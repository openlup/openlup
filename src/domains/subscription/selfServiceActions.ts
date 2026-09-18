import type { SubscriptionSelfServiceAction } from "./selfServiceContracts.js";
import { SUBSCRIPTION_PRICE_AGREEMENT_POLICY } from "./selfServiceContracts.js";
import type { EngineSubscription } from "./subscriptionEngineTypes.js";
import type { SubscriptionStatus } from "./types.js";

export type SubscriptionSelfServiceIneligibility =
  | "invalid_timestamp"
  | "inactive_subscription"
  | "invalid_transition"
  | "edit_window_closed"
  | "locked_cycle"
  | "payment_blocked"
  | "invalid_slide_target"
  | "line_not_found"
  | "duplicate_line"
  | "stale_template";

export interface SubscriptionSelfServicePreviewContext {
  subscription: EngineSubscription;
  action: SubscriptionSelfServiceAction;
  now: string;
  hasLockedUpcomingCycle?: boolean;
  hasOpenDunningCase?: boolean;
}

export interface SubscriptionSelfServiceActionPreview {
  action: SubscriptionSelfServiceAction["action"];
  subscriptionId: string;
  resultingStatus: SubscriptionStatus;
  resultingNextCycleAt: string | null;
  resultingTemplateVersion: number;
  priceAgreementPolicy: typeof SUBSCRIPTION_PRICE_AGREEMENT_POLICY;
  effects: string[];
  pauseWindow?: { preset: "2_weeks" | "1_month" | "indefinite"; startsAt: string; endsAt: string | null };
  cancelSurvey?: { reasonCode?: string; acceptedSaveOfferId?: string | null };
}

export type SubscriptionSelfServicePreviewResult =
  | { ok: true; value: SubscriptionSelfServiceActionPreview }
  | { ok: false; error: { code: SubscriptionSelfServiceIneligibility; message: string } };

export function previewSubscriptionSelfServiceAction(
  input: SubscriptionSelfServicePreviewContext,
): SubscriptionSelfServicePreviewResult {
  const now = parseDate(input.now);
  if (!now) return fail("invalid_timestamp", "now must be a valid ISO timestamp");
  const { subscription, action } = input;
  if (input.hasOpenDunningCase && action.action !== "change_shipping_address") {
    return fail("payment_blocked", "payment recovery must be completed first");
  }
  if (action.subscriptionId !== subscription.id) {
    return fail("line_not_found", "action subscriptionId does not match the subscription");
  }

  if (action.action === "resume") {
    if (subscription.status !== "paused") return fail("invalid_transition", "only paused subscriptions can resume");
    return ok(input, "active", rollForward(subscription.nextCycleAt, subscription.template.cadence_days, now), [
      "status_resumes",
      "lapsed_cycle_rolls_forward",
    ]);
  }

  if (action.action === "cancel") {
    if (subscription.status !== "active" && subscription.status !== "paused") {
      return fail("invalid_transition", "only active or paused subscriptions can cancel");
    }
    return ok(input, "cancelled", subscription.nextCycleAt, ["status_cancels"], {
      cancelSurvey: {
        reasonCode: action.survey?.reasonCode,
        acceptedSaveOfferId: action.survey?.acceptedSaveOfferId ?? action.saveOffer?.offerId ?? null,
      },
    });
  }

  if (action.action === "change_shipping_address") {
    if (subscription.status !== "active" && subscription.status !== "paused") {
      return fail("invalid_transition", "only active or paused subscriptions can change shipping address");
    }
    if (input.hasLockedUpcomingCycle) return fail("locked_cycle", "the upcoming cycle is already locked");
    return ok(input, subscription.status, subscription.nextCycleAt, [
      "shipping_address_changes",
      "future_unlocked_cycles_only",
    ]);
  }

  if (subscription.status !== "active") return fail("inactive_subscription", "subscription must be active");

  if (action.action === "pause") {
    return ok(input, "paused", subscription.nextCycleAt, ["status_pauses"], {
      pauseWindow: {
        preset: action.pausePreset,
        startsAt: now.toISOString(),
        endsAt: pauseEndsAt(action.pausePreset, now),
      },
    });
  }

  if (action.action === "skip_next_cycle") {
    if (input.hasLockedUpcomingCycle) return fail("locked_cycle", "the upcoming cycle is already locked");
    const skippedNextCycleAt = addDays(subscription.nextCycleAt, subscription.template.cadence_days);
    if (!skippedNextCycleAt) return fail("invalid_timestamp", "nextCycleAt must be a valid ISO timestamp");
    return ok(input, "active", skippedNextCycleAt, [
      "next_cycle_skipped",
      "future_unlocked_cycles_only",
    ]);
  }

  if (action.action === "slide_next_cycle") {
    if (input.hasLockedUpcomingCycle) return fail("locked_cycle", "the upcoming cycle is already locked");
    const next = parseDate(action.newNextCycleAt);
    if (!next || next.getTime() < now.getTime() + 2 * dayMs || next.getTime() > now.getTime() + 60 * dayMs) {
      return fail("invalid_slide_target", "slide target must be 2 to 60 days in the future");
    }
    return ok(input, "active", next.toISOString(), ["next_cycle_slides", "future_unlocked_cycles_only"]);
  }

  const editCheck = canEditTemplate(input, now);
  if (editCheck) return editCheck;

  if ("expectedTemplateVersion" in action && action.expectedTemplateVersion !== undefined) {
    if (action.expectedTemplateVersion !== subscription.templateVersion) {
      return fail("stale_template", "template version changed since preview");
    }
  }

  if (action.action === "add_addon" && hasLine(subscription, action.variantId)) {
    return fail("duplicate_line", "add-on variant is already present");
  }
  if (action.action === "remove_addon" && !hasAddon(subscription, action.variantId)) {
    return fail("line_not_found", "add-on variant is not present");
  }
  if (action.action === "update_addon_quantity" && !hasAddon(subscription, action.variantId)) {
    return fail("line_not_found", "add-on variant is not present");
  }

  return ok(input, "active", subscription.nextCycleAt, ["template_updates", "price_locks_until_next_edit"], {
    templateVersionDelta: 1,
  });
}

