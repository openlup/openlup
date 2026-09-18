import type { PaymentAttemptStatus } from "../../../src/domains/payment/types.js";
import type { PreparedProviderAttemptRuntimePort } from "../../../src/domains/commerce/ports.js";
import { isPaymentControlSubscriptionNotChargeable } from "../../../src/domains/commerce/paymentAttemptAdmission.js";
import { resolveSubscriptionPaymentMethodStatus } from "../../../src/domains/subscription/paymentMethodLifecycle.js";
import type { PayerContextRequirements, PaymentExecutionProviderDecline } from "@openlup/core/payment";
import { declineFailureReason } from "../../shared/finalizeDeclinedAttempt.js";
import { propagateSubscriptionCycleChargeFailure } from "./propagateSubscriptionCycleChargeFailure.js";
import type {
  ChargeDeps,
  DueSubscription,
  SubscriptionRenewalChargeResult,
} from "./chargeSubscriptionCycleOffSession.js";

interface ReplayPreparedAttemptContext {
  cycleId: string;
  cycleNumber: number;
  orderId: string;
  paymentIntentId: string;
  executionIdempotencyKey: string;
  providerIdempotencyKey: string;
  providerRequestFingerprint: string;
  providerKind: string;
}

interface RenewalArtifactContext {
  cycleId: string;
  cycleNumber: number;
  orderId: string;
  paymentIntentId: string;
}

export async function prepareRenewalProviderAttempt(
  paymentPort: PreparedProviderAttemptRuntimePort,
  input: Parameters<PreparedProviderAttemptRuntimePort["prepareProviderAttempt"]>[0],
): Promise<Awaited<ReturnType<PreparedProviderAttemptRuntimePort["prepareProviderAttempt"]>> | null> {
  try {
    return await paymentPort.prepareProviderAttempt(input);
  } catch (error) {
    if (isPaymentControlSubscriptionNotChargeable(error)) return null;
    throw error;
  }
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

export async function replayPreparedAttempt(
  deps: ChargeDeps,
  due: DueSubscription,
  ctx: ReplayPreparedAttemptContext,
  status: PaymentAttemptStatus,
): Promise<SubscriptionRenewalChargeResult> {
  if (status === "requires_action") {
    const propagation = await propagateSubscriptionCycleChargeFailure(deps.chargeFailurePropagation, {
      kind: "off_session_requires_action",
      executionIdempotencyKey: ctx.executionIdempotencyKey,
      providerIdempotencyKey: ctx.providerIdempotencyKey,
      providerRequestFingerprint: ctx.providerRequestFingerprint,
      paymentIntentId: ctx.paymentIntentId,
      cycleId: ctx.cycleId,
      subscriptionId: due.subscriptionId,
      orderUuid: ctx.orderId,
      providerKind: ctx.providerKind,
      failureReason: "off_session_sca_required",
      occurredAt: (deps.now ?? defaultNow)(),
      attemptAlreadyPrepared: true,
    });
    return {
      subscriptionId: due.subscriptionId,
      outcome: "requires_action",
      cycleId: ctx.cycleId,
      cycleNumber: ctx.cycleNumber,
      orderId: ctx.orderId,
      paymentIntentId: ctx.paymentIntentId,
      attemptStatus: status,
      replayed: true,
      dunningCaseId: propagation.dunningCaseId,
      retryAttempt: propagation.retryAttempt,
      applyReplayed: propagation.applyReplayed,
    };
  }
  if (status === "sent_to_provider" || status === "processing") {
    return {
      subscriptionId: due.subscriptionId,
      outcome: "charged",
      cycleId: ctx.cycleId,
      cycleNumber: ctx.cycleNumber,
      orderId: ctx.orderId,
      paymentIntentId: ctx.paymentIntentId,
      attemptStatus: status,
      replayed: true,
    };
  }
  return {
    subscriptionId: due.subscriptionId,
    outcome: "failed",
    cycleId: ctx.cycleId,
    cycleNumber: ctx.cycleNumber,
    orderId: ctx.orderId,
    paymentIntentId: ctx.paymentIntentId,
    attemptStatus: status,
    replayed: true,
    dunningCaseId: null,
    retryAttempt: null,
    reason: status === "created"
      ? "provider_attempt_prepared_without_provider_ack"
      : `provider_attempt_${status}`,
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

export function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 240);
  if (typeof error === "string") return error.slice(0, 240);
  return "unknown_execution_error";
}
