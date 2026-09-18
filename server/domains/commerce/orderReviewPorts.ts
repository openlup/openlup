import type {
  OrderReview,
  OrderReviewAdminDetail,
  OrderReviewMedia,
  OrderReviewMediaConfirm,
  OrderReviewMediaIntent,
  OrderReviewMediaIntentResult,
  OrderReviewModeration,
  OrderReviewReadResult,
  OrderReviewSubmit,
} from "../../../src/domains/commerce/orderReviewContracts.js";

export type Replay<T> = { value: T; replayed: boolean };

/** Server-only storage locator. It is not a public schema or BFF DTO. */
export type OrderReviewMediaObject = { media: OrderReviewMedia; objectKey: string };
/** A live raw-upload lease; the clear capability itself is deliberately absent. */
export type OrderReviewUploadReservation = OrderReviewMediaObject & {
  leaseVersion: number;
  leaseExpiresAt: string;
  declaredContentType: "image/jpeg" | "image/png" | "image/webp";
  declaredByteLength: number;
};
/** Physical deletion is fenced by a durable, non-public cleanup receipt. */
export type OrderReviewMediaCleanup = OrderReviewMediaObject & { tempKey?: string; cleanupReceipt: string; replayed: boolean };
export type OrderReviewUploadAdmission =
  | { kind: "unavailable" }
  | { kind: "conflict" }
  | { kind: "lease"; reservation: OrderReviewUploadReservation }
  | { kind: "complete"; media: OrderReviewMedia };
/** Claimed by one worker; no worker may scan a volume or infer an object key. */
export type OrderReviewMediaReconcileTask = {
  receipt: string;
  kind: "finalize" | "delete";
  objectKey: string;
  tempKey?: string;
  expectedDeclaredContentType: "image/jpeg" | "image/png" | "image/webp";
  expectedDeclaredByteLength: number;
};
export type OrderReviewMediaReconcileOutcome =
  | { kind: "stored"; observedContentType: "image/jpeg" | "image/png" | "image/webp"; observedByteLength: number; observedDigest: string }
  | { kind: "deleted" }
  | { kind: "retry"; reason: string };

export interface OrderReviewLifecyclePort {
  /** null means an invalid/revoked grant; { review: null } is an eligible first submission. */
  read(grant: string): Promise<OrderReviewReadResult | null>;
  submit(input: OrderReviewSubmit): Promise<Replay<OrderReview>>;
  createMediaIntent(input: OrderReviewMediaIntent): Promise<OrderReviewMediaIntentResult>;
  confirmMedia(input: OrderReviewMediaConfirm): Promise<Replay<OrderReviewMedia>>;
  moderate(input: OrderReviewModeration & { actorRef: string }): Promise<Replay<OrderReview>>;
  revoke(input: { reviewRef: string; actorRef: string; idempotencyKey: string }): Promise<{ replayed: boolean }>;
}

/** Metadata-only seam. Lane B owns bytes and can never resolve a grant directly. */
export interface OrderReviewMediaPort {
  /** The route may expose only .media; .objectKey is for the object-store adapter. */
  readAuthorized(grant: string, mediaRef: string): Promise<OrderReviewMediaObject | null>;
  /**
   * Raw ingress supplies only SHA-256(clear capability), never grant/order/media
   * identifiers. The implementation must lock and re-check grant -> review ->
   * media while admitting this live lease.
   */
  admitUpload(input: {
    capabilityDigest: string;
    declaredContentType: "image/jpeg" | "image/png" | "image/webp";
    declaredByteLength: number;
    writerRef: string;
  }): Promise<OrderReviewUploadAdmission>;
  /** The transaction remains open across promote; a stale grant/lease cannot rename. */
  finalizeUpload(input: {
    capabilityDigest: string;
    writerRef: string;
    leaseVersion: number;
    digest: string;
    byteLength: number;
    promote: () => Promise<void>;
  }): Promise<OrderReviewMedia | null>;
  abortUpload(input: { capabilityDigest: string; writerRef: string; leaseVersion: number; reason: string }): Promise<void>;
  readAdmin(input: { actorRef: string; mediaRef: string }): Promise<OrderReviewMediaObject | null>;
  /** Marks cleanup_pending and returns the exact object key plus durable receipt. */
  prepareAdminDelete(input: { actorRef: string; mediaRef: string; idempotencyKey: string }): Promise<OrderReviewMediaCleanup | null>;
  /** May mark deleted only after object storage confirms physical removal. */
  completeAdminDelete(input: { actorRef: string; cleanupReceipt: string }): Promise<{ replayed: boolean }>;
  /** Claims bounded exact keys under SKIP LOCKED; B owns physical inspection/deletion. */
  claimReconcile(limit: number): Promise<OrderReviewMediaReconcileTask[]>;
  /** Fenced completion cannot overwrite a later lease or a different object outcome. */
  completeReconcile(input: { receipt: string; outcome: OrderReviewMediaReconcileOutcome }): Promise<void>;
}

export interface OrderReviewAdminReadPort {
  list(input: { actorRef: string; cursor?: string; limit: number }): Promise<{ items: OrderReview[]; nextCursor?: string }>;
  read(input: { actorRef: string; reviewRef: string }): Promise<OrderReviewAdminDetail | null>;
}
