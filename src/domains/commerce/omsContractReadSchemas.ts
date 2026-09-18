import { z } from "../../lib/validation/zod.js";
import { commerceMoneySchema, orderStatusSchema } from "./contracts.js";
import { defaultOmsFulfillmentDebug, omsFulfillmentDebugSchema } from "./omsFulfillmentDebugSchemas.js";
import { omsFulfillmentHealthDigestSchema, omsFulfillmentHealthSchema } from "./omsFulfillmentHealthSchemas.js";
import { omsCommunicationDeliverySchema, omsDeliveryContactProjectionSchema, omsDeliveryContactSchema, omsDeliverySelectionSchema, omsFirstSubscriptionPricePresentationSchema, omsPricingSummarySchema } from "./omsContractReadAuxSchemas.js";
import {
  actionEligibilitySchema, commerceOrderModeSchema, datetimeSchema, nullableTextSchema,
  omsAccountingStatusSchema, omsAttentionReasonSchema, omsFulfillmentBlockReasonSchema,
  omsFulfillmentStatusSchema, omsHoldReasonSchema, omsHoldStatusSchema, omsInventoryStatusSchema,
  omsNextActionSchema, omsOperationTypeSchema, omsPaymentAttemptStatusSchema, omsPaymentStatusSchema,
  omsProviderOpsStatusSchema, uuidSchema,
} from "./omsContractBase.js";
import {
  defaultOmsReplacementChain, omsFulfillmentSummarySchema, omsInventorySummarySchema,
  omsProviderOpsSlaSchema, omsReplacementChainSchema, omsSubscriptionContextSchema,
} from "./omsFulfillmentContractSchemas.js";
import { COMMERCE_CONTRACT_VERSION } from "./types.js";
import { FULFILLMENT_STATUS_MAP, type CustomerFulfillmentStep } from "../../lib/customerFulfillmentCanon.js";
export { omsCommunicationDeliverySchema, omsCommunicationDeliveryStatusSchema, omsDeliveryContactProjectionSchema, omsDeliveryContactSchema, omsDeliverySelectionSchema, omsPricingSummarySchema } from "./omsContractReadAuxSchemas.js";
export { omsFulfillmentHealthDigestSchema, omsFulfillmentHealthSchema } from "./omsFulfillmentHealthSchemas.js";
export {
  omsFulfillmentSummarySchema, omsFulfillmentTimelineEventSchema, omsFulfillmentTrackingReferenceSchema,
  omsInventorySummarySchema, omsProviderOpsSlaSchema, omsReplacementChainSchema,
  omsSubscriptionContextSchema, omsSupersededParcelSchema,
} from "./omsFulfillmentContractSchemas.js";
export const omsCustomerSummarySchema = z.object({
  id: uuidSchema,
  email: z.string().min(1),
  firstName: nullableTextSchema,
  lastName: nullableTextSchema,
  phone: nullableTextSchema,
  lifecycleStage: z.string().nullable(),
}).strict();
export const omsPetSummarySchema = z.object({
  id: uuidSchema,
  name: nullableTextSchema,
  petType: nullableTextSchema,
  breed: nullableTextSchema,
  ageLabel: nullableTextSchema,
  weightKg: z.number().nullable(),
}).strict();
export const omsAddressSummarySchema = z.object({
  id: uuidSchema,
  label: nullableTextSchema,
  line1: nullableTextSchema,
  line2: nullableTextSchema,
  city: nullableTextSchema,
  postalCode: nullableTextSchema,
  country: nullableTextSchema,
  recipientName: nullableTextSchema,
  contactPhone: nullableTextSchema,
  companyName: nullableTextSchema,
  taxId: nullableTextSchema,
  deliveryNotes: nullableTextSchema,
  courierInstructions: nullableTextSchema,
}).strict();
export const omsOrderLineSchema = z.object({
  id: uuidSchema,
  skuId: uuidSchema.nullable(),
  sku: nullableTextSchema,
  title: nullableTextSchema,
  quantity: z.number().int().positive(),
  unitPrice: commerceMoneySchema,
  total: commerceMoneySchema,
  discountAllocated: commerceMoneySchema,
  effectiveTotal: commerceMoneySchema,
  effectiveNet: commerceMoneySchema,
  vatRateBps: z.number().int().nonnegative().nullable(),
  productSnapshot: z.record(z.string(), z.unknown()),
  variantSnapshot: z.record(z.string(), z.unknown()).nullable(),
}).strict();
export const omsAccountingSummarySchema = z.object({
  status: omsAccountingStatusSchema,
  invoiceId: uuidSchema.nullable(),
  invoiceRef: nullableTextSchema,
  providerKind: nullableTextSchema,
  providerInvoiceNumber: nullableTextSchema,
  ksefStatus: nullableTextSchema,
  outboxStatus: nullableTextSchema,
  outboxAttemptCount: z.number().int().nonnegative().nullable(),
  outboxNextAttemptAt: datetimeSchema.nullable(),
  outboxLastError: z
    .object({
      code: z.string().trim().min(1).max(80).nullable(),
      message: z.string().trim().min(1).max(240).nullable(),
      retryable: z.boolean().nullable(),
    })
    .strict()
    .nullable(),
  recoveryGuidance: z.enum(["none", "not_requested", "wait_for_retry", "review_and_retry"]),
  updatedAt: datetimeSchema.nullable(),
}).strict();
export const omsOrderActionEligibilitySchema = z.object({
  addNote: actionEligibilitySchema,
  createHold: actionEligibilitySchema,
  releaseHold: actionEligibilitySchema,
  createFulfillment: actionEligibilitySchema,
  updateShippingAddress: actionEligibilitySchema,
  recordLabel: actionEligibilitySchema,
  handOff: actionEligibilitySchema,
  recordTrackingEvent: actionEligibilitySchema,
  cancelFulfillment: actionEligibilitySchema,
  cancelOrder: actionEligibilitySchema,
  markRefunded: actionEligibilitySchema,
}).strict();
export const omsOrderSearchMatchSchema = z.object({
  field: z.enum([
    "order_number",
    "order_id",
    "email",
    "phone",
    "customer",
    "pet",
    "address",
    "postal_code",
    "tracking",
    "invoice",
    "payment",
    "provider_order",
    "sku",
  ]),
  label: z.string().trim().min(1).max(80),
  valuePreview: z.string().trim().min(1).max(120).nullable(),
}).strict();
export const omsOrderListItemSchema = z.object({
  orderId: uuidSchema,
  orderNumber: z.string().nullable(),
  clientId: uuidSchema.nullable(),
  customer: omsCustomerSummarySchema.nullable(),
  pet: omsPetSummarySchema.nullable(),
  status: orderStatusSchema,
  mode: commerceOrderModeSchema,
  // Where the order was sold. Absent on a reader predating the source axis, and
  // sourceChannelSlug is absent on a storefront order, which names no channel.
  // Open strings, not enums: selling surfaces are a registry, not a vocabulary.
  sourceKind: z.string().optional(),
  sourceChannelSlug: z.string().optional(),
  sourceOrderRef: z.string().optional(),
  paymentMethodLabel: z.string().nullable(),
  paymentProvider: z.string().nullable(),
  paymentStatus: omsPaymentStatusSchema,
  fulfillmentStatus: omsFulfillmentStatusSchema.nullable(),
  customerFulfillmentStep: z.custom<CustomerFulfillmentStep>((value) =>
    FULFILLMENT_STATUS_MAP.stages.some((stage) => stage.customerStep === value)),
  inventoryStatus: omsInventoryStatusSchema,
  accountingStatus: omsAccountingStatusSchema,
  providerOpsStatus: omsProviderOpsStatusSchema.default("none"),
  providerOpsSla: omsProviderOpsSlaSchema.nullable().default(null),
  providerOrderId: nullableTextSchema.default(null),
  attentionReason: omsAttentionReasonSchema,
  nextAction: omsNextActionSchema,
  activeHoldCount: z.number().int().min(0),
  // Why, not just that: `attentionReason` says `active_hold` and stops.
  activeHoldReasons: z.array(omsHoldReasonSchema),
  fulfillmentHealthDigest: omsFulfillmentHealthDigestSchema,
  total: commerceMoneySchema,
  pricingSummary: omsPricingSummarySchema,
  createdAt: datetimeSchema,
  updatedAt: datetimeSchema,
  match: omsOrderSearchMatchSchema.optional(),
});
export const omsOrderListSummaryCountsSchema = z.object({
  needsAttention: z.number().int().min(0),
  activeHold: z.number().int().min(0),
  readyForFulfillment: z.number().int().min(0),
  paymentIssues: z.number().int().min(0),
  inventoryRisk: z.number().int().min(0),
  fulfillmentBlocked: z.number().int().min(0),
  fulfillmentExceptions: z.number().int().min(0),
  invoiceIssues: z.number().int().min(0),
  omnipackDispatchedNotPicked: z.number().int().min(0),
}).strict();
export const omsOrderListSummaryTotalsSchema = z.object({
  gmv: commerceMoneySchema, aov: commerceMoneySchema,
  orderCount: z.number().int().min(0), paidSubscriptionCycleCount: z.number().int().min(0),
}).strict();
export const omsOrderHoldSchema = z.object({
  id: uuidSchema,
  orderId: uuidSchema,
  status: omsHoldStatusSchema,
  reason: omsHoldReasonSchema,
  note: z.string().nullable(),
  createdAt: datetimeSchema,
  releasedAt: datetimeSchema.nullable(),
});
export const omsOrderOperationSchema = z.object({
  id: uuidSchema,
  orderId: uuidSchema,
  type: omsOperationTypeSchema,
  holdId: uuidSchema.nullable(),
  actorUserId: uuidSchema.nullable(),
  occurredAt: datetimeSchema,
  payload: z.record(z.string(), z.unknown()),
});

