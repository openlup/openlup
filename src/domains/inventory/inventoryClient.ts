import { requestBff, type BffRequestOptions } from "@/lib/bff/client";
import {
  adminInventoryStockAdjustmentRequestSchema,
  inventorySubscriptionForecastResponseSchema,
  inventoryAtpResultSchema,
  inventoryReservationsListResponseSchema,
  inventoryStockAdjustmentResponseSchema,
  inventoryStockListResponseSchema,
  type AdminInventoryReservationsRequest,
  type AdminInventoryStockAdjustmentRequest,
  type AdminInventoryStockRequest,
  type AdminInventorySubscriptionForecastRequest,
  type InventoryAtpRequest,
  type InventoryAtpResult,
  type InventoryReservationsListResponse,
  type InventoryStockAdjustmentResponse,
  type InventoryStockListResponse,
  type InventorySubscriptionForecastResponse,
} from "./contracts";

export function getAdminInventoryStock(
  accessToken: string,
  request: AdminInventoryStockRequest = { page: 1, pageSize: 25, includeZero: false },
  options: BffRequestOptions = {},
): Promise<InventoryStockListResponse> {
  return requestBff(
    `/api/bff/admin/inventory/stock?${new URLSearchParams(toQuery(request))}`,
    inventoryStockListResponseSchema,
    { ...options, method: "GET", headers: authHeaders(accessToken, options) },
  );
}

export function getAdminInventoryReservations(
  accessToken: string,
  request: AdminInventoryReservationsRequest = { page: 1, pageSize: 25 },
  options: BffRequestOptions = {},
): Promise<InventoryReservationsListResponse> {
  return requestBff(
    `/api/bff/admin/inventory/reservations?${new URLSearchParams(toQuery(request))}`,
    inventoryReservationsListResponseSchema,
    { ...options, method: "GET", headers: authHeaders(accessToken, options) },
  );
}

export function checkAdminInventoryAtp(
  accessToken: string,
  request: InventoryAtpRequest,
  options: BffRequestOptions = {},
): Promise<InventoryAtpResult> {
  return requestBff("/api/bff/admin/inventory/atp-check", inventoryAtpResultSchema, {
    ...options,
    method: "POST",
    headers: authHeaders(accessToken, options),
    body: request,
  });
}

export function getAdminInventorySubscriptionForecast(
  accessToken: string,
  request: AdminInventorySubscriptionForecastRequest = { horizonDays: 60, protectionDays: 45 },
  options: BffRequestOptions = {},
): Promise<InventorySubscriptionForecastResponse> {
  return requestBff(
    `/api/bff/admin/inventory/subscription-forecast?${new URLSearchParams(toQuery(request))}`,
    inventorySubscriptionForecastResponseSchema,
    { ...options, method: "GET", headers: authHeaders(accessToken, options) },
  );
}

export function createAdminInventoryStockAdjustment(
  accessToken: string,
  request: AdminInventoryStockAdjustmentRequest,
  options: BffRequestOptions = {},
): Promise<InventoryStockAdjustmentResponse> {
  const body = adminInventoryStockAdjustmentRequestSchema.parse(request);
  return requestBff("/api/bff/admin/inventory/stock-adjustment", inventoryStockAdjustmentResponseSchema, {
    ...options,
    method: "POST",
    headers: authHeaders(accessToken, options),
    body,
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
