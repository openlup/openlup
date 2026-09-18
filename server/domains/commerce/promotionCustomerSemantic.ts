import type { CommercePromotionCustomerSemantic } from "../../../src/domains/commerce/types.js";
import type { PromotionRow } from "../../../src/domains/promo/types.js";

type PromotionWithV2Benefit = PromotionRow & {
  promotion_engine_version?: unknown;
  benefit_lane?: unknown;
  benefit_kind?: unknown;
  benefit_value_bps?: unknown;
};

/**
 * Stable customer-facing identity for the canonical automatic offers. Display
 * names are intentionally ignored because operators may edit or translate them.
 * Unknown or partially matching policies stay unclassified and use the client's
 * backward-compatible fallback presentation.
 */
export function promotionCustomerSemantic(
  promotion: PromotionWithV2Benefit,
): CommercePromotionCustomerSemantic | undefined {
  if (promotion.trigger_type !== "automatic" || promotion.applies_to_kind !== "order_total") {
    return undefined;
  }

  const eligibility = promotion.eligibility ?? {};
  const payload = promotion.applies_to_payload ?? {};
  if (payload.cart_mode === "subscription" && isFirstSubscription50(promotion, eligibility)) {
    return "first_subscription_50";
  }
  if (
    payload.cart_mode === "one_time" &&
    promotion.discount_type === "percentage" &&
    promotion.discount_value === 10 &&
    promotion.stacking_rule === "exclusive" &&
    hasOnlyEligibility(eligibility, "first_onetime_purchase", true)
  ) {
    return "first_purchase_10";
  }
  if (
    payload.cart_mode === "one_time" &&
    promotion.discount_type === "percentage" &&
    promotion.discount_value === 5 &&
    promotion.stacking_rule === "stackable_with_any" &&
    hasOnlyEligibility(eligibility, "min_cart_minor", 12_000)
  ) {
    return "bundle_5";
  }
  return undefined;
}

function isFirstSubscription50(
  promotion: PromotionWithV2Benefit,
  eligibility: Record<string, unknown>,
): boolean {
  if (
    promotion.stacking_rule !== "exclusive" ||
    !hasOnlyEligibility(eligibility, "first_subscription_purchase", true)
  ) {
    return false;
  }
  if (promotion.promotion_engine_version === "promotion-engine.v2") {
    return promotion.benefit_lane === "product" &&
      promotion.benefit_kind === "target_percentage" &&
      promotion.benefit_value_bps === 5_000;
  }
  return promotion.discount_type === "percentage" &&
    Math.abs(promotion.discount_value - 44.404) < 0.000_001;
}

function hasOnlyEligibility(
  eligibility: Record<string, unknown>,
  key: string,
  value: unknown,
): boolean {
  const keys = Object.keys(eligibility);
  return keys.length === 1 && keys[0] === key && eligibility[key] === value;
}
