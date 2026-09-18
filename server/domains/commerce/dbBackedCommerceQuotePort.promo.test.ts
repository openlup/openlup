import { describe, expect, it, vi } from "vitest";
import type { CatalogProduct } from "../../../src/domains/catalog/types.js";
import type { CatalogReadPort } from "../../../src/domains/catalog/ports.js";
import { createQuoteResponseSchema } from "../../../src/domains/commerce/contracts.js";
import type { PricingResolverPort } from "../../../src/domains/pricing/ports.js";
import type { ResolvedPrice, ResolvePriceQuery } from "../../../src/domains/pricing/types.js";
import type { PromotionRow } from "../../../src/domains/promo/types.js";
import { createDbBackedCommerceQuotePort } from "./dbBackedCommerceQuotePort.js";
import type { CommercePromoDataPort } from "./promoDataPort.js";
import type {
  PromotionCodeQuotePort,
  PromotionCodeQuoteResolution,
} from "./promotionCodeQuotePort.js";

// A subscription cart of 2 cans @ 1340 gross = 2680 subtotal; -50% => 1340.
describe("db backed commerce quote port — promo evaluation", () => {
  it("applies an automatic first-purchase order-total discount for a new client", async () => {
    const port = portWithPromos(promoPort([firstSubPromo()], 0));

    const response = await subscriptionQuote(port, { clientId: "client-new" });

    expect(createQuoteResponseSchema.parse(response)).toEqual(response);
    expect(response.quote.discounts).toEqual([
      { promotionId: "promo-firstsub", label: "First Subscription", appliesTo: "order_total", amountOffMinor: 1340, reasonCode: "promo:first_subscription" },
    ]);
    expect(response.quote.subtotalGross.amountMinor).toBe(2680);
    expect(response.quote.discountTotalGross.amountMinor).toBe(1340);
    expect(response.quote.totalGross.amountMinor).toBe(1340);
    expect(response.quote.netTotal.amountMinor + response.quote.taxTotal.amountMinor).toBe(1340);
  });

  it("excludes a first-purchase promo for a returning (already-paid) client", async () => {
    const data = promoPort([firstSubPromo()], 2);

    const response = await subscriptionQuote(portWithPromos(data), { clientId: "client-returning" });

    expect(response.quote.discounts).toEqual([]);
    expect(response.quote.totalGross.amountMinor).toBe(2680);
    expect(data.countPaidOrdersByMode).toHaveBeenCalledWith("client-returning");
  });

  it("never resolves the paid-order count for an anonymous preview", async () => {
    const data = promoPort([], 0);

    const response = await subscriptionQuote(portWithPromos(data), {});

    expect(response.quote.discounts).toEqual([]);
    expect(data.countPaidOrdersByMode).not.toHaveBeenCalled();
  });

  it("applies a coupon-code order-total discount when the code is supplied", async () => {
    const response = await subscriptionQuote(portWithPromos(promoPort([welcomeCoupon()], 0)), {
      clientId: "client-c",
      promoCodes: ["WELCOME10"],
    });

    expect(createQuoteResponseSchema.parse(response)).toEqual(response);
    expect(response.quote.discounts).toEqual([
      { promotionId: "promo-welcome10", code: "WELCOME10", label: "Welcome 10", appliesTo: "order_total", amountOffMinor: 268, reasonCode: "promo:WELCOME10" },
    ]);
    expect(response.quote.totalGross.amountMinor).toBe(2412);
  });

  it("drops a coupon that has reached its per-customer redemption cap", async () => {
    const capped = welcomeCoupon();
    capped.redemption_limit_per_customer = 1;
    const counts = new Map([["promo-welcome10", { global: 3, perCustomer: 1 }]]);

    const response = await subscriptionQuote(
      portWithPromos(promoPort([capped], 0, counts)),
      { clientId: "client-capped", promoCodes: ["WELCOME10"] },
    );

    expect(response.quote.discounts).toEqual([]);
    expect(response.quote.totalGross.amountMinor).toBe(2680);
  });

  it("still applies a per-customer-capped coupon for a DIFFERENT client under the cap", async () => {
    const capped = welcomeCoupon();
    capped.redemption_limit_per_customer = 1;
    // global usage exists but this client's perCustomer is 0 -> still eligible.
    const counts = new Map([["promo-welcome10", { global: 5, perCustomer: 0 }]]);

    const response = await subscriptionQuote(
      portWithPromos(promoPort([capped], 0, counts)),
      { clientId: "client-fresh", promoCodes: ["WELCOME10"] },
    );

    expect(response.quote.discounts).toHaveLength(1);
    expect(response.quote.totalGross.amountMinor).toBe(2412);
  });

  it("drops a promo that has reached its global redemption cap", async () => {
    const capped = welcomeCoupon();
    capped.redemption_limit_global = 100;
    const counts = new Map([["promo-welcome10", { global: 100, perCustomer: 0 }]]);

    const response = await subscriptionQuote(
      portWithPromos(promoPort([capped], 0, counts)),
      { clientId: "client-x", promoCodes: ["WELCOME10"] },
    );

    expect(response.quote.discounts).toEqual([]);
  });

  it("clamps stacked discounts to the subtotal so the quote invariants hold", async () => {
    const response = await subscriptionQuote(
      portWithPromos(promoPort([stackPromo("a", 70), stackPromo("b", 50)], 0)),
      { clientId: "client-d" },
    );

    expect(createQuoteResponseSchema.parse(response)).toEqual(response);
    const discountSum = response.quote.discounts.reduce((s, d) => s + d.amountOffMinor, 0);
    expect(discountSum).toBe(2680);
    expect(response.quote.discountTotalGross.amountMinor).toBe(2680);
    expect(response.quote.totalGross.amountMinor).toBe(0);
  });

  it("emits no discounts (byte-identical) when no promo data port is wired", async () => {
    const port = createDbBackedCommerceQuotePort({
      catalogReadPort: catalogReadPort(),
      pricingResolverPort: pricingResolver(),
      now: () => "2026-06-05T10:00:00.000Z",
    });

    const response = await subscriptionQuote(port, { clientId: "client-x" });

    expect(response.quote.discounts).toEqual([]);
    expect(response.quote.totalGross.amountMinor).toBe(2680);
  });

  it("charges flat shipping when no free-shipping promo applies", async () => {
    const response = await subscriptionQuote(
      portWithPromosAndShipping(promoPort([], 0), 1500),
      { clientId: "client-ship" },
    );

    expect(createQuoteResponseSchema.parse(response)).toEqual(response);
    expect(response.quote.shippingGross?.amountMinor).toBe(1500);
    expect(response.quote.shippingDiscountGross?.amountMinor).toBe(0);
    // 2680 subtotal + 1500 shipping, no discount.
    expect(response.quote.totalGross.amountMinor).toBe(4180);
    expect(response.quote.netTotal.amountMinor + response.quote.taxTotal.amountMinor).toBe(4180);
  });

  it("free shipping survives an exclusive order-total promo (separate lane)", async () => {
    const response = await subscriptionQuote(
      portWithPromosAndShipping(promoPort([firstSubPromo(), subFreeShipPromo()], 0), 1500),
      { clientId: "client-new" },
    );

    expect(createQuoteResponseSchema.parse(response)).toEqual(response);
    // -50% order total AND free shipping both apply despite First Subscription being exclusive.
    const shipping = response.quote.discounts.find((d) => d.appliesTo === "shipping");
    const order = response.quote.discounts.find((d) => d.appliesTo === "order_total");
    expect(order?.amountOffMinor).toBe(1340);
    expect(shipping?.amountOffMinor).toBe(1500);
    expect(response.quote.shippingGross?.amountMinor).toBe(1500);
    expect(response.quote.shippingDiscountGross?.amountMinor).toBe(1500);
    // 2680 - 1340 (50%) + 1500 shipping - 1500 free shipping = 1340.
    expect(response.quote.totalGross.amountMinor).toBe(1340);
    expect(response.quote.discountTotalGross.amountMinor).toBe(1340);
  });

  it.each([
    { mode: "one_time" as const, promotions: [] },
    { mode: "subscription" as const, promotions: [firstSubPromo()] },
  ])("makes SAVE80 exactly target-effective from the one-time reference for $mode", async ({ mode, promotions }) => {
    const port = createDbBackedCommerceQuotePort({
      catalogReadPort: catalogReadPort(),
      pricingResolverPort: pricingResolver(),
      promoDataPort: promoPort(promotions, 0),
      promotionCodeQuotePort: save80Port(),
      now: () => "2026-06-05T10:00:00.000Z",
    });

    const response = await port.createQuote({
      mode,
      lines: [{ sku: "opaque:lamb-launch.v1", quantity: 2, modeAtLine: mode }],
      ...(mode === "subscription" ? { cadenceDays: 21 } : {}),
      promoCodes: ["SAVE80"],
    }, { clientId: "client-save80" });

    expect(createQuoteResponseSchema.parse(response)).toEqual(response);
    expect(response.quote.totalGross.amountMinor).toBe(596);
    expect(response.quote.codeRejections).toBeUndefined();
    expect(response.quote.discounts).toContainEqual(expect.objectContaining({
      code: "SAVE80",
      amountOffMinor: mode === "subscription" ? 744 : 2_384,
      promotionEngineVersion: "promotion-engine.v2",
      promotionCodeRevision: 7,
    }));
  });
});

