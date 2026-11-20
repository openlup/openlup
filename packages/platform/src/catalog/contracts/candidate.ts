import type { CatalogHeadRef } from "./lifecycle.js";
import type { CatalogDraftIssue } from "./productTypes.js";
/** @experimental */
export interface CatalogCandidateQuery { draftId: string; draftRevision: number; expectedHead: CatalogHeadRef | null }
/** A preparation refusal with safe context for fixing and checking the draft.
 * @experimental
 */
export interface CatalogCandidateIssue extends CatalogDraftIssue {
  phase?: "structural" | "pricing" | "activation";
  subject?: string;
  message?: string;
  hook?: string;
  cause?: "throw" | "undefined_result" | "realm_limit" | "invalid_result";
}
/** @experimental */
export interface CatalogCandidatePreview {
  candidateRef: string; candidateDigest: string; issues: readonly CatalogDraftIssue[];
  /** @experimental Reports what needs attention before the draft is ready. */
  preparation?: {
    structural: { outcome: "staged" | "blocked-input" | "unknown"; issues: readonly CatalogCandidateIssue[] };
    activation: { outcome: "ready" | "pending" | "blocked-input" | "unknown"; issues: readonly (CatalogCandidateIssue & {
      channel?: "one_time" | "subscription";
    })[] };
  };
  impact: { productId: string; skuIds: readonly string[]; priceOperationCount: number };
}
/** @experimental */
export interface CatalogCandidateComparison {
  candidateRef: string; candidateDigest: string; expectedHead: CatalogHeadRef | null;
}
