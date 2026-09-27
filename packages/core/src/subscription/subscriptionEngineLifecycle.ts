import type { SubscriptionEngineEventType, SubscriptionLineSnapshot, SubscriptionStatus } from "./types.js";
import { isEditWindowOpen } from "./subscriptionEngineCore.js";
import {
  DEFAULT_CYCLE_RETRY_CADENCE,
  isDunningLadderExhausted,
  type CycleRetryCadence,
} from "./cycleHardening.js";
import type {
  EngineCycle,
  EngineEvent,
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
  // Resume leaves `paused` only. Leaving `cancelled` is a win-back and goes
  // through reactivateSubscription, which re-arms the schedule. A subscription
  // the exhausted ladder paused must resume through
  // resumeSubscriptionFromExpiredDunning, which skips the uncollected cycle.
  return changeSubscriptionStatus(input.subscription, "active", input.now, "subscription.resumed", {}, ["paused"]);
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

/**
 * Win-back: the owner reactivates their own cancelled subscription.
 *
 * Mirrors the `cancelled -> active` edge of the managed SQL guard
 * `public.subscription_guard_status_transition` and the customer `reactivate`
 * action behind it. A reactivation charges again, so it needs a stored payment
 * method, and it re-arms the next cycle {@link RESTART_LEAD_DAYS} out rather
 * than leaving a stale instant that would make the renewal due immediately.
 * The SQL action also clears the end instant and cancellation reason, requires
 * the customer's confirmation of the charge timing, refuses while a cycle is
 * locked and bumps the template version; those durable duties stay with the
 * host.
 *
 * @beta
 */
export function reactivateSubscription(input: {
  subscription: EngineSubscription;
  now: string;
  reason?: string;
}): SubscriptionEngineResult<SubscriptionMutationResult> {
  const now = parseIso(input.now);
  if (!now) return failure("invalid_timestamp", "now must be a valid ISO timestamp");
  if (input.subscription.status !== "cancelled") {
    return failure(
      "invalid_transition",
      `Cannot reactivate a subscription that is ${input.subscription.status}; only cancelled subscriptions can be won back`,
    );
  }
  if (!input.subscription.paymentMethodRef) {
    return failure("missing_payment_method", "reactivation requires a stored payment method");
  }

  const nextCycleAt = restartNextCycleAt(input.subscription, now);
  if (!nextCycleAt) return failure("invalid_timestamp", "restart exceeds the supported timestamp range");

  return restart({
    subscription: input.subscription,
    now,
    nextCycleAt,
    idempotencyPrefix: `${input.subscription.id}:reactivated:${now.toISOString()}`,
    payload: { reactivatedFrom: "cancelled", reason: input.reason ?? null },
    leadingEvents: [],
  });
}

/**
 * The sanctioned non-payment rule: a cycle that exhausted the retry ladder
 * pauses an ACTIVE subscription.
 *
 * This is the only path in the engine that suspends a live subscription for a
 * reason the owner did not choose, and it fires only when
 * {@link isDunningLadderExhausted} holds for the refused cycle. A ladder cut
 * short by a terminating refusal class, or a failure on any rung that still has
 * a retry after it, is refused as `dunning_not_exhausted` and leaves the
 * subscription untouched. A subscription that is not active (already paused,
 * cancelled or completed) is returned unchanged with no event, which is what
 * the managed SQL dunning boundary does and what makes a replay harmless.
 *
 * The schedule is not touched: pausing never moves `nextCycleAt`.
 *
 * @beta
 */
export function pauseSubscriptionForExpiredDunning(input: {
  subscription: EngineSubscription;
  cycle: EngineCycle;
  now: string;
  cadence?: CycleRetryCadence;
}): SubscriptionEngineResult<SubscriptionMutationResult> {
  const now = parseIso(input.now);
  if (!now) return failure("invalid_timestamp", "now must be a valid ISO timestamp");
  const mismatch = cycleOwnershipError(input.subscription, input.cycle);
  if (mismatch) return mismatch;
  if (!isDunningLadderExhausted(input.cycle, input.cadence ?? DEFAULT_CYCLE_RETRY_CADENCE)) {
    return failure(
      "dunning_not_exhausted",
      "only a cycle that exhausted the retry ladder may pause a subscription for non-payment",
    );
  }
  if (input.subscription.status !== "active") {
    return success({ subscription: touchSubscription(input.subscription, input.subscription.updatedAt, {}), events: [] });
  }

  const subscription = touchSubscription(input.subscription, now.toISOString(), statusPatch("paused"));
  return success({
    subscription,
    events: [
      makeEvent({
        eventType: "subscription.paused",
        subscription,
        cycleNumber: input.cycle.cycleNumber,
        idempotencyKey: `${input.cycle.engineIdempotencyKey}:subscription_paused`,
        occurredAt: now.toISOString(),
        payload: {
          reason: "payment_failed_expired",
          retryAttempt: input.cycle.retryAttempt,
          failureReason: input.cycle.failureReason,
        },
      }),
    ],
  });
}

/**
 * Customer-initiated recovery out of the non-payment pause.
 *
 * Mirrors the managed SQL `subscription_resume_after_expired_dunning`: the
 * subscription must be paused and the cycle it passes must be the refused cycle
 * that exhausted the ladder (the caller passes the LATEST such cycle, as the SQL
 * boundary reads the latest dunning case). A new payment method, when given,
 * replaces the stored one; without any method the resume is refused. Whether
 * the method is chargeable unattended is the host's check, as it is in SQL.
 * The given cycle becomes `skipped` rather than being charged late; the SQL
 * boundary skips every uncollected cycle, so a host that holds more than one
 * must skip the rest itself. The next cycle is re-armed
 * {@link RESTART_LEAD_DAYS} out.
 *
 * @beta
 */
export function resumeSubscriptionFromExpiredDunning(input: {
  subscription: EngineSubscription;
  cycle: EngineCycle;
  now: string;
  paymentMethodRef?: string | null;
  paymentMethodKind?: string | null;
  cadence?: CycleRetryCadence;
}): SubscriptionEngineResult<SubscriptionMutationResult & { cycle: EngineCycle }> {
  const now = parseIso(input.now);
  if (!now) return failure("invalid_timestamp", "now must be a valid ISO timestamp");
  if (input.subscription.status !== "paused") {
    return failure(
      "invalid_transition",
      `Cannot resume a ${input.subscription.status} subscription from expired dunning; it must be paused`,
    );
  }
  const mismatch = cycleOwnershipError(input.subscription, input.cycle);
  if (mismatch) return mismatch;
  if (!isDunningLadderExhausted(input.cycle, input.cadence ?? DEFAULT_CYCLE_RETRY_CADENCE)) {
    return failure("dunning_not_exhausted", "the cycle did not exhaust the retry ladder");
  }

  const replacementRef = input.paymentMethodRef?.trim() ? input.paymentMethodRef : null;
  const method: Partial<EngineSubscription> = replacementRef
    ? {
        paymentMethodRef: replacementRef,
        paymentMethodKind: input.paymentMethodKind?.trim() || input.subscription.paymentMethodKind,
      }
    : {};
  const withMethod = { ...input.subscription, ...method };
  if (!withMethod.paymentMethodRef) {
    return failure("missing_payment_method", "resuming requires a chargeable payment method");
  }

  const nextCycleAt = restartNextCycleAt(withMethod, now);
  if (!nextCycleAt) return failure("invalid_timestamp", "restart exceeds the supported timestamp range");

  const cycle: EngineCycle = { ...input.cycle, status: "skipped", nextRetryAt: null };
  const restarted = restart({
    subscription: withMethod,
    now,
    nextCycleAt,
    idempotencyPrefix: `${input.cycle.engineIdempotencyKey}:resumed_after_expired_dunning`,
    payload: {
      resumedAfterExpiredDunning: true,
      skippedCycleNumber: cycle.cycleNumber,
    },
    leadingEvents: [
      makeEvent({
        eventType: "subscription.cycle_skipped",
        subscription: withMethod,
        cycleNumber: cycle.cycleNumber,
        idempotencyKey: `${input.cycle.engineIdempotencyKey}:cycle_skipped`,
        occurredAt: now.toISOString(),
        payload: {
          skippedScheduledAt: cycle.scheduledAt,
          reason: "subscription_resumed_after_expired_dunning",
        },
      }),
    ],
  });
  if (restarted.ok === false) return restarted;
  return success({ ...restarted.value, cycle });
}

/**
 * How far out a restarted subscription's next cycle is re-armed, in days. Both
 * managed SQL restart paths (the customer `reactivate` action and
 * `subscription_resume_after_expired_dunning`) spell it `interval '2 days'`.
 *
 * @beta
 */
export const RESTART_LEAD_DAYS = 2;

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
  allowedFrom?: readonly SubscriptionStatus[],
): SubscriptionEngineResult<SubscriptionMutationResult> {
  const now = parseIso(nowIso);
  if (!now) return failure("invalid_timestamp", "now must be a valid ISO timestamp");
  if (
    (allowedFrom !== undefined && !allowedFrom.includes(subscription.status)) ||
    !canTransitionSubscriptionStatus(subscription.status, status)
  ) {
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

function restart(input: {
  subscription: EngineSubscription;
  now: Date;
  nextCycleAt: string;
  idempotencyPrefix: string;
  payload: Record<string, unknown>;
  leadingEvents: EngineEvent[];
}): SubscriptionEngineResult<SubscriptionMutationResult> {
  if (!canTransitionSubscriptionStatus(input.subscription.status, "active")) {
    return failure("invalid_transition", `Cannot move subscription from ${input.subscription.status} to active`);
  }
  const occurredAt = input.now.toISOString();
  const subscription = touchSubscription(input.subscription, occurredAt, {
    ...statusPatch("active"),
    nextCycleAt: input.nextCycleAt,
  });
  const events = [
    ...input.leadingEvents,
    makeEvent({
      eventType: "subscription.resumed",
      subscription,
      idempotencyKey: `${input.idempotencyPrefix}:resumed`,
      occurredAt,
      payload: { ...input.payload, nextCycleAt: input.nextCycleAt },
    }),
  ];
  if (input.nextCycleAt !== input.subscription.nextCycleAt) {
    events.push(
      makeEvent({
        eventType: "subscription.next_cycle_at_updated",
        subscription,
        idempotencyKey: `${input.idempotencyPrefix}:next_cycle_at_updated`,
        occurredAt,
        payload: { previousNextCycleAt: input.subscription.nextCycleAt, nextCycleAt: input.nextCycleAt },
      }),
    );
  }
  return success({ subscription, events });
}

// A restart re-arms the schedule RESTART_LEAD_DAYS out, but never earlier than
// the instant already stored: the same monotonic clamp recordPaymentSuccess
// applies, so a restart cannot pull a charge into a window already paid for.
// The managed SQL restart paths assign `now + 2 days` without the clamp, so
// the two differ exactly when the stored instant is later than that: a win-back
// of a subscription paid through a later date, or a schedule skipped or slid
// while the ladder was still running. There SQL charges earlier; this does not.
function restartNextCycleAt(subscription: EngineSubscription, now: Date): string | null {
  return new Date(Math.max(
    Date.parse(subscription.nextCycleAt) || 0,
    now.getTime() + RESTART_LEAD_DAYS * 24 * 60 * 60 * 1000,
  )).toJSON();
}

function cycleOwnershipError(
  subscription: EngineSubscription,
  cycle: EngineCycle,
): SubscriptionEngineResult<never> | null {
  if (cycle.subscriptionId === subscription.id) return null;
  return failure("invalid_transition", "the cycle belongs to a different subscription");
}

/**
 * The engine's subscription status matrix: every edge a status may take, and
 * nothing else.
 *
 * It mirrors the managed SQL guard `public.subscription_guard_status_transition`
 * over the four statuses the engine manages. The guard's remaining edges belong
 * to the activation flow the engine never drives (`pending_activation` ->
 * `active` / `activation_failed` / `cancelled`, and the audited expired-checkout
 * reopen `cancelled` -> `pending_activation`). `completed` is terminal on both
 * sides. `cancelled` -> `active` is the owner's win-back.
 *
 * Which OPERATION may take an edge is narrower than the matrix: `active` ->
 * `paused` is the owner's pause or {@link pauseSubscriptionForExpiredDunning},
 * and `cancelled` -> `active` is only {@link reactivateSubscription}.
 *
 * @beta
 */
export const SUBSCRIPTION_STATUS_TRANSITIONS: Readonly<
  Record<SubscriptionStatus, readonly SubscriptionStatus[]>
> = Object.freeze({
  active: Object.freeze(["paused", "cancelled", "completed"] as const),
  paused: Object.freeze(["active", "cancelled"] as const),
  cancelled: Object.freeze(["active"] as const),
  completed: Object.freeze([] as const),
});

/** @beta */
export function canTransitionSubscriptionStatus(from: SubscriptionStatus, to: SubscriptionStatus): boolean {
  // Own keys only: a status read from storage is an untyped string, and
  // "constructor" or "__proto__" must answer false rather than throw.
  return Object.prototype.hasOwnProperty.call(SUBSCRIPTION_STATUS_TRANSITIONS, from) &&
    SUBSCRIPTION_STATUS_TRANSITIONS[from].includes(to);
}
