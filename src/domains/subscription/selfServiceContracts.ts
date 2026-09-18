import { z } from "../../lib/validation/zod.js";
import {
  compositionConstraintSchema,
  compositionResizeLeverSchema,
  subscriptionAddonBundleLineSchema,
  subscriptionCoreBundleLineSchema,
} from "./bundleActionSchemas.js";
import { subscriptionCancelSurveySchema } from "./cancelSurveyContract.js";

export { createCancelSurveySchema, subscriptionCancelSurveySchema } from "./cancelSurveyContract.js";
export type { SubscriptionCancelSurvey } from "./cancelSurveyContract.js";

export const SUBSCRIPTION_SELF_SERVICE_CONTRACT_VERSION = "subscription.self_service.v2" as const;

export const SUBSCRIPTION_PRICE_AGREEMENT_POLICY = {
  kind: "lock_until_edit",
  proration: "none",
  cycleEffect: "future_unlocked_cycles_only",
} as const;

const uuidSchema = z.guid();
const datetimeSchema = z.string().datetime({ offset: true });
const idempotencyKeySchema = z.string().trim().min(8).max(180);
const nullableTextSchema = z.string().trim().min(1).max(500).nullable();
const variantQtySchema = z.object({ variantId: uuidSchema, qty: z.number().int().positive().max(99) }).strict();
const quoteHashSchema = z.string().trim().regex(/^[a-f0-9]{64}$/);

export const SUBSCRIPTION_SELF_SERVICE_ACTION_IMPACTS = [
  "schedule",
  "status",
  "price",
  "contents",
  "delivery",
  "charge_timing",
] as const;

export const SUBSCRIPTION_ACTIONS_REQUIRING_ACCEPTED_QUOTE = [
  "swap_recipe",
  "add_addon",
  "remove_addon",
  "update_addon_quantity",
  "update_plan_length",
  "update_recipe_mix",
  "set_portion_mode",
  "update_package_template",
  "update_bundle",
  "resize_bundle",
] as const;

export const SUBSCRIPTION_ACTIONS_REQUIRING_CHARGE_TIMING_CONFIRMATION = [
  "order_now",
  "reactivate",
] as const;

export const subscriptionPaymentMethodStatusSchema = z.enum([
  "usable",
  "expiring",
  "missing",
  "revoked",
  "requires_action",
  "invalid",
  "provider_disabled",
]);

export const subscriptionRenewalBlockStatusSchema = z.enum([
  "blocked_preflight",
  "payment_pending",
  "dunning",
  "paid_fulfillment_pending",
  "fulfillment_blocked",
  "catalog_blocked",
  "customer_action_required",
]);

export const subscriptionSelfServiceActionImpactSchema = z.enum(SUBSCRIPTION_SELF_SERVICE_ACTION_IMPACTS);

export const subscriptionPausePresetSchema = z.enum(["2_weeks", "1_month", "indefinite"]);

export const subscriptionSaveOfferSchema = z
  .object({
    offerId: z.string().trim().min(1).max(120),
    kind: z.enum(["pause", "skip", "reschedule", "plan_length", "recipe_mix", "support_callback"]),
    accepted: z.boolean(),
    externalOfferRef: z.string().trim().min(1).max(180).nullable().optional(),
  })
  .strict();

