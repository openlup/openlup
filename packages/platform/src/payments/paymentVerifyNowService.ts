import type { ProviderReadPurpose } from "./contracts/evidence.js";
import type { VerifiableAttemptSnapshot, PaymentVerifyReadPort, PaymentVerifyNowResult } from "./contracts/reconciliation.js";
import type {
  ClaimedPaymentAttempt,
  PaymentProviderReconciliationPort,
  PaymentProviderReconciliationProvider,
  ProviderReconciliationStatus,
} from "./contracts/reconciliation.js";
import { applyResultKey, evidencePayload, terminalAmountMismatch } from "./paymentProviderReconciliationEvidence.js";

const LIVE_ATTEMPT_STATUSES = new Set(["sent_to_provider", "requires_action", "processing", "created"]);

/**
 * Shared buyer/cron-compatible live PSP read. It never accepts a browser
 * outcome and terminal writes still pass through the canonical reconciliation
 * RPC, so recovery cannot create a second payment truth path.
 */
export async function verifyPaymentAttemptNow(input: {
  snapshot: VerifiableAttemptSnapshot;
  applyPort: Pick<PaymentProviderReconciliationPort, "applyTerminalResult">;
  providers: Partial<Record<string, PaymentProviderReconciliationProvider>>;
  now: () => Date;
  providerPaymentId?: string;
  providerStatus?: ProviderReconciliationStatus;
  /**
   * Passed straight to the provider read. A caller that omits it gets the
   * reconciliation reading, in which an intent still waiting for its first
   * payment method is a finished, abandoned attempt.
   */
  purpose?: ProviderReadPurpose;
}): Promise<PaymentVerifyNowResult> {
  const { snapshot } = input;
  if (!LIVE_ATTEMPT_STATUSES.has(snapshot.attemptStatus)) {
    return { status: snapshot.attemptStatus, verified: false, applied: false, providerPaymentId: null, attempt: null };
  }

  const provider = input.providers[snapshot.provider];
  const providerPaymentId = input.providerPaymentId
    ?? snapshot.providerAttemptId
    ?? snapshot.intentProviderPaymentId
    ?? snapshot.providerSessionId;
  if (!provider || !providerPaymentId) {
    return { status: "unavailable", verified: false, applied: false, providerPaymentId, attempt: null };
  }

  const attempt = toClaimedAttemptShape(snapshot, providerPaymentId);
  const providerStatus = input.providerStatus
    ?? await provider.readPayment({
      providerPaymentId,
      attempt,
      ...(input.purpose ? { purpose: input.purpose } : {}),
    });
  if (providerStatus.status !== "succeeded" && providerStatus.status !== "failed") {
    return {
      // Preserve the established payment-verify contract: an unknown provider
      // vocabulary is still non-terminal and therefore reported as pending.
      status: "pending",
      verified: true,
      applied: false,
      providerPaymentId,
      attempt,
    };
  }

  if (terminalAmountMismatch(attempt, providerStatus)) {
    return { status: "manual_review", verified: true, applied: false, providerPaymentId, attempt };
  }

  const checkedAt = input.now().toISOString();
  const applied = await input.applyPort.applyTerminalResult({
    idempotencyKey: applyResultKey(attempt, providerStatus.status),
    expectedOrderId: snapshot.orderId,
    expectedPaymentIntentId: snapshot.paymentIntentId,
    expectedPaymentAttemptId: snapshot.paymentAttemptId,
    expectedPaymentId: snapshot.paymentId,
    provider: attempt.provider,
    providerPaymentId,
    localStatus: snapshot.attemptStatus,
    providerStatus: providerStatus.providerStatus,
    resultStatus: providerStatus.status,
    occurredAt: providerStatus.occurredAt ?? checkedAt,
    failureReason: providerStatus.status === "failed"
      ? providerStatus.failureReason ?? `provider_verify_${providerStatus.providerStatus}`
      : null,
    checkedAt,
    payload: evidencePayload(attempt, providerStatus, {
      source: "commerce-payment-verify.v0",
      trigger: "buyer_confirm_settled",
    }),
  });

  return {
    status: providerStatus.status,
    verified: true,
    applied: applied.correctionStatus === "corrected" && !applied.replayed,
    providerPaymentId,
    attempt,
  };
}

export function toClaimedAttemptShape(
  snapshot: VerifiableAttemptSnapshot,
  providerPaymentId: string,
): ClaimedPaymentAttempt {
  return {
    paymentAttemptId: snapshot.paymentAttemptId,
    paymentIntentId: snapshot.paymentIntentId,
    paymentId: snapshot.paymentId,
    orderId: snapshot.orderId,
    subscriptionId: null,
    subscriptionCycleId: null,
    provider: snapshot.provider as ClaimedPaymentAttempt["provider"],
    providerPaymentId,
    providerAttemptId: snapshot.providerAttemptId,
    providerSessionId: snapshot.providerSessionId,
    attemptStatus: snapshot.attemptStatus,
    intentStatus: snapshot.intentStatus,
    amountMinor: snapshot.amountMinor,
    currency: snapshot.currency,
    orderMode: snapshot.orderMode as ClaimedPaymentAttempt["orderMode"],
    cycleRetryAttempt: 0,
    cycleNextRetryAt: null,
    localUpdatedAt: snapshot.localUpdatedAt,
  };
}
