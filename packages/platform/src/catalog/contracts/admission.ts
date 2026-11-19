import type { CatalogAcceptanceV2, CatalogAcceptedReferenceV2 } from "@openlup/core/catalog";
import type { CatalogHeadRef } from "./lifecycle.js";

/** Immutable publication evidence beside the existing pricing provenance.
 * @experimental
 */
export interface CatalogAdmissionSelection {
  reference: CatalogAcceptedReferenceV2;
  quantity: number;
}
/** Native price identity and exact consulted state; no price calculation occurs here.
 * @experimental
 */
export interface CatalogAdmissionPriceContext {
  skuId: string;
  priceListId: string;
  entryId: string;
  entry: Record<string, unknown>;
  /** Effective subscription policy associated with the consulted one-time base.
   * @experimental
   */
  policy?: { revisionId: string; digest: string };
}
/** Authenticated references for catalogue lines first used at graduation.
 * @experimental
 */
export interface CatalogGraduationPhaseReference {
  schemaVersion: 1;
  phase: "graduation";
  markerDigest: string;
  proof: CatalogAcceptanceV2;
}
/** A trusted server supplies this evidence; an account baseline is read under its subscription lock.
 * @experimental
 */
export interface CatalogAdmissionInput {
  heads: readonly { productId: string; head: CatalogHeadRef }[];
  skuRevisions: readonly CatalogAdmissionSelection[];
  mode: "one_time" | "subscription";
  offerEvidence: { offerVersion: string; subscriptionId?: string; lane?: "classic" | "exact" | "sized" | "legacy"; optIn?: boolean };
  priceContextVersions: readonly CatalogAdmissionPriceContext[];
  /** Current price rows independently consulted for a retained selection.
   * @experimental
   */
  retainedPriceContextVersions?: readonly CatalogAdmissionPriceContext[];
  /** Frozen by purchase admission for a distinct governed graduation SKU.
   * @experimental
   */
  phaseReference?: CatalogGraduationPhaseReference;
  purpose: "order" | "account";
}
