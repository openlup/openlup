/** @beta */
export const PROMOTION_TRIGGER_TYPES = ["coupon_code", "automatic", "referral"] as const;
/** @beta */
export type PromotionTriggerType = (typeof PROMOTION_TRIGGER_TYPES)[number];

/** @beta */
export const PROMOTION_DISCOUNT_TYPES = ["percentage", "fixed_amount", "free_shipping"] as const;
/** @beta */
export type PromotionDiscountType = (typeof PROMOTION_DISCOUNT_TYPES)[number];

/** @beta */
export const PROMOTION_APPLIES_TO_KINDS = ["order_total", "line_with_variant", "line_with_category"] as const;
/** @beta */
export type PromotionAppliesToKind = (typeof PROMOTION_APPLIES_TO_KINDS)[number];

/** @beta */
export const PROMOTION_STACKING_RULES = [
  "exclusive",
  "stackable_with_any",
  "stackable_with_loyalty",
] as const;
/** @beta */
export type PromotionStackingRule = (typeof PROMOTION_STACKING_RULES)[number];

/** @beta */
export interface PromotionRow {
  id: string;
  code: string | null;
  name: string;
  trigger_type: PromotionTriggerType;
  discount_type: PromotionDiscountType;
  discount_value: number;
  applies_to_kind: PromotionAppliesToKind;
  applies_to_payload: Record<string, unknown>;
  stacking_rule: PromotionStackingRule;
  eligibility: Record<string, unknown>;
  valid_from: string;
  valid_to: string | null;
  status: string;
  region_availability: string[];
  /**
   * Redemption caps. Enforced at quote-evaluation time by the caller before the
   * candidate set reaches `evaluatePromos`, never by failing a paid order.
   * Null = uncapped. Optional so non-DB callers/fixtures need not set them.
   */
  redemption_limit_global?: number | null;
  redemption_limit_per_customer?: number | null;
}

/** @beta */
export interface PromoEvaluationCart {
  region_code: string;
  cart_mode: "one_time" | "subscription";
  cart_subtotal_minor: number;
  shipping_amount_minor: number;
  /** All paid orders in any mode. Kept for the legacy `first_purchase` eligibility key. */
  client_orders_count: number;
  /** Paid subscription orders. Drives `first_subscription_purchase`. Optional for fixtures. */
  client_subscription_orders_count?: number;
  /** Paid one-time orders. Drives `first_onetime_purchase`. Optional for fixtures. */
  client_onetime_orders_count?: number;
  /**
   * True when this device's first-party visitor id already has a paid first-order
   * redemption. Denies any first-order promo regardless of client/email.
   * Optional; absent means no device guard.
   *
   * Demoted to advisory when {@link email_eligibility_confirmed} is true: an
   * account-level email signal outranks the device cookie.
   */
  device_first_order_redeemed?: boolean;
  /**
   * True when eligibility was resolved from a customer-provided email. When true,
   * the email-derived order counts are authoritative and the device guard is
   * advisory only. Optional; absent means the device guard stays in force.
   */
  email_eligibility_confirmed?: boolean;
  applied_codes: string[];
}

/** @beta */
export interface AppliedPromotion {
  promotion_id: string;
  code: string | null;
  /** Human-facing promotion name, surfaced as the quote discount label. */
  name: string;
  amount_off_minor: number;
  applies_to: PromotionAppliesToKind;
  discount_type: PromotionDiscountType;
  reason_code: string;
}

/** @beta */
export interface EvaluateNowInput {
  cart: PromoEvaluationCart;
  candidates: ReadonlyArray<PromotionRow>;
  now: string;
}
