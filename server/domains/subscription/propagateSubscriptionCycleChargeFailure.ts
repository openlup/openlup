import { nextRetryAttemptAt } from "../../../src/domains/subscription/cycleHardening.js";
import { resolvedFailureClassification } from "../../shared/applyPaymentResultRpc.js";

/**
 * Propagates a subscription-cycle charge failure with explicit terminal
 * evidence (provider decline, off-session `requires_action`, or local preflight)
 * through four steps, each one a named method on the injected
 * {@link CycleChargeFailurePropagationPort}:
 *
 *   1. `recordBlockedPreflightAttempt` for a local preflight block when the
 *      caller has not already prepared an attempt. It uses the local-only
 *      `"blocked_preflight"` status so we do not claim a provider call
 *      happened. The terminal `failed` state is carried by the applied result
 *      in step 2, NOT by the initial attempt row. Recording the attempt here is
 *      also what stamps the intent's active attempt, which applying a result
 *      requires to exist.
 *   2. `applyFailedResult`, which bumps the cycle's retry attempt and computes
 *      `next_retry_at` using the canonical backoff ladder.
 *   3. `readCycleRetryState` — a read of the cycle's new
 *      `(retry_attempt, next_retry_at)` so we can hand the dunning step the
 *      exact integer it stamps on the row (any drift would trip the
 *      `subscription_dunning_retry_attempt_stale` guard).
 *   4. `openDunningCase` to insert the dunning case and queue the notification
 *      row the active `subscription-dunning-dispatch` worker picks up.
 *
 * All three writes are idempotent on `(scope, idempotency_key)`. We derive
 * deterministic keys from the cron's `executionIdempotencyKey` so a replay of
 * the same row replays the same chain without opening duplicate cases. A
 * deterministic KEY is not enough: applying a result also fingerprints
 * `occurredAt`, so steps 2 and 4 take their instant from a durable row —
 * see {@link resolveDurableOccurredAt} for the poison pill that forces this.
 *
 * Errors from the dunning step do not throw (the cycle is already failed and must
 * not be undone) but are NOT swallowed — see {@link RENEWAL_DUNNING_PROPAGATION_FAILED_KEY}.
 * Errors from recording the attempt / applying the result are surfaced. If the
 * attempt commits and applying the result fails, the intent can temporarily sit
 * in `processing` with an active `blocked_preflight` attempt; the deterministic
 * keys let the next cron/replay finish the same chain rather than open a second
 * attempt.
 *
 * A thrown PSP execution is deliberately absent from this API: timeout/network
 * failure is indeterminate after prepare and must stay on the prepared-attempt
 * reconciliation path. Off-session SCA follows the explicit-result boundary:
 * only a caller with a prepared/finalized active attempt may classify it as
 * failed and open customer dunning.
 */

export type FailurePropagationKind =
  | "off_session_requires_action"
  /**
   * Provider refused inside the execution call rather than throwing. Nothing
   * went wrong technically: the charge was declined and no callback may follow.
   */
  | "provider_declined"
  | "preflight_block";

export interface FailurePropagationContext {
  kind: FailurePropagationKind;
  executionIdempotencyKey: string;
  providerIdempotencyKey: string;
  providerRequestFingerprint: string;
  paymentIntentId: string;
  cycleId: string;
  subscriptionId: string;
  orderUuid: string;
  providerKind: string;
  failureReason: string;
  failureClassification?: { failureClass: string; decidedBy: string } | null; // Refusal evidence (advice code, hints) when the caller holds any; omitting it DERIVES a class from failureReason. The same resolved class is both persisted and passed to the canonical cadence decision.
  /** Caller clock. FALLBACK only — a durable instant for this key always wins. */
  occurredAt: string;
  attemptAlreadyPrepared?: boolean;
}

export interface CycleRetryState {
  retryAttempt: number | null;
  nextRetryAt: string | null;
  /**
   * Whether the cycle row was actually read. Without it a `nextRetryAt: null`
   * is ambiguous between the two answers that must never be treated alike: the
   * row SAYS there is no next retry, and there was no row to ask. Only the
   * second may be filled in from the ladder — re-deriving a schedule the store
   * deliberately cleared files a case that contradicts its own cycle.
   */
  rowPresent: boolean;
}

/** The dunning step's outcome, kept as DATA rather than a throw. */
export type DunningCaseOpenOutcome =
  | { status: "opened"; caseId: string | null }
  /** The store answered, and its answer was a refusal. */
  | { status: "rejected"; reason: string; code?: string }
  /** The store never answered at all. */
  | { status: "unavailable"; reason: string };

