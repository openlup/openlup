import type { PaymentExecutionResult, PaymentProviderFlow } from "../../../src/domains/payment/types.js";
import { buildProviderAttemptIdentity } from "../../../src/lib/providerAttemptIdempotency.js";
import { acceptedCycleCurrency } from "./subscriptionCycleOrderTotals.js";
import { recordSubscriptionRenewalPreflightBlock } from "./recordSubscriptionRenewalPreflightBlock.js";
import {
  buildCycleOrderIdempotencyKey, buildExecutionIdempotencyKey,
  defaultNow, failureResult,
  providerCustomerRef, prepareRenewalProviderAttempt,
  readTotalGrossMinor, replayPreparedAttempt,
  skippedNotChargeableRenewalResult,
  tpayPayer, validateProviderChargeInput,
} from "./chargeSubscriptionCycleOffSessionHelpers.js";
import { declinedRenewalResult, requiresActionRenewalResult } from "./subscriptionRenewalOutcomes.js";
import { deliveryAlignmentBlockResult } from "./callSubscriptionDeliveryAlignmentAdmission.js";
import type {
  DueSubscription, SubscriptionRenewalChargeDeps, SubscriptionRenewalChargeResult,
} from "./automaticRenewalPorts.js";
export type {
  DueSubscription, SubscriptionRenewalChargeResult, SubscriptionRenewalPersistencePort,
} from "./automaticRenewalPorts.js";
export type ChargeDeps = SubscriptionRenewalChargeDeps;
/**
 * Wave D-2 — off-session subscription renewal orchestrator.
 *
 * Builds immutable cycle snapshots, creates/replays the local cycle order and
 * payment intent, dispatches the injected PSP adapter, and records attempts.
 * Webhooks remain the canonical terminal-state writer. Provider execution keys
 * are scoped by `retry_attempt`; local order/intent keys stay stable. (CJ01-P)
 */
