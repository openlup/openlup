import { describe, expect, it } from "vitest";
import {
  evaluatePromotionAdjustmentsV2,
  evaluatePromos,
  promoEligibilityFailure,
  PROMOTION_APPLIES_TO_KINDS,
  PROMOTION_DISCOUNT_TYPES,
  PROMOTION_STACKING_RULES,
  PROMOTION_TRIGGER_TYPES,
  type PromoEvaluationCart,
  type PromotionRow,
} from "@openlup/core/promo";

const NOW = "2026-06-03T14:00:00Z";

function makeCart(overrides: Partial<PromoEvaluationCart> = {}): PromoEvaluationCart {
  return {
    region_code: "GLOBAL",
    cart_mode: "one_time",
    cart_subtotal_minor: 20860,
    shipping_amount_minor: 990,
    client_orders_count: 0,
    applied_codes: [],
    ...overrides,
  };
}

function makePromo(overrides: Partial<PromotionRow> = {}): PromotionRow {
  return {
    id: "promo-base",
    code: null,
    name: "Base",
    trigger_type: "automatic",
    discount_type: "percentage",
    discount_value: 10,
    applies_to_kind: "order_total",
    applies_to_payload: {},
    stacking_rule: "exclusive",
    eligibility: {},
    valid_from: "2026-06-01T00:00:00Z",
    valid_to: null,
    status: "active",
    region_availability: ["GLOBAL"],
    ...overrides,
  };
}

describe("promo standalone smoke", () => {
  it("exposes neutral promo primitives", () => {
    expect(PROMOTION_TRIGGER_TYPES).toEqual(["coupon_code", "automatic", "referral"]);
    expect(PROMOTION_DISCOUNT_TYPES).toEqual(["percentage", "fixed_amount", "free_shipping"]);
    expect(PROMOTION_APPLIES_TO_KINDS).toEqual(["order_total", "line_with_variant", "line_with_category"]);
    expect(PROMOTION_STACKING_RULES).toEqual(["exclusive", "stackable_with_any", "stackable_with_loyalty"]);
  });

  it("evaluates order and shipping lanes deterministically", () => {
    const applied = evaluatePromos({
      cart: makeCart({ cart_mode: "subscription", client_subscription_orders_count: 0 }),
      candidates: [
        makePromo({
          id: "first-sub-50",
          name: "First Subscription 50%",
          discount_value: 50,
          applies_to_payload: { cart_mode: "subscription" },
          eligibility: { first_subscription_purchase: true },
        }),
        makePromo({
          id: "sub-free-ship",
          name: "Subscription Free Shipping",
          discount_type: "free_shipping",
          stacking_rule: "stackable_with_any",
          applies_to_payload: { cart_mode: "subscription" },
        }),
      ],
      now: NOW,
    });

    expect(applied.map((promo) => promo.promotion_id).sort()).toEqual(["first-sub-50", "sub-free-ship"]);
    expect(applied.find((promo) => promo.discount_type === "free_shipping")?.amount_off_minor).toBe(990);
  });

  it("keeps rejection classification separate from stacking wins", () => {
    expect(promoEligibilityFailure(makePromo({ eligibility: {} }), makeCart(), NOW)).toBeNull();
    expect(promoEligibilityFailure(
      makePromo({ region_availability: ["OTHER"] }),
      makeCart(),
      NOW,
    )).toBe("not_eligible");
    expect(promoEligibilityFailure(
      makePromo({ valid_to: "2026-06-02T00:00:00Z" }),
      makeCart(),
      NOW,
    )).toBe("expired");
  });

  it("exposes the target-effective v2 adjustment kernel without changing legacy evaluation", () => {
    const result = evaluatePromotionAdjustmentsV2({
      purchaseScope: "subscription_initial",
      referenceProductMinor: 10_000,
      currentProductMinor: 9_000,
      shippingMinor: 1_000,
      minimumProductPayableMinor: 1,
    }, [{
      promotionId: "target-80",
      codeId: "code-80",
      name: "Target 80%",
      source: "code",
      lane: "product",
      kind: "target_percentage",
      valueBps: 8_000,
      scopes: ["subscription_initial"],
    }]);

    expect(result.productPayableMinor).toBe(2_000);
    expect(result.effectiveProductDiscountBps).toBe(8_000);
  });
});