export const omsPaymentSummarySchema = z.object({
  intentId: uuidSchema.nullable(),
  paymentId: uuidSchema.nullable(),
  status: omsPaymentStatusSchema,
  activeAttemptId: uuidSchema.nullable(),
  providerPaymentId: z.string().nullable(),
  updatedAt: datetimeSchema.nullable(),
});

export const omsPaymentAttemptSchema = z.object({
  id: uuidSchema,
  status: omsPaymentAttemptStatusSchema,
  provider: z.string().min(1),
  providerAttemptId: z.string().nullable(),
  nextActionKind: z.string().nullable(),
  updatedAt: datetimeSchema,
});

export const omsPaymentTransitionSchema = z.object({
  id: uuidSchema,
  transitionKind: z.string().min(1),
  fromStatus: z.string().nullable(),
  toStatus: z.string().min(1),
  reason: z.string().min(1),
  occurredAt: datetimeSchema,
});

export const omsFulfillmentEligibilitySchema = z.object({
  allowed: z.boolean(),
  reason: omsFulfillmentBlockReasonSchema.nullable(),
});

export const omsOrderDetailSchema = omsOrderListItemSchema.extend({
  firstSubscriptionPricePresentation: omsFirstSubscriptionPricePresentationSchema.nullable().optional(),
  shippingAddress: omsAddressSummarySchema.nullable(),
  deliveryContact: omsDeliveryContactProjectionSchema.optional(),
  billingAddress: omsAddressSummarySchema.nullable(),
  deliverySelection: omsDeliverySelectionSchema.nullable().default(null),
  lines: z.array(omsOrderLineSchema),
  subscription: omsSubscriptionContextSchema,
  fulfillmentEligibility: omsFulfillmentEligibilitySchema,
  inventory: omsInventorySummarySchema,
  fulfillment: omsFulfillmentSummarySchema,
  replacementChain: omsReplacementChainSchema.optional().default(defaultOmsReplacementChain),
  fulfillmentHealth: omsFulfillmentHealthSchema,
  fulfillmentDebug: omsFulfillmentDebugSchema.optional().default(defaultOmsFulfillmentDebug),
  accounting: omsAccountingSummarySchema,
  actionEligibility: omsOrderActionEligibilitySchema,
  holds: z.array(omsOrderHoldSchema),
  operations: z.array(omsOrderOperationSchema),
  payment: omsPaymentSummarySchema,
  paymentAttempts: z.array(omsPaymentAttemptSchema),
  paymentTransitions: z.array(omsPaymentTransitionSchema),
  communicationDeliveries: z.array(omsCommunicationDeliverySchema),
});

