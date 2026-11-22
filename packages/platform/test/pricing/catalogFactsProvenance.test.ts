import { describe, expect, it, vi } from "vitest";
import type { CreateQuoteResponse } from "../../src/pricing/index.js";
import type { CommerceQuoteCatalogItem } from "../../src/pricing/index.js";
import {
  catalogFactsForQuoteLine,
  projectPublicQuoteSnapshot,
  quoteDigest,
} from "../../src/pricing/index.js";
import { buildCatalogOwnerQuote } from "../../src/catalog/catalogOwnerQuote.js";
import { createPostgresCatalogAdmission } from "../../src/catalog/catalogAdmission.js";
import { catalogAdmissionEvidenceSchema } from "../../src/catalog/catalogAdmissionSchema.js";
import { withCatalogAdmissionFence } from "../../src/catalog/catalogAdmissionFence.js";

const TEST_CURRENCY = "XXX";

it("pins the registered domain, canonical UTF-8 framing and encoder bounds", () => {
  const document = { policy: "not_applicable", lines: [
    { sku: "ARTICLE-A", selector: "opaque:α" }, { sku: "ARTICLE-B", selector: "opaque:β" },
  ] };
  expect(quoteDigest("catalog.owner-quote.v0", document)).toBe("29bc5f4314f138ef984f252b09391e4ad8f0e41fa3c1d23ab3932dcb95537e92");
  expect(() => quoteDigest("unknown" as never, document)).toThrow("quote_digest_dialect_unsupported");
  expect(() => quoteDigest("catalog.owner-quote.v0", "λ".repeat(524_288))).toThrow("draft_payload_too_large");
  const deep = Array.from({ length: 49 }).reduce<unknown>(value => [value], null);
  expect(() => quoteDigest("catalog.owner-quote.v0", deep)).toThrow("draft_json_depth");
});

