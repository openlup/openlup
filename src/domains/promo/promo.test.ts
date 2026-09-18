import { describe, expect, it } from "vitest";
import {
  PROMOTION_APPLIES_TO_KINDS,
  PROMOTION_DISCOUNT_TYPES,
  PROMOTION_STACKING_RULES,
  PROMOTION_TRIGGER_TYPES,
} from "./types.js";

describe("promo domain primitives", () => {
  it("exposes the canonical trigger types", () => {
    expect(PROMOTION_TRIGGER_TYPES).toEqual(["coupon_code", "automatic", "referral"]);
  });

  it("exposes the canonical discount types (incl. free_shipping)", () => {
    expect(PROMOTION_DISCOUNT_TYPES).toEqual(["percentage", "fixed_amount", "free_shipping"]);
  });

  it("exposes the canonical applies_to_kinds", () => {
    expect(PROMOTION_APPLIES_TO_KINDS).toEqual([
      "order_total",
      "line_with_variant",
      "line_with_category",
    ]);
  });

  it("exposes the canonical stacking rules", () => {
    expect(PROMOTION_STACKING_RULES).toEqual([
      "exclusive",
      "stackable_with_any",
      "stackable_with_loyalty",
    ]);
  });
});