function portWithPromos(promoDataPort: ReturnType<typeof promoPort>) {
  return createDbBackedCommerceQuotePort({
    catalogReadPort: catalogReadPort(),
    pricingResolverPort: pricingResolver(),
    promoDataPort,
    now: () => "2026-06-05T10:00:00.000Z",
  });
}

function portWithPromosAndShipping(
  promoDataPort: ReturnType<typeof promoPort>,
  shippingFlatMinor: number,
) {
  return createDbBackedCommerceQuotePort({
    catalogReadPort: catalogReadPort(),
    pricingResolverPort: pricingResolver(),
    promoDataPort,
    commerceSettingsPort: { getShippingFlatMinor: async () => shippingFlatMinor },
    now: () => "2026-06-05T10:00:00.000Z",
  });
}

function subFreeShipPromo(): PromotionRow {
  return basePromo({
    id: "promo-subship",
    name: "Subscription Free Shipping",
    discount_type: "free_shipping",
    discount_value: 100,
    stacking_rule: "stackable_with_any",
    applies_to_payload: { cart_mode: "subscription" },
  });
}

function subscriptionQuote(
  port: ReturnType<typeof createDbBackedCommerceQuotePort>,
  opts: { clientId?: string; promoCodes?: string[] },
) {
  return port.createQuote(
    {
      mode: "subscription",
      lines: [{ sku: "opaque:lamb-launch.v1", quantity: 2, modeAtLine: "subscription" }],
      cadenceDays: 21,
      promoCodes: opts.promoCodes ?? [],
    },
    opts.clientId ? { clientId: opts.clientId } : undefined,
  );
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
    resolvePrice: vi.fn(async (query: ResolvePriceQuery) =>
      query.mode === "subscription"
        ? price({ mode: "subscription", unitPriceMinor: 1340, priceEntryId: "price-sub" })
        : price({ mode: "one_time", unitPriceMinor: 1490, priceEntryId: "price-one" }),
    ),
  };
}

