import type {
  AdminLowStockEvidenceRequest,
  AdminLowStockEvidenceResponse,
  AdminOmnipackOperationalProofResponse,
  AdminProductReconciliationRequest,
  AdminProductReconciliationResponse,
  AdminShipmentsOverviewRequest,
  AdminShipmentsOverviewResponse,
  BookDhlCourierRequest,
  BookDhlCourierResponse,
  ClearDhlShipmentStateRequest,
  ClearDhlShipmentStateResponse,
  CleanupDhlShipmentRequest,
  CleanupDhlShipmentResponse,
  CreateDhlShipmentRequest,
  CreateDhlShipmentResponse,
  GetDhlLabelRequest,
  GetDhlLabelResponse,
  MergeDhlLabelsRequest,
  MergeDhlLabelsResponse,
  RepairDhlCourierPickupRequest,
  RepairDhlCourierPickupResponse,
  ShipmentStatusReadRequest,
  ShipmentStatusReadResponse,
} from "./contracts.js";

export interface FulfillmentReadPort {
  getShipmentStatus(
    request: ShipmentStatusReadRequest,
  ): Promise<ShipmentStatusReadResponse>;
}

export interface FulfillmentDhlCleanupPort {
  cleanupDhlShipment(
    request: CleanupDhlShipmentRequest,
  ): Promise<CleanupDhlShipmentResponse>;
}

export interface FulfillmentDhlShipmentPort {
  createDhlShipment(
    request: CreateDhlShipmentRequest,
  ): Promise<CreateDhlShipmentResponse>;
  getDhlLabel(request: GetDhlLabelRequest): Promise<GetDhlLabelResponse>;
  mergeDhlLabels(request: MergeDhlLabelsRequest): Promise<MergeDhlLabelsResponse>;
  bookDhlCourier(request: BookDhlCourierRequest): Promise<BookDhlCourierResponse>;
  repairDhlCourierPickup(
    request: RepairDhlCourierPickupRequest,
  ): Promise<RepairDhlCourierPickupResponse>;
  clearDhlShipmentState(
    request: ClearDhlShipmentStateRequest,
  ): Promise<ClearDhlShipmentStateResponse>;
}

export interface FulfillmentShipmentsOverviewPort {
  getShipmentsOverview(
    request: AdminShipmentsOverviewRequest,
  ): Promise<AdminShipmentsOverviewResponse>;
}

export interface FulfillmentLowStockEvidencePort {
  getLowStockEvidence(
    request: AdminLowStockEvidenceRequest,
  ): Promise<AdminLowStockEvidenceResponse>;
}

export interface FulfillmentProductReconciliationEvidencePort {
  getProductReconciliationEvidence(
    request: AdminProductReconciliationRequest,
  ): Promise<AdminProductReconciliationResponse>;
}

export interface FulfillmentOmnipackOperationalProofPort {
  getOmnipackOperationalProof(): Promise<AdminOmnipackOperationalProofResponse>;
}

export class FulfillmentNotFoundError extends Error {
  constructor(message = "Shipment not found") {
    super(message);
    this.name = "FulfillmentNotFoundError";
  }
}

export class FulfillmentPreflightError extends Error {
  readonly details: Record<string, unknown>;

  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "FulfillmentPreflightError";
    this.details = details;
  }
}

export class FulfillmentProviderError extends Error {
  readonly provider = "dhl";
  readonly providerMessage: string;
  readonly operatorMessage: string;
  readonly retryable: boolean;
  readonly supportCode: string | null;
  readonly details: Record<string, unknown>;

  constructor(
    providerMessage: string,
    options: {
      operatorMessage?: string;
      retryable?: boolean;
      supportCode?: string | null;
      details?: Record<string, unknown>;
    } = {},
  ) {
    const operatorMessage = options.operatorMessage ?? providerMessage;
    super(operatorMessage);
    this.name = "FulfillmentProviderError";
    this.providerMessage = providerMessage;
    this.operatorMessage = operatorMessage;
    this.retryable = options.retryable ?? true;
    this.supportCode = options.supportCode ?? null;
    this.details = options.details ?? {};
  }
}