function canEditTemplate(
  input: SubscriptionSelfServicePreviewContext,
  now: Date,
): SubscriptionSelfServicePreviewResult | null {
  if (input.hasLockedUpcomingCycle) return fail("locked_cycle", "the upcoming cycle is already locked");
  const next = parseDate(input.subscription.nextCycleAt);
  if (!next) return fail("invalid_timestamp", "nextCycleAt must be a valid ISO timestamp");
  const cutoff = next.getTime() - (input.subscription.template.edit_window_hours ?? 72) * 60 * 60 * 1000;
  return now.getTime() < cutoff ? null : fail("edit_window_closed", "template edits are locked");
}

function ok(
  input: SubscriptionSelfServicePreviewContext,
  resultingStatus: SubscriptionStatus,
  resultingNextCycleAt: string | null,
  effects: string[],
  extra: Partial<SubscriptionSelfServiceActionPreview> & { templateVersionDelta?: number } = {},
): SubscriptionSelfServicePreviewResult {
  return {
    ok: true,
    value: {
      action: input.action.action,
      subscriptionId: input.subscription.id,
      resultingStatus,
      resultingNextCycleAt,
      resultingTemplateVersion: input.subscription.templateVersion + (extra.templateVersionDelta ?? 0),
      priceAgreementPolicy: SUBSCRIPTION_PRICE_AGREEMENT_POLICY,
      effects,
      pauseWindow: extra.pauseWindow,
      cancelSurvey: extra.cancelSurvey,
    },
  };
}

function fail(code: SubscriptionSelfServiceIneligibility, message: string): SubscriptionSelfServicePreviewResult {
  return { ok: false, error: { code, message } };
}

const dayMs = 24 * 60 * 60 * 1000;

function parseDate(value: string): Date | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function addDays(value: string, days: number): string | null {
  const date = parseDate(value);
  return date ? new Date(date.getTime() + days * dayMs).toISOString() : null;
}

function rollForward(value: string, cadenceDays: number, now: Date): string | null {
  const date = parseDate(value);
  if (!date || date.getTime() > now.getTime()) return value;
  const cycles = Math.floor((now.getTime() - date.getTime()) / (cadenceDays * dayMs)) + 1;
  return new Date(date.getTime() + cycles * cadenceDays * dayMs).toISOString();
}

function pauseEndsAt(preset: "2_weeks" | "1_month" | "indefinite", now: Date): string | null {
  if (preset === "indefinite") return null;
  const days = preset === "2_weeks" ? 14 : 30;
  return new Date(now.getTime() + days * dayMs).toISOString();
}

function hasLine(subscription: EngineSubscription, variantId: string): boolean {
  return subscription.template.lines.some((line) => line.variant_id === variantId);
}

function hasAddon(subscription: EngineSubscription, variantId: string): boolean {
  return subscription.template.lines.some((line) => line.variant_id === variantId && line.is_addon);
}
