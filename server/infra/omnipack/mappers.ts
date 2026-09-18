import {
  mapOmnipackTrackingReferences,
  type OmnipackTrackingReferenceEvidence,
} from "./trackingReferences.js";

export interface OmnipackOrderCreatedEvidence {
  provider: "omnipack";
  providerOrderId: string;
  raw: Record<string, unknown>;
}

export interface OmnipackProductCreatedEvidence {
  provider: "omnipack";
  sku: string;
  raw: Record<string, unknown>;
}

export interface OmnipackInboundCreatedEvidence {
  provider: "omnipack";
  reference: string;
  raw: Record<string, unknown>;
}

export interface OmnipackCancelOrderRequest {
  method: "DELETE";
  path: string;
  providerOrderId: string;
}

export interface OmnipackStockEvidence {
  provider: "omnipack";
  sku: string;
  totalQuantity: number;
  forSaleQuantity: number;
  reservedOrUnavailableQuantity: number;
  stockTruth: "external_stock_master_with_local_reservations";
}

export interface OmnipackStockMovementEvidence {
  provider: "omnipack";
  sku: string;
  occurredAt: string | null;
  quantity: number;
  operationType: string | null;
  warehouseDocumentNumber: string | null;
  lotNumber: string | null;
  expirationDate: string | null;
}

export interface OmnipackFulfilmentEvidence {
  provider: "omnipack";
  providerOrderId: string | null;
  fulfilmentNumber: string;
  externalNumber: string | null;
  orderNumber: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  status: string | null;
  subStatus: string | null;
  trackingNumbers: string[];
  trackingReferences: OmnipackTrackingReferenceEvidence[];
  items: Array<{ sku: string; quantity: number; lotNumber: string | null; expirationDate: string | null }>;
}

export interface OmnipackFulfilmentRequestEvidence {
  provider: "omnipack";
  warehouseDocumentNumber: string;
  warehouseName: string | null;
  state: string | null;
}

export interface OmnipackWebhookEvidence {
  provider: "omnipack";
  event: string;
  providerOrderId: string | null;
  orderNumber: string | null;
  fulfilmentNumber: string | null;
  occurredAt: string | null;
  trackingNumbers: string[];
  trackingReferences: OmnipackTrackingReferenceEvidence[];
  shippingMethods: string[];
}

export function mapOmnipackOrderCreatedResponse(body: unknown): OmnipackOrderCreatedEvidence {
  const response = asRecord(body);
  const providerOrderId = readString(response.orderId);
  if (!providerOrderId) throw new Error("omnipack_order_response_invalid");
  return {
    provider: "omnipack",
    providerOrderId,
    raw: sanitizeOmnipackPayload(response),
  };
}

// Catalog load (test-readiness). The product/inbound responses are evidence only — we read
// back authoritative stock via getStock. We tolerate a sparse response body and fall back to
// the request-side sku/reference so an idempotent re-create still yields usable evidence.
export function mapOmnipackProductCreatedResponse(body: unknown, requestSku: string): OmnipackProductCreatedEvidence {
  const response = asRecord(body);
  return {
    provider: "omnipack",
    sku: readString(response.sku) || requestSku,
    raw: sanitizeOmnipackPayload(response),
  };
}

export function mapOmnipackInboundCreatedResponse(body: unknown, requestReference: string): OmnipackInboundCreatedEvidence {
  const response = asRecord(body);
  return {
    provider: "omnipack",
    reference: readString(response.reference) || requestReference,
    raw: sanitizeOmnipackPayload(response),
  };
}

export function buildOmnipackCancelOrderRequest(providerOrderId: string): OmnipackCancelOrderRequest {
  return {
    method: "DELETE",
    path: `/orders/${encodeURIComponent(providerOrderId)}`,
    providerOrderId,
  };
}

export function mapOmnipackStockResponse(body: unknown): OmnipackStockEvidence[] {
  const stockItems = readArray(asRecord(asRecord(body)._embedded).stockItems);
  return stockItems.map((item) => {
    const row = asRecord(item);
    const totalQuantity = readNumber(row.totalQuantity);
    const forSaleQuantity = readNumber(row.forSaleQuantity);
    const unavailable = [
      row.expireSoonQuantity,
      row.faultyQuantity,
      row.complaintsQuantity,
      row.withheldQuantity,
      row.packagingQuantity,
      row.processingQuantity,
      row.unpackingQuantity,
    ].map(readNumber).reduce((sum, value) => sum + value, 0);
    return {
      provider: "omnipack",
      sku: readString(row.sku),
      totalQuantity,
      forSaleQuantity,
      reservedOrUnavailableQuantity: unavailable,
      stockTruth: "external_stock_master_with_local_reservations",
    };
  });
}

