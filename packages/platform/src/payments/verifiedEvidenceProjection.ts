import type {
  PaymentRefundObservation, PaymentVerifyNormalizePort, RefundEvidencePolicy,
  VerifiedMethodEvidence, VerifiedPaymentEvidence,
} from "./contracts/evidence.js";
import type { ProviderWebhookWithMethodLifecycle } from "./paymentMethodLifecycle.js";
import type { ProviderPaymentWebhookKind } from "./verifiedIngress.js";

/** New boundary module: verified adapter envelopes into the unchanged donor carrier. */
export function projectVerifiedEvidence(
  evidence: VerifiedPaymentEvidence | VerifiedMethodEvidence,
  input: Parameters<PaymentVerifyNormalizePort["verifyAndNormalize"]>[0],
  policy: RefundEvidencePolicy,
): ProviderWebhookWithMethodLifecycle {
  const payload: unknown = JSON.parse(new TextDecoder().decode(input.rawBody));
  if (!isPayload(payload)) throw new Error("payment_payload_invalid");
  const base = {
    provider: evidence.provider, providerEventId: evidence.providerEventId,
    occurredAt: input.receivedAt, rawPayload: payload,
    paymentIntentId: evidence.intentRef,
  };
  switch (evidence.kind) {
    case "money": {
      const reversal = evidence.refund;
      const refundKind = evidence.outcome === "refunded"
        ? reversal ? projectRefund(reversal, evidence) : policy === "legacy-assume-full" ? "full" : null
        : undefined;
      return {
        ...base, eventType: moneyEvent(evidence.outcome, reversal),
        providerPaymentId: evidence.providerPaymentRef, paymentAttemptId: evidence.attemptRef,
        amountMinor: evidence.money?.amountMinor ?? null, currency: evidence.money?.currency ?? null,
        refundKind,
      };
    }
    case "method":
      return {
        ...base, eventType: methodEvent(evidence.outcome),
        // Pinned donor normalizer :59 calls resolveLinkagePaymentId :146–154:
        // setup/method objects use their own object id as the carrier reference.
        providerPaymentId: evidence.setupRef ?? evidence.methodRef,
        methodLifecycle: evidence.methodLifecycle,
      };
  }
  return assertNever(evidence);
}

function moneyEvent(outcome: VerifiedPaymentEvidence["outcome"], refund: PaymentRefundObservation | undefined): ProviderPaymentWebhookKind {
  switch (outcome) {
    case "succeeded": return "payment.succeeded";
    case "failed": return "payment.failed";
    case "pending": return "payment.requires_action";
    case "refunded": return refund?.kind === "full-reversal" && refund.reason === "chargeback" ? "payment.disputed" : "payment.refunded";
    case "disputed": return "payment.disputed";
  }
  return assertNever(outcome);
}

function methodEvent(outcome: VerifiedMethodEvidence["outcome"]): ProviderPaymentWebhookKind {
  switch (outcome) {
    case "registered": case "updated": return "setup.succeeded";
    case "revoked": case "expired": case "suspended": case "failed": return "setup.failed";
    case "requires-action": return "setup.requires_action";
  }
  return assertNever(outcome);
}

function projectRefund(refund: PaymentRefundObservation, evidence: VerifiedPaymentEvidence): "full" | "partial" {
  const original = refund.originalPaymentMoney;
  if (!refund.operationId?.trim() || !evidence.providerPaymentRef.trim()
    || !Number.isSafeInteger(original?.amountMinor) || original.amountMinor <= 0
    || !original.currency?.trim() || !evidence.money
    || evidence.money.amountMinor !== original.amountMinor || evidence.money.currency !== original.currency) {
    throw new Error("payment_refund_identity_money_required");
  }
  switch (refund.kind) {
    case "full-reversal": return "full";
    case "cumulative-snapshot": case "event-delta": {
      const money = refund.refundedMoney;
      if (!Number.isSafeInteger(money?.amountMinor) || money.amountMinor <= 0
        || money.amountMinor > original.amountMinor || money.currency !== original.currency) {
        throw new Error("payment_refund_money_invalid");
      }
      return money.amountMinor < original.amountMinor ? "partial" : "full";
    }
  }
  return assertNever(refund);
}

function assertNever(value: never): never {
  throw new Error(`payment_evidence_unmapped:${String(value)}`);
}

function isPayload(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
