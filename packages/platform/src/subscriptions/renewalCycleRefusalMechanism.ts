import type { PaymentAttemptStatus, PaymentExecutionProviderDecline, ProviderAttemptIdentity } from "@openlup/core/payment";
import type {
  HostedRenewalDue, SubscriptionRenewalChargeResult, SubscriptionCycleSnapshotResult,
  SubscriptionCycleOrderResult, RenewalIntentResult, RenewalPreflightDeps,
  RenewalFailureDeps, RenewalOutcomeContext, RenewalReplayContext, FailurePropagationResult,
} from "./contracts/renewal.js";
import { propagateRenewalFailure, type RenewalFailurePolicy } from "./renewalCycleFailureMechanism.js";

export interface RenewalPreflightPolicy<D extends HostedRenewalDue, CI, IR extends RenewalIntentResult> {
  isOperatorOnly(reason: string): boolean;
  logOperatorBlock(fields: { subscriptionId: string; providerKind: string; reason: string }): void;
  readTotal(snapshot: Record<string, unknown>): number | null;
  cycleKey(due: D): string;
  executionKey(cycleKey: string, retry: number, sequence: number): string;
  intentInput(due: D, key: string, snapshots: SubscriptionCycleSnapshotResult, order: SubscriptionCycleOrderResult, total: number, reason: string): CI;
  identity(due: D, key: string, intent: IR, order: SubscriptionCycleOrderResult, total: number): ProviderAttemptIdentity;
  normalizedProvider(provider: string): string;
  failed(due: D, cycleId: string | null, cycleNumber: number | null, orderId: string | null, intentId: string | null, reason: string, propagation?: FailurePropagationResult): SubscriptionRenewalChargeResult;
  invalidTotalsReason: string;
  defaultNow(): string;
  failure: RenewalFailurePolicy;
}
export interface RenewalOutcomePolicy {
  declineReason(decline: PaymentExecutionProviderDecline): string;
  classifyDecline(decline: PaymentExecutionProviderDecline): { failureClass: string; decidedBy: string };
  scaReason: string;
  defaultNow(): string;
  failure: RenewalFailurePolicy;
}
export interface RenewalReplayPolicy extends Pick<RenewalOutcomePolicy, "scaReason" | "defaultNow" | "failure"> {
  unacknowledgedReason(status: PaymentAttemptStatus): string;
}

/** Alternate preflight owns its full order/intent/failure chain, without reservation or dispatch. */
export async function recordRenewalPreflightBlock<D extends HostedRenewalDue, CI,
  IR extends RenewalIntentResult, M extends string | null | undefined>(
  deps: RenewalPreflightDeps<CI, IR, M>, due: D, reason: string,
  policy: RenewalPreflightPolicy<D, CI, IR>,
): Promise<SubscriptionRenewalChargeResult> {
  if (policy.isOperatorOnly(reason)) {
    policy.logOperatorBlock({ subscriptionId: due.subscriptionId, providerKind: due.providerKind, reason });
    return policy.failed(due, null, null, null, null, reason);
  }
  const snapshots = await deps.persistence.buildCycleSnapshots({
    subscriptionId: due.subscriptionId,
    scheduledAt: due.nextCycleAt,
  });
  const totalGrossMinor = policy.readTotal(snapshots.orderSnapshot);
  if (totalGrossMinor === null) {
    return policy.failed(due, null, snapshots.cycleNumber, null, null, policy.invalidTotalsReason);
  }
  const cycleKey = policy.cycleKey(due);
  const cycleOrder = await deps.persistence.createCycleOrder({
    idempotencyKey: cycleKey,
    subscriptionId: due.subscriptionId,
    cycleNumber: snapshots.cycleNumber,
    scheduledAt: due.nextCycleAt,
    templateSnapshot: snapshots.templateSnapshot,
    pricingSnapshot: snapshots.pricingSnapshot,
    orderSnapshot: snapshots.orderSnapshot,
  });
  const intent = await deps.paymentPort.createIntent(policy.intentInput(due, cycleKey, snapshots, cycleOrder, totalGrossMinor, reason));
  const executionKey = policy.executionKey(
    cycleKey, snapshots.retryAttempt, snapshots.providerAttemptSequence,
  );
  const attempt = policy.identity(due, executionKey, intent, cycleOrder, totalGrossMinor);
  const propagation = await propagateRenewalFailure(deps.chargeFailurePropagation, {
    kind: "preflight_block",
    executionIdempotencyKey: executionKey,
    providerIdempotencyKey: attempt.providerIdempotencyKey,
    providerRequestFingerprint: attempt.providerRequestFingerprint,
    paymentIntentId: intent.paymentIntentId,
    cycleId: cycleOrder.cycleId,
    subscriptionId: due.subscriptionId,
    orderUuid: cycleOrder.orderUuid,
    providerKind: policy.normalizedProvider(due.providerKind),
    failureReason: reason,
    occurredAt: (deps.now ?? policy.defaultNow)(),
  }, policy.failure);
  return policy.failed(
    due,
    cycleOrder.cycleId,
    snapshots.cycleNumber,
    cycleOrder.orderUuid,
    intent.paymentIntentId,
    reason,
    propagation,
  );
}

