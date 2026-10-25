import { z } from "zod";
import type { OutboxEventRow } from "@openlup/core/outbox";
import { commerceIdempotencyKeySchema } from "./contractPrimitives.js";

export const COMMERCE_ORDER_DRAFT_CREATED_EVENT_TYPE =
  "commerce.order_draft.created";
export const COMMERCE_ORDER_DRAFT_CREATED_EVENT_CONTRACT_VERSION =
  "commerce.order_draft.created.v1";

export const COMMERCE_ORDER_PAID_EVENT_TYPE = "commerce.order.paid";
export const COMMERCE_ORDER_PAID_EVENT_CONTRACT_VERSION =
  "commerce.order.paid.v1";

export const COMMERCE_ORDER_PAID_EMAIL_EVENT_TYPE = "commerce.order.paid.email";

export const COMMERCE_PAYMENT_FAILED_EVENT_TYPE = "commerce.payment.failed";

export const COMMERCE_CHECKOUT_EXPIRED_EVENT_TYPE = "commerce.checkout.expired";

export const COMMERCE_ORDER_CANCELED_EVENT_TYPE = "commerce.order.canceled";

export const COMMERCE_ORDER_REFUNDED_EVENT_TYPE = "commerce.order.refunded";

export const COMMERCE_SHIPMENT_DISPATCHED_EVENT_TYPE =
  "commerce.shipment.dispatched";
export const COMMERCE_SHIPMENT_DELIVERED_EVENT_TYPE =
  "commerce.shipment.delivered";

export const COMMERCE_SHIPMENT_EXCEPTION_EVENT_TYPE =
  "commerce.shipment.exception";

export const COMMERCE_RETURN_APPROVED_EVENT_TYPE = "commerce.return.approved";
export const COMMERCE_RETURN_REJECTED_EVENT_TYPE = "commerce.return.rejected";

export const COMMERCE_ORDER_REVIEW_REQUEST_EVENT_TYPE =
  "commerce.order.review_request";

export const COMMERCE_ORDER_REVIEW_EFFECTS_EVENT_TYPE =
  "commerce.order.review_effects";

export const COMMERCE_PRODUCT_BACK_IN_STOCK_EVENT_TYPE =
  "commerce.product.back_in_stock";

export const commerceProductBackInStockPayloadSchema = z
  .object({
    sku: z.string().trim().min(1),
    email: z.string().trim().email(),
  })
  .strict();

export type CommerceProductBackInStockPayload = z.infer<
  typeof commerceProductBackInStockPayloadSchema
>;

export const COMMERCE_ORDER_DRAFT_ABANDONED_1H_EVENT_TYPE =
  "commerce.order_draft.abandoned.1h";
export const COMMERCE_ORDER_DRAFT_ABANDONED_24H_EVENT_TYPE =
  "commerce.order_draft.abandoned.24h";
export const COMMERCE_ORDER_DRAFT_ABANDONED_72H_EVENT_TYPE =
  "commerce.order_draft.abandoned.72h";

export const COMMERCE_ORDER_REORDER_REMINDER_EVENT_TYPE =
  "commerce.order.reorder_reminder";

export const COMMERCE_CHECKOUT_RECOVERY_EVENT_TYPE = "commerce.checkout_recovery";

export const commerceOutboxEventStatuses = [
  "pending",
  "processing",
  "processed",
  "failed",
  "discarded",
] as const;

const uuidSchema = z.guid();
const timestampSchema = z.string().datetime({ offset: true });

