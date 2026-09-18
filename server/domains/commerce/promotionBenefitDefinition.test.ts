import { describe, expect, it } from "vitest";

import { resolvePromotionBenefitDefinition } from "./promotionBenefitDefinition.js";

describe("promotion benefit dual read", () => {
  it("reads legacy 44.404 only from discount_value even when v2-shaped backfill exists", () => {
    expect(resolvePromotionBenefitDefinition({
      promotion_engine_version: "promotion-engine.v1",
      discount_type: "percentage",
      discount_value: 44.404,
      benefit_kind: "target_percentage",
      benefit_value_bps: 4_440,
    })).toEqual({ kind: "legacy_percentage", percentage: 44.404 });
  });

  it("reads target 50% only from an explicitly v2 row", () => {
    expect(resolvePromotionBenefitDefinition({
      promotion_engine_version: "promotion-engine.v2",
      discount_type: "percentage",
      discount_value: 44.404,
      benefit_lane: "product",
      benefit_kind: "target_percentage",
      benefit_value_bps: 5_000,
    })).toEqual({ kind: "target_percentage", lane: "product", valueBps: 5_000 });
  });

  it("fails closed for a v2 row without explicit safe benefit data", () => {
    expect(() => resolvePromotionBenefitDefinition({
      promotion_engine_version: "promotion-engine.v2",
      discount_type: "percentage",
      discount_value: 50,
    })).toThrow("promotion_v2_benefit_invalid");
  });
});
