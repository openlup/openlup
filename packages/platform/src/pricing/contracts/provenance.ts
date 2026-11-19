export const CATALOG_FACTS_PROVENANCE_VERSION = "catalog_facts_v1" as const;
export const CATALOG_FACTS_POLICY_PROVENANCE_VERSION = "catalog_facts_v2" as const;

/** The publication and SKU revision observed by a governed quote reader.
 * @experimental
 */
export interface CommerceQuoteCatalogPublication {
  productId: string;
  skuRevisionId: string;
  head: { publicationId: string; revision: number; documentDigest: string };
}

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
  /** Governed publication evidence carries the exact facts the quote consulted.
   * @experimental
   */
  publication?: CommerceQuoteCatalogPublication;
}

export type CatalogFactsProvenance = CatalogFactsFields & (
  | { version: typeof CATALOG_FACTS_PROVENANCE_VERSION; resolvedPriceEntryId: string; mode: "one_time" | "subscription" }
  | { version: typeof CATALOG_FACTS_POLICY_PROVENANCE_VERSION; policyRevisionId: string; policyDigest: string; mode: "subscription" }
);