export async function chargeSubscriptionCycleOffSession(
  deps: SubscriptionRenewalChargeDeps,
  due: DueSubscription,
): Promise<SubscriptionRenewalChargeResult> {
  const deliveryBlock = deps.deliveryAlignmentAdmission ? null
    : await deliveryAlignmentBlockResult(deps.deliveryAlignment, due, (deps.now ?? defaultNow)());
  if (deliveryBlock) return deliveryBlock;
  const providerValidation = validateProviderChargeInput(due);
  if (providerValidation !== null) {
    return recordSubscriptionRenewalPreflightBlock(deps, due, providerValidation);
  }

  // Validate stored consent before creating a durable provider attempt: local DB evidence,
  // not a PSP call, so a consent that cannot back an unattended charge enters customer repair
  // instead of being mislabeled indeterminate. A rail that judges without it skips the read.
  const paymentMethodRecurringModel = deps.capability.requiresStoredMandateEvidence
    ? await deps.persistence.readMandateRecurringModel(due.providerKind, due.providerMethodRef) : undefined;
  if (!deps.capability.assessMandate({ recurringModel: paymentMethodRecurringModel }).chargeable) {
    // PERSISTED block reason: the capability's verdict is neutral, but dunning cases, alert
    // queries and tests match this exact string. Renaming it is a separate, enumerated wave.
    return recordSubscriptionRenewalPreflightBlock(deps, due, "tpay_recurring_requires_model_o");
  }

  const snapshots = await deps.persistence.buildCycleSnapshots({
    subscriptionId: due.subscriptionId,
    scheduledAt: due.nextCycleAt,
  });

  const totalGrossMinor = readTotalGrossMinor(snapshots.orderSnapshot);
  if (totalGrossMinor === null) {
    return failureResult(due, null, snapshots.cycleNumber, null, null, "invalid_totals");
  }

  const cycleOrderIdempotencyKey = buildCycleOrderIdempotencyKey(due);
  const cycleOrder = await deps.persistence.createCycleOrder({
    idempotencyKey: cycleOrderIdempotencyKey,
    subscriptionId: due.subscriptionId,
    cycleNumber: snapshots.cycleNumber,
    scheduledAt: due.nextCycleAt,
    templateSnapshot: snapshots.templateSnapshot,
    pricingSnapshot: snapshots.pricingSnapshot,
    orderSnapshot: snapshots.orderSnapshot,
  });

  // Stock preflight BEFORE any money moves (fail closed; re-acquires expired
  // holds via the provider stock authority). No dunning on block — the customer
  // cannot fix stock; the cycle stays payment_pending for the next tick.
  const reservationPreflight = await deps.persistence.preflightReservation({
    orderId: cycleOrder.orderUuid,
    now: (deps.now ?? defaultNow)(),
  });
  if (!reservationPreflight.ok) {
    return failureResult(
      due,
      cycleOrder.cycleId,
      snapshots.cycleNumber,
      cycleOrder.orderUuid,
      null,
      reservationPreflight.reason ?? "reservation_preflight_blocked",
    );
  }

  const intent = await deps.paymentPort.createIntent({
    idempotencyKey: `${cycleOrderIdempotencyKey}:payment-intent`,
    targetKind: "subscription_cycle",
    orderId: cycleOrder.orderUuid,
    subscriptionId: due.subscriptionId,
    subscriptionCycleId: cycleOrder.cycleId,
    amountMinor: totalGrossMinor,
    currency: acceptedCycleCurrency(due.currency),
    metadata: {
      source: "subscription.renewal.cron.v0",
      runtimeIdempotencyKey: cycleOrderIdempotencyKey,
      cycleNumber: snapshots.cycleNumber,
      scheduledAt: due.nextCycleAt,
    },
  });

  // Per-attempt key (0 = initial, 1+ = retries) — see module header. CJ01-P.
  const executionIdempotencyKey = buildExecutionIdempotencyKey(
    cycleOrderIdempotencyKey, snapshots.retryAttempt, snapshots.providerAttemptSequence,
  );
  const attemptIdentity = buildProviderAttemptIdentity({
    provider: due.providerKind,
    localExecutionIdempotencyKey: executionIdempotencyKey,
    paymentIntentId: intent.paymentIntentId,
    amountMinor: totalGrossMinor,
    currency: due.currency,
    mode: "subscription_cycle",
    orderRef: cycleOrder.orderRef,
  });
  // Neutral flow name; a value outside the local contract is an adapter defect the matrix fails on.
  const providerFlow = deps.capability.unattendedChargeFlow as PaymentProviderFlow;

  const preparedAttempt = await prepareRenewalProviderAttempt(deps.paymentPort, {
    idempotencyKey: `${executionIdempotencyKey}:prepare-attempt`,
    paymentIntentId: intent.paymentIntentId,
    provider: due.providerKind as "stripe" | "tpay",
    providerIdempotencyKey: attemptIdentity.providerIdempotencyKey,
    providerRequestFingerprint: attemptIdentity.providerRequestFingerprint,
    providerFlow,
    paymentMethodRef: due.providerMethodRef,
    requestPayload: {
      source: "subscription.renewal.cron.v0",
      providerIdempotencyKey: attemptIdentity.providerIdempotencyKey,
      providerRequestFingerprint: attemptIdentity.providerRequestFingerprint,
      providerFlow,
      paymentMethodRef: due.providerMethodRef,
      amountMinor: totalGrossMinor,
      currency: due.currency,
      scheduledAt: due.nextCycleAt,
      retryAttempt: snapshots.retryAttempt,
      providerAttemptSequence: snapshots.providerAttemptSequence,
    },
  });
  if (!preparedAttempt) {
    return skippedNotChargeableRenewalResult(due, {
      cycleId: cycleOrder.cycleId,
      cycleNumber: snapshots.cycleNumber,
      orderId: cycleOrder.orderUuid,
      paymentIntentId: intent.paymentIntentId,
    });
  }

  if (preparedAttempt.replayed) {
    return replayPreparedAttempt(
      deps,
      due,
      {
        cycleId: cycleOrder.cycleId,
        cycleNumber: snapshots.cycleNumber,
        orderId: cycleOrder.orderUuid,
        paymentIntentId: intent.paymentIntentId,
        executionIdempotencyKey,
        providerIdempotencyKey: attemptIdentity.providerIdempotencyKey,
        providerRequestFingerprint: attemptIdentity.providerRequestFingerprint,
        providerKind: due.providerKind,
      },
      preparedAttempt.status,
    );
  }

  let execution: PaymentExecutionResult;
  try {
    execution = await deps.executionPort.execute({
      idempotencyKey: executionIdempotencyKey,
      providerIdempotencyKey: attemptIdentity.providerIdempotencyKey,
      providerRequestFingerprint: attemptIdentity.providerRequestFingerprint,
      paymentIntentId: intent.paymentIntentId,
      amountMinor: totalGrossMinor,
      currency: due.currency,
      mode: "subscription_cycle",
      orderRef: cycleOrder.orderRef,
      providerFlow,
      customerRef: providerCustomerRef(due, deps.capability.payerContext),
      paymentMethodRef: due.providerMethodRef ?? undefined,
      paymentMethodRecurringModel,
      clientId: due.clientId,
      payer: deps.capability.payerContext.requiresPayerBlock ? tpayPayer(due) : undefined,
    });
  } catch {
    // A thrown PSP call is not decline evidence. It may be a timeout after the
    // provider accepted the charge, so applying `failed` here would open dunning
    // and eventually authorize a fresh idempotency key — a double-charge window.
    // Keep the durable attempt at `created`; the next renewal tick replays it
    // without another provider call and reconciliation/webhook/operator proof
    // remains the only authority that can resolve the ambiguity.
    throw new Error("provider_execution_indeterminate");
  }

  const finalizedAttempt = await deps.paymentPort.finalizeProviderAttempt({
    idempotencyKey: `${executionIdempotencyKey}:finalize-attempt`,
    paymentIntentId: intent.paymentIntentId,
    paymentAttemptId: preparedAttempt.paymentAttemptId,
    providerIdempotencyKey: attemptIdentity.providerIdempotencyKey,
    providerRequestFingerprint: attemptIdentity.providerRequestFingerprint,
    providerAttemptId: execution.providerAttemptId,
    providerSessionId: execution.providerSessionId,
    attemptStatus: execution.attemptStatus,
    nextActionKind: execution.nextActionKind,
    requestPayload: execution.requestPayload,
    responsePayload: execution.responsePayload,
  });

  if (execution.providerDecline) {
    return declinedRenewalResult(deps, due, {
      decline: execution.providerDecline,
      executionIdempotencyKey,
      attemptIdentity,
      intent,
      cycleOrder,
      snapshots,
      finalizedAttempt,
    });
  }

  if (execution.attemptStatus === "requires_action") {
    return requiresActionRenewalResult(deps, due, {
      executionIdempotencyKey,
      attemptIdentity,
      intent,
      cycleOrder,
      snapshots,
      finalizedAttempt,
    });
  }

  return {
    subscriptionId: due.subscriptionId,
    outcome: "charged",
    cycleId: cycleOrder.cycleId,
    cycleNumber: snapshots.cycleNumber,
    orderId: cycleOrder.orderUuid,
    paymentIntentId: intent.paymentIntentId,
    attemptStatus: finalizedAttempt.status,
    replayed: cycleOrder.replayed || intent.replayed,
  };
}
