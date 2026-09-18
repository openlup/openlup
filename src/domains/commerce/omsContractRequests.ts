import { z } from "../../lib/validation/zod.js";
import { orderStatusSchema } from "./contracts.js";
import {
  commerceOrderModeSchema,
  omsAccountingStatusSchema,
  omsAttentionReasonSchema,
  omsFulfillmentStatusSchema,
  omsHoldReasonSchema,
  omsInventoryStatusSchema,
  omsNextActionSchema,
  omsPaymentStatusSchema,
  omsProviderOpsStatusSchema,
  uuidSchema,
} from "./omsContractBase.js";

const booleanQuerySchema = z.union([
  z.boolean(),
  z.enum(["true", "false"]).transform((value) => value === "true"),
]);

export const adminCommerceOrdersListRequestSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  search: z.string().trim().min(1).max(120).optional(),
  status: orderStatusSchema.optional(),
  mode: commerceOrderModeSchema.optional(),
  paymentStatus: omsPaymentStatusSchema.optional(),
  fulfillmentStatus: omsFulfillmentStatusSchema.optional(),
  inventoryStatus: omsInventoryStatusSchema.optional(),
  accountingStatus: omsAccountingStatusSchema.optional(),
  providerOpsStatus: omsProviderOpsStatusSchema.optional(),
  attentionReason: omsAttentionReasonSchema.optional(),
  attentionOnly: booleanQuerySchema.optional(),
  nextAction: omsNextActionSchema.optional(),
  from: z.string().trim().min(1).max(40).optional(),
  to: z.string().trim().min(1).max(40).optional(),
  sort: z.enum(["created_desc", "created_asc", "updated_desc", "updated_asc", "attention_priority_desc"]).default("created_desc"),
  // Withdrawn rows are the cancelled residue of a checkout journey that was
  // declined and retried on another payment method. They are hidden by default
  // and never deleted; this asks for them back. Absent means false, which is why
  // it is the operator's explicit act rather than a remembered preference.
  includeWithdrawn: booleanQuerySchema.optional(),
}).strict();

export const adminCommerceOrderDetailRequestSchema = z.object({
  orderId: uuidSchema,
}).strict();

export const adminCommerceOrderHoldRequestSchema = z.object({
  idempotencyKey: z.string().trim().min(8).max(120),
  orderId: uuidSchema,
  reason: omsHoldReasonSchema,
  note: z.string().trim().max(1000).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();

export const adminCommerceOrderReleaseHoldRequestSchema = z.object({
  idempotencyKey: z.string().trim().min(8).max(120),
  holdId: uuidSchema,
  note: z.string().trim().max(1000).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();

export const adminCommerceOrderNoteRequestSchema = z.object({
  idempotencyKey: z.string().trim().min(8).max(120),
  orderId: uuidSchema,
  note: z.string().trim().min(1).max(2000),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();

export const adminCommerceOrderMarkRefundedRequestSchema = z.object({
  idempotencyKey: z.string().trim().min(8).max(120),
  orderId: uuidSchema,
  reason: z.string().trim().min(1).max(2000),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();

export const adminCommerceOrderCancelRequestSchema = z.object({
  idempotencyKey: z.string().trim().min(8).max(120),
  orderId: uuidSchema,
  reason: z.string().trim().min(1).max(2000),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();

export const adminCommerceOrderShippingAddressInputSchema = z.object({
  recipientName: z.string().trim().min(1).max(200),
  contactEmail: z.string().trim().email().max(200),
  line1: z.string().trim().min(1).max(240),
  line2: z.string().trim().max(240).nullable().optional(),
  city: z.string().trim().min(1).max(120),
  postalCode: z.string().trim().min(1).max(32),
  country: z.string().trim().min(2).max(3),
  contactPhone: z.string().trim().min(1).max(64),
  deliveryInstructions: z.string().trim().max(500).nullable().optional(),
  courierInstructions: z.string().trim().max(500).nullable().optional(),
}).strict();

// The operator's reasons are the four the database CHECK admits; a fifth would be
// refused by `commerce_fulfillment_orders_replacement_reason_check`, so the contract
// and the constraint are deliberately the same list.
export const adminCommerceOrderRequestReplacementShipmentRequestSchema = z.object({
  idempotencyKey: z.string().trim().min(8).max(120),
  orderId: uuidSchema,
  reason: z.enum(["damaged", "lost", "returned_undelivered", "other"]),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();

/**
 * Every way the payment-link command declines. Closed on purpose and shared by
 * both ends: the handler may only send one of these, and the operator surface has
 * a sentence for each, so no database text can ever reach a screen.
 */
export const ADMIN_COMMERCE_ORDER_PAYMENT_LINK_REFUSALS = [
  "order_not_found",
  "order_paid",
  "order_cancelled",
  "order_not_recoverable",
  "order_changed",
] as const;

export type AdminCommerceOrderPaymentLinkRefusal =
  (typeof ADMIN_COMMERCE_ORDER_PAYMENT_LINK_REFUSALS)[number];

// The order, and how the operator wants the link to travel. The expiry is still
// derived from the order's own age and the link still lands on the one recovery
// page, so `delivery` is the only choice there is to make.
//
// `copy` (the default, and what an omitted field means) hands the link back for
// the operator to paste into their own reply. `email` additionally puts it on the
// existing transactional recovery rail, addressed to the order's own customer.
// Optional rather than required so a caller that predates this field keeps its
// exact behaviour, which is also what keeps the copy flow's request byte-identical.
export const adminCommerceOrderPaymentLinkRequestSchema = z.object({
  orderId: uuidSchema,
  delivery: z.enum(["copy", "email"]).optional(),
}).strict();

export const adminCommerceOrderUpdateShippingAddressRequestSchema = z.object({
  idempotencyKey: z.string().trim().min(8).max(120),
  orderId: uuidSchema,
  expectedRevision: z.number().int().positive(),
  expectedContactDigest: z.string().regex(/^[0-9a-f]{32}$/),
  address: adminCommerceOrderShippingAddressInputSchema,
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();
