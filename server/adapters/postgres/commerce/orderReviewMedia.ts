import {
  orderReviewMediaSchema,
  type OrderReviewMedia,
} from "../../../../src/domains/commerce/orderReviewContracts.js";
import type {
  OrderReviewMediaCleanup,
  OrderReviewMediaObject,
  OrderReviewMediaPort,
  OrderReviewMediaReconcileTask,
  OrderReviewUploadReservation,
} from "../../../domains/commerce/orderReviewPorts.js";
import type { PgQueryExecutor } from "../queryBuilder.js";

const READ = "SELECT public.order_review_read_media($1::text,$2::text,now()) AS response";
const ADMIT = "SELECT public.order_review_admit_media_upload($1::text,$2::text,$3::integer,$4::text,now()) AS response";
const LOCK_FINALIZE = "SELECT public.order_review_lock_media_finalize($1::text,$2::text,$3::bigint,now()) AS response";
const STORED = "SELECT public.order_review_record_media_stored($1::text,$2::text,$3::bigint,$4::text,$5::integer,now()) AS response";
const ABORT = "SELECT public.order_review_abort_media_upload($1::text,$2::text,$3::bigint,$4::text,now()) AS response";
const ADMIN_READ = "SELECT public.order_review_admin_read_media($1::text,$2::text) AS response";
const ADMIN_DELETE_PREPARE = "SELECT public.order_review_admin_prepare_media_delete($1::text,$2::text,$3::text,now()) AS response";
const ADMIN_DELETE_COMPLETE = "SELECT public.order_review_admin_complete_media_delete($1::text,$2::text,now()) AS response";
const CLAIM_RECONCILE = "SELECT public.order_review_claim_media_reconcile($1::integer,now()) AS response";
const COMPLETE_RECONCILE = "SELECT public.order_review_complete_media_reconcile($1::text,$2::text,$3::text,$4::integer,$5::text,$6::text,now()) AS response";

export interface OrderReviewMediaTransactionLane {
  run<T>(work: (executor: PgQueryExecutor) => Promise<T>): Promise<T>;
}

export function createPostgresOrderReviewMediaPort(
  executor: PgQueryExecutor,
  transactionLane?: OrderReviewMediaTransactionLane,
): OrderReviewMediaPort {
  return {
    async readAuthorized(grant, mediaRef) { return mediaObjectOrNull(await call(executor, READ, [grant, mediaRef])); },
    async admitUpload(input) {
      let value: Record<string, unknown> | null;
      try {
        value = object(await call(executor, ADMIT, [
          input.capabilityDigest, input.declaredContentType, input.declaredByteLength, input.writerRef,
        ]));
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
        if (code === "23505" || code === "order_review_conflict") return { kind: "conflict" };
        throw error;
      }
      if (!value) return { kind: "unavailable" };
      if (value.kind === "complete") return { kind: "complete", media: media(value.media) };
      if (value.kind !== undefined && value.kind !== "lease") throw invalid();
      const parsed = media(value.media);
      const leaseVersion = value.leaseVersion;
      const leaseExpiresAt = value.leaseExpiresAt;
      const objectKey = value.objectKey;
      const declaredContentType = value.declaredContentType;
      const declaredByteLength = value.declaredByteLength;
      if (!Number.isInteger(leaseVersion) || typeof leaseExpiresAt !== "string" || typeof objectKey !== "string"
        || (declaredContentType !== "image/jpeg" && declaredContentType !== "image/png" && declaredContentType !== "image/webp")
        || !Number.isInteger(declaredByteLength)) throw invalid();
      return { kind: "lease", reservation: { media: parsed, leaseVersion: leaseVersion as number, leaseExpiresAt, objectKey,
        declaredContentType, declaredByteLength: declaredByteLength as number } satisfies OrderReviewUploadReservation };
    },
    async finalizeUpload(input) {
      if (!transactionLane) throw Object.assign(new Error("order_review_finalize_lane_required"), { code: "order_review_invalid" });
      let leased = false;
      try {
        return await transactionLane.run(async (transaction) => {
          const locked = await call(transaction, LOCK_FINALIZE, [input.capabilityDigest, input.writerRef, input.leaseVersion]);
          if (locked === null) return null;
          const lockedRow = object(locked);
          if (!lockedRow || !lockedRow.media) throw invalid();
          media(lockedRow.media);
          leased = true;
          await input.promote();
          const stored = mediaOrNull(await call(transaction, STORED, [
            input.capabilityDigest, input.writerRef, input.leaseVersion, input.digest, input.byteLength,
          ]));
          if (!stored) throw invalid();
          return stored;
        });
      } catch (error) {
        // The transaction has rolled back: persist cleanup_pending outside it.
        if (leased) await call(executor, ABORT, [input.capabilityDigest, input.writerRef, input.leaseVersion, "finalize_failed"]);
        throw error;
      }
    },
    async abortUpload(input) { await call(executor, ABORT, [input.capabilityDigest, input.writerRef, input.leaseVersion, input.reason]); },
    async readAdmin(input) { return mediaObjectOrNull(await call(executor, ADMIN_READ, [input.actorRef, input.mediaRef])); },
    async prepareAdminDelete(input) {
      const value = object(await call(executor, ADMIN_DELETE_PREPARE, [input.actorRef, input.mediaRef, input.idempotencyKey]));
      if (!value) return null;
      return cleanup(value);
    },
    async completeAdminDelete(input) {
      const value = object(await call(executor, ADMIN_DELETE_COMPLETE, [input.actorRef, input.cleanupReceipt]));
      if (!value) throw invalid();
      return { replayed: value.replayed === true };
    },
    async claimReconcile(limit) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw invalid();
      const value = object(await call(executor, CLAIM_RECONCILE, [limit]));
      if (!value || !Array.isArray(value.tasks)) throw invalid();
      return value.tasks.map(reconcileTask);
    },
    async completeReconcile(input) {
      const outcome = input.outcome;
      if (!/^[-A-Za-z0-9_:]{1,512}$/.test(input.receipt)) throw invalid();
      if (outcome.kind === "stored" && (!Number.isInteger(outcome.observedByteLength)
        || outcome.observedByteLength < 1 || outcome.observedByteLength > 20 * 1024 * 1024
        || !/^[a-f0-9]{64}$/.test(outcome.observedDigest))) throw invalid();
      if (outcome.kind === "retry" && (outcome.reason.length < 1 || outcome.reason.length > 128)) throw invalid();
      await call(executor, COMPLETE_RECONCILE, [
        input.receipt,
        outcome.kind,
        outcome.kind === "stored" ? outcome.observedContentType : null,
        outcome.kind === "stored" ? outcome.observedByteLength : null,
        outcome.kind === "stored" ? outcome.observedDigest : null,
        outcome.kind === "retry" ? outcome.reason : null,
      ]);
    },
  };
}

