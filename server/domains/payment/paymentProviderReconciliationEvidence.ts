import type {
  ClaimedPaymentAttempt,
  ProviderReconciliationStatus,
  ProviderReconciliationStatusKind,
} from "./paymentProviderReconciliationContracts.js";

export function evidencePayload(
  attempt: ClaimedPaymentAttempt,
  providerStatus: ProviderReconciliationStatus,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  return {
    source: "payment-provider-reconciliation.v0",
    provider: attempt.provider,
    providerPaymentId: attempt.providerPaymentId,
    paymentIntentId: attempt.paymentIntentId,
    paymentAttemptId: attempt.paymentAttemptId,
    orderId: attempt.orderId,
    subscriptionId: attempt.subscriptionId,
    subscriptionCycleId: attempt.subscriptionCycleId,
    localAttemptStatus: attempt.attemptStatus,
    localIntentStatus: attempt.intentStatus,
    providerStatus: providerStatus.providerStatus,
    normalizedStatus: providerStatus.status,
    failureReason: providerStatus.failureReason,
    amountMinorPresent: providerStatus.amountMinor !== null,
    currency: providerStatus.currency,
    providerPayload: providerStatus.rawPayload,
    ...extra,
  };
}

export function terminalAmountMismatch(
  attempt: ClaimedPaymentAttempt,
  status: ProviderReconciliationStatus,
): string | null {
  if (status.amountMinor !== null && status.amountMinor !== attempt.amountMinor) {
    return "provider_amount_mismatch";
  }
  if (status.currency && status.currency.toUpperCase() !== attempt.currency.toUpperCase()) {
    return "provider_currency_mismatch";
  }
  return null;
}

export function applyResultKey(attempt: ClaimedPaymentAttempt, status: "succeeded" | "failed"): string {
  return `payment-provider-reconciliation:${attempt.paymentAttemptId}:apply:${status}`;
}

export function observedEvidenceKey(
  attempt: ClaimedPaymentAttempt,
  status: ProviderReconciliationStatusKind,
  correction: "observed" | "failed",
  checkedAt: string,
): string {
  return `payment-provider-reconciliation:${attempt.paymentAttemptId}:${correction}:${status}:${bucket(checkedAt)}`;
}

export function preparedAttemptEvidenceKey(attempt: ClaimedPaymentAttempt, checkedAt: string): string {
  return `payment-provider-reconciliation:${attempt.paymentAttemptId}:failed:prepared_without_provider_ack:${bucket(checkedAt)}`;
}

// Stable (no time bucket): a successful reopen cancels the attempt (it leaves
// `created`), so the RPC is called at most once per attempt; replays after a
// crash return the recorded response via commerce_idempotency_keys.
export function absenceReopenKey(attempt: ClaimedPaymentAttempt): string {
  return `payment-provider-reconciliation:${attempt.paymentAttemptId}:absence-reopen`;
}

export function absenceProbeEvidenceKey(attempt: ClaimedPaymentAttempt, checkedAt: string): string {
  return `payment-provider-reconciliation:${attempt.paymentAttemptId}:absence-probe:${bucket(checkedAt)}`;
}

export function bucket(value: string): string {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return "unknown";
  return String(Math.floor(ms / (30 * 60 * 1000)));
}

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

export function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 240);
}

/**
 * The class the reading adapter already decided, read back off the normalized
 * status so the terminal write can carry it.
 *
 * READ, never re-derived. Both shipped adapters classify what they read through
 * the shared `classifyDecline` seam and put the verdict in `rawPayload`; deriving
 * a second one here would be a second classifier, free to disagree with the one
 * whose reasoning the evidence payload records. It is also why this function is
 * provider-agnostic: it never learns which rail refused, only what that rail
 * concluded.
 *
 * Returns a spreadable fragment rather than a nullable value, so an unclassified
 * refusal leaves the key genuinely ABSENT from the composed call instead of
 * present-and-null. Absence is what the port's contract defines as "behave
 * exactly as before the field existed", and it is what the two non-classifying
 * consumers of that contract are pinned to.
 *
 * A success carries no class by construction: there is no refusal to classify.
 */
export function classificationOf(
  resultStatus: "succeeded" | "failed",
  providerStatus: ProviderReconciliationStatus,
): { failureClassification?: { failureClass: string; decidedBy: string } } {
  if (resultStatus !== "failed") return {};
  const { failureClass, failureClassDecidedBy } = providerStatus.rawPayload;
  if (typeof failureClass !== "string" || failureClass.length === 0) return {};
  if (typeof failureClassDecidedBy !== "string" || failureClassDecidedBy.length === 0) return {};
  return { failureClassification: { failureClass, decidedBy: failureClassDecidedBy } };
}