export const adminCommerceOrdersListResponseSchema = z.object({
  contractVersion: z.literal(COMMERCE_CONTRACT_VERSION),
  orders: z.array(omsOrderListItemSchema),
  summaryCounts: omsOrderListSummaryCountsSchema,
  summaryTotals: omsOrderListSummaryTotalsSchema,
  totalCount: z.number().int().min(0),
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
}).strict();

export const adminCommerceOrderDetailResponseSchema = z.object({
  contractVersion: z.literal(COMMERCE_CONTRACT_VERSION),
  order: omsOrderDetailSchema,
});

export const adminCommerceOrderHoldResponseSchema = z.object({
  contractVersion: z.literal(COMMERCE_CONTRACT_VERSION),
  hold: omsOrderHoldSchema,
  operationId: uuidSchema,
  replayed: z.boolean(),
});

export const adminCommerceOrderNoteResponseSchema = z.object({
  contractVersion: z.literal(COMMERCE_CONTRACT_VERSION),
  operation: omsOrderOperationSchema,
  replayed: z.boolean(),
});

export const adminCommerceOrderUpdateShippingAddressResponseSchema = z.object({
  contractVersion: z.literal(COMMERCE_CONTRACT_VERSION),
  result: z.enum(["applied", "replayed"]),
  scope: z.enum(["order", "parcel"]),
  deliveryContact: omsDeliveryContactSchema,
  operation: omsOrderOperationSchema,
  address: z.object({
    recipientName: nullableTextSchema,
    contactEmail: nullableTextSchema,
    contactPhone: nullableTextSchema,
    line1: nullableTextSchema,
    line2: nullableTextSchema,
    city: nullableTextSchema,
    postalCode: nullableTextSchema,
    country: nullableTextSchema,
  }).strict(),
  replayed: z.boolean(),
}).strict();