async function call(executor: PgQueryExecutor, sql: string, values: unknown[]): Promise<unknown> {
  const result = await executor.query(sql, values);
  return object(result.rows[0])?.response ?? null;
}
function mediaOrNull(value: unknown): OrderReviewMedia | null {
  return value === null ? null : media(value);
}
function media(value: unknown): OrderReviewMedia { return orderReviewMediaSchema.parse(value); }
function mediaObjectOrNull(value: unknown): OrderReviewMediaObject | null {
  if (value === null) return null;
  const row = object(value);
  if (!row || typeof row.objectKey !== "string") throw invalid();
  return { media: media(row.media), objectKey: row.objectKey };
}
function cleanup(value: Record<string, unknown>): OrderReviewMediaCleanup {
  if (typeof value.objectKey !== "string" || typeof value.cleanupReceipt !== "string" || typeof value.replayed !== "boolean") throw invalid();
  if (value.tempKey !== undefined && value.tempKey !== null && typeof value.tempKey !== "string") throw invalid();
  return { media: media(value.media), objectKey: value.objectKey,
    ...(typeof value.tempKey === "string" ? { tempKey: value.tempKey } : {}),
    cleanupReceipt: value.cleanupReceipt, replayed: value.replayed };
}
function reconcileTask(value: unknown): OrderReviewMediaReconcileTask {
  const row = object(value);
  const expectedDeclaredByteLength = row?.expectedDeclaredByteLength;
  const tempKey = row?.tempKey;
  if (!row
    || typeof row.receipt !== "string"
    || (row.kind !== "finalize" && row.kind !== "delete")
    || typeof row.objectKey !== "string"
    || (tempKey !== undefined && typeof tempKey !== "string")
    || (row.expectedDeclaredContentType !== "image/jpeg" && row.expectedDeclaredContentType !== "image/png" && row.expectedDeclaredContentType !== "image/webp")
    || !Number.isInteger(expectedDeclaredByteLength)
    || typeof expectedDeclaredByteLength !== "number"
    || expectedDeclaredByteLength < 1
    || expectedDeclaredByteLength > 20 * 1024 * 1024) throw invalid();
  return {
    receipt: row.receipt,
    kind: row.kind,
    objectKey: row.objectKey,
    ...(tempKey === undefined ? {} : { tempKey: tempKey as string }),
    expectedDeclaredContentType: row.expectedDeclaredContentType,
    expectedDeclaredByteLength,
  };
}
function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function invalid() { return Object.assign(new Error("order_review_media_response_invalid"), { code: "order_review_invalid" }); }
