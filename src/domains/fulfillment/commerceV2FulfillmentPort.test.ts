import { describe, expect, it } from "vitest";
import {
  FulfillmentProviderNotConfiguredError,
  SHIPMENT_STATES,
} from "./commerceV2FulfillmentPort.js";

describe("commerce-v2 fulfillment domain primitives", () => {
  it("exposes the canonical shipment state machine", () => {
    expect(SHIPMENT_STATES).toEqual([
      "pending",
      "label_created",
      "in_transit",
      "out_for_delivery",
      "delivered",
      "exception",
      "returned",
    ]);
  });

  it("FulfillmentProviderNotConfiguredError carries the provider_kind that needs an adapter", () => {
    const error = new FulfillmentProviderNotConfiguredError("dhl");
    expect(error.name).toBe("FulfillmentProviderNotConfiguredError");
    expect(error.message).toContain("dhl");
  });
});
