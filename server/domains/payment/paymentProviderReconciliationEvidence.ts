import type {
  ClaimedPaymentAttempt,
  ProviderReconciliationStatus,
} from "./paymentProviderReconciliationContracts.js";

export {
  applyResultKey,
  observedEvidenceKey,
  preparedAttemptEvidenceKey,
  absenceReopenKey,
  absenceProbeEvidenceKey,
  bucket,
  clamp,
  safeMessage,
  classificationOf,
} from "@openlup/platform/payments";

/**
 * Managed Supabase reconciliation evidence payload. Kept distinct from the
 * native PostgreSQL capture-evidence payload until the managed Supabase apply
 * RPC carries the pre-upgrade replay-compatibility strip for `amountMinor` and
 * `capturedAmountBasis`.
 */
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
  if (status.status === "succeeded" && status.amountMinor === null) {
    return "provider_amount_missing";
  }
  if ((status.status === "succeeded" && status.failureReason === "provider_amount_mismatch")
    || (status.amountMinor !== null && status.amountMinor !== attempt.amountMinor)) {
    return "provider_amount_mismatch";
  }
  if (status.status === "succeeded" && !status.currency?.trim()) {
    return "provider_currency_missing";
  }
  if (status.currency && status.currency.toUpperCase() !== attempt.currency.toUpperCase()) {
    return "provider_currency_mismatch";
  }
  return null;
}
