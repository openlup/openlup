import { executeHandler } from "./trace.js";
import type {
  Clock,
  OutboxDispatchConfig,
  OutboxDispatchRunResult,
  OutboxEventRow,
  OutboxHandlerRegistry,
  OutboxQueueDiagnostics,
  OutboxStore,
  OutboxLogger,
  OutboxObservation,
} from "./contracts.js";

// Tail reserved per row: worst-case handler.timeoutMs + this mark-RPC margin.
const MARK_MARGIN_MS = 2000;
// R-8: a hung queueStats RPC must never starve finishJobRun past Vercel's
// kill — best-effort stats race a hard deadline (try/catch only covers throws).
const QUEUE_STATS_DEADLINE_MS = 3000;
const DISCARDED_EVENT_IDS_CAP = 25;
const SAFE_MESSAGE_MAX_CHARS = 300;

interface ClaimedItem {
  eventId: string;
  claimToken: string;
}

type PerTypeCounter =
  | "processed"
  | "retried"
  | "snoozed"
  | "discarded"
  | "leaseLost"
  | "duplicateInRun";

export async function runOutboxDispatchWorker(deps: {
  store: OutboxStore;
  registry: OutboxHandlerRegistry;
  config: OutboxDispatchConfig;
  knownEventTypes?: readonly string[];
  diagnostics?: OutboxQueueDiagnostics;
  clock?: Clock;
  logger?: OutboxLogger;
  observe?: (observation: OutboxObservation) => void;
}): Promise<OutboxDispatchRunResult> {
  const { store, registry, config } = deps;
  const suppliedLogger = deps.logger ?? console;
  const log = (method: "warn" | "error", args: unknown[]): void => {
    try { suppliedLogger[method](...args); } catch { /* Diagnostic failures cannot interrupt dispatch. */ }
  };
  const logger = { warn: (...args: unknown[]) => log("warn", args), error: (...args: unknown[]) => log("error", args) };
  const observe = (event: "claimed" | "finished", count: number): void => {
    try { deps.observe?.({ event, count }); } catch { /* Diagnostics cannot rewrite an outcome. */ }
  };
  const clock = deps.clock ?? { now: () => Date.now() };
  const startedAt = clock.now();

  const counters = {
    claimed: 0,
    processed: 0,
    retried: 0,
    snoozed: 0,
    discarded: 0,
    released: 0,
    duplicateInRun: 0,
    leaseLost: 0,
    batches: 0,
  };
  const byEventType: Record<string, Record<string, number>> = {};
  const discardedEventIds: string[] = [];

  const bump = (eventType: string, key: PerTypeCounter): void => {
    const bucket = (byEventType[eventType] ??= {});
    bucket[key] = (bucket[key] ?? 0) + 1;
  };

  const finish = async (input: {
    skipped: boolean;
    reason?: string;
  }): Promise<OutboxDispatchRunResult> => {
    let queue: Record<string, unknown> | undefined;
    if (!input.skipped && deps.diagnostics) {
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        queue = await Promise.race([
          deps.diagnostics.queueStats(),
          new Promise<undefined>((resolve) => {
            deadlineTimer = setTimeout(() => resolve(undefined), QUEUE_STATS_DEADLINE_MS);
          }),
        ]);
        if (queue === undefined) logger.warn("[outbox-dispatch] queue_stats_failed", "deadline_exceeded");
      } catch (error) {
        logger.warn("[outbox-dispatch] queue_stats_failed", safeMessage(error));
      } finally {
        if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      }
    }
    observe("finished", counters.processed);
    return {
      ok: true,
      checked: counters.claimed,
      updated: counters.processed,
      failures: counters.retried + counters.discarded,
      skipped: input.skipped,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      ...counters,
      runMs: clock.now() - startedAt,
      byEventType,
      discardedEventIds,
      ...(queue !== undefined ? { queue } : {}),
    };
  };

  const applyMarkFailed = async (
    row: OutboxEventRow,
    claimToken: string,
    outcome: "retry" | "discard" | "snooze",
    reason: string,
    benign = false,
  ): Promise<"failed" | "discarded" | "snoozed" | "missed"> => {
    const { status } = await store.markFailed({
      eventId: row.id,
      claimToken,
      error: reason,
      outcome,
      baseDelaySeconds: config.backoffBaseSeconds,
      maxDelaySeconds: config.backoffCapSeconds,
      maxAttempts: config.maxAttempts,
      snoozeSeconds: config.snoozeSeconds,
    });
    if (status === "failed") {
      counters.retried += 1;
      bump(row.event_type, "retried");
    } else if (status === "discarded") {
      counters.discarded += 1;
      bump(row.event_type, "discarded");
      if (discardedEventIds.length < DISCARDED_EVENT_IDS_CAP) discardedEventIds.push(row.id);
      // Benign discard = expected terminal drop (deleted aggregate): same tag, logged at warn not error so it does not read as a failure.
      const payload = { eventId: row.id, eventType: row.event_type, aggregateId: row.aggregate_id, attempts: row.attempts, reason, ...(benign ? { benign: true } : {}) };
      (benign ? logger.warn : logger.error)("[outbox-dispatch] event_discarded", JSON.stringify(payload));
    } else if (status === "missed") {
      counters.leaseLost += 1;
      bump(row.event_type, "leaseLost");
      logger.warn("[outbox-dispatch] outbox_lease_lost", row.id);
    } else {
      counters.snoozed += 1;
      bump(row.event_type, "snoozed");
    }
    return status;
  };

  const allowlist = [...registry.keys()];
  if (allowlist.length === 0) {
    return finish({ skipped: true, reason: "outbox_registry_empty" });
  }

  const seen = new Set<string>();
  let circuitBroken = false;

  drain: while (clock.now() - startedAt < config.softBudgetMs) {
    const claimed = await store.claimBatch({
      eventTypes: allowlist,
      knownEventTypes: deps.knownEventTypes,
      batchSize: config.batchSize,
      visibilitySeconds: config.visibilitySeconds,
      maxAttempts: config.maxAttempts,
    });
    if (claimed.length === 0) break;
    counters.batches += 1;
    counters.claimed += claimed.length;
    observe("claimed", claimed.length);

    // RETURNING order is unspecified — re-establish (created_at, id) order.
    const batch = [...claimed].sort(compareByCreatedAtThenId);
    const unstarted: ClaimedItem[] = [];

    for (let index = 0; index < batch.length; index += 1) {
      const row = batch[index];
      const claimToken = row.metadata?.claimToken;
      if (typeof claimToken !== "string" || claimToken.length === 0) {
        counters.leaseLost += 1;
        bump(row.event_type, "leaseLost");
        logger.error("[outbox-dispatch] missing_claim_token", row.id);
        continue;
      }

      if (seen.has(row.id)) {
        // An in-process aborted orphan may still race — never re-execute in-run.
        counters.released += await store.releaseUnprocessed(
          [{ eventId: row.id, claimToken }],
          config.backoffBaseSeconds,
        );
        counters.duplicateInRun += 1;
        bump(row.event_type, "duplicateInRun");
        continue;
      }
      seen.add(row.id);

      const handler = registry.get(row.event_type);
      if (!handler) {
        await applyMarkFailed(row, claimToken, "retry", "outbox_handler_missing");
        continue;
      }

      const elapsed = clock.now() - startedAt;
      if (elapsed + handler.timeoutMs + MARK_MARGIN_MS > config.softBudgetMs) {
        unstarted.push({ eventId: row.id, claimToken });
        continue;
      }

      const outcome = await executeHandler(handler, row);

      if (outcome.kind === "processed") {
        const { applied } = await store.markProcessed({
          eventId: row.id,
          claimToken,
          metadata: outcome.detail,
        });
        if (applied) {
          counters.processed += 1;
          bump(row.event_type, "processed");
        } else {
          counters.leaseLost += 1;
          bump(row.event_type, "leaseLost");
          logger.warn("[outbox-dispatch] outbox_lease_lost", row.id);
        }
        continue;
      }

      if (outcome.kind === "snooze") {
        const snoozeCount = Number(row.metadata?.snoozeCount) || 0;
        if (snoozeCount >= config.maxSnoozes) {
          // Liveness bound: a misclassified permanent error must not snooze
          // forever — consume an attempt instead. No circuit-break.
          await applyMarkFailed(
            row,
            claimToken,
            "retry",
            `snooze_budget_exhausted:${outcome.reason}`,
          );
          continue;
        }
        await applyMarkFailed(row, claimToken, "snooze", outcome.reason);
        // Circuit-break: the provider is down — refund everything still
        // claimed (tail-gated rows included) and stop hammering it.
        const remainder = [...unstarted];
        for (let rest = index + 1; rest < batch.length; rest += 1) {
          const restToken = batch[rest].metadata?.claimToken;
          if (typeof restToken === "string" && restToken.length > 0) {
            remainder.push({ eventId: batch[rest].id, claimToken: restToken });
          }
        }
        if (remainder.length > 0) {
          counters.released += await store.releaseUnprocessed(remainder, config.snoozeSeconds);
        }
        circuitBroken = true;
        break drain;
      }

      await applyMarkFailed(row, claimToken, outcome.kind, outcome.reason, outcome.kind === "discard" && outcome.benign === true);
    }

    if (unstarted.length > 0) {
      counters.released += await store.releaseUnprocessed(unstarted, 0);
      break;
    }
    if (claimed.length < config.batchSize) break;
  }

  return finish({
    skipped: false,
    ...(circuitBroken ? { reason: "provider_outage" } : {}),
  });
}
function compareByCreatedAtThenId(a: OutboxEventRow, b: OutboxEventRow): number {
  if (a.created_at < b.created_at) return -1;
  if (a.created_at > b.created_at) return 1;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}
function safeMessage(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, SAFE_MESSAGE_MAX_CHARS); }
