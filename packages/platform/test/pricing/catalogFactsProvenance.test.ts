import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { buildLineBreakdown } from "@openlup/core/pricing";
import { mapPricingComponent } from "../../src/pricing/dbBackedCommerceQuoteHelpers.js";
import { describe, expect, it, vi } from "vitest";
import type { CreateQuoteResponse } from "../../src/pricing/index.js";
import type { CommerceQuoteCatalogItem } from "../../src/pricing/index.js";
import {
  catalogFactsForQuoteLine,
  projectPublicQuoteSnapshot,
  quoteDigest,
} from "../../src/pricing/index.js";
import { buildCatalogOwnerQuote } from "../../src/catalog/testing/index.js";
import { buildSelectedSubscriptionOwnerQuote, type SelectedSubscriptionOwnerInput } from "../../src/catalog/catalogOwnerQuoteSubscription.js";
import { canonicalCatalogDraftJson as canonical } from "../../src/catalog/contracts/draft.js";
import { splitIncludedVat } from "../../src/pricing/quoteSchemas.js";
import { digestSubscriptionPricePolicy } from "../../src/pricing/subscriptionPricePolicy.js";
import { createPostgresCatalogAdmission } from "../../src/catalog/catalogAdmission.js";
import { catalogAdmissionEvidenceSchema } from "../../src/catalog/catalogAdmissionSchema.js";
import { authenticateSelectedOfferReview, promotionQuoteAcceptanceEnvelope as codec } from "../../src/promotions/promotionQuoteAcceptanceEnvelope.js";
import { withCatalogAdmissionFence } from "../../src/catalog/catalogAdmissionFence.js";

import { id, moneyGolden, sealQuote } from "./quoteMoneyV2Fixtures.js";

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

it("pins the canonical Unicode quote money and final quote digests", () => {
  const body = moneyGolden();
  const { quoteDigest: _digest, ...final } = sealQuote(body);
  expect(quoteDigest("commerce.quote-money.v2", body)).toBe("6da5f2ae74154e53ce12da4b60cfccbe5b847a3e2bb88834a283ebf939479f0e");
  expect(quoteDigest("commerce.quote.v2", final)).toBe("dc27ad4548ef9ccf0e34ac94d96e56beef822a5ddb2c1a1d60c6217a6241459d");
  const { price, ...other } = body;
  const { priceEvidenceRef, ...otherPrice } = price;
  expect(quoteDigest("commerce.quote-money.v2", { price: { priceEvidenceRef, ...otherPrice }, ...other })).toBe(final.moneyDigest);
  expect(quoteDigest("commerce.quote-money.v2", { ...body, lines: [...body.lines].reverse() })).not.toBe(final.moneyDigest);
  expect(quoteDigest("commerce.quote.v2", { status: final.status, ...Object.fromEntries(Object.entries(final).filter(([key]) => key !== "status").reverse()) } as typeof final)).toBe(_digest);
});

it("pins the quote presentation dialect and its nested canonical frame", () => {
  expect(quoteDigest("commerce.quote-presentation.v2", [
    "098959dbaccb5a6becc8f01f11478ce47ab2384f7ca793232e73051e8855c0f4",
    ["service-a", "service-b"], { currency: TEST_CURRENCY, amountMinor: 8 },
  ])).toBe("ba689fa625a12af4916b475311099d5e50723368b732af0eb2989f00158ff501");
});

it("commits status, allocations and destination even at equal payable", () => {
  const original = sealQuote();
  const { quoteDigest: digest, ...final } = original;
  expect(quoteDigest("commerce.quote.v2", { ...final, status: "estimate" })).not.toBe(digest);
  const body = moneyGolden();
  const [first, ...rest] = body.lines;
  const [share] = first.discountAllocations;
  for (const altered of [
    { ...body, lines: [{ ...first, discountAllocations: [{ ...share, allocationId: id(7) }] }, ...rest] },
    { ...body, destination: { ...body.destination, snapshotRef: id(8) } },
  ]) {
    expect(altered.payableMinor).toBe(body.payableMinor);
    const sealed = sealQuote(altered);
    expect(sealed.moneyDigest).not.toBe(original.moneyDigest);
    expect(sealed.quoteDigest).not.toBe(digest);
  }
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
  expect(tagged(firstProof.document)).toBe(ownerGolden("one-time"));
  expect(firstProof.evidence.quoteDigest).toBe("35eabb1479c54e3a534e20a445083335916fcac31886bd114fac57767a044edd");
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
  }, read)).rejects.toMatchObject({
    message: "catalog_admission_fence_unavailable",
    hint: "Retry the same request with the same idempotency key.",
  });
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

const tagged = (document: unknown) => canonical(["catalog.owner-quote.v0", document]);
const ownerGolden = (name: string) => readFileSync(new URL(`./fixtures/catalog-owner-quote/${name}.json`, import.meta.url), "utf8");
const sample = "2026-06-05T10:00:00.000Z";
const validFrom = "2026-06-01T00:00:00.000Z";

