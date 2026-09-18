import { z } from "../../lib/validation/zod.js";
import {
  commerceIdempotencyKeySchema,
  createQuoteResponseSchema,
} from "./contracts.js";
import {
  orderDraftSnapshotFromQuoteSnapshotSchema,
  orderDraftSnapshotSchema,
} from "./orderDraftSnapshotContracts.js";

export const COMMERCE_ORDER_DRAFT_CREATED_EVENT_TYPE =
  "commerce.order_draft.created";
export const COMMERCE_ORDER_DRAFT_CREATED_EVENT_CONTRACT_VERSION =
  "commerce.order_draft.created.v1";

export const COMMERCE_ORDER_PAID_EVENT_TYPE = "commerce.order.paid";
export const COMMERCE_ORDER_PAID_EVENT_CONTRACT_VERSION =
  "commerce.order.paid.v1";

// commerce.order.paid.email — emitted by the SAME trigger as commerce.order.paid
// (20260614120000_order_paid_email_outbox_event.sql), a distinct event type so the
// customer paid-confirmation email handler is fully decoupled from fulfillment.
// Same payload shape (commerceOrderPaidPayloadSchema); the handler reads items +
// totals from the DB at send time.
export const COMMERCE_ORDER_PAID_EMAIL_EVENT_TYPE = "commerce.order.paid.email";

// commerce.payment.failed — emitted only for recoverable declined payments while
// the same order/subscription context is still active. Terminal expiry uses
// commerce.checkout.expired.
export const COMMERCE_PAYMENT_FAILED_EVENT_TYPE = "commerce.payment.failed";

export const COMMERCE_CHECKOUT_EXPIRED_EVENT_TYPE = "commerce.checkout.expired";

// commerce.order.canceled — emitted by the commerce_emit_order_canceled_outbox
// trigger (20260615120000_order_canceled_outbox_event.sql) when a paid or
// in-fulfillment order is cancelled. Payload embeds the order total so the email
// handler needs no extra read.
export const COMMERCE_ORDER_CANCELED_EVENT_TYPE = "commerce.order.canceled";

// commerce.order.refunded — emitted by the commerce_emit_order_refunded_outbox
// trigger (20260616100000_order_refunded_outbox_event.sql) when an order
// transitions to status='refunded'. Payload embeds the order total (the
// full-refund amount) so the email handler needs no extra read.
export const COMMERCE_ORDER_REFUNDED_EVENT_TYPE = "commerce.order.refunded";

// commerce.shipment.dispatched / commerce.shipment.delivered — emitted by the
// commerce_emit_shipment_status_outbox trigger
// (20260616130000_shipment_status_outbox_events.sql) when a fulfillment order is
// handed to the carrier (dispatched, with the opaque carrier tracking id
// embedded) or marked delivered. Provider-agnostic: the dispatched payload may
// carry an opaque tracking id plus an optional provider-supplied public
// tracking URL. Legacy carrier payloads carry only the id and keep their
// adapter-level URL fallback; new providers should supply a confirmed URL
// instead of letting the email path guess carrier semantics.
export const COMMERCE_SHIPMENT_DISPATCHED_EVENT_TYPE =
  "commerce.shipment.dispatched";
export const COMMERCE_SHIPMENT_DELIVERED_EVENT_TYPE =
  "commerce.shipment.delivered";

// commerce.shipment.exception — emitted by the commerce_emit_shipment_exception_outbox
// trigger (20260702090000_shipment_exception_outbox_event.sql) when a
// `fulfillment_exception` hold is placed on an order (e.g. the split-shipment
// preflight guard routes a paid order to manual review). The paid+charged
// customer would otherwise hear nothing after their order confirmation. The
// notice is deliberately reassurance-only: ops handles the snag, the customer
// is asked to do nothing and is told we will follow up. Payload carries only the
// order reference (the handler reads the recipient); no internal reason is
// exposed to the customer. Exactly-once per hold via the idempotency key.
export const COMMERCE_SHIPMENT_EXCEPTION_EVENT_TYPE =
  "commerce.shipment.exception";

// commerce.return.approved / commerce.return.rejected — emitted by the
// commerce_emit_return_outbox trigger (20260706110000_commerce_returns_outbox.sql)
// when an admin approves/rejects a return. The producer family `commerce.return.`
// is registered DORMANT (Returns R0 #1016); R1 registers these two customer email
// handlers (claim is by registry key, not the KNOWN list). Payload carries the
// order reference + return request id; the handler reads the recipient.
export const COMMERCE_RETURN_APPROVED_EVENT_TYPE = "commerce.return.approved";
export const COMMERCE_RETURN_REJECTED_EVENT_TYPE = "commerce.return.rejected";

// commerce.order.review_request — emitted by the enqueue_review_requests scan
// (20260621120000_commerce_order_feedback.sql) N days after a fulfillment order
// is delivered, with the opaque review-form token embedded so the marketing
// review-request email links straight to the anon feedback page. Marketing
// (consent-gated, unsubscribe footer), not transactional.
export const COMMERCE_ORDER_REVIEW_REQUEST_EVENT_TYPE =
  "commerce.order.review_request";

