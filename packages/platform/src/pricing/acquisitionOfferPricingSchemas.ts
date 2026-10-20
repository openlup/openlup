import { z } from "zod";
import { acquisitionTermsSchema } from "./acquisitionTermsSchemas.js";
import { COMMERCE_OFFER_PRICING_V2_CONTRACT_VERSION, COMMERCE_OFFER_PRICING_V3_CONTRACT_VERSION, type AcquisitionOfferPricingResponse, type CommerceOfferPricingResponse } from "./contracts/offer.js";
export const ACQUISITION_PROJECTION_MAX_AGE_MS = 60_000;
export const acquisitionProjectionFreshnessShape = {
  acquisitionTerms: acquisitionTermsSchema,
  observedAt: z.string().datetime({ offset: true }),
  validUntil: z.string().datetime({ offset: true }),
};
export const acquisitionProjectionFreshnessSchema = z.object(acquisitionProjectionFreshnessShape).strict().refine((value) => {
  const observed = Date.parse(value.observedAt);
  const until = Date.parse(value.validUntil);
  return until > observed && until <= observed + ACQUISITION_PROJECTION_MAX_AGE_MS
    && (value.acquisitionTerms.effectiveFrom == null || Date.parse(value.acquisitionTerms.effectiveFrom) <= observed)
    && (value.acquisitionTerms.effectiveTo == null || until <= Date.parse(value.acquisitionTerms.effectiveTo));
}, "acquisition projection must be current and expire by its next boundary or 60 seconds");


/** Validate against the host's existing v2 scope, product and settlement schemas. */
export function createAcquisitionOfferPricingSchema<ScopeV2 extends string>(
  v2Schema: z.ZodType<Extract<CommerceOfferPricingResponse<string, ScopeV2>, { contractVersion: typeof COMMERCE_OFFER_PRICING_V2_CONTRACT_VERSION }>>,
): z.ZodType<AcquisitionOfferPricingResponse<ScopeV2>> {
  return z.unknown().transform((value, ctx) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      ctx.addIssue({ code: "custom", message: "Invalid acquisition offer" }); return z.NEVER;
    }
    const { contractVersion, acquisitionTerms, observedAt, validUntil, ...base } = value as Record<string, unknown>;
    const pricing = v2Schema.safeParse({ ...base, contractVersion: COMMERCE_OFFER_PRICING_V2_CONTRACT_VERSION });
    const freshness = acquisitionProjectionFreshnessSchema.safeParse({ acquisitionTerms, observedAt, validUntil });
    if (contractVersion !== COMMERCE_OFFER_PRICING_V3_CONTRACT_VERSION || !pricing.success || !freshness.success) {
      ctx.addIssue({ code: "custom", message: "Invalid acquisition offer" }); return z.NEVER;
    }
    return { ...pricing.data, contractVersion: COMMERCE_OFFER_PRICING_V3_CONTRACT_VERSION, ...freshness.data };
  });
}
