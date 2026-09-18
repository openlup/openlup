import { describe, expect, it } from "vitest";
import { clearDhlShipmentStateUpdate } from "../../../adapters/dhl/cleanupAdapter.js";

describe("admin DHL clear shipment state BFF route adapters", () => {
  it("maps clear shipment state into the legacy tester update fields", () => {
    expect(clearDhlShipmentStateUpdate()).toEqual({
      tracking_number: null,
      tracking_url: null,
      dhl_shipment_id: null,
      dhl_shipment_date: null,
      label_url: null,
    });
  });
});
