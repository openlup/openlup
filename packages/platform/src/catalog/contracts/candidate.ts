import type { CatalogHeadRef } from "./lifecycle.js";
import type { CatalogDraftIssue } from "./productTypes.js";
/** @experimental */
export interface CatalogCandidateQuery { draftId: string; draftRevision: number; expectedHead: CatalogHeadRef | null }
/** @experimental */
export interface CatalogCandidatePreview {
  candidateRef: string; candidateDigest: string; issues: readonly CatalogDraftIssue[];
  impact: { productId: string; skuIds: readonly string[]; priceOperationCount: number };
}
/** @experimental */
export interface CatalogCandidateComparison {
  candidateRef: string; candidateDigest: string; expectedHead: CatalogHeadRef | null;
}
