import { describe, expect, it, vi } from "vitest";

import type { CatalogReadPort } from "../../../src/domains/catalog/ports.js";
import type { CatalogProduct } from "../../../src/domains/catalog/types.js";
import { createQuoteResponseSchema, type CreateQuoteRequest } from "../../../src/domains/commerce/contracts.js";
import { OFFER_POLICY_V2, PROMOTION_ENGINE_V2 } from "../../../src/domains/commerce/offerPolicyContracts.js";
import type { CreateQuoteOptions } from "../../../src/domains/commerce/ports.js";
import type { PricingResolverPort } from "../../../src/domains/pricing/ports.js";
import type { ResolvedPrice, ResolvePriceQuery } from "../../../src/domains/pricing/types.js";
import type { PromotionRow } from "../../../src/domains/promo/types.js";
import type { CommerceCodeRejection, CommerceCodeRejectionDetail } from "../../../src/domains/commerce/types.js";
import { createDbBackedCommerceQuotePort } from "./dbBackedCommerceQuotePort.js";
import type { CommercePromoDataPort } from "./promoDataPort.js";
import type { PromotionCodeQuotePort, ResolvedPromotionCodeCandidate } from "./promotionCodeQuotePort.js";
import { issuePromotionQuoteAcceptance, verifyPromotionQuoteAcceptance } from "./promotionQuoteAcceptance.js";

const NOW = new Date("2026-09-03T10:00:00.000Z");
const KEYRING = { current: "a".repeat(32) };
const QUOTE_OPTIONS = {
  pricingPolicy: { offerPolicyVersion: OFFER_POLICY_V2, promotionEngineVersion: PROMOTION_ENGINE_V2 },
} as CreateQuoteOptions;