/**
 * The four durable effects this propagation needs, named by what they mean to
 * the lifecycle rather than by how any one deployment performs them. The
 * implementation lives in a named adapter; nothing here knows a driver.
 */
export interface CycleChargeFailurePropagationPort {
  /** Local-only attempt row for a failure blocked before any provider call. */
  recordBlockedPreflightAttempt(input: {
    idempotencyKey: string;
    paymentIntentId: string;
    providerKind: string;
    providerIdempotencyKey: string;
    providerRequestFingerprint: string;
    failureReason: string;
  }): Promise<void>;
  /**
   * The instant the attempt under this key was durably created, or null when
   * no such row is readable. Fail-SOFT: an unreadable row answers null.
   */
  readDurableAttemptInstant(input: {
    paymentIntentId: string;
    attemptIdempotencyKey: string;
  }): Promise<string | null>;
  /** Terminal `failed` result for the intent. Throws when it does not land. */
  applyFailedResult(input: {
    idempotencyKey: string;
    paymentIntentId: string;
    occurredAt: string;
    failureReason: string;
    failureClassification: { failureClass: string; decidedBy: string };
  }): Promise<{ replayed: boolean }>;
  /** The cycle's retry state after the result was applied. Throws when unreadable. */
  readCycleRetryState(cycleId: string): Promise<CycleRetryState>;
  /** Opens the case, token and queued notice. Never throws — see the outcome type. */
  openDunningCase(input: {
    idempotencyKey: string;
    cycleId: string;
    subscriptionId: string;
    orderUuid: string;
    paymentIntentId: string;
    retryAttempt: number;
    nextRetryAt: string | null;
    failureReason: string;
    occurredAt: string;
    failureClass: string;
  }): Promise<DunningCaseOpenOutcome>;
}

/**
 * Row-outcome key for a charge failure whose dunning step did not land. That step
 * creates the case, the recovery token and the queued customer notice; when it
 * fails, the result has still failed and rescheduled the cycle, so the row reads
 * as handled from every angle an operator can see while the customer is told
 * nothing and given no way to pay. Not progress — and ONE constant key, because
 * the quarantine streak advances only on identical ones. */
export const RENEWAL_DUNNING_PROPAGATION_FAILED_KEY = "renewal_dunning_propagation_failed";

export interface FailurePropagationResult {
  dunningCaseId: string | null;
  retryAttempt: number | null;
  /**
   * Applying the result returned its STORED response instead of applying
   * anything — the store's own statement that this tick moved nothing. A tick
   * that changes nothing and repeats forever is a stuck row, not progress.
   */
  applyReplayed: boolean;
  /** The dunning step rejected or never answered. Non-fatal, never silent — see the key above. */
  dunningPropagationFailed: boolean;
}

export async function propagateSubscriptionCycleChargeFailure(
  port: CycleChargeFailurePropagationPort,
  ctx: FailurePropagationContext,
): Promise<FailurePropagationResult> {
  if (ctx.kind === "off_session_requires_action" && ctx.attemptAlreadyPrepared !== true) {
    return { dunningCaseId: null, retryAttempt: null, applyReplayed: false, dunningPropagationFailed: false };
  }
  if (ctx.kind === "preflight_block" && ctx.attemptAlreadyPrepared !== true) {
    await port.recordBlockedPreflightAttempt({
      idempotencyKey: `${ctx.executionIdempotencyKey}:record-attempt`,
      paymentIntentId: ctx.paymentIntentId,
      providerKind: ctx.providerKind,
      providerIdempotencyKey: ctx.providerIdempotencyKey,
      providerRequestFingerprint: ctx.providerRequestFingerprint,
      failureReason: ctx.failureReason,
    });
  }
  const occurredAt = await resolveDurableOccurredAt(port, ctx);
  const applied = await port.applyFailedResult({
    idempotencyKey: `${ctx.executionIdempotencyKey}:apply-result`,
    paymentIntentId: ctx.paymentIntentId,
    occurredAt,
    failureReason: ctx.failureReason,
    failureClassification: resolvedFailureClassification(ctx.failureClassification, ctx.failureReason),
  });
  const cycleSnapshot = await port.readCycleRetryState(ctx.cycleId);
  return {
    ...await openDunningCase(port, ctx, cycleSnapshot, occurredAt),
    applyReplayed: applied.replayed,
  };
}

