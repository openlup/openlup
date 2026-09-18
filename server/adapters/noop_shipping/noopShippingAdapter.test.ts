import { describe, expect, it } from "vitest";
import { createNoopShippingAdapter } from "./noopShippingAdapter.js";

describe("noopShippingAdapter", () => {
  it("createShipment returns a deterministic tracking id + the requested carrier_kind", async () => {
    const adapter = createNoopShippingAdapter();
    const result = await adapter.createShipment({
      order_id: "order_42",
      parcel: { weight_g: 5600 },
      address: {
        line1: "ul. Testowa 1",
        city: "Warszawa",
        postal_code: "00-001",
        country: "PL",
      },
      carrier_kind: "noop_shipping",
    });

    expect(result.provider_tracking_id).toMatch(/^noop_track_noop_shipping_/);
    expect(result.carrier_kind).toBe("noop_shipping");
    expect(result.delivery_estimate_days).toBe(3);
  });

  it("trackShipment returns the canonical in_transit state for any tracking id", async () => {
    const adapter = createNoopShippingAdapter();
    const tracked = await adapter.trackShipment("noop_track_42");
    expect(tracked.state).toBe("in_transit");
  });

  it("parseWebhook canonicalises a shipment.delivered payload", () => {
    const adapter = createNoopShippingAdapter();
    const event = adapter.parseWebhook({
      event_id: "ship_evt_001",
      event_type: "shipment.delivered",
      tracking_id: "noop_track_42",
      state: "delivered",
    });
    expect(event.event_type).toBe("shipment.delivered");
    expect(event.provider_tracking_id).toBe("noop_track_42");
    expect(event.state).toBe("delivered");
  });
});
