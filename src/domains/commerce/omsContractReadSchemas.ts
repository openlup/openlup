export { adminCommerceOrderHoldResponseSchema, adminCommerceOrderMarkRefundedResponseSchema, adminCommerceOrderNoteResponseSchema, adminCommerceOrderPaymentLinkResponseSchema, adminCommerceOrderRequestReplacementShipmentResponseSchema, adminCommerceOrderUpdateShippingAddressResponseSchema, omsAddressSummarySchema, omsCommunicationDeliverySchema, omsCommunicationDeliveryStatusSchema, omsCustomerSummarySchema, omsDeliveryContactProjectionSchema, omsDeliveryContactSchema, omsDeliverySelectionSchema, omsFulfillmentEligibilitySchema, omsFulfillmentHealthDigestSchema, omsFulfillmentHealthSchema, omsFulfillmentSummarySchema, omsFulfillmentTimelineEventSchema, omsFulfillmentTrackingReferenceSchema, omsInventorySummarySchema, omsOrderActionEligibilitySchema, omsOrderHoldSchema, omsOrderOperationSchema, omsPaymentAttemptSchema, omsPaymentSummarySchema, omsPaymentTransitionSchema, omsProviderOpsSlaSchema, omsReplacementChainSchema, omsSubscriptionContextSchema, omsSupersededParcelSchema } from "@openlup/platform/commerce";
import * as neutral from "@openlup/platform/commerce";
import { z } from "../../lib/validation/zod.js";
import { commerceMoneySchema } from "./contracts.js";
import { omsAccountingStatusSchema,omsProviderOpsStatusSchema } from "./omsContractBase.js";
import { omsFirstSubscriptionPricePresentationSchema,omsPricingSummarySchema } from "./omsContractReadAuxSchemas.js";
import { defaultOmsFulfillmentDebug } from "./omsFulfillmentDebugSchemas.js";
export { omsPricingSummarySchema } from "./omsContractReadAuxSchemas.js";
export const omsPetSummarySchema = z.object({
  id: neutral.uuidSchema,
  name: neutral.nullableTextSchema,
  petType: neutral.nullableTextSchema,
  breed: neutral.nullableTextSchema,
  ageLabel: neutral.nullableTextSchema,
  weightKg: z.number().nullable(),
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
const boundOmsAccountingSummarySchema = neutral.omsAccountingSummarySchema.omit({ fiscalStatus: true }).extend({ status: omsAccountingStatusSchema, ksefStatus: neutral.nullableTextSchema });

export const omsAccountingSummarySchema = z.object({
  status: boundOmsAccountingSummarySchema.shape.status,
  invoiceId: boundOmsAccountingSummarySchema.shape.invoiceId,
  invoiceRef: boundOmsAccountingSummarySchema.shape.invoiceRef,
  providerKind: boundOmsAccountingSummarySchema.shape.providerKind,
  providerInvoiceNumber: boundOmsAccountingSummarySchema.shape.providerInvoiceNumber,
  ksefStatus: boundOmsAccountingSummarySchema.shape.ksefStatus,
  outboxStatus: boundOmsAccountingSummarySchema.shape.outboxStatus,
  outboxAttemptCount: boundOmsAccountingSummarySchema.shape.outboxAttemptCount,
  outboxNextAttemptAt: boundOmsAccountingSummarySchema.shape.outboxNextAttemptAt,
  outboxLastError: boundOmsAccountingSummarySchema.shape.outboxLastError,
  recoveryGuidance: boundOmsAccountingSummarySchema.shape.recoveryGuidance,
  updatedAt: boundOmsAccountingSummarySchema.shape.updatedAt,
}).strict();
export const omsOrderLineSchema = neutral.omsOrderLineSchema.extend({ unitPrice: commerceMoneySchema, total: commerceMoneySchema, discountAllocated: commerceMoneySchema, effectiveTotal: commerceMoneySchema, effectiveNet: commerceMoneySchema });
export const omsOrderListSummaryCountsSchema = neutral.omsOrderListSummaryCountsSchema.omit({ providerDispatchedNotPicked: true }).extend({ omnipackDispatchedNotPicked: z.number().int().min(0) });
export const omsOrderListSummaryTotalsSchema = neutral.omsOrderListSummaryTotalsSchema.extend({ gmv: commerceMoneySchema, aov: commerceMoneySchema });
const boundOmsOrderListItemSchema = neutral.omsOrderListItemSchema.extend({ pet: omsPetSummarySchema.nullable(), accountingStatus: omsAccountingStatusSchema, providerOpsStatus: omsProviderOpsStatusSchema.default("none"), total: commerceMoneySchema, pricingSummary: omsPricingSummarySchema, match: omsOrderSearchMatchSchema.optional() });

export const omsOrderListItemSchema = z.object({
  orderId: boundOmsOrderListItemSchema.shape.orderId,
  orderNumber: boundOmsOrderListItemSchema.shape.orderNumber,
  clientId: boundOmsOrderListItemSchema.shape.clientId,
  customer: boundOmsOrderListItemSchema.shape.customer,
  pet: boundOmsOrderListItemSchema.shape.pet,
  status: boundOmsOrderListItemSchema.shape.status,
  mode: boundOmsOrderListItemSchema.shape.mode,
  sourceKind: boundOmsOrderListItemSchema.shape.sourceKind,
  sourceChannelSlug: boundOmsOrderListItemSchema.shape.sourceChannelSlug,
  sourceOrderRef: boundOmsOrderListItemSchema.shape.sourceOrderRef,
  paymentMethodLabel: boundOmsOrderListItemSchema.shape.paymentMethodLabel,
  paymentProvider: boundOmsOrderListItemSchema.shape.paymentProvider,
  paymentStatus: boundOmsOrderListItemSchema.shape.paymentStatus,
  fulfillmentStatus: boundOmsOrderListItemSchema.shape.fulfillmentStatus,
  customerFulfillmentStep: boundOmsOrderListItemSchema.shape.customerFulfillmentStep,
  inventoryStatus: boundOmsOrderListItemSchema.shape.inventoryStatus,
  accountingStatus: boundOmsOrderListItemSchema.shape.accountingStatus,
  providerOpsStatus: boundOmsOrderListItemSchema.shape.providerOpsStatus,
  providerOpsSla: boundOmsOrderListItemSchema.shape.providerOpsSla,
  providerOrderId: boundOmsOrderListItemSchema.shape.providerOrderId,
  attentionReason: boundOmsOrderListItemSchema.shape.attentionReason,
  nextAction: boundOmsOrderListItemSchema.shape.nextAction,
  activeHoldCount: boundOmsOrderListItemSchema.shape.activeHoldCount,
  activeHoldReasons: boundOmsOrderListItemSchema.shape.activeHoldReasons,
  fulfillmentHealthDigest: boundOmsOrderListItemSchema.shape.fulfillmentHealthDigest,
  total: boundOmsOrderListItemSchema.shape.total,
  pricingSummary: boundOmsOrderListItemSchema.shape.pricingSummary,
  createdAt: boundOmsOrderListItemSchema.shape.createdAt,
  updatedAt: boundOmsOrderListItemSchema.shape.updatedAt,
  match: boundOmsOrderListItemSchema.shape.match,
});
const boundOmsOrderDetailSchema = omsOrderListItemSchema.extend({ ...neutral.omsOrderDetailSchema.shape, ...omsOrderListItemSchema.shape, firstSubscriptionPricePresentation: omsFirstSubscriptionPricePresentationSchema.nullable().optional(), lines: z.array(omsOrderLineSchema), accounting: omsAccountingSummarySchema, fulfillmentDebug: neutral.omsFulfillmentDebugSchema.optional().default(defaultOmsFulfillmentDebug) });

export const omsOrderDetailSchema = z.object({
  ...omsOrderListItemSchema.shape,
  firstSubscriptionPricePresentation: boundOmsOrderDetailSchema.shape.firstSubscriptionPricePresentation,
  shippingAddress: boundOmsOrderDetailSchema.shape.shippingAddress,
  deliveryContact: boundOmsOrderDetailSchema.shape.deliveryContact,
  billingAddress: boundOmsOrderDetailSchema.shape.billingAddress,
  deliverySelection: boundOmsOrderDetailSchema.shape.deliverySelection,
  lines: boundOmsOrderDetailSchema.shape.lines,
  subscription: boundOmsOrderDetailSchema.shape.subscription,
  fulfillmentEligibility: boundOmsOrderDetailSchema.shape.fulfillmentEligibility,
  inventory: boundOmsOrderDetailSchema.shape.inventory,
  fulfillment: boundOmsOrderDetailSchema.shape.fulfillment,
  replacementChain: boundOmsOrderDetailSchema.shape.replacementChain,
  fulfillmentHealth: boundOmsOrderDetailSchema.shape.fulfillmentHealth,
  fulfillmentDebug: boundOmsOrderDetailSchema.shape.fulfillmentDebug,
  accounting: boundOmsOrderDetailSchema.shape.accounting,
  actionEligibility: boundOmsOrderDetailSchema.shape.actionEligibility,
  holds: boundOmsOrderDetailSchema.shape.holds,
  operations: boundOmsOrderDetailSchema.shape.operations,
  payment: boundOmsOrderDetailSchema.shape.payment,
  paymentAttempts: boundOmsOrderDetailSchema.shape.paymentAttempts,
  paymentTransitions: boundOmsOrderDetailSchema.shape.paymentTransitions,
  communicationDeliveries: boundOmsOrderDetailSchema.shape.communicationDeliveries,
});
export const adminCommerceOrdersListResponseSchema = neutral.adminCommerceOrdersListResponseSchema.extend({ orders: z.array(omsOrderListItemSchema), summaryCounts: omsOrderListSummaryCountsSchema, summaryTotals: omsOrderListSummaryTotalsSchema });
export const adminCommerceOrderDetailResponseSchema = neutral.adminCommerceOrderDetailResponseSchema.extend({ order: omsOrderDetailSchema });
