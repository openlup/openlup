import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createBffResponder } from "../../src/bff/index.js";
import type { HttpRequest, HttpResponse } from "../../src/http/index.js";
import { acquisitionCapabilitySchema, createCommerceQuoteBatchHandler, createCommerceQuoteHandler, createCommerceQuoteSchemas, resolvedAcquisitionTermsSchema } from "../../src/pricing/index.js";

const acquisitionTerms = { schemaVersion: "subscription-acquisition.v1" as const, revision: "example-v1",
  delivery2DiscountBps: 2000, initialDiscountBps: 5000, effectiveFrom: new Date(0).toISOString(),
  effectiveTo: new Date(86_400_000).toISOString(), sourcePromotionId: "promotion-example" };
const shippingTerms = { version: "shipping-threshold.v1" as const, currency: "XXX", flatMinor: 1000, freeThresholdMinor: 6000 };
const contextSchema = z.object({ mode: z.enum(["one_time", "subscription"]), cadenceDays: z.number().int().positive(),
  promoCodes: z.array(z.string()).default([]), acquisitionTerms: resolvedAcquisitionTermsSchema,
  shippingTerms: z.object({ version: z.literal("shipping-threshold.v1"), currency: z.literal("XXX"), flatMinor: z.number().int(), freeThresholdMinor: z.number().int() }).strict() }).strict();
const schemas = createCommerceQuoteSchemas({ currencySchema: z.literal("XXX"), productSlugSchema: z.string().min(1), contextSchema });
const createQuoteRequestSchema = schemas.createQuoteRequestSchema.safeExtend({ acquisitionCapability: acquisitionCapabilitySchema.optional() });
const publicCreateQuoteRequestSchema = createQuoteRequestSchema.safeExtend({ promotionAcceptanceToken: z.string().optional() });
const responder = createBffResponder();
const input = { mode: "subscription", cadenceDays: 28, acquisitionCapability: "subscription-acquisition.v1", lines: [{ sku: "EXAMPLE-SKU", quantity: 1 }] };
const money = (amountMinor: number) => ({ amountMinor, currency: "XXX" });
function receipt(revision = "example-v1", flatMinor = 1000) {
  return { contractVersion: "commerce.v0" as const, quote: { currency: "XXX", taxIncluded: true as const,
    lines: [{ sku: "EXAMPLE-SKU", productSlug: "item-a", quantity: 1, unitPriceGross: money(1000), lineSubtotalGross: money(1000),
      tax: { included: true as const, country: "AA", category: "standard", vatRateBps: 0, legalBasis: "example", netAmount: money(1000), vatAmount: money(0), grossAmount: money(1000) } }],
    discounts: [], subtotalGross: money(1000), discountTotalGross: money(0), totalGross: money(1000), netTotal: money(1000), taxTotal: money(0),
    context: { mode: "subscription" as const, cadenceDays: 28, promoCodes: [], acquisitionTerms: { ...acquisitionTerms, revision }, shippingTerms: { ...shippingTerms, flatMinor } } } };
}
function request(body: unknown): HttpRequest { return { method: "POST", body, headers: {}, query: {} } as HttpRequest; }
function response() {
  const res = { status: vi.fn(), json: vi.fn(), setHeader: vi.fn(), end: vi.fn() };
  res.status.mockReturnValue(res);
  return res as typeof res & HttpResponse;
}
afterEach(() => vi.restoreAllMocks());
describe("commerce quote composition characterization W4", () => {
  it("forwards literal acquisition and shipping terms through single composition to acceptance and output", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const quotePort = { createQuote: vi.fn().mockResolvedValue(receipt()) };
    const accept = vi.fn(() => "example-acceptance"), res = response();
    await createCommerceQuoteHandler({ responder, ...schemas, createQuoteRequestSchema, publicCreateQuoteRequestSchema,
      quotePort, createPromotionAcceptance: accept, acquisition: { terms: quote => quote.context?.acquisitionTerms },
      shipping: { terms: quote => quote.context?.shippingTerms } })(request(input), res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(accept).toHaveBeenCalledOnce();
    expect(accept.mock.calls[0]).toEqual([{ ...input, promoCodes: [] }, receipt().quote, acquisitionTerms, shippingTerms]);
    expect(res.json.mock.calls[0]?.[0]).toMatchObject({ ok: true, data: { promotionAcceptanceToken: "example-acceptance",
      quote: { context: { acquisitionTerms, shippingTerms } } } });
  });
  it("preserves literal acquisition and shipping outputs in batch request order without issuing acceptance", async () => {
    const quotePort = { createQuote: vi.fn().mockResolvedValueOnce(receipt()).mockResolvedValueOnce(receipt("example-v2", 1200)) };
    const res = response();
    await createCommerceQuoteBatchHandler({ responder, quotePort,
      createQuoteBatchRequestSchema: z.object({ quotes: z.array(createQuoteRequestSchema).min(1).max(8) }),
      publicCreateQuoteBatchResponseSchema: schemas.publicCreateQuoteBatchResponseSchema })(request({ quotes: [input, input] }), res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(quotePort.createQuote.mock.calls).toEqual(Array.from({ length: 2 }, () => [{ ...input, promoCodes: [] }, { clientId: null }]));
    const payload = res.json.mock.calls[0]?.[0];
    expect(payload).toMatchObject({ ok: true, data: { quotes: [
      { context: { acquisitionTerms, shippingTerms } },
      { context: { acquisitionTerms: { ...acquisitionTerms, revision: "example-v2" }, shippingTerms: { ...shippingTerms, flatMinor: 1200 } } },
    ] } });
    expect(JSON.stringify(payload)).not.toContain("promotionAcceptanceToken");
  });
});
