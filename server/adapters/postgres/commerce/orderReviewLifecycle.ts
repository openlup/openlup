import {
  ORDER_REVIEW_CONTRACT_VERSION,
  orderReviewAdminDetailSchema,
  orderReviewMediaSchema,
  orderReviewMediaIntentResultSchema,
  orderReviewReadResultSchema,
  orderReviewSchema,
  type OrderReview,
  type OrderReviewAdminDetail,
  type OrderReviewMedia,
} from "../../../../src/domains/commerce/orderReviewContracts.js";
import type { OrderReviewAdminReadPort, OrderReviewLifecyclePort, Replay } from "../../../domains/commerce/orderReviewPorts.js";
import type { PgQueryExecutor } from "../queryBuilder.js";

const READ = "SELECT public.order_review_read($1::text, now()) AS response";
const SUBMIT = "SELECT public.order_review_submit($1::text,$2::integer,$3::text,$4::text,now()) AS response";
const INTENT = "SELECT public.order_review_create_media_intent($1::text,$2::text,$3::integer,$4::text,$5::text,now()) AS response";
const CONFIRM = "SELECT public.order_review_confirm_media($1::text,$2::text,$3::text,$4::text,now()) AS response";
const MODERATE = "SELECT public.order_review_moderate($1::text,$2::text,$3::text,$4::text,now()) AS response";
const REVOKE = "SELECT public.order_review_revoke_access($1::text,$2::text,$3::text,now()) AS response";
const ADMIN_LIST = "SELECT public.order_review_admin_list($1::text,$2::text,$3::integer,now()) AS response";
const ADMIN_READ = "SELECT public.order_review_admin_read($1::text,$2::text,now()) AS response";

export function createPostgresOrderReviewLifecyclePort(executor: PgQueryExecutor): OrderReviewLifecyclePort {
  return {
    async read(grant) {
      const response = await call(executor, READ, [grant]);
      if (response === null) return null;
      return readResult(response);
    },
    async submit(input) {
      return replay(review(required(await call(executor, SUBMIT, [input.grant, input.rating, input.comment ?? null, input.fingerprint]))));
    },
    async createMediaIntent(input) {
      return mediaIntent(required(await call(executor, INTENT, [
        input.grant, input.contentType, input.byteLength, input.capabilityDigest, input.commandKey,
      ])));
    },
    async confirmMedia(input) {
      return replay(media(required(await call(executor, CONFIRM, [input.grant, input.mediaRef, input.digest, input.commandKey]))));
    },
    async moderate(input) {
      return replay(review(await call(executor, MODERATE, [
        input.reviewRef, input.action, input.actorRef, input.idempotencyKey,
      ])));
    },
    async revoke(input) {
      const response = object(await call(executor, REVOKE, [input.reviewRef, input.actorRef, input.idempotencyKey]));
      if (!response) throw invalid();
      return { replayed: response.replayed === true };
    },
  };
}

/** Admin route composition authenticates the actor before invoking this adapter. */
export function createPostgresOrderReviewAdminReadPort(executor: PgQueryExecutor): OrderReviewAdminReadPort {
  return {
    async list(input) {
      const row = object(await call(executor, ADMIN_LIST, [input.actorRef, input.cursor ?? null, input.limit]));
      if (!row || !Array.isArray(row.items)) throw invalid();
      const items = row.items.map((item) => review(item));
      const nextCursor = row.nextCursor;
      if (nextCursor !== undefined && typeof nextCursor !== "string") throw invalid();
      return nextCursor === undefined ? { items } : { items, nextCursor: nextCursor as string };
    },
    async read(input) {
      const response = await call(executor, ADMIN_READ, [input.actorRef, input.reviewRef]);
      return response === null ? null : adminDetail(response);
    },
  };
}

async function call(executor: PgQueryExecutor, sql: string, values: unknown[]): Promise<unknown> {
  const result = await executor.query(sql, values);
  return object(result.rows[0])?.response ?? null;
}

function replay<T>(value: T & { replayed?: unknown }): Replay<T> {
  const { replayed, ...result } = value;
  return { value: result as T, replayed: replayed === true };
}
function review(value: unknown): OrderReview & { replayed?: unknown } {
  const row = object(value);
  if (!row) throw invalid();
  const { replayed, ...payload } = row;
  const parsed = orderReviewSchema.parse({
    contractVersion: payload.contractVersion ?? ORDER_REVIEW_CONTRACT_VERSION,
    ...payload,
    comment: payload.comment ?? null,
  });
  return { ...parsed, ...(typeof replayed === "boolean" ? { replayed } : {}) };
}
function media(value: unknown): OrderReviewMedia & { replayed?: unknown } {
  const row = object(value);
  if (!row) throw invalid();
  const { replayed, ...payload } = row;
  const parsed = orderReviewMediaSchema.parse(payload);
  return { ...parsed, ...(typeof replayed === "boolean" ? { replayed } : {}) };
}
function mediaIntent(value: unknown) {
  const row = object(value);
  if (!row) throw invalid();
  return orderReviewMediaIntentResultSchema.parse(row);
}
function readResult(value: unknown) {
  const row = object(value);
  if (!row || !Array.isArray(row.media)) throw invalid();
  return orderReviewReadResultSchema.parse({
    review: row.review === null ? null : review(row.review),
    media: row.media.map((item) => media(item)),
  });
}
function adminDetail(value: unknown): OrderReviewAdminDetail {
  const row = object(value);
  if (!row || !Array.isArray(row.media)) throw invalid();
  return orderReviewAdminDetailSchema.parse({
    review: review(row.review),
    media: row.media.map((item) => media(item)),
  });
}
function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function invalid() { return Object.assign(new Error("order_review_response_invalid"), { code: "order_review_invalid" }); }
function required(value: unknown): unknown {
  if (value === null) throw Object.assign(new Error("order_review_unavailable"), { code: "order_review_unavailable" });
  return value;
}
