import { requestBff, type BffRequestOptions } from "@/lib/bff/client";

import {
  adminPromotionUpdateResponseSchema,
  adminPromotionsListResponseSchema,
  adminSetCatalogPriceResponseSchema,
  adminSetShippingRateResponseSchema,
  adminSetSubscriptionBandResponseSchema,
  adminShippingRateResponseSchema,
  adminSubscriptionBandResponseSchema,
  type AdminPromotionUpdateRequest,
  type AdminPromotionUpdateResponse,
  type AdminPromotionsListResponse,
  type AdminSetCatalogPriceRequest,
  type AdminSetCatalogPriceResponse,
  type AdminSetShippingRateRequest,
  type AdminSetShippingRateResponse,
  type AdminSetSubscriptionBandRequest,
  type AdminSetSubscriptionBandResponse,
  type AdminShippingRateResponse,
  type AdminSubscriptionBandResponse,
} from "./adminPromotionsContracts";

/** Browser → BFF clients for the admin "Rabaty" surface. Bearer-authed admin only. */

function authHeaders(accessToken: string, options: BffRequestOptions): Headers {
  const headers = new Headers(options.headers);
  headers.set("Authorization", `Bearer ${accessToken}`);
  return headers;
}

export function getAdminPromotions(
  accessToken: string,
  options: BffRequestOptions = {},
): Promise<AdminPromotionsListResponse> {
  return requestBff("/api/bff/admin/commerce/promotions/list", adminPromotionsListResponseSchema, {
    ...options,
    method: "GET",
    headers: authHeaders(accessToken, options),
  });
}

export function updateAdminPromotion(
  accessToken: string,
  request: AdminPromotionUpdateRequest,
  options: BffRequestOptions = {},
): Promise<AdminPromotionUpdateResponse> {
  return requestBff("/api/bff/admin/commerce/promotions/update", adminPromotionUpdateResponseSchema, {
    ...options,
    method: "POST",
    headers: authHeaders(accessToken, options),
    body: request,
  });
}

export function getAdminSubscriptionBand(
  accessToken: string,
  options: BffRequestOptions = {},
): Promise<AdminSubscriptionBandResponse> {
  return requestBff("/api/bff/admin/commerce/subscription-band", adminSubscriptionBandResponseSchema, {
    ...options,
    method: "GET",
    headers: authHeaders(accessToken, options),
  });
}

export function setAdminSubscriptionBand(
  accessToken: string,
  request: AdminSetSubscriptionBandRequest,
  options: BffRequestOptions = {},
): Promise<AdminSetSubscriptionBandResponse> {
  return requestBff("/api/bff/admin/commerce/subscription-band", adminSetSubscriptionBandResponseSchema, {
    ...options,
    method: "POST",
    headers: authHeaders(accessToken, options),
    body: request,
  });
}

export function setAdminCatalogPrice(
  accessToken: string,
  request: AdminSetCatalogPriceRequest,
  options: BffRequestOptions = {},
): Promise<AdminSetCatalogPriceResponse> {
  return requestBff("/api/bff/admin/commerce/catalog-prices", adminSetCatalogPriceResponseSchema, {
    ...options,
    method: "POST",
    headers: authHeaders(accessToken, options),
    body: request,
  });
}

export function getAdminShippingRate(
  accessToken: string,
  options: BffRequestOptions = {},
): Promise<AdminShippingRateResponse> {
  return requestBff("/api/bff/admin/commerce/shipping-rate", adminShippingRateResponseSchema, {
    ...options,
    method: "GET",
    headers: authHeaders(accessToken, options),
  });
}

export function setAdminShippingRate(
  accessToken: string,
  request: AdminSetShippingRateRequest,
  options: BffRequestOptions = {},
): Promise<AdminSetShippingRateResponse> {
  return requestBff("/api/bff/admin/commerce/shipping-rate", adminSetShippingRateResponseSchema, {
    ...options,
    method: "POST",
    headers: authHeaders(accessToken, options),
    body: request,
  });
}
