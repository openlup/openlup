import "./neutralFixtures.js";
import { describe, expect, it, vi } from "vitest";
import type { CreateQuoteResponse } from "./quoteSchemaFixtures.js";
import type { CommerceQuotePort } from "./quoteSchemaFixtures.js";
import { createDbBackedCommerceQuoteSnapshotVerifier } from "./snapshotFixtures.js";

describe("DB-backed commerce quote snapshot verifier", () => {
  it("re-quotes with hidden context and accepts matching snapshots", async () => {
    const snapshot = quoteResponse();
    const port = createPort(snapshot);

    await expect(
      createDbBackedCommerceQuoteSnapshotVerifier(port).verifyQuoteSnapshot(snapshot),
    ).resolves.toEqual(snapshot);

    expect(port.createQuote).toHaveBeenCalledWith({
      mode: "subscription",
      lines: [{ sku: "opaque:item-alpha.v1", quantity: 14, modeAtLine: "subscription" }],
      sizeConstraint: { kind: "usage_days", value: 21, dailyUsageOverride: 328 },
      cadenceDays: 21,
      promoCodes: ["launch"],
      subjectId: "subject-a",
      subjectContext: { subjectId: "subject-a", stage: "stage_c", load: 12 },
    });
  });

  it("rejects stale DB-backed quote snapshots", async () => {
    const stale = quoteResponse();
    const current = quoteResponse();
    current.quote.lines[0].unitPriceGross.amountMinor = 1300;
    current.quote.lines[0].lineSubtotalGross.amountMinor = 18200;
    current.quote.lines[0].tax.netAmount.amountMinor = 16852;
    current.quote.lines[0].tax.vatAmount.amountMinor = 1348;
    current.quote.lines[0].tax.grossAmount.amountMinor = 18200;
    current.quote.subtotalGross.amountMinor = 18200;
    current.quote.totalGross.amountMinor = 18200;
    current.quote.netTotal.amountMinor = 16852;
    current.quote.taxTotal.amountMinor = 1348;

    await expect(
      createDbBackedCommerceQuoteSnapshotVerifier(createPort(current)).verifyQuoteSnapshot(stale),
    ).rejects.toMatchObject({
      code: "QUOTE_SNAPSHOT_MISMATCH",
      details: { reason: "snapshot_does_not_match_db_backed_quote" },
    });
  });

  it("compares the complete public projection and returns the authoritative enriched snapshot", async () => {
    const submitted = quoteResponse();
    const authoritative = quoteResponse();
    authoritative.quote.lines[0]!.catalogFacts = catalogFacts(authoritative.quote.currency);
    const port: CommerceQuotePort = {
      createQuote: vi.fn(),
      createServerAuthoritativeQuote: vi.fn().mockResolvedValue(authoritative),
    };

    await expect(
      createDbBackedCommerceQuoteSnapshotVerifier(port).verifyQuoteSnapshot(submitted),
    ).resolves.toEqual(authoritative);
    expect(port.createQuote).not.toHaveBeenCalled();
    expect(port.createServerAuthoritativeQuote).toHaveBeenCalledTimes(1);
  });
});

function createPort(snapshot: ReturnType<typeof quoteResponse>): CommerceQuotePort {
  return {
    createQuote: vi.fn().mockResolvedValue(snapshot),
  };
}

function quoteResponse(): CreateQuoteResponse {
  return {
    contractVersion: "commerce.v0" as const,
    quote: {
      currency: "XXX" as const,
      taxIncluded: true as const,
      context: {
        mode: "subscription" as const,
        cadenceDays: 21,
        sizeConstraint: { kind: "usage_days" as const, value: 21, dailyUsageOverride: 328 },
        promoCodes: ["launch"],
        subjectId: "subject-a",
        subjectContext: { subjectId: "subject-a", stage: "stage_c" as const, load: 12 },
      },
      lines: [{
        sku: "opaque:item-alpha.v1",
        productSlug: "item-alpha" as const,
        quantity: 14,
        unitPriceGross: { amountMinor: 1340, currency: "XXX" as const },
        lineSubtotalGross: { amountMinor: 18760, currency: "XXX" as const },
        tax: {
          included: true as const,
          country: "ZZ" as const,
          category: "example_category" as const,
          vatRateBps: 800 as const,
          legalBasis: "Example VAT rule" as const,
          netAmount: { amountMinor: 17370, currency: "XXX" as const },
          vatAmount: { amountMinor: 1390, currency: "XXX" as const },
          grossAmount: { amountMinor: 18760, currency: "XXX" as const },
        },
      }],
      discounts: [],
      pricingComponents: [],
      subtotalGross: { amountMinor: 18760, currency: "XXX" as const },
      discountTotalGross: { amountMinor: 0, currency: "XXX" as const },
      totalGross: { amountMinor: 18760, currency: "XXX" as const },
      netTotal: { amountMinor: 17370, currency: "XXX" as const },
      taxTotal: { amountMinor: 1390, currency: "XXX" as const },
    },
  };
}

function catalogFacts(currency: CreateQuoteResponse["quote"]["currency"]) {
  return {
    version: "catalog_facts_v1" as const,
    skuId: "11111111-1111-4111-8111-111111111111",
    documentRevisionId: "22222222-2222-4222-8222-222222222222",
    documentDigest: "a".repeat(64),
    resolvedPriceEntryId: "resolved-entry",
    basePriceEntryId: "base-entry",
    mode: "subscription" as const,
    atTime: "2026-06-05T10:00:00.000Z",
    currency,
    resolvedUnitAmountMinor: 1340,
    resolvedLineAmountMinor: 18760,
    baseUnitAmountMinor: 1490,
  };
}
