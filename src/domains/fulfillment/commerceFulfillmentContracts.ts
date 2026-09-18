import { z } from "../../lib/validation/zod.js";
import {
  OMS_FULFILLMENT_BLOCK_REASONS,
  OMS_INVENTORY_STATUSES,
} from "../commerce/types.js";
import { PAYMENT_INTENT_STATUSES } from "../payment/types.js";

export const COMMERCE_FULFILLMENT_CONTRACT_VERSION = "commerce.fulfillment.v0";

export const COMMERCE_FULFILLMENT_STATUSES = [
  "created",
  "packed",
  "label_pending",
  "label_created",
  "handed_over",
  "in_transit",
  "delivered",
  "exception",
  "cancelled",
] as const;

export const COMMERCE_FULFILLMENT_OPERATION_TYPES = [
  "created",
  "packed",
  "provider_attempt_recorded",
  "label_created",
  "handed_over",
  "tracking_event_recorded",
  "cancelled",
] as const;

export const COMMERCE_FULFILLMENT_PROVIDER_ATTEMPT_STATUSES = [
  "recorded",
  "succeeded",
  "failed",
] as const;

const uuidSchema = z.guid();
const datetimeSchema = z.string().datetime({ offset: true });

export const commerceFulfillmentStatusSchema = z.enum(COMMERCE_FULFILLMENT_STATUSES);
export const commerceFulfillmentOperationTypeSchema = z.enum(COMMERCE_FULFILLMENT_OPERATION_TYPES);
export const commerceFulfillmentProviderAttemptStatusSchema = z.enum(
  COMMERCE_FULFILLMENT_PROVIDER_ATTEMPT_STATUSES,
);
export const commerceFulfillmentPaymentStatusSchema = z.enum(["not_started", ...PAYMENT_INTENT_STATUSES]);
export const commerceFulfillmentInventoryStatusSchema = z.enum(OMS_INVENTORY_STATUSES);
export const commerceFulfillmentBlockReasonSchema = z.enum(OMS_FULFILLMENT_BLOCK_REASONS);

export const commerceFulfillmentShippingAddressSnapshotSchema = z.object({
  addressId: uuidSchema,
  clientId: uuidSchema,
  label: z.string().nullable(),
  line1: z.string().trim().min(1),
  line2: z.string().nullable(),
  city: z.string().trim().min(1),
  postalCode: z.string().trim().min(1),
  country: z.string().trim().min(2).max(3),
}).strict();

export const commerceFulfillmentLineSchema = z.object({
  id: uuidSchema.nullable(),
  orderItemId: uuidSchema,
  skuId: uuidSchema,
  sku: z.string().trim().min(1),
  title: z.string().trim().min(1).nullable(),
  quantity: z.number().int().positive(),
  inventoryReservationIds: z.array(uuidSchema),
  productSnapshot: z.record(z.string(), z.unknown()),
}).strict();

export const commerceFulfillmentPaymentSummarySchema = z.object({
  paymentIntentId: uuidSchema,
  paymentStatus: commerceFulfillmentPaymentStatusSchema,
  providerPaymentId: z.string().nullable(),
}).strict();

export const commerceFulfillmentInventorySummarySchema = z.object({
  status: commerceFulfillmentInventoryStatusSchema,
  reservationId: uuidSchema.nullable(),
  reservationStatus: z.enum(["reserved", "released", "consumed", "expired"]).nullable(),
  expiresAt: datetimeSchema.nullable(),
  locationId: uuidSchema.nullable(),
  locationCode: z.string().nullable(),
}).strict();

export const commerceFulfillmentOmsEligibilitySchema = z.object({
  allowed: z.boolean(),
  reason: commerceFulfillmentBlockReasonSchema.nullable(),
}).strict();

export const commerceFulfillmentOperationSchema = z.object({
  id: uuidSchema,
  type: commerceFulfillmentOperationTypeSchema,
  occurredAt: datetimeSchema,
  actorUserId: uuidSchema.nullable(),
  payload: z.record(z.string(), z.unknown()),
}).strict();

export const commerceFulfillmentOrderSchema = z.object({
  id: uuidSchema,
  orderId: uuidSchema,
  clientId: uuidSchema.nullable(),
  status: commerceFulfillmentStatusSchema,
  providerKind: z.string().trim().min(1).nullable(),
  providerTrackingId: z.string().trim().min(1).nullable(),
  shippingAddress: commerceFulfillmentShippingAddressSnapshotSchema,
  lines: z.array(commerceFulfillmentLineSchema).min(1),
  payment: commerceFulfillmentPaymentSummarySchema,
  inventory: commerceFulfillmentInventorySummarySchema,
  omsEligibility: commerceFulfillmentOmsEligibilitySchema,
  latestOperation: commerceFulfillmentOperationSchema.nullable(),
  createdAt: datetimeSchema,
  updatedAt: datetimeSchema,
}).strict();

export const adminCommerceFulfillmentOrdersListRequestSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  status: commerceFulfillmentStatusSchema.optional(),
}).strict();

