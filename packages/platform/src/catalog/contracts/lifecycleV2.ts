import type { CatalogHeadRef } from "./lifecycle.js";
import type { CatalogDraftPayloadV3, CatalogDraftPublicationOperationV3, CatalogDraftPublicationStoredPayload, CatalogDraftPublicationStoredCommand } from "./draftV3.js";
import type { CatalogDraftSummary } from "./draft.js";
import type { CatalogPublishedProduct, CatalogPublishedSku } from "./publication.js";

/** Authoritative states; legacy SQL status alone establishes none of these facts.
 * @experimental
 */
export type CatalogLifecycleStateV2 = "draft" | "active" | "withdrawn" | "archived";
/** @experimental */
export type CatalogLifecycleOperationV2 =
  | { op: "set_product_lifecycle"; productSlug: string; expectedState: CatalogLifecycleStateV2; state: "active" | "withdrawn" | "archived";
      children: { skuCode: string; expectedState: CatalogLifecycleStateV2 }[] }
  | { op: "restore_product"; productSlug: string; expectedState: "withdrawn" }
  | { op: "set_sku_lifecycle"; skuCode: string; expectedState: CatalogLifecycleStateV2; state: "active" | "withdrawn" | "archived" }
  | { op: "restore_sku"; skuCode: string; expectedState: "withdrawn" };
/** @experimental */
export type CatalogDraftPublicationOperationV4 = Exclude<CatalogDraftPublicationOperationV3, { op: "set_product_status" | "set_sku_status" }> | CatalogLifecycleOperationV2;
/** Separate stored dialect: old payloads, command fingerprints and receipts remain exact.
 * @experimental
 */
export interface CatalogDraftPayloadV4 extends Omit<CatalogDraftPayloadV3, "schemaVersion" | "publication" | "skus"> {
  schemaVersion: 4;
  skus: (CatalogDraftPayloadV3["skus"][number] & {
    /** Optional demand policy sealed into the SKU revision.
     * @experimental
     */
    demandPolicyRef?: string;
  })[];
  publication: Omit<CatalogDraftPayloadV3["publication"], "operations"> & { operations: CatalogDraftPublicationOperationV4[] };
}
/** @experimental */
export interface CatalogDraftCommandV4 {
  schemaVersion: 4; action: "create" | "revise" | "abandon" | "resume";
  draftId: string; commandKey: string; expectedRevision: number; payload?: CatalogDraftPayloadV4;
}
/** @experimental */
export type CatalogLifecycleStoredPayload = CatalogDraftPublicationStoredPayload | CatalogDraftPayloadV4;
/** @experimental */
export type CatalogLifecycleStoredCommand = CatalogDraftPublicationStoredCommand | CatalogDraftCommandV4;
/** @experimental */
export interface CatalogLifecycleStoredRecord extends CatalogDraftSummary { payload: CatalogLifecycleStoredPayload }
/** @experimental */
export interface CatalogPublishedProductV3 extends CatalogPublishedProduct { schemaVersion: 3; lifecycleState: CatalogLifecycleStateV2; definitionDigest: string }
/** @experimental */
export interface CatalogPublishedSkuV3 extends CatalogPublishedSku {
  schemaVersion: 3; lifecycleState: CatalogLifecycleStateV2; optionDigest: string;
  /** The optional policy reference owned by this immutable revision.
   * @experimental
   */
  demandPolicyRef?: string;
}
/** @experimental */
export type CatalogProductState = CatalogPublishedProduct | CatalogPublishedProductV3;
/** @experimental */
export type CatalogSkuState = CatalogPublishedSku | CatalogPublishedSkuV3;

/** Shared pure reference; subscriptions own its accepted binding. */
export type { CatalogAcceptedReferenceV2, CatalogAcceptanceV2 } from "@openlup/core/catalog";
/** @experimental */
export type CatalogObligationFamilyV2 = "template" | "pending_activation" | "frozen_renewal" | "outstanding_order" | "replacement" | "stock_wait" | "graduation";
/** @experimental */
export interface CatalogBoundObligationV2 { family: CatalogObligationFamilyV2; sourceId: string; subscriptionId: string | null; skuId: string; skuCode: string; skuRevisionId: string | null }
/** @experimental */
export type CatalogBoundObligationsV2 =
  | { schemaVersion: 2; outcome: "complete"; obligations: CatalogBoundObligationV2[] }
  | { schemaVersion: 2; outcome: "unknown" | "unavailable"; reason: "catalog_obligation_evidence_unknown" | "catalog_obligation_evidence_unavailable" };


/** @experimental */
export interface CatalogFullPublicationV3 {
  outcome: "page"; schemaVersion: 3; head: CatalogHeadRef; product: CatalogPublishedProductV3;
  items: { reference: import("./publication.js").CatalogSkuRevisionRef; facts: CatalogPublishedSkuV3 }[]; nextCursor: string | null;
}
