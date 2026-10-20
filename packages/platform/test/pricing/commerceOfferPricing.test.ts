import "./neutralFixtures.js";
import { describe, expect, it, vi } from "vitest";

import type { CreateQuoteRequest } from "./quoteSchemaFixtures.js";
import {
  CommerceQuoteError,
  type CommerceQuotePort,
} from "./quoteSchemaFixtures.js";
import { COMMERCE_MIN_AUTO_ORDER_UNITS } from "./offerFixtures.js";
import { projectCommerceOfferPricing } from "./offerFixtures.js";

const product = {
  skuCode: "opaque:item-alpha.v1",
  variantId: "variant-item-alpha",
  productSlug: "item-alpha",
  segment: "segment_a",
  isPrimarySku: true,
  isAddon: false,
  sellability: { oneTime: true, subscription: true },
} as const;

function quotePort(input: {
  oneTimeSubtotal: number;
  subscriptionSubtotal: number;
  subscriptionDiscount: number;
  calls: CreateQuoteRequest[];
}): CommerceQuotePort {
  return {
    async createQuote(request) {
      input.calls.push(request);
      const subscription = request.mode === "subscription";
      const subtotal = subscription
        ? input.subscriptionSubtotal
        : input.oneTimeSubtotal;
      const discount = subscription ? input.subscriptionDiscount : 0;
      return {
        contractVersion: "commerce.v0",
        quote: {
          currency: "XXX",
          subtotalGross: { amountMinor: subtotal, currency: "XXX" },
          discountTotalGross: { amountMinor: discount, currency: "XXX" },
          // Deliberately includes a fake delivery residual. The product-only
          // projection must ignore totalGross and use subtotal-discount.
          totalGross: { amountMinor: subtotal - discount + 1490, currency: "XXX" },
          lines: [
            {
              unitPriceGross: {
                amountMinor: subscription ? 1340 : 1490,
                currency: "XXX",
              },
            },
          ],
        },
      } as never;
    },
  };
}