function price(overrides: Partial<ResolvedPrice>): ResolvedPrice {
  return {
    variantId: "variant-lamb-400",
    mode: "one_time",
    matchedMinQty: 1,
    unitPriceMinor: 1490,
    amountKind: "gross",
    priceListId: "list-pl",
    priceEntryId: "price-one",
    resolvedAt: "2026-06-05T10:00:00.000Z",
    ...overrides,
  };
}

function promoPort(
  promotions: PromotionRow[],
  paidCount: number,
  redemptions: Map<string, { global: number; perCustomer: number }> = new Map(),
  deviceRedeemed = false,
): CommercePromoDataPort & {
  countPaidOrders: ReturnType<typeof vi.fn>;
  countPaidOrdersByMode: ReturnType<typeof vi.fn>;
  deviceFirstOrderRedeemed: ReturnType<typeof vi.fn>;
} {
  return {
    listActivePromotions: vi.fn(async () => promotions),
    countPaidOrders: vi.fn(async () => paidCount),
    countPaidOrdersByMode: vi.fn(async () => ({ oneTime: paidCount, subscription: 0 })),
    redemptionCounts: vi.fn(async () => redemptions),
    deviceFirstOrderRedeemed: vi.fn(async () => deviceRedeemed),
  };
}

function save80Port(): PromotionCodeQuotePort {
  return {
    resolve: vi.fn(async (): Promise<PromotionCodeQuoteResolution> => ({
      candidates: [{
        promotionId: "22222222-2222-4222-8222-222222222222",
        codeId: "11111111-1111-4111-8111-111111111111",
        code: "SAVE80",
        codeRevision: 7,
        definitionFingerprint: "a".repeat(64),
        minimumReferenceMinor: 0,
        validTo: "2026-07-17T00:00:00.000Z",
        name: "Target 80",
        source: "code",
        scopes: ["one_time", "subscription_initial"],
        lane: "product",
        kind: "target_percentage",
        valueBps: 8_000,
      }],
      codeRejections: [],
      codeRejectionDetails: [],
    })),
  };
}

function basePromo(overrides: Partial<PromotionRow>): PromotionRow {
  return {
    id: "promo",
    code: null,
    name: "Promo",
    trigger_type: "automatic",
    discount_type: "percentage",
    discount_value: 10,
    applies_to_kind: "order_total",
    applies_to_payload: {},
    stacking_rule: "stackable_with_any",
    eligibility: {},
    valid_from: "2020-01-01T00:00:00.000Z",
    valid_to: null,
    status: "active",
    region_availability: ["PL"],
    ...overrides,
  };
}

function firstSubPromo(): PromotionRow {
  return basePromo({
    id: "promo-firstsub",
    name: "First Subscription",
    discount_value: 50,
    stacking_rule: "exclusive",
    eligibility: { first_purchase: true },
    applies_to_payload: { cart_mode: "subscription" },
  });
}

function welcomeCoupon(): PromotionRow {
  return basePromo({ id: "promo-welcome10", code: "WELCOME10", name: "Welcome 10", trigger_type: "coupon_code", discount_value: 10 });
}

function stackPromo(suffix: string, value: number): PromotionRow {
  return basePromo({ id: `promo-stack-${suffix}`, name: `Stack ${suffix}`, discount_value: value });
}