export const adminCommerceFulfillmentOrderDetailRequestSchema = z
  .object({
    fulfillmentOrderId: uuidSchema.optional(),
    orderId: uuidSchema.optional(),
  })
  .strict()
  .refine((request) => request.fulfillmentOrderId || request.orderId, {
    message: "fulfillmentOrderId or orderId is required",
  });

export const adminCommerceFulfillmentCreateRequestSchema = z.object({
  idempotencyKey: z.string().trim().min(8).max(120),
  orderId: uuidSchema,
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();

export const adminCommerceFulfillmentRecordProviderAttemptRequestSchema = z.object({
  idempotencyKey: z.string().trim().min(8).max(120),
  fulfillmentOrderId: uuidSchema,
  providerKind: z.string().trim().min(1),
  status: commerceFulfillmentProviderAttemptStatusSchema,
  requestPayload: z.record(z.string(), z.unknown()).default({}),
  responsePayload: z.record(z.string(), z.unknown()).default({}),
  error: z.string().trim().min(1).nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();

export const adminCommerceFulfillmentRecordLabelRequestSchema = z.object({
  idempotencyKey: z.string().trim().min(8).max(120),
  fulfillmentOrderId: uuidSchema,
  providerKind: z.string().trim().min(1),
  providerTrackingId: z.string().trim().min(1),
  labelUrl: z.string().trim().min(1).nullable().optional(),
  deliveryEstimateDays: z.number().int().nonnegative().nullable().optional(),
  rawProviderPayload: z.record(z.string(), z.unknown()).default({}),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();

export const adminCommerceFulfillmentHandOffRequestSchema = z.object({
  idempotencyKey: z.string().trim().min(8).max(120),
  fulfillmentOrderId: uuidSchema,
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();

export const adminCommerceFulfillmentTrackingEventRequestSchema = z.object({
  idempotencyKey: z.string().trim().min(8).max(120),
  fulfillmentOrderId: uuidSchema,
  status: z.enum(["in_transit", "delivered", "exception"]),
  providerTrackingId: z.string().trim().min(1).optional(),
  rawEvent: z.record(z.string(), z.unknown()).default({}),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();

export const adminCommerceFulfillmentCancelRequestSchema = z.object({
  idempotencyKey: z.string().trim().min(8).max(120),
  fulfillmentOrderId: uuidSchema,
  reason: z.string().trim().min(1).max(240),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();

export const adminCommerceFulfillmentOrdersListResponseSchema = z.object({
  contractVersion: z.literal(COMMERCE_FULFILLMENT_CONTRACT_VERSION),
  orders: z.array(commerceFulfillmentOrderSchema),
  totalCount: z.number().int().min(0),
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
}).strict();

export const adminCommerceFulfillmentOrderDetailResponseSchema = z.object({
  contractVersion: z.literal(COMMERCE_FULFILLMENT_CONTRACT_VERSION),
  order: commerceFulfillmentOrderSchema,
}).strict();

export const adminCommerceFulfillmentMutationResponseSchema = z.object({
  contractVersion: z.literal(COMMERCE_FULFILLMENT_CONTRACT_VERSION),
  fulfillmentOrderId: uuidSchema,
  orderId: uuidSchema,
  status: commerceFulfillmentStatusSchema,
  replayed: z.boolean(),
}).strict();

export type AdminCommerceFulfillmentOrdersListRequest = z.infer<typeof adminCommerceFulfillmentOrdersListRequestSchema>;
export type AdminCommerceFulfillmentOrderDetailRequest = z.infer<typeof adminCommerceFulfillmentOrderDetailRequestSchema>;
export type AdminCommerceFulfillmentCreateRequest = z.infer<typeof adminCommerceFulfillmentCreateRequestSchema>;
export type AdminCommerceFulfillmentRecordProviderAttemptRequest = z.input<typeof adminCommerceFulfillmentRecordProviderAttemptRequestSchema>;
export type AdminCommerceFulfillmentRecordLabelRequest = z.input<typeof adminCommerceFulfillmentRecordLabelRequestSchema>;
export type AdminCommerceFulfillmentHandOffRequest = z.infer<typeof adminCommerceFulfillmentHandOffRequestSchema>;
export type AdminCommerceFulfillmentTrackingEventRequest = z.input<typeof adminCommerceFulfillmentTrackingEventRequestSchema>;
export type AdminCommerceFulfillmentCancelRequest = z.infer<typeof adminCommerceFulfillmentCancelRequestSchema>;
export type AdminCommerceFulfillmentOrdersListResponse = z.infer<typeof adminCommerceFulfillmentOrdersListResponseSchema>;
export type AdminCommerceFulfillmentOrderDetailResponse = z.infer<typeof adminCommerceFulfillmentOrderDetailResponseSchema>;
export type AdminCommerceFulfillmentMutationResponse = z.infer<typeof adminCommerceFulfillmentMutationResponseSchema>;
export type CommerceFulfillmentOrder = z.infer<typeof commerceFulfillmentOrderSchema>;
export type CommerceFulfillmentStatus = z.infer<typeof commerceFulfillmentStatusSchema>;
export type CommerceFulfillmentOperationType = z.infer<typeof commerceFulfillmentOperationTypeSchema>;
