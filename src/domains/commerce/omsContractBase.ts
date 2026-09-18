import { z } from "../../lib/validation/zod.js";
import { PAYMENT_ATTEMPT_STATUSES, PAYMENT_INTENT_STATUSES } from "../payment/types.js";
import { SUBSCRIPTION_CYCLE_STATUSES } from "../subscription/types.js";
import {
  OMS_FULFILLMENT_BLOCK_REASONS,
  OMS_INVENTORY_STATUSES,
} from "./types.js";

export const commerceOrderModeSchema = z.enum(["one_time", "subscription_cycle"]);
export const omsPaymentStatusSchema = z.enum(["not_started", ...PAYMENT_INTENT_STATUSES]);
export const omsPaymentAttemptStatusSchema = z.enum(PAYMENT_ATTEMPT_STATUSES);
export const omsSubscriptionCycleStatusSchema = z.enum(SUBSCRIPTION_CYCLE_STATUSES);

export const omsHoldReasonSchema = z.enum([
  "payment_not_succeeded",
  "inventory_review",
  "risk_review",
  "address_review",
  "fulfillment_exception",
  "manual_support",
]);
export const omsHoldStatusSchema = z.enum(["active", "released"]);
export const omsOperationTypeSchema = z.enum([
  "hold_created",
  "hold_released",
  "fulfillment_reviewed",
  "support_note",
  "shipping_address_updated",
  "order_marked_refunded",
  "order_cancelled_manual",
  // The replacement command's audit row. The database CHECK was widened for it by
  // 20260820100000_replacement_shipment_command.sql; without the same widening here
  // the operation appears in `commerce_order_operations` and then fails this enum on
  // every read of the order that carries it - the replacement response itself, and
  // the whole order-detail timeline afterwards.
  "replacement_shipment_requested",
]);
export const omsFulfillmentBlockReasonSchema = z.enum(OMS_FULFILLMENT_BLOCK_REASONS);
export const omsInventoryStatusSchema = z.enum(OMS_INVENTORY_STATUSES);
export const omsFulfillmentStatusSchema = z.enum([
  "created",
  "packed",
  "label_pending",
  "label_created",
  "handed_over",
  "in_transit",
  "delivered",
  "exception",
  "cancelled",
]);
export const omsAccountingStatusSchema = z.enum([
  "missing",
  "draft",
  "issue_requested",
  "blocked",
  "issued",
  "ksef_pending",
  "accepted",
  "rejected",
  "correction_requested",
  "corrected",
  "voided",
  "outbox_failed",
]);
export const omsAttentionReasonSchema = z.enum([
  "none",
  "payment_required",
  "active_hold",
  "missing_shipping_address",
  "inventory_missing",
  "fulfillment_blocked",
  "fulfillment_pending",
  "fulfillment_exception",
  "invoice_missing",
  "invoice_issue_failed",
  "invoice_buyer_data_invalid",
]);
export const omsNextActionSchema = z.enum([
  "none",
  "review_payment",
  "release_hold",
  "review_address",
  "review_inventory",
  "review_fulfillment",
  "create_fulfillment",
  "record_label",
  "hand_off",
  "review_tracking",
  "review_invoice",
]);
export const omsProviderOpsStatusSchema = z.enum([
  "none",
  "omnipack_dispatched_not_picked",
  "omnipack_picked_not_shipped",
  "omnipack_dispatch_failed",
]);
export const omsProviderOpsSlaStatusSchema = z.enum([
  "ok",
  "watch",
  "breached",
  "paused_non_shipping_day",
]);

export const uuidSchema = z.guid();
export const datetimeSchema = z.string().datetime({ offset: true });
export const nullableTextSchema = z.string().nullable();
export const actionEligibilitySchema = z.object({
  allowed: z.boolean(),
  reason: z.string().nullable(),
}).strict();
