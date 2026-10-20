import { z } from "zod";
import { createBffResponder } from "@openlup/platform/bff";
import type { HttpResponse } from "@openlup/platform/http";
import { ACQUISITION_TERMS_CAPABILITY, createCommerceQuoteSchemas, type CommerceQuote, type CreateQuoteRequest } from "@openlup/platform/pricing";
export const AT = "2026-10-01T00:00:00.000Z";
export const terms = { schemaVersion: ACQUISITION_TERMS_CAPABILITY, revision: "example-a", delivery2DiscountBps: 1700,
  initialDiscountBps: 2300, effectiveFrom: AT, effectiveTo: "2026-10-02T00:00:00.000Z", sourcePromotionId: "target-a" };
export const responder = createBffResponder();
export const money = (amountMinor: number) => ({ amountMinor, currency: "XXX" });
export const quote: CommerceQuote = { currency: "XXX", taxIncluded: true,
  lines: [{ sku: "ITEM", productSlug: "item", quantity: 1, unitPriceGross: money(1200), lineSubtotalGross: money(1200),
    tax: { included: true, country: "ZZ", category: "standard", legalBasis: "Example", vatRateBps: 0, netAmount: money(1200), vatAmount: money(0), grossAmount: money(1200) } }],
  discounts: [], subtotalGross: money(1200), discountTotalGross: money(0), totalGross: money(1200), netTotal: money(1200), taxTotal: money(0) };
export const request: CreateQuoteRequest = { mode: "subscription", lines: [{ sku: "ITEM", quantity: 1 }], cadenceDays: 17, promoCodes: [] };
export function response() {
  const transcript: { status?: number; body?: unknown; headers: Record<string, unknown> } = { headers: {} };
  const res = { setHeader(name: string, value: unknown) { transcript.headers[name] = value; },
    status(status: number) { transcript.status = status; return res; }, json(body: unknown) { transcript.body = body; return res; } };
  return { res: res as unknown as HttpResponse, transcript };
}
const canonicalSchemas = createCommerceQuoteSchemas({ currencySchema: z.literal("XXX"), productSlugSchema: z.string(),
  contextSchema: z.object({ mode: z.enum(["one_time", "subscription"]), promoCodes: z.array(z.string()) }) });
export const schemas = { ...canonicalSchemas,
  publicCreateQuoteRequestSchema: canonicalSchemas.createQuoteRequestSchema.safeExtend({ promotionAcceptanceToken: z.string().optional() }),
  createQuoteBatchRequestSchema: z.object({ quotes: z.array(canonicalSchemas.createQuoteRequestSchema) }),
};
