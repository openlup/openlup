import type { CatalogDraftPublicationStoredRecord, CatalogDraftClaimV3, CatalogDraftMediaClaimV3, CatalogPublicationFacts } from "./contracts/draftV3.js";
import type { CatalogHeadRef } from "./contracts/lifecycle.js";
import type { CatalogDocumentRevisionRef } from "./contracts/foundation.js";
import type { CatalogPublishedProduct, CatalogPublishedSku } from "./contracts/publication.js";
import type { PublicationDraftRecord, PublicationLifecycleState } from "./publicationIntent.js";
import type { CatalogRulesContext } from "./catalogPublicationRules.js";
import { z } from "./validation.js";

export type ExpectedPublicationHead = Pick<CatalogHeadRef, "publicationId" | "revision">
  & Partial<Pick<CatalogHeadRef, "documentDigest">>;

export function matchesPublicationHead(expected: ExpectedPublicationHead | null, observed: CatalogHeadRef | null): boolean {
  return expected === null ? observed === null : observed !== null && expected.publicationId === observed.publicationId
    && expected.revision === observed.revision && (expected.documentDigest === undefined || expected.documentDigest === observed.documentDigest);
}

export const publicationHeadSchema = z.object({ publicationId: z.guid().refine(value => value === value.toLowerCase()),
  revision: z.number().int().min(1).max(2_147_483_647), documentDigest: z.string().regex(/^[a-f0-9]{64}$/u) }).strict();

/** @experimental */
export interface CatalogPublicationDocument {
  reference: CatalogDocumentRevisionRef; canonicalText: string;
  provenance: { draftId: string; draftRevision: number; draftCommandKey: string; draftFingerprint: string };
}
/** One draft revision with its independent command receipt and observed open head.
 * @experimental
 */
export interface CatalogPublicationDraftEvidence {
  record: PublicationDraftRecord;
  receipt: CatalogDraftClaimV3;
  head: Pick<CatalogDraftPublicationStoredRecord, "draftId" | "productId" | "revision" | "status"> | null;
}

/** Read-only facts from the exact publication head and its admitted draft sources.
 * @experimental
 */
export interface CatalogPublicationEvidence {
  head: CatalogHeadRef | null;
  product: CatalogPublishedProduct | null;
  skus: readonly CatalogPublishedSku[];
  documents: readonly CatalogPublicationDocument[];
  /** Highest saved revision number, independent of which document bytes were selected. */
  documentRevisionHighWater: number;
  /** Selected sources, including the candidate. Retained sources are ordered by descending publication sequence, then by draft ID. */
  drafts: readonly CatalogPublicationDraftEvidence[];
  /** Omit for a confirmed historic head. Null means the authoritative state could not be read. */
  lifecycle?: { product: PublicationLifecycleState; skus: Readonly<Record<string, { state: PublicationLifecycleState; demandPolicyRef?: string }>> } | null;
}

/** Observations supplied by the host's read owners.
 * @experimental
 */
export interface CatalogCandidatePublicationDeps {
  /** Share a fixed instant and any required locale or time zone across observations. */
  evaluation?: CatalogRulesContext;
  readEvidence(request: { candidate: CatalogDraftClaimV3; productId: string; expectedHead: CatalogHeadRef | null }): Promise<CatalogPublicationEvidence | null>;
  presentationReadiness?: (productId: string, presentation: CatalogPublicationFacts) =>
    Promise<{ ready: boolean; reasons: readonly string[] } | null>;
  verifyMedia?: (claim: CatalogDraftMediaClaimV3, head: CatalogHeadRef | null) => Promise<boolean | null>;
  assessActivation?: (state: { product: CatalogPublishedProduct; skus: readonly CatalogPublishedSku[] },
    head: CatalogHeadRef | null, verifiedMedia: readonly CatalogDraftMediaClaimV3[]) =>
    Promise<{ ready: boolean; reasons: readonly string[] } | null>;
}
