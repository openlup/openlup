import { z } from "zod";
import { ACQUISITION_TERMS_CAPABILITY, type AcquisitionTerms, type ResolvedAcquisitionTerms } from "./contracts/acquisitionTerms.js";
export const acquisitionCapabilitySchema = z.literal(ACQUISITION_TERMS_CAPABILITY);
const revisionSchema = z.string().min(1).max(80).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const bpsSchema = z.number().int().min(0).max(10_000);
const instantSchema = z.string().datetime({ offset: true });

/** Only these extra terms are stored; promotion benefit and validity remain authoritative. */
export const acquisitionTermsMetadataSchema = z.object({
  schemaVersion: acquisitionCapabilitySchema,
  revision: revisionSchema,
  delivery2DiscountBps: bpsSchema,
}).strict();

const termsShape = {
  ...acquisitionTermsMetadataSchema.shape,
  initialDiscountBps: bpsSchema,
  effectiveFrom: instantSchema,
  effectiveTo: instantSchema.nullable(),
};
const validWindow = (terms: { effectiveFrom?: string; effectiveTo?: string | null }) =>
  typeof terms.effectiveFrom === "string" && (terms.effectiveTo === null
    || typeof terms.effectiveTo === "string" && Date.parse(terms.effectiveTo) > Date.parse(terms.effectiveFrom));

export const acquisitionTermsSchema = z.object(termsShape).strict()
  .refine(validWindow, { message: "Acquisition terms require a nonempty effective interval" });
export const resolvedAcquisitionTermsSchema = z.object({
  ...termsShape,
  sourcePromotionId: z.string().min(1).max(120),
}).strict().refine(validWindow, { message: "Acquisition terms require a nonempty effective interval" });

export const acquisitionTermsExpectationSchema = z.object({
  revision: revisionSchema,
  delivery2DiscountBps: bpsSchema,
}).strict();

export function projectAcquisitionTerms(terms: ResolvedAcquisitionTerms): AcquisitionTerms {
  const { sourcePromotionId: _source, ...publicTerms } = resolvedAcquisitionTermsSchema.parse(terms);
  return publicTerms;
}


/** Compose only at an opted-in host boundary; preserve its existing refinements. */
export function createAcquisitionQuoteSchemas<Request extends z.ZodObject, Context extends z.ZodObject, Quote extends z.ZodObject>(input: {
  request: Request; context: Context; quote: Quote;
}) {
  return {
    request: input.request.safeExtend({ acquisitionCapability: acquisitionCapabilitySchema.optional() }),
    context: input.context.safeExtend({ acquisitionCapability: acquisitionCapabilitySchema.optional(), atTime: instantSchema.optional() }),
    quote: input.quote.safeExtend({ acquisitionTerms: resolvedAcquisitionTermsSchema.optional() }),
  };
}