async function selectedSubscription(policyId?: string): Promise<SelectedSubscriptionOwnerInput> {
  const scope = { priceListId: id(10), regionCode: "ZZ", currency: TEST_CURRENCY, channel: "D2C" } as const;
  const tuple = { ...scope, id: policyId ?? id(11), revisionNo: 1, effectiveFrom: validFrom, effectiveTo: null,
    discountBps: 1000, roundingQuantumMinor: 10, roundingRule: "FLOOR_TO_QUANTUM" } as const;
  const policy = policyId ? { ...tuple, digest: await digestSubscriptionPricePolicy(tuple) } : null;
  const price = (i: number, base: boolean) => ({
    variantId: id(20 + i), mode: base ? "one_time" as const : "subscription" as const, matchedMinQty: 1 as const,
    unitPriceMinor: base ? 1490 : 1340, amountKind: "gross" as const, priceListId: scope.priceListId,
    priceEntryId: id((base ? 30 : 40) + i), resolvedAt: sample,
  });
  const results = [1, 2].map(i => policy
    ? { kind: "subscription_policy" as const, base: price(i, true), unitPriceMinor: 1340, policy }
    : { kind: "subscription_legacy" as const, base: price(i, true), unitPriceMinor: 1340, legacyResolved: price(i, false) });
  const gross = (amountMinor: number) => ({ amountMinor, currency: TEST_CURRENCY });
  const lines = results.map((result, index) => {
    const item = { ...strictItem(), skuId: result.base.variantId, skuCode: `ARTICLE-${index + 1}` };
    const baseLine = quoteResponse().quote.lines[0]!;
    const { netMinor, vatMinor } = splitIncludedVat(1340, 2300);
    const pricingComponents = buildLineBreakdown({ variant_id: item.skuId, line_qty: 1, base_unit_price_minor: 1490,
      resolved_unit_price_minor: 1340, matched_tier_min_qty: 1, mode_at_line: "subscription", mode_resolved_via_fallback: false })
      .map(component => mapPricingComponent(component, "line"));
    return { ...baseLine, sku: item.skuCode, unitPriceGross: gross(1340), lineSubtotalGross: gross(1340), pricingComponents,
      tax: { ...baseLine.tax, netAmount: gross(netMinor), vatAmount: gross(vatMinor), grossAmount: gross(1340) },
      catalogFacts: catalogFactsForQuoteLine(true, item, price(index + 1, false), result.base,
        "subscription", sample, TEST_CURRENCY, 1340, 1340, 1490,
        policy ? { policyRevisionId: policy.id, policyDigest: policy.digest } : undefined)! };
  });
  const lineBindings = lines.map((line, index) => ({
    sourceOrdinal: index + 1, skuCode: line.sku, skuId: line.catalogFacts.skuId, mode: "subscription", quantity: 1, role: "core",
    ...(index === 0 ? { source: "fresh", skuRevisionId: id(51) } as const : { source: "legacy" } as const),
  } as const));
  const linePricing = lines.map(line => ({ sku: line.sku, quantity: 1, unitAmountMinor: 1340, isAddon: false, quoteLine: structuredClone(line) }));
  const head = (n: number) => ({ productId: id(n), publicationId: id(n + 10), revision: 3, documentDigest: "c".repeat(64) });
  const first = head(60), unused = head(61);
  const actual = (i: number) => policy ? price(i, true) : price(i, false);
  const row = (i: number, role: "actual" | "base" | "comparison", value = role === "base" ? price(i, true) : actual(i)) => ({
    sourceOrdinal: i, role, selectorKey: `opaque:${role}:α`, declaringRef: "opaque:中", value: { ...value, resolvedAt: validFrom },
    outcome: role === "comparison" ? "rejected" as const : "selected" as const, validFrom,
    validTo: role === "comparison" ? "2026-06-03T00:00:00.000Z" : null,
  });
  const shippingTerms = { version: "shipping-threshold.v1", currency: TEST_CURRENCY, flatMinor: 150, freeThresholdMinor: 2700 } as const;
  const acquisitionCapability = "subscription-acquisition.v1" as const;
  const snapshot = quoteResponse();
  const ship = splitIncludedVat(150, 2300), discount = splitIncludedVat(296, 2300);
  return {
    atTime: sample, request: { principalRef: id(80), clientId: id(81), ownerNamespace: "fixture:store", purpose: "checkout",
      offerSelector: "configured:regular", acquisitionCapability, mode: "subscription", cadenceDays: 28,
      lines: lines.map(({ sku, quantity }) => ({ sku, quantity })), promoCodes: [],
      checkout: { configuration: "regular", country: "ZZ", termsRevision: "terms:1", firstName: "Sample", lastName: null,
        phone: null, line1: null, line2: null, city: null, postalCode: null, email: "fixture@example.invalid", purchaser: id(81) } },
    offer: { ref: "owner:regular-α", version: "1" }, consultedHeads: [unused, first], lineBindings,
    issues: [{ ...first, publicationId: id(79), revision: 1, kind: "compared", sourceOrdinal: 1, skuRevisionId: id(52) },
      { ...first, revision: 2, publicationId: id(78), kind: "declaring", sourceOrdinal: 1, skuRevisionId: id(51) }],
    price: { ...scope, lists: [{ priceListId: scope.priceListId, validFrom, validTo: null }],
      selectors: [row(2, "base"), row(1, "comparison", { ...actual(1), priceEntryId: id(95) }), row(1, "actual"), row(2, "actual"), row(1, "base")],
      results },
    policyHistory: policy ? [policy] : [], secondTotalMinor: 2236,
    decisions: { promotions: [{ ref: "promotion:regular", revision: "1", validFrom, validTo: null, decision: "applied" },
      { ref: "promotion:unused", revision: "2", validFrom, validTo: null, decision: "ineligible" }],
      eligibilityRef: "owner:eligibility-α", claim: "eligible", acquisitionPolicyRef: "owner:acquisition", taxRef: "owner:tax",
      shippingRef: "owner:shipping", destination: { ref: "owner:destination-β", digest: "d".repeat(64) } },
    phase: { applicability: "certified", phaseDigest: "e".repeat(64), lineBindings: structuredClone(lineBindings),
      basis: { templateRef: "owner:phase", templateVersion: 1, cadenceDays: 56 } },
    quote: { ...snapshot, quote: { ...snapshot.quote, lines, subtotalGross: gross(2680), shippingGross: gross(150),
      pricingComponents: lines.flatMap(line => line.pricingComponents),
      discounts: [{ promotionId: "promotion:regular", label: "Initial subscription", reasonCode: "promotion_target_percentage",
        appliesTo: "order_total", amountOffMinor: 296 }],
      discountTotalGross: gross(296), shippingDiscountGross: gross(0), totalGross: gross(2534),
      netTotal: gross(ship.netMinor - discount.netMinor + lines[0]!.tax.netAmount.amountMinor * 2),
      taxTotal: gross(ship.vatMinor - discount.vatMinor + lines[0]!.tax.vatAmount.amountMinor * 2),
      context: { mode: "subscription", cadenceDays: 28, acquisitionCapability, promoCodes: [], starterRequest: "a".repeat(64),
        pricingPolicy: { offerPolicyVersion: "commerce.offer-policy.v2", promotionEngineVersion: "promotion-engine.v2" },
        acquisitionTerms: { schemaVersion: acquisitionCapability, revision: "acquisition:1", initialDiscountBps: 2000,
          delivery2DiscountBps: 3000, effectiveFrom: validFrom, effectiveTo: null, sourcePromotionId: "promotion:regular" },
        shippingTerms, starterRenewalTerms: { version: "native.renewal-terms.v1", shippingTerms, minimumPayableMinor: 10,
          linePricing, normalCadenceDays: [56], starterPack: { schemaVersion: "1", starterIntervalDays: 28, basisTemplateVersion: 1,
            delivery2: { discountBps: 3000, basisSubtotalMinor: 2680, discountMinor: 594 },
            graduation: { cadenceDays: 56, lines: linePricing.map(({ sku, quoteLine }, sortOrder) =>
              ({ sku, qty: 1, isAddon: false, sortOrder, quoteLine: structuredClone(quoteLine) })) } } } } } },
  };
}

