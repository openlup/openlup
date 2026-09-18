import { describe, expect, it } from "vitest";
import type { PromotionRow } from "../../../src/domains/promo/types.js";
import { evaluateOrderTotalDiscounts } from "./quotePromoDiscounts.js";
import type { CommercePromoDataPort } from "./promoDataPort.js";

const NOW = "2026-06-03T14:00:00Z";

function firstOnetimePromo(): PromotionRow {
  return {
    id: "first-bundle",
    code: null,
    name: "Operator-defined acquisition label",
    trigger_type: "automatic",
    discount_type: "percentage",
    discount_value: 10,
    applies_to_kind: "order_total",
    applies_to_payload: { cart_mode: "one_time" },
    stacking_rule: "exclusive",
    eligibility: { first_onetime_purchase: true },
    valid_from: "2026-06-01T00:00:00Z",
    valid_to: null,
    status: "active",
    region_availability: ["PL"],
  };
}

function makePort(overrides: Partial<CommercePromoDataPort> = {}): CommercePromoDataPort {
  return {
    listActivePromotions: async () => [firstOnetimePromo()],
    countPaidOrders: async () => 0,
    countPaidOrdersByMode: async () => ({ oneTime: 0, subscription: 0 }),
    redemptionCounts: async () => new Map(),
    // Device already redeemed a first order — the guard would normally deny.
    deviceFirstOrderRedeemed: async () => true,
    ...overrides,
  };
}

const baseInput = {
  clientId: null,
  visitorId: "vid-used-device",
  mode: "one_time" as const,
  promoCodes: [] as string[],
  regionCode: "PL" as const,
  subtotalGrossMinor: 10000,
  shippingGrossMinor: 0,
  atTime: NOW,
};

