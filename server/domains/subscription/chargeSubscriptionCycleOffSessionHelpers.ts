import { resolveSubscriptionPaymentMethodStatus } from "../../../src/domains/subscription/paymentMethodLifecycle.js";
import type { PayerContextRequirements } from "@openlup/core/payment";
import type {
  DueSubscription,
  SubscriptionRenewalChargeResult,
} from "./chargeSubscriptionCycleOffSession.js";

interface RenewalArtifactContext {
  cycleId: string;
  cycleNumber: number;
  orderId: string;
  paymentIntentId: string;
}

export function skippedNotChargeableRenewalResult(
  due: DueSubscription,
  ctx: RenewalArtifactContext,
): SubscriptionRenewalChargeResult {
  return {
    subscriptionId: due.subscriptionId,
    outcome: "skipped",
    cycleId: ctx.cycleId,
    cycleNumber: ctx.cycleNumber,
    orderId: ctx.orderId,
    paymentIntentId: ctx.paymentIntentId,
    attemptStatus: null,
    replayed: false,
    reason: "subscription_not_chargeable",
  };
}

export function defaultNow(): string {
  return new Date().toISOString();
}

export function validateProviderChargeInput(due: DueSubscription): string | null {
  const resolution = resolveSubscriptionPaymentMethodStatus({
    clientId: due.clientId,
    methodClientId: due.methodClientId,
    providerKind: due.providerKind,
    providerCustomerRef: due.providerCustomerRef,
    providerMethodRef: due.providerMethodRef,
    methodKind: due.methodKind,
    methodStatus: due.methodStatus,
    methodActive: due.methodActive,
    methodExpiresAt: due.methodExpiresAt,
    payerEmail: due.payerEmail,
  });
  return resolution.canAttemptCharge ? null : resolution.preflightReason ?? "payment_method_invalid";
}

export function providerCustomerRef(
  due: DueSubscription,
  payerContext: PayerContextRequirements,
): string | undefined {
  const storedRef = normalizedText(due.providerCustomerRef);
  // A rail with no provider-side customer identifies the payer by contact.
  return payerContext.customerRefFallsBackToContactEmail
    ? storedRef ?? normalizedText(due.payerEmail) ?? undefined
    : storedRef ?? undefined;
}

export function tpayPayer(due: DueSubscription): { email: string; name: string } | undefined {
  const email = normalizedText(due.payerEmail);
  if (!email) return undefined;
  return {
    email,
    name: normalizedText(due.payerName) ?? "Customer",
  };
}

export function readTotalGrossMinor(orderSnapshot: Record<string, unknown>): number | null {
  const totals = orderSnapshot.totals;
  if (!totals || typeof totals !== "object" || Array.isArray(totals)) return null;
  const totalGross = (totals as Record<string, unknown>).totalGross;
  if (!totalGross || typeof totalGross !== "object" || Array.isArray(totalGross)) return null;
  const amount = (totalGross as Record<string, unknown>).amountMinor;
  return typeof amount === "number" && Number.isInteger(amount) && amount > 0 ? amount : null;
}

export function failureResult(
  due: DueSubscription,
  cycleId: string | null,
  cycleNumber: number | null,
  orderId: string | null,
  paymentIntentId: string | null,
  reason: string,
  propagation?: { dunningCaseId: string | null; retryAttempt: number | null },
): SubscriptionRenewalChargeResult {
  return {
    subscriptionId: due.subscriptionId,
    outcome: "failed",
    cycleId,
    cycleNumber,
    orderId,
    paymentIntentId,
    attemptStatus: propagation ? "failed" : null,
    replayed: false,
    dunningCaseId: propagation?.dunningCaseId ?? null,
    retryAttempt: propagation?.retryAttempt ?? null,
    reason,
  };
}

function normalizedText(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

export function buildCycleOrderIdempotencyKey(due: DueSubscription): string {
  return `subscription:${due.subscriptionId}:cycle:${due.nextCycleAt}`;
}

export function buildExecutionIdempotencyKey(
  cycleOrderIdempotencyKey: string,
  retryAttempt: number,
  providerAttemptSequence: number,
): string {
  const base = `${cycleOrderIdempotencyKey}:payment-execution:attempt:${retryAttempt}`;
  return providerAttemptSequence > 0 ? `${base}:provider-seq:${providerAttemptSequence}` : base;
}
