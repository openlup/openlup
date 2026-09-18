import { maskProviderReference } from "../../../src/domains/platform/observabilityRedaction.js";
import { latestTimestamp, secondsBetween } from "./paymentObservabilityEvidenceHelpers.js";
import {
  PROVIDER_SUCCESS_CONSISTENT_INTENT_STATUSES,
  type PaymentAttemptEvidenceRow,
  type PaymentIntentEvidenceRow,
  type PaymentObservabilityEvidence,
  type PaymentReconciliationEvidenceRow,
} from "./paymentObservabilityEvidence.js";

/**
 * A dunning case, narrowed to the two columns that answer "was this payment
 * offered a way back". Declared here rather than imported from the adapter so
 * the domain keeps owning its own read shape.
 */
export type DunningRescueEvidenceRow = Record<string, unknown> & {
  payment_intent_id?: string | null;
  cycle_id?: string | null;
};

/** One `commerce_checkout_recovery_tokens` row, narrowed to the only column this reads. */
export type CheckoutRecoveryTokenEvidenceRow = {
  order_id?: string | null;
};




/**
 * The order ids that have a checkout-recovery token, in any state.
 *
 * Presence is the fact "a recovery path was created for this order", which is
 * all the `recovery_missing` detector needs; whether the customer used the link
 * is a different question and not this detector's. Supplied by the adapter as a
 * bounded read of `commerce_checkout_recovery_tokens` — see the port.
 */
export type RecoveryTokenOrderIds = ReadonlySet<string>;

/**
 * A payment the customer cannot finish, that nobody offered a way back from.
 *
 * ⛔ This detector used to read `attempt.recovery_required` and
 * `attempt.recovery_link_created`. Neither column is created by any migration,
 * so it could not fire — a p1 that had never been true. It now reads the facts
 * the two recovery rails actually persist.
 *
 * ⛔ THE TOKEN IS NOT THE ONLY RESCUE. A renewal refusal never receives a
 * checkout-recovery token — its way back is a DUNNING CASE, which schedules a
 * retry and tells the customer. Judging a renewal on the token alone raised a p1
 * saying "recovery path missing" at the exact moment recovery was working, which
 * is the same disease this detector was repaired for: an alert asserting
 * something untrue. So the suppressor is the FACT OF RESCUE — a token OR a
 * dunning case — and not a guess at which rail the attempt came from. That keeps
 * the reading rail-agnostic: it says "nobody offered a way back", full stop.
 *
 * A failed attempt on its own is ordinary — a mistyped card produces one, and
 * the customer retries seconds later. Four suppressors keep those out, each
 * reading a column that exists:
 *
 * 1. the intent must not have landed money (a later success on the same intent
 *    means the customer already got through);
 * 2. no sibling attempt on the intent may have succeeded, which catches a
 *    success recorded on the attempt before the intent row caught up;
 * 3. no dunning case may cover this payment — matched on the intent AND on the
 *    cycle, because `subscription_dunning_cases` is UNIQUE per `cycle_id` and
 *    the cycle link survives any intent churn across retries; and
 * 4. the failure must have sat for 15 minutes, which is longer than any
 *    self-service retry and matches the webhook-missing window.
 *
 * What survives all four is the real blind spot: a payment that ended, offered
 * the customer nothing, and has no worker coming back for it.
 */
export function collectRecoveryMissingEvidence(
  attempts: PaymentAttemptEvidenceRow[],
  intentById: Map<string, PaymentIntentEvidenceRow>,
  now: Date,
  options: {
    recoveryTokenOrderIds?: RecoveryTokenOrderIds;
    dunningCases?: DunningRescueEvidenceRow[];
  } = {},
): PaymentObservabilityEvidence[] {
  const recoveryTokenOrderIds = options.recoveryTokenOrderIds ?? new Set<string>();
  const dunningCases = options.dunningCases ?? [];
  const recoveryCutoff = now.getTime() - 15 * 60 * 1000;
  // The token read is windowed to 24h, so an older failure would be judged
  // against tokens the adapter never read and could allege a missing recovery
  // path that exists. Bounding the detector to the same window is what keeps a
  // truncated read from manufacturing a p1.
  const recoveryFloor = now.getTime() - 24 * 60 * 60 * 1000;
  const intentIdsWithSucceededAttempt = new Set(
    attempts.filter((row) => row.status === "succeeded").map((row) => row.payment_intent_id),
  );
  // A dunning case IS the recovery path for a renewal, in every status: `open`
  // is one running, `recovered` one that worked, `expired` one that ran and gave
  // up. All three mean somebody was offered a way back, which is the only
  // question this detector asks.
  const rescuedIntentIds = new Set(
    dunningCases.map((row) => row.payment_intent_id).filter((id): id is string => Boolean(id)),
  );
  const rescuedCycleIds = new Set(
    dunningCases.map((row) => row.cycle_id).filter((id): id is string => Boolean(id)),
  );

  const evidence: PaymentObservabilityEvidence[] = [];
  for (const attempt of attempts) {
    const intent = intentById.get(attempt.payment_intent_id);
    if (!intent) continue;
    if (attempt.status !== "failed") continue;
    const orderId = intent.order_id;
    if (!orderId) continue;
    if (PROVIDER_SUCCESS_CONSISTENT_INTENT_STATUSES.has(intent.status)) continue;
    if (intentIdsWithSucceededAttempt.has(attempt.payment_intent_id)) continue;
    if (recoveryTokenOrderIds.has(orderId)) continue;
    if (rescuedIntentIds.has(attempt.payment_intent_id)) continue;
    if (intent.subscription_cycle_id && rescuedCycleIds.has(intent.subscription_cycle_id)) continue;
    const failedAt = latestTimestamp(attempt.updated_at, attempt.created_at);
    if (failedAt > recoveryCutoff || failedAt < recoveryFloor) continue;

    evidence.push({
      kind: "recovery_missing" as const,
      provider: attempt.provider_kind ?? attempt.provider ?? null,
      paymentIntentId: attempt.payment_intent_id,
      paymentAttemptId: attempt.id,
      orderId,
      providerPaymentId: maskProviderReference(attempt.provider_payment_id ?? attempt.provider_attempt_id),
      reason: "failed_attempt_without_any_recovery_path",
      ageSeconds: secondsBetween(failedAt, now),
      owner: "commerce/payment",
      customerSafeStatus: "operator_review_required",
      observedAt: now.toISOString(),
    });
  }
  return evidence;
}
