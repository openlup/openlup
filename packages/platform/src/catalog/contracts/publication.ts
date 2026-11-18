import type { CatalogHeadRef, CatalogPublishCommand, CatalogPublicationReceipt } from "./lifecycle.js";
import type { CatalogQuantity, CatalogProductTypeRef, CatalogOptionValue } from "./productTypes.js";
import type { CatalogAttributeValue } from "./draftV2.js";
import type { CatalogPublicationFacts, CatalogDraftSharedContentV3, CatalogDraftClaimV3 } from "./draftV3.js";
import type { CatalogDocumentRevisionRef } from "./foundation.js";

/** @experimental */
export const CATALOG_PUBLICATION_LIMITS = { skuBytes: 2_097_152, manifestBytes: 16_777_216,
  receiptBytes: 8_388_608, historyBytes: 16_777_216, pageBytes: 8_388_608, pageItems: 100 } as const;
/** @experimental */
export interface CatalogPublishCommandV2 extends CatalogPublishCommand { schemaVersion: 2 }
/** @experimental */
export interface CatalogDecisionCommandV2 {
  schemaVersion: 2; action: "approve" | "revoke"; productId: string; commandKey: string;
  candidateRef: string; candidateDigest: string; reason: string | null;
}
/** @experimental */
export interface CatalogPublishedIdentifier {
  scheme: string; issuer: string; value: string; packagingLevel: "unit" | "case"; quantity: number;
  isPrimary: boolean; label: string | null; sourceRef: string | null;
}
/** @experimental */
export interface CatalogPublishedProduct {
  id: string; slug: string; name: string; status: "draft" | "active" | "archived";
  type: CatalogProductTypeRef; axes: string[]; attributes: Record<string, CatalogAttributeValue>;
  primarySkuId: string | null; document: CatalogDocumentRevisionRef | null;
  presentation: CatalogPublicationFacts | null; source: CatalogDraftClaimV3; content: CatalogDraftSharedContentV3;
}
/** @experimental */
export interface CatalogPublishedSku {
  id: string; productId: string; code: string; title: string; status: "draft" | "active" | "archived";
  minQuantity: number; isAddon: boolean; sellableStandalone: boolean; sellableInSubscription: boolean;
  netContent: CatalogQuantity; grossMass: CatalogQuantity | null; options: Record<string, CatalogOptionValue>;
  attributes: Record<string, CatalogAttributeValue>; facts: CatalogPublicationFacts;
  identifiers: CatalogPublishedIdentifier[]; assetRefs: string[]; logisticsRef: string | null;
  memberships: { offerVersion: string; admitted: boolean }[]; source: CatalogDraftClaimV3;
}
/** @experimental */
export interface CatalogSkuRevisionRef { skuId: string; revisionId: string; revision: number; digest: string }
/** @experimental */
export interface CatalogPublicationManifestV2 { schemaVersion: 2; product: CatalogPublishedProduct; skus: CatalogSkuRevisionRef[] }
/** @experimental */
export interface CatalogFullPublicationV2 { outcome: "page"; schemaVersion: 2; head: CatalogHeadRef; product: CatalogPublishedProduct;
  items: { reference: CatalogSkuRevisionRef; facts: CatalogPublishedSku }[]; nextCursor: string | null }
/** @experimental */
export interface CatalogPublicationReceiptV2 extends CatalogPublicationReceipt {
  schemaVersion: 2; productId: string; publicationDigest: string; committedAt: string;
}
/** @experimental */
export interface CatalogDecisionReceiptV2 {
  schemaVersion: 2; action: "approve" | "revoke"; productId: string; commandKey: string; fingerprint: string;
  candidateRef: string; candidateDigest: string; actorId: string; reason: string | null; decidedAt: string;
}
/** @experimental */
export interface CatalogRetainedSourceBinding {
  kind: "account" | "order" | "fulfilment"; sourceId: string; lineId: string;
  productId: string; skuId: string; skuRevisionId: string; publicationId: string; documentRevisionId: string;
}
/** @experimental */
export interface CatalogPublicationFailure {
  outcome: "unauthorized" | "validation_issue" | "conflict" | "dependency_unavailable" | "unsupported";
  reason: string;
}
