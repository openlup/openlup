import type {
  AdminInventoryReservationsRequest,
  AdminInventoryStockAdjustmentRequest,
  AdminInventoryStockRequest,
  AdminInventorySubscriptionForecastRequest,
  InventoryAtpRequest,
  InventoryAtpResult,
  InventoryReservationsListResponse,
  InventoryStockAdjustmentResponse,
  InventoryStockListResponse,
  InventorySubscriptionForecastResponse,
} from "./contracts.js";

export interface InventoryReadPort {
  listStock(request: AdminInventoryStockRequest): Promise<InventoryStockListResponse>;
  listReservations(request: AdminInventoryReservationsRequest): Promise<InventoryReservationsListResponse>;
  checkAtp(request: InventoryAtpRequest): Promise<InventoryAtpResult>;
  forecastSubscriptions(
    request: AdminInventorySubscriptionForecastRequest,
  ): Promise<InventorySubscriptionForecastResponse>;
}

export interface InventoryMutationPort {
  adjustStock(
    request: AdminInventoryStockAdjustmentRequest & { actorUserId: string },
  ): Promise<InventoryStockAdjustmentResponse>;
}

export class InventoryPersistenceError extends Error {
  readonly details: Record<string, unknown>;

  constructor(message = "Inventory persistence failed", details: Record<string, unknown> = {}) {
    super(message);
    this.name = "InventoryPersistenceError";
    this.details = details;
  }
}

export class InventoryConflictError extends Error {
  readonly details: Record<string, unknown>;

  constructor(message = "Inventory conflict", details: Record<string, unknown> = {}) {
    super(message);
    this.name = "InventoryConflictError";
    this.details = details;
  }
}
