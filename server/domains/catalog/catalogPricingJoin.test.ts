import { describe, expect, it } from "vitest";
import type { CatalogProduct, CatalogSku } from "../../../src/domains/catalog/types.js";
import type { PricingResolverPort } from "../../../src/domains/pricing/ports.js";
import type { ResolvePriceQuery } from "../../../src/domains/pricing/types.js";
import {
  DEFAULT_CATALOG_PRICING_REGION,
  joinCatalogListPricing,
  joinCatalogPricing,
  type CatalogExactOneTimeBasePriceReadPort,
} from "./catalogPricingJoin.js";

function sku(overrides: Partial<CatalogSku> = {}): CatalogSku {
  return {
    sku: "SKU-LAMB-400G",
    productSlug: "lamb",
    variantId: "var-1",
    publicationStatus: "published",
    unit: "can",
    netWeightGrams: 400,
    isAddon: false,
    pricing: {
      status: "not_configured",
      listPrice: null,
      taxCategory: "pet_food",
      externalRefs: { paymentProviderPriceId: null, inventoryProviderSku: null },
    },
    ...overrides,
  };
}

function product(variants: CatalogSku[]): CatalogProduct {
  return {
    id: "prod-1",
    slug: "lamb",
    displayName: "Lamb",
    lineName: "Health & Longevity Diet",
    species: "dog",
    publicationStatus: "published",
    route: { pl: "/produkty/lamb", en: "/products/lamb" },
    primarySku: variants[0],
    variants,
    composition: {
      rawIngredients: "",
      rawIngredientsEn: null,
      items: [],
      allergenSlugs: [],
      kcalPer100g: null,
    },
    metadata: { format: "", kcalPer100g: null, legacyStatus: null },
  };
}

function resolverReturning(byVariant: Record<string, number>): {
  port: PricingResolverPort;
  queries: ResolvePriceQuery[];
} {
  const queries: ResolvePriceQuery[] = [];
  return {
    queries,
    port: {
      async resolvePrice(query) {
        queries.push(query);
        const minor = byVariant[query.variantId];
        if (minor === undefined) return null;
        return {
          variantId: query.variantId,
          mode: "one_time",
          matchedMinQty: 1,
          unitPriceMinor: minor,
          amountKind: "gross",
          priceListId: "pl-1",
          priceEntryId: `pe-${query.variantId}`,
          resolvedAt: "2026-01-01T00:00:00.000Z",
        };
      },
    },
  };
}

