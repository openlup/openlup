import { z } from "../../lib/validation/zod.js";

// Accounting owns the independent event contract. Wave 2A registers the
// consumer only; it deliberately adds no producer or event emission.

export const ACCOUNTING_ORDER_REVERSAL_REQUESTED_EVENT_TYPE =
  "accounting.order.reversal_requested";

export type AccountingOrderReversalReason = "order_canceled" | "order_refunded";

export const accountingOrderReversalRequestedPayloadSchema = z.object({
  // Match the existing reversal RPC's fail-closed idempotency floor so a row
  // accepted by this consumer cannot enter a permanent retry loop there.
  businessIdempotencyKey: z.string().trim().min(8).max(200),
  orderUuid: z.guid(),
  orderId: z.string().trim().min(1),
  reason: z.enum(["order_canceled", "order_refunded"]),
  sourceEvent: z.object({
    id: z.string().trim().min(1),
    eventType: z.string().trim().min(1),
  }).strict(),
}).strict();

export type AccountingOrderReversalRequestedPayload = z.infer<
  typeof accountingOrderReversalRequestedPayloadSchema
>;

export type AccountingOrderReversalRequested = {
  /** Canonical obligation identifier. Its producer remains deferred in Wave 2A. */
  eventType: typeof ACCOUNTING_ORDER_REVERSAL_REQUESTED_EVENT_TYPE;
  /** Legacy rows retain their event-derived key; canonical rows supply a business key. */
  idempotencyKey: string;
  orderUuid: string;
  reason: AccountingOrderReversalReason;
  payload: {
    outboxEventId: string;
    eventType: string;
    orderId: string;
    sourceEvent?: AccountingOrderReversalRequestedPayload["sourceEvent"];
  };
};