describe("db-backed quote promotion-v2 legacy outcomes", () => {
  it("composes one full floor-safe v2 code discount for a legacy/v2 identity without changing acceptance", async () => {
    const request = quoteRequest("SAVE99");
    const response = await quotePort(
      legacyCoupon("SAVE99", 10),
      v2Code("SAVE99", { kind: "target_percentage", valueBps: 9_999 }),
    ).createQuote(request, QUOTE_OPTIONS);

    expect(createQuoteResponseSchema.parse(response)).toEqual(response);
    expect(response.quote.discounts).toEqual([expect.objectContaining({
      code: "SAVE99",
      amountOffMinor: 9_900,
      promotionEngineVersion: "promotion-engine.v2",
      floorApplied: true,
    })]);
    expect(response.quote.codeRejections).toBeUndefined();
    expect(response.quote.discountTotalGross.amountMinor).toBe(9_900);
    expect(response.quote.totalGross.amountMinor).toBe(100);

    const token = issuePromotionQuoteAcceptance({ request, quote: response.quote, keyring: KEYRING, now: NOW });
    expect(token).not.toBeNull();
    expect(verifyPromotionQuoteAcceptance({
      token: token!,
      request,
      quote: response.quote,
      expectedTotal: response.quote.totalGross,
      keyring: KEYRING,
      now: NOW,
    })).toBe(true);
  });

  it("keeps the stronger legacy result when a matching v2 code would worsen the lane", async () => {
    const request = quoteRequest("save60");
    const response = await quotePort(
      legacyCoupon("SAVE60", 60),
      v2Code("SAVE60", { kind: "fixed_amount", valueMinor: 500 }),
    ).createQuote(request, QUOTE_OPTIONS);

    expect(createQuoteResponseSchema.parse(response)).toEqual(response);
    expect(response.quote.discounts).toEqual([expect.objectContaining({
      code: "save60",
      amountOffMinor: 6_000,
    })]);
    expect(response.quote.discounts[0]).not.toHaveProperty("promotionEngineVersion");
    expect(response.quote.codeRejections).toBeUndefined();
    expect(response.quote.discountTotalGross.amountMinor).toBe(6_000);
    expect(response.quote.totalGross.amountMinor).toBe(4_000);
    expect(issuePromotionQuoteAcceptance({ request, quote: response.quote, keyring: KEYRING, now: NOW })).toBeNull();
  });

  it("reduces stackable legacy case collisions to one first-submitted lane result when v2 loses", async () => {
    const request = quoteRequest("SAVE10", "save10", "SAVE10");
    const response = await quotePort(
      [
        legacyCoupon("SAVE10", 10, "stackable_with_any"),
        legacyCoupon("save10", 10, "stackable_with_any"),
      ],
      v2Code("SAVE10", { kind: "fixed_amount", valueMinor: 500 }),
    ).createQuote(request, QUOTE_OPTIONS);

    expect(createQuoteResponseSchema.parse(response)).toEqual(response);
    expect(response.quote.discounts).toEqual([expect.objectContaining({
      promotionId: "legacy-SAVE10",
      code: "SAVE10",
      amountOffMinor: 1_000,
    })]);
    expect(response.quote.discounts[0]).not.toHaveProperty("promotionEngineVersion");
    expect(response.quote.codeRejections).toBeUndefined();
    expect(response.quote.discountTotalGross.amountMinor).toBe(1_000);
    expect(response.quote.totalGross.amountMinor).toBe(9_000);
  });

  it("compares a collision-reduced legacy lane with automatic v2 without a code resolver", async () => {
    const response = await quotePort([
      automaticV2(15), legacyCoupon("SAVE10", 10, "stackable_with_any"), legacyCoupon("save10", 10, "stackable_with_any"),
    ], [], 0, false).createQuote(quoteRequest("SAVE10", "save10"), QUOTE_OPTIONS);

    expect(createQuoteResponseSchema.parse(response)).toEqual(response);
    expect(response.quote.discounts).toEqual([expect.objectContaining({ promotionId: "automatic-15", amountOffMinor: 1_500 })]);
    expect(response.quote.codeRejections).toEqual([{ code: "SAVE10", reason: "better_price_exists" }]);
    expect(response.quote.totalGross.amountMinor).toBe(8_500);
  });

  it("keeps stackable legacy case variants byte-exact when a resolver is present without v2 policy", async () => {
    const response = await quotePort([
      legacyCoupon("SAVE80", 10, "stackable_with_any"), legacyCoupon("save80", 60, "stackable_with_any"),
    ]).createQuote(quoteRequest("SAVE80", "save80"));

    expect(createQuoteResponseSchema.parse(response)).toEqual(response);
    expect(response.quote.discounts).toEqual([
      expect.objectContaining({ promotionId: "legacy-save80", code: "save80", amountOffMinor: 6_000 }),
      expect.objectContaining({ promotionId: "legacy-SAVE80", code: "SAVE80", amountOffMinor: 1_000 }),
    ]);
    expect(response.quote.discounts.every((discount) => discount.promotionEngineVersion === undefined)).toBe(true);
    expect(response.quote.codeRejections).toBeUndefined();
    expect(response.quote.discountTotalGross.amountMinor).toBe(7_000);
    expect(response.quote.totalGross.amountMinor).toBe(3_000);
  });

  it("keeps an authoritative expired resolver outcome over synthetic parity rejection", async () => {
    const response = await quotePort([automaticV2(15)], [], 0, true, [{ code: "SAVE10", reason: "expired" }])
      .createQuote(quoteRequest("save10"), QUOTE_OPTIONS);

    expect(createQuoteResponseSchema.parse(response)).toEqual(response);
    expect(response.quote.codeRejections).toEqual([{ code: "save10", reason: "expired" }]);
  });

  it("keeps the engine's better-price outcome over synthetic parity rejection", async () => {
    const response = await quotePort([automaticV2(15)], v2Code("SAVE10", { kind: "target_percentage", valueBps: 1_000 }), 0, true, [],
      [{ code: "SAVE10", reason: "scope_not_applicable", allowedScopes: ["one_time"] }])
      .createQuote(quoteRequest("save10"), QUOTE_OPTIONS);

    expect(createQuoteResponseSchema.parse(response)).toEqual(response);
    expect(response.quote.codeRejections).toEqual([{ code: "save10", reason: "better_price_exists" }]);
    expect(response.quote.codeRejectionDetails).toBeUndefined();
  });

  it("orders distinct final code discounts by submitted identity while preserving evaluator lanes", async () => {
    const request = quoteRequest("shipfree", "product10");
    const response = await quotePort(
      [
        legacyCoupon("PRODUCT10", 10, "stackable_with_any"),
        legacyCoupon("SHIPFREE", 100, "stackable_with_any", "free_shipping"),
      ],
      [],
      1_500,
    ).createQuote(request, QUOTE_OPTIONS);

    expect(createQuoteResponseSchema.parse(response)).toEqual(response);
    expect(response.quote.discounts.map(({ code, appliesTo }) => ({ code, appliesTo }))).toEqual([
      { code: "shipfree", appliesTo: "shipping" },
      { code: "product10", appliesTo: "order_total" },
    ]);
  });
});

