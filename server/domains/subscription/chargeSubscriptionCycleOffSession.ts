import { executeRenewalCycle, type RenewalCyclePolicy } from "@openlup/platform/subscriptions";
import type { PaymentExecutionInput, PaymentExecutionProvider, PaymentProviderFlow } from "../../../src/domains/payment/types.js";
import { buildProviderAttemptIdentity } from "../../../src/lib/providerAttemptIdempotency.js";
import { acceptedCycleCurrency } from "./subscriptionCycleOrderTotals.js";
import {
  buildCycleOrderIdempotencyKey, buildExecutionIdempotencyKey, defaultNow, failureResult,
  providerCustomerRef, readTotalGrossMinor, skippedNotChargeableRenewalResult,
  tpayPayer, validateProviderChargeInput,
} from "./chargeSubscriptionCycleOffSessionHelpers.js";
import { isPaymentControlSubscriptionNotChargeable } from "../../../src/domains/commerce/paymentAttemptAdmission.js";
import { classifyDecline, declineFailureReason } from "../../shared/finalizeDeclinedAttempt.js";
import { isOperatorOnlyPreflightReason } from "./recordSubscriptionRenewalPreflightBlock.js";
import { renewalFailurePolicy } from "./propagateSubscriptionCycleChargeFailure.js";
import type { DueSubscription, SubscriptionRenewalChargeDeps, SubscriptionRenewalChargeResult } from "./automaticRenewalPorts.js";
export type { DueSubscription, SubscriptionRenewalChargeResult, SubscriptionRenewalPersistencePort } from "./automaticRenewalPorts.js";
export type ChargeDeps = SubscriptionRenewalChargeDeps;
type IntentInput = Parameters<ChargeDeps["paymentPort"]["createIntent"]>[0];
type Intent = Awaited<ReturnType<ChargeDeps["paymentPort"]["createIntent"]>>;

const identity = (due: DueSubscription, key: string, intent: Intent, order: { orderRef: string }, total: number) =>
  buildProviderAttemptIdentity({ provider: due.providerKind, localExecutionIdempotencyKey: key,
    paymentIntentId: intent.paymentIntentId, amountMinor: total, currency: due.currency,
    mode: "subscription_cycle", orderRef: order.orderRef });