it("pins the mixed subscription preimage and keeps timed observations, contact and private decisions scoped", async () => {
  const input = await selectedSubscription(), originalQuote = structuredClone(input.quote);
  const first = buildSelectedSubscriptionOwnerQuote(input);
  expect(input.quote).toEqual(originalQuote);
  expect(tagged(first.document)).toBe(ownerGolden("subscription"));
  expect(first.evidence.quoteDigest).toBe("d02afe16aaaf3b7d8e4fb268bcab03ff02a9f811ae55a89e1d1902c1f1694acf");
  const later = "2026-06-05T11:00:00.000Z";
  input.atTime = input.quote.quote.context.atTime = later;
  input.quote.quote.context.starterRequest = "b".repeat(64);
  input.quote.quote.context.pricingPolicy.pricingPolicyToken = "opaque".repeat(12);
  const terms = input.quote.quote.context.starterRenewalTerms;
  for (const line of [...input.quote.quote.lines, ...terms.linePricing.map(row => row.quoteLine),
    ...terms.starterPack.graduation.lines.map(row => row.quoteLine)]) line.catalogFacts.atTime = later;
  for (const result of input.price!.results) {
    result.base.resolvedAt = later;
    if (result.kind === "subscription_legacy") result.legacyResolved.resolvedAt = later;
  }
  input.price!.selectors.reverse();
  input.consultedHeads!.reverse();
  expect(buildSelectedSubscriptionOwnerQuote(input)).toEqual(first);
  input.request.checkout.email = "other@example.invalid";
  expect(buildSelectedSubscriptionOwnerQuote(input).document).toEqual(first.document);
  expect(first.requestBinding.checkout.email).toBe("fixture@example.invalid");
  expect(Object.keys(first.evidence).sort()).toEqual(["consultedHeads", "destinationDigest", "destinationRef", "graduation", "lineBindings",
    "moneyVersion", "offer", "policyEvidenceRef", "priceEvidenceRef", "quoteDigest"]);
  expect(tagged(first.document)).not.toMatch(/catalogFacts|example\.invalid|starterRequest|resolvedAt/);
  const wire = projectPublicQuoteSnapshot(originalQuote);
  expect(wire.quote.lines.every(line => !Object.hasOwn(line, "catalogFacts"))).toBe(true);
  expect(Object.keys(wire.quote.context).sort()).toEqual(["acquisitionCapability", "acquisitionTerms", "cadenceDays", "mode",
    "pricingPolicy", "promoCodes", "shippingTerms", "starterRenewalTerms", "starterRequest"]);
  expect(tagged(wire)).not.toMatch(/ownerDecisions|renewalTerms|phaseDigest|destinationDigest|priceEvidenceRef/);
});

