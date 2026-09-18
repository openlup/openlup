/**
 * commerce-v2 W7b FulfillmentPort — canonical types + interface for the V2 commerce
 * fulfillment boundary. Lives alongside (but distinct from) the existing DHL admin
 * client code in this folder: that surface is operator-tooling for the legacy DHL
 * adapter; this surface is the data-driven port the v2 cart flow will call when W11+
 * migrates DHL behind the new boundary.
 */

export const SHIPMENT_STATES = [
  "pending",
  "label_created",
  "in_transit",
  "out_for_delivery",
  "delivered",
  "exception",
  "returned",
] as const;
export type ShipmentState = (typeof SHIPMENT_STATES)[number];

export interface ShipmentAddress {
  line1: string;
  line2?: string | null;
  city: string;
  postal_code: string;
  country: string;
}

export interface ParcelSpec {
  weight_g: number;
  length_mm?: number;
  width_mm?: number;
  height_mm?: number;
  declared_value_minor?: number;
  currency?: string;
}

export interface CreateShipmentInput {
  order_id: string;
  parcel: ParcelSpec;
  address: ShipmentAddress;
  carrier_kind: string;
  cod_amount_minor?: number;
}

export interface ShipmentCreatedResult {
  provider_tracking_id: string;
  carrier_kind: string;
  delivery_estimate_days: number | null;
  raw_provider_payload: Record<string, unknown>;
}

export interface CanonicalShipmentEvent {
  provider_event_id: string;
  event_type:
    | "shipment.created"
    | "shipment.in_transit"
    | "shipment.delivered"
    | "shipment.exception"
    | "shipment.returned";
  provider_tracking_id: string;
  state: ShipmentState;
  raw_payload: Record<string, unknown>;
}

/**
 * Canonical FulfillmentPort. Today its only implementer is the no-op adapter
 * (server/adapters/noop_shipping) used by CI and hidden previews; the DHL direct
 * backup and the hidden-preview simulator implement the separate
 * OrderPaidFulfillmentPort contract (server/domains/commerce/outboxOrderPaidFulfillmentPorts.ts),
 * with migration onto this port still planned. InPost, DPD, Orlen, and other
 * non-DHL couriers are currently OmniPack-routed carrier dictionary entries
 * rather than direct app-owned adapters.
 *
 * The interface deliberately stops at "create shipment + track shipment + parse
 * webhook" — printing labels, dispute resolution, and refund-on-return remain
 * provider-specific operator tooling that does NOT travel through the canonical
 * boundary. That tooling lives next to this file (adminDhl*.ts) and continues to
 * be the operator surface in production.
 */
export interface FulfillmentPort {
  createShipment(input: CreateShipmentInput): Promise<ShipmentCreatedResult>;
  trackShipment(providerTrackingId: string): Promise<{ state: ShipmentState; raw_provider_payload: Record<string, unknown> }>;
  parseWebhook(rawPayload: Record<string, unknown>): CanonicalShipmentEvent;
}

export class FulfillmentProviderNotConfiguredError extends Error {
  constructor(providerKind: string) {
    super(`No FulfillmentPort adapter wired for provider_kind=${providerKind}`);
    this.name = "FulfillmentProviderNotConfiguredError";
  }
}
