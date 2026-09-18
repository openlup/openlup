import { describe, expect, it, vi } from "vitest";
import type { CatalogReadPort } from "../../../src/domains/catalog/ports.js";
import type { CatalogProduct } from "../../../src/domains/catalog/types.js";
import { createQuoteResponseSchema } from "../../../src/domains/commerce/contracts.js";
import {
  CommercePriceAuthorityError,
  type CommercePriceAuthorityPort,
  type PricingResolverPort,
} from "../../../src/domains/pricing/ports.js";
import type { ResolvedPrice, ResolvePriceQuery } from "../../../src/domains/pricing/types.js";
import { readSettlementProfile } from "../../../src/lib/currency/platformCurrency.js";
import {
  createLegacyCommerceQuoteCatalogReadPort,
  type CommerceQuoteCatalogReadPort,
} from "./commerceQuoteCatalogReadPort.js";
import { createDbBackedCommerceQuotePort } from "./dbBackedCommerceQuotePort.js";

const COVERAGE_CONSTRAINT = { kind: "feeding_days" as const, value: 21, dailyKcalOverride: 328 };
const settlementProfile = readSettlementProfile();

const exampleTaxProfile = {
  included: true,
  country: "DE",
  category: "standard",
  vatRateBps: 2300,
  legalBasis: "Example VAT rule",
} as const;

