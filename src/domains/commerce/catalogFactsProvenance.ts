import { z } from "../../lib/validation/zod.js";

export const CATALOG_FACTS_PROVENANCE_VERSION = "catalog_facts_v1" as const;
export const CATALOG_FACTS_POLICY_PROVENANCE_VERSION = "catalog_facts_v2" as const;

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

/**
 * Server-only evidence for a strict quote line. V1 remains readable for
 * historical and explicitly pre-cutover legacy subscription observations; v2
 * records the policy which derived a current subscription amount.
 */
export const catalogFactsProvenanceSchema = z.union([
  catalogFactsV1ProvenanceSchema,
  catalogFactsV2ProvenanceSchema,
]);

export type CatalogFactsProvenance = z.infer<typeof catalogFactsProvenanceSchema>;

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