const intentInput = (due: DueSubscription, key: string, snapshots: { cycleNumber: number }, order: { orderUuid: string; cycleId: string }, total: number): IntentInput => ({
  idempotencyKey: `${key}:payment-intent`, targetKind: "subscription_cycle", orderId: order.orderUuid,
  subscriptionId: due.subscriptionId, subscriptionCycleId: order.cycleId,
  amountMinor: total, currency: acceptedCycleCurrency(due.currency),
  metadata: { source: "subscription.renewal.cron.v0", runtimeIdempotencyKey: key,
    cycleNumber: snapshots.cycleNumber, scheduledAt: due.nextCycleAt },
});
const policy: RenewalCyclePolicy<DueSubscription, IntentInput, Intent, PaymentExecutionProvider, PaymentExecutionInput, "O" | "M" | undefined, PaymentProviderFlow> = {
  validateProvider: validateProviderChargeInput, readTotal: readTotalGrossMinor, failed: failureResult,
  cycleKey: buildCycleOrderIdempotencyKey, executionKey: buildExecutionIdempotencyKey,
  intentInput, identity, providerFlow: flow => flow as PaymentProviderFlow,
  prepareInput(due, ctx) { return {
    idempotencyKey: `${ctx.executionIdempotencyKey}:prepare-attempt`, paymentIntentId: ctx.intent.paymentIntentId,
    provider: due.providerKind as PaymentExecutionProvider, providerIdempotencyKey: ctx.attemptIdentity.providerIdempotencyKey,
    providerRequestFingerprint: ctx.attemptIdentity.providerRequestFingerprint, providerFlow: ctx.providerFlow,
    paymentMethodRef: due.providerMethodRef, requestPayload: { source: "subscription.renewal.cron.v0",
      providerIdempotencyKey: ctx.attemptIdentity.providerIdempotencyKey,
      providerRequestFingerprint: ctx.attemptIdentity.providerRequestFingerprint, providerFlow: ctx.providerFlow,
      paymentMethodRef: due.providerMethodRef, amountMinor: ctx.totalGrossMinor, currency: due.currency,
      scheduledAt: due.nextCycleAt, retryAttempt: ctx.snapshots.retryAttempt,
      providerAttemptSequence: ctx.snapshots.providerAttemptSequence },
  }; },
  executionInput(due, ctx, deps) { return {
    idempotencyKey: ctx.executionIdempotencyKey, providerIdempotencyKey: ctx.attemptIdentity.providerIdempotencyKey,
    providerRequestFingerprint: ctx.attemptIdentity.providerRequestFingerprint,
    paymentIntentId: ctx.intent.paymentIntentId, amountMinor: ctx.totalGrossMinor, currency: due.currency,
    mode: "subscription_cycle", orderRef: ctx.cycleOrder.orderRef, providerFlow: ctx.providerFlow,
    customerRef: providerCustomerRef(due, deps.capability.payerContext), paymentMethodRef: due.providerMethodRef ?? undefined,
    paymentMethodRecurringModel: ctx.paymentMethodRecurringModel, clientId: due.clientId,
    payer: deps.capability.payerContext.requiresPayerBlock ? tpayPayer(due) : undefined,
  }; },
  isNotChargeable: isPaymentControlSubscriptionNotChargeable, skippedNotChargeable: skippedNotChargeableRenewalResult,
  finalizeKey: key => `${key}:finalize-attempt`, executionIndeterminate: () => new Error("provider_execution_indeterminate"),
  defaultNow, mandateBlockReason: "tpay_recurring_requires_model_o", invalidTotalsReason: "invalid_totals",
  reservationBlockReason: "reservation_preflight_blocked",
  preflight: {
    isOperatorOnly: isOperatorOnlyPreflightReason,
    logOperatorBlock: fields => console.warn("[subscription-renewal] operator-only preflight block; skipping customer dunning", fields),
    readTotal: readTotalGrossMinor, cycleKey: buildCycleOrderIdempotencyKey, executionKey: buildExecutionIdempotencyKey,
    intentInput: (due, key, snapshots, order, total, reason) => ({ ...intentInput(due, key, snapshots, order, total),
      metadata: { source: "subscription.renewal.preflight.v0", runtimeIdempotencyKey: key,
        cycleNumber: snapshots.cycleNumber, scheduledAt: due.nextCycleAt, preflightBlockReason: reason } }),
    identity: (due, key, intent, order, total) => identity({ ...due, providerKind: (due.providerKind.trim() || "unknown") }, key, intent, order, total), normalizedProvider: provider => (provider.trim() || "unknown"),
    failed: (due, cycleId, cycleNumber, orderId, intentId, reason, propagation) => ({
      ...failureResult(due, cycleId, cycleNumber, orderId, intentId, reason, propagation),
      applyReplayed: propagation?.applyReplayed, dunningPropagationFailed: propagation?.dunningPropagationFailed,
    }),
    invalidTotalsReason: "invalid_totals", defaultNow, failure: renewalFailurePolicy,
  },
  replay: { scaReason: "off_session_sca_required", defaultNow, failure: renewalFailurePolicy,
    unacknowledgedReason: status => status === "created" ? "provider_attempt_prepared_without_provider_ack" : `provider_attempt_${status}` },
  outcome: { declineReason: declineFailureReason, classifyDecline, scaReason: "off_session_sca_required", defaultNow, failure: renewalFailurePolicy },
};

/** Application policy binds the unchanged package mechanism to M07 and its existing key dialect. */
export async function chargeSubscriptionCycleOffSession(deps: ChargeDeps, due: DueSubscription): Promise<SubscriptionRenewalChargeResult> {
  return executeRenewalCycle(deps, due, policy);
}
