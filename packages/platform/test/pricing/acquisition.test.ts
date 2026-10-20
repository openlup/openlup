import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { selectAcquisitionTerms, filterAcquisitionPromotions, assertAcquisitionTermsCapability,
  AcquisitionTermsError, ACQUISITION_TERMS_CAPABILITY as CAP, acquisitionExpectationChanged,
  createCommerceQuoteHandler, createCommerceQuoteBatchHandler, createCommerceOfferPricingHandler,
  createAcquisitionOfferPricingHandler, createAcquisitionOfferPricingSchema, projectAcquisitionOfferPricing,
  acquisitionProjectionFreshness, projectAcquisitionTerms, createAcquisitionReadinessCache,
  OFFER_POLICY_V2_READINESS_CONTRACT, ACQUISITION_READINESS_CONTRACT, type AcquisitionFinancialPolicy,
} from "../../src/pricing/index.js";
import { AT, END, terms, row, policy, metadata, quote, request, pricingPolicy, responder,
  response, schemas, offerSchemas, offerV1, offerV2, type Row } from "./acquisitionFixtures.js";
const missing = undefined as unknown as AcquisitionFinancialPolicy<Row>;
const v3Schema = createAcquisitionOfferPricingSchema(offerSchemas.commerceOfferPricingV2ResponseSchema);
const v3 = { ...offerV2, contractVersion: "commerce.offer-pricing.v3" as const,
  ...acquisitionProjectionFreshness(projectAcquisitionTerms(terms), AT) };
