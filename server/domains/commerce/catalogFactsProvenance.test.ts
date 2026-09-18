import { describe, expect, it } from "vitest";
import type { CreateQuoteResponse } from "../../../src/domains/commerce/contracts.js";
import { readSettlementProfile } from "../../../src/lib/currency/platformCurrency.js";
import type { CommerceQuoteCatalogItem } from "./commerceQuoteCatalogReadPort.js";
import {
  catalogFactsForQuoteLine,
  projectPublicQuoteSnapshot,
} from "./catalogFactsProvenance.js";

const TEST_CURRENCY = readSettlementProfile({}).defaultCurrency;

describe("catalog facts provenance", () => {
  it("records document and one-time base price facts without policy authority", () => {
    expect(catalogFactsForQuoteLine(
      true, strictItem(), { priceEntryId: "resolved-entry", unitPriceMinor: 1340 },
      { priceEntryId: "base-entry", unitPriceMinor: 1490 }, "subscription",
      "2026-06-05T10:00:00.000Z", TEST_CURRENCY, 1340, 2680, 1490,
    )).toEqual({
      version: "catalog_facts_v1",
      skuId: "11111111-1111-4111-8111-111111111111",
      documentRevisionId: "22222222-2222-4222-8222-222222222222",
      documentDigest: "a".repeat(64),
      resolvedPriceEntryId: "resolved-entry",
      basePriceEntryId: "base-entry",
      mode: "subscription",
      atTime: "2026-06-05T10:00:00.000Z",
      currency: TEST_CURRENCY,
      resolvedUnitAmountMinor: 1340,
      resolvedLineAmountMinor: 2680,
      baseUnitAmountMinor: 1490,
    });
  });

  it("records policy-derived subscriptions as v2 without fabricating an authored subscription entry", () => {
    expect(catalogFactsForQuoteLine(
      true, strictItem(), { priceEntryId: "base-entry", unitPriceMinor: 1340 },
      { priceEntryId: "base-entry", unitPriceMinor: 1490 }, "subscription",
      "2026-06-05T10:00:00.000Z", TEST_CURRENCY, 1340, 2680, 1490,
      { policyRevisionId: "33333333-3333-4333-8333-333333333333", policyDigest: "b".repeat(64) },
    )).toEqual({
      version: "catalog_facts_v2",
      skuId: "11111111-1111-4111-8111-111111111111",
      documentRevisionId: "22222222-2222-4222-8222-222222222222",
      documentDigest: "a".repeat(64),
      basePriceEntryId: "base-entry",
      policyRevisionId: "33333333-3333-4333-8333-333333333333",
      policyDigest: "b".repeat(64),
      mode: "subscription",
      atTime: "2026-06-05T10:00:00.000Z",
      currency: TEST_CURRENCY,
      resolvedUnitAmountMinor: 1340,
      resolvedLineAmountMinor: 2680,
      baseUnitAmountMinor: 1490,
    });
  });

  it("rejects a policy on a one-time line", () => {
    let error: unknown;
    try {
      catalogFactsForQuoteLine(
        true, strictItem(), { priceEntryId: "base-entry", unitPriceMinor: 1490 },
        { priceEntryId: "base-entry", unitPriceMinor: 1490 }, "one_time",
        "2026-06-05T10:00:00.000Z", TEST_CURRENCY, 1490, 1490, 1490,
        { policyRevisionId: "33333333-3333-4333-8333-333333333333", policyDigest: "b".repeat(64) },
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "PRICING_INVARIANT_VIOLATION" });
  });

  it("fails closed for a strict port with incomplete document facts", () => {
    let error: unknown;
    try {
      catalogFactsForQuoteLine(
        true,
        { ...strictItem(), documentRevision: { id: null, digest: null } },
        { priceEntryId: "resolved-entry", unitPriceMinor: 1340 },
        { priceEntryId: "base-entry", unitPriceMinor: 1490 }, "one_time",
        "2026-06-05T10:00:00.000Z", TEST_CURRENCY, 1490, 1490, 1490,
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "PRICE_NOT_CONFIGURED", details: { sku: "opaque:lamb-launch.v1" } });
    expect(catalogFactsForQuoteLine(
      false,
      { ...strictItem(), documentRevision: { id: null, digest: null } },
      { priceEntryId: "resolved-entry", unitPriceMinor: 1340 },
      { priceEntryId: "base-entry", unitPriceMinor: 1490 }, "one_time",
      "2026-06-05T10:00:00.000Z", TEST_CURRENCY, 1490, 1490, 1490,
    )).toBeUndefined();
  });

  it("keeps all public money fields and strips only server provenance", () => {
    const enriched = quoteResponse();
    enriched.quote.lines[0]!.catalogFacts = catalogFactsForQuoteLine(
      true, strictItem(), { priceEntryId: "resolved-entry", unitPriceMinor: 1490 },
      { priceEntryId: "base-entry", unitPriceMinor: 1490 }, "one_time",
      "2026-06-05T10:00:00.000Z", TEST_CURRENCY, 1490, 1490, 1490,
    );
    const publicQuote = projectPublicQuoteSnapshot(enriched);

    const { catalogFacts: _catalogFacts, ...publicLine } = enriched.quote.lines[0]!;
    expect(publicQuote).toEqual({
      ...enriched,
      quote: { ...enriched.quote, lines: [publicLine] },
    });
    expect(publicQuote.quote.lines[0]).not.toHaveProperty("catalogFacts");
  });
});

function strictItem(): CommerceQuoteCatalogItem {
  return {
    skuId: "11111111-1111-4111-8111-111111111111",
    skuCode: "opaque:lamb-launch.v1",
    variantId: "variant-lamb-400",
    productSlug: "lamb",
    netWeightG: 400,
    energyPer100g: 123,
    isAddon: false,
    sellability: { oneTime: true, subscription: true },
    documentRevision: {
      id: "22222222-2222-4222-8222-222222222222",
      digest: "a".repeat(64),
    },
  };
}

function quoteResponse(): CreateQuoteResponse {
  return {
    contractVersion: "commerce.v0",
    quote: {
      currency: TEST_CURRENCY, taxIncluded: true,
      lines: [{
        sku: "opaque:lamb-launch.v1", productSlug: "lamb", quantity: 1,
        unitPriceGross: { amountMinor: 1490, currency: TEST_CURRENCY },
        lineSubtotalGross: { amountMinor: 1490, currency: TEST_CURRENCY },
        tax: {
          included: true, country: "ZZ", category: "standard", vatRateBps: 2300,
          legalBasis: "Example VAT rule",
          netAmount: { amountMinor: 1211, currency: TEST_CURRENCY },
          vatAmount: { amountMinor: 279, currency: TEST_CURRENCY },
          grossAmount: { amountMinor: 1490, currency: TEST_CURRENCY },
        },
      }],
      discounts: [], pricingComponents: [],
      subtotalGross: { amountMinor: 1490, currency: TEST_CURRENCY },
      discountTotalGross: { amountMinor: 0, currency: TEST_CURRENCY },
      totalGross: { amountMinor: 1490, currency: TEST_CURRENCY },
      netTotal: { amountMinor: 1211, currency: TEST_CURRENCY },
      taxTotal: { amountMinor: 279, currency: TEST_CURRENCY },
    },
  };
}
