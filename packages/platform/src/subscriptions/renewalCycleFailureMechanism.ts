import { nextRetryAttemptAt } from "@openlup/core/subscription";
import type {
  CycleChargeFailurePropagationPort, FailurePropagationContext, FailurePropagationResult,
  CycleRetryState,
} from "./contracts/renewal.js";

export interface RenewalFailurePolicy {
  resolveClassification(supplied: FailurePropagationContext["failureClassification"], reason: string): { failureClass: string; decidedBy: string };
  recordKey(key: string): string;
  applyKey(key: string): string;
  dunningKey(key: string, attempt: number): string;
  preparedSuffix: string;
  blockedSuffix: string;
  dunningFailureKey: string;
  logBelowRetry(fields: { cycleId: string; retryAttempt: number }): void;
  logRejected(fields: { cycleId: string; subscriptionId: string; retryAttempt: number; rowOutcomeKey: string; code?: string; reason: string }): void;
  logUnavailable(fields: { cycleId: string; subscriptionId: string; retryAttempt: number; rowOutcomeKey: string; reason: string }): void;
}

/** Complete durable refusal ladder; unexpected port throws remain raw. */
export async function propagateRenewalFailure(
  port: CycleChargeFailurePropagationPort,
  ctx: FailurePropagationContext,
  policy: RenewalFailurePolicy,
): Promise<FailurePropagationResult> {
  if (ctx.kind === "off_session_requires_action" && ctx.attemptAlreadyPrepared !== true) {
    return { dunningCaseId: null, retryAttempt: null, applyReplayed: false, dunningPropagationFailed: false };
  }
  if (ctx.kind === "preflight_block" && ctx.attemptAlreadyPrepared !== true) {
    await port.recordBlockedPreflightAttempt({
      idempotencyKey: policy.recordKey(ctx.executionIdempotencyKey),
      paymentIntentId: ctx.paymentIntentId,
      providerKind: ctx.providerKind,
      providerIdempotencyKey: ctx.providerIdempotencyKey,
      providerRequestFingerprint: ctx.providerRequestFingerprint,
      failureReason: ctx.failureReason,
    });
  }
  // A replay fingerprints the first durable instant, with caller time only as fallback.
  const occurredAt = await resolveDurableOccurredAt(port, ctx, policy);
  const applied = await port.applyFailedResult({
    idempotencyKey: policy.applyKey(ctx.executionIdempotencyKey),
    paymentIntentId: ctx.paymentIntentId,
    occurredAt,
    failureReason: ctx.failureReason,
    failureClassification: policy.resolveClassification(ctx.failureClassification, ctx.failureReason),
  });
  const cycleSnapshot = await port.readCycleRetryState(ctx.cycleId);
  return {
    ...await openDunningCase(port, ctx, cycleSnapshot, occurredAt, policy, applied.paymentAttemptId ?? null),
    applyReplayed: applied.replayed,
  };
}
async function resolveDurableOccurredAt(
  port: Pick<CycleChargeFailurePropagationPort, "readDurableAttemptInstant">,
  ctx: FailurePropagationContext,
  policy: RenewalFailurePolicy,
): Promise<string> {
  const suffix = ctx.attemptAlreadyPrepared === true ? policy.preparedSuffix : policy.blockedSuffix;
  const durable = await port.readDurableAttemptInstant({
    paymentIntentId: ctx.paymentIntentId,
    attemptIdempotencyKey: `${ctx.executionIdempotencyKey}${suffix}`,
  });
  return durable !== null && durable.length > 0 ? durable : ctx.occurredAt;
}
async function openDunningCase(
  port: Pick<CycleChargeFailurePropagationPort, "openDunningCase">,
  ctx: FailurePropagationContext,
  cycle: CycleRetryState,
  occurredAt: string,
  policy: RenewalFailurePolicy,
  failedPaymentAttemptId: string | null,
): Promise<Omit<FailurePropagationResult, "applyReplayed">> {
  const retryAttempt = cycle.retryAttempt ?? 1;
  // Resolve again after the retry read: original context evidence remains dynamic.
  const failureClass = policy.resolveClassification(
    ctx.failureClassification,
    ctx.failureReason,
  ).failureClass;
  const stranded = { cycleId: ctx.cycleId, subscriptionId: ctx.subscriptionId, retryAttempt,
    rowOutcomeKey: policy.dunningFailureKey };
  if (retryAttempt < 1) {
    policy.logBelowRetry({ cycleId: ctx.cycleId, retryAttempt });
    return { dunningCaseId: null, retryAttempt, dunningPropagationFailed: false };
  }
  // A stored null is a deliberate no-retry decision, not a missing row.
  const nextRetryAt = cycle.rowPresent
    ? cycle.nextRetryAt
    : nextRetryAttemptAt(
      occurredAt,
      retryAttempt,
      undefined,
      failureClass,
    );
  const outcome = await port.openDunningCase({
    failedPaymentAttemptId,
    idempotencyKey: policy.dunningKey(ctx.executionIdempotencyKey, retryAttempt),
    cycleId: ctx.cycleId,
    subscriptionId: ctx.subscriptionId,
    orderUuid: ctx.orderUuid,
    paymentIntentId: ctx.paymentIntentId,
    retryAttempt,
    nextRetryAt,
    failureReason: ctx.failureReason,
    occurredAt,
    failureClass,
  });
  if (outcome.status === "rejected") {
    policy.logRejected({
      ...stranded, code: outcome.code, reason: outcome.reason,
    });
    return { dunningCaseId: null, retryAttempt, dunningPropagationFailed: true };
  }
  if (outcome.status === "unavailable") {
    policy.logUnavailable({
      ...stranded, reason: outcome.reason,
    });
    return { dunningCaseId: null, retryAttempt, dunningPropagationFailed: true };
  }
  return { dunningCaseId: outcome.caseId, retryAttempt, dunningPropagationFailed: false };
}
