import type { CatalogDraftPayloadV2, CatalogDraftStoredCommand, CatalogDraftStoredPayload } from "./draftV2.js";
import type { CatalogDraftSummary, CatalogDraftRefusal } from "./draft.js";
import type { CatalogQuantity } from "./productTypes.js";

export type CatalogPublicationJson = null | boolean | number | string | CatalogPublicationJson[] | { [key: string]: CatalogPublicationJson };
export type CatalogPublicationFacts = { [key: string]: CatalogPublicationJson };
/** Immutable source receipt; current_draft is expanded from the persisted record, never hashed into itself. */
export type CatalogDraftProvenanceV3 = { source: "current_draft" } | {
  source: "retained_draft"; draftId: string; draftRevision: number; draftCommandKey: string; draftFingerprint: string;
};
export interface CatalogDraftClaimV3 { draftId: string; revision: number; commandKey: string; fingerprint: string }
export interface CatalogDraftMediaClaimV3 { skuCode: string; mediaRef: string; assetRefs: string[]; revisionDigest: string }
export interface CatalogDraftPublicationSkuV3 {
  skuCode: string; title: string; minQuantity: number; isAddon: boolean; facts: CatalogPublicationFacts;
}
export interface CatalogDraftMembershipV3 { skuCode: string; offerVersion: string; admitted: boolean }
/** Frozen extraction envelope. Installed validators own the opaque document, presentation and SKU facts. */
export interface CatalogDraftSharedContentV3 {
  schemaVersion: 1; catalogAction: "create" | "revise"; document?: CatalogPublicationFacts;
  presentation: CatalogPublicationFacts; offerMemberships: CatalogDraftMembershipV3[];
  requestedModes: { skuCode: string; modes: ("one_time" | "subscription")[] }[];
  publicationSkus: CatalogDraftPublicationSkuV3[];
}
/** Array order is authoritative, including repeated legal operations and explicit omitted-SKU cache effects. */
export type CatalogDraftPublicationOperationV3 =
  | { op: "create_product"; productId: string; productSlug: string; name: string }
  | { op: "register_document_revision"; productSlug: string; revisionId: string; revisionNo: number;
      documentRef: string; sourceRef: string; canonicalText: string; digest: string; provenance: CatalogDraftProvenanceV3 }
  | ({ op: "create_sku"; skuId: string; productSlug: string; documentRevisionNo: number } & CatalogDraftPublicationSkuV3)
  | { op: "create_identifier"; skuCode: string; scheme: string; issuer: string; value: string;
      packagingLevel: "unit" | "case"; quantity: number; isPrimary: boolean; label: string | null; sourceRef: string | null }
  | { op: "set_eligibility"; skuCode: string; sellableStandalone: boolean; sellableInSubscription: boolean }
  | { op: "set_sku_status"; skuCode: string; status: "active" | "archived" }
  | { op: "move_document_pointer"; productSlug: string; documentRevisionNo: number }
  | { op: "set_primary_sku"; productSlug: string; skuCode: string }
  | { op: "set_product_status"; productSlug: string; status: "active" | "archived" }
  | ({ op: "set_offer_membership" } & CatalogDraftMembershipV3)
  | { op: "set_product_presentation"; productSlug: string; presentation: CatalogPublicationFacts | null }
  | { op: "set_sku_metadata"; skuCode: string; logisticsRef: string | null }
  | { op: "set_derived_sku_facts"; skuCode: string; documentRevisionNo: number; netContent: CatalogQuantity; facts: CatalogPublicationFacts };
export interface CatalogDraftPublicationInputsV3 {
  kind: "release" | "compensation"; operations: CatalogDraftPublicationOperationV3[];
  evidence: { drafts?: CatalogDraftClaimV3[]; media?: CatalogDraftMediaClaimV3[] };
}
/** Additive stored version; v1 and v2 are never reinterpreted. Prices retain the v2 command grammar. */
export interface CatalogDraftPayloadV3 extends Omit<CatalogDraftPayloadV2, "schemaVersion" | "product"> {
  schemaVersion: 3;
  product: Omit<CatalogDraftPayloadV2["product"], "sharedContent"> & { sharedContent: CatalogDraftSharedContentV3 };
  publication: CatalogDraftPublicationInputsV3;
}
export interface CatalogDraftCommandV3 {
  schemaVersion: 3; action: "create" | "revise" | "abandon" | "resume";
  draftId: string; commandKey: string; expectedRevision: number; payload?: CatalogDraftPayloadV3;
}
export type CatalogDraftPublicationStoredPayload = CatalogDraftStoredPayload | CatalogDraftPayloadV3;
export type CatalogDraftPublicationStoredCommand = CatalogDraftStoredCommand | CatalogDraftCommandV3;
export interface CatalogDraftPublicationStoredRecord extends CatalogDraftSummary { payload: CatalogDraftPublicationStoredPayload }
export type CatalogDraftPublicationStoredApplyResult = { outcome: "committed" | "replayed"; record: CatalogDraftPublicationStoredRecord } | CatalogDraftRefusal;
