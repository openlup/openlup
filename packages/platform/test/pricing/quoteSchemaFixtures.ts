import { z } from "zod";
import { slugSchema } from "@openlup/core/catalog";
import { createCommerceQuotePrimitives, createCommerceQuoteSchemas, createCommerceOfferPricingSchemas, pricingPolicyRequestSchema, pricingPolicySnapshotSchema, CommerceQuoteError, CommerceQuoteSnapshotError, CommerceQuoteCatalogReadError, CommercePricingPolicyRequestError, CommercePricingPolicyUnavailableError } from "../../src/pricing/index.js";
import type { CommerceQuotePort as QuotePort } from "../../src/pricing/index.js";
export { CommerceQuoteError, CommerceQuoteSnapshotError, CommerceQuoteCatalogReadError, CommercePricingPolicyRequestError, CommercePricingPolicyUnavailableError };
export { COMMERCE_CONTRACT_VERSION, COMMERCE_OFFER_PRICING_CONTRACT_VERSION, COMMERCE_OFFER_PRICING_V2_CONTRACT_VERSION } from "../../src/pricing/contracts/index.js";
const currencySchema = z.string().regex(/^[A-Z]{3}$/).refine(code => code === "XXX", { message: "currency_not_settlement_currency" });
const { commerceSkuSchema, commerceMoneySchema } = createCommerceQuotePrimitives(currencySchema);
const catalogAttributeSlugSchema = slugSchema;
export const cartLineInputSchema = z.object({
  sku: commerceSkuSchema,
  quantity: z.number().int().min(1).max(99),
  variantId: z.string().trim().min(1).max(120).optional(),
  modeAtLine: z.enum(["one_time", "subscription"]).optional(),
  isAddon: z.boolean().optional(),
});
export const commerceSizeConstraintSchema = z
  .object({
    kind: z.enum(["unit_count", "total_weight_g", "usage_days"]),
    value: z.number().int().positive(),
    subjectId: z.string().trim().min(1).max(120).nullable().optional(),
    dailyUsageOverride: z.number().int().positive().nullable().optional(),
  })
  .strict()
  .superRefine((constraint, ctx) => {
    if (constraint.kind === "usage_days" && !constraint.dailyUsageOverride) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "usage_days size constraint requires dailyUsageOverride",
        path: ["dailyUsageOverride"],
      });
    }
  });
const quoteSizeConstraintSchema = commerceSizeConstraintSchema;
export const quoteSubjectContextSchema = z
  .object({
    subjectId: z.string().trim().min(1).max(120).nullable().optional(),
    stage: z.enum(["stage_a", "stage_b", "stage_c", "stage_d"]).optional(),
    group: z.string().trim().min(1).max(120).optional(),
    load: z.number().positive().max(120).optional(),
    usageLevel: z.enum(["low", "normal", "high"]).optional(),
    condition: z.enum(["condition_a", "condition_b", "condition_c"]).optional(),
    attributeSlugs: z.array(catalogAttributeSlugSchema).optional(),
    dailyUsageOverride: z.number().int().positive().nullable().optional(),
  })
  .strict();

export const quoteCustomerEligibilityContextSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(320).optional(),
    contactEmail: z.string().trim().toLowerCase().email().max(320).optional(),
    visitorId: z.string().trim().min(1).max(120).optional(),
  })
  .strict();
export const quoteContextSchema = z
  .object({
    mode: z.enum(["one_time", "subscription"]),
    cadenceDays: z.number().int().positive().max(120).nullable().optional(),
    usageCoverageDays: z.number().positive().nullable().optional(),
    sizeConstraint: quoteSizeConstraintSchema.optional(),
    promoCodes: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
    subjectId: z.string().trim().min(1).max(120).nullable().optional(),
    subjectContext: quoteSubjectContextSchema.optional(),
    pricingPolicy: pricingPolicySnapshotSchema.optional(),
  })
  .strict();

const createQuoteRequestShape = {
    mode: z.enum(["one_time", "subscription"]).default("one_time"),
    lines: z.array(cartLineInputSchema).min(1).max(50),
    sizeConstraint: quoteSizeConstraintSchema.optional(),
    cadenceDays: z.number().int().positive().max(120).nullable().optional(),
    promoCodes: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
    subjectId: z.string().trim().min(1).max(120).nullable().optional(),
    subjectContext: quoteSubjectContextSchema.optional(),
    locale: z.enum(["qaa", "qab"]).optional(),
    // Persistent first-party visitor id for the device first-order guard. Advisory at
    // quote time; authoritative re-evaluation happens at checkout with the same id.
    visitorId: z.string().trim().min(1).max(120).optional(),
    // Optional customer context lets the public quote route resolve an existing
    // client out-of-band and evaluate first-subscription eligibility with the
    // same facts checkout will use. Client-supplied ids are intentionally not
    // accepted; the server may only derive clientId from this context.
    customerEligibilityContext: quoteCustomerEligibilityContextSchema.optional(),
    pricingPolicy: pricingPolicyRequestSchema.optional(),
};

function validateQuoteRequest(
  request: { mode: "one_time" | "subscription"; cadenceDays?: number | null },
  ctx: z.RefinementCtx,
): void {
    if (request.mode === "subscription" && !request.cadenceDays) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "subscription quote requires cadenceDays",
        path: ["cadenceDays"],
      });
    }
}

export const createQuoteRequestSchema = z.object(createQuoteRequestShape)
  .superRefine(validateQuoteRequest);

export const publicCreateQuoteRequestSchema = z.object({
  ...createQuoteRequestShape,
  promotionAcceptanceToken: z.string().min(1).max(8_300).optional(),
}).superRefine(validateQuoteRequest);


const quoteSchemas = createCommerceQuoteSchemas({ currencySchema, productSlugSchema: slugSchema, contextSchema: quoteContextSchema });
export const { createQuoteResponseSchema, publicCreateQuoteResponseSchema, publicCreateQuoteBatchResponseSchema } = quoteSchemas;
export type CreateQuoteRequest = z.infer<typeof createQuoteRequestSchema>;
export type CreateQuoteResponse = z.infer<typeof createQuoteResponseSchema>;
export type CommerceQuotePort = QuotePort<CreateQuoteRequest, CreateQuoteResponse>;
export type CommerceQuote = CreateQuoteResponse["quote"];
export const { commerceOfferPricingResponseSchema } = createCommerceOfferPricingSchemas({
  commerceMoneySchema, catalogProductSlugSchema: slugSchema,
  scopeV1Schema: z.literal("example_products_only_excludes_shipping"),
  scopeV2Schema: z.literal("example_products_and_shipping"),
  minimumProductPayableMinor: 100,
  minimumProductPayableMessage: "offer-pricing v2 requires the 1 XXX product floor",
});
export type CommerceOfferPricingResponse = z.infer<typeof commerceOfferPricingResponseSchema>;

export const createQuoteBatchRequestSchema = z.object({ quotes: z.array(createQuoteRequestSchema).min(1).max(8) });