/**
 * The instant this failure was FIRST observed, not the instant we are trying to
 * record it.
 *
 * Applying a result fingerprints `occurredAt`, so two presentations of one key
 * must carry the same value or the second is rejected with
 * `payment_control_result_idempotency_conflict` — and since the write is atomic,
 * that rejection rolls the row back and leaves it due, failing identically,
 * forever. A caller can re-present the same key whenever the same rung is driven
 * twice — a cron tick that overlaps its predecessor, a replayed row, a retried
 * invocation — and this anchor is what makes that second presentation carry the
 * first one's instant instead of conflicting.
 *
 * It is no longer what holds the preflight path together. Until
 * `20260826`-era, that path built its execution key from the cycle alone,
 * without the retry-attempt scoping the charge path's builder adds, so EVERY
 * later tick re-presented one key and this anchor froze the ladder at rung one
 * rather than merely making the repeat safe. Both paths now scope by
 * `retry_attempt`, so a new rung mints a new key and reaches the `null` fallback
 * with the caller's own clock.
 *
 * The anchor is the attempt row that same key already created, matched on the
 * UNIQUE `(payment_intent_id, idempotency_key)` pair the apply key derives
 * from. Scoping it to the KEY is what makes the fallback correct, not just
 * safe: when prepare replays an older non-terminal attempt under a NEW key,
 * nothing carries that key and the caller's clock is exactly right — that path
 * advances the ladder every tick. An unreadable anchor falls back too;
 * poison-pill hardening must never create a row error of its own.
 */
async function resolveDurableOccurredAt(
  port: Pick<CycleChargeFailurePropagationPort, "readDurableAttemptInstant">,
  ctx: FailurePropagationContext,
): Promise<string> {
  const suffix = ctx.attemptAlreadyPrepared === true ? ":prepare-attempt" : ":record-attempt";
  const durable = await port.readDurableAttemptInstant({
    paymentIntentId: ctx.paymentIntentId,
    attemptIdempotencyKey: `${ctx.executionIdempotencyKey}${suffix}`,
  });
  return durable !== null && durable.length > 0 ? durable : ctx.occurredAt;
}

// Takes the same durable instant the applied result was given: it derives
// `next_retry_at` from it and the fallback below re-derives it, so two clock
// reads would let the case and the cycle disagree about when to retry.
async function openDunningCase(
  port: Pick<CycleChargeFailurePropagationPort, "openDunningCase">,
  ctx: FailurePropagationContext,
  cycle: CycleRetryState,
  occurredAt: string,
): Promise<Omit<FailurePropagationResult, "applyReplayed">> {
  const retryAttempt = cycle.retryAttempt ?? 1;
  const failureClass = resolvedFailureClassification(
    ctx.failureClassification,
    ctx.failureReason,
  ).failureClass;
  // console.ERROR, not warn, on the branches below: that is where the customer
  // silently ends up with no case, no token and no email.
  const stranded = { cycleId: ctx.cycleId, subscriptionId: ctx.subscriptionId, retryAttempt,
    rowOutcomeKey: RENEWAL_DUNNING_PROPAGATION_FAILED_KEY };
  if (retryAttempt < 1) {
    console.warn("[subscription-renewal] skipping dunning — retry_attempt below 1", { cycleId: ctx.cycleId, retryAttempt });
    return { dunningCaseId: null, retryAttempt, dunningPropagationFailed: false };
  }
  // The stored schedule wins whenever there IS a stored schedule to read —
  // including when what it stores is "none". A cycle the apply body left without
  // a next retry has been terminated on purpose, and re-deriving one here would
  // open a case whose schedule contradicts the cycle it belongs to. The ladder is
  // consulted only when the row itself could not be read, where it is the best
  // guess available and past its end it terminates too.
  const nextRetryAt = cycle.rowPresent
    ? cycle.nextRetryAt
    : nextRetryAttemptAt(
      occurredAt,
      retryAttempt,
      undefined,
      failureClass,
    );
  const outcome = await port.openDunningCase({
    idempotencyKey: `${ctx.executionIdempotencyKey}:dunning:${retryAttempt}`,
    cycleId: ctx.cycleId,
    subscriptionId: ctx.subscriptionId,
    orderUuid: ctx.orderUuid,
    paymentIntentId: ctx.paymentIntentId,
    retryAttempt,
    nextRetryAt,
    failureReason: ctx.failureReason,
    occurredAt,
    failureClass,
  });
  if (outcome.status === "rejected") {
    console.error("[subscription-renewal] dunning RPC error", {
      ...stranded, code: outcome.code, reason: outcome.reason,
    });
    return { dunningCaseId: null, retryAttempt, dunningPropagationFailed: true };
  }
  if (outcome.status === "unavailable") {
    console.error("[subscription-renewal] dunning RPC threw", {
      ...stranded, reason: outcome.reason,
    });
    return { dunningCaseId: null, retryAttempt, dunningPropagationFailed: true };
  }
  return { dunningCaseId: outcome.caseId, retryAttempt, dunningPropagationFailed: false };
}
