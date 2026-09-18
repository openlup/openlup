import { requestBff, type BffRequestOptions } from "@/lib/bff/client";
import {
  adminCommerceFulfillmentMutationResponseSchema,
  adminCommerceFulfillmentOrderDetailResponseSchema,
  adminCommerceFulfillmentOrdersListResponseSchema,
  type AdminCommerceFulfillmentCancelRequest,
  type AdminCommerceFulfillmentCreateRequest,
  type AdminCommerceFulfillmentHandOffRequest,
  type AdminCommerceFulfillmentMutationResponse,
  type AdminCommerceFulfillmentOrderDetailResponse,
  type AdminCommerceFulfillmentOrdersListRequest,
  type AdminCommerceFulfillmentOrdersListResponse,
  type AdminCommerceFulfillmentRecordLabelRequest,
  type AdminCommerceFulfillmentRecordProviderAttemptRequest,
  type AdminCommerceFulfillmentTrackingEventRequest,
} from "./commerceFulfillmentContracts";

export function getAdminCommerceFulfillmentOrders(
  accessToken: string,
  request: AdminCommerceFulfillmentOrdersListRequest = { page: 1, pageSize: 25 },
  options: BffRequestOptions = {},
): Promise<AdminCommerceFulfillmentOrdersListResponse> {
  return requestBff(
    `/api/bff/admin/fulfillment/commerce-orders?${new URLSearchParams(toQuery(request))}`,
    adminCommerceFulfillmentOrdersListResponseSchema,
    { ...options, method: "GET", headers: authHeaders(accessToken, options) },
  );
}

export function getAdminCommerceFulfillmentOrderDetail(
  accessToken: string,
  request: { fulfillmentOrderId?: string; orderId?: string },
  options: BffRequestOptions = {},
): Promise<AdminCommerceFulfillmentOrderDetailResponse> {
  return requestBff(
    `/api/bff/admin/fulfillment/commerce-orders/detail?${new URLSearchParams(toQuery(request))}`,
    adminCommerceFulfillmentOrderDetailResponseSchema,
    { ...options, method: "GET", headers: authHeaders(accessToken, options) },
  );
}

export function createAdminCommerceFulfillmentOrder(
  accessToken: string,
  request: AdminCommerceFulfillmentCreateRequest,
  options: BffRequestOptions = {},
): Promise<AdminCommerceFulfillmentMutationResponse> {
  return postMutation(accessToken, "/api/bff/admin/fulfillment/commerce-orders/create", request, options);
}

export function recordAdminCommerceFulfillmentProviderAttempt(
  accessToken: string,
  request: AdminCommerceFulfillmentRecordProviderAttemptRequest,
  options: BffRequestOptions = {},
): Promise<AdminCommerceFulfillmentMutationResponse> {
  return postMutation(
    accessToken,
    "/api/bff/admin/fulfillment/commerce-orders/record-provider-attempt",
    request,
    options,
  );
}

export function recordAdminCommerceFulfillmentLabel(
  accessToken: string,
  request: AdminCommerceFulfillmentRecordLabelRequest,
  options: BffRequestOptions = {},
): Promise<AdminCommerceFulfillmentMutationResponse> {
  return postMutation(accessToken, "/api/bff/admin/fulfillment/commerce-orders/record-label", request, options);
}

export function handOffAdminCommerceFulfillmentOrder(
  accessToken: string,
  request: AdminCommerceFulfillmentHandOffRequest,
  options: BffRequestOptions = {},
): Promise<AdminCommerceFulfillmentMutationResponse> {
  return postMutation(accessToken, "/api/bff/admin/fulfillment/commerce-orders/hand-off", request, options);
}

export function recordAdminCommerceFulfillmentTrackingEvent(
  accessToken: string,
  request: AdminCommerceFulfillmentTrackingEventRequest,
  options: BffRequestOptions = {},
): Promise<AdminCommerceFulfillmentMutationResponse> {
  return postMutation(
    accessToken,
    "/api/bff/admin/fulfillment/commerce-orders/record-tracking-event",
    request,
    options,
  );
}

export function cancelAdminCommerceFulfillmentOrder(
  accessToken: string,
  request: AdminCommerceFulfillmentCancelRequest,
  options: BffRequestOptions = {},
): Promise<AdminCommerceFulfillmentMutationResponse> {
  return postMutation(accessToken, "/api/bff/admin/fulfillment/commerce-orders/cancel", request, options);
}

function postMutation(
  accessToken: string,
  path: string,
  request: unknown,
  options: BffRequestOptions,
): Promise<AdminCommerceFulfillmentMutationResponse> {
  return requestBff(path, adminCommerceFulfillmentMutationResponseSchema, {
    ...options,
    method: "POST",
    headers: authHeaders(accessToken, options),
    body: request,
  });
}

function authHeaders(accessToken: string, options: BffRequestOptions): Headers {
  const headers = new Headers(options.headers);
  headers.set("Authorization", `Bearer ${accessToken}`);
  return headers;
}

function toQuery(request: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(request)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, String(value)]),
  );
}
