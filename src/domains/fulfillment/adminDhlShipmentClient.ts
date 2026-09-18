import { requestBff, type BffRequestOptions } from "@/lib/bff/client";
import {
  bookDhlCourierResponseSchema,
  clearDhlShipmentStateResponseSchema,
  createDhlShipmentResponseSchema,
  getDhlLabelResponseSchema,
  mergeDhlLabelsResponseSchema,
  repairDhlCourierPickupResponseSchema,
  type BookDhlCourierRequest,
  type BookDhlCourierResponse,
  type ClearDhlShipmentStateRequest,
  type ClearDhlShipmentStateResponse,
  type CreateDhlShipmentRequest,
  type CreateDhlShipmentResponse,
  type GetDhlLabelRequest,
  type GetDhlLabelResponse,
  type MergeDhlLabelsRequest,
  type MergeDhlLabelsResponse,
  type RepairDhlCourierPickupRequest,
  type RepairDhlCourierPickupResponse,
} from "./contracts";

const CREATE_PATH = "/api/bff/admin/fulfillment/dhl-create-shipment";
const LABEL_PATH = "/api/bff/admin/fulfillment/dhl-label";
const MERGE_LABELS_PATH = "/api/bff/admin/fulfillment/dhl-merge-labels";
const BOOK_COURIER_PATH = "/api/bff/admin/fulfillment/dhl-book-courier";
const REPAIR_COURIER_PICKUP_PATH = "/api/bff/admin/fulfillment/dhl-repair-courier-pickup";
const CLEAR_STATE_PATH = "/api/bff/admin/fulfillment/dhl-clear-shipment-state";

export function createAdminDhlShipment(
  accessToken: string,
  request: CreateDhlShipmentRequest,
  options: BffRequestOptions = {},
): Promise<CreateDhlShipmentResponse> {
  return requestBff(CREATE_PATH, createDhlShipmentResponseSchema, {
    ...options,
    method: "POST",
    headers: authHeaders(accessToken, options),
    body: request,
  });
}

export function getAdminDhlLabel(
  accessToken: string,
  request: GetDhlLabelRequest,
  options: BffRequestOptions = {},
): Promise<GetDhlLabelResponse> {
  return requestBff(LABEL_PATH, getDhlLabelResponseSchema, {
    ...options,
    method: "POST",
    headers: authHeaders(accessToken, options),
    body: request,
  });
}

export function mergeAdminDhlLabels(
  accessToken: string,
  request: MergeDhlLabelsRequest,
  options: BffRequestOptions = {},
): Promise<MergeDhlLabelsResponse> {
  return requestBff(MERGE_LABELS_PATH, mergeDhlLabelsResponseSchema, {
    ...options,
    method: "POST",
    headers: authHeaders(accessToken, options),
    body: request,
  });
}

export function bookAdminDhlCourier(
  accessToken: string,
  request: BookDhlCourierRequest,
  options: BffRequestOptions = {},
): Promise<BookDhlCourierResponse> {
  return requestBff(BOOK_COURIER_PATH, bookDhlCourierResponseSchema, {
    ...options,
    method: "POST",
    headers: authHeaders(accessToken, options),
    body: request,
  });
}

export function repairAdminDhlCourierPickup(
  accessToken: string,
  request: RepairDhlCourierPickupRequest,
  options: BffRequestOptions = {},
): Promise<RepairDhlCourierPickupResponse> {
  return requestBff(REPAIR_COURIER_PICKUP_PATH, repairDhlCourierPickupResponseSchema, {
    ...options,
    method: "POST",
    headers: authHeaders(accessToken, options),
    body: request,
  });
}

export function clearAdminDhlShipmentState(
  accessToken: string,
  request: ClearDhlShipmentStateRequest,
  options: BffRequestOptions = {},
): Promise<ClearDhlShipmentStateResponse> {
  return requestBff(CLEAR_STATE_PATH, clearDhlShipmentStateResponseSchema, {
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