const headers = { "x-commerce-acquisition-capability": CAP, "x-commerce-offer-policy-capability": "commerce.offer-policy.v2", "x-commerce-visitor-id": "example" };
function offerHandler(overrides: Partial<Parameters<typeof createAcquisitionOfferPricingHandler>[0]> = {}) {
  return createAcquisitionOfferPricingHandler({ responder, commerceOfferPricingResponseSchema: v3Schema,
    incumbentHandler: async () => { throw new Error("unexpected incumbent"); }, readOfferPricing: async () => v3,
    resolvePricingPolicy: () => pricingPolicy, ...overrides });
}
function errorDetails(transcript: ReturnType<typeof response>["transcript"]) {
  return (transcript.body as { error: { details: unknown } }).error.details;
}
describe("opt-in acquisition", () => {
  it("selects adjacent half-open windows with normalized future boundaries and scope", () => {
    const later = row({ id: "target-b", validFrom: END, validTo: null, metadata: { ...metadata, revision: "example-b" } });
    const rows = [row({ validFrom: "2026-10-01T02:00:00+02:00" }), later, row({ regionCodes: ["YY"], metadata: {} }), row({ active: false, metadata: {} })];
    expect(selectAcquisitionTerms(rows, AT, "ZZ", policy)).toMatchObject({ terms, nextBoundaryAt: END });
    expect(selectAcquisitionTerms(rows, END, "ZZ", policy)).toMatchObject({ terms: { revision: "example-b" }, nextBoundaryAt: null });
    expect(selectAcquisitionTerms(rows, "2026-10-03T00:00:00Z", "ZZ", policy)?.sourcePromotionId).toBe("target-b");
    expect(() => selectAcquisitionTerms(rows, "2026-09-30T00:00:00Z", "ZZ", policy)).toThrow("acquisition_terms_not_effective");
  });
  it("refuses a future gap while an earlier interval is current", () => {
    expect(() => selectAcquisitionTerms([row(), row({ validFrom: "2026-10-03T00:00:00Z", validTo: null, metadata: { ...metadata, revision: "example-b" } })], AT, "ZZ", policy)).toThrow("acquisition_terms_not_effective");
  });
  it("refuses overlap and duplicate family ambiguity", () => {
    expect(() => selectAcquisitionTerms([row(), row()], AT, "ZZ", policy)).toThrow("acquisition_terms_ambiguous");
    expect(() => selectAcquisitionTerms([row(), row({ validFrom: "2026-10-01T01:00:00Z", metadata: { ...metadata, revision: "example-b" } })], AT, "ZZ", policy)).toThrow("acquisition_terms_ambiguous");
  });
  it("validates future tagged rows before fallback and never infers missing policy", () => {
    expect(() => selectAcquisitionTerms([row(), row({ validFrom: END, metadata: {} })], AT, "ZZ", policy)).toThrow("acquisition_terms_invalid");
    expect(() => selectAcquisitionTerms([row({ mirrorOf: "missing" })], AT, "ZZ", policy)).toThrow("acquisition_terms_invalid");
    expect(() => selectAcquisitionTerms([], "invalid", "ZZ", missing)).toThrow("acquisition_terms_policy_unconfigured");
    expect(() => filterAcquisitionPromotions([], AT, "ZZ", missing)).toThrow("acquisition_terms_policy_unconfigured");
    const strict = { ...policy, validateMetadata() { throw new AcquisitionTermsError("acquisition_terms_invalid"); } };
    expect(() => selectAcquisitionTerms([row()], AT, "ZZ", strict)).toThrow("acquisition_terms_invalid");
    expect(() => selectAcquisitionTerms([row({ rate: "2300" })], AT, "ZZ", policy)).toThrow("acquisition_terms_invalid");
  });
  it("selects the synthetic unconfigured pair and refuses a known ended pair", () => {
    const legacy = row({ id: "baseline", kind: "baseline", metadataPresent: false });
    const mirror = row({ mirrorOf: "baseline", metadataPresent: false });
    expect(selectAcquisitionTerms([legacy, mirror], AT, "ZZ", policy)).toMatchObject({ kind: "legacy_unconfigured", terms });
    expect(() => selectAcquisitionTerms([legacy, mirror], END, "ZZ", policy)).toThrow("acquisition_terms_not_effective");
    expect(selectAcquisitionTerms([], AT, "ZZ", policy)).toBeNull();
  });
  it("requires standalone capability then engine, exempts paired terms, preserves ordinary coupons", () => {
    const selected = selectAcquisitionTerms([row()], AT, "ZZ", policy);
    expect(() => assertAcquisitionTermsCapability(selected, null, null)).toThrow("acquisition_terms_capability_required");
    expect(() => assertAcquisitionTermsCapability(selected, CAP, null)).toThrow("acquisition_terms_v2_required");
    expect(() => assertAcquisitionTermsCapability(selected, CAP, "promotion-engine.v2")).not.toThrow();
    const pair = selectAcquisitionTerms([row({ id: "baseline", kind: "baseline" }), row({ mirrorOf: "baseline" })], AT, "ZZ", policy);
    expect(() => assertAcquisitionTermsCapability(pair, null, null)).not.toThrow();
    const ordinary = row({ kind: "ordinary", metadataPresent: false });
    const inactive = row({ active: false });
    expect(filterAcquisitionPromotions([ordinary, row()], END, "ZZ", policy)).toEqual([ordinary]);
    expect(filterAcquisitionPromotions([inactive], AT, "ZZ", policy)).toEqual([inactive]);
  });
  it("compares promises asymmetrically, independently of initial money", () => {
    expect(acquisitionExpectationChanged(undefined, undefined)).toBe(false);
    expect(acquisitionExpectationChanged(metadata, terms)).toBe(false);
    expect(acquisitionExpectationChanged(metadata, { ...terms, initialDiscountBps: 2900 })).toBe(false);
    expect(acquisitionExpectationChanged(metadata, undefined)).toBe(true);
    expect(acquisitionExpectationChanged(metadata, { ...terms, revision: "example-b" })).toBe(true);
    expect(acquisitionExpectationChanged(metadata, { ...terms, delivery2DiscountBps: 1900 })).toBe(true);
  });
  it("maps quote/batch refusals and rejects an unsigned acquisition fallback", async () => {
    const quoteWithTerms = { ...quote, acquisitionTerms: terms };
    const extended = schemas.createQuoteResponseSchema.extend({ quote: schemas.createQuoteResponseSchema.shape.quote.safeExtend({ acquisitionTerms: z.unknown().optional() }) });
    const deps = { responder, createQuoteRequestSchema: schemas.createQuoteRequestSchema, createQuoteResponseSchema: extended,
      publicCreateQuoteRequestSchema: schemas.publicCreateQuoteRequestSchema, publicCreateQuoteResponseSchema: extended.safeExtend({ promotionAcceptanceToken: z.string().optional() }),
      acquisition: { terms: (value: unknown) => (value as typeof quoteWithTerms).acquisitionTerms },
      quotePort: { createQuote: async () => ({ contractVersion: "commerce.v0" as const, quote: quoteWithTerms }) } };
    const fallback = vi.fn(deps.quotePort.createQuote);
    const out = response();
    await createCommerceQuoteHandler({ ...deps, fallbackQuotePort: { createQuote: fallback } })({ method: "POST", body: request }, out.res);
    expect(out.transcript.status).toBe(409); expect(fallback).toHaveBeenCalledOnce();
    const accepted = response();
    await createCommerceQuoteHandler({ ...deps, fallbackQuotePort: { createQuote: async () => ({ contractVersion: "commerce.v0", quote }) } })({ method: "POST", body: request }, accepted.res);
    expect(accepted.transcript.status).toBe(200);
    const refusal = response();
    const quotePort = { createQuote: async () => { throw new AcquisitionTermsError("acquisition_terms_capability_required"); } };
    await createCommerceQuoteHandler({ ...deps, quotePort })({ method: "POST", body: request }, refusal.res);
    expect(errorDetails(refusal.transcript)).toEqual({ reason: "acquisition_terms_capability_required", refreshRequired: true });
    const batch = response();
    await createCommerceQuoteBatchHandler({ responder, acquisition: deps.acquisition, quotePort,
      createQuoteBatchRequestSchema: schemas.createQuoteBatchRequestSchema, publicCreateQuoteBatchResponseSchema: schemas.publicCreateQuoteBatchResponseSchema })(
        { method: "POST", body: { quotes: [request] } }, batch.res);
    expect(batch.transcript.status).toBe(409);
  });
  it("projects negotiated v3 with pinned capability, strict freshness and private headers", async () => {
    const requestFor = vi.fn((_product, mode) => ({ ...request, mode }));
    const result = await projectAcquisitionOfferPricing({ quoteCatalogReadPort: { listQuoteCatalogItems: async () => [{ productSlug: "item" } as never] },
      quoteWithPromotions: { createQuote: async () => ({ contractVersion: "commerce.v0", quote }) },
      quoteWithoutPromotions: { createQuote: async () => ({ contractVersion: "commerce.v0", quote }) },
      isOfferProduct: () => true, requestFor, unitCount: 1, minimumProductPayableMinor: 7, scopeV1: "products", scopeV2: "products-v2",
      pricingPolicy, acquisitionTerms: projectAcquisitionTerms(terms), observedAt: AT });
    expect(v3Schema.parse(result)).toEqual(result);
    expect(result.validUntil).toBe("2026-10-01T00:01:00.000Z");
    expect(requestFor).toHaveBeenCalledTimes(4);
    expect(requestFor.mock.calls[0]?.[2]).toEqual({ acquisitionCapability: CAP, atTime: AT });
    expect(acquisitionProjectionFreshness(projectAcquisitionTerms(terms), AT, "2026-10-01T00:00:12Z").validUntil).toBe("2026-10-01T00:00:12.000Z");
    expect(v3Schema.safeParse({ ...result, extra: true }).success).toBe(false);
    expect(v3Schema.safeParse({ ...result, validUntil: END }).success).toBe(false);
    const out = response(); await offerHandler()({ method: "GET", headers }, out.res);
    expect(out.transcript.status).toBe(200);
    expect(out.transcript.headers["Cache-Control"]).toBe("private, no-store");
    expect(out.transcript.headers.Vary).toBe("x-commerce-acquisition-capability, x-commerce-offer-policy-capability, x-commerce-pricing-policy-token, x-commerce-visitor-id");
  });
  it("refuses unsupported negotiation without downgrading or leaking dependency details", async () => {
    const invalid = response(); await offerHandler()({ method: "GET", headers: { ...headers, "x-commerce-acquisition-capability": [CAP] } }, invalid.res);
    expect(invalid.transcript.status).toBe(400);
    const missingPolicy = response(); await offerHandler({ requirePricingPolicy: true })({ method: "GET", headers: { "x-commerce-acquisition-capability": CAP } }, missingPolicy.res);
    expect(errorDetails(missingPolicy.transcript)).toEqual({ reason: "pricing_policy_request_invalid", stage: "pricing_policy", policyReason: "v2_capability_required" });
    const mismatch = response(); await offerHandler({ readOfferPricing: async () => offerV2 })({ method: "GET", headers }, mismatch.res);
    expect(mismatch.transcript.status).toBe(502);
    const unconfigured = response(); await offerHandler({ readOfferPricing: async () => { throw new AcquisitionTermsError("acquisition_terms_policy_unconfigured"); } })({ method: "GET", headers }, unconfigured.res);
    expect(unconfigured.transcript.status).toBe(503);
    expect(errorDetails(unconfigured.transcript)).toEqual({ reason: "offer_pricing_projection_unavailable" });
    const unavailable = response(); await offerHandler({ resolvePricingPolicy: () => { throw new Error("private dependency"); } })({ method: "GET", headers }, unavailable.res);
    expect(errorDetails(unavailable.transcript)).toEqual({ reason: "offer_pricing_policy_unavailable" });
    const unpaired = response(); await offerHandler({ resolvePricingPolicy: () => undefined })({ method: "GET", headers }, unpaired.res);
    expect(unpaired.transcript.status).toBe(400);
  });
  it("expires readiness at a boundary, rereads once and refuses repeated stale green", async () => {
    let now = Date.parse(AT);
    const boundary = "2026-10-01T00:00:10.000Z";
    const { schemaVersion: _schema, sourcePromotionId: _source, ...publicTerms } = terms;
    const evidence = { ...publicTerms, contractVersion: ACQUISITION_READINESS_CONTRACT, kind: "v2_standalone", legacyPairCount: 0, standaloneCount: 1, nextBoundaryAt: boundary };
    const ready = { contractVersion: OFFER_POLICY_V2_READINESS_CONTRACT, ready: true, reasons: [], checkedAt: AT, evidence: { acquisition: evidence } };
    const read = vi.fn(async () => ready);
    const cache = createAcquisitionReadinessCache({ policy, now: () => now });
    expect((await cache.read({ readOfferPolicyV2Readiness: read })).ready).toBe(true);
    now += 9000; await cache.read({ readOfferPolicyV2Readiness: read }); expect(read).toHaveBeenCalledTimes(1);
    now += 1000;
    expect((await cache.read({ readOfferPolicyV2Readiness: read })).reasons).toEqual(["readiness_acquisition_boundary_elapsed"]);
    expect(read).toHaveBeenCalledTimes(3);
    cache.clear();
    expect((await cache.read({ readOfferPolicyV2Readiness: async () => ({ ...ready, evidence: { acquisition: { ...evidence, standaloneCount: 2 } } }) })).reasons).toEqual(["readiness_contract_invalid"]);
    cache.clear();
    expect((await cache.read({ readOfferPolicyV2Readiness: async () => ({ ...ready, evidence: undefined }) })).ready).toBe(true);
  });
  it("keeps activation-off offer transcripts, arguments and read counts unchanged including ignored headers", async () => {
    const read = vi.fn(async () => offerV1);
    const resolve = vi.fn();
    const incumbent = createCommerceOfferPricingHandler({ responder, commerceOfferPricingResponseSchema: offerSchemas.commerceOfferPricingResponseSchema,
      readOfferPricing: read, resolvePricingPolicy: resolve });
    const plain = response(); const ignored = response();
    await incumbent({ method: "GET" }, plain.res);
    await incumbent({ method: "GET", headers: { "x-commerce-acquisition-capability": "unknown" } }, ignored.res);
    expect(JSON.stringify(ignored.transcript)).toBe(JSON.stringify(plain.transcript));
    expect(plain.transcript).toEqual({ status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=0, s-maxage=5, must-revalidate" },
      body: { ok: true, data: offerV1, meta: { contractVersion: "commerce.offer-pricing.v1" } } });
    expect(read.mock.calls).toEqual([[undefined], [undefined]]); expect(resolve).not.toHaveBeenCalled();
    const delegated = response(); await offerHandler({ incumbentHandler: incumbent })({ method: "GET" }, delegated.res);
    expect(delegated.transcript).toEqual(plain.transcript);
    const failure = response();
    await createCommerceOfferPricingHandler({ responder, commerceOfferPricingResponseSchema: offerSchemas.commerceOfferPricingResponseSchema,
      readOfferPricing: async () => { throw new Error("unavailable"); } })({ method: "GET", headers }, failure.res);
    expect(failure.transcript.body).toEqual({ ok: false, error: { code: "UPSTREAM_UNAVAILABLE", message: "Commerce offer pricing is unavailable" } });
  });
});
