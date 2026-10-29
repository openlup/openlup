import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CatalogReadPort } from "../../../src/domains/catalog/ports.js";
import type { CatalogProduct } from "../../../src/domains/catalog/types.js";
import type { PricingResolverPort } from "../../../src/domains/pricing/ports.js";
import { readSettlementProfile } from "../../../src/lib/currency/platformCurrency.js";
import { createDbBackedCommerceQuotePort } from "./dbBackedCommerceQuotePort.js";

const product = {
  id: "product-example", slug: "example", segment: "example",
  primarySku: { sku: "opaque:example", productSlug: "example", variantId: "variant-example", netWeightGrams: 1 },
  variants: [{ sku: "opaque:example", productSlug: "example", variantId: "variant-example", netWeightGrams: 1 }],
} as unknown as CatalogProduct;
const catalogReadPort: CatalogReadPort = {
  async listProducts() { return [product]; },
  async getProductBySlug(slug) { return slug === product.slug ? product : null; },
  async listAllergens() { return []; },
};
const request = { mode: "one_time" as const, lines: [{ sku: "opaque:example", quantity: 1 }], promoCodes: [] };

function resolverFor(currency: string): PricingResolverPort {
  return { resolvePrice: vi.fn(async (query) => query.currency === currency ? {
    variantId: query.variantId, matchedMinQty: 1, unitPriceMinor: 1490,
    mode: "one_time" as const, amountKind: "gross" as const,
    priceListId: "list-example", priceEntryId: "entry-example", resolvedAt: "2026-08-16T10:00:00.000Z",
  } : null) };
}

function currencies(value: unknown): string[] {
  const found = new Set<string>();
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(visit);
    for (const [key, entry] of Object.entries(node)) {
      if (key === "currency" && typeof entry === "string") found.add(entry);
      visit(entry);
    }
  };
  visit(value);
  return [...found];
}

describe("reference quote currency", () => {
  it.each([{}, { COMMERCE_SETTLEMENT_CURRENCY: "EUR" }, { COMMERCE_SETTLEMENT_CURRENCY: "CZK" }])(
    "uses the configured settlement throughout the DB quote (%o)", async (configuration) => {
      const profile = readSettlementProfile(configuration);
      const port = createDbBackedCommerceQuotePort({ catalogReadPort, pricingResolverPort: resolverFor(profile.defaultCurrency), settlementProfile: profile });
      const result = await port.createQuote(request);
      expect(currencies(result)).toEqual([profile.defaultCurrency]);
      expect(result.quote.lines[0]?.unitPriceGross.amountMinor).toBe(1490);
    },
  );

  it("refuses a price list in another currency and requests the settlement currency", async () => {
    const profile = readSettlementProfile({ COMMERCE_SETTLEMENT_CURRENCY: "EUR" });
    const resolver = resolverFor(readSettlementProfile({}).defaultCurrency);
    const port = createDbBackedCommerceQuotePort({ catalogReadPort, pricingResolverPort: resolver, settlementProfile: profile });
    await expect(port.createQuote(request)).rejects.toMatchObject({ code: "PRICE_NOT_CONFIGURED" });
    expect(resolver.resolvePrice).toHaveBeenCalledWith(expect.objectContaining({ currency: profile.defaultCurrency, regionCode: profile.regionCode }));
  });

  it("prices normally when the price list agrees", async () => {
    const profile = readSettlementProfile({ COMMERCE_SETTLEMENT_CURRENCY: "EUR" });
    const port = createDbBackedCommerceQuotePort({ catalogReadPort, pricingResolverPort: resolverFor(profile.defaultCurrency), settlementProfile: profile });
    expect((await port.createQuote(request)).quote.totalGross.currency).toBe(profile.defaultCurrency);
  });

  it("names no quote-factory currency default outside its configured owner", () => {
    const root = resolve(import.meta.dirname, "../../..");
    const paths = ["server/domains/commerce/dbBackedCommerceQuotePort.ts", "server/domains/commerce/commerceQuoteCatalogReadPort.ts", "server/domains/commerce/quoteAutomaticPromotions.ts", "server/domains/commerce/quotePromotionCodeAdjustments.ts"];
    for (const path of paths) {
      expect(readFileSync(resolve(root, path), "utf8")).not.toMatch(/currency\s*(?:\?\s*:|:|=)\s*"[A-Za-z]{3}"/i);
    }
  });
});

describe("current promotion floor observation", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

  it("quote imports evaluate preview once and share its first floor", async () => {
    vi.resetModules();
    vi.stubEnv("COMMERCE_MIN_PRODUCT_PAYABLE_MINOR", "7");
    const preview = await import("./promotionCodePreview.js");
    vi.stubEnv("COMMERCE_MIN_PRODUCT_PAYABLE_MINOR", "19");
    await import("./quotePromotionV2.js");
    await import("./quotePromotionCodeAdjustments.js");
    await import("./dbBackedCommerceQuotePort.js");
    expect(preview.MINIMUM_PRODUCT_PAYABLE_MINOR).toBe(7);
  });

  it.each(["./promotionCodePreview.js", "./quotePromotionV2.js", "./quotePromotionCodeAdjustments.js", "./dbBackedCommerceQuotePort.js"])(
    "%s refuses a malformed floor during import", async (entry) => {
      vi.resetModules();
      vi.stubEnv("COMMERCE_MIN_PRODUCT_PAYABLE_MINOR", "invalid");
      await expect(import(entry)).rejects.toMatchObject({ name: "InvalidMinimumProductPayableError", configuredValue: "invalid" });
    },
  );

  it("later settlement selection leaves the imported promotion floor intact", async () => {
    vi.resetModules();
    vi.stubEnv("COMMERCE_MIN_PRODUCT_PAYABLE_MINOR", "7");
    const preview = await import("./promotionCodePreview.js");
    vi.stubEnv("COMMERCE_MIN_PRODUCT_PAYABLE_MINOR", "19");
    vi.stubEnv("COMMERCE_SETTLEMENT_CURRENCY", "EUR");
    const quote = await import("./dbBackedCommerceQuotePort.js");
    const port = quote.createDbBackedCommerceQuotePort({ catalogReadPort, pricingResolverPort: resolverFor("EUR") });
    expect((await port.createQuote(request)).quote.currency).toBe("EUR");
    expect(preview.MINIMUM_PRODUCT_PAYABLE_MINOR).toBe(7);
  });
});