export const subscriptionSelfServiceActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("slide_next_cycle"),
    idempotencyKey: idempotencyKeySchema,
    subscriptionId: uuidSchema,
    newNextCycleAt: datetimeSchema,
    reason: nullableTextSchema.optional(),
  }),
  z.object({
    action: z.literal("skip_next_cycle"),
    idempotencyKey: idempotencyKeySchema,
    subscriptionId: uuidSchema,
    reason: nullableTextSchema.optional(),
  }),
  // "Order now / get it sooner": pull the next cycle forward to just after now so
  // the renewal cron charges it on its next pass. Soft-advance (no immediate charge
  // in the request path); bypasses the slide 2-day floor because accelerating should
  // always be allowed. Guards: active + no open dunning + no locked/in-flight cycle.
  z.object({
    action: z.literal("order_now"),
    idempotencyKey: idempotencyKeySchema,
    subscriptionId: uuidSchema,
    confirmedChargeTiming: z.literal(true),
    reason: nullableTextSchema.optional(),
  }),
  z.object({
    action: z.literal("pause"),
    idempotencyKey: idempotencyKeySchema,
    subscriptionId: uuidSchema,
    pausePreset: subscriptionPausePresetSchema,
    reason: nullableTextSchema.optional(),
    survey: subscriptionCancelSurveySchema.optional(),
    saveOffer: subscriptionSaveOfferSchema.optional(),
  }),
  z.object({
    action: z.literal("resume"),
    idempotencyKey: idempotencyKeySchema,
    subscriptionId: uuidSchema,
  }),
  // Customer-initiated reactivation of a cancelled subscription (the win-back "Wznów").
  // Flips cancelled -> active and sets a near-future next_cycle_at; requires a stored
  // payment method (server rejects with payment_blocked otherwise).
  z.object({
    action: z.literal("reactivate"),
    idempotencyKey: idempotencyKeySchema,
    subscriptionId: uuidSchema,
    confirmedChargeTiming: z.literal(true),
  }),
  z.object({
    action: z.literal("cancel"),
    idempotencyKey: idempotencyKeySchema,
    subscriptionId: uuidSchema,
    reason: nullableTextSchema.optional(),
    survey: subscriptionCancelSurveySchema.optional(),
    saveOffer: subscriptionSaveOfferSchema.optional(),
  }),
  z.object({
    action: z.literal("change_shipping_address"),
    idempotencyKey: idempotencyKeySchema,
    subscriptionId: uuidSchema,
    shippingAddressId: uuidSchema,
    reason: nullableTextSchema.optional(),
  }),
  z.object({
    action: z.literal("update_plan_length"),
    idempotencyKey: idempotencyKeySchema,
    subscriptionId: uuidSchema,
    planDays: z.number().int().positive().max(90),
    expectedTemplateVersion: z.number().int().positive().optional(),
    acceptedQuoteHash: quoteHashSchema.optional(),
  }),
  // Deprecated petfood-specific alias; use update_bundle for new clients.
  z.object({
    action: z.literal("update_recipe_mix"),
    idempotencyKey: idempotencyKeySchema,
    subscriptionId: uuidSchema,
    recipes: z.array(variantQtySchema).min(1).max(6),
    expectedTemplateVersion: z.number().int().positive().optional(),
    acceptedQuoteHash: quoteHashSchema.optional(),
  }),
  z.object({
    action: z.literal("update_bundle"),
    idempotencyKey: idempotencyKeySchema,
    subscriptionId: uuidSchema,
    coreLines: z.array(subscriptionCoreBundleLineSchema).min(1).max(6),
    addonLines: z.array(subscriptionAddonBundleLineSchema).max(12).optional(),
    compositionConstraint: compositionConstraintSchema,
    cadenceDays: z.number().int().positive().max(90).optional(),
    expectedTemplateVersion: z.number().int().positive().optional(),
    acceptedQuoteHash: quoteHashSchema.optional(),
  }),
  z.object({
    action: z.literal("update_package_template"),
    idempotencyKey: idempotencyKeySchema,
    subscriptionId: uuidSchema,
    planDays: z.number().int().positive().max(90),
    recipes: z.array(variantQtySchema).min(1).max(6),
    addons: z.array(variantQtySchema).max(12).default([]),
    expectedTemplateVersion: z.number().int().positive().optional(),
    acceptedQuoteHash: quoteHashSchema.optional(),
  }),
  // Topper / half-plan: keep the same delivery cadence but scale the daily
  // portion (full = 1.0, topper = 0.5). The server recomputes the recipe can
  // count at the scaled daily kcal and re-locks the (lower) prices, so future
  // cycles charge the reduced amount. Doubles as the `too_expensive` save-offer.
  z.object({
    action: z.literal("set_portion_mode"),
    idempotencyKey: idempotencyKeySchema,
    subscriptionId: uuidSchema,
    portionMode: z.enum(["full", "topper"]),
    expectedTemplateVersion: z.number().int().positive().optional(),
    acceptedQuoteHash: quoteHashSchema.optional(),
  }),
  z.object({
    action: z.literal("resize_bundle"),
    idempotencyKey: idempotencyKeySchema,
    subscriptionId: uuidSchema,
    resizeLever: compositionResizeLeverSchema,
    compositionConstraint: compositionConstraintSchema,
    cadenceDays: z.number().int().positive().max(90).optional(),
    expectedTemplateVersion: z.number().int().positive().optional(),
    acceptedQuoteHash: quoteHashSchema.optional(),
  }),
  z.object({
    action: z.literal("add_addon"),
    idempotencyKey: idempotencyKeySchema,
    subscriptionId: uuidSchema,
    variantId: uuidSchema,
    qty: z.number().int().positive().max(99),
    acceptedQuoteHash: quoteHashSchema.optional(),
  }),
  z.object({
    action: z.literal("remove_addon"),
    idempotencyKey: idempotencyKeySchema,
    subscriptionId: uuidSchema,
    variantId: uuidSchema,
    acceptedQuoteHash: quoteHashSchema.optional(),
  }),
  z.object({
    action: z.literal("update_addon_quantity"),
    idempotencyKey: idempotencyKeySchema,
    subscriptionId: uuidSchema,
    variantId: uuidSchema,
    qty: z.number().int().positive().max(99),
    acceptedQuoteHash: quoteHashSchema.optional(),
  }),
]);

