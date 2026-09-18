import type { AppliedPromotion, EvaluateNowInput, PromotionRow } from "./types.js";

/**
 * Deterministic promotion evaluator shared by preview and finalization callers.
 * The same `(cart, candidates, now)` triple always yields the same
 * `AppliedPromotion[]`, so downstream quote/order layers can compare the
 * previewed discount with the persisted one.
 *
 * Two independent lanes:
 *   - order_total lane (percentage / fixed_amount): exclusivity applies.
 *   - shipping lane (free_shipping): evaluated separately so an order-total
 *     promo never suppresses free shipping.
 *
 * Within each lane, candidates are filtered to active, in-window, in-region,
 * eligible-for-this-cart; coupon promotions additionally require the code in
 * `cart.applied_codes`.
 */
/** @beta */
export function evaluatePromos(input: EvaluateNowInput): AppliedPromotion[] {
  const { cart, candidates, now } = input;
  const eligible = candidates.filter((p) => promoEligibilityFailure(p, cart, now) === null && couponCodePresent(p, cart));

  const shippingLane = eligible.filter((p) => p.discount_type === "free_shipping");
  const orderLane = eligible.filter((p) => p.discount_type !== "free_shipping");

  const applied: AppliedPromotion[] = [];

  let exclusiveBlocked = false;
  for (const promo of sortByPriority(orderLane, cart)) {
    if (exclusiveBlocked) break;
    const amount = computeAmountOff(promo, cart);
    if (amount <= 0) continue;
    applied.push(toApplied(promo, amount));
    if (promo.stacking_rule === "exclusive") exclusiveBlocked = true;
  }

  const shippingPromo = sortByPriority(shippingLane, cart)[0];
  if (shippingPromo) {
    const amount = computeAmountOff(shippingPromo, cart);
    if (amount > 0) applied.push(toApplied(shippingPromo, amount));
  }

  return applied;
}

/**
 * Why a promo does not apply to this cart, or `null` if it would apply. Used by
 * quote/finalization layers to classify rejected coupon codes. A promo that is
 * eligible but merely loses to a larger exclusive promo returns `null` here.
 */
/** @beta */
export function promoEligibilityFailure(
  promo: PromotionRow,
  cart: EvaluateNowInput["cart"],
  now: string,
): "expired" | "not_eligible" | null {
  if (promo.status !== "active") return "not_eligible";
  if (!promo.region_availability.includes(cart.region_code)) return "not_eligible";
  if (!(promo.valid_from <= now && (promo.valid_to === null || promo.valid_to >= now))) return "expired";
  if (!isEligibleForCart(promo, cart)) return "not_eligible";
  return null;
}

function couponCodePresent(promo: PromotionRow, cart: EvaluateNowInput["cart"]): boolean {
  return promo.trigger_type !== "coupon_code" || (promo.code !== null && cart.applied_codes.includes(promo.code));
}

function isEligibleForCart(promo: PromotionRow, cart: EvaluateNowInput["cart"]): boolean {
  const elig = promo.eligibility;
  const isFirstOrderPromo =
    elig.first_purchase === true ||
    elig.first_subscription_purchase === true ||
    elig.first_onetime_purchase === true;
  if (
    isFirstOrderPromo &&
    cart.device_first_order_redeemed === true &&
    cart.email_eligibility_confirmed !== true
  ) {
    return false;
  }
  if (typeof elig.first_purchase === "boolean") {
    if (elig.first_purchase === true && cart.client_orders_count !== 0) return false;
    if (elig.first_purchase === false && cart.client_orders_count === 0) return false;
  }
  if (elig.first_subscription_purchase === true && (cart.client_subscription_orders_count ?? 0) !== 0) return false;
  if (elig.first_onetime_purchase === true && (cart.client_onetime_orders_count ?? 0) !== 0) return false;
  if (typeof elig.returning_customer === "boolean") {
    if (elig.returning_customer === true && cart.client_orders_count === 0) return false;
    if (elig.returning_customer === false && cart.client_orders_count !== 0) return false;
  }
  if (typeof elig.min_cart_minor === "number") {
    if (cart.cart_subtotal_minor < elig.min_cart_minor) return false;
  }
  const cartModeMatch = promo.applies_to_payload.cart_mode;
  if (typeof cartModeMatch === "string" && cartModeMatch !== cart.cart_mode) return false;
  return true;
}

function computeAmountOff(promo: PromotionRow, cart: EvaluateNowInput["cart"]): number {
  switch (promo.discount_type) {
    case "percentage":
      return Math.floor((cart.cart_subtotal_minor * promo.discount_value) / 100);
    case "fixed_amount":
      return Math.min(promo.discount_value, cart.cart_subtotal_minor);
    case "free_shipping":
      return cart.shipping_amount_minor;
    default:
      return 0;
  }
}

function toApplied(promo: PromotionRow, amount: number): AppliedPromotion {
  return {
    promotion_id: promo.id,
    code: promo.code,
    name: promo.name,
    amount_off_minor: amount,
    applies_to: promo.applies_to_kind,
    discount_type: promo.discount_type,
    reason_code: promo.code ? `promo:${promo.code}` : `promo:${normalizeReasonName(promo.name)}`,
  };
}

function sortByPriority(promos: PromotionRow[], cart: EvaluateNowInput["cart"]): PromotionRow[] {
  return [...promos].sort((a, b) => {
    if (a.stacking_rule === "exclusive" && b.stacking_rule !== "exclusive") return -1;
    if (a.stacking_rule !== "exclusive" && b.stacking_rule === "exclusive") return 1;
    const amountA = computeAmountOff(a, cart);
    const amountB = computeAmountOff(b, cart);
    if (amountA !== amountB) return amountB - amountA;
    return a.name.localeCompare(b.name);
  });
}

function normalizeReasonName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}
