import type { SubscriptionCycleStatus } from "./types.js";
import type {
  CreateInitialSubscriptionCheckoutInput,
  CycleMutationResult,
  EngineSubscription,
  InitialSubscriptionCheckoutModel,
  PlanCycleInput,
  SubscriptionEngineResult,
} from "./subscriptionEngineTypes.js";
import { DEFAULT_EDIT_WINDOW_HOURS, DEFAULT_TIMEZONE } from "./subscriptionEngineTypes.js";
import {
  cloneRecord,
  cloneTemplate,
  failure,
  makeEvent,
  parseIso,
  success,
  validateTemplate,
} from "./subscriptionEngineUtils.js";

/** @beta */
export function createInitialSubscriptionCheckoutModel(
  input: CreateInitialSubscriptionCheckoutInput,
): SubscriptionEngineResult<InitialSubscriptionCheckoutModel> {
  const now = parseIso(input.now);
  const firstCycleAt = parseIso(input.firstCycleAt);
  if (!now || !firstCycleAt) {
    return failure("invalid_timestamp", "now and firstCycleAt must be valid ISO timestamps");
  }

  const template = cloneTemplate(input.template);
  const templateError = validateTemplate(template);
  if (templateError) return templateError;

  const subscription: EngineSubscription = {
    id: input.subscriptionId,
    clientRef: input.clientRef,
    status: "active",
    template,
    templateVersion: 1,
    nextCycleAt: firstCycleAt.toISOString(),
    paymentMethodRef: input.paymentMethodRef ?? null,
    paymentMethodKind: input.paymentMethodKind ?? null,
    timezone: input.timezone ?? DEFAULT_TIMEZONE,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };

  const planned = planSubscriptionCycle({
    subscription,
    cycleNumber: 1,
    now: now.toISOString(),
    pricingSnapshot: input.pricingSnapshot,
    idempotencyKey: input.idempotencyKey,
  });
  if (planned.ok === false) {
    return failure(planned.error.code, planned.error.message);
  }

  return success({
    subscription,
    cycle: planned.value.cycle,
    events: [
      makeEvent({
        eventType: "subscription.created",
        subscription,
        idempotencyKey: `${input.idempotencyKey}:subscription.created`,
        occurredAt: now.toISOString(),
        payload: { clientRef: input.clientRef, templateVersion: 1 },
      }),
      ...planned.value.events,
    ],
  });
}

/** @beta */
export function planSubscriptionCycle(
  input: PlanCycleInput,
): SubscriptionEngineResult<CycleMutationResult> {
  const now = parseIso(input.now);
  const scheduledAt = parseIso(input.subscription.nextCycleAt);
  if (!now || !scheduledAt) {
    return failure("invalid_timestamp", "now and subscription.nextCycleAt must be valid ISO timestamps");
  }

  if (input.subscription.status !== "active") {
    return failure("inactive_subscription", "only active subscriptions can generate cycles");
  }

  const templateSnapshot = cloneTemplate(input.subscription.template);
  const hasPaymentMethod = Boolean(input.subscription.paymentMethodRef);
  const status: SubscriptionCycleStatus = hasPaymentMethod ? "payment_pending" : "payment_failed";
  const failureReason = hasPaymentMethod ? null : "missing_payment_method";

  const cycle = {
    subscriptionId: input.subscription.id,
    cycleNumber: input.cycleNumber,
    status,
    scheduledAt: scheduledAt.toISOString(),
    paidAt: null,
    templateVersion: input.subscription.templateVersion,
    templateSnapshot,
    pricingSnapshot: cloneRecord(input.pricingSnapshot),
    paymentMethodRef: input.subscription.paymentMethodRef,
    retryAttempt: 0,
    nextRetryAt: null,
    failureReason,
    engineIdempotencyKey: input.idempotencyKey,
  };

  const events = [
    makeEvent({
      eventType: "subscription.cycle_planned",
      subscription: input.subscription,
      cycleNumber: input.cycleNumber,
      idempotencyKey: `${input.idempotencyKey}:cycle_planned`,
      occurredAt: now.toISOString(),
      payload: {
        scheduledAt: cycle.scheduledAt,
        templateVersion: cycle.templateVersion,
      },
    }),
  ];

  events.push(
    hasPaymentMethod
      ? makeEvent({
          eventType: "subscription.payment_requested",
          subscription: input.subscription,
          cycleNumber: input.cycleNumber,
          idempotencyKey: `${input.idempotencyKey}:payment_requested`,
          occurredAt: now.toISOString(),
          payload: { paymentMethodRef: input.subscription.paymentMethodRef },
        })
      : makeEvent({
          eventType: "subscription.payment_failed",
          subscription: input.subscription,
          cycleNumber: input.cycleNumber,
          idempotencyKey: `${input.idempotencyKey}:missing_payment_method`,
          occurredAt: now.toISOString(),
          payload: { reason: failureReason },
        }),
  );

  return success({ cycle, events });
}

/** @beta */
export function findDueSubscriptions(
  subscriptions: EngineSubscription[],
  nowIso: string,
): EngineSubscription[] {
  return subscriptions.filter((subscription) => isRenewalDue(subscription, nowIso));
}

/** @beta */
export function isRenewalDue(subscription: EngineSubscription, nowIso: string): boolean {
  if (subscription.status !== "active") return false;
  const now = parseIso(nowIso);
  const nextCycleAt = parseIso(subscription.nextCycleAt);
  if (!now || !nextCycleAt) return false;
  return nextCycleAt.getTime() <= now.getTime();
}

/** @beta */
export function editCutoffAt(subscription: EngineSubscription): string | null {
  const nextCycleAt = parseIso(subscription.nextCycleAt);
  if (!nextCycleAt) return null;
  const editWindowHours = subscription.template.edit_window_hours ?? DEFAULT_EDIT_WINDOW_HOURS;
  return new Date(nextCycleAt.getTime() - editWindowHours * 60 * 60 * 1000).toISOString();
}

/** @beta */
export function isEditWindowOpen(subscription: EngineSubscription, nowIso: string): boolean {
  if (subscription.status !== "active") return false;
  const now = parseIso(nowIso);
  const cutoff = editCutoffAt(subscription);
  const cutoffAt = cutoff ? parseIso(cutoff) : null;
  if (!now || !cutoffAt) return false;
  return now.getTime() < cutoffAt.getTime();
}
