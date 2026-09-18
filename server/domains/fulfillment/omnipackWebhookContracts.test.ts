import { describe, expect, it } from "vitest";
import {
  OmnipackFulfillmentStateConflict,
  type OmnipackWebhookEvidence,
  type OmnipackWebhookRouteEvent,
} from "./omnipackWebhookContracts.js";

describe("OmniPack webhook contracts", () => {
  it("exposes a typed conflict that preserves a safe machine-readable reason", () => {
    const error = new OmnipackFulfillmentStateConflict("tracking_reference_owned_by_another_order");

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(OmnipackFulfillmentStateConflict);
    expect(error.name).toBe("OmnipackFulfillmentStateConflict");
    expect(error.message).toBe("tracking_reference_owned_by_another_order");
    expect(error.reason).toBe("tracking_reference_owned_by_another_order");
  });

  it("keeps route events and provider evidence structurally distinct", () => {
    const routeEvents: OmnipackWebhookRouteEvent[] = [
      "shipment.accepted",
      "order.processing_started",
      "order.picked",
      "order.shipped",
      "order.delivered",
    ];
    const evidence: OmnipackWebhookEvidence = {
      provider: "omnipack",
      event: "DELIVERED",
      providerOrderId: "provider-order-1",
      orderNumber: "OPENLUP-1",
      fulfilmentNumber: "fulfilment-1",
      occurredAt: "2026-07-15T13:45:07.000Z",
      trackingNumbers: ["620999680488324432743247"],
      shippingMethods: ["INPOST_COURIER_STANDARD"],
    };

    expect(routeEvents).toHaveLength(5);
    expect(evidence.provider).toBe("omnipack");
    expect(evidence.trackingNumbers).toEqual(["620999680488324432743247"]);
  });
});