// Mirrors what `commerce_oms_request_replacement_shipment` returns. `releasedHoldIds`
// is the audit trail of D-R6: the command releases only `fulfillment_exception` holds,
// and the operator is shown exactly which ones went.
export const adminCommerceOrderRequestReplacementShipmentResponseSchema = z.object({
  contractVersion: z.literal(COMMERCE_CONTRACT_VERSION),
  operation: omsOrderOperationSchema,
  replacement: z.object({
    fulfillmentOrderId: z.string().uuid(),
    orderId: z.string().uuid(),
    sequenceNo: z.number().int().min(1),
    replacesFulfillmentOrderId: z.string().uuid(),
    reason: z.enum(["damaged", "lost", "returned_undelivered", "other"]),
    status: z.string(),
  }),
  releasedHoldIds: z.array(z.string().uuid()).default([]),
  replayed: z.boolean(),
});

export const adminCommerceOrderPaymentLinkResponseSchema = z.object({
  // The raw token, once: storage is hash-only, so nothing ever reads it back. `emailQueued` is always sent, false for the copy flow, and true only once the email is durably enqueued.
  token: z.string().min(1), expiresAt: z.string().datetime({ offset: true }), orderRef: z.string().min(1), emailQueued: z.boolean() }).strict();

export const adminCommerceOrderMarkRefundedResponseSchema = z.object({
  contractVersion: z.literal(COMMERCE_CONTRACT_VERSION),
  orderId: uuidSchema,
  status: orderStatusSchema,
  replayed: z.boolean(),
}).strict();
