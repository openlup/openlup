import type { PublicationLifecycleState } from "./publicationIntent.js";
import type { CatalogDraftSharedContentV3, CatalogDraftClaimV3 } from "./contracts/draftV3.js";
import type { RulesIdentifier, RulesProduct, RulesSku } from "./contracts/publicationRuleFacts.js";
import type { CatalogHeadRef, CatalogPublicationReceipt } from "./contracts/lifecycle.js";
import type { CatalogDocumentRevisionRef } from "./contracts/foundation.js";

export const GOVERNED_PRODUCT_FACTS_VERSION = 3;
export const GOVERNED_SKU_FACTS_VERSION = 3;

/** @experimental */
export const CATALOG_PUBLICATION_LIMITS = { skuBytes: 2_097_152, manifestBytes: 16_777_216,
  receiptBytes: 8_388_608, historyBytes: 16_777_216, pageBytes: 8_388_608, pageItems: 100 } as const;
/** @internal */
export type CatalogPublishedIdentifier = RulesIdentifier;
/** @experimental */
export type CatalogPublishedContent = Pick<CatalogDraftSharedContentV3,
  "schemaVersion" | "catalogAction" | "presentation" | "offerMemberships" | "requestedModes" | "publicationSkus">;
/** @internal */
export interface CatalogPublishedProduct extends RulesProduct {
  document: CatalogDocumentRevisionRef | null;
  source: CatalogDraftClaimV3;
  content: CatalogPublishedContent;
  schemaVersion?: typeof GOVERNED_PRODUCT_FACTS_VERSION;
  lifecycleState?: PublicationLifecycleState;
  definitionDigest?: string;
}
/** @internal */
export interface CatalogPublishedSku extends RulesSku {
  source: CatalogDraftClaimV3;
  schemaVersion?: typeof GOVERNED_SKU_FACTS_VERSION;
  lifecycleState?: PublicationLifecycleState;
  optionDigest?: string;
}
/** @experimental */
export interface CatalogSkuRevisionRef { skuId: string; revisionId: string; revision: number; digest: string }
/** @experimental */
export interface CatalogPublicationManifestV2 { schemaVersion: 2; product: CatalogPublishedProduct; skus: CatalogSkuRevisionRef[] }
/** @internal */
export interface CatalogFullPublicationV2 { outcome: "page"; schemaVersion: 2; head: CatalogHeadRef; product: CatalogPublishedProduct;
  items: { reference: CatalogSkuRevisionRef; facts: CatalogPublishedSku }[]; nextCursor: string | null }
/** @internal */
export interface CatalogPublicationReceiptV2 extends CatalogPublicationReceipt {
  schemaVersion: 2; productId: string; publicationDigest: string; committedAt: string;
}
/** @internal */
export interface CatalogRetainedSourceBinding {
  kind: "account" | "order" | "fulfilment"; sourceId: string; lineId: string;
  productId: string; skuId: string; skuRevisionId: string; publicationId: string; documentRevisionId: string;
}
/** @internal */
export interface CatalogPublicationFailure {
  outcome: "unauthorized" | "validation_issue" | "conflict" | "dependency_unavailable" | "unsupported";
  reason: string;
  message?: string;
  path?: string;
  subject?: string;
}

/** @experimental */
export interface CatalogPublishedProductV3 extends CatalogPublishedProduct {
  schemaVersion: typeof GOVERNED_PRODUCT_FACTS_VERSION; lifecycleState: PublicationLifecycleState; definitionDigest: string;
}
/** @experimental */
export interface CatalogPublishedSkuV3 extends CatalogPublishedSku {
  schemaVersion: typeof GOVERNED_SKU_FACTS_VERSION; lifecycleState: PublicationLifecycleState; optionDigest: string;
}
/** @experimental */
export interface CatalogPublicationManifestV3 { schemaVersion: 3; product: CatalogPublishedProductV3; skus: CatalogSkuRevisionRef[] }
/** @experimental */
export interface CatalogFullPublicationV3 extends Omit<CatalogFullPublicationV2, "schemaVersion" | "product" | "items"> {
  schemaVersion: 3; product: CatalogPublishedProductV3;
  items: { reference: CatalogSkuRevisionRef; facts: CatalogPublishedSkuV3 }[];
}
/** @experimental */
export interface CatalogPublicationReceiptV3 extends Omit<CatalogPublicationReceiptV2, "schemaVersion" | "changes"> {
  schemaVersion: 3;
  changes: readonly (Omit<CatalogPublicationReceiptV2["changes"][number], "state"> & { state: PublicationLifecycleState })[];
}