describe("db backed commerce quote port", () => {
  it("quotes opaque DB SKUs through catalog variants and pricing resolver tiers", async () => {
    const pricingResolverPort = createPricingResolver({
      "variant-lamb-400:subscription": price({
        mode: "subscription",
        unitPriceMinor: 1340,
        matchedMinQty: 14,
        priceEntryId: "price-sub-14",
      }),
      "variant-lamb-400:one_time": price({
        mode: "one_time",
        unitPriceMinor: 1490,
        matchedMinQty: 14,
        priceEntryId: "price-one-14",
      }),
    });
    const port = createDbBackedCommerceQuotePort({
      catalogReadPort: createCatalogReadPort(),
      pricingResolverPort,
      now: () => "2026-06-05T10:00:00.000Z",
    });

    const response = await port.createQuote({
      mode: "subscription",
      lines: [
        {
          sku: "opaque:lamb-launch.v1",
          variantId: "variant-lamb-400",
          quantity: 14,
          modeAtLine: "subscription",
        },
      ],
      sizeConstraint: COVERAGE_CONSTRAINT,
      cadenceDays: 21,
      promoCodes: [],
      petId: "pet-rex",
    });

    expect(createQuoteResponseSchema.parse(response)).toEqual(response);
    expect(response.quote.lines[0]).toMatchObject({
      sku: "opaque:lamb-launch.v1",
      productSlug: "lamb",
      unitPriceGross: { amountMinor: 1340, currency: "PLN" },
      lineSubtotalGross: { amountMinor: 18760, currency: "PLN" },
    });
    expect(response.quote.lines[0].pricingComponents).toEqual([
      expect.objectContaining({ componentType: "base_unit", amountMinor: 20860 }),
      expect.objectContaining({ componentType: "mode_discount", amountMinor: -2100 }),
    ]);
    expect(response.quote.context).toMatchObject({
      mode: "subscription",
      cadenceDays: 21,
      feedingCoverageDays: 21,
      sizeConstraint: COVERAGE_CONSTRAINT,
      petId: "pet-rex",
    });
    expect(response.quote.context).not.toHaveProperty("pricingPolicy");
    expect(vi.mocked(pricingResolverPort.resolvePrice).mock.calls.map(([query]) => query)).toEqual([
      expect.objectContaining({
        variantId: "variant-lamb-400",
        mode: "subscription",
        eligibleCartQty: 14,
      }),
      expect.objectContaining({
        variantId: "variant-lamb-400",
        mode: "one_time",
        eligibleCartQty: 14,
      }),
    ]);
  });

  it("rejects subscription prices above the active one-time tier", async () => {
    const port = createDbBackedCommerceQuotePort({
      catalogReadPort: createCatalogReadPort(),
      pricingResolverPort: createPricingResolver({
        "variant-lamb-400:subscription": price({
          mode: "subscription",
          unitPriceMinor: 1590,
          priceEntryId: "price-sub-bad",
        }),
        "variant-lamb-400:one_time": price({
          mode: "one_time",
          unitPriceMinor: 1490,
          priceEntryId: "price-one",
        }),
      }),
    });

    await expect(
      port.createQuote({
        mode: "subscription",
        lines: [{ sku: "opaque:lamb-launch.v1", quantity: 1 }],
        cadenceDays: 21,
        promoCodes: [],
      }),
    ).rejects.toMatchObject({
      name: "CommerceQuoteError",
      code: "PRICING_INVARIANT_VIOLATION",
    });
  });

  it("uses the injected tax profile instead of a hard-coded VAT rate", async () => {
    const port = createDbBackedCommerceQuotePort({
      catalogReadPort: createCatalogReadPort(),
      pricingResolverPort: createPricingResolver({
        "variant-lamb-400:one_time": price({
          mode: "one_time",
          unitPriceMinor: 12300,
          priceEntryId: "price-one-example-tax",
        }),
      }),
      taxProfile: exampleTaxProfile,
      supportedTaxProfiles: [exampleTaxProfile],
      now: () => "2026-06-05T10:00:00.000Z",
    });

    const response = await port.createQuote({
      mode: "one_time",
      lines: [{ sku: "opaque:lamb-launch.v1", quantity: 1 }],
      promoCodes: [],
    });

    expect(createQuoteResponseSchema.parse(response)).toEqual(response);
    expect(response.quote.lines[0].tax).toMatchObject({
      country: "DE",
      category: "standard",
      vatRateBps: 2300,
      legalBasis: "Example VAT rule",
      netAmount: { amountMinor: 10000, currency: "PLN" },
      vatAmount: { amountMinor: 2300, currency: "PLN" },
      grossAmount: { amountMinor: 12300, currency: "PLN" },
    });
    expect(response.quote).toMatchObject({
      subtotalGross: { amountMinor: 12300, currency: "PLN" },
      totalGross: { amountMinor: 12300, currency: "PLN" },
      netTotal: { amountMinor: 10000, currency: "PLN" },
      taxTotal: { amountMinor: 2300, currency: "PLN" },
    });
  });

  it("rejects tax profiles that are not declared in the instance configuration", () => {
    expect(() =>
      createDbBackedCommerceQuotePort({
        catalogReadPort: createCatalogReadPort(),
        pricingResolverPort: createPricingResolver({}),
        taxProfile: {
          included: true,
          country: "PL",
          category: "pet_food",
          vatRateBps: 1,
          legalBasis: "Misconfigured test rate",
        },
      }),
    ).toThrowError("Unsupported commerce tax profile");
  });

  it("rejects unknown opaque SKUs and missing DB prices", async () => {
    const port = createDbBackedCommerceQuotePort({
      catalogReadPort: createCatalogReadPort(),
      pricingResolverPort: createPricingResolver({}),
    });

    await expect(
      port.createQuote({
        mode: "one_time",
        lines: [{ sku: "opaque:missing", quantity: 1 }],
        promoCodes: [],
      }),
    ).rejects.toMatchObject({ code: "UNKNOWN_SKU" });

    await expect(
      port.createQuote({
        mode: "one_time",
        lines: [{ sku: "opaque:lamb-launch.v1", quantity: 1 }],
        promoCodes: [],
      }),
    ).rejects.toMatchObject({ code: "PRICE_NOT_CONFIGURED" });
  });

  it("keeps the complete public quote byte-equivalent when strict D1 policy facts match the legacy catalog", async () => {
    const prices = {
      "variant-lamb-400:subscription": price({ mode: "subscription", unitPriceMinor: 1340 }),
      "variant-lamb-400:one_time": price({ mode: "one_time", unitPriceMinor: 1490 }),
    };
    const request = {
      mode: "subscription" as const,
      lines: [{ sku: "opaque:lamb-launch.v1", quantity: 2 }],
      cadenceDays: 21,
      promoCodes: [],
      sizeConstraint: COVERAGE_CONSTRAINT,
    };
    const legacy = createDbBackedCommerceQuotePort({
      catalogReadPort: createCatalogReadPort(),
      pricingResolverPort: createPricingResolver(prices),
      now: () => "2026-06-05T10:00:00.000Z",
    });
    const d1 = createDbBackedCommerceQuotePort({
      quoteCatalogReadPort: quoteCatalogReadPort(),
      commercePriceAuthorityPort: createCommercePriceAuthority({
        oneTime: prices["variant-lamb-400:one_time"]!,
        subscription: {
          kind: "subscription_policy",
          base: prices["variant-lamb-400:one_time"]!,
          unitPriceMinor: 1340,
          policy: subscriptionPolicy(),
        },
      }),
      now: () => "2026-06-05T10:00:00.000Z",
    });

    await expect(d1.createQuote(request)).resolves.toEqual(await legacy.createQuote(request));
    await expect(d1.createServerAuthoritativeQuote!(request)).resolves.toMatchObject({
      quote: { lines: [expect.objectContaining({
        catalogFacts: expect.objectContaining({
          version: "catalog_facts_v2",
          basePriceEntryId: "price-one",
          baseUnitAmountMinor: 1490,
          policyRevisionId: "33333333-3333-4333-8333-333333333333",
          policyDigest: "b".repeat(64),
        }),
      })] },
    });
  });

  it("derives a strict D1 subscription price from the authority policy result", async () => {
    const commercePriceAuthorityPort = createCommercePriceAuthority({
      oneTime: price({ mode: "one_time", unitPriceMinor: 1490, matchedMinQty: 1 }),
      subscription: {
        kind: "subscription_policy",
        base: price({ mode: "one_time", unitPriceMinor: 1490, matchedMinQty: 1 }),
        unitPriceMinor: 1340,
        policy: subscriptionPolicy(),
      },
    });
    const port = createDbBackedCommerceQuotePort({
      quoteCatalogReadPort: quoteCatalogReadPort(),
      commercePriceAuthorityPort,
      now: () => "2026-06-05T10:00:00.000Z",
    });

    await expect(port.createServerAuthoritativeQuote!({
      mode: "subscription",
      lines: [{ sku: "opaque:lamb-launch.v1", quantity: 2 }],
      cadenceDays: 21,
      promoCodes: [],
    })).resolves.toMatchObject({
      quote: { lines: [expect.objectContaining({
        unitPriceGross: expect.objectContaining({ amountMinor: 1340 }),
        catalogFacts: expect.objectContaining({
          version: "catalog_facts_v2",
          basePriceEntryId: "price-one",
          policyRevisionId: "33333333-3333-4333-8333-333333333333",
          policyDigest: "b".repeat(64),
        }),
      })] },
    });
    expect(commercePriceAuthorityPort.resolvePrice).toHaveBeenCalledWith(expect.objectContaining({
      mode: "subscription", channel: "D2C",
      regionCode: settlementProfile.regionCode, currency: settlementProfile.defaultCurrency,
    }));
  });

  it("keeps v1 provenance only for the strict authority's explicit pre-cutover legacy subscription result", async () => {
    const legacyResolved = price({
      mode: "subscription",
      unitPriceMinor: 1340,
      priceEntryId: "price-sub-legacy",
    });
    const port = createDbBackedCommerceQuotePort({
      quoteCatalogReadPort: quoteCatalogReadPort(),
      commercePriceAuthorityPort: createCommercePriceAuthority({
        oneTime: price({ mode: "one_time", unitPriceMinor: 1490, matchedMinQty: 1 }),
        subscription: {
          kind: "subscription_legacy",
          base: price({ mode: "one_time", unitPriceMinor: 1490, matchedMinQty: 1 }),
          unitPriceMinor: 1340,
          legacyResolved,
        },
      }),
    });

    await expect(port.createServerAuthoritativeQuote!({
      mode: "subscription",
      lines: [{ sku: "opaque:lamb-launch.v1", quantity: 1 }],
      cadenceDays: 21,
      promoCodes: [],
    })).resolves.toMatchObject({
      quote: { lines: [expect.objectContaining({
        catalogFacts: expect.objectContaining({
          version: "catalog_facts_v1",
          resolvedPriceEntryId: "price-sub-legacy",
          basePriceEntryId: "price-one",
        }),
      })] },
    });
  });

  it("fails closed when the strict authority cannot return the exact one-time base price", async () => {
    const commercePriceAuthorityPort: CommercePriceAuthorityPort = {
      resolvePrice: vi.fn(async () => {
        throw new CommercePriceAuthorityError("base_price_not_found");
      }),
    };
    const port = createDbBackedCommerceQuotePort({
      quoteCatalogReadPort: quoteCatalogReadPort(),
      commercePriceAuthorityPort,
    });

    await expect(port.createServerAuthoritativeQuote!({
      mode: "subscription",
      lines: [{ sku: "opaque:lamb-launch.v1", quantity: 1 }],
      cadenceDays: 21,
      promoCodes: [],
    })).rejects.toMatchObject({
      name: "CommerceQuoteError",
      code: "PRICE_NOT_CONFIGURED",
      details: { reason: "base_price_not_found" },
    });
  });

  it("refuses a D1 SKU that is inactive for the requested purchase mode before price resolution", async () => {
    const commercePriceAuthorityPort = createCommercePriceAuthority({
      oneTime: price({ mode: "one_time", unitPriceMinor: 1490, matchedMinQty: 1 }),
      subscription: {
        kind: "subscription_policy",
        base: price({ mode: "one_time", unitPriceMinor: 1490, matchedMinQty: 1 }),
        unitPriceMinor: 1340,
        policy: subscriptionPolicy(),
      },
    });
    const port = createDbBackedCommerceQuotePort({
      quoteCatalogReadPort: quoteCatalogReadPort({ sellability: { oneTime: true, subscription: false } }),
      commercePriceAuthorityPort,
    });

    await expect(port.createQuote({
      mode: "subscription",
      lines: [{ sku: "opaque:lamb-launch.v1", quantity: 1 }],
      cadenceDays: 21,
      promoCodes: [],
    })).rejects.toMatchObject({ code: "UNKNOWN_SKU", details: { mode: "subscription" } });
    expect(commercePriceAuthorityPort.resolvePrice).not.toHaveBeenCalled();
  });
});

