import { describe, expect, it } from "vitest";

import { deriveOfferAvailability, statusForSellableNow } from "../../src/commerce/index.js";

const base = {
  sku: "ITEM-A",
  productSlug: "item-a",
  variantId: "variant-a",
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

  it("accepts boundary non-negative integers 0 and 2147483647", () => {
    expect(statusForSellableNow(1, 0)).toBe("available");
    expect(statusForSellableNow(1, 2147483647)).toBe("low_stock");
  });

  it.each([-1, 1.5, NaN, Infinity, -Infinity, 2147483648, null as unknown as number])("rejects invalid lowStockThreshold=%p even when sellableNow is null or zero", lowStockThreshold => {
    expect(() => statusForSellableNow(null, lowStockThreshold)).toThrow("offer_low_stock_threshold_invalid");
    expect(() => statusForSellableNow(0, lowStockThreshold)).toThrow("offer_low_stock_threshold_invalid");
    expect(() => deriveOfferAvailability({ ...base, sellableNow: null, lowStockThreshold })).toThrow("offer_low_stock_threshold_invalid");
  });
});
