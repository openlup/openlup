/**
 * Lifecycle observations are additive DTOs, not changes to existing wire status.
 * SKU draft/active/archived and draft receipt open/abandoned remain unchanged.
 * Map archived to withdrawn only where an authority establishes that meaning;
 * abandoning a draft never implies withdrawing the active variant.
 */
export type CatalogVariantState = "draft" | "active" | "withdrawn";

export interface CatalogHeadRef {
  publicationId: string;
  revision: number;
  documentDigest: string;
}

export interface CatalogLifecycleObservation {
  productId: string;
  variantId: string;
  sku: string;
  state: CatalogVariantState;
  variantRevision: number;
  /** Null means known unpublished, never unknown publication lineage. */
  publicationHead: CatalogHeadRef | null;
  draftRef: { draftId: string; revision: number } | null;
}

export interface CatalogPublishCommand {
  commandKey: string;
  productId: string;
  candidateRef: string;
  candidateDigest: string;
  expectedHead: CatalogHeadRef | null;
  changes: readonly {
    variantId: string;
    expectedRevision: number;
    state: "active" | "withdrawn";
  }[];
}

export interface CatalogPublicationReceipt {
  commandKey: string;
  fingerprint: string;
  actorId: string;
  previousHead: CatalogHeadRef | null;
  head: CatalogHeadRef;
  changes: readonly CatalogLifecycleObservation[];
}

/** Named refusals contain no arbitrary provider diagnostics. */
export interface CatalogPublicationRefusal {
  outcome: "unauthorized" | "validation_issue" | "conflict" | "dependency_unavailable" | "unsupported";
  reason: "publisher_not_authorized" | "candidate_invalid" | "head_conflict"
    | "publication_authority_unavailable" | "publication_not_supported";
}

/** Success requires coherent authoritative document and lifecycle facts. */
export type CatalogPublicationReadResult =
  | { outcome: "found"; head: CatalogHeadRef; documentRef: string; observations: readonly CatalogLifecycleObservation[] }
  | { outcome: "unpublished" }
  | CatalogPublicationRefusal;

/** Absence is distinct from an unavailable or unsupported authority. */
export type CatalogPublicationReceiptResult =
  | { outcome: "found"; receipt: CatalogPublicationReceipt }
  | { outcome: "absent" }
  | CatalogPublicationRefusal;

/**
 * Authority-owned history, newest publication revision first with stable ordering.
 * Limit is an integer from 1 through 100; receipts never exceed limit.
 * nextCursor is opaque, and null only when no further page exists.
 */
export type CatalogHistoryResult =
  | { outcome: "page"; receipts: readonly CatalogPublicationReceipt[]; limit: number; nextCursor: string | null }
  | CatalogPublicationRefusal;