it("pins the selected offer-review codec bytes and the two token hash dialects", async () => {
  const input = JSON.parse(JSON.stringify(await selectedSubscription()).replaceAll('"XXX"', '"XTS"')) as SelectedSubscriptionOwnerInput;
  Object.assign(input.request, { purpose: "offer-review" });
  Object.assign(input.request.checkout, { firstName: "Sample", lastName: "Buyer", phone: "000000", line1: "Example 1",
    line2: null, city: "Example", postalCode: "000" });
  const { requestBinding, evidence } = buildSelectedSubscriptionOwnerQuote(input);
  const quote = input.quote.quote as CreateQuoteResponse["quote"];
  const { acquisitionTerms, shippingTerms } = input.quote.quote.context;
  const current = "0123456789abcdef0123456789abcdef";
  const keyring = { current };
  const iat = 1_780_653_600_000, exp = iat + codec.maxTtlMs;
  const value = { v: 1, kid: codec.keyId(current), iat, exp, engine: "promotion-engine.v2",
    requestBinding: codec.requestBinding(requestBinding, current), codeBinding: codec.codeBinding([], current),
    quoteBinding: codec.quoteBinding(quote, current, acquisitionTerms, shippingTerms),
    sectionBindings: codec.sectionBindings(quote, current, acquisitionTerms, shippingTerms),
    totalMinor: 2534, currency: "XTS", ownerQuoteDigest: evidence.quoteDigest };
  const encode = (body: Buffer, offerReview = true) => {
    const segment = body.toString("base64url");
    return `${segment}.${codec.sign(segment, current, offerReview)}`;
  };
  const sha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
  const vectors = [value, { ...value, sectionBindings: undefined }, { ...value, ownerQuoteDigest: undefined },
    { ...value, iat: 8_639_999_000_000_000, exp: 8_639_999_000_000_000 + codec.maxTtlMs, totalMinor: 2_000_000_000 }];
  expect(vectors.map(payload => {
    const json = JSON.stringify(payload);
    const token = encode(Buffer.from(json)), [body, signature] = token.split(".");
    return { json, bodyLength: body!.length, signature, token, rawHash: sha(token), legacyHash: sha(canonical(token)) };
  })).toMatchInlineSnapshot(`
    [
      {
        "bodyLength": 1170,
        "json": "{"v":1,"kid":"3eb1bd439947eb76","iat":1780653600000,"exp":1780912800000,"engine":"promotion-engine.v2","requestBinding":"d14731e38d0ea655d795e316e8105c806bb7f032508e25dfaeb74d3cebc1f283","codeBinding":"ad12fdb13ff0ab86ff6c711867d7134adcf79d33f834a741be12988ff846b7e2","quoteBinding":"a4228ce776bff1be32f6506de42d4837401230722854c525937ab3219fb6689b","sectionBindings":{"lines":"f243031be94b6ef82fc633e7d79a851c01a026bed82626e51601731704cf1253","discounts":"290e00be947f20320ab22d467893839f76a195721abfb52d1027673cef177312","shipping":"709cde6a9399483a7d933762f0f35c1d1b7fbbb9f4cbb3906824e6e4ceaab5f6","totals":"70dc09ef890359fc72ce417cb3273ef84e2aad25018d31e7b69e1d403bd0b6a3","currency":"6260c00643528784db79a5c736503b46c303d5e73d74bc84edbf527b24f83b83"},"totalMinor":2534,"currency":"XTS","ownerQuoteDigest":"ec543690384383929f46a288a7d7550f83802c40752a80c9430311aac18106dd"}",
        "legacyHash": "655548443d72158b2eec15ef60b45e6d87ce80129aef6939ff73bfe34a2b7ec4",
        "rawHash": "d753faa72e558b390f5868682c3f7d61a2c3dba78417cb24e51dbb167bbdfc59",
        "signature": "yBOgRbyknQ1lCjz3bcfYEKsswlUFEhnNYgyaCLOtlMQ",
        "token": "eyJ2IjoxLCJraWQiOiIzZWIxYmQ0Mzk5NDdlYjc2IiwiaWF0IjoxNzgwNjUzNjAwMDAwLCJleHAiOjE3ODA5MTI4MDAwMDAsImVuZ2luZSI6InByb21vdGlvbi1lbmdpbmUudjIiLCJyZXF1ZXN0QmluZGluZyI6ImQxNDczMWUzOGQwZWE2NTVkNzk1ZTMxNmU4MTA1YzgwNmJiN2YwMzI1MDhlMjVkZmFlYjc0ZDNjZWJjMWYyODMiLCJjb2RlQmluZGluZyI6ImFkMTJmZGIxM2ZmMGFiODZmZjZjNzExODY3ZDcxMzRhZGNmNzlkMzNmODM0YTc0MWJlMTI5ODhmZjg0NmI3ZTIiLCJxdW90ZUJpbmRpbmciOiJhNDIyOGNlNzc2YmZmMWJlMzJmNjUwNmRlNDJkNDgzNzQwMTIzMDcyMjg1NGM1MjU5MzdhYjMyMTlmYjY2ODliIiwic2VjdGlvbkJpbmRpbmdzIjp7ImxpbmVzIjoiZjI0MzAzMWJlOTRiNmVmODJmYzYzM2U3ZDc5YTg1MWMwMWEwMjZiZWQ4MjYyNmU1MTYwMTczMTcwNGNmMTI1MyIsImRpc2NvdW50cyI6IjI5MGUwMGJlOTQ3ZjIwMzIwYWIyMmQ0Njc4OTM4MzlmNzZhMTk1NzIxYWJmYjUyZDEwMjc2NzNjZWYxNzczMTIiLCJzaGlwcGluZyI6IjcwOWNkZTZhOTM5OTQ4M2E3ZDkzMzc2MmYwZjM1YzFkMWI3ZmJiYjlmNGNiYjM5MDY4MjRlNmU0Y2VhYWI1ZjYiLCJ0b3RhbHMiOiI3MGRjMDllZjg5MDM1OWZjNzJjZTQxN2NiMzI3M2VmODRlMmFhZDI1MDE4ZDMxZTdiNjllMWQ0MDNiZDBiNmEzIiwiY3VycmVuY3kiOiI2MjYwYzAwNjQzNTI4Nzg0ZGI3OWE1YzczNjUwM2I0NmMzMDNkNWU3M2Q3NGJjODRlZGJmNTI3YjI0ZjgzYjgzIn0sInRvdGFsTWlub3IiOjI1MzQsImN1cnJlbmN5IjoiWFRTIiwib3duZXJRdW90ZURpZ2VzdCI6ImVjNTQzNjkwMzg0MzgzOTI5ZjQ2YTI4OGE3ZDc1NTBmODM4MDJjNDA3NTJhODBjOTQzMDMxMWFhYzE4MTA2ZGQifQ.yBOgRbyknQ1lCjz3bcfYEKsswlUFEhnNYgyaCLOtlMQ",
      },
      {
        "bodyLength": 628,
        "json": "{"v":1,"kid":"3eb1bd439947eb76","iat":1780653600000,"exp":1780912800000,"engine":"promotion-engine.v2","requestBinding":"d14731e38d0ea655d795e316e8105c806bb7f032508e25dfaeb74d3cebc1f283","codeBinding":"ad12fdb13ff0ab86ff6c711867d7134adcf79d33f834a741be12988ff846b7e2","quoteBinding":"a4228ce776bff1be32f6506de42d4837401230722854c525937ab3219fb6689b","totalMinor":2534,"currency":"XTS","ownerQuoteDigest":"ec543690384383929f46a288a7d7550f83802c40752a80c9430311aac18106dd"}",
        "legacyHash": "3b0e409039b7f9001cb309d5cb8a1e963132cbffd062e78b3b858349dadba6be",
        "rawHash": "9faae2420fb5563e7321d95a90112cf440fabf01524aae8bac1efaeb0ea84622",
        "signature": "c-XKlv6EbX74w213L6S0gnPrFgQLkUZXVyVKYHhAs0w",
        "token": "eyJ2IjoxLCJraWQiOiIzZWIxYmQ0Mzk5NDdlYjc2IiwiaWF0IjoxNzgwNjUzNjAwMDAwLCJleHAiOjE3ODA5MTI4MDAwMDAsImVuZ2luZSI6InByb21vdGlvbi1lbmdpbmUudjIiLCJyZXF1ZXN0QmluZGluZyI6ImQxNDczMWUzOGQwZWE2NTVkNzk1ZTMxNmU4MTA1YzgwNmJiN2YwMzI1MDhlMjVkZmFlYjc0ZDNjZWJjMWYyODMiLCJjb2RlQmluZGluZyI6ImFkMTJmZGIxM2ZmMGFiODZmZjZjNzExODY3ZDcxMzRhZGNmNzlkMzNmODM0YTc0MWJlMTI5ODhmZjg0NmI3ZTIiLCJxdW90ZUJpbmRpbmciOiJhNDIyOGNlNzc2YmZmMWJlMzJmNjUwNmRlNDJkNDgzNzQwMTIzMDcyMjg1NGM1MjU5MzdhYjMyMTlmYjY2ODliIiwidG90YWxNaW5vciI6MjUzNCwiY3VycmVuY3kiOiJYVFMiLCJvd25lclF1b3RlRGlnZXN0IjoiZWM1NDM2OTAzODQzODM5MjlmNDZhMjg4YTdkNzU1MGY4MzgwMmM0MDc1MmE4MGM5NDMwMzExYWFjMTgxMDZkZCJ9.c-XKlv6EbX74w213L6S0gnPrFgQLkUZXVyVKYHhAs0w",
      },
      {
        "bodyLength": 1055,
        "json": "{"v":1,"kid":"3eb1bd439947eb76","iat":1780653600000,"exp":1780912800000,"engine":"promotion-engine.v2","requestBinding":"d14731e38d0ea655d795e316e8105c806bb7f032508e25dfaeb74d3cebc1f283","codeBinding":"ad12fdb13ff0ab86ff6c711867d7134adcf79d33f834a741be12988ff846b7e2","quoteBinding":"a4228ce776bff1be32f6506de42d4837401230722854c525937ab3219fb6689b","sectionBindings":{"lines":"f243031be94b6ef82fc633e7d79a851c01a026bed82626e51601731704cf1253","discounts":"290e00be947f20320ab22d467893839f76a195721abfb52d1027673cef177312","shipping":"709cde6a9399483a7d933762f0f35c1d1b7fbbb9f4cbb3906824e6e4ceaab5f6","totals":"70dc09ef890359fc72ce417cb3273ef84e2aad25018d31e7b69e1d403bd0b6a3","currency":"6260c00643528784db79a5c736503b46c303d5e73d74bc84edbf527b24f83b83"},"totalMinor":2534,"currency":"XTS"}",
        "legacyHash": "95d07c81859e3006ae8e77d90712c8273edee53f3ed6caf5f9995c023af0b9b2",
        "rawHash": "b9e904fe12dfe8c8171248835a31b6557478048276d2d23e17b55e4e9b37ef59",
        "signature": "03l0JVvzz8BDtMvIszJv7_82Xp2PonqREH3gUBTgiBA",
        "token": "eyJ2IjoxLCJraWQiOiIzZWIxYmQ0Mzk5NDdlYjc2IiwiaWF0IjoxNzgwNjUzNjAwMDAwLCJleHAiOjE3ODA5MTI4MDAwMDAsImVuZ2luZSI6InByb21vdGlvbi1lbmdpbmUudjIiLCJyZXF1ZXN0QmluZGluZyI6ImQxNDczMWUzOGQwZWE2NTVkNzk1ZTMxNmU4MTA1YzgwNmJiN2YwMzI1MDhlMjVkZmFlYjc0ZDNjZWJjMWYyODMiLCJjb2RlQmluZGluZyI6ImFkMTJmZGIxM2ZmMGFiODZmZjZjNzExODY3ZDcxMzRhZGNmNzlkMzNmODM0YTc0MWJlMTI5ODhmZjg0NmI3ZTIiLCJxdW90ZUJpbmRpbmciOiJhNDIyOGNlNzc2YmZmMWJlMzJmNjUwNmRlNDJkNDgzNzQwMTIzMDcyMjg1NGM1MjU5MzdhYjMyMTlmYjY2ODliIiwic2VjdGlvbkJpbmRpbmdzIjp7ImxpbmVzIjoiZjI0MzAzMWJlOTRiNmVmODJmYzYzM2U3ZDc5YTg1MWMwMWEwMjZiZWQ4MjYyNmU1MTYwMTczMTcwNGNmMTI1MyIsImRpc2NvdW50cyI6IjI5MGUwMGJlOTQ3ZjIwMzIwYWIyMmQ0Njc4OTM4MzlmNzZhMTk1NzIxYWJmYjUyZDEwMjc2NzNjZWYxNzczMTIiLCJzaGlwcGluZyI6IjcwOWNkZTZhOTM5OTQ4M2E3ZDkzMzc2MmYwZjM1YzFkMWI3ZmJiYjlmNGNiYjM5MDY4MjRlNmU0Y2VhYWI1ZjYiLCJ0b3RhbHMiOiI3MGRjMDllZjg5MDM1OWZjNzJjZTQxN2NiMzI3M2VmODRlMmFhZDI1MDE4ZDMxZTdiNjllMWQ0MDNiZDBiNmEzIiwiY3VycmVuY3kiOiI2MjYwYzAwNjQzNTI4Nzg0ZGI3OWE1YzczNjUwM2I0NmMzMDNkNWU3M2Q3NGJjODRlZGJmNTI3YjI0ZjgzYjgzIn0sInRvdGFsTWlub3IiOjI1MzQsImN1cnJlbmN5IjoiWFRTIn0.03l0JVvzz8BDtMvIszJv7_82Xp2PonqREH3gUBTgiBA",
      },
      {
        "bodyLength": 1186,
        "json": "{"v":1,"kid":"3eb1bd439947eb76","iat":8639999000000000,"exp":8639999259200000,"engine":"promotion-engine.v2","requestBinding":"d14731e38d0ea655d795e316e8105c806bb7f032508e25dfaeb74d3cebc1f283","codeBinding":"ad12fdb13ff0ab86ff6c711867d7134adcf79d33f834a741be12988ff846b7e2","quoteBinding":"a4228ce776bff1be32f6506de42d4837401230722854c525937ab3219fb6689b","sectionBindings":{"lines":"f243031be94b6ef82fc633e7d79a851c01a026bed82626e51601731704cf1253","discounts":"290e00be947f20320ab22d467893839f76a195721abfb52d1027673cef177312","shipping":"709cde6a9399483a7d933762f0f35c1d1b7fbbb9f4cbb3906824e6e4ceaab5f6","totals":"70dc09ef890359fc72ce417cb3273ef84e2aad25018d31e7b69e1d403bd0b6a3","currency":"6260c00643528784db79a5c736503b46c303d5e73d74bc84edbf527b24f83b83"},"totalMinor":2000000000,"currency":"XTS","ownerQuoteDigest":"ec543690384383929f46a288a7d7550f83802c40752a80c9430311aac18106dd"}",
        "legacyHash": "d3833fb50937b258c6d26aa2799c46edc8deb87138b4215b4690882dbc9f7d4d",
        "rawHash": "1bfcb85ab5f5643d60f2dbebe2aaa361c3d5fb11bb9e142706ed902ddde6f7a9",
        "signature": "cs-YtujAFt5ZB4bEoa9X5FgcsUyqxlgkXA3eUy-D9Hk",
        "token": "eyJ2IjoxLCJraWQiOiIzZWIxYmQ0Mzk5NDdlYjc2IiwiaWF0Ijo4NjM5OTk5MDAwMDAwMDAwLCJleHAiOjg2Mzk5OTkyNTkyMDAwMDAsImVuZ2luZSI6InByb21vdGlvbi1lbmdpbmUudjIiLCJyZXF1ZXN0QmluZGluZyI6ImQxNDczMWUzOGQwZWE2NTVkNzk1ZTMxNmU4MTA1YzgwNmJiN2YwMzI1MDhlMjVkZmFlYjc0ZDNjZWJjMWYyODMiLCJjb2RlQmluZGluZyI6ImFkMTJmZGIxM2ZmMGFiODZmZjZjNzExODY3ZDcxMzRhZGNmNzlkMzNmODM0YTc0MWJlMTI5ODhmZjg0NmI3ZTIiLCJxdW90ZUJpbmRpbmciOiJhNDIyOGNlNzc2YmZmMWJlMzJmNjUwNmRlNDJkNDgzNzQwMTIzMDcyMjg1NGM1MjU5MzdhYjMyMTlmYjY2ODliIiwic2VjdGlvbkJpbmRpbmdzIjp7ImxpbmVzIjoiZjI0MzAzMWJlOTRiNmVmODJmYzYzM2U3ZDc5YTg1MWMwMWEwMjZiZWQ4MjYyNmU1MTYwMTczMTcwNGNmMTI1MyIsImRpc2NvdW50cyI6IjI5MGUwMGJlOTQ3ZjIwMzIwYWIyMmQ0Njc4OTM4MzlmNzZhMTk1NzIxYWJmYjUyZDEwMjc2NzNjZWYxNzczMTIiLCJzaGlwcGluZyI6IjcwOWNkZTZhOTM5OTQ4M2E3ZDkzMzc2MmYwZjM1YzFkMWI3ZmJiYjlmNGNiYjM5MDY4MjRlNmU0Y2VhYWI1ZjYiLCJ0b3RhbHMiOiI3MGRjMDllZjg5MDM1OWZjNzJjZTQxN2NiMzI3M2VmODRlMmFhZDI1MDE4ZDMxZTdiNjllMWQ0MDNiZDBiNmEzIiwiY3VycmVuY3kiOiI2MjYwYzAwNjQzNTI4Nzg0ZGI3OWE1YzczNjUwM2I0NmMzMDNkNWU3M2Q3NGJjODRlZGJmNTI3YjI0ZjgzYjgzIn0sInRvdGFsTWlub3IiOjIwMDAwMDAwMDAsImN1cnJlbmN5IjoiWFRTIiwib3duZXJRdW90ZURpZ2VzdCI6ImVjNTQzNjkwMzg0MzgzOTI5ZjQ2YTI4OGE3ZDc1NTBmODM4MDJjNDA3NTJhODBjOTQzMDMxMWFhYzE4MTA2ZGQifQ.cs-YtujAFt5ZB4bEoa9X5FgcsUyqxlgkXA3eUy-D9Hk",
      },
    ]
  `);
  const token = encode(Buffer.from(JSON.stringify(value)));
  const authenticate = (token: string) => authenticateSelectedOfferReview(token, keyring, requestBinding);
  const review = authenticate(token)!;
  expect(review.tokenDigest).toBe(sha(token));
  expect(review.timing(new Date(exp - 1)).accepted).toBe(true);
  expect(review.timing(new Date(exp)).reason).toBe("expired");
  expect(review.timing(new Date(iat - 60_001)).reason).toBe("not_yet_valid");
  expect(review.timing(new Date(iat - 60_000)).accepted).toBe(true);
  expect(authenticate(encode(Buffer.from(JSON.stringify({ ...value, exp: exp + 1 }))))!.timing(new Date(iat)).reason).toBe("ttl_invalid");
  expect(authenticateSelectedOfferReview(token, { current: "different".repeat(4), previous: current }, requestBinding)).toBeDefined();
  expect(authenticateSelectedOfferReview(token, keyring, { ...requestBinding, offerSelector: "different" })).toBeUndefined();
  for (const invalid of [token + ".", token + "=", "=" + token, encode(Buffer.from([0xff])), encode(Buffer.from("{}null")),
    encode(Buffer.from(JSON.stringify(value)), false), "x".repeat(8193) + "." + "x".repeat(43)]) expect(authenticate(invalid)).toBeUndefined();
  const json = JSON.stringify(value), maxDecoded = 8192 * 3 / 4;
  expect(authenticate(encode(Buffer.from(json.padEnd(maxDecoded))))).toBeDefined();
  expect(authenticate(encode(Buffer.from(json.padEnd(maxDecoded + 1))))).toBeUndefined();
});