export function mapOmnipackStockMovementsResponse(body: unknown): OmnipackStockMovementEvidence[] {
  return readArray(asRecord(body)._embedded).map((item) => {
    const row = asRecord(item);
    return {
      provider: "omnipack",
      sku: readString(row.sku),
      occurredAt: readNullableString(row.occurredAt),
      quantity: readNumber(row.quantity),
      operationType: readNullableString(row.operationType),
      warehouseDocumentNumber: readNullableString(row.warehouseDocumentNumber),
      lotNumber: readNullableString(row.productLotNumber),
      expirationDate: readNullableString(row.expirationDate),
    };
  });
}

export function mapOmnipackFulfilmentsResponse(body: unknown): OmnipackFulfilmentEvidence[] {
  const fulfilments = readArray(asRecord(asRecord(body)._embedded).fulfilments);
  return fulfilments.map((item) => {
    const row = asRecord(item);
    const trackingReferences = trackingReferencesFrom(row);
    return {
      provider: "omnipack",
      providerOrderId: readNullableString(row.orderId) ?? readNullableString(row.providerOrderId),
      fulfilmentNumber: readString(row.fulfilmentNumber),
      externalNumber: readNullableString(row.externalNumber),
      orderNumber: readNullableString(row.orderNumber),
      createdAt: readNullableString(row.createdAt),
      updatedAt: readNullableString(row.updatedAt),
      status: readNullableString(row.status),
      subStatus: readNullableString(row.subStatus),
      trackingNumbers: trackingReferences.map((ref) => ref.trackingNumber),
      trackingReferences,
      items: readArray(row.items).map((rawItem) => {
        const fulfilmentItem = asRecord(rawItem);
        return {
          sku: readString(fulfilmentItem.sku),
          quantity: readNumber(fulfilmentItem.quantity),
          lotNumber: readNullableString(fulfilmentItem.productLotNumber),
          expirationDate: readNullableString(fulfilmentItem.expirationDate),
        };
      }),
    };
  });
}

export function mapOmnipackFulfilmentRequestsResponse(body: unknown): OmnipackFulfilmentRequestEvidence[] {
  const requests = readArray(asRecord(asRecord(body)._embedded).fulfilmentRequests);
  return requests.map((item) => {
    const row = asRecord(item);
    return {
      provider: "omnipack",
      warehouseDocumentNumber: readString(row.warehouseDocumentNumber),
      warehouseName: readNullableString(row.warehouseName),
      state: readNullableString(row.state),
    };
  });
}

export function mapOmnipackWebhookPayload(body: unknown, fallbackEvent = ""): OmnipackWebhookEvidence {
  const payload = asRecord(body);
  const shipments = readArray(payload.shipments).map(asRecord);
  const trackingReferences = trackingReferencesFrom({ shipments });
  return {
    provider: "omnipack",
    event: readString(payload.event) || fallbackEvent,
    providerOrderId: readNullableString(payload.orderId) ?? readNullableString(payload.providerOrderId),
    orderNumber: readNullableString(payload.orderNumber),
    fulfilmentNumber: readNullableString(payload.fulfilmentNumber),
    occurredAt: readNullableString(payload.occurredAt),
    trackingNumbers: trackingReferences.map((ref) => ref.trackingNumber),
    trackingReferences,
    shippingMethods: shipments.map((shipment) => readString(shipment.shippingMethod)).filter(Boolean),
  };
}

export function sanitizeOmnipackPayload(input: Record<string, unknown>): Record<string, unknown> {
  const blocked = new Set([
    "authorization",
    "Authorization",
    "password",
    "email",
    "phone",
    "firstName",
    "lastName",
    "name",
    "address",
    "street",
    "streetNumber",
    "houseNo",
    "flatNo",
    "city",
    "postalCode",
  ]);
  return sanitizeRecord(input, blocked);
}

function sanitizeRecord(input: Record<string, unknown>, blocked: Set<string>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input)
      .filter(([key]) => !blocked.has(key))
      .map(([key, value]) => [key, sanitizeValue(value, blocked)]),
  );
}

function sanitizeValue(input: unknown, blocked: Set<string>): unknown {
  if (Array.isArray(input)) return input.map((value) => sanitizeValue(value, blocked));
  if (input && typeof input === "object") return sanitizeRecord(input as Record<string, unknown>, blocked);
  return input;
}

function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
}

function readArray(input: unknown): unknown[] {
  return Array.isArray(input) ? input : [];
}

function readString(input: unknown): string {
  return typeof input === "string" ? input : "";
}

function readNullableString(input: unknown): string | null {
  const value = readString(input);
  return value || null;
}

function readNumber(input: unknown): number {
  return typeof input === "number" && Number.isFinite(input) ? input : 0;
}

function trackingReferencesFrom(row: Record<string, unknown>): OmnipackTrackingReferenceEvidence[] {
  return mapOmnipackTrackingReferences({
    shipments: readArray(row.shipments),
    trackingNumbers: readArray(row.trackingNumbers),
    readString,
    readNullableString,
    asRecord,
  });
}
