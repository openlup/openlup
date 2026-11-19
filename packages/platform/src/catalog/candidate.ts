import type { CatalogCandidateQuery, CatalogCandidatePreview, CatalogCandidateComparison, CatalogCandidateIssue } from "./contracts/candidate.js";
import type { CatalogDraftPayloadV2 } from "./contracts/draftV2.js";
import type { CatalogDraftPublicationStoredRecord } from "./contracts/draftV3.js";
import type { CatalogDraftIssue, CatalogProductTypeRef, CatalogProductTypeRegistry } from "./contracts/productTypes.js";
import type { CatalogHeadRef, CatalogPublicationReadResult } from "./contracts/lifecycle.js";
import type { CatalogAttributeReferencePort } from "./attributeReferencePort.js";
import type { CatalogDocumentRevisionRef } from "./contracts/foundation.js";
import type { CatalogValidationPort } from "./publicationPorts.js";
import { createCatalogCandidateServiceWithPublication } from "./candidateService.js";

/** @experimental */
export class CatalogCandidateError extends Error {
  constructor(readonly code: "candidate_invalid" | "head_conflict" | "candidate_digest_mismatch" | "catalog_definition_drift" | "candidate_dependency_unavailable", readonly diagnostic?: CatalogCandidateIssue) {
    super(diagnostic?.message ?? code); this.name = "CatalogCandidateError";
  }
}
/** @experimental */
export interface CatalogCandidateDeps {
  /** Authorized immutable revision read; no actor string becomes publication authority. */
  readDraft(draftId: string, revision?: number): Promise<CatalogDraftPublicationStoredRecord | null>;
  registry: CatalogProductTypeRegistry;
  installedDefinitionDigest(ref: CatalogProductTypeRef): Promise<string | null>;
  currentHead(productId: string): Promise<CatalogPublicationReadResult>;
  /** Resolve full immutable lineage, including documentDigest, from the encoded identity. */
  resolveHead(identity: { publicationId: string; revision: number }): Promise<CatalogHeadRef | null>;
  readDocument?: (reference: CatalogDocumentRevisionRef) => Promise<CatalogDocumentRevisionRef | null>;
  attributeReferences?: CatalogAttributeReferencePort;
  /** The price owner validates proposed operations; its absence blocks a price-bearing preview. */
  validatePrices?: (payload: CatalogDraftPayloadV2) => Promise<readonly CatalogDraftIssue[]>;
}
/** No candidate state: each call reconstructs every digest input through the supplied readers.
 * @experimental
 */
export function createCatalogCandidateService(deps: CatalogCandidateDeps): CatalogValidationPort & {
  prepareCandidate(query: CatalogCandidateQuery): Promise<CatalogCandidatePreview>;
  compareCandidate(input: CatalogCandidateComparison): Promise<CatalogCandidatePreview>;
} {
  return createCatalogCandidateServiceWithPublication(deps);
}
