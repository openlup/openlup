export const CATALOG_FACTS_PROVENANCE_VERSION = "catalog_facts_v1" as const;
export const CATALOG_FACTS_POLICY_PROVENANCE_VERSION = "catalog_facts_v2" as const;

interface CatalogFactsFields {
  skuId: string;
  documentRevisionId: string;
  documentDigest: string;
  basePriceEntryId: string;
  atTime: string;
  currency: string;
  resolvedUnitAmountMinor: number;
  resolvedLineAmountMinor: number;
  baseUnitAmountMinor: number;
}

export type CatalogFactsProvenance = CatalogFactsFields & (
  | { version: typeof CATALOG_FACTS_PROVENANCE_VERSION; resolvedPriceEntryId: string; mode: "one_time" | "subscription" }
  | { version: typeof CATALOG_FACTS_POLICY_PROVENANCE_VERSION; policyRevisionId: string; policyDigest: string; mode: "subscription" }
);
