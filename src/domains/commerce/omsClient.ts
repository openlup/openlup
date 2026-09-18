import { requestBff, type BffRequestOptions } from "@/lib/bff/client";
import {
  adminCommerceOrderDetailResponseSchema,
  adminCommerceOrderHoldResponseSchema,
  adminCommerceOrderMarkRefundedResponseSchema,
  adminCommerceOrderNoteResponseSchema,
  adminCommerceOrderPaymentLinkResponseSchema,
  adminCommerceOrderRequestReplacementShipmentResponseSchema,
  adminCommerceOrderUpdateShippingAddressResponseSchema,
  adminCommerceOrdersListResponseSchema,
  type AdminCommerceOrderDetailResponse,
  type AdminCommerceOrderHoldRequest,
  type AdminCommerceOrderHoldResponse,
  type AdminCommerceOrderMarkRefundedRequest,
  type AdminCommerceOrderMarkRefundedResponse,
  type AdminCommerceOrderCancelRequest,
  type AdminCommerceOrderNoteRequest,
  type AdminCommerceOrderNoteResponse,
  type AdminCommerceOrderReleaseHoldRequest,
  type AdminCommerceOrderPaymentLinkRequest,
  type AdminCommerceOrderPaymentLinkResponse,
  type AdminCommerceOrderRequestReplacementShipmentRequest,
  type AdminCommerceOrderRequestReplacementShipmentResponse,
  type AdminCommerceOrderUpdateShippingAddressRequest,
  type AdminCommerceOrderUpdateShippingAddressResponse,
  type AdminCommerceOrdersListRequestInput,
  type AdminCommerceOrdersListResponse,
} from "./omsContracts";
import {
  adminPaidFulfillmentRecoveryExecuteResponseSchema,
  adminPaidFulfillmentRecoveryPreviewResponseSchema,
  type AdminPaidFulfillmentRecoveryExecuteRequest,
  type AdminPaidFulfillmentRecoveryExecuteResponse,
  type AdminPaidFulfillmentRecoveryPreviewRequest,
  type AdminPaidFulfillmentRecoveryPreviewResponse,
} from "./recoveryOpsContracts";
import {
  adminCommerceRenewalExceptionsResponseSchema,
  type AdminCommerceRenewalExceptionsRequestInput,
  type AdminCommerceRenewalExceptionsResponse,
} from "./renewalExceptionContracts";

export function getAdminCommerceOrders(
  accessToken: string,
  request: AdminCommerceOrdersListRequestInput = { page: 1, pageSize: 25 },
  options: BffRequestOptions = {},
): Promise<AdminCommerceOrdersListResponse> {
  return requestBff(
    "/api/bff/admin/commerce/orders",
    adminCommerceOrdersListResponseSchema,
    { ...options, method: "POST", headers: authHeaders(accessToken, options), body: request },
  );
}

export function getAdminCommerceOrderDetail(
  accessToken: string,
  orderId: string,
  options: BffRequestOptions = {},
): Promise<AdminCommerceOrderDetailResponse> {
  return requestBff(
    `/api/bff/admin/commerce/orders/detail?${new URLSearchParams({ orderId })}`,
    adminCommerceOrderDetailResponseSchema,
    { ...options, method: "GET", headers: authHeaders(accessToken, options) },
  );
}

export function getAdminCommerceRenewalExceptions(
  accessToken: string,
  request: AdminCommerceRenewalExceptionsRequestInput = { page: 1, pageSize: 25 },
  options: BffRequestOptions = {},
): Promise<AdminCommerceRenewalExceptionsResponse> {
  return requestBff(
    "/api/bff/admin/commerce/renewal-exceptions",
    adminCommerceRenewalExceptionsResponseSchema,
    { ...options, method: "POST", headers: authHeaders(accessToken, options), body: request },
  );
}

export function previewAdminPaidFulfillmentRecovery(
  accessToken: string,
  request: AdminPaidFulfillmentRecoveryPreviewRequest,
  options: BffRequestOptions = {},
): Promise<AdminPaidFulfillmentRecoveryPreviewResponse> {
  return requestBff(
    "/api/bff/admin/commerce/paid-fulfillment-recovery",
    adminPaidFulfillmentRecoveryPreviewResponseSchema,
    { ...options, method: "POST", headers: authHeaders(accessToken, options), body: request },
  );
}

export function executeAdminPaidFulfillmentRecovery(
  accessToken: string,
  request: AdminPaidFulfillmentRecoveryExecuteRequest,
  options: BffRequestOptions = {},
): Promise<AdminPaidFulfillmentRecoveryExecuteResponse> {
  return requestBff(
    "/api/bff/admin/commerce/paid-fulfillment-recovery",
    adminPaidFulfillmentRecoveryExecuteResponseSchema,
    { ...options, method: "POST", headers: authHeaders(accessToken, options), body: request },
  );
}