describe("evaluateOrderTotalDiscounts — device guard vs confirmed email", () => {
  it("denies the first-order discount on a used device with no email signal", async () => {
    const { discounts } = await evaluateOrderTotalDiscounts({
      promoDataPort: makePort(),
      ...baseInput,
    });
    expect(discounts).toHaveLength(0);
  });

  it("grants the first-order discount when the email confirms eligibility", async () => {
    const { discounts } = await evaluateOrderTotalDiscounts({
      promoDataPort: makePort(),
      ...baseInput,
      emailEligibilityConfirmed: true,
    });
    expect(discounts).toHaveLength(1);
    expect(discounts[0]).toMatchObject({
      appliesTo: "order_total",
      amountOffMinor: 1000,
      customerSemantic: "first_purchase_10",
    });
  });

  it("reports a case-insensitive legacy code that loses to a better automatic price", async () => {
    const automatic = {
      ...firstOnetimePromo(),
      id: "automatic-60",
      discount_value: 60,
      name: "Automatic 60",
    };
    const weakerCode = couponPromo({
      id: "code-save10",
      code: "SAVE10",
      name: "Save 10",
      discount_value: 10,
    });
    const result = await evaluateOrderTotalDiscounts({
      promoDataPort: makePort({ listActivePromotions: async () => [automatic, weakerCode] }),
      ...baseInput,
      emailEligibilityConfirmed: true,
      promoCodes: ["save10"],
    });

    expect(result.discounts).toEqual([expect.objectContaining({ promotionId: "automatic-60" })]);
    expect(result.codeRejections).toEqual([{ code: "save10", reason: "better_price_exists" }]);
  });

  it("does not reject a case-insensitive code applied in the shipping lane", async () => {
    const automatic = {
      ...firstOnetimePromo(),
      id: "automatic-60",
      discount_value: 60,
      name: "Automatic 60",
    };
    const shippingCode = couponPromo({
      id: "code-shipfree",
      code: "SHIPFREE",
      name: "Free shipping",
      discount_type: "free_shipping",
      discount_value: 100,
    });
    const result = await evaluateOrderTotalDiscounts({
      promoDataPort: makePort({ listActivePromotions: async () => [automatic, shippingCode] }),
      ...baseInput,
      emailEligibilityConfirmed: true,
      promoCodes: ["shipfree"],
      shippingGrossMinor: 1_500,
    });

    expect(result.discounts).toEqual(expect.arrayContaining([
      expect.objectContaining({ promotionId: "automatic-60", appliesTo: "order_total" }),
      expect.objectContaining({ promotionId: "code-shipfree", code: "SHIPFREE", appliesTo: "shipping" }),
    ]));
    expect(result.codeRejections).toEqual([]);
  });

  it("keeps legacy 60VIP applied for its one-time scope with canonical code identity", async () => {
    const legacy60Vip = couponPromo({
      id: "legacy-60vip",
      code: "60VIP",
      name: "Legacy 60 VIP",
      discount_value: 60,
    });
    const result = await evaluateOrderTotalDiscounts({
      promoDataPort: makePort({ listActivePromotions: async () => [legacy60Vip] }),
      ...baseInput,
      emailEligibilityConfirmed: true,
      promoCodes: ["60vip"],
    });

    expect(result.discounts).toEqual([expect.objectContaining({
      promotionId: "legacy-60vip",
      code: "60VIP",
      amountOffMinor: 6_000,
    })]);
    expect(result.codeRejections).toEqual([]);
  });

  it("rejects legacy 60VIP in the subscription cart mode without changing v1 money", async () => {
    const legacy60Vip = couponPromo({
      id: "legacy-60vip",
      code: "60VIP",
      name: "Legacy 60 VIP",
      discount_value: 60,
    });
    const result = await evaluateOrderTotalDiscounts({
      promoDataPort: makePort({ listActivePromotions: async () => [legacy60Vip] }),
      ...baseInput,
      mode: "subscription",
      promoCodes: ["60VIP"],
    });

    expect(result.discounts).toEqual([]);
    expect(result.codeRejections).toEqual([{ code: "60VIP", reason: "not_eligible" }]);
  });

  it("preserves exact legacy code selection when normalized collisions exist", async () => {
    const upper = couponPromo({ id: "legacy-upper", code: "SAVE10", name: "Upper", discount_value: 10 });
    const lower = couponPromo({ id: "legacy-lower", code: "save10", name: "Lower", discount_value: 60 });
    const result = await evaluateOrderTotalDiscounts({
      promoDataPort: makePort({ listActivePromotions: async () => [upper, lower] }),
      ...baseInput,
      promoCodes: ["SAVE10"],
    });

    expect(result.discounts).toEqual([expect.objectContaining({
      promotionId: "legacy-upper",
      code: "SAVE10",
      amountOffMinor: 1_000,
    })]);
    expect(result.codeRejections).toEqual([]);
  });

  it("keeps an applied shipping code when another same-literal legacy row fails scope", async () => {
    const scopeFailingProduct = couponPromo({
      id: "legacy-product-scope-fail",
      code: "SAMECODE",
      name: "Product scope fail",
      applies_to_payload: { cart_mode: "subscription" },
    });
    const appliedShipping = couponPromo({
      id: "legacy-shipping-applied",
      code: "SAMECODE",
      name: "Shipping applies",
      discount_type: "free_shipping",
      discount_value: 100,
    });
    const result = await evaluateOrderTotalDiscounts({
      promoDataPort: makePort({ listActivePromotions: async () => [scopeFailingProduct, appliedShipping] }),
      ...baseInput,
      promoCodes: ["SAMECODE"],
      shippingGrossMinor: 1_500,
    });

    expect(result.discounts).toEqual([expect.objectContaining({
      promotionId: "legacy-shipping-applied",
      code: "SAMECODE",
      appliesTo: "shipping",
    })]);
    expect(result.codeRejections).toEqual([]);
  });
});

function couponPromo(overrides: Partial<PromotionRow>): PromotionRow {
  return {
    id: "coupon",
    code: "COUPON",
    name: "Coupon",
    trigger_type: "coupon_code",
    discount_type: "percentage",
    discount_value: 10,
    applies_to_kind: "order_total",
    applies_to_payload: { cart_mode: "one_time" },
    stacking_rule: "exclusive",
    eligibility: {},
    valid_from: "2026-06-01T00:00:00Z",
    valid_to: null,
    status: "active",
    region_availability: ["PL"],
    ...overrides,
  };
}