it("binds the full reviewed projection, distinct source lines and unselected owner dependencies", async () => {
  const quote = quoteResponse();
  const first = quote.quote.lines[0]!;
  first.catalogFacts = catalogFactsForQuoteLine(true, strictItem(), { priceEntryId: "actual-a", unitPriceMinor: 1490 },
    { priceEntryId: "base-a", unitPriceMinor: 1490 }, "one_time", "2026-06-05T10:00:00.000Z", TEST_CURRENCY, 1490, 1490, 1490);
  const secondSku = "opaque:item-beta.v1";
  const second = structuredClone(first);
  second.sku = secondSku;
  second.catalogFacts!.skuId = "33333333-3333-4333-8333-333333333333";
  quote.quote.lines.push(second);
  quote.quote.subtotalGross.amountMinor = 2980;
  quote.quote.totalGross.amountMinor = 2980;
  quote.quote.netTotal.amountMinor = 2422;
  quote.quote.taxTotal.amountMinor = 558;
  const terms = { linePricing: [{ quoteLine: structuredClone(first) }],
    starterPack: { graduation: { lines: [{ quoteLine: structuredClone(second) }] } } };
  const context = { mode: "one_time" as const, promoCodes: [], starterRenewalTerms: terms };
  quote.quote.context = context;
  // The owner inputs are independent of the displayed projection.
  const input: Parameters<typeof buildCatalogOwnerQuote>[0] = {
    quote, consultedHeads: [{ productId: "44444444-4444-4444-8444-444444444444",
      publicationId: "55555555-5555-4555-8555-555555555555", revision: 3, documentDigest: "c".repeat(64) }],
    lineBindings: quote.quote.lines.map((line, index) => ({ sourceOrdinal: index + 1,
      skuCode: line.sku, skuId: line.catalogFacts!.skuId, mode: "one_time", quantity: line.quantity,
      role: "core", source: "legacy" })),
    priceSelectors: [
      { sourceOrdinal: 1, role: "comparison", selectorKey: "candidate-unused", evidence: { ref: "opaque:unused" } },
      { sourceOrdinal: 2, role: "actual", selectorKey: "candidate-b", evidence: { ref: "opaque:β" } },
      { sourceOrdinal: 1, role: "actual", selectorKey: "candidate-a", evidence: { ref: "opaque:α" } },
    ],
    policy: { applicability: "not_applicable", context: { scope: "opaque:verified" } },
  };
  const firstProof = buildCatalogOwnerQuote(input);
  expect(firstProof.evidence.quoteDigest).toBe(quoteDigest("catalog.owner-quote.v0", firstProof.document));
  const readAgain = structuredClone(input);
  readAgain.quote.quote.lines[0]!.catalogFacts!.atTime = "2026-06-05T11:00:00.000Z";
  const retained = (readAgain.quote.quote.context as typeof context).starterRenewalTerms;
  retained.linePricing[0]!.quoteLine.catalogFacts!.atTime = "2026-06-05T12:00:00.000Z";
  retained.starterPack.graduation.lines[0]!.quoteLine.catalogFacts!.atTime = "2026-06-05T13:00:00.000Z";
  readAgain.priceSelectors.reverse();
  expect(buildCatalogOwnerQuote(readAgain)).toEqual(firstProof);
  for (const change of [
    (value: typeof input) => { value.quote.quote.lines[0]!.productSlug = "reviewed-article"; },
    (value: typeof input) => {
      const reviewed = (value.quote.quote.context as typeof context).starterRenewalTerms;
      reviewed.starterPack.graduation.lines[0]!.quoteLine.productSlug = "reviewed-renewal";
    },
    (value: typeof input) => { value.consultedHeads[0]!.revision++; },
    (value: typeof input) => { value.lineBindings[0]!.role = "addon"; },
    (value: typeof input) => { value.priceSelectors[0]!.evidence = { ref: "opaque:changed-comparison" }; },
    (value: typeof input) => { value.priceSelectors[1]!.evidence = { ref: "opaque:changed-actual" }; },
    (value: typeof input) => { value.policy = { applicability: "applies", context: {}, revisionRef: "opaque:policy", revisionDigest: "d".repeat(64) }; },
    (value: typeof input) => { value.offer = { ref: "opaque:offer", version: "2" }; },
  ]) {
    const current = structuredClone(input);
    change(current);
    expect(buildCatalogOwnerQuote(current).evidence.quoteDigest).not.toBe(firstProof.evidence.quoteDigest);
  }
  expect(catalogAdmissionEvidenceSchema.safeParse({ ...firstProof.evidence, quoteRef: "λ".repeat(121) }).success).toBe(false);
  expect(catalogAdmissionEvidenceSchema.safeParse({ ...firstProof.evidence, lineBindings: [...input.lineBindings].reverse() }).success).toBe(false);
  let reads = 0;
  await expect(createPostgresCatalogAdmission().assertCurrent({ async query() { reads++; return { rows: [] }; } }, {
    mode: "one_time", context: { regionCode: "ZZ", currency: TEST_CURRENCY, channel: "D2C", policy: "not_applicable" },
    reviewedProjection: { altered: true }, ownerDocument: firstProof.document,
    evidence: { ...firstProof.evidence, quoteDigest: "0".repeat(64) },
  })).rejects.toThrow("catalog_admission_evidence_binding_mismatch");
  expect(reads).toBe(0);
});

it("releases both a partially reserved pool pair and a late connection", async () => {
  const release = vi.fn(), lateRelease = vi.fn();
  let acquired: (client: unknown) => void = () => {};
  const connect = vi.fn().mockResolvedValueOnce({ release }).mockImplementationOnce(
    () => new Promise(resolve => { acquired = resolve; }),
  );
  const read = vi.fn();
  await expect(withCatalogAdmissionFence({ connect } as never, {
    key: "bounded-request", clientId: "client", skuIds: [], revisionIds: [], priceListId: "list", timeoutMs: 10,
  }, read)).rejects.toThrow("catalog_admission_fence_unavailable");
  expect(release).toHaveBeenCalledOnce();
  expect(read).not.toHaveBeenCalled();
  acquired({ release: lateRelease });
  await Promise.resolve();
  expect(lateRelease).toHaveBeenCalledOnce();
});

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
    expect(error).toMatchObject({ code: "PRICE_NOT_CONFIGURED", details: { sku: "opaque:item-alpha.v1" } });
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

function strictItem(): CommerceQuoteCatalogItem & { usagePer100Units: number } {
  return {
    skuId: "11111111-1111-4111-8111-111111111111",
    skuCode: "opaque:item-alpha.v1",
    variantId: "variant-item-alpha-400",
    productSlug: "item-alpha",
    netWeightG: 400,
    usagePer100Units: 123,
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
        sku: "opaque:item-alpha.v1", productSlug: "item-alpha", quantity: 1,
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
