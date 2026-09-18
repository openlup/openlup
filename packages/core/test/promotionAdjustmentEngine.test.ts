import { describe, expect, it } from "vitest";
import {
  evaluatePromotionAdjustmentsV2,
  type PromotionAdjustmentCandidate,
  type PromotionAdjustmentContext,
} from "../src/promo/index.js";

const code80: PromotionAdjustmentCandidate = {
  promotionId: "code-benefit-80",
  codeId: "code-80",
  code: "SAVE80",
  name: "Save 80%",
  source: "code",
  lane: "product",
  kind: "target_percentage",
  valueBps: 8_000,
  scopes: ["one_time", "subscription_initial"],
};

function context(overrides: Partial<PromotionAdjustmentContext> = {}): PromotionAdjustmentContext {
  return {
    purchaseScope: "one_time",
    referenceProductMinor: 10_000,
    currentProductMinor: 10_000,
    shippingMinor: 1_500,
    minimumProductPayableMinor: 100,
    ...overrides,
  };
}

describe("evaluatePromotionAdjustmentsV2", () => {
  it.each([
    ["one_time", 0],
    ["subscription_initial", 0],
    ["subscription_initial", 500],
    ["subscription_initial", 1_000],
    ["subscription_initial", 2_000],
  ] as const)("makes CODE80 target-effective for %s with %i bps already active", (scope, automaticBps) => {
    const currentProductMinor = Math.ceil(10_000 * (10_000 - automaticBps) / 10_000);
    const result = evaluatePromotionAdjustmentsV2(
      context({ purchaseScope: scope, currentProductMinor }),
      [code80],
    );

    expect(result.productPayableMinor).toBe(2_000);
    expect(result.effectiveProductDiscountBps).toBe(8_000);
    expect(result.adjustments).toMatchObject([
      { codeId: "code-80", lane: "product", amountOffMinor: currentProductMinor - 2_000 },
    ]);
  });

  it("keeps product and shipping independent and permits free shipping", () => {
    const freeShipping: PromotionAdjustmentCandidate = {
      promotionId: "ship-free",
      name: "Free delivery",
      source: "automatic",
      lane: "shipping",
      kind: "free_shipping",
      scopes: ["subscription_initial"],
    };
    const result = evaluatePromotionAdjustmentsV2(
      context({ purchaseScope: "subscription_initial", currentProductMinor: 9_000 }),
      [code80, freeShipping],
    );

    expect(result.productPayableMinor).toBe(2_000);
    expect(result.shippingPayableMinor).toBe(0);
    expect(result.adjustments.map((adjustment) => adjustment.lane).sort()).toEqual(["product", "shipping"]);
  });

  it("enforces the product floor without imposing it on shipping", () => {
    const result = evaluatePromotionAdjustmentsV2(
      context({ referenceProductMinor: 101, currentProductMinor: 101, shippingMinor: 99 }),
      [
        { ...code80, valueBps: 9_999 },
        {
          promotionId: "ship-fixed",
          codeId: "ship-code",
          name: "Shipping credit",
          source: "code",
          lane: "shipping",
          kind: "fixed_amount",
          valueMinor: 500,
          scopes: ["one_time"],
        },
      ],
    );

    expect(result.productPayableMinor).toBe(100);
    expect(result.shippingPayableMinor).toBe(0);
    expect(result.adjustments.find((item) => item.lane === "product")?.floorApplied).toBe(true);
  });

  it("does not consume a code that only ties the current automatic price", () => {
    const result = evaluatePromotionAdjustmentsV2(
      context({ currentProductMinor: 5_000 }),
      [{ ...code80, valueBps: 5_000 }],
    );

    expect(result.adjustments).toEqual([]);
    expect(result.rejectedCodes).toEqual([
      { codeId: "code-80", code: "SAVE80", reason: "better_price_exists" },
    ]);
  });

  it("uses stable ids after amount and automatic-before-code tie-breaks", () => {
    const candidates: PromotionAdjustmentCandidate[] = [
      { ...code80, promotionId: "z-code", valueBps: 8_000 },
      {
        ...code80,
        promotionId: "a-auto",
        codeId: undefined,
        code: undefined,
        source: "automatic",
        valueBps: 8_000,
      },
    ];
    const forward = evaluatePromotionAdjustmentsV2(context(), candidates);
    const reverse = evaluatePromotionAdjustmentsV2(context(), [...candidates].reverse());

    expect(forward.adjustments[0].promotionId).toBe("a-auto");
    expect(reverse).toEqual(forward);
  });

  it("uses code-unit ids for same-source ties", () => {
    const result = evaluatePromotionAdjustmentsV2(context(), [
      { ...code80, promotionId: "z-benefit", codeId: "z-code" },
      { ...code80, promotionId: "a-benefit", codeId: "a-code", code: "ALSO80" },
    ]);
    expect(result.adjustments[0].promotionId).toBe("a-benefit");
  });

  it("deduplicates a losing dual-lane code rejection", () => {
    const result = evaluatePromotionAdjustmentsV2(context({ currentProductMinor: 5_000, shippingMinor: 0 }), [
      { ...code80, codeId: "dual", code: "DUAL", valueBps: 5_000 },
      {
        promotionId: "dual-shipping",
        codeId: "dual",
        code: "DUAL",
        name: "Dual shipping",
        source: "code",
        lane: "shipping",
        kind: "free_shipping",
        scopes: ["one_time"],
      },
    ]);
    expect(result.rejectedCodes).toEqual([{ codeId: "dual", code: "DUAL", reason: "better_price_exists" }]);
  });

  it("keeps target and shipping arithmetic exact at Number.MAX_SAFE_INTEGER", () => {
    const max = Number.MAX_SAFE_INTEGER;
    const result = evaluatePromotionAdjustmentsV2(context({
      referenceProductMinor: max,
      currentProductMinor: max,
      shippingMinor: max,
      minimumProductPayableMinor: 1,
    }), [
      { ...code80, valueBps: 1 },
      {
        promotionId: "max-shipping",
        codeId: "max-shipping-code",
        name: "Max shipping",
        source: "code",
        lane: "shipping",
        kind: "percentage",
        valueBps: 8_000,
        scopes: ["one_time"],
      },
    ]);
    const expectedProduct = Number((BigInt(max) * 9_999n + 9_999n) / 10_000n);
    const expectedShipping = max - Number((BigInt(max) * 8_000n) / 10_000n);
    expect(result.productPayableMinor).toBe(expectedProduct);
    expect(result.shippingPayableMinor).toBe(expectedShipping);
  });

  it.each<[unknown, string]>([
    [{ ...code80, valueBps: 10_000 }, "valueBps must be below 10000"],
    [{ ...code80, valueBps: 80.5 }, "valueBps must be a safe integer"],
    [{ ...code80, kind: "free_shipping", lane: "product", valueBps: undefined }, "product candidate kind"],
    [{ ...code80, lane: "bogus" }, "candidate lane is invalid"],
    [{ ...code80, source: "bogus" }, "candidate source is invalid"],
    [{ ...code80, scopes: ["bogus"] }, "candidate scopes are invalid"],
  ] as const)("fails closed for an invalid candidate", (candidate, message) => {
    expect(() => evaluatePromotionAdjustmentsV2(
      context(),
      [candidate as unknown as PromotionAdjustmentCandidate],
    )).toThrow(message);
  });

  it("fails closed when current product money exceeds the reference", () => {
    expect(() => evaluatePromotionAdjustmentsV2(
      context({ referenceProductMinor: 1_000, currentProductMinor: 1_001 }),
      [],
    )).toThrow("currentProductMinor cannot exceed referenceProductMinor");
  });

  it("fails closed for an invalid runtime scope or inconsistent dual-lane code", () => {
    expect(() => evaluatePromotionAdjustmentsV2(
      context({ purchaseScope: "bogus" as PromotionAdjustmentContext["purchaseScope"] }),
      [],
    )).toThrow("purchaseScope is invalid");
    expect(() => evaluatePromotionAdjustmentsV2(context(), [
      code80,
      {
        promotionId: "same-code-shipping",
        codeId: "code-80",
        code: "OTHER",
        name: "Same code shipping",
        source: "code",
        lane: "shipping",
        kind: "free_shipping",
        scopes: ["one_time"],
      },
    ])).toThrow("codeId candidates must use one code value");
    expect(() => evaluatePromotionAdjustmentsV2(context(), [{
      ...code80,
      source: "automatic",
      codeId: "not-automatic",
    } as unknown as PromotionAdjustmentCandidate])).toThrow("automatic candidates cannot carry code identity");
  });

});
