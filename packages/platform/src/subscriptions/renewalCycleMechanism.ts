import type {
  PaymentExecutionBaseInput, PaymentExecutionBaseResult, PaymentProviderCapabilityDescriptor,
  ProviderAttemptIdentity,
} from "@openlup/core/payment";
import type { RenewalPreparedAttemptPersistencePort } from "./contracts/renewal.js";
import type {
  HostedRenewalDue, SubscriptionRenewalChargeResult, SubscriptionCycleSnapshotResult,
  SubscriptionCycleOrderResult, RenewalIntentResult, RenewalCycleDeps,
  RenewalExecutionContext, RenewalPrepareInput, RenewalAttemptResult,
  RenewalDeliveryClient, RenewalAllowedAdmission, RenewalDeliveryAdmission,
} from "./contracts/renewal.js";
import {
  recordRenewalPreflightBlock, replayRenewalAttempt, declinedRenewalOutcome, requiresActionRenewalOutcome,
  type RenewalPreflightPolicy, type RenewalReplayPolicy, type RenewalOutcomePolicy,
} from "./renewalCycleRefusalMechanism.js";

export interface RenewalCyclePolicy<D extends HostedRenewalDue, CI, IR extends RenewalIntentResult,
  P extends string, I extends PaymentExecutionBaseInput, M extends string | null | undefined, F extends string> {
  validateProvider(due: D): string | null;
  readTotal(snapshot: Record<string, unknown>): number | null;
  failed(due: D, cycleId: string | null, cycleNumber: number | null, orderId: string | null, intentId: string | null, reason: string): SubscriptionRenewalChargeResult;
  cycleKey(due: D): string;
  executionKey(key: string, retry: number, sequence: number): string;
  intentInput(due: D, key: string, snapshots: SubscriptionCycleSnapshotResult, order: SubscriptionCycleOrderResult, total: number): CI;
  identity(due: D, key: string, intent: IR, order: SubscriptionCycleOrderResult, total: number): ProviderAttemptIdentity;
  providerFlow(flow: string): F;
  prepareInput(due: D, context: RenewalExecutionContext<IR, M, F>): RenewalPrepareInput<P>;
  executionInput(due: D, context: RenewalExecutionContext<IR, M, F>, deps: { capability: PaymentProviderCapabilityDescriptor }): I;
  isNotChargeable(error: unknown): boolean;
  skippedNotChargeable(due: D, context: { cycleId: string; cycleNumber: number; orderId: string; paymentIntentId: string }): SubscriptionRenewalChargeResult;
  finalizeKey(key: string): string;
  executionIndeterminate(): Error;
  defaultNow(): string;
  mandateBlockReason: string;
  invalidTotalsReason: string;
  reservationBlockReason: string;
  preflight: RenewalPreflightPolicy<D, CI, IR>;
  replay: RenewalReplayPolicy;
  outcome: RenewalOutcomePolicy;
}

