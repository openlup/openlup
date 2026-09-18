import type { SubscriptionEngineEventType, SubscriptionLineSnapshot, SubscriptionStatus } from "./types.js";
import { isEditWindowOpen } from "./subscriptionEngineCore.js";
import type {
  EngineSubscription,
  SubscriptionEngineResult,
  SubscriptionMutationResult,
} from "./subscriptionEngineTypes.js";
import {
  addCadenceDays,
  cloneTemplate,
  failure,
  makeEvent,
  parseIso,
  statusPatch,
  success,
  touchSubscription,
  validateTemplate,
} from "./subscriptionEngineUtils.js";

/** @beta */
export function swapTemplateLine(input: {
  subscription: EngineSubscription;
  fromVariantId: string;
  toVariantId: string;
  now: string;
}): SubscriptionEngineResult<SubscriptionMutationResult> {
  if (!isEditWindowOpen(input.subscription, input.now)) {
    return failure("edit_window_closed", "template swaps are locked after the edit cutoff");
  }

  if (input.subscription.template.lines.some((line) => line.variant_id === input.toVariantId)) {
    return failure("duplicate_line", "target variant is already present in the template");
  }

  let replaced = false;
  const lines = input.subscription.template.lines.map((line) => {
    if (line.variant_id !== input.fromVariantId) return { ...line };
    replaced = true;
    return { ...line, variant_id: input.toVariantId };
  });

  if (!replaced) {
    return failure("line_not_found", "source variant is not present in the template");
  }

  return updateTemplate({
    subscription: input.subscription,
    template: { ...cloneTemplate(input.subscription.template), lines },
    now: input.now,
    eventType: "subscription.template_updated",
    payload: { operation: "swap", fromVariantId: input.fromVariantId, toVariantId: input.toVariantId },
  });
}

/** @beta */
export function addPermanentAddon(input: {
  subscription: EngineSubscription;
  line: Omit<SubscriptionLineSnapshot, "is_addon" | "sort_order"> & { sort_order?: number };
  now: string;
}): SubscriptionEngineResult<SubscriptionMutationResult> {
  if (!isEditWindowOpen(input.subscription, input.now)) {
    return failure("edit_window_closed", "template add-ons are locked after the edit cutoff");
  }

  if (input.subscription.template.lines.some((line) => line.variant_id === input.line.variant_id)) {
    return failure("duplicate_line", "add-on variant is already present in the template");
  }

  const nextSortOrder =
    input.line.sort_order ??
    Math.max(0, ...input.subscription.template.lines.map((line) => line.sort_order)) + 1;
  const template = cloneTemplate(input.subscription.template);
  template.lines = [
    ...template.lines,
    {
      variant_id: input.line.variant_id,
      qty: input.line.qty,
      sort_order: nextSortOrder,
      is_addon: true,
    },
  ];

  return updateTemplate({
    subscription: input.subscription,
    template,
    now: input.now,
    eventType: "subscription.template_updated",
    payload: { operation: "add_permanent_addon", variantId: input.line.variant_id },
  });
}

/** @beta */
export function skipNextCycle(input: {
  subscription: EngineSubscription;
  now: string;
  reason?: string;
}): SubscriptionEngineResult<SubscriptionMutationResult> {
  const now = parseIso(input.now);
  if (!now) return failure("invalid_timestamp", "now must be a valid ISO timestamp");
  if (input.subscription.status !== "active") {
    return failure("inactive_subscription", "only active subscriptions can skip cycles");
  }

  const nextCycleAt = addCadenceDays(input.subscription.nextCycleAt, input.subscription.template.cadence_days);
  if (!nextCycleAt) return failure("invalid_timestamp", "subscription.nextCycleAt must be a valid ISO timestamp");

  const subscription = touchSubscription(input.subscription, input.now, { nextCycleAt });

  return success({
    subscription,
    events: [
      makeEvent({
        eventType: "subscription.cycle_skipped",
        subscription: input.subscription,
        idempotencyKey: `${input.subscription.id}:${input.subscription.nextCycleAt}:cycle_skipped`,
        occurredAt: now.toISOString(),
        payload: { skippedScheduledAt: input.subscription.nextCycleAt, reason: input.reason ?? null },
      }),
      makeEvent({
        eventType: "subscription.next_cycle_at_updated",
        subscription,
        idempotencyKey: `${subscription.id}:${subscription.nextCycleAt}:next_cycle_at_updated`,
        occurredAt: now.toISOString(),
        payload: { nextCycleAt },
      }),
    ],
  });
}

