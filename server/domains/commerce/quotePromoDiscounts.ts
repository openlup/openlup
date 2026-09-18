import type { CreateQuoteRequest } from "../../../src/domains/commerce/contracts.js";
import type { CommerceCodeRejection, CommerceQuoteDiscount } from "../../../src/domains/commerce/types.js";
import { evaluatePromos, promoEligibilityFailure } from "../../../src/domains/promo/ports.js";
import type { PromoEvaluationCart, PromotionRow } from "../../../src/domains/promo/types.js";
import type { CommercePromoDataPort, PromotionRedemptionCount } from "./promoDataPort.js";
import { promotionCustomerSemantic } from "./promotionCustomerSemantic.js";

export interface QuoteDiscountResult {
  /** Applied discounts: order_total (clamped to subtotal) + at most one shipping discount. */
  discounts: CommerceQuoteDiscount[];
  /** Submitted coupon codes that produced no discount, with the reason. */
  codeRejections: CommerceCodeRejection[];
}

/**
 * Evaluate active promotions for this cart and map them to quote discounts. Two lanes:
 * `order_total` promos are clamped to the subtotal (so `discountTotal <= subtotal`), and
 * a single `free_shipping` promo is emitted as an `appliesTo:"shipping"` discount clamped
 * to `shippingGrossMinor` — it is NOT suppressed by an exclusive order-total promo and is
 * NOT counted against the subtotal. Per-mode paid-order counts drive `first_subscription_purchase`
 * and `first_onetime_purchase` independently; all counts are server-authoritative (resolved
 * from the clientId, never client input), so eligibility cannot be forged.
 */
export async function evaluateOrderTotalDiscounts(input: {
  promoDataPort: CommercePromoDataPort;
  clientId: string | null;
  visitorId?: string | null;
  mode: CreateQuoteRequest["mode"];
  promoCodes: string[];
  regionCode: string;
  subtotalGrossMinor: number;
  shippingGrossMinor?: number;
  atTime: string;
  /**
   * True when a customer email drove eligibility resolution (the request carried
   * `customerEligibilityContext.email`). Demotes the device-redemption guard to
   * advisory so an email-eligible customer on a used device still gets the
   * first-order price. See {@link PromoEvaluationCart.email_eligibility_confirmed}.
   */
  emailEligibilityConfirmed?: boolean;
}): Promise<QuoteDiscountResult> {
  if (input.subtotalGrossMinor <= 0) return { discounts: [], codeRejections: [] };

  const byMode = input.clientId
    ? await input.promoDataPort.countPaidOrdersByMode(input.clientId)
    : { oneTime: 0, subscription: 0 };

  // Cap pre-filter: drop a promo that has reached its global or per-customer redemption
  // limit BEFORE evaluation, so caps are enforced at quote time and a paid order is never
  // failed on a cap. A per-customer cap can only be checked for an authenticated client.
  const [allCandidates, redemptionCounts, deviceFirstOrderRedeemed] = await Promise.all([
    input.promoDataPort.listActivePromotions(),
    input.promoDataPort.redemptionCounts(input.clientId),
    input.promoDataPort.deviceFirstOrderRedeemed(input.visitorId ?? null),
  ]);
  const candidates = allCandidates.filter(
    (promo) => !capReached(promo, redemptionCounts.get(promo.id), input.clientId),
  );

  const cart: PromoEvaluationCart = {
    region_code: input.regionCode,
    cart_mode: input.mode === "subscription" ? "subscription" : "one_time",
    cart_subtotal_minor: input.subtotalGrossMinor,
    shipping_amount_minor: input.shippingGrossMinor ?? 0,
    client_orders_count: byMode.oneTime + byMode.subscription,
    client_subscription_orders_count: byMode.subscription,
    client_onetime_orders_count: byMode.oneTime,
    device_first_order_redeemed: deviceFirstOrderRedeemed,
    email_eligibility_confirmed: input.emailEligibilityConfirmed === true,
    // The engine compares code literals. Preserve the customer's submitted spelling
    // for the public rejection, but feed known legacy codes in their canonical
    // spelling so eligibility and applied-discount matching are case-insensitive.
    applied_codes: canonicalSubmittedCodes(input.promoCodes, allCandidates),
  };

  const applied = evaluatePromos({ cart, candidates, now: input.atTime });

  const discounts: CommerceQuoteDiscount[] = [];
  let running = 0;
  for (const promo of applied) {
    const source = candidates.find((candidate) => candidate.id === promo.promotion_id);
    const customerSemantic = source ? promotionCustomerSemantic(source) : undefined;
    const isShipping = promo.discount_type === "free_shipping";
    const cap = isShipping ? cart.shipping_amount_minor : input.subtotalGrossMinor - running;
    if (cap <= 0) {
      if (isShipping) continue;
      break;
    }
    const amountOffMinor = Math.min(promo.amount_off_minor, cap);
    if (amountOffMinor <= 0) continue;
    if (!isShipping) running += amountOffMinor;
    discounts.push({
      promotionId: promo.promotion_id,
      ...(promo.code ? { code: promo.code } : {}),
      // Human-facing label so the FE shows the promo name (e.g. "First Purchase 10%")
      // instead of the internal reasonCode ("promo:first_purchase_10").
      ...(promo.name ? { label: promo.name } : {}),
      appliesTo: isShipping ? "shipping" : "order_total",
      amountOffMinor,
      reasonCode: promo.reason_code,
      ...(customerSemantic ? { customerSemantic } : {}),
    });
  }

  return {
    discounts,
    codeRejections: classifyRejections(input, cart, allCandidates, redemptionCounts, discounts),
  };
}