// commerce.order.review_effects — the SECOND review touchpoint, emitted by the
// enqueue_review_effects scan 14-60 days after delivery (kind='effects' feedback
// row + its own token). Same payload shape as review_request; asks about outcomes
// (energy/digestion/coat) rather than first impression. Marketing, not transactional.
export const COMMERCE_ORDER_REVIEW_EFFECTS_EVENT_TYPE =
  "commerce.order.review_effects";

// commerce.product.back_in_stock — emitted by the enqueue_back_in_stock RPC
// (20260621110000_back_in_stock_notifications.sql), once per still-pending
// subscriber when a previously out-of-stock sku is restocked. The recipient is
// carried directly in the payload (this is a per-email marketing alert, not an
// order event), so the handler needs no recipient lookup. Marketing-class: the
// dispatch handler consent-gates 'marketing_newsletter' for the email.
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

// commerce.order_draft.abandoned.24h / .72h — emitted by the
// enqueue_abandoned_cart_reminders RPC (20260621100000_abandoned_cart_reminders.sql)
// from the abandoned-cart cron, NOT a DB trigger. A draft that never reached
// payment gets a light 1h first nudge, a gentle 24h nudge, then a final 72h
// nudge. The payload is minimal (no snapshot): the email copy is generic about
// "your saved mix" and the handler reads only the recipient. reminderHours
// distinguishes the three tones.
export const COMMERCE_ORDER_DRAFT_ABANDONED_1H_EVENT_TYPE =
  "commerce.order_draft.abandoned.1h";
export const COMMERCE_ORDER_DRAFT_ABANDONED_24H_EVENT_TYPE =
  "commerce.order_draft.abandoned.24h";
export const COMMERCE_ORDER_DRAFT_ABANDONED_72H_EVENT_TYPE =
  "commerce.order_draft.abandoned.72h";

// commerce.order.reorder_reminder — emitted by the enqueue_reorder_reminders RPC
// from the reorder-reminder cron, NOT a DB trigger. Sent ~30 days after a
// ONE-TIME order is delivered (commerce_fulfillment_orders.delivered_at) to a
// customer who has neither reordered nor converted to a subscription. Payload is
// minimal (no snapshot): the email copy is generic about "your saved mix".
export const COMMERCE_ORDER_REORDER_REMINDER_EVENT_TYPE =
  "commerce.order.reorder_reminder";

// Checkout-recovery (W2 producer / W3 handler): "finish your payment" nudge for an
// unpaid order, carrying a single-use recovery token in the payload.
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

export const commerceOrderDraftCreatedPayloadSchema = z
  .object({
    orderId: z.string().regex(/^order_[a-f0-9-]{36}$/),
    orderUuid: uuidSchema,
    quoteSnapshot: createQuoteResponseSchema,
    orderDraftSnapshot: orderDraftSnapshotSchema,
  })
  .strict()
  .refine((payload) => payload.orderId === `order_${payload.orderUuid}`, {
    message: "orderId must contain the order UUID",
    path: ["orderId"],
  })
  .refine(
    (payload) =>
      orderDraftSnapshotFromQuoteSnapshotSchema.safeParse({
        quoteSnapshot: payload.quoteSnapshot,
        orderDraftSnapshot: payload.orderDraftSnapshot,
      }).success,
    {
      message: "order draft snapshot must match the quote snapshot",
      path: ["orderDraftSnapshot"],
    },
  );

export const commerceOrderDraftCreatedOutboxRecordSchema = z
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
  });

export const commerceOrderDraftCreatedEventSchema = z
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

export type CommerceOrderDraftCreatedPayload = z.infer<
  typeof commerceOrderDraftCreatedPayloadSchema
>;
export type CommerceOrderDraftCreatedOutboxRecord = z.infer<
  typeof commerceOrderDraftCreatedOutboxRecordSchema
>;
export type CommerceOrderDraftCreatedEvent = z.infer<
  typeof commerceOrderDraftCreatedEventSchema
>;

export function parseCommerceOrderDraftCreatedOutboxEvent(
  record: unknown,
): CommerceOrderDraftCreatedEvent {
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

// commerce.order.paid — emitted by the commerce_emit_order_paid_outbox trigger
// (supabase/migrations/20260613230000_order_paid_outbox_event.sql) when an order
// transitions to paid. `mode` stays a free-form non-empty string (not an enum):
// a producer that adds a new order mode must never retro-DLQ in-flight events,
// and the dispatch handler only forwards orderUuid to the fulfillment RPCs.
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
  });

export type CommerceOrderPaidPayload = z.infer<typeof commerceOrderPaidPayloadSchema>;
export type CommerceOrderPaidOutboxRecord = z.infer<
  typeof commerceOrderPaidOutboxRecordSchema
>;

// review_request payload: the order identifiers + the opaque review token. The
// token is a 32-char hex string (gen_random_uuid with dashes stripped); kept as
// a permissive non-empty string so a token-format change in the DB never breaks
// the dispatcher contract.
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
