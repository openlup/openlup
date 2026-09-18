import type { OmnipackDeliveryCarrierEvidence } from "./omnipackTrackingReferences.js";
import type {
  OmnipackDispatchAcceptanceInput,
  OmnipackDispatchAcceptanceResult,
} from "./omnipackDispatchAcceptance.js";

export interface OmnipackReconciliationFulfilment {
  provider: "omnipack";
  providerOrderId: string | null;
  fulfilmentNumber: string;
  externalNumber: string | null;
  orderNumber: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  status: string | null;
  subStatus: string | null;
  trackingNumbers: string[];
  trackingReferences?: OmnipackReconciliationTrackingReference[];
}

export interface OmnipackReconciliationTrackingReference {
  trackingNumber: string;
  trackingUrl?: string | null;
  carrier?: string | null;
  carrierKind?: string | null;
  service?: string | null;
}

export interface OmnipackReconciliationDispatchRef {
  dispatchRefId: string;
  fulfillmentOrderId: string;
  orderId: string;
  providerOrderId: string | null;
}

export type OmnipackReconciliationDeliveryCarrier = OmnipackDeliveryCarrierEvidence;

export interface OmnipackReconciliationPort {
  findDispatchRef(fulfilment: OmnipackReconciliationFulfilment): Promise<OmnipackReconciliationDispatchRef | null>;
  /**
   * Durable `commerce_fulfillment_orders.status`, read BEFORE the acceptance
   * ack so an off-track (cancelled/exception) fulfillment is skipped benignly
   * instead of raising 22023 and failing the whole job.
   * See omnipackReconciliationTerminalSkip.ts.
   */
  readLocalFulfillmentStatus(fulfillmentOrderId: string): Promise<string | null>;
  acknowledgeDispatchAcceptance(
    input: OmnipackDispatchAcceptanceInput,
  ): Promise<OmnipackDispatchAcceptanceResult>;
  latestStatusOccurredAt(fulfillmentOrderId: string): Promise<string | null>;
  readHandedOverAt(fulfillmentOrderId: string): Promise<string | null>;
  readDeliveryCarrier(fulfillmentOrderId: string): Promise<OmnipackReconciliationDeliveryCarrier | null>;
  recordStatusEvidence(input: {
    idempotencyKey: string;
    fulfillmentOrderId: string;
    dispatchRefId: string;
    providerStatus: string;
    providerSubStatus: string | null;
    localStatus: string;
    occurredAt: string | null;
    sanitizedPayload: Record<string, unknown>;
  }): Promise<{ replayed: boolean }>;
  recordTrackingReference(input: {
    idempotencyKey: string;
    orderId: string;
    fulfillmentOrderId: string;
    trackingNumber: string;
    trackingUrl: string | null;
    carrierKind: string | null;
    service: string | null;
    status: "in_transit" | "delivered";
    rawEvent: Record<string, unknown>;
  }): Promise<{ replayed: boolean; readBack: boolean }>;
  markHandedOver(input: {
    idempotencyKey: string;
    fulfillmentOrderId: string;
    suppressDispatched: boolean;
  }): Promise<{ status: string; replayed: boolean }>;
  issueAccountingInvoice?(input: {
    idempotencyKey: string;
    fulfillmentOrderId: string;
  }): Promise<void>;
  markProviderStockConsumed(input: {
    idempotencyKey: string;
    fulfillmentOrderId: string;
  }): Promise<{ status: string; replayed: boolean }>;
  recordQuarantine(input: {
    idempotencyKey: string;
    fulfilment: OmnipackReconciliationFulfilment;
    reason: string;
  }): Promise<{ replayed: boolean }>;
  recordProviderException(input: {
    idempotencyKey: string;
    orderId: string;
    fulfillmentOrderId: string;
    reason: string;
    // `reason` carries the raw provider string (provider casing); these two pin
    // the occurrence so an auto-released hold still says which observation
    // opened it.
    providerStatus: string;
    occurredAt: string | null;
  }): Promise<{ replayed: boolean }>;
}

export interface OmnipackReconciliationProvider {
  getFulfilments(params?: { page?: number; size?: number }): Promise<OmnipackReconciliationFulfilment[]>;
}

export interface OmnipackReconciliationResult {
  ok: boolean;
  checked: number;
  updated: number;
  trackingRefs: number;
  quarantined: number;
  stateConflicts: number;
  exceptions: number;
  stale: number;
  /** Fulfilments skipped because the local fulfillment is off-track (benign). */
  offTrackSkips: number;
  replayed: number;
  failures: number;
  invoiceIssueFailures: number;
  /**
   * Permanent per-fulfilment accounting refusals (SQLSTATE 22023). Counted, not
   * failed: see omnipackReconciliationInvoice.ts. Keeps counting past the
   * itemisation cap below.
   */
  invoiceIssueRefused: number;
  /** At most 10 itemised refusals, so one bad page cannot grow the jsonb column. */
  invoiceIssueRefusals: Array<{
    fulfillmentOrderId: string;
    identifier: string | null;
    sqlstate: string;
    benign: boolean;
  }>;
  providerCalls: number;
  readBacks: number;
  skipped: boolean;
  reason?: string;
}
