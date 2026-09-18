import { z } from "../../lib/validation/zod.js";

const uuidSchema = z.guid();
const sha256DigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const currencySchema = z.string().regex(/^[A-Z]{3}$/u);
const moneyMinorSchema = z.number().int().nonnegative();

/**
 * Persistable, lossless catalog-price evidence for a quote line. W2a validates
 * the value only; W3a alone may attach it to quote or order persistence.
 */
export const catalogQuoteProvenanceSchema = z.object({
  skuId: uuidSchema,
  documentRevisionId: uuidSchema,
  documentDigest: sha256DigestSchema,
  basePriceEntryId: uuidSchema,
  policyRevisionId: uuidSchema.nullable(),
  policyDigest: sha256DigestSchema.nullable(),
  mode: z.enum(["one_time", "subscription"]),
  atTime: z.string().datetime({ offset: true }),
  currency: currencySchema,
  baseUnitAmountMinor: moneyMinorSchema,
  resolvedLineAmountMinor: moneyMinorSchema,
}).strict().superRefine((provenance, context) => {
  const hasPolicyId = provenance.policyRevisionId !== null;
  const hasPolicyDigest = provenance.policyDigest !== null;
  if (hasPolicyId !== hasPolicyDigest) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["policyRevisionId"], message: "policy revision ID and digest must be present together" });
  }
  if (provenance.mode === "subscription" && !hasPolicyId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["policyRevisionId"], message: "subscription provenance requires a policy revision" });
  }
  if (provenance.mode === "one_time" && (hasPolicyId || hasPolicyDigest)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["policyRevisionId"], message: "one-time provenance must not name a subscription policy" });
  }
});

export type CatalogQuoteProvenance = z.infer<typeof catalogQuoteProvenanceSchema>;