export function createAdminCommerceOrderHold(
  accessToken: string,
  request: AdminCommerceOrderHoldRequest,
  options: BffRequestOptions = {},
): Promise<AdminCommerceOrderHoldResponse> {
  return requestBff("/api/bff/admin/commerce/orders/hold", adminCommerceOrderHoldResponseSchema, {
    ...options,
    method: "POST",
    headers: authHeaders(accessToken, options),
    body: request,
  });
}

export function releaseAdminCommerceOrderHold(
  accessToken: string,
  request: AdminCommerceOrderReleaseHoldRequest,
  options: BffRequestOptions = {},
): Promise<AdminCommerceOrderHoldResponse> {
  return requestBff(
    "/api/bff/admin/commerce/orders/release-hold",
    adminCommerceOrderHoldResponseSchema,
    {
      ...options,
      method: "POST",
      headers: authHeaders(accessToken, options),
      body: request,
    },
  );
}

export function addAdminCommerceOrderNote(
  accessToken: string,
  request: AdminCommerceOrderNoteRequest,
  options: BffRequestOptions = {},
): Promise<AdminCommerceOrderNoteResponse> {
  return requestBff("/api/bff/admin/commerce/orders/note", adminCommerceOrderNoteResponseSchema, {
    ...options,
    method: "POST",
    headers: authHeaders(accessToken, options),
    body: request,
  });
}

export function markAdminCommerceOrderRefundedManual(
  accessToken: string,
  request: AdminCommerceOrderMarkRefundedRequest,
  options: BffRequestOptions = {},
): Promise<AdminCommerceOrderMarkRefundedResponse> {
  return requestBff("/api/bff/admin/commerce/orders/mark-refunded", adminCommerceOrderMarkRefundedResponseSchema, {
    ...options,
    method: "POST",
    headers: authHeaders(accessToken, options),
    body: request,
  });
}

export function cancelAdminCommerceUnpaidOrder(
  accessToken: string,
  request: AdminCommerceOrderCancelRequest,
  options: BffRequestOptions = {},
): Promise<AdminCommerceOrderMarkRefundedResponse> {
  return requestBff("/api/bff/admin/commerce/orders/cancel", adminCommerceOrderMarkRefundedResponseSchema, {
    ...options,
    method: "POST",
    headers: authHeaders(accessToken, options),
    body: request,
  });
}

export function requestAdminCommerceOrderReplacementShipment(
  accessToken: string,
  request: AdminCommerceOrderRequestReplacementShipmentRequest,
  options: BffRequestOptions = {},
): Promise<AdminCommerceOrderRequestReplacementShipmentResponse> {
  return requestBff(
    "/api/bff/admin/commerce/orders/request-replacement-shipment",
    adminCommerceOrderRequestReplacementShipmentResponseSchema,
    {
      ...options,
      method: "POST",
      headers: authHeaders(accessToken, options),
      body: request,
    },
  );
}

/**
 * Mints a fresh recovery link for an unpaid or expired order. Every call retires
 * the order's previous link, so the response carries the only redeemable token.
 *
 * `delivery: "email"` additionally hands that link to the transactional recovery
 * rail for the order's own customer; the response's `emailQueued` says whether it
 * was durably enqueued, and a failure to enqueue is an error rather than a link
 * with a false promise attached.
 */
export function generateAdminCommerceOrderPaymentLink(
  accessToken: string,
  request: AdminCommerceOrderPaymentLinkRequest,
  options: BffRequestOptions = {},
): Promise<AdminCommerceOrderPaymentLinkResponse> {
  return requestBff(
    "/api/bff/admin/commerce/orders/payment-link",
    adminCommerceOrderPaymentLinkResponseSchema,
    {
      ...options,
      method: "POST",
      headers: authHeaders(accessToken, options),
      body: request,
    },
  );
}

export function updateAdminCommerceOrderShippingAddress(
  accessToken: string,
  request: AdminCommerceOrderUpdateShippingAddressRequest,
  options: BffRequestOptions = {},
): Promise<AdminCommerceOrderUpdateShippingAddressResponse> {
  return requestBff(
    "/api/bff/admin/commerce/orders/update-shipping-address",
    adminCommerceOrderUpdateShippingAddressResponseSchema,
    {
      ...options,
      method: "POST",
      headers: authHeaders(accessToken, options),
      body: request,
    },
  );
}

function authHeaders(accessToken: string, options: BffRequestOptions): Headers {
  const headers = new Headers(options.headers);
  headers.set("Authorization", `Bearer ${accessToken}`);
  return headers;
}
