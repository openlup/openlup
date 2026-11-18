// Browser validation binding; the pricing server entry owns the portable counterpart.
import { z } from "../../lib/validation/zod.js";

import { CATALOG_FACTS_PROVENANCE_VERSION, CATALOG_FACTS_POLICY_PROVENANCE_VERSION, CATALOG_FACTS_OFFER_PROVENANCE_VERSION } from "@openlup/platform/pricing/contracts";
export { CATALOG_FACTS_PROVENANCE_VERSION, CATALOG_FACTS_POLICY_PROVENANCE_VERSION, CATALOG_FACTS_OFFER_PROVENANCE_VERSION } from "@openlup/platform/pricing/contracts";
import type { CatalogFactsProvenance } from "@openlup/platform/pricing/contracts";
export type { CatalogFactsProvenance } from "@openlup/platform/pricing/contracts";
const catalogFactsFields = {
  skuId: z.string().uuid(),
  documentRevisionId: z.string().uuid(),
  documentDigest: z.string().regex(/^[a-f0-9]{64}$/iu),
  basePriceEntryId: z.string().trim().min(1).max(120),
  atTime: z.string().datetime({ offset: true }),
  currency: z.string().regex(/^[A-Z]{3}$/u),
  resolvedUnitAmountMinor: z.number().int().min(0),
  resolvedLineAmountMinor: z.number().int().min(0),
  baseUnitAmountMinor: z.number().int().min(0),
};

/**
 * Server-only evidence for a quote line resolved from the strict current
 * catalog facts port. V1 records authored price-entry observations; W3d v2
 * records policy-derived subscription money without inventing such an entry.
 */
const catalogFactsV1ProvenanceSchema = z
  .object({
    version: z.literal(CATALOG_FACTS_PROVENANCE_VERSION),
    resolvedPriceEntryId: z.string().trim().min(1).max(120),
    mode: z.enum(["one_time", "subscription"]),
    ...catalogFactsFields,
  })
  .strict();

const catalogFactsV2ProvenanceSchema = z
  .object({
    version: z.literal(CATALOG_FACTS_POLICY_PROVENANCE_VERSION),
    // A policy-derived subscription price has no authored subscription price
    // entry. Its immutable evidence is the exact base anchor plus this policy.
    policyRevisionId: z.string().uuid(),
    policyDigest: z.string().regex(/^[a-f0-9]{64}$/iu),
    mode: z.literal("subscription"),
    ...catalogFactsFields,
  })
  .strict();

const catalogFactsV3ProvenanceSchema = z
  .object({
    version: z.literal(CATALOG_FACTS_OFFER_PROVENANCE_VERSION),
    offerPriceReference: z.string().trim().min(1).max(120),
    mode: z.literal("one_time"),
    ...catalogFactsFields,
  })
  .strict();

const legacyCatalogFactsProvenanceSchema = z.union([
  catalogFactsV1ProvenanceSchema,
  catalogFactsV2ProvenanceSchema,
]);

/** Server-only evidence for strict catalog, subscription policy and one-time offer prices. */
export const catalogFactsProvenanceSchema = z.transform<CatalogFactsProvenance, CatalogFactsProvenance>((input: unknown, context) => {
  // Keep the existing union diagnostics for historical and unrecognized inputs.
  const schema = typeof input === "object" && input !== null && "version" in input
    && input.version === CATALOG_FACTS_OFFER_PROVENANCE_VERSION
    ? catalogFactsV3ProvenanceSchema
    : legacyCatalogFactsProvenanceSchema;
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  for (const issue of result.error.issues) {
    // The legacy union emits non-union issues only from the one branch that
    // can continue, so its enclosing quote refinements must still run.
    const canContinue = schema === legacyCatalogFactsProvenanceSchema && issue.code !== "invalid_union";
    context.addIssue({ ...issue, continue: canContinue ? true : undefined });
  }
  return z.NEVER;
});



/** Reject server-only provenance at every HTTP response schema boundary. */
export function rejectCatalogFactsFromPublicQuote(
  response: { quote: { lines: readonly { catalogFacts?: unknown }[] } },
  ctx: z.RefinementCtx,
  pathPrefix: Array<string | number> = ["quote"],
): void {
  response.quote.lines.forEach((line, index) => {
    if (line.catalogFacts !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "catalog facts are server-only",
        path: [...pathPrefix, "lines", index, "catalogFacts"],
      });
    }
  });
}
