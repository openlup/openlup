import type { OutboxHandler, OutboxHandlerOutcome, OutboxHandlerRegistry } from "./contracts.js";
export function claimAllowlist(registry: OutboxHandlerRegistry): string[] {
  return [...registry.keys()];
}

export function uniqueRegistry(handlers: readonly OutboxHandler[]): OutboxHandlerRegistry {
  const registry = new Map<string, OutboxHandler>();
  for (const handler of handlers) {
    const existing = registry.get(handler.eventType);
    registry.set(handler.eventType, existing ? composeHandlers(existing, handler) : handler);
  }
  return registry;
}

// Preserve top-level delivery observations, with first-component precedence.
const DELIVERY_LIFECYCLE_METADATA_KEYS = ["resendId", "providerMessageId", "skipped", "dedupe"] as const;

function hoistDeliveryLifecycleKeys(detail: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!detail) return {};
  const hoisted: Record<string, unknown> = {};
  for (const key of DELIVERY_LIFECYCLE_METADATA_KEYS) {
    if (detail[key] !== undefined) hoisted[key] = detail[key];
  }
  return hoisted;
}

export function composeHandlers(first: OutboxHandler, second: OutboxHandler): OutboxHandler {
  return {
    eventType: first.eventType,
    timeoutMs: first.timeoutMs + second.timeoutMs,
    async handle(row, signal) {
      const firstOutcome = await first.handle(row, signal);
      if (firstOutcome.kind !== "processed") return firstOutcome;
      const secondOutcome = await second.handle(row, signal);
      if (secondOutcome.kind !== "processed") return secondOutcome;
      return {
        kind: "processed",
        detail: {
          // Hoist second first, then first, so the primary (email) handler wins on
          // the rare chance both emit a lifecycle key.
          ...hoistDeliveryLifecycleKeys(secondOutcome.detail),
          ...hoistDeliveryLifecycleKeys(firstOutcome.detail),
          first: firstOutcome.detail ?? {},
          second: secondOutcome.detail ?? {},
        },
      };
    },
  };
}

type TerminalHandlerOutcome = Extract<OutboxHandlerOutcome, { kind: "processed" | "discard" }>;

/** Compose same-event handlers whose effects each have their own replay protection. */
export function composeIndependentHandlers(
  handlers: readonly OutboxHandler[],
  options: {
    maxConcurrency: number;
    /** Deadline for the entire group, enforced by the existing outbox worker. */
    timeoutMs: number;
    acknowledgeDiscardedHandlers?: boolean;
    projectProcessedDetail?(outcomes: readonly TerminalHandlerOutcome[]): Record<string, unknown> | undefined;
  },
): OutboxHandler {
  const components = [...handlers];
  const eventType = components[0]?.eventType;
  if (!eventType?.trim() || components.some(handler => handler.eventType !== eventType)) {
    throw new RangeError("outbox_independent_handlers_require_same_event_type");
  }
  const { maxConcurrency, timeoutMs, acknowledgeDiscardedHandlers, projectProcessedDetail } = options;
  if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1) {
    throw new RangeError("outbox_independent_handlers_invalid_concurrency");
  }
  // Leave room for the worker's abort grace within the timer's supported range.
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_147) {
    throw new RangeError("outbox_independent_handlers_invalid_timeout");
  }

  return {
    eventType,
    timeoutMs,
    async handle(row, signal, execution) {
      const outcomes = new Array<OutboxHandlerOutcome | undefined>(components.length).fill(undefined);
      let next = 0;
      const runLane = async () => {
        while (!signal.aborted && next < components.length) {
          const index = next++;
          try {
            outcomes[index] = await components[index]!.handle(row, signal, execution);
          } catch {
            outcomes[index] = { kind: "retry", reason: "outbox_independent_handler_failed" };
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(maxConcurrency, components.length) }, runLane));

      const snooze = outcomes.find(outcome => outcome?.kind === "snooze");
      if (snooze) return { kind: "snooze", reason: snooze.reason };
      if (next < components.length) return { kind: "retry", reason: "outbox_handler_timeout" };
      const retry = outcomes.find(outcome => outcome?.kind === "retry");
      if (retry) return { kind: "retry", reason: retry.reason };

      if (!acknowledgeDiscardedHandlers) {
        const discarded = outcomes.filter(outcome => outcome?.kind === "discard");
        const discard = discarded.find(outcome => !outcome.benign) ?? discarded[0];
        if (discard) return {
          kind: "discard", reason: discard.reason,
          ...(discard.benign === undefined ? {} : { benign: discard.benign }),
        };
      }
      try {
        const detail = projectProcessedDetail?.(outcomes.filter(
          outcome => outcome?.kind === "processed" || outcome?.kind === "discard",
        ));
        return detail === undefined ? { kind: "processed" } : { kind: "processed", detail };
      } catch {
        return { kind: "retry", reason: "outbox_independent_projection_failed" };
      }
    },
  };
}
