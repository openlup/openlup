import type { CatalogHeadRef } from "./lifecycle.js";
import type { CatalogDraftIssue } from "./productTypes.js";
/** @experimental */
export interface CatalogCandidateQuery { draftId: string; draftRevision: number; expectedHead: CatalogHeadRef | null }
/** @experimental */
export interface CatalogCandidatePreview {
  candidateRef: string; candidateDigest: string; issues: readonly CatalogDraftIssue[];
  /** @experimental Phase reports for sealed publication inputs. */
  preparation?: {
    structural: { outcome: "staged" | "blocked-input" | "unknown"; issues: readonly CatalogDraftIssue[] };
    activation: { outcome: "ready" | "pending" | "blocked-input" | "unknown"; issues: readonly (CatalogDraftIssue & {
      channel?: "one_time" | "subscription";
    })[] };
  };
  impact: { productId: string; skuIds: readonly string[]; priceOperationCount: number };
}
/** @experimental */
export interface CatalogCandidateComparison {
  candidateRef: string; candidateDigest: string; expectedHead: CatalogHeadRef | null;
}
