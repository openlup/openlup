import type { CatalogQuantity } from "./quantities.js";
/** Exact immutable catalogue identity captured by a commerce agreement.
 * @experimental
 */
export interface CatalogAcceptedReferenceV2 {
  schemaVersion: 2;
  skuId: string;
  skuCode: string;
  skuRevisionId: string;
  publicationHead: { publicationId: string; revision: number; documentDigest: string };
  typeRef: { key: string; version: number };
  definitionDigest: string;
  optionDigest: string;
  netContent: CatalogQuantity;
  demandPolicyRef?: string;
}
/** A head consulted by the owner during selection, independently of the issue declaring a SKU.
 * @experimental
 */
export interface CatalogAdmissionHead {
  productId: string;
  publicationId: string;
  revision: number;
  documentDigest: string;
}

/** The owner coordinate of a commercial source line before any allocation splits.
 * @experimental
 */
export type CatalogAdmissionLine = {
  sourceOrdinal: number;
  lineKey?: string;
  skuId: string;
  skuCode: string;
  mode: "one_time" | "subscription";
  quantity: number;
  role: "core" | "addon";
} & ({ source: "legacy" } | { source: "fresh" | "retained"; skuRevisionId: string });

/** @experimental */
export type CatalogAdmissionLegacyReview =
  | { identityComparison: "unavailable"; priceEvidenceRef: string; policyEvidenceRef: string }
  | { identityComparison: "equal" | "changed"; priceEvidenceRef: string; policyEvidenceRef: string;
      priorPriceEvidenceRef: string; priorPolicyEvidenceRef: string };

/** Private, owner-produced admission evidence for the native quote contract.
 * @experimental
 */
export interface CatalogAdmissionEvidence {
  quoteRef?: string;
  quoteDigest: string;
  moneyVersion: "v0";
  priceEvidenceRef: string;
  policyEvidenceRef: string;
  acceptanceTokenDigest?: string;
  consultedHeads: CatalogAdmissionHead[];
  offer?: { ref: string; version: string };
  lineBindings: CatalogAdmissionLine[];
  legacyReviewEvidence?: CatalogAdmissionLegacyReview;
  destinationRef?: string;
  destinationDigest?: string;
  graduation?: { phaseDigest: string; lineBindings: CatalogAdmissionLine[] };
}

/** @experimental */
export interface CatalogAcceptanceV2 {
  schemaVersion: 2;
  lines: CatalogAcceptedReferenceV2[];
  admission?: CatalogAdmissionEvidence;
}
