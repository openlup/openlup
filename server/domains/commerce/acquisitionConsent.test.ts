import { describe, expect, it, vi } from "vitest";
import { projectPromotionQuoteMoney, promotionQuoteMoneySections } from "./promotionQuoteBinding.js";
import { issuePromotionQuoteAcceptance, verifyPromotionQuoteAcceptanceWithOutcome } from "./promotionQuoteAcceptance.js";
import { AT, terms, quote, request, response, schemas, responder } from "./acquisitionConsent.testFixtures.js";
import { createCommerceQuoteHandler, createOfferPolicyReadinessCache, OFFER_POLICY_V2_READINESS_CONTRACT, AcquisitionTermsError } from "@openlup/platform/pricing";
const keyring = { current: "example-fixture-key-".repeat(3) };
const now = new Date(AT);
const quoteWithCode = { ...quote, discounts: [{ promotionId: "example", appliesTo: "order_total" as const,
  amountOffMinor: 0, reasonCode: "promotion_code_v2", promotionEngineVersion: "promotion-engine.v2" as const }] };
describe("explicit acquisition consent bridge", () => {
  it("binds the exact resolved terms to whole money and totals while absent terms add no property", () => {
    expect(projectPromotionQuoteMoney(quote, terms).acquisitionTerms).toBe(terms);
    expect(promotionQuoteMoneySections(quote, terms).totals).toMatchObject({ acquisitionTerms: terms });
    expect(Object.hasOwn(projectPromotionQuoteMoney(quote), "acquisitionTerms")).toBe(false);
    expect(Object.hasOwn(promotionQuoteMoneySections(quote).totals as object, "acquisitionTerms")).toBe(false);
    expect(Object.keys(promotionQuoteMoneySections(quote, terms))).toEqual(["lines", "discounts", "shipping", "totals", "currency"]);
  });
  it("issues and honors terms-only tokens and rejects a changed promise at the same money", () => {
    const token = issuePromotionQuoteAcceptance({ request: request as never, quote, acquisitionTerms: terms, keyring, now })!;
    expect(token).toBeTypeOf("string");
    const input = { token, request: request as never, quote, acquisitionTerms: terms, expectedTotal: quote.totalGross, keyring, now };
    expect(verifyPromotionQuoteAcceptanceWithOutcome(input).accepted).toBe(true);
    expect(verifyPromotionQuoteAcceptanceWithOutcome({ ...input, acquisitionTerms: { ...terms, delivery2DiscountBps: 1900 } })).toMatchObject({ accepted: false, reason: "quote_mismatch", mismatchField: "totals" });
    expect(verifyPromotionQuoteAcceptanceWithOutcome({ ...input, acquisitionTerms: undefined }).accepted).toBe(false);
  });
  it("preserves inactive quote/readiness transcripts and fixed historical token bytes", async () => {
    const token = issuePromotionQuoteAcceptance({ request: request as never, quote: quoteWithCode, keyring, now });
    expect(token).toBe(FIXED_TOKEN);
    expect(verifyPromotionQuoteAcceptanceWithOutcome({ token: FIXED_TOKEN, request: request as never,
      quote: quoteWithCode, expectedTotal: quote.totalGross, keyring, now }).accepted).toBe(true);
    expect(issuePromotionQuoteAcceptance({ request: request as never, quote, keyring, now })).toBeNull();
    const cache = createOfferPolicyReadinessCache({ now: () => Date.parse(AT) });
    const read = vi.fn(async () => ({ contractVersion: OFFER_POLICY_V2_READINESS_CONTRACT, ready: true,
      checkedAt: AT, reasons: [], evidence: { acquisition: "ignored" } }));
    expect(await cache.read({ readOfferPolicyV2Readiness: read })).toEqual({ contractVersion: OFFER_POLICY_V2_READINESS_CONTRACT, ready: true, checkedAt: AT, reasons: [] });
    await cache.read({ readOfferPolicyV2Readiness: read }); expect(read).toHaveBeenCalledOnce();
    const quotePort = { createQuote: vi.fn(async () => ({ contractVersion: "commerce.v0" as const, quote })) };
    const out = response();
    const deps = { ...schemas, responder, quotePort };
    await createCommerceQuoteHandler(deps)({ method: "POST", body: request } as never, out.res);
    expect(out.transcript.status).toBe(200);
    expect(out.transcript.body).toEqual({ ok: true, data: { contractVersion: "commerce.v0", quote }, meta: { contractVersion: "commerce.v0" } });
    expect(quotePort.createQuote.mock.calls).toEqual([[request, { clientId: null }]]);
    const refused = response();
    await createCommerceQuoteHandler({ ...deps, quotePort: { createQuote: async () => { throw new AcquisitionTermsError("acquisition_terms_capability_required"); } } })({ method: "POST", body: request } as never, refused.res);
    expect(refused.transcript.status).toBe(503);
    expect(refused.transcript.body).toEqual({ ok: false, error: { code: "UPSTREAM_UNAVAILABLE", message: "Commerce quote failed", details: { reason: "quote_dependency_failed", stage: "quote_evaluation" } } });
  });
});
const FIXED_TOKEN = "eyJ2IjoxLCJraWQiOiI4NWQyY2I1ZDk5NGU1ZWJmIiwiaWF0IjoxNzkwODEyODAwMDAwLCJleHAiOjE3OTEwNzIwMDAwMDAsImVuZ2luZSI6InByb21vdGlvbi1lbmdpbmUudjIiLCJyZXF1ZXN0QmluZGluZyI6ImJlNzM2ZjBmMmU1MTM3MDlmZGU3YzI0N2RhMzE3ZDdlNzI2YzgxNWEyYTliYzQ5YmQwY2ZhMTgxMDMwOThlN2QiLCJjb2RlQmluZGluZyI6IjgwZjdmMjUxMDc0NjA3NGQ1YmE4YzI2NThjNGJmYmFiYjEzNTI2MzYyNjVlNTU2ZDMzYzY0MDQ2Mjg1NGZkMmIiLCJxdW90ZUJpbmRpbmciOiIyNWFlOWE4MmE4YjFiYjgwZTdiN2ZkZmMwMWU2MmU3NmEyZTE4ZGVlZWRlNWRlZGQ3ZDM5ZWMzZGIxNmU2YmE2Iiwic2VjdGlvbkJpbmRpbmdzIjp7ImxpbmVzIjoiNDgxN2E2MjM3YjJmOWRjZTQwNGM5YmQ4ZTkzZjMxNWFkMDNiNjliZjM4MWY1Zjc2YTNjYWI3YjdhNGQyNjY3OCIsImRpc2NvdW50cyI6IjkxNmI0MjExYzZmZGM2YTE4N2IyNjU0YTVjMGU5ODhlOGE2MmIzMmY2OGI2NDk2YThhMmRlYjJhYzMzYmViMjkiLCJzaGlwcGluZyI6ImMyOGEzY2EwYWI3NjE3YTMwZjdmYzFjN2EzNTczZjg2ODc5YmVlMDFkMDczM2RlYjk1NDkwMGFlMDY1Zjc5ZjAiLCJ0b3RhbHMiOiI2N2JhZmQzODM1ZGQwMWU0MmJlZTdhNTY4MzYxZGY0ZDc4ZmY4Yjg5YzM0ZTA4YmZjMWY4NDAzZTliOTA4OGYwIiwiY3VycmVuY3kiOiI3ZGI5ODVlMWZiYzk5ODkyOTg0M2ZjY2FjZGQzZTJhYzRjYmRmZGFmYjI0YmQ0M2IxNDM5NWRmYzZmNjcyNmViIn0sInRvdGFsTWlub3IiOjEyMDAsImN1cnJlbmN5IjoiWFhYIn0.QOA17a7q-PyLqTI6Z0SOc17t3c-RT_Gpqv_g8wGYkZw";
