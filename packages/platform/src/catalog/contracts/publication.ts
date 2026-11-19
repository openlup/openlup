import type { CatalogPublishCommand, CatalogPublicationReceipt } from "./lifecycle.js";
import type { CatalogDraftSharedContentV3, CatalogDraftClaimV3 } from "./draftV3.js";
import type { RulesIdentifier, RulesProduct, RulesSku } from "./publicationRuleFacts.js";
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
}
/** @internal */
export interface CatalogPublishedSku extends RulesSku {
  source: CatalogDraftClaimV3;
}
/** @experimental */
export interface CatalogSkuRevisionRef { skuId: string; revisionId: string; revision: number; digest: string }
/** @experimental */
export interface CatalogPublicationManifestV2 { schemaVersion: 2; product: CatalogPublishedProduct; skus: CatalogSkuRevisionRef[] }
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
export interface CatalogPublicationFailure {
  outcome: "unauthorized" | "validation_issue" | "conflict" | "dependency_unavailable" | "unsupported";
  reason: string;
}
