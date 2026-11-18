import type { CatalogSubscriptionProfileRef } from "./subscriptionProfile.js";
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
  /** Immutable identity of the admitted subscription profile. @experimental */
  subscriptionProfile?: CatalogSubscriptionProfileRef & { readonly digest: string };
}
/** @experimental */
export interface CatalogAcceptanceV2 { schemaVersion: 2; lines: CatalogAcceptedReferenceV2[] }