export async function declinedRenewalOutcome<D extends HostedRenewalDue>(
  deps: RenewalFailureDeps, due: D, context: RenewalOutcomeContext & { decline: PaymentExecutionProviderDecline }, policy: RenewalOutcomePolicy,
): Promise<SubscriptionRenewalChargeResult> {
  const propagation = await propagateRenewalFailure(deps.chargeFailurePropagation, {
    kind: "provider_declined",
    executionIdempotencyKey: context.executionIdempotencyKey,
    providerIdempotencyKey: context.attemptIdentity.providerIdempotencyKey,
    providerRequestFingerprint: context.attemptIdentity.providerRequestFingerprint,
    paymentIntentId: context.intent.paymentIntentId,
    cycleId: context.cycleOrder.cycleId,
    subscriptionId: due.subscriptionId,
    orderUuid: context.cycleOrder.orderUuid,
    providerKind: due.providerKind,
    failureReason: policy.declineReason(context.decline),
    failureClassification: policy.classifyDecline(context.decline),
    occurredAt: (deps.now ?? policy.defaultNow)(),
    attemptAlreadyPrepared: true,
  }, policy.failure);
  return {
    subscriptionId: due.subscriptionId,
    outcome: "failed",
    cycleId: context.cycleOrder.cycleId,
    cycleNumber: context.snapshots.cycleNumber,
    orderId: context.cycleOrder.orderUuid,
    paymentIntentId: context.intent.paymentIntentId,
    attemptStatus: "failed",
    replayed: context.cycleOrder.replayed || context.intent.replayed,
    dunningCaseId: propagation.dunningCaseId,
    retryAttempt: propagation.retryAttempt,
    applyReplayed: propagation.applyReplayed,
    dunningPropagationFailed: propagation.dunningPropagationFailed,
  };
}
export async function requiresActionRenewalOutcome<D extends HostedRenewalDue>(
  deps: RenewalFailureDeps, due: D, context: RenewalOutcomeContext, policy: RenewalOutcomePolicy,
): Promise<SubscriptionRenewalChargeResult> {
  const propagation = await propagateRenewalFailure(deps.chargeFailurePropagation, {
    kind: "off_session_requires_action",
    executionIdempotencyKey: context.executionIdempotencyKey,
    providerIdempotencyKey: context.attemptIdentity.providerIdempotencyKey,
    providerRequestFingerprint: context.attemptIdentity.providerRequestFingerprint,
    paymentIntentId: context.intent.paymentIntentId,
    cycleId: context.cycleOrder.cycleId,
    subscriptionId: due.subscriptionId,
    orderUuid: context.cycleOrder.orderUuid,
    providerKind: due.providerKind,
    failureReason: policy.scaReason,
    occurredAt: (deps.now ?? policy.defaultNow)(),
    attemptAlreadyPrepared: true,
  }, policy.failure);
  return {
    subscriptionId: due.subscriptionId,
    outcome: "requires_action",
    cycleId: context.cycleOrder.cycleId,
    cycleNumber: context.snapshots.cycleNumber,
    orderId: context.cycleOrder.orderUuid,
    paymentIntentId: context.intent.paymentIntentId,
    attemptStatus: context.finalizedAttempt.status,
    replayed: context.cycleOrder.replayed || context.intent.replayed,
    dunningCaseId: propagation.dunningCaseId,
    retryAttempt: propagation.retryAttempt,
    applyReplayed: propagation.applyReplayed,
    dunningPropagationFailed: propagation.dunningPropagationFailed,
  };
}

export async function replayRenewalAttempt<D extends HostedRenewalDue>(
  deps: RenewalFailureDeps, due: D, ctx: RenewalReplayContext,
  status: PaymentAttemptStatus, policy: RenewalReplayPolicy,
): Promise<SubscriptionRenewalChargeResult> {
  if (status === "requires_action") {
    const propagation = await propagateRenewalFailure(deps.chargeFailurePropagation, {
      kind: "off_session_requires_action",
      executionIdempotencyKey: ctx.executionIdempotencyKey,
      providerIdempotencyKey: ctx.providerIdempotencyKey,
      providerRequestFingerprint: ctx.providerRequestFingerprint,
      paymentIntentId: ctx.paymentIntentId,
      cycleId: ctx.cycleId,
      subscriptionId: due.subscriptionId,
      orderUuid: ctx.orderId,
      providerKind: ctx.providerKind,
      failureReason: policy.scaReason,
      occurredAt: (deps.now ?? policy.defaultNow)(),
      attemptAlreadyPrepared: true,
    }, policy.failure);
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
    reason: policy.unacknowledgedReason(status),
  };
}
