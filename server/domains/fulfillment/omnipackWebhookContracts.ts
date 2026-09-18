import type { VercelRequest } from "../../_lib/types/vercel.js";
import type {
  OmnipackDispatchAcceptanceInput,
  OmnipackDispatchAcceptanceResult,
} from "./omnipackDispatchAcceptance.js";
import type { NormalizedProviderStatus } from "./omnipackStatusVocabulary.js";
import type { OmnipackTrackingReferenceEvidence } from "./omnipackTrackingReferences.js";

export type OmnipackWebhookRouteEvent =
  | "shipment.accepted"
  | "order.processing_started"
  | "order.picked"
  | "order.shipped"
  | "order.delivered";

export interface OmnipackWebhookEvidence {
  provider: "omnipack";
  event: string;
  providerOrderId: string | null;
  orderNumber: string | null;
  fulfilmentNumber: string | null;
  occurredAt: string | null;
  trackingNumbers: string[];
  trackingReferences?: OmnipackTrackingReferenceEvidence[];
  shippingMethods: string[];
}

export interface ParsedOmnipackWebhookPayload {
  evidence: OmnipackWebhookEvidence;
  sanitizedPayload: Record<string, unknown>;
}

export interface OmnipackWebhookInboundEvent {
  inboundProviderEventId: string;
  replayed: boolean;
}

export interface OmnipackWebhookDispatchRef {
  dispatchRefId: string;
  fulfillmentOrderId: string;
  orderId: string;
  providerOrderId: string | null;
}

export interface OmnipackWebhookStatusEvidence {
  statusEvidenceId: string;
  replayed: boolean;
}

export class OmnipackFulfillmentStateConflict extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "OmnipackFulfillmentStateConflict";
  }
}

export interface OmnipackWebhookPort {
  ingestInboundEvent(input: {
    providerEventId: string;
    eventType: OmnipackWebhookRouteEvent;
    processingStatus: "received" | "ignored";
    payload: Record<string, unknown>;
    error: Record<string, unknown>;
  }): Promise<OmnipackWebhookInboundEvent>;
  findDispatchRef(evidence: OmnipackWebhookEvidence): Promise<OmnipackWebhookDispatchRef | null>;
  // Optional only for the disabled route's no-op port. Every enabled request
  // fails before status/effects if the acknowledgement capability is absent.
  acknowledgeDispatchAcceptance?(
    input: OmnipackDispatchAcceptanceInput,
  ): Promise<OmnipackDispatchAcceptanceResult>;
  recordStatusEvidence(input: {
    idempotencyKey: string;
    fulfillmentOrderId: string;
    dispatchRefId: string;
    providerStatus: NormalizedProviderStatus;
    providerSubStatus: string | null;
    localStatus: string;
    occurredAt: string | null;
    inboundProviderEventId: string;
    sanitizedPayload: Record<string, unknown>;
  }): Promise<OmnipackWebhookStatusEvidence>;
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
  markProviderStockConsumed(input: {
    idempotencyKey: string;
    fulfillmentOrderId: string;
  }): Promise<{ status: string; replayed: boolean }>;
  issueAccountingInvoice?(input: {
    idempotencyKey: string;
    fulfillmentOrderId: string;
  }): Promise<void>;
  markInboundEventProcessed(input: {
    inboundProviderEventId: string;
    processingStatus: "processed" | "ignored" | "failed";
    error: Record<string, unknown>;
  }): Promise<void>;
}

export interface OmnipackWebhookHandlerDeps {
  expectedEvent: OmnipackWebhookRouteEvent;
  enabled: () => boolean;
  verifyToken: (req: VercelRequest) => boolean;
  port: OmnipackWebhookPort;
  parsePayload: (req: VercelRequest) => Promise<ParsedOmnipackWebhookPayload>;
}