function createCatalogReadPort(): CatalogReadPort {
  const products = [catalogProduct()];
  return {
    async listProducts() {
      return products;
    },
    async getProductBySlug(slug) {
      return products.find((product) => product.slug === slug) ?? null;
    },
    async listAllergens() {
      return [];
    },
  };
}

function createPricingResolver(prices: Record<string, ResolvedPrice>): PricingResolverPort {
  return {
    resolvePrice: vi.fn(async (query: ResolvePriceQuery) => prices[`${query.variantId}:${query.mode}`] ?? null),
  };
}

function createCommercePriceAuthority(input: {
  oneTime: ResolvedPrice;
  subscription: Extract<Awaited<ReturnType<CommercePriceAuthorityPort["resolvePrice"]>>, { kind: "subscription_policy" | "subscription_legacy" }>;
}): CommercePriceAuthorityPort & { resolvePrice: ReturnType<typeof vi.fn> } {
  const resolvePrice: CommercePriceAuthorityPort["resolvePrice"] = async (query) => query.mode === "one_time"
    ? { kind: "one_time", base: input.oneTime, unitPriceMinor: input.oneTime.unitPriceMinor }
    : input.subscription;
  return {
    resolvePrice: vi.fn(resolvePrice),
  };
}

function subscriptionPolicy() {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    revisionNo: 1,
    priceListId: "44444444-4444-4444-8444-444444444444",
    regionCode: settlementProfile.regionCode,
    currency: settlementProfile.defaultCurrency,
    channel: "D2C",
    effectiveFrom: "2026-06-01T00:00:00.000Z",
    effectiveTo: null,
    discountBps: 1000,
    roundingQuantumMinor: 10,
    roundingRule: "FLOOR_TO_QUANTUM",
    digest: "b".repeat(64),
  } as const;
}

