import { describe, expect, it } from "vitest";

import type { PromotionRow } from "../../../src/domains/promo/types.js";
import type { CommercePromoDataPort } from "./promoDataPort.js";
import { evaluateAutomaticPromotionV2 } from "./quotePromotionV2.js";

const NOW = "2026-09-03T10:00:00.000Z";

describe("promotion v2 legacy-code outcomes", () => {
  it("keeps a stronger legacy product code instead of the weaker automatic-v2 lane", async () => {
    const result = await evaluateAutomaticPromotionV2(input([
      automaticProduct("automatic-50", 5_000),
      legacyCoupon({ id: "legacy-save60", code: "SAVE60", discount_value: 60 }),
    ], ["SAVE60"]));

    expect(result.discounts).toEqual([expect.objectContaining({
      promotionId: "legacy-save60",
      code: "SAVE60",
      appliesTo: "order_total",
      amountOffMinor: 6_000,
      reasonCode: "promotion_v2:legacy_parity_floor:promo:SAVE60",
    })]);
    expect(result.codeRejections).toEqual([]);
  });

  it.each([
    ["weaker", 40],
    ["equal", 50],
  ])("keeps automatic-v2 money and truthfully rejects a %s legacy code", async (_kind, discountValue) => {
    const result = await evaluateAutomaticPromotionV2(input([
      automaticProduct("automatic-50", 5_000),
      legacyCoupon({ id: `legacy-save${discountValue}`, code: `SAVE${discountValue}`, discount_value: discountValue }),
    ], [`SAVE${discountValue}`]));

    expect(result.discounts).toEqual([expect.objectContaining({
      promotionId: "automatic-50",
      appliesTo: "order_total",
      amountOffMinor: 5_000,
    })]);
    expect(result.codeRejections).toEqual([
      { code: `SAVE${discountValue}`, reason: "better_price_exists" },
    ]);
  });

  it("keeps an independent legacy shipping code beside an automatic-v2 product winner", async () => {
    const result = await evaluateAutomaticPromotionV2(input([
      automaticProduct("automatic-50", 5_000),
      legacyCoupon({
        id: "legacy-shipfree",
        code: "SHIPFREE",
        discount_type: "free_shipping",
        discount_value: 100,
      }),
    ], ["SHIPFREE"]));

    expect(result.discounts).toEqual(expect.arrayContaining([
      expect.objectContaining({ promotionId: "automatic-50", appliesTo: "order_total", amountOffMinor: 5_000 }),
      expect.objectContaining({ promotionId: "legacy-shipfree", code: "SHIPFREE", appliesTo: "shipping", amountOffMinor: 1_500 }),
    ]));
    expect(result.codeRejections).toEqual([]);
  });

  it("keeps equal automatic-v2 shipping and leaves the legacy shipping code unused", async () => {
    const result = await evaluateAutomaticPromotionV2(input([
      automaticShipping("automatic-shipping"),
      legacyCoupon({ id: "legacy-shipfree", code: "SHIPFREE", discount_type: "free_shipping", discount_value: 100 }),
    ], ["SHIPFREE"]));

    expect(result.discounts).toEqual([expect.objectContaining({
      promotionId: "automatic-shipping", appliesTo: "shipping", amountOffMinor: 1_500,
    })]);
    expect(result.codeRejections).toEqual([{ code: "SHIPFREE", reason: "better_price_exists" }]);
  });

  it("keeps exact legacy literal selection before v2 reconciliation", async () => {
    const result = await evaluateAutomaticPromotionV2(input([
      automaticProduct("automatic-15", 1_500),
      legacyCoupon({ id: "legacy-upper", code: "SAVE10", name: "Upper", discount_value: 20 }),
      legacyCoupon({ id: "legacy-lower", code: "save10", name: "Lower", discount_value: 60 }),
    ], ["SAVE10"]));

    expect(result.discounts).toEqual([expect.objectContaining({
      promotionId: "legacy-upper",
      code: "SAVE10",
      amountOffMinor: 2_000,
    })]);
  });
});

function input(rows: PromotionRow[], promoCodes: string[]) {
  return {
    promoDataPort: port(rows),
    clientId: null,
    mode: "one_time" as const,
    promoCodes,
    regionCode: "GLOBAL",
    referenceProductMinor: 10_000,
    currentProductMinor: 10_000,
    shippingMinor: 1_500,
    atTime: NOW,
  };
}

function automaticProduct(id: string, valueBps: number): PromotionRow {
  return row(id, {
    name: id,
    promotion_engine_version: "promotion-engine.v2",
    benefit_lane: "product",
    benefit_kind: "target_percentage",
    benefit_value_bps: valueBps,
  });
}

function automaticShipping(id: string): PromotionRow {
  return row(id, {
    name: id,
    promotion_engine_version: "promotion-engine.v2",
    benefit_lane: "shipping",
    benefit_kind: "free_shipping",
  });
}

function legacyCoupon(overrides: Partial<PromotionRow>): PromotionRow {
  return row(overrides.id ?? "legacy-code", {
    code: "SAVE",
    trigger_type: "coupon_code",
    name: "Legacy code",
    discount_type: "percentage",
    discount_value: 10,
    ...overrides,
  });
}

function row(id: string, overrides: Record<string, unknown> = {}): PromotionRow {
  return {
    id,
    code: null,
    name: id,
    trigger_type: "automatic",
    discount_type: "percentage",
    discount_value: 10,
    applies_to_kind: "order_total",
    applies_to_payload: {},
    stacking_rule: "exclusive",
    eligibility: {},
    valid_from: "2026-01-01T00:00:00.000Z",
    valid_to: null,
    status: "active",
    region_availability: ["GLOBAL"],
    ...overrides,
  } as PromotionRow;
}

function port(rows: PromotionRow[]): CommercePromoDataPort {
  return {
    listActivePromotions: async () => rows,
    countPaidOrders: async () => 0,
    countPaidOrdersByMode: async () => ({ oneTime: 0, subscription: 0 }),
    redemptionCounts: async () => new Map(),
    deviceFirstOrderRedeemed: async () => false,
  };
}
