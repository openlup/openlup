import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createPromotionQuoteAcceptance, projectPromotionQuoteMoney, promotionQuoteMoneySections } from "../../src/promotions/index.js";
import { createCommerceQuoteHandler, createCommerceQuoteSchemas, projectPublicQuoteSnapshot, type CommerceQuote, type CreateQuoteResponse } from "../../src/pricing/index.js";
import type { ShippingTerms } from "../../src/shipping/contracts/index.js";
import type { HttpRequest } from "../../src/http/index.js";
import { quote, request, response, responder } from "../pricing/acquisitionFixtures.js";

const terms: ShippingTerms = { version: "shipping-threshold.v1", currency: "XXX", flatMinor: 200, freeThresholdMinor: 1400 };
const keyring = { current: "synthetic-consent-key-000000000000000000" };
const now = new Date("2026-10-01T00:00:00.000Z");
const acceptance = createPromotionQuoteAcceptance<typeof request>({ projectRequest: value => value });
const input = { request, quote, keyring, now };
const schemas = createCommerceQuoteSchemas({ currencySchema: z.literal("XXX"), productSlugSchema: z.string(),
  contextSchema: z.object({ mode: z.enum(["one_time", "subscription"]), promoCodes: z.array(z.string()), shippingTerms: z.unknown().optional() }) });
const deps = { ...schemas, responder,
  publicCreateQuoteRequestSchema: schemas.createQuoteRequestSchema.safeExtend({ promotionAcceptanceToken: z.string().optional() }),
  publicCreateQuoteResponseSchema: schemas.createQuoteResponseSchema.safeExtend({ promotionAcceptanceToken: z.string().optional() }) };
function snapshot(shippingTerms?: ShippingTerms, v2 = false): CreateQuoteResponse {
  return { contractVersion: "commerce.v0", quote: { ...quote,
    ...(v2 ? { discounts: [{ promotionId: "11111111-1111-4111-8111-111111111111", appliesTo: "order_total", amountOffMinor: 1,
      reasonCode: "promotion_code_v2", promotionEngineVersion: "promotion-engine.v2", code: "SAVE", promotionCodeId: "22222222-2222-4222-8222-222222222222",
      promotionCodeRevision: 1, promotionDefinitionFingerprint: "a".repeat(64), promotionCodeScopes: ["subscription_initial"],
      promotionMinimumReferenceMinor: 0, promotionCodeValidTo: null, promotionBenefitKind: "fixed_amount", promotionBenefitValueMinor: 1, floorApplied: false }],
      discountTotalGross: { amountMinor: 1, currency: "XXX" }, totalGross: { amountMinor: 1199, currency: "XXX" }, netTotal: { amountMinor: 1199, currency: "XXX" } } : {}),
    context: { mode: request.mode, promoCodes: [], ...(shippingTerms ? { shippingTerms } : {}) } } };
}
const shipping = { terms: (value: CommerceQuote) => (value.context as { shippingTerms?: ShippingTerms } | undefined)?.shippingTerms };
const req = (body: unknown = request) => ({ method: "POST", body }) as HttpRequest;