/**
 * For each submitted coupon code that produced no discount, classify why. Uses the
 * pre-cap candidate set so an exhausted per-customer cap reads as `already_used` rather
 * than `not_recognized`. An eligible code that was merely outranked by a larger promo
 * is a neutral `better_price_exists`: it was not applied because the customer already
 * has an equally good or better automatic price. Applied shipping-code discounts count
 * as applied too.
 */
function classifyRejections(
  input: { clientId: string | null; promoCodes: string[]; atTime: string },
  cart: PromoEvaluationCart,
  allCandidates: PromotionRow[],
  redemptionCounts: Map<string, PromotionRedemptionCount>,
  discounts: readonly CommerceQuoteDiscount[],
): CommerceCodeRejection[] {
  const rejections: CommerceCodeRejection[] = [];
  for (const code of input.promoCodes) {
    const promo = resolveSubmittedCoupon(code, allCandidates);
    if (!promo) {
      rejections.push({ code, reason: "not_recognized" });
      continue;
    }
    // A legacy literal may be bound to more than one promotion/lane. A shipping
    // benefit can legitimately apply even when the first matching product row
    // fails scope, so the visible applied discount always wins over rejection.
    if (discounts.some((discount) => sameCode(discount.code, code) || sameCode(discount.code, promo.code))) {
      continue;
    }
    if (capReached(promo, redemptionCounts.get(promo.id), input.clientId)) {
      rejections.push({ code, reason: "already_used" });
      continue;
    }
    const failure = promoEligibilityFailure(promo, cart, input.atTime);
    if (failure) rejections.push({ code, reason: failure });
    else if (!discounts.some((discount) => discount.code === promo.code)) {
      rejections.push({ code, reason: "better_price_exists" });
    }
  }
  return rejections;
}

function canonicalSubmittedCodes(codes: readonly string[], candidates: readonly PromotionRow[]): string[] {
  return codes.map((code) => resolveSubmittedCoupon(code, candidates)?.code ?? code);
}

/**
 * Legacy permits normalized-code collisions. Preserve its exact-literal
 * matching first; case-insensitive recovery is safe only for one identity.
 */
function resolveSubmittedCoupon(code: string, candidates: readonly PromotionRow[]): PromotionRow | undefined {
  const couponCandidates = candidates.filter((promo) => promo.trigger_type === "coupon_code" && promo.code !== null);
  const exact = couponCandidates.find((promo) => promo.code === code);
  if (exact) return exact;
  const normalized = couponCandidates.filter((promo) => sameCode(promo.code, code));
  return normalized.length === 1 ? normalized[0] : undefined;
}

function sameCode(left: string | null | undefined, right: string | null | undefined): boolean {
  return typeof left === "string" && typeof right === "string" &&
    left.trim().toUpperCase() === right.trim().toUpperCase();
}

function capReached(
  promo: PromotionRow,
  counts: PromotionRedemptionCount | undefined,
  clientId: string | null,
): boolean {
  const { global, perCustomer } = counts ?? { global: 0, perCustomer: 0 };
  if (promo.redemption_limit_global != null && global >= promo.redemption_limit_global) return true;
  if (clientId && promo.redemption_limit_per_customer != null && perCustomer >= promo.redemption_limit_per_customer) {
    return true;
  }
  return false;
}
