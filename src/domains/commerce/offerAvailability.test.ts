import { describe, expect, it } from "vitest";

import { deriveOfferAvailability } from "./offerAvailability.js";

const base = {
  sku: "opaque:lamb-launch.v1",
  productSlug: "lamb",
  variantId: "variant-lamb-400",
  requestedQuantity: 1,
  checkoutMode: "one_time" as const,
  source: "test",
};

describe("deriveOfferAvailability", () => {
  it("marks zero sellable stock as hidden from the configurator", () => {
    expect(deriveOfferAvailability({ ...base, sellableNow: 0 })).toMatchObject({
      status: "out_of_stock",
      visibleInConfigurator: false,
      reasonCode: "out_of_stock",
    });
  });

  it("marks positive stock at or below the threshold as low stock", () => {
    expect(deriveOfferAvailability({
      ...base,
      sellableNow: 3,
      lowStockThreshold: 5,
    })).toMatchObject({
      status: "low_stock",
      visibleInConfigurator: true,
      reasonCode: "low_stock",
    });
  });

  it("marks stock above the threshold as available", () => {
    expect(deriveOfferAvailability({
      ...base,
      sellableNow: 6,
      lowStockThreshold: 5,
    })).toMatchObject({
      status: "available",
      visibleInConfigurator: true,
      reasonCode: "stock_available",
    });
  });
});
