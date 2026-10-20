import { z } from "zod";
import { createBffResponder } from "../../src/bff/index.js";
import type { HttpResponse } from "../../src/http/index.js";
import { ACQUISITION_TERMS_CAPABILITY, type AcquisitionFinancialPolicy, type AcquisitionRowFacts,
  type AcquisitionTermsMetadata, type CommerceQuote, type CreateQuoteRequest,
  createCommerceQuoteSchemas, createCommerceOfferPricingSchemas } from "../../src/pricing/index.js";
export const AT = "2026-10-01T00:00:00.000Z";
export const END = "2026-10-02T00:00:00.000Z";
export const metadata: AcquisitionTermsMetadata = { schemaVersion: ACQUISITION_TERMS_CAPABILITY, revision: "example-a", delivery2DiscountBps: 1700 };
export const terms = { ...metadata, initialDiscountBps: 2300, effectiveFrom: AT, effectiveTo: END, sourcePromotionId: "target-a" };
export type Row = AcquisitionRowFacts & { kind: "baseline" | "target" | "ordinary"; rate?: unknown };
export function row(overrides: Partial<Row> = {}): Row {
  return { id: "target-a", active: true, regionCodes: ["ZZ"], validFrom: AT, validTo: END,
    mirrorOf: null, metadataPresent: true, metadata, kind: "target", rate: 2300, ...overrides };
}
/** Deliberately synthetic host policy: never shipped with the pricing module. */
export const policy: AcquisitionFinancialPolicy<Row> = {
  facts: value => value,
  classify: value => ({ baselineLegacy: value.kind === "baseline", target: value.kind === "target",
    canonicalRow: value.metadataPresent || value.kind !== "ordinary",
    unconfiguredLegacyEligible: value.kind === "baseline" }),
  validateMetadata() {},
  pairMatches: (legacy, mirror) => mirror.mirrorOf === legacy.id && legacy.validFrom === mirror.validFrom && legacy.validTo === mirror.validTo,
  initialDiscountBps: (value, purpose) => value.kind === "baseline" && purpose === "filter_validation" ? 2300 : value.rate,
  unconfiguredTerms: () => metadata,
};
export const money = (amountMinor: number) => ({ amountMinor, currency: "XXX" });
export const quote: CommerceQuote = { currency: "XXX", taxIncluded: true,
  lines: [{ sku: "ITEM", productSlug: "item", quantity: 1, unitPriceGross: money(1200), lineSubtotalGross: money(1200),
    tax: { included: true, country: "ZZ", category: "standard", legalBasis: "Example", vatRateBps: 0, netAmount: money(1200), vatAmount: money(0), grossAmount: money(1200) } }],
  discounts: [], subtotalGross: money(1200), discountTotalGross: money(0), totalGross: money(1200), netTotal: money(1200), taxTotal: money(0) };
export const request: CreateQuoteRequest = { mode: "subscription", lines: [{ sku: "ITEM", quantity: 1 }], cadenceDays: 17, promoCodes: [] };
export const pricingPolicy = { offerPolicyVersion: "commerce.offer-policy.v2", promotionEngineVersion: "promotion-engine.v2" } as const;
export const responder = createBffResponder();
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
export const offerSchemas = createCommerceOfferPricingSchemas({ commerceMoneySchema: z.object({ amountMinor: z.number().int(), currency: z.literal("XXX") }).strict(),
  catalogProductSlugSchema: z.string(), scopeV1Schema: z.literal("products"), scopeV2Schema: z.literal("products-v2"),
  minimumProductPayableMinor: 7, minimumProductPayableMessage: "Example floor" });
export const productPrice = { productSlug: "item", unitCount: 1, oneTime: { packageGross: money(1200), unitGross: money(1200) },
  subscriptionInitial: { packageGross: money(1200), unitGross: money(1200) }, subscriptionRecurring: { packageGross: money(1200), unitGross: money(1200) },
  catalogAnchorUnitGross: money(1200), initialDiscountPercent: 0, recurringDiscountPercent: 0 };
export const offerV1 = { contractVersion: "commerce.offer-pricing.v1", scope: "products", products: [productPrice], minimum: { oneTime: productPrice, subscription: productPrice } } as const;
export const offerV2 = { ...offerV1, contractVersion: "commerce.offer-pricing.v2", scope: "products-v2", pricingPolicy,
  shipping: { gross: money(0), discountGross: money(0), payable: money(0) }, minimumProductPayable: money(7) } as const;