function quoteCatalogReadPort(
  overrides: Partial<Awaited<ReturnType<CommerceQuoteCatalogReadPort["listQuoteCatalogItems"]>>[number]> = {},
): CommerceQuoteCatalogReadPort {
  return {
    async listQuoteCatalogItems() {
      const [item] = await createLegacyCommerceQuoteCatalogReadPort(
        createCatalogReadPort(),
      ).listQuoteCatalogItems();
      return [{
        ...item,
        ...overrides,
        skuId: "11111111-1111-4111-8111-111111111111",
        documentRevision: overrides.documentRevision ?? {
          id: "11111111-1111-4111-8111-111111111111",
          digest: "a".repeat(64),
        },
      }];
    },
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

function catalogProduct(): CatalogProduct {
  return {
    id: "product-lamb",
    slug: "lamb",
    displayName: "Lamb",
    lineName: "openlup",
    species: "dog",
    publicationStatus: "published",
    route: { pl: "/psy/jagniecina", en: "/dogs/lamb" },
    primarySku: {
      sku: "opaque:lamb-launch.v1",
      productSlug: "lamb",
      variantId: "variant-lamb-400",
      publicationStatus: "published",
      unit: "can",
      netWeightGrams: 400,
      pricing: {
        status: "configured",
        listPrice: { amountMinor: 1490, currency: "PLN" },
        taxCategory: "pet_food",
        externalRefs: {
          paymentProviderPriceId: null,
          inventoryProviderSku: null,
        },
      },
    },
    variants: [
      {
        sku: "opaque:lamb-launch.v1",
        productSlug: "lamb",
        variantId: "variant-lamb-400",
        publicationStatus: "published",
        unit: "can",
        netWeightGrams: 400,
        pricing: {
          status: "configured",
          listPrice: { amountMinor: 1490, currency: "PLN" },
          taxCategory: "pet_food",
          externalRefs: {
            paymentProviderPriceId: null,
            inventoryProviderSku: null,
          },
        },
      },
    ],
    composition: {
      rawIngredients: "",
      rawIngredientsEn: null,
      items: [],
      allergenSlugs: ["lamb"],
      kcalPer100g: 123,
    },
    metadata: {
      format: "can",
      kcalPer100g: 123,
      legacyStatus: null,
    },
  };
}
