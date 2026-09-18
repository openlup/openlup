import { maskProviderReference } from "../../../src/domains/platform/observabilityRedaction.js";
import type {
  PaymentAttemptEvidenceRow,
  PaymentIntentEvidenceRow,
  PaymentObservabilityEvidence,
} from "./paymentObservabilityEvidence.js";

export type PaymentReconciliationEvidenceRow = Record<string, unknown> & {
  payment_attempt_id?: string | null;
  payment_intent_id?: string | null;
  provider?: string | null;
  provider_payment_id?: string | null;
  correction_status?: string | null;
  checked_at?: string | null;
  payload?: Record<string, unknown> | null;
};

export const ACTIVE_PROVIDER_ATTEMPT_STATUSES = new Set([
  "sent_to_provider",
  "requires_action",
  "processing",
]);

export function collectReconciliationMismatchEvidence(
  rows: PaymentReconciliationEvidenceRow[],
  attemptById: Map<string, PaymentAttemptEvidenceRow>,
  intentById: Map<string, PaymentIntentEvidenceRow>,
  now: Date,
): { evidence: PaymentObservabilityEvidence[]; attemptIds: Set<string> } {
  const seenAttempts = new Set<string>();
  const attemptIds = new Set<string>();
  const evidence: PaymentObservabilityEvidence[] = [];
  const ordered = [...rows].sort((left, right) =>
    String(right.checked_at ?? "").localeCompare(String(left.checked_at ?? "")),
  );
  for (const row of ordered) {
    const paymentAttemptId = row.payment_attempt_id ?? null;
    if (!paymentAttemptId || seenAttempts.has(paymentAttemptId)) continue;
    // The newest outcome supersedes old immutable mismatch evidence.
    seenAttempts.add(paymentAttemptId);
    const reason = reconciliationMismatchReason(row);
    if (!reason) continue;
    const attempt = attemptById.get(paymentAttemptId);
    // Terminal attempts retain history without keeping an incident open.
    if (!attempt || !ACTIVE_PROVIDER_ATTEMPT_STATUSES.has(attempt.status)) continue;
    const paymentIntentId = row.payment_intent_id ?? attempt.payment_intent_id;
    const intent = intentById.get(paymentIntentId);
    evidence.push({
      kind: "amount_currency_mismatch",
      provider: row.provider ?? providerOf(attempt),
      paymentIntentId,
      paymentAttemptId,
      orderId: intent?.order_id ?? null,
      subscriptionId: intent?.subscription_id ?? null,
      subscriptionCycleId: intent?.subscription_cycle_id ?? null,
      providerPaymentId: maskProviderReference(row.provider_payment_id),
      owner: "commerce/payment",
      customerSafeStatus: "operator_review_required",
      operatorNextAction: "inspect_provider_before_retry",
      reason,
      observedAt: row.checked_at ?? now.toISOString(),
    });
    attemptIds.add(paymentAttemptId);
  }
  return { evidence, attemptIds };
}

function reconciliationMismatchReason(
  row: PaymentReconciliationEvidenceRow,
): "provider_amount_mismatch" | "provider_currency_mismatch" | null {
  if (row.correction_status !== "failed") return null;
  const reason = row.payload?.failureReason;
  return reason === "provider_amount_mismatch" || reason === "provider_currency_mismatch"
    ? reason
    : null;
}

function providerOf(row: PaymentAttemptEvidenceRow): string | null {
  return row.provider_kind ?? row.provider ?? null;
}
