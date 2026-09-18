import type { PaymentExecutionProviderDecline } from "@openlup/core/payment";

import type { PaymentAttemptStatus } from "../../../src/domains/payment/types.js";
import { classifyDecline, declineFailureReason } from "../../shared/finalizeDeclinedAttempt.js";
import {
  propagateSubscriptionCycleChargeFailure,
  type CycleChargeFailurePropagationPort,
} from "./propagateSubscriptionCycleChargeFailure.js";
import type {
  DueSubscription,
  SubscriptionRenewalChargeResult,
} from "./chargeSubscriptionCycleOffSession.js";
import { defaultNow } from "./chargeSubscriptionCycleOffSessionHelpers.js";

/**
 * Terminal renewal outcomes that collected no money.
 *
 * Both close a cycle into dunning and differ only in whether the customer can
 * rescue it themselves; keeping them side by side makes it obvious when one gains
 * a behaviour the other should mirror.
 */

/**
 * Closes a renewal the provider refused inside `execute()`.
 *
 * Execution adapters keep `attemptStatus` non-terminal by contract, so without an
 * explicit branch a decline falls through to `outcome: "charged"` and a renewal
 * that collected nothing is reported — by the cron aggregation too — as money
 * taken. Routed through the same failure propagation as an SCA block so the cycle
 * lands in dunning with a retry ladder rather than silently stalling.
 */
export async function declinedRenewalResult(
  deps: { chargeFailurePropagation: CycleChargeFailurePropagationPort; now?: () => string },
  due: DueSubscription,
  context: {
    decline: PaymentExecutionProviderDecline;
    executionIdempotencyKey: string;
    attemptIdentity: { providerIdempotencyKey: string; providerRequestFingerprint: string };
    intent: { paymentIntentId: string; replayed: boolean };
    cycleOrder: { cycleId: string; orderUuid: string; replayed: boolean };
    snapshots: { cycleNumber: number };
    finalizedAttempt: { status: PaymentAttemptStatus };
  },
): Promise<SubscriptionRenewalChargeResult> {
  const propagation = await propagateSubscriptionCycleChargeFailure(deps.chargeFailurePropagation, {
    kind: "provider_declined",
    executionIdempotencyKey: context.executionIdempotencyKey,
    providerIdempotencyKey: context.attemptIdentity.providerIdempotencyKey,
    providerRequestFingerprint: context.attemptIdentity.providerRequestFingerprint,
    paymentIntentId: context.intent.paymentIntentId,
    cycleId: context.cycleOrder.cycleId,
    subscriptionId: due.subscriptionId,
    orderUuid: context.cycleOrder.orderUuid,
    providerKind: due.providerKind,
    failureReason: declineFailureReason(context.decline),
    failureClassification: classifyDecline(context.decline),
    occurredAt: (deps.now ?? defaultNow)(),
    attemptAlreadyPrepared: true,
  });
  return {
    subscriptionId: due.subscriptionId,
    outcome: "failed",
    cycleId: context.cycleOrder.cycleId,
    cycleNumber: context.snapshots.cycleNumber,
    orderId: context.cycleOrder.orderUuid,
    paymentIntentId: context.intent.paymentIntentId,
    // The propagation above applied a terminal `failed` result; reporting the
    // status captured before it would make the cron output and observability
    // disagree with what the database now holds.
    attemptStatus: "failed",
    replayed: context.cycleOrder.replayed || context.intent.replayed,
    dunningCaseId: propagation.dunningCaseId,
    retryAttempt: propagation.retryAttempt,
    applyReplayed: propagation.applyReplayed,
    dunningPropagationFailed: propagation.dunningPropagationFailed,
  };
}

/**
 * Moves a renewal into dunning when off-session authentication is required.
 *
 * Sibling of {@link declinedRenewalResult}: both close a renewal that collected
 * nothing, differing only in whether the customer can rescue it themselves.
 */
export async function requiresActionRenewalResult(
  deps: { chargeFailurePropagation: CycleChargeFailurePropagationPort; now?: () => string },
  due: DueSubscription,
  context: {
    executionIdempotencyKey: string;
    attemptIdentity: { providerIdempotencyKey: string; providerRequestFingerprint: string };
    intent: { paymentIntentId: string; replayed: boolean };
    cycleOrder: { cycleId: string; orderUuid: string; replayed: boolean };
    snapshots: { cycleNumber: number };
    finalizedAttempt: { status: PaymentAttemptStatus };
  },
): Promise<SubscriptionRenewalChargeResult> {
  const propagation = await propagateSubscriptionCycleChargeFailure(deps.chargeFailurePropagation, {
    kind: "off_session_requires_action",
    executionIdempotencyKey: context.executionIdempotencyKey,
    providerIdempotencyKey: context.attemptIdentity.providerIdempotencyKey,
    providerRequestFingerprint: context.attemptIdentity.providerRequestFingerprint,
    paymentIntentId: context.intent.paymentIntentId,
    cycleId: context.cycleOrder.cycleId,
    subscriptionId: due.subscriptionId,
    orderUuid: context.cycleOrder.orderUuid,
    providerKind: due.providerKind,
    failureReason: "off_session_sca_required",
    occurredAt: (deps.now ?? defaultNow)(),
    attemptAlreadyPrepared: true,
  });
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
