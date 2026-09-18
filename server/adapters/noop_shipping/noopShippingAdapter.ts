import type {
  CanonicalShipmentEvent,
  CreateShipmentInput,
  FulfillmentPort,
  ShipmentCreatedResult,
  ShipmentState,
} from "../../../src/domains/fulfillment/commerceV2FulfillmentPort.js";

/**
 * No-op FulfillmentPort adapter. Returns deterministic tracking ids + a transit-state
 * sequence the W8 happy-path E2E suite can replay through the inbound event log.
 *
 * D7 + vendor neutrality: this adapter is the only FulfillmentPort implementation
 * that emits the "noop_shipping" provider kind (the literal also appears in
 * preview handoff-proof validation and tests). Direct carrier execution ships under its own
 * provider_kind only when explicitly implemented; today DHL is the direct backup
 * and non-DHL couriers are OmniPack-routed dictionary entries.
 */
export function createNoopShippingAdapter(): FulfillmentPort {
  let counter = 0;
  function nextRef(prefix: string): string {
    counter += 1;
    return `${prefix}_${counter.toString().padStart(6, "0")}`;
  }

  return {
    async createShipment(input: CreateShipmentInput): Promise<ShipmentCreatedResult> {
      return {
        provider_tracking_id: nextRef(`noop_track_${input.carrier_kind}`),
        carrier_kind: input.carrier_kind,
        delivery_estimate_days: 3,
        raw_provider_payload: {
          provider_kind: "noop_shipping",
          order_id: input.order_id,
          parcel_weight_g: input.parcel.weight_g,
        },
      };
    },

    async trackShipment(providerTrackingId: string): Promise<{ state: ShipmentState; raw_provider_payload: Record<string, unknown> }> {
      return {
        state: "in_transit",
        raw_provider_payload: {
          provider_kind: "noop_shipping",
          tracking_id: providerTrackingId,
        },
      };
    },

    parseWebhook(rawPayload: Record<string, unknown>): CanonicalShipmentEvent {
      const eventId = String(rawPayload.event_id ?? nextRef("noop_ship_event"));
      const eventType =
        (rawPayload.event_type as CanonicalShipmentEvent["event_type"]) ?? "shipment.in_transit";
      const state = (rawPayload.state as ShipmentState | undefined) ?? "in_transit";
      return {
        provider_event_id: eventId,
        event_type: eventType,
        provider_tracking_id: String(rawPayload.tracking_id ?? "noop_track_unknown"),
        state,
        raw_payload: rawPayload,
      };
    },
  };
}
