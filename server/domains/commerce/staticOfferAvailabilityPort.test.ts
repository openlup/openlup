import { describe, expect, it } from "vitest";

import { createStaticOfferAvailabilityPort } from "./staticOfferAvailabilityPort.js";

describe("createStaticOfferAvailabilityPort", () => {
  it("returns available visibility for every requested SKU", async () => {
    const port = createStaticOfferAvailabilityPort();

    const availability = await port.getAvailability({
      items: [
        {
          sku: "OPENLUP-DOG-LAMB-CAN-400G",
          productSlug: "lamb",
          variantId: "lamb-400g",
          requestedQuantity: 12,
          checkoutMode: "one_time",
        },
      ],
    });

    expect(availability).toEqual([
      expect.objectContaining({
        sku: "OPENLUP-DOG-LAMB-CAN-400G",
        productSlug: "lamb",
        variantId: "lamb-400g",
        status: "available",
        visibleInConfigurator: true,
        sellableNow: null,
        reasonCode: "static_available",
        source: "static",
      }),
    ]);
  });
});