export const subscriptionPriceAgreementPolicySchema = z
  .object({
    kind: z.literal(SUBSCRIPTION_PRICE_AGREEMENT_POLICY.kind),
    proration: z.literal(SUBSCRIPTION_PRICE_AGREEMENT_POLICY.proration),
    cycleEffect: z.literal(SUBSCRIPTION_PRICE_AGREEMENT_POLICY.cycleEffect),
  })
  .strict();

export type SubscriptionPausePreset = z.infer<typeof subscriptionPausePresetSchema>;
export type SubscriptionSaveOffer = z.infer<typeof subscriptionSaveOfferSchema>;
export type SubscriptionSelfServiceAction = z.infer<typeof subscriptionSelfServiceActionSchema>;
export type SubscriptionPriceAgreementPolicy = z.infer<typeof subscriptionPriceAgreementPolicySchema>;
export type SubscriptionSelfServiceActionImpact = z.infer<typeof subscriptionSelfServiceActionImpactSchema>;
export type SubscriptionPaymentMethodStatus = z.infer<typeof subscriptionPaymentMethodStatusSchema>;
export type SubscriptionRenewalBlockStatus = z.infer<typeof subscriptionRenewalBlockStatusSchema>;

export type SubscriptionSelfServiceActionName =
  | SubscriptionSelfServiceAction["action"]
  | "swap_recipe"
  | "update_cadence"
  | "update_package";

export function subscriptionActionRequiresAcceptedQuote(action: SubscriptionSelfServiceActionName): boolean {
  return (SUBSCRIPTION_ACTIONS_REQUIRING_ACCEPTED_QUOTE as readonly string[]).includes(action);
}

export function subscriptionActionRequiresChargeTimingConfirmation(action: SubscriptionSelfServiceActionName): boolean {
  return (SUBSCRIPTION_ACTIONS_REQUIRING_CHARGE_TIMING_CONFIRMATION as readonly string[]).includes(action);
}

export function subscriptionSelfServiceActionImpacts(action: SubscriptionSelfServiceActionName): SubscriptionSelfServiceActionImpact[] {
  switch (action) {
    case "slide_next_cycle":
    case "skip_next_cycle":
      return ["schedule"];
    case "order_now":
    case "reactivate":
      return ["status", "charge_timing"];
    case "pause":
    case "resume":
    case "cancel":
      return ["status"];
    case "change_shipping_address":
      return ["delivery"];
    case "swap_recipe":
    case "add_addon":
    case "remove_addon":
    case "update_addon_quantity":
    case "update_plan_length":
    case "update_recipe_mix":
    case "set_portion_mode":
    case "update_package_template":
    case "update_bundle":
    case "resize_bundle":
      return ["price", "contents"];
    default:
      return [];
  }
}
