import type {
  AdminCommerceFulfillmentCancelRequest,
  AdminCommerceFulfillmentCreateRequest,
  AdminCommerceFulfillmentHandOffRequest,
  AdminCommerceFulfillmentMutationResponse,
  AdminCommerceFulfillmentOrderDetailRequest,
  AdminCommerceFulfillmentOrderDetailResponse,
  AdminCommerceFulfillmentOrdersListRequest,
  AdminCommerceFulfillmentOrdersListResponse,
  AdminCommerceFulfillmentRecordLabelRequest,
  AdminCommerceFulfillmentRecordProviderAttemptRequest,
  AdminCommerceFulfillmentTrackingEventRequest,
} from "./commerceFulfillmentContracts.js";

export interface CommerceFulfillmentReadPort {
  listCommerceFulfillmentOrders(
    request: AdminCommerceFulfillmentOrdersListRequest,
  ): Promise<AdminCommerceFulfillmentOrdersListResponse>;
  getCommerceFulfillmentOrderDetail(
    request: AdminCommerceFulfillmentOrderDetailRequest,
  ): Promise<AdminCommerceFulfillmentOrderDetailResponse | null>;
}

export interface CommerceFulfillmentMutationPort {
  createCommerceFulfillmentOrder(
    request: AdminCommerceFulfillmentCreateRequest & { actorUserId: string },
  ): Promise<AdminCommerceFulfillmentMutationResponse>;
  recordCommerceFulfillmentProviderAttempt(
    request: AdminCommerceFulfillmentRecordProviderAttemptRequest & { actorUserId: string },
  ): Promise<AdminCommerceFulfillmentMutationResponse>;
  recordCommerceFulfillmentLabel(
    request: AdminCommerceFulfillmentRecordLabelRequest & { actorUserId: string },
  ): Promise<AdminCommerceFulfillmentMutationResponse>;
  handOffCommerceFulfillmentOrder(
    request: AdminCommerceFulfillmentHandOffRequest & { actorUserId: string },
  ): Promise<AdminCommerceFulfillmentMutationResponse>;
  recordCommerceFulfillmentTrackingEvent(
    request: AdminCommerceFulfillmentTrackingEventRequest & { actorUserId: string },
  ): Promise<AdminCommerceFulfillmentMutationResponse>;
  cancelCommerceFulfillmentOrder(
    request: AdminCommerceFulfillmentCancelRequest & { actorUserId: string },
  ): Promise<AdminCommerceFulfillmentMutationResponse>;
}

export interface ShipmentSpineResult {
  shipmentId: string;
  orderId: string;
  status: string;
  replayed: boolean;
}

export interface ShipmentSpineMutationPort {
  createShipment(request: {
    idempotencyKey: string;
    orderId: string;
    metadata?: Record<string, unknown>;
    requestedAt?: string;
  }): Promise<ShipmentSpineResult>;
  recordLabel(request: {
    idempotencyKey: string;
    shipmentId: string;
    externalRef?: string;
    metadata?: Record<string, unknown>;
    requestedAt?: string;
  }): Promise<ShipmentSpineResult>;
  handOff(request: {
    idempotencyKey: string;
    shipmentId: string;
    metadata?: Record<string, unknown>;
    requestedAt?: string;
  }): Promise<ShipmentSpineResult>;
  recordTracking(request: {
    idempotencyKey: string;
    shipmentId: string;
    status: "in_transit" | "delivered";
    externalRef?: string;
    metadata?: Record<string, unknown>;
    requestedAt?: string;
  }): Promise<ShipmentSpineResult>;
  cancel(request: {
    idempotencyKey: string;
    shipmentId: string;
    reason: string;
    metadata?: Record<string, unknown>;
    requestedAt?: string;
  }): Promise<ShipmentSpineResult>;
  raiseException(request: {
    idempotencyKey: string;
    shipmentId: string;
    reason: string;
    metadata?: Record<string, unknown>;
    requestedAt?: string;
  }): Promise<ShipmentSpineResult>;
}

export class CommerceFulfillmentPersistenceError extends Error {
  readonly details: Record<string, unknown>;

  constructor(message = "Commerce fulfillment persistence failed", details: Record<string, unknown> = {}) {
    super(message);
    this.name = "CommerceFulfillmentPersistenceError";
    this.details = details;
  }
}

export class CommerceFulfillmentConflictError extends Error {
  readonly details: Record<string, unknown>;

  constructor(message = "Commerce fulfillment conflict", details: Record<string, unknown> = {}) {
    super(message);
    this.name = "CommerceFulfillmentConflictError";
    this.details = details;
  }
}