function quotePort(
  legacy: PromotionRow | readonly PromotionRow[],
  candidates: ResolvedPromotionCodeCandidate | readonly ResolvedPromotionCodeCandidate[] = [],
  shippingGrossMinor = 0,
  withResolver = true,
  codeRejections: CommerceCodeRejection[] = [],
  codeRejectionDetails: CommerceCodeRejectionDetail[] = [],
) {
  return createDbBackedCommerceQuotePort({
    catalogReadPort: catalogReadPort(),
    pricingResolverPort: pricingResolver(),
    promoDataPort: promoDataPort(legacy),
    ...(withResolver ? { promotionCodeQuotePort: promotionCodeQuotePort(candidates, codeRejections, codeRejectionDetails) } : {}),
    ...(shippingGrossMinor ? { commerceSettingsPort: { getShippingFlatMinor: async () => shippingGrossMinor } } : {}),
    regionCode: "GLOBAL",
    now: () => NOW.toISOString(),
  });
}

function quoteRequest(...promoCodes: string[]): CreateQuoteRequest {
  return {
    mode: "one_time",
    lines: [{ sku: "opaque:lamb-launch.v1", quantity: 1 }],
    promoCodes,
  };
}

function catalogReadPort(): CatalogReadPort {
  const product = {
    slug: "lamb",
    primarySku: { variantId: "variant-lamb-400" },
    variants: [{ sku: "opaque:lamb-launch.v1", variantId: "variant-lamb-400", netWeightGrams: 400 }],
  } as unknown as CatalogProduct;
  return {
    listProducts: async () => [product],
    getProductBySlug: async () => null,
    listAllergens: async () => [],
  };
}

function pricingResolver(): PricingResolverPort {
  return {
    resolvePrice: vi.fn(async (_query: ResolvePriceQuery) => price()),
  };
}

function price(): ResolvedPrice {
  return {
    variantId: "variant-lamb-400",
    mode: "one_time",
    matchedMinQty: 1,
    unitPriceMinor: 10_000,
    amountKind: "gross",
    priceListId: "list-default",
    priceEntryId: "price-one",
    resolvedAt: NOW.toISOString(),
  };
}

function promoDataPort(legacy: PromotionRow | readonly PromotionRow[]): CommercePromoDataPort {
  return {
    listActivePromotions: async () => Array.isArray(legacy) ? legacy : [legacy],
    countPaidOrders: async () => 0,
    countPaidOrdersByMode: async () => ({ oneTime: 0, subscription: 0 }),
    redemptionCounts: async () => new Map(),
    deviceFirstOrderRedeemed: async () => false,
  };
}

function legacyCoupon(
  code: string,
  discountValue: number,
  stackingRule: PromotionRow["stacking_rule"] = "exclusive",
  discountType: PromotionRow["discount_type"] = "percentage",
): PromotionRow {
  return {
    id: `legacy-${code}`,
    code,
    name: `Legacy ${code}`,
    trigger_type: "coupon_code",
    discount_type: discountType,
    discount_value: discountValue,
    applies_to_kind: "order_total",
    applies_to_payload: { cart_mode: "one_time" },
    stacking_rule: stackingRule,
    eligibility: {},
    valid_from: "2026-01-01T00:00:00.000Z",
    valid_to: null,
    status: "active",
    region_availability: ["GLOBAL"],
  };
}

function automaticV2(percent: number): PromotionRow {
  return {
    ...legacyCoupon("automatic", percent), id: `automatic-${percent}`, code: null, trigger_type: "automatic",
    promotion_engine_version: "promotion-engine.v2", benefit_lane: "product",
    benefit_kind: "target_percentage", benefit_value_bps: percent * 100,
  } as PromotionRow;
}

function v2Code(
  code: string,
  benefit: { kind: "target_percentage"; valueBps: number } | { kind: "fixed_amount"; valueMinor: number },
): ResolvedPromotionCodeCandidate {
  return {
    promotionId: "22222222-2222-4222-8222-222222222222",
    codeId: "11111111-1111-4111-8111-111111111111",
    code,
    codeRevision: 7,
    definitionFingerprint: "a".repeat(64),
    minimumReferenceMinor: 0,
    validTo: "2026-09-04T10:00:00.000Z",
    name: `V2 ${code}`,
    source: "code",
    scopes: ["one_time", "subscription_initial"],
    lane: "product",
    ...benefit,
  } as ResolvedPromotionCodeCandidate;
}

function promotionCodeQuotePort(
  candidates: ResolvedPromotionCodeCandidate | readonly ResolvedPromotionCodeCandidate[],
  codeRejections: CommerceCodeRejection[] = [],
  codeRejectionDetails: CommerceCodeRejectionDetail[] = [],
): PromotionCodeQuotePort {
  return {
    resolve: vi.fn(async () => ({ candidates: Array.isArray(candidates) ? candidates : [candidates], codeRejections, codeRejectionDetails })),
  };
}
