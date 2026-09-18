import type { z } from "zod";
import { omsDeliveryContactResolutionSchema } from "./omsContractReadAuxSchemas.js";
import {
  omsAccountingStatusSchema,
  omsAttentionReasonSchema,
  omsFulfillmentBlockReasonSchema,
  omsInventoryStatusSchema,
  omsNextActionSchema,
  omsPaymentStatusSchema,
  omsProviderOpsSlaStatusSchema,
  omsProviderOpsStatusSchema,
} from "./omsContractBase.js";
import {
  adminCommerceOrderDetailRequestSchema,
  adminCommerceOrderHoldRequestSchema,
  adminCommerceOrderMarkRefundedRequestSchema,
  adminCommerceOrderCancelRequestSchema,
  adminCommerceOrderNoteRequestSchema,
  adminCommerceOrderReleaseHoldRequestSchema,
  adminCommerceOrdersListRequestSchema,
  adminCommerceOrderPaymentLinkRequestSchema,
  adminCommerceOrderRequestReplacementShipmentRequestSchema,
  adminCommerceOrderUpdateShippingAddressRequestSchema,
} from "./omsContractRequests.js";
import {
  adminCommerceOrderDetailResponseSchema,
  adminCommerceOrderHoldResponseSchema,
  adminCommerceOrderMarkRefundedResponseSchema,
  adminCommerceOrderNoteResponseSchema,
  adminCommerceOrdersListResponseSchema,
  adminCommerceOrderPaymentLinkResponseSchema,
  adminCommerceOrderRequestReplacementShipmentResponseSchema,
  adminCommerceOrderUpdateShippingAddressResponseSchema,
  omsFulfillmentHealthSchema,
  omsOrderActionEligibilitySchema,
  omsCommunicationDeliverySchema,
  omsOrderDetailSchema,
  omsOrderHoldSchema,
  omsOrderListItemSchema,
  omsOrderListSummaryCountsSchema,
  omsOrderListSummaryTotalsSchema,
  omsOrderSearchMatchSchema,
  omsPricingSummarySchema,
} from "./omsContractReadSchemas.js";

export * from "./omsContractBase.js";
export * from "./omsContractRequests.js";
export * from "./omsContractReadSchemas.js";
export { omsDeliveryContactResolutionSchema } from "./omsContractReadAuxSchemas.js";

export type AdminCommerceOrdersListRequest = z.infer<typeof adminCommerceOrdersListRequestSchema>;
export type AdminCommerceOrdersListRequestInput = z.input<typeof adminCommerceOrdersListRequestSchema>;
export type AdminCommerceOrderDetailRequest = z.infer<typeof adminCommerceOrderDetailRequestSchema>;
export type AdminCommerceOrderHoldRequest = z.infer<typeof adminCommerceOrderHoldRequestSchema>;
export type AdminCommerceOrderReleaseHoldRequest = z.infer<typeof adminCommerceOrderReleaseHoldRequestSchema>;
export type AdminCommerceOrderNoteRequest = z.infer<typeof adminCommerceOrderNoteRequestSchema>;
export type AdminCommerceOrderMarkRefundedRequest = z.infer<typeof adminCommerceOrderMarkRefundedRequestSchema>;
export type AdminCommerceOrderCancelRequest = z.infer<typeof adminCommerceOrderCancelRequestSchema>;
export type AdminCommerceOrderPaymentLinkRequest = z.infer<typeof adminCommerceOrderPaymentLinkRequestSchema>;
export type AdminCommerceOrderRequestReplacementShipmentRequest = z.infer<typeof adminCommerceOrderRequestReplacementShipmentRequestSchema>;
export type AdminCommerceOrderUpdateShippingAddressRequest = z.infer<typeof adminCommerceOrderUpdateShippingAddressRequestSchema>;
export type AdminCommerceOrdersListResponse = z.infer<typeof adminCommerceOrdersListResponseSchema>;
export type AdminCommerceOrderDetailResponse = z.infer<typeof adminCommerceOrderDetailResponseSchema>;
export type AdminCommerceOrderHoldResponse = z.infer<typeof adminCommerceOrderHoldResponseSchema>;
export type AdminCommerceOrderNoteResponse = z.infer<typeof adminCommerceOrderNoteResponseSchema>;
export type AdminCommerceOrderMarkRefundedResponse = z.infer<typeof adminCommerceOrderMarkRefundedResponseSchema>;
export type AdminCommerceOrderPaymentLinkResponse = z.infer<typeof adminCommerceOrderPaymentLinkResponseSchema>;
export type AdminCommerceOrderRequestReplacementShipmentResponse = z.infer<typeof adminCommerceOrderRequestReplacementShipmentResponseSchema>;
export type AdminCommerceOrderUpdateShippingAddressResponse = z.infer<typeof adminCommerceOrderUpdateShippingAddressResponseSchema>;
export type AdminOmsOrderListItem = z.infer<typeof omsOrderListItemSchema>;
export type AdminOmsOrderSearchMatch = z.infer<typeof omsOrderSearchMatchSchema>;
export type AdminOmsOrderListSummaryCounts = z.infer<typeof omsOrderListSummaryCountsSchema>;
export type AdminOmsOrderListSummaryTotals = z.infer<typeof omsOrderListSummaryTotalsSchema>;
export type AdminOmsAttentionReason = z.infer<typeof omsAttentionReasonSchema>;
export type AdminOmsNextAction = z.infer<typeof omsNextActionSchema>;
export type OmsOrderDetail = z.infer<typeof omsOrderDetailSchema>;
export type OmsDeliveryContactResolution = z.infer<typeof omsDeliveryContactResolutionSchema>;
export type OmsOrderHold = z.infer<typeof omsOrderHoldSchema>;
export type OmsPaymentStatus = z.infer<typeof omsPaymentStatusSchema>;
export type OmsFulfillmentBlockReason = z.infer<typeof omsFulfillmentBlockReasonSchema>;
export type OmsInventoryStatus = z.infer<typeof omsInventoryStatusSchema>;
export type OmsAccountingStatus = z.infer<typeof omsAccountingStatusSchema>;
export type AdminOmsProviderOpsStatus = z.infer<typeof omsProviderOpsStatusSchema>;