it("binds isolated equal-payable price, catalogue, promotion, acquisition and future decisions", async () => {
  const input = await selectedSubscription(), first = buildSelectedSubscriptionOwnerQuote(input);
  const updateEntry = (x: SelectedSubscriptionOwnerInput, role: "actual" | "base") => {
    const result = x.price!.results[0]!;
    if (result.kind !== "subscription_legacy") throw new Error("Expected a legacy observation");
    const entry = role === "actual" ? result.legacyResolved : result.base;
    entry.priceEntryId = x.price!.selectors.find(s => s.sourceOrdinal === 1 && s.role === role)!.value.priceEntryId = id(96);
    const terms = x.quote.quote.context.starterRenewalTerms;
    for (const line of [x.quote.quote.lines[0]!, terms.linePricing[0]!.quoteLine, terms.starterPack.graduation.lines[0]!.quoteLine]) {
      if (line.catalogFacts.version !== "catalog_facts_v1") throw new Error("Expected legacy facts");
      line.catalogFacts[role === "actual" ? "resolvedPriceEntryId" : "basePriceEntryId"] = id(96);
    }
  };
  const altered = [
    (x: typeof input) => updateEntry(x, "actual"), (x: typeof input) => updateEntry(x, "base"),
    (x: typeof input) => { x.price!.selectors[1]!.value.priceEntryId = id(97); },
    (x: typeof input) => { x.price!.selectors[2]!.validTo = "2026-08-01T00:00:00.000Z"; },
    (x: typeof input) => { x.consultedHeads![0]!.revision++; },
    (x: typeof input) => { x.issues[1]!.publicationId = id(98); },
    (x: typeof input) => { x.offer!.version = "2"; },
    (x: typeof input) => { x.decisions.promotions[0]!.revision = "2"; },
    (x: typeof input) => { x.decisions.eligibilityRef += "2"; },
    (x: typeof input) => { x.decisions.promotions[1]!.validTo = "2026-08-01T00:00:00.000Z"; },
    (x: typeof input) => { x.decisions.acquisitionPolicyRef += "2"; },
    (x: typeof input) => { x.decisions.destination = { ref: "owner:destination-δ", digest: "f".repeat(64) }; },
    (x: typeof input) => {
      if (x.phase.applicability === "certified") x.phase.phaseDigest = "9".repeat(64);
    },
    (x: typeof input) => {
      if (x.phase.applicability === "certified" && x.phase.lineBindings[0]!.source !== "legacy") x.phase.lineBindings[0]!.skuRevisionId = id(99);
    },
    (x: typeof input) => { x.phase = { applicability: "absent" }; },
    (x: typeof input) => { x.secondTotalMinor++; },
    (x: typeof input) => { x.request.cadenceDays = x.quote.quote.context.cadenceDays = x.quote.quote.context.starterRenewalTerms.starterPack.starterIntervalDays = 35; },
  ].map(update => { const copy = structuredClone(input); update(copy); return copy; });
  const policy = buildSelectedSubscriptionOwnerQuote(await selectedSubscription(id(11)));
  const otherPolicy = buildSelectedSubscriptionOwnerQuote(await selectedSubscription(id(12)));
  expect(otherPolicy.evidence.policyEvidenceRef).not.toBe(policy.evidence.policyEvidenceRef);
  expect(otherPolicy.evidence.quoteDigest).not.toBe(policy.evidence.quoteDigest);
  const rebuilt = altered.map(buildSelectedSubscriptionOwnerQuote);
  expect(rebuilt.at(-2)!.document.reviewedProjection.secondTotalMinor).toBe(input.secondTotalMinor + 1);
  expect(rebuilt.at(-1)!.document.reviewedProjection.cadenceDays).toBe(35);
  for (const moved of [...rebuilt, policy, otherPolicy]) {
    expect(moved.document.reviewedProjection.totalGross).toEqual(first.document.reviewedProjection.totalGross);
    expect(tagged(moved.document)).not.toBe(tagged(first.document));
    expect(moved.evidence.quoteDigest).not.toBe(first.evidence.quoteDigest);
  }
});