describe("shipping consent parity", () => {
  it("issues and verifies shipping-only consent while omission remains no-adjustment", () => {
    expect(acceptance.issuePromotionQuoteAcceptance(input)).toBeNull();
    const token = acceptance.issuePromotionQuoteAcceptance({ ...input, shippingTerms: terms })!;
    expect(token).toBeTypeOf("string");
    expect(acceptance.verifyPromotionQuoteAcceptance({ ...input, shippingTerms: terms, token, expectedTotal: quote.totalGross })).toBe(true);
  });
  it("refuses a same-money shipping promise mutation in the shipping section", () => {
    const token = acceptance.issuePromotionQuoteAcceptance({ ...input, shippingTerms: terms })!;
    expect(acceptance.verifyPromotionQuoteAcceptanceWithOutcome({ ...input, token, expectedTotal: quote.totalGross,
      shippingTerms: { ...terms, freeThresholdMinor: 1401 } })).toMatchObject({ accepted: false, reason: "quote_mismatch", mismatchField: "shipping" });
  });
  it("refuses removed shipping promises before the no-adjustment check", () => {
    const token = acceptance.issuePromotionQuoteAcceptance({ ...input, shippingTerms: terms })!;
    expect(acceptance.verifyPromotionQuoteAcceptanceWithOutcome({ ...input, token, expectedTotal: quote.totalGross }))
      .toMatchObject({ accepted: false, reason: "quote_mismatch", mismatchField: "shipping" });
  });
  it("binds identical public and strict money while ignoring server facts", () => {
    const strict = { ...snapshot(terms), quote: { ...snapshot(terms).quote, lines: quote.lines.map(line => ({ ...line, catalogFacts: { version: "catalog_facts_v1" as const, skuId: "sku", documentRevisionId: "revision", documentDigest: "a".repeat(64),
      basePriceEntryId: "base", atTime: "2026-10-01T00:00:00.000Z", currency: "XXX", resolvedUnitAmountMinor: 1200,
      resolvedLineAmountMinor: 1200, baseUnitAmountMinor: 1200, resolvedPriceEntryId: "resolved", mode: "subscription" as const } })) } };
    const publicQuote = projectPublicQuoteSnapshot(strict).quote;
    expect(publicQuote.lines[0]).not.toHaveProperty("catalogFacts");
    expect(projectPromotionQuoteMoney(strict.quote, undefined, terms)).toEqual(projectPromotionQuoteMoney(publicQuote, undefined, terms));
    expect(promotionQuoteMoneySections(publicQuote, undefined, terms).shipping).toMatchObject({ shippingTerms: terms });
    expect(projectPromotionQuoteMoney(publicQuote)).toEqual(projectPromotionQuoteMoney(publicQuote, undefined, undefined));
    const token = acceptance.issuePromotionQuoteAcceptance({ ...input, quote: publicQuote, shippingTerms: terms })!;
    expect(acceptance.verifyPromotionQuoteAcceptance({ ...input, quote: strict.quote, token, shippingTerms: terms, expectedTotal: quote.totalGross })).toBe(true);
  });
  it("refuses unsigned shipping before attempting promotion fallback", async () => {
    const fallback = { createQuote: vi.fn(async () => snapshot()) };
    const result = response();
    await createCommerceQuoteHandler({ ...deps, quotePort: { createQuote: async () => snapshot(terms, true) }, fallbackQuotePort: fallback, shipping })(req(), result.res);
    expect(result.transcript.body).toMatchObject({ error: { code: "CONFLICT", message: "Shipping quote must be refreshed" } });
    expect(fallback.createQuote).not.toHaveBeenCalled();
  });
  it("rejects a promotion fallback that retains shipping promises", async () => {
    const fallback = { createQuote: vi.fn(async () => snapshot(terms)) };
    const result = response();
    await createCommerceQuoteHandler({ ...deps, quotePort: { createQuote: async () => snapshot(undefined, true) }, fallbackQuotePort: fallback, shipping })(req(), result.res);
    expect(fallback.createQuote).toHaveBeenCalledOnce();
    expect(result.transcript.body).toMatchObject({ error: { code: "CONFLICT", message: "Promotion quote must be refreshed" } });
  });
  it("preserves incumbent token bytes when the shipping seam is omitted", () => {
    const adjusted = { ...quote, discounts: [{ promotionId: "adjustment", appliesTo: "order_total" as const, amountOffMinor: 0,
      reasonCode: "promotion_code_v2", promotionEngineVersion: "promotion-engine.v2" as const }] };
    const token = acceptance.issuePromotionQuoteAcceptance({ ...input, quote: adjusted })!;
    expect(token).toBe(acceptance.issuePromotionQuoteAcceptance({ ...input, quote: adjusted, shippingTerms: undefined }));
    expect(createHash("sha256").update(token).digest("hex")).toBe("276cdedf08689a08a03ebead81cd0135a4c14a8f622a2eef83100d4b425edc8d");
  });
  it("propagates shipping terms to issue and honor while omitted callbacks keep their arity", async () => {
    const issue = vi.fn(() => "signed");
    const honor = vi.fn(() => true);
    const result = response();
    await createCommerceQuoteHandler({ ...deps, quotePort: { createQuote: async () => snapshot(terms) }, shipping, createPromotionAcceptance: issue })(req(), result.res);
    expect(issue.mock.calls[0]).toEqual([request, snapshot(terms).quote, undefined, terms]);
    expect(result.transcript.body).toMatchObject({ data: { promotionAcceptanceToken: "signed" } });
    await createCommerceQuoteHandler({ ...deps, quotePort: { createQuote: async () => snapshot(terms) }, shipping, honorPromotionAcceptance: honor, createPromotionAcceptance: issue })(req({ ...request, promotionAcceptanceToken: "prior" }), response().res);
    expect(honor.mock.calls[0]).toEqual(["prior", request, snapshot(terms).quote, undefined, terms]);
    issue.mockClear();
    await createCommerceQuoteHandler({ ...deps, quotePort: { createQuote: async () => snapshot(terms) }, createPromotionAcceptance: issue })(req(), response().res);
    expect(issue.mock.calls[0]).toHaveLength(3);
  });
});
