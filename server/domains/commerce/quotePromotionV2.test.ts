import { describe, expect, it } from "vitest";

import type { PromotionRow } from "../../../src/domains/promo/types.js";
import type { CommercePromoDataPort, PromotionRedemptionCount } from "./promoDataPort.js";
import { evaluateAutomaticPromotionV2, legacyPromotionDataPort } from "./quotePromotionV2.js";
import { evaluateOrderTotalDiscounts } from "./quotePromoDiscounts.js";

const legacy = row("legacy", {
  discount_value: 44.404,
  applies_to_payload: { cart_mode: "subscription" },
  eligibility: { first_subscription_purchase: true },
});
const target = row("target", {
  applies_to_payload: { cart_mode: "subscription" },
  eligibility: { first_subscription_purchase: true },
  promotion_engine_version: "promotion-engine.v2",
  benefit_lane: "product",
  benefit_kind: "target_percentage",
  benefit_value_bps: 5_000,
});

describe("quote promotion v2 adapter", () => {
  it("applies explicit 5000 bps against reference price, not the subscription price", async () => {
    const result = await evaluateAutomaticPromotionV2({
      promoDataPort: port([legacy, target]), clientId: null,
      mode: "subscription", regionCode: "PL", referenceProductMinor: 10_000,
      currentProductMinor: 9_000, shippingMinor: 1_500,
      atTime: "2026-07-14T12:00:00.000Z",
    });
    expect(result.discounts).toEqual([expect.objectContaining({
      promotionId: "target", appliesTo: "order_total", amountOffMinor: 4_000,
      customerSemantic: "first_subscription_50",
    })]);
  });

  it("keeps explicit v2 rows out of the legacy evaluator", async () => {
    await expect(legacyPromotionDataPort(port([legacy, target])).listActivePromotions())
      .resolves.toEqual([legacy]);
  });

  it("preserves the current first-subscription policy at exactly 50% in v1 and v2", async () => {
    const currentLegacy = row("current-v1", {
      name: "Legacy internal label",
      discount_value: 44.404,
      applies_to_payload: { cart_mode: "subscription" },
      eligibility: { first_subscription_purchase: true },
      redemption_limit_per_customer: 1,
    });
    const currentV2 = row("current-v2", {
      name: "V2 internal label",
      discount_value: 50,
      applies_to_payload: { cart_mode: "subscription" },
      eligibility: { first_subscription_purchase: true },
      redemption_limit_per_customer: 1,
      promotion_engine_version: "promotion-engine.v2",
      benefit_lane: "product",
      benefit_kind: "target_percentage",
      benefit_value_bps: 5_000,
    });
    const currentPolicy = port([currentLegacy, currentV2]);

    const v1 = await evaluateOrderTotalDiscounts({
      promoDataPort: legacyPromotionDataPort(currentPolicy), clientId: null,
      mode: "subscription", promoCodes: [], regionCode: "PL",
      subtotalGrossMinor: 18_760, shippingGrossMinor: 1_500,
      atTime: "2026-07-14T12:00:00.000Z",
    });
    const v2 = await evaluateAutomaticPromotionV2({
      promoDataPort: currentPolicy, clientId: null,
      mode: "subscription", regionCode: "PL", referenceProductMinor: 20_860,
      currentProductMinor: 18_760, shippingMinor: 1_500,
      atTime: "2026-07-14T12:00:00.000Z",
    });

    expect(v1.discounts).toEqual([expect.objectContaining({ amountOffMinor: 8_330 })]);
    expect(v2.discounts).toEqual([expect.objectContaining({
      amountOffMinor: 8_330,
      customerSemantic: "first_subscription_50",
    })]);
    expect(18_760 - v2.discounts[0]!.amountOffMinor).toBe(20_860 / 2);
  });

  it("preserves first-purchase semantics through the legacy parity floor", async () => {
    const firstPurchase = row("first-purchase", {
      name: "Internal one-time acquisition label",
      discount_value: 10,
      applies_to_payload: { cart_mode: "one_time" },
      eligibility: { first_onetime_purchase: true },
      redemption_limit_per_customer: 1,
    });
    const result = await evaluateAutomaticPromotionV2({
      promoDataPort: port([firstPurchase]), clientId: null,
      mode: "one_time", regionCode: "PL", referenceProductMinor: 10_000,
      currentProductMinor: 10_000, shippingMinor: 1_500,
      atTime: "2026-07-14T12:00:00.000Z",
    });

    expect(result.discounts).toEqual([expect.objectContaining({
      amountOffMinor: 1_000,
      customerSemantic: "first_purchase_10",
      reasonCode: expect.stringContaining("legacy_parity_floor"),
    })]);
  });

  it("preserves bundle semantics for a returning one-time customer", async () => {
    const bundle = row("bundle", {
      name: "Internal bundle label",
      discount_value: 5,
      stacking_rule: "stackable_with_any",
      applies_to_payload: { cart_mode: "one_time" },
      eligibility: { min_cart_minor: 12_000 },
    });
    const returningPort = port([bundle]);
    returningPort.countPaidOrdersByMode = async () => ({ oneTime: 1, subscription: 0 });
    const result = await evaluateAutomaticPromotionV2({
      promoDataPort: returningPort, clientId: "returning-client",
      mode: "one_time", regionCode: "PL", referenceProductMinor: 20_000,
      currentProductMinor: 20_000, shippingMinor: 1_500,
      atTime: "2026-07-14T12:00:00.000Z",
    });

    expect(result.discounts).toEqual([expect.objectContaining({
      amountOffMinor: 1_000,
      customerSemantic: "bundle_5",
      reasonCode: expect.stringContaining("legacy_parity_floor"),
    })]);
  });

  it("never worsens an in-flight v2 price when the legacy discount changes", async () => {
    const changedLegacy = row("changed-v1", {
      name: "First Subscription 50%",
      discount_value: 50,
      applies_to_payload: { cart_mode: "subscription" },
      eligibility: { first_subscription_purchase: true },
    });
    const changedPolicy = port([changedLegacy]);
    const v1 = await evaluateOrderTotalDiscounts({
      promoDataPort: changedPolicy, clientId: null, mode: "subscription",
      promoCodes: [], regionCode: "PL", subtotalGrossMinor: 18_760,
      shippingGrossMinor: 1_500, atTime: "2026-07-14T12:00:00.000Z",
    });
    const inFlightV2 = await evaluateAutomaticPromotionV2({
      promoDataPort: changedPolicy, clientId: null, mode: "subscription",
      regionCode: "PL", referenceProductMinor: 20_860,
      currentProductMinor: 18_760, shippingMinor: 1_500,
      atTime: "2026-07-14T12:00:00.000Z",
    });

    expect(inFlightV2.discounts[0]!.amountOffMinor)
      .toBe(v1.discounts[0]!.amountOffMinor);
    expect(inFlightV2.discounts[0]!.reasonCode)
      .toContain("promotion_v2:legacy_parity_floor");
  });

  it("shares the exhausted global cap between a legacy promotion and its v2 mirror", async () => {
    const legacyCapped = row("capped-v1", {
      applies_to_payload: { cart_mode: "subscription" },
      eligibility: { first_subscription_purchase: true },
      redemption_limit_global: 2,
      redemption_limit_per_customer: 1,
    });
    const mirror = row("capped-v2", {
      applies_to_payload: { cart_mode: "subscription" },
      eligibility: { first_subscription_purchase: true },
      redemption_limit_global: 2,
      redemption_limit_per_customer: 1,
      promotion_engine_version: "promotion-engine.v2",
      benefit_lane: "product",
      benefit_kind: "target_percentage",
      benefit_value_bps: 5_000,
      v2_mirror_of: "capped-v1",
    });
    const counts = new Map<string, PromotionRedemptionCount>([
      ["capped-v1", { global: 2, perCustomer: 0 }],
    ]);

    const result = await evaluateAutomaticPromotionV2({
      promoDataPort: port([legacyCapped, mirror], counts), clientId: "client-a",
      mode: "subscription", regionCode: "PL", referenceProductMinor: 10_000,
      currentProductMinor: 9_000, shippingMinor: 1_500,
      atTime: "2026-07-14T12:00:00.000Z",
    });

    expect(result.discounts).toEqual([]);
  });

  it("shares the exhausted per-customer cap between a legacy promotion and its v2 mirror", async () => {
    const legacyCapped = row("customer-capped-v1", {
      applies_to_payload: { cart_mode: "subscription" },
      eligibility: { first_subscription_purchase: true },
      redemption_limit_global: 2,
      redemption_limit_per_customer: 1,
    });
    const mirror = row("customer-capped-v2", {
      applies_to_payload: { cart_mode: "subscription" },
      eligibility: { first_subscription_purchase: true },
      redemption_limit_global: 2,
      redemption_limit_per_customer: 1,
      promotion_engine_version: "promotion-engine.v2",
      benefit_lane: "product",
      benefit_kind: "target_percentage",
      benefit_value_bps: 5_000,
      v2_mirror_of: "customer-capped-v1",
    });
    const counts = new Map<string, PromotionRedemptionCount>([
      ["customer-capped-v1", { global: 1, perCustomer: 1 }],
    ]);

    const result = await evaluateAutomaticPromotionV2({
      promoDataPort: port([legacyCapped, mirror], counts), clientId: "client-a",
      mode: "subscription", regionCode: "PL", referenceProductMinor: 10_000,
      currentProductMinor: 9_000, shippingMinor: 1_500,
      atTime: "2026-07-14T12:00:00.000Z",
    });

    expect(result.discounts).toEqual([]);
  });

  it("still applies before the shared promotion-family caps are exhausted", async () => {
    const legacyCapped = row("available-v1", {
      applies_to_payload: { cart_mode: "subscription" },
      eligibility: { first_subscription_purchase: true },
      redemption_limit_global: 2,
      redemption_limit_per_customer: 1,
    });
    const mirror = row("available-v2", {
      applies_to_payload: { cart_mode: "subscription" },
      eligibility: { first_subscription_purchase: true },
      redemption_limit_global: 2,
      redemption_limit_per_customer: 1,
      promotion_engine_version: "promotion-engine.v2",
      benefit_lane: "product",
      benefit_kind: "target_percentage",
      benefit_value_bps: 5_000,
      v2_mirror_of: "available-v1",
    });
    const counts = new Map<string, PromotionRedemptionCount>([
      ["available-v1", { global: 1, perCustomer: 0 }],
    ]);

    const result = await evaluateAutomaticPromotionV2({
      promoDataPort: port([legacyCapped, mirror], counts), clientId: "client-a",
      mode: "subscription", regionCode: "PL", referenceProductMinor: 10_000,
      currentProductMinor: 9_000, shippingMinor: 1_500,
      atTime: "2026-07-14T12:00:00.000Z",
    });

    expect(result.discounts).toEqual([expect.objectContaining({
      promotionId: "available-v1",
      amountOffMinor: 4_500,
      reasonCode: expect.stringContaining("legacy_parity_floor"),
    })]);
  });
});

function row(id: string, extra: Record<string, unknown> = {}): PromotionRow {
  return {
    id, code: null, name: id, trigger_type: "automatic",
    discount_type: "percentage", discount_value: 50,
    applies_to_kind: "order_total", applies_to_payload: {},
    stacking_rule: "exclusive", eligibility: {},
    valid_from: "2026-01-01T00:00:00.000Z", valid_to: null,
    status: "active", region_availability: ["PL"], ...extra,
  } as PromotionRow;
}

function port(
  rows: PromotionRow[],
  counts: Map<string, PromotionRedemptionCount> = new Map(),
): CommercePromoDataPort {
  return {
    listActivePromotions: async () => rows,
    countPaidOrders: async () => 0,
    countPaidOrdersByMode: async () => ({ oneTime: 0, subscription: 0 }),
    redemptionCounts: async () => counts,
    deviceFirstOrderRedeemed: async () => false,
  };
}
