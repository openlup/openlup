import { describe, expect, it } from "vitest";

import type { PromotionRow } from "../../../src/domains/promo/types.js";
import { promotionCustomerSemantic } from "./promotionCustomerSemantic.js";

describe("promotionCustomerSemantic", () => {
  it("classifies canonical offers without depending on their display names", () => {
    expect(promotionCustomerSemantic(row({
      name: "Nazwa zmieniona przez operatora",
      discount_value: 10,
      applies_to_payload: { cart_mode: "one_time" },
      eligibility: { first_onetime_purchase: true },
    }))).toBe("first_purchase_10");
    expect(promotionCustomerSemantic(row({
      name: "Eksperyment A",
      discount_value: 44.404,
      applies_to_payload: { cart_mode: "subscription" },
      eligibility: { first_subscription_purchase: true },
    }))).toBe("first_subscription_50");
    expect(promotionCustomerSemantic(row({
      name: "Dowolna nazwa bundle",
      discount_value: 5,
      stacking_rule: "stackable_with_any",
      applies_to_payload: { cart_mode: "one_time" },
      eligibility: { min_cart_minor: 12_000 },
    }))).toBe("bundle_5");
  });

  it("recognizes the exact v2 target policy", () => {
    expect(promotionCustomerSemantic(row({
      name: "Internal acquisition target",
      discount_value: 50,
      applies_to_payload: { cart_mode: "subscription" },
      eligibility: { first_subscription_purchase: true },
      promotion_engine_version: "promotion-engine.v2",
      benefit_lane: "product",
      benefit_kind: "target_percentage",
      benefit_value_bps: 5_000,
    }))).toBe("first_subscription_50");
  });

  it("leaves similar custom or ambiguous promotions unclassified", () => {
    expect(promotionCustomerSemantic(row({
      discount_value: 15,
      applies_to_payload: { cart_mode: "one_time" },
      eligibility: { first_onetime_purchase: true },
    }))).toBeUndefined();
    expect(promotionCustomerSemantic(row({
      discount_value: 5,
      stacking_rule: "stackable_with_any",
      applies_to_payload: { cart_mode: "one_time" },
      eligibility: { min_cart_minor: 12_000, segment: "vip" },
    }))).toBeUndefined();
    expect(promotionCustomerSemantic(row({
      trigger_type: "coupon_code",
      code: "FIRST10",
      discount_value: 10,
      applies_to_payload: { cart_mode: "one_time" },
      eligibility: { first_onetime_purchase: true },
    }))).toBeUndefined();
  });
});

function row(overrides: Partial<PromotionRow> & Record<string, unknown>): PromotionRow {
  return {
    id: "promotion-id",
    code: null,
    name: "Promotion",
    trigger_type: "automatic",
    discount_type: "percentage",
    discount_value: 50,
    applies_to_kind: "order_total",
    applies_to_payload: {},
    stacking_rule: "exclusive",
    eligibility: {},
    valid_from: "2026-01-01T00:00:00.000Z",
    valid_to: null,
    status: "active",
    region_availability: ["PL"],
    ...overrides,
  } as PromotionRow;
}
