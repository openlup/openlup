import { propagateRenewalFailure, type RenewalFailurePolicy } from "@openlup/platform/subscriptions";
import { resolvedFailureClassification } from "../../shared/applyPaymentResultRpc.js";
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
  }): Promise<{ replayed: boolean; paymentAttemptId?: string | null }>;
  /** The cycle's retry state after the result was applied. Throws when unreadable. */
  readCycleRetryState(cycleId: string): Promise<CycleRetryState>;
  /** Opens the case, token and queued notice. Never throws — see the outcome type. */
  openDunningCase(input: {
    failedPaymentAttemptId: string | null;
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

export const renewalFailurePolicy: RenewalFailurePolicy = {
  resolveClassification: resolvedFailureClassification,
  recordKey: key => `${key}:record-attempt`, applyKey: key => `${key}:apply-result`,
  dunningKey: (key, attempt) => `${key}:dunning:${attempt}`,
  preparedSuffix: ":prepare-attempt", blockedSuffix: ":record-attempt",
  dunningFailureKey: RENEWAL_DUNNING_PROPAGATION_FAILED_KEY,
  logBelowRetry: fields => console.warn("[subscription-renewal] skipping dunning — retry_attempt below 1", fields),
  logRejected: fields => console.error("[subscription-renewal] dunning RPC error", fields),
  logUnavailable: fields => console.error("[subscription-renewal] dunning RPC threw", fields),
};
export async function propagateSubscriptionCycleChargeFailure(
  port: CycleChargeFailurePropagationPort, ctx: FailurePropagationContext,
): Promise<FailurePropagationResult> {
  return propagateRenewalFailure(port, ctx, renewalFailurePolicy);
}