/** Bind host quote and draft snapshots without importing their policy. */
export function createCommerceOutboxEventSchemas<Quote extends z.ZodType, Snapshot extends z.ZodType, Pair extends z.ZodType>(input: {
  quoteSnapshotSchema: Quote;
  orderDraftSnapshotSchema: Snapshot;
  snapshotPairSchema: Pair;
}) {
const commerceOrderDraftCreatedPayloadSchema = z
  .object({
    orderId: z.string().regex(/^order_[a-f0-9-]{36}$/),
    orderUuid: uuidSchema,
    quoteSnapshot: input.quoteSnapshotSchema,
    orderDraftSnapshot: input.orderDraftSnapshotSchema,
  })
  .strict()
  .refine((payload) => payload.orderId === `order_${payload.orderUuid}`, {
    message: "orderId must contain the order UUID",
    path: ["orderId"],
  })
  .refine(
    (payload) =>
      input.snapshotPairSchema.safeParse({
        quoteSnapshot: (payload as { quoteSnapshot: unknown }).quoteSnapshot,
        orderDraftSnapshot: (payload as { orderDraftSnapshot: unknown }).orderDraftSnapshot,
      }).success,
    {
      message: "order draft snapshot must match the quote snapshot",
      path: ["orderDraftSnapshot"],
    },
  );

const commerceOrderDraftCreatedOutboxRecordSchema = z
  .object({
    id: uuidSchema,
    created_at: timestampSchema,
    available_at: timestampSchema,
    processed_at: timestampSchema.nullable(),
    aggregate_type: z.literal("commerce_order"),
    aggregate_id: uuidSchema,
    event_type: z.literal(COMMERCE_ORDER_DRAFT_CREATED_EVENT_TYPE),
    idempotency_key: commerceIdempotencyKeySchema,
    status: z.enum(commerceOutboxEventStatuses),
    attempts: z.number().int().nonnegative(),
    payload: commerceOrderDraftCreatedPayloadSchema,
    error: z.string().nullable(),
    metadata: z.record(z.string(), z.unknown()),
  })
  .strict()
  .refine((record) => record.aggregate_id === record.payload.orderUuid, {
    message: "aggregate_id must match payload.orderUuid",
    path: ["aggregate_id"],
  }) satisfies z.ZodType<OutboxEventRow>;

const commerceOrderDraftCreatedEventSchema = z
  .object({
    contractVersion: z.literal(COMMERCE_ORDER_DRAFT_CREATED_EVENT_CONTRACT_VERSION),
    id: uuidSchema,
    createdAt: timestampSchema,
    availableAt: timestampSchema,
    processedAt: timestampSchema.nullable(),
    aggregateType: z.literal("commerce_order"),
    aggregateId: uuidSchema,
    eventType: z.literal(COMMERCE_ORDER_DRAFT_CREATED_EVENT_TYPE),
    idempotencyKey: commerceIdempotencyKeySchema,
    status: z.enum(commerceOutboxEventStatuses),
    attempts: z.number().int().nonnegative(),
    payload: commerceOrderDraftCreatedPayloadSchema,
    error: z.string().nullable(),
    metadata: z.record(z.string(), z.unknown()),
  })
  .strict()
  .refine((event) => event.aggregateId === event.payload.orderUuid, {
    message: "aggregateId must match payload.orderUuid",
    path: ["aggregateId"],
  });


function parseCommerceOrderDraftCreatedOutboxEvent(
  record: unknown,
): z.output<typeof commerceOrderDraftCreatedEventSchema> {
  const parsed = commerceOrderDraftCreatedOutboxRecordSchema.parse(record);

  return commerceOrderDraftCreatedEventSchema.parse({
    contractVersion: COMMERCE_ORDER_DRAFT_CREATED_EVENT_CONTRACT_VERSION,
    id: parsed.id,
    createdAt: parsed.created_at,
    availableAt: parsed.available_at,
    processedAt: parsed.processed_at,
    aggregateType: parsed.aggregate_type,
    aggregateId: parsed.aggregate_id,
    eventType: parsed.event_type,
    idempotencyKey: parsed.idempotency_key,
    status: parsed.status,
    attempts: parsed.attempts,
    payload: parsed.payload,
    error: parsed.error,
    metadata: parsed.metadata,
  });
}

  return { commerceOrderDraftCreatedPayloadSchema, commerceOrderDraftCreatedOutboxRecordSchema, commerceOrderDraftCreatedEventSchema, parseCommerceOrderDraftCreatedOutboxEvent };
}

export const commerceOrderPaidPayloadSchema = z
  .object({
    orderId: z.string().regex(/^order_[a-f0-9-]{36}$/),
    orderUuid: uuidSchema,
    mode: z.string().min(1),
    occurredAt: timestampSchema,
  })
  .strict()
  .refine((payload) => payload.orderId === `order_${payload.orderUuid}`, {
    message: "orderId must contain the order UUID",
    path: ["orderId"],
  });

export const commerceOrderPaidOutboxRecordSchema = z
  .object({
    id: uuidSchema,
    created_at: timestampSchema,
    available_at: timestampSchema,
    processed_at: timestampSchema.nullable(),
    aggregate_type: z.literal("commerce_order"),
    aggregate_id: uuidSchema,
    event_type: z.literal(COMMERCE_ORDER_PAID_EVENT_TYPE),
    idempotency_key: commerceIdempotencyKeySchema,
    status: z.enum(commerceOutboxEventStatuses),
    attempts: z.number().int().nonnegative(),
    payload: commerceOrderPaidPayloadSchema,
    error: z.string().nullable(),
    metadata: z.record(z.string(), z.unknown()),
  })
  .strict()
  .refine((record) => record.aggregate_id === record.payload.orderUuid, {
    message: "aggregate_id must match payload.orderUuid",
    path: ["aggregate_id"],
  }) satisfies z.ZodType<OutboxEventRow>;

export type CommerceOrderPaidPayload = z.infer<typeof commerceOrderPaidPayloadSchema>;
export type CommerceOrderPaidOutboxRecord = z.infer<
  typeof commerceOrderPaidOutboxRecordSchema
>;

export const commerceOrderReviewRequestPayloadSchema = z
  .object({
    orderId: z.string().min(1),
    orderUuid: uuidSchema,
    token: z.string().min(1),
  })
  .passthrough();

export type CommerceOrderReviewRequestPayload = z.infer<
  typeof commerceOrderReviewRequestPayloadSchema
>;