/** @beta */
export function slideNextCycle(input: {
  subscription: EngineSubscription;
  newNextCycleAt: string;
  now: string;
  reason?: string;
}): SubscriptionEngineResult<SubscriptionMutationResult> {
  const now = parseIso(input.now);
  const newNextCycleAt = parseIso(input.newNextCycleAt);
  if (!now || !newNextCycleAt) {
    return failure("invalid_timestamp", "now and newNextCycleAt must be valid ISO timestamps");
  }
  if (input.subscription.status !== "active") {
    return failure("inactive_subscription", "only active subscriptions can slide cycles");
  }
  if (newNextCycleAt.getTime() <= now.getTime()) {
    return failure("invalid_slide_target", "newNextCycleAt must be in the future");
  }

  const subscription = touchSubscription(input.subscription, now.toISOString(), {
    nextCycleAt: newNextCycleAt.toISOString(),
  });

  return success({
    subscription,
    events: [
      makeEvent({
        eventType: "subscription.next_cycle_at_updated",
        subscription,
        idempotencyKey: `${subscription.id}:${subscription.nextCycleAt}:slide`,
        occurredAt: now.toISOString(),
        payload: {
          previousNextCycleAt: input.subscription.nextCycleAt,
          nextCycleAt: subscription.nextCycleAt,
          reason: input.reason ?? null,
        },
      }),
    ],
  });
}

/** @beta */
export function pauseSubscription(input: {
  subscription: EngineSubscription;
  now: string;
  reason?: string;
}): SubscriptionEngineResult<SubscriptionMutationResult> {
  return changeSubscriptionStatus(input.subscription, "paused", input.now, "subscription.paused", {
    reason: input.reason ?? null,
  });
}

/** @beta */
export function resumeSubscription(input: {
  subscription: EngineSubscription;
  now: string;
}): SubscriptionEngineResult<SubscriptionMutationResult> {
  return changeSubscriptionStatus(input.subscription, "active", input.now, "subscription.resumed", {});
}

/** @beta */
export function cancelSubscription(input: {
  subscription: EngineSubscription;
  now: string;
  reason?: string;
}): SubscriptionEngineResult<SubscriptionMutationResult> {
  return changeSubscriptionStatus(input.subscription, "cancelled", input.now, "subscription.cancelled", {
    reason: input.reason ?? null,
  });
}

/** @beta */
export function completeSubscription(input: {
  subscription: EngineSubscription;
  now: string;
}): SubscriptionEngineResult<SubscriptionMutationResult> {
  return changeSubscriptionStatus(input.subscription, "completed", input.now, "subscription.completed", {});
}

function updateTemplate(input: {
  subscription: EngineSubscription;
  template: EngineSubscription["template"];
  now: string;
  eventType: SubscriptionEngineEventType;
  payload: Record<string, unknown>;
}): SubscriptionEngineResult<SubscriptionMutationResult> {
  const now = parseIso(input.now);
  if (!now) return failure("invalid_timestamp", "now must be a valid ISO timestamp");

  const template = cloneTemplate(input.template);
  const templateError = validateTemplate(template);
  if (templateError) return templateError;

  const subscription = touchSubscription(input.subscription, now.toISOString(), {
    template,
    templateVersion: input.subscription.templateVersion + 1,
  });

  return success({
    subscription,
    events: [
      makeEvent({
        eventType: input.eventType,
        subscription,
        idempotencyKey: `${subscription.id}:template:${subscription.templateVersion}`,
        occurredAt: now.toISOString(),
        payload: { ...input.payload, templateVersion: subscription.templateVersion },
      }),
    ],
  });
}

function changeSubscriptionStatus(
  subscription: EngineSubscription,
  status: SubscriptionStatus,
  nowIso: string,
  eventType: SubscriptionEngineEventType,
  payload: Record<string, unknown>,
): SubscriptionEngineResult<SubscriptionMutationResult> {
  const now = parseIso(nowIso);
  if (!now) return failure("invalid_timestamp", "now must be a valid ISO timestamp");
  if (!canTransitionSubscriptionStatus(subscription.status, status)) {
    return failure(
      "invalid_transition",
      `Cannot move subscription from ${subscription.status} to ${status}`,
    );
  }

  const next = touchSubscription(subscription, now.toISOString(), statusPatch(status));
  return success({
    subscription: next,
    events: [
      makeEvent({
        eventType,
        subscription: next,
        idempotencyKey: `${next.id}:${eventType}:${now.toISOString()}`,
        occurredAt: now.toISOString(),
        payload,
      }),
    ],
  });
}

function canTransitionSubscriptionStatus(from: SubscriptionStatus, to: SubscriptionStatus): boolean {
  const transitions: Record<SubscriptionStatus, readonly SubscriptionStatus[]> = {
    active: ["paused", "cancelled", "completed"],
    paused: ["active", "cancelled"],
    cancelled: [],
    completed: [],
  };

  return transitions[from].includes(to);
}