describe("projectCommerceOfferPricing", () => {
  it("keeps initial promo separate from recurring band and excludes shipping", async () => {
    const promotedCalls: CreateQuoteRequest[] = [];
    const recurringCalls: CreateQuoteRequest[] = [];
    const response = await projectCommerceOfferPricing({
      quoteCatalogReadPort: { listQuoteCatalogItems: vi.fn().mockResolvedValue([product]) },
      quoteWithPromotions: quotePort({
        oneTimeSubtotal: 20_860,
        subscriptionSubtotal: 18_760,
        subscriptionDiscount: 8_330,
        calls: promotedCalls,
      }),
      quoteWithoutPromotions: quotePort({
        oneTimeSubtotal: 20_860,
        subscriptionSubtotal: 18_760,
        subscriptionDiscount: 0,
        calls: recurringCalls,
      }),
    });

    expect(response.scope).toBe("example_products_only_excludes_shipping");
    expect(response.products[0]).toMatchObject({
      unitCount: COMMERCE_MIN_AUTO_ORDER_UNITS,
      subscriptionInitial: {
        packageGross: { amountMinor: 10_430 },
        unitGross: { amountMinor: 745 },
      },
      subscriptionRecurring: {
        packageGross: { amountMinor: 18_760 },
        unitGross: { amountMinor: 1340 },
      },
      initialDiscountPercent: 50,
      recurringDiscountPercent: 10,
    });
    expect(response.products[0].oneTime.packageGross.amountMinor).toBe(20_860);
    expect(response).not.toHaveProperty("checkoutQuoteExpectation");
    expect(
      [...promotedCalls, ...recurringCalls].every(
        (request: CreateQuoteRequest) =>
        request.lines[0]?.quantity === COMMERCE_MIN_AUTO_ORDER_UNITS &&
        !("expectedQuote" in request),
      ),
    ).toBe(true);
    expect(promotedCalls.find((request) => request.mode === "subscription"))
      .toMatchObject({ cadenceDays: 14 });
  });

  it("keeps included-cohort minima isolated from excluded-cohort products and add-ons", async () => {
    const promotedCalls: CreateQuoteRequest[] = [];
    const recurringCalls: CreateQuoteRequest[] = [];
    const excluded = {
      ...product,
      productSlug: "item-beta",
      segment: "segment_b",
      skuCode: "opaque:item-beta.v1",
      variantId: "variant-item-beta",
    } as const;
    const addon = {
      ...product,
      productSlug: "item-addon",
      skuCode: "opaque:item-addon.v1",
      variantId: "variant-item-addon",
      isAddon: true,
    } as const;

    const response = await projectCommerceOfferPricing({
      quoteCatalogReadPort: { listQuoteCatalogItems: vi.fn().mockResolvedValue([excluded, addon, product]) },
      quoteWithPromotions: quotePort({
        oneTimeSubtotal: 20_860,
        subscriptionSubtotal: 18_760,
        subscriptionDiscount: 8_330,
        calls: promotedCalls,
      }),
      quoteWithoutPromotions: quotePort({
        oneTimeSubtotal: 20_860,
        subscriptionSubtotal: 18_760,
        subscriptionDiscount: 0,
        calls: recurringCalls,
      }),
    });

    expect(response.products.map((entry) => entry.productSlug)).toEqual(["item-alpha"]);
    expect(response.minimum.oneTime.productSlug).toBe("item-alpha");
    expect(response.minimum.subscription.productSlug).toBe("item-alpha");
    expect(promotedCalls).toHaveLength(2);
    expect(recurringCalls).toHaveLength(1);
  });
  it("excludes only the product the money authority cannot price and keeps the rest", async () => {
    // ⛔ REGRESSION PIN. `Promise.all` over the products meant one refusing SKU
    // rejected the array and the handler answered 503 for EVERY PDP price block.
    const cheap = { ...product, productSlug: "cheap", skuCode: "opaque:cheap.v1", variantId: "variant-cheap" } as const;
    const refusing = (slug: string): CommerceQuotePort => ({
      async createQuote(request) {
        if (request.lines[0]!.sku === "opaque:cheap.v1") {
          throw new CommerceQuoteError("PRICE_NOT_CONFIGURED", "no anchor", { reason: "base_price_not_found" });
        }
        return healthy[slug]!.createQuote(request);
      },
    });
    const promotedCalls: CreateQuoteRequest[] = [];
    const recurringCalls: CreateQuoteRequest[] = [];
    const healthy: Record<string, CommerceQuotePort> = {
      promoted: quotePort({ oneTimeSubtotal: 20_860, subscriptionSubtotal: 18_760, subscriptionDiscount: 8_330, calls: promotedCalls }),
      recurring: quotePort({ oneTimeSubtotal: 20_860, subscriptionSubtotal: 18_760, subscriptionDiscount: 0, calls: recurringCalls }),
    };
    const info = vi.spyOn(console, "info").mockImplementation(() => {});

    try {
      const response = await projectCommerceOfferPricing({
        quoteCatalogReadPort: { listQuoteCatalogItems: vi.fn().mockResolvedValue([cheap, product]) },
        quoteWithPromotions: refusing("promoted"),
        quoteWithoutPromotions: refusing("recurring"),
      });

      expect(response.products.map((entry) => entry.productSlug)).toEqual(["item-alpha"]);
      expect(response.minimum.oneTime.productSlug).toBe("item-alpha");
      // A silent exclusion would move the customer-facing "from" figure invisibly.
      expect(info.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([{
        event: "commerce_offer_pricing_product_excluded",
        product_slug: "cheap",
        refusal_code: "base_price_not_found",
      }]);
    } finally {
      info.mockRestore();
    }
  });

  it("takes the v2 representative quote from a product that priced, not the catalogue head", async () => {
    // ⛔ The subtle half of the fix. The v2 branch quotes ONE representative
    // product for shipping. It used to use `products[0]` - which, once the head
    // product is the excluded one, re-raises the very refusal just degraded and
    // refuses the whole response: the batch failure this wave removes, restored.
    const cheap = { ...product, productSlug: "cheap", skuCode: "opaque:cheap.v1", variantId: "variant-cheap" } as const;
    const promotedCalls: CreateQuoteRequest[] = [];
    const recurringCalls: CreateQuoteRequest[] = [];
    const healthy: Record<string, CommerceQuotePort> = {
      promoted: quotePort({ oneTimeSubtotal: 20_860, subscriptionSubtotal: 18_760, subscriptionDiscount: 8_330, calls: promotedCalls }),
      recurring: quotePort({ oneTimeSubtotal: 20_860, subscriptionSubtotal: 18_760, subscriptionDiscount: 0, calls: recurringCalls }),
    };
    const refusing = (slug: string): CommerceQuotePort => ({
      async createQuote(request) {
        if (request.lines[0]!.sku === "opaque:cheap.v1") {
          throw new CommerceQuoteError("PRICE_NOT_CONFIGURED", "no anchor", { reason: "base_price_not_found" });
        }
        return healthy[slug]!.createQuote(request);
      },
    });
    const info = vi.spyOn(console, "info").mockImplementation(() => {});

    try {
      // `cheap` is FIRST in the catalogue and is the one that cannot price.
      const response = await projectCommerceOfferPricing({
        quoteCatalogReadPort: { listQuoteCatalogItems: vi.fn().mockResolvedValue([cheap, product]) },
        quoteWithPromotions: refusing("promoted"),
        quoteWithoutPromotions: refusing("recurring"),
        pricingPolicy: {
          offerPolicyVersion: "commerce.offer-policy.v2",
          promotionEngineVersion: "promotion-engine.v2",
        },
      });

      expect(response.products.map((entry) => entry.productSlug)).toEqual(["item-alpha"]);
      // Every representative call went to the surviving product, never to `cheap`.
      expect(promotedCalls.every((call) => call.lines[0]!.sku === "opaque:item-alpha.v1")).toBe(true);
    } finally {
      info.mockRestore();
    }
  });

  it("refuses the projection when every product refuses, rather than inventing a floor", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const allRefuse: CommerceQuotePort = {
      async createQuote() {
        throw new CommerceQuoteError("PRICE_NOT_CONFIGURED", "no anchor", { reason: "base_price_ambiguous" });
      },
    };

    try {
      await expect(projectCommerceOfferPricing({
        quoteCatalogReadPort: { listQuoteCatalogItems: vi.fn().mockResolvedValue([product]) },
        quoteWithPromotions: allRefuse,
        quoteWithoutPromotions: allRefuse,
      })).rejects.toThrow("commerce_offer_pricing_unavailable");
    } finally {
      info.mockRestore();
    }
  });

  it("still refuses the whole projection for a non-pricing failure", async () => {
    // Only PRICE_NOT_CONFIGURED degrades. An infrastructure fault or a violated
    // pricing invariant must not be silently dropped as one unlucky product.
    for (const failure of [
      new CommerceQuoteError("PRICING_INVARIANT_VIOLATION", "bad anchor"),
      new Error("connection reset"),
    ]) {
      const failing: CommerceQuotePort = { async createQuote() { throw failure; } };

      await expect(projectCommerceOfferPricing({
        quoteCatalogReadPort: { listQuoteCatalogItems: vi.fn().mockResolvedValue([product]) },
        quoteWithPromotions: failing,
        quoteWithoutPromotions: failing,
      })).rejects.toBe(failure);
    }
  });
});