it("refuses malformed coordinates, lossy JSON and unavailable decisions with fixed remedies", async () => {
  const input = await selectedSubscription(), malformed = "Recover the original purchase evidence with its owner and replay the original request.";
  for (const mutate of [
    (x: typeof input) => { x.consultedHeads!.push({ ...x.consultedHeads![0]!, revision: 9 }); },
    (x: typeof input) => { x.price!.selectors.push(x.price!.selectors[0]!); },
    (x: typeof input) => { x.price!.selectors.splice(2, 1); },
    (x: typeof input) => { x.price!.selectors[0]!.role = "actual"; },
    (x: typeof input) => { x.price!.selectors[0]!.value.matchedMinQty = 2 as never; },
    (x: typeof input) => { x.request.lines[0]!.quantity++; },
    (x: typeof input) => { x.quote.quote.context.starterRenewalTerms.linePricing[0]!.quoteLine.catalogFacts.documentDigest = "b".repeat(64); },
    (x: typeof input) => { if (x.phase.applicability === "certified") x.phase.lineBindings[0]!.role = "addon"; },
    (x: typeof input) => { x.offer!.ref = "λ".repeat(121); },
    (x: typeof input) => { delete (x.decisions.destination as Partial<NonNullable<typeof x.decisions.destination>>).digest; },
    (x: typeof input) => { Object.assign(x.quote.quote.context, { unexpected: 1 }); },
    (x: typeof input) => { Object.assign(x.quote.quote.context, { cyclic: x }); },
    (x: typeof input) => { Object.assign(x.quote.quote.context, { atTime: undefined }); },
  ]) {
    const copy = structuredClone(input);
    mutate(copy);
    expect(() => buildSelectedSubscriptionOwnerQuote(copy)).toThrow(malformed);
  }
  input.offer!.ref = "λ".repeat(120);
  expect(buildSelectedSubscriptionOwnerQuote(input).document.offer?.ref).toBe(input.offer!.ref);
  const policy = await selectedSubscription(id(11));
  policy.policyHistory[0]!.effectiveFrom = "2026-08-01T00:00:00.000Z";
  expect(() => buildSelectedSubscriptionOwnerQuote(policy)).toThrow("Use a selection supported on this installation.");
  policy.policyHistory[0]!.effectiveFrom = validFrom;
  policy.policyHistory.push({ ...policy.policyHistory[0]!, id: id(12), revisionNo: 2 });
  expect(() => buildSelectedSubscriptionOwnerQuote(policy)).toThrow("Use a selection supported on this installation.");
  const payload = "a".repeat(1_048_576 - Buffer.byteLength(tagged("")));
  expect(quoteDigest("catalog.owner-quote.v0", payload)).toMatch(/^[0-9a-f]{64}$/u);
  expect(() => quoteDigest("catalog.owner-quote.v0", payload + "a")).toThrow("draft_payload_too_large");
  const depth47 = Array.from({ length: 47 }).reduce<unknown>(value => [value], null);
  expect(quoteDigest("catalog.owner-quote.v0", depth47)).toMatch(/^[0-9a-f]{64}$/u);
  expect(() => quoteDigest("catalog.owner-quote.v0", [depth47])).toThrow("draft_json_depth");
});