/** One hosted cycle: admission and stock precede one prepare/execute/finalize. */
export async function executeRenewalCycle<D extends HostedRenewalDue, CI, IR extends RenewalIntentResult,
  P extends string, N extends string, I extends PaymentExecutionBaseInput,
  R extends PaymentExecutionBaseResult & { nextActionKind: N | null },
  M extends string | null | undefined, F extends string>(
  deps: RenewalCycleDeps<CI, IR, P, N, I, R, M>, due: D,
  policy: RenewalCyclePolicy<D, CI, IR, P, I, M, F>,
): Promise<SubscriptionRenewalChargeResult> {
  const deliveryBlock = deps.deliveryAlignmentAdmission ? null
    : (await checkRenewalDeliveryAdmission(deps.deliveryAlignment, due, (deps.now ?? policy.defaultNow)())).blocked;
  if (deliveryBlock) return deliveryBlock;
  const providerValidation = policy.validateProvider(due);
  if (providerValidation !== null) {
    return recordRenewalPreflightBlock(deps, due, providerValidation, policy.preflight);
  }
  const paymentMethodRecurringModel = deps.capability.requiresStoredMandateEvidence
    ? await deps.persistence.readMandateRecurringModel(due.providerKind, due.providerMethodRef) : undefined;
  if (!deps.capability.assessMandate({ recurringModel: paymentMethodRecurringModel }).chargeable) {
    return recordRenewalPreflightBlock(deps, due, policy.mandateBlockReason, policy.preflight);
  }
  const snapshots = await deps.persistence.buildCycleSnapshots({
    subscriptionId: due.subscriptionId,
    scheduledAt: due.nextCycleAt,
  });
  const totalGrossMinor = policy.readTotal(snapshots.orderSnapshot);
  if (totalGrossMinor === null) {
    return policy.failed(due, null, snapshots.cycleNumber, null, null, policy.invalidTotalsReason);
  }
  const cycleOrderIdempotencyKey = policy.cycleKey(due);
  const cycleOrder = await deps.persistence.createCycleOrder({
    idempotencyKey: cycleOrderIdempotencyKey,
    subscriptionId: due.subscriptionId,
    cycleNumber: snapshots.cycleNumber,
    scheduledAt: due.nextCycleAt,
    templateSnapshot: snapshots.templateSnapshot,
    pricingSnapshot: snapshots.pricingSnapshot,
    orderSnapshot: snapshots.orderSnapshot,
  });
  const reservationPreflight = await deps.persistence.preflightReservation({
    orderId: cycleOrder.orderUuid,
    now: (deps.now ?? policy.defaultNow)(),
  });
  if (!reservationPreflight.ok) {
    return policy.failed(
      due,
      cycleOrder.cycleId,
      snapshots.cycleNumber,
      cycleOrder.orderUuid,
      null,
      reservationPreflight.reason ?? policy.reservationBlockReason,
    );
  }
  const intent = await deps.paymentPort.createIntent(policy.intentInput(due, cycleOrderIdempotencyKey, snapshots, cycleOrder, totalGrossMinor));
  const executionIdempotencyKey = policy.executionKey(
    cycleOrderIdempotencyKey, snapshots.retryAttempt, snapshots.providerAttemptSequence,
  );
  const attemptIdentity = policy.identity(due, executionIdempotencyKey, intent, cycleOrder, totalGrossMinor);
  const providerFlow = policy.providerFlow(deps.capability.unattendedChargeFlow);
  const state = { snapshots, cycleOrder, intent, totalGrossMinor, executionIdempotencyKey,
    attemptIdentity, providerFlow, paymentMethodRecurringModel };
  const preparedAttempt = await prepareRenewalAttempt(deps.paymentPort,
    policy.prepareInput(due, state), policy.isNotChargeable);
  if (!preparedAttempt) {
    return policy.skippedNotChargeable(due, {
      cycleId: cycleOrder.cycleId,
      cycleNumber: snapshots.cycleNumber,
      orderId: cycleOrder.orderUuid,
      paymentIntentId: intent.paymentIntentId,
    });
  }
  if (preparedAttempt.replayed) {
    return replayRenewalAttempt(
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
      preparedAttempt.status, policy.replay,
    );
  }
  // DTO construction and dispatch share the indeterminate execution boundary.
  let execution: R;
  try {
    execution = await deps.executionPort.execute(policy.executionInput(due, state, deps));
  } catch {
    throw policy.executionIndeterminate();
  }
  // Finalization is one raw call outside that catch; it cannot authorize redispatch.
  const finalizedAttempt = await deps.paymentPort.finalizeProviderAttempt({
    idempotencyKey: policy.finalizeKey(executionIdempotencyKey),
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
    return declinedRenewalOutcome(deps, due, {
      decline: execution.providerDecline,
      executionIdempotencyKey,
      attemptIdentity,
      intent,
      cycleOrder,
      snapshots,
      finalizedAttempt,
    }, policy.outcome);
  }
  if (execution.attemptStatus === "requires_action") {
    return requiresActionRenewalOutcome(deps, due, {
      executionIdempotencyKey,
      attemptIdentity,
      intent,
      cycleOrder,
      snapshots,
      finalizedAttempt,
    }, policy.outcome);
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

export async function prepareRenewalAttempt<P extends string, N extends string>(
  paymentPort: RenewalPreparedAttemptPersistencePort<P, N>, input: RenewalPrepareInput<P>,
  isNotChargeable: (error: unknown) => boolean,
): Promise<RenewalAttemptResult<N> | null> {
  try {
    return await paymentPort.prepareProviderAttempt(input);
  } catch (error) {
    if (isNotChargeable(error)) return null;
    throw error;
  }
}

export async function checkRenewalDeliveryAdmission(
  client: RenewalDeliveryClient, due: Pick<HostedRenewalDue, "subscriptionId" | "nextCycleAt">, asOf: string,
): Promise<{ admitted: RenewalAllowedAdmission; blocked: null } | { admitted: null; blocked: SubscriptionRenewalChargeResult }> {
  const admission = await callRenewalDeliveryAdmission(client, {
    subscriptionId: due.subscriptionId,
    scheduledAt: due.nextCycleAt,
    asOf,
  });
  if (admission.allowed) {
    return { admitted: admission as RenewalAllowedAdmission, blocked: null };
  }
  return { admitted: null, blocked: {
    subscriptionId: due.subscriptionId,
    outcome: "skipped",
    cycleId: null,
    cycleNumber: null,
    orderId: null,
    paymentIntentId: null,
    attemptStatus: null,
    replayed: false,
    reason: admission.reason,
  } };
}

// Preserve the original admission call's async adoption before observing its result.
async function callRenewalDeliveryAdmission(
  client: RenewalDeliveryClient,
  input: Parameters<RenewalDeliveryClient["admitDeliveryAlignment"]>[0],
): Promise<RenewalDeliveryAdmission> {
  return client.admitDeliveryAlignment(input);
}
