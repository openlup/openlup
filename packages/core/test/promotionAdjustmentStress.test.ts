import { describe, it } from "vitest";
import {
  evaluatePromotionAdjustmentsV2,
  type PromotionAdjustmentCandidate,
  type PromotionPurchaseScope,
} from "../src/promo/index.js";

describe("promotion adjustment stress", () => {
  it("holds all money and winner invariants across 200,000 deterministic cases", () => {
    let seed = 0x5eed_2026;
    const next = (max: number) => {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      return seed % max;
    };

    for (let index = 0; index < 200_000; index += 1) {
      const floor = 1 + next(500);
      const referenceProductMinor = floor + next(100_000);
      const automaticBps = next(4_001);
      const currentProductMinor = Math.max(
        floor,
        Math.ceil(referenceProductMinor * (10_000 - automaticBps) / 10_000),
      );
      const shippingMinor = next(5_001);
      const valueBps = 1 + next(9_999);
      const automaticTargetBps = 1 + next(6_000);
      const fixedMinor = 1 + next(20_000);
      const scope: PromotionPurchaseScope = next(2) === 0 ? "one_time" : "subscription_initial";
      const productCode: PromotionAdjustmentCandidate = {
        promotionId: "target-code",
        codeId: "code-80",
        code: "SAVE",
        name: "Target code",
        source: "code",
        lane: "product",
        kind: "target_percentage",
        valueBps,
        scopes: [scope],
      };
      const automaticTarget: PromotionAdjustmentCandidate = {
        promotionId: "automatic-target",
        name: "Automatic target",
        source: "automatic",
        lane: "product",
        kind: "target_percentage",
        valueBps: automaticTargetBps,
        scopes: [scope],
      };
      const fixedProduct: PromotionAdjustmentCandidate = {
        promotionId: "fixed-product",
        codeId: "fixed-code",
        code: "FIXED",
        name: "Fixed product",
        source: "code",
        lane: "product",
        kind: "fixed_amount",
        valueMinor: fixedMinor,
        scopes: [scope],
      };
      const shippingCode = makeShippingCandidate(index, scope, valueBps, fixedMinor);
      const input = {
        purchaseScope: scope,
        referenceProductMinor,
        currentProductMinor,
        shippingMinor,
        minimumProductPayableMinor: floor,
      };
      const candidates = [productCode, automaticTarget, fixedProduct, shippingCode];
      const result = evaluatePromotionAdjustmentsV2(input, candidates);
      const repeated = evaluatePromotionAdjustmentsV2(input, [...candidates].reverse());
      const target = (bps: number) => Math.max(
        floor,
        Number((BigInt(referenceProductMinor) * BigInt(10_000 - bps) + 9_999n) / 10_000n),
      );
      const expectedProduct = Math.min(
        currentProductMinor,
        target(valueBps),
        target(automaticTargetBps),
        Math.max(floor, currentProductMinor - fixedMinor),
      );
      const expectedShipping = index % 3 === 0
        ? 0
        : index % 3 === 1
          ? shippingMinor - Number((BigInt(shippingMinor) * BigInt(valueBps)) / 10_000n)
          : Math.max(0, shippingMinor - fixedMinor);
      const productAdjustments = result.adjustments.filter((item) => item.lane === "product");
      const shippingAdjustments = result.adjustments.filter((item) => item.lane === "shipping");
      const finalTotal = result.productPayableMinor + result.shippingPayableMinor;

      if (JSON.stringify(repeated) !== JSON.stringify(result) ||
          result.productPayableMinor !== expectedProduct || result.shippingPayableMinor !== expectedShipping ||
          productAdjustments.length > 1 || shippingAdjustments.length > 1 ||
          result.productPayableMinor < floor || result.shippingPayableMinor < 0 ||
          finalTotal !== currentProductMinor - (productAdjustments[0]?.amountOffMinor ?? 0) +
            shippingMinor - (shippingAdjustments[0]?.amountOffMinor ?? 0) ||
          result.adjustments.some((item) => item.beforeMinor - item.afterMinor !== item.amountOffMinor)) {
        throw new Error(`promotion stress invariant failed at case ${index}`);
      }
    }
  }, 30_000);
});

function makeShippingCandidate(
  index: number,
  scope: PromotionPurchaseScope,
  valueBps: number,
  fixedMinor: number,
): PromotionAdjustmentCandidate {
  const base = {
    codeId: "code-80",
    code: "SAVE",
    source: "code" as const,
    lane: "shipping" as const,
    scopes: [scope],
  };
  if (index % 3 === 0) {
    return { ...base, promotionId: "shipping-free", name: "Free shipping", kind: "free_shipping" };
  }
  if (index % 3 === 1) {
    return { ...base, promotionId: "shipping-percent", name: "Shipping percent", kind: "percentage", valueBps };
  }
  return { ...base, promotionId: "shipping-fixed", name: "Shipping fixed", kind: "fixed_amount", valueMinor: fixedMinor };
}
