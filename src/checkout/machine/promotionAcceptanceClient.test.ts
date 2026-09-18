import { describe, expect, it } from "vitest";
import { missingRequiredPromotionAcceptance } from "./promotionAcceptanceClient";

describe("missingRequiredPromotionAcceptance", () => {
  it("requires a token only for v2 promotion-code discounts", () => {
    expect(missingRequiredPromotionAcceptance({
      discounts: [{
        promotionEngineVersion: "promotion-engine.v2",
        reasonCode: "automatic_subscription_discount",
      }],
    } as never)).toBe(false);

    expect(missingRequiredPromotionAcceptance({
      discounts: [{
        promotionEngineVersion: "promotion-engine.v2",
        reasonCode: "promotion_code_v2",
      }],
    } as never)).toBe(true);

    expect(missingRequiredPromotionAcceptance({
      discounts: [{
        promotionEngineVersion: "promotion-engine.v2",
        reasonCode: "promotion_code_v2",
      }],
      promotionAcceptanceToken: "opaque-token",
    } as never)).toBe(false);
  });
});