describe("joinCatalogPricing", () => {
  it("overlays a configured list price resolved at the one-time base tier", async () => {
    const variant = sku({ variantId: "var-1" });
    const { port, queries } = resolverReturning({ "var-1": 2490 });

    const [joined] = await joinCatalogPricing([product([variant])], port);

    expect(joined.variants[0].pricing.status).toBe("configured");
    expect(joined.variants[0].pricing.listPrice).toEqual({ amountMinor: 2490, currency: "PLN" });
    // List price = single unit of the base tier in the catalog region.
    expect(queries[0]).toMatchObject({
      variantId: "var-1",
      mode: "one_time",
      lineQty: 1,
      eligibleCartQty: 1,
      regionCode: "PL",
      currency: "PLN",
    });
  });

  it("re-points primarySku at the re-priced variant instance", async () => {
    const variant = sku({ variantId: "var-1" });
    const { port } = resolverReturning({ "var-1": 3100 });

    const [joined] = await joinCatalogPricing([product([variant])], port);

    expect(joined.primarySku).toBe(joined.variants[0]);
    expect(joined.primarySku.pricing.listPrice?.amountMinor).toBe(3100);
  });

  it("leaves a variant not_configured when no entry matches", async () => {
    const priced = sku({ variantId: "var-1" });
    const unpriced = sku({ variantId: "var-2", sku: "SKU-LAMB-800G" });
    const { port } = resolverReturning({ "var-1": 2490 });

    const [joined] = await joinCatalogPricing([product([priced, unpriced])], port);

    expect(joined.variants[0].pricing.status).toBe("configured");
    expect(joined.variants[1].pricing.status).toBe("not_configured");
    expect(joined.variants[1].pricing.listPrice).toBeNull();
  });

  it("skips placeholder SKUs that have no variant id (no resolver call)", async () => {
    const placeholder = sku({ variantId: "" });
    const { port, queries } = resolverReturning({});

    const [joined] = await joinCatalogPricing([product([placeholder])], port);

    expect(queries).toHaveLength(0);
    expect(joined.variants[0].pricing.status).toBe("not_configured");
  });

  it("honours a custom region/currency", async () => {
    const variant = sku({ variantId: "var-1" });
    const { port, queries } = resolverReturning({ "var-1": 999 });

    await joinCatalogPricing([product([variant])], port, {
      regionCode: "PL",
      currency: "PLN",
    });

    expect(queries[0].regionCode).toBe("PL");
    expect(DEFAULT_CATALOG_PRICING_REGION).toEqual({ regionCode: "PL", currency: "PLN" });
  });

  it("keeps legacy callers on one resolver read per non-placeholder SKU", async () => {
    const { port, queries } = resolverReturning({ "var-1": 2490, "var-2": 1990 });
    let batchCalls = 0;
    const resolverWithBatch: PricingResolverPort & CatalogExactOneTimeBasePriceReadPort = {
      ...port,
      async listExactOneTimeBasePrices() {
        batchCalls += 1;
        return new Map();
      },
    };

    await joinCatalogPricing([
      product([sku({ variantId: "var-1" }), sku({ variantId: "var-2" })]),
    ], resolverWithBatch);

    expect(batchCalls).toBe(0);
    expect(queries.map((query) => query.variantId)).toEqual(["var-1", "var-2"]);
    expect(queries.every((query) => query.atTime === undefined)).toBe(true);
  });

  it("uses one pinned-time batch read for every SKU rather than resolving N prices", async () => {
    const calls: Parameters<CatalogExactOneTimeBasePriceReadPort["listExactOneTimeBasePrices"]>[0][] = [];
    const reader: CatalogExactOneTimeBasePriceReadPort = {
      async listExactOneTimeBasePrices(query) {
        calls.push(query);
        return new Map([["var-1", {
          variantId: "var-1", mode: "one_time", matchedMinQty: 1, unitPriceMinor: 2490,
          amountKind: "gross", priceListId: "pl-1", priceEntryId: "pe-1", resolvedAt: query.atTime,
        }]]);
      },
    };

    const [joined] = await joinCatalogListPricing([product([sku({ variantId: "var-1" }), sku({ variantId: "var-2" })])], reader, undefined, "2026-08-12T00:00:00.000Z");

    expect(calls).toEqual([{
      variantIds: ["var-1", "var-2"], ...DEFAULT_CATALOG_PRICING_REGION, atTime: "2026-08-12T00:00:00.000Z",
    }]);
    expect(joined.variants.map((variant) => variant.pricing.status)).toEqual(["configured", "not_configured"]);
  });

  it("leaves a degraded SKU unpriced rather than quoting it at zero", async () => {
    // ⛔ The load-bearing assumption of the degrade: a variant the batch reader
    // omitted must render as `not_configured` with a NULL list price. If anything
    // here coerced the absence to 0, degrading would turn a 503 into a storefront
    // selling at zero - far worse than the outage it replaces.
    const reader: CatalogExactOneTimeBasePriceReadPort = {
      async listExactOneTimeBasePrices(query) {
        return new Map([["var-2", {
          variantId: "var-2", mode: "one_time", matchedMinQty: 1, unitPriceMinor: 2490,
          amountKind: "gross", priceListId: "pl-1", priceEntryId: "pe-1", resolvedAt: query.atTime,
        }]]);
      },
    };
    // The DEGRADED variant is the primary SKU, so this also pins that the product's
    // primarySku is re-pointed at the same unpriced instance the variants carry.
    const [joined] = await joinCatalogListPricing(
      [product([sku({ variantId: "var-1" }), sku({ variantId: "var-2" })])],
      reader, undefined, "2026-08-12T00:00:00.000Z",
    );

    const degraded = joined!.variants.find((variant) => variant.variantId === "var-1")!;
    expect(degraded.pricing.status).toBe("not_configured");
    expect(degraded.pricing.listPrice).toBeNull();
    expect(joined!.primarySku.variantId).toBe("var-1");
    expect(joined!.primarySku.pricing.listPrice).toBeNull();
    expect(joined!.variants.find((variant) => variant.variantId === "var-2")!.pricing)
      .toMatchObject({ status: "configured", listPrice: { amountMinor: 2490 } });
  });

  it("keeps the catalog price read constant for a 500-product/5,000-SKU projection", async () => {
    let calls = 0;
    const reader: CatalogExactOneTimeBasePriceReadPort = {
      async listExactOneTimeBasePrices(query) {
        calls += 1;
        expect(query.variantIds).toHaveLength(5_000);
        return new Map();
      },
    };
    const products = Array.from({ length: 500 }, (_, productIndex) => product(
      Array.from({ length: 10 }, (_, skuIndex) => sku({
        variantId: `variant-${productIndex}-${skuIndex}`,
        sku: `SKU-${productIndex}-${skuIndex}`,
      })),
    ));

    const joined = await joinCatalogListPricing(products, reader, undefined, "2026-08-12T00:00:00.000Z");

    expect(calls).toBe(1);
    expect(joined).toHaveLength(500);
    expect(joined.flatMap((catalogProduct) => catalogProduct.variants)).toHaveLength(5_000);
  });
});
