import { z } from "../../lib/validation/zod.js";

export const ORDER_REVIEW_CONTRACT_VERSION = "commerce.order-review.v1" as const;

const opaqueReference = (prefix: string) => z.string().regex(new RegExp(`^${prefix}:[a-f0-9-]{36}$`));
const digest = z.string().regex(/^[a-f0-9]{64}$/);

export const orderReviewGrantReferenceSchema = opaqueReference("review-grant");
export const orderReviewReferenceSchema = opaqueReference("order-review");
export const orderReviewMediaReferenceSchema = opaqueReference("order-review-media");
export const orderReviewUploadCapabilitySchema = opaqueReference("order-review-upload");
export const orderReviewCommandKeySchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/);
export const orderReviewContentTypeSchema = z.enum(["image/jpeg", "image/png", "image/webp"]);

export const orderReviewSchema = z.object({
  contractVersion: z.literal(ORDER_REVIEW_CONTRACT_VERSION),
  reviewRef: orderReviewReferenceSchema,
  rating: z.number().int().min(1).max(5),
  comment: z.string().max(2_000).nullable(),
  moderation: z.enum(["pending", "visible", "hidden"]),
  createdAt: z.string().datetime({ offset: true }),
}).strict();

const orderReviewMediaDeclared = {
  mediaRef: orderReviewMediaReferenceSchema,
  declaredContentType: orderReviewContentTypeSchema,
  declaredByteLength: z.number().int().min(1).max(20 * 1024 * 1024),
};
const orderReviewMediaObserved = {
  observedContentType: orderReviewContentTypeSchema,
  observedByteLength: z.number().int().min(1).max(20 * 1024 * 1024),
  observedDigest: digest,
};

/** Pending intent records declarations only; an observed digest exists only after raw validation/store. */
export const orderReviewMediaSchema = z.discriminatedUnion("state", [
  z.object({ ...orderReviewMediaDeclared, state: z.literal("pending"), observedContentType: z.null(), observedByteLength: z.null(), observedDigest: z.null() }).strict(),
  z.object({ ...orderReviewMediaDeclared, ...orderReviewMediaObserved, state: z.enum(["stored", "confirmed"]) }).strict(),
  z.object({ ...orderReviewMediaDeclared, state: z.enum(["cleanup_pending", "deleted"]), observedContentType: orderReviewContentTypeSchema.nullable(), observedByteLength: z.number().int().min(1).max(20 * 1024 * 1024).nullable(), observedDigest: digest.nullable() }).strict(),
]);

/** A valid grant may not have a review yet; invalid grants stay outside this envelope. */
export const orderReviewReadResultSchema = z.object({
  review: orderReviewSchema.nullable(),
  media: z.array(orderReviewMediaSchema).max(10),
}).strict();

/** Bounded admin detail; physical storage locators remain server-only. */
export const orderReviewAdminDetailSchema = z.object({
  review: orderReviewSchema,
  media: z.array(orderReviewMediaSchema).max(10),
}).strict();

export const orderReviewSubmitSchema = z.object({
  grant: orderReviewGrantReferenceSchema,
  rating: z.number().int().min(1).max(5),
  comment: z.string().trim().min(1).max(2_000).optional(),
  fingerprint: digest,
}).strict();

export const orderReviewMediaIntentSchema = z.object({
  grant: orderReviewGrantReferenceSchema,
  contentType: orderReviewContentTypeSchema,
  byteLength: z.number().int().min(1).max(20 * 1024 * 1024),
  capabilityDigest: digest,
  commandKey: orderReviewCommandKeySchema,
}).strict();

export const orderReviewMediaIntentResultSchema = z.object({
  media: orderReviewMediaSchema,
  uploadExpiresAt: z.string().datetime({ offset: true }),
  replayed: z.boolean(),
}).strict();

export const orderReviewMediaConfirmSchema = z.object({
  grant: orderReviewGrantReferenceSchema,
  mediaRef: orderReviewMediaReferenceSchema,
  digest,
  commandKey: orderReviewCommandKeySchema,
}).strict();

export const orderReviewModerationSchema = z.object({
  reviewRef: orderReviewReferenceSchema,
  action: z.enum(["publish", "hide"]),
  idempotencyKey: orderReviewCommandKeySchema,
}).strict();

export const orderReviewCustomerCommandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("submit"), input: orderReviewSubmitSchema }).strict(),
  z.object({ kind: z.literal("media_intent"), input: orderReviewMediaIntentSchema }).strict(),
  z.object({ kind: z.literal("media_confirm"), input: orderReviewMediaConfirmSchema }).strict(),
]);

export const orderReviewCustomerResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("review"), review: orderReviewSchema, replayed: z.boolean() }).strict(),
  z.object({ kind: z.literal("media_intent"), result: orderReviewMediaIntentResultSchema }).strict(),
  z.object({ kind: z.literal("media"), media: orderReviewMediaSchema, replayed: z.boolean() }).strict(),
]);

export type OrderReview = z.infer<typeof orderReviewSchema>;
export type OrderReviewReadResult = z.infer<typeof orderReviewReadResultSchema>;
export type OrderReviewAdminDetail = z.infer<typeof orderReviewAdminDetailSchema>;
export type OrderReviewMedia = z.infer<typeof orderReviewMediaSchema>;
export type OrderReviewSubmit = z.infer<typeof orderReviewSubmitSchema>;
export type OrderReviewMediaIntent = z.infer<typeof orderReviewMediaIntentSchema>;
export type OrderReviewMediaIntentResult = z.infer<typeof orderReviewMediaIntentResultSchema>;
export type OrderReviewMediaConfirm = z.infer<typeof orderReviewMediaConfirmSchema>;
export type OrderReviewModeration = z.infer<typeof orderReviewModerationSchema>;

export const orderReviewAdminRevokeSchema = z.object({
  reviewRef: orderReviewReferenceSchema,
  idempotencyKey: orderReviewCommandKeySchema,
}).strict();

export type OrderReviewUnavailable = { kind: "unavailable" };
export type OrderReviewConflict = { kind: "conflict" };
export type OrderReviewInvalid = { kind: "invalid" };
export type OrderReviewFailure = OrderReviewUnavailable | OrderReviewConflict | OrderReviewInvalid;

export function orderReviewFailure(code: string | undefined): OrderReviewFailure {
  if (code === "order_review_conflict" || code === "23505") return { kind: "conflict" };
  if (code === "order_review_invalid" || code === "22023") return { kind: "invalid" };
  return { kind: "unavailable" };
}
