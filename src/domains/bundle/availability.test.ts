import { describe, expect, it } from "vitest";

import {
  BUNDLE_COMPONENT_STOCK_UNKNOWN,
  BUNDLE_COMPOSITION_EMPTY,
  DEFAULT_BUNDLE_LOW_STOCK_THRESHOLD,
  deriveBundleAvailability,
  type BundleAvailabilityComponent,
} from "./availability.js";
import { offerAvailabilityStatusFor } from "../commerce/ports.js";

/**
 * Vocabulary-neutral fixtures throughout: neutral sku slugs, no vendor names, no
 * currency (this kernel carries none).
 */
function component(
  sku: string,
  sellableNow: number | null,
  quantity = 1,
  isAddon = false,
): BundleAvailabilityComponent {
  return { sku, quantity, sellableNow, isAddon };
}

describe("deriveBundleAvailability", () => {
  it("takes the minimum whole-bundle count over the counted components", () => {
    const result = deriveBundleAvailability({
      components: [component("unit-a", 40), component("unit-b", 9), component("unit-c", 25)],
    });

    expect(result.sellableNow).toBe(9);
    expect(result.limitingSku).toBe("unit-b");
    expect(result.status).toBe("available");
    expect(result.reasonCode).toBe("stock_available");
  });

  it("floors the per-component quotient rather than rounding it", () => {
    // 7 units at 2 per bundle is three whole bundles, not 3.5 and not four.
    const result = deriveBundleAvailability({
      components: [component("unit-a", 7, 2), component("unit-b", 100)],
    });

    expect(result.sellableNow).toBe(3);
    expect(result.limitingSku).toBe("unit-a");
  });

  it("lets quantity, not raw stock, decide which component limits", () => {
    // unit-b holds more raw stock but is consumed ten at a time.
    const result = deriveBundleAvailability({
      components: [component("unit-a", 12), component("unit-b", 50, 10)],
    });

    expect(result.sellableNow).toBe(5);
    expect(result.limitingSku).toBe("unit-b");
  });

  it("propagates unknown from any counted component and names it", () => {
    const result = deriveBundleAvailability({
      components: [component("unit-a", 40), component("unit-b", null), component("unit-c", 0)],
    });

    expect(result.sellableNow).toBeNull();
    expect(result.status).toBe("unknown");
    expect(result.reasonCode).toBe(BUNDLE_COMPONENT_STOCK_UNKNOWN);
    // Unknown outranks the out-of-stock component: an unknown figure is never
    // resolved into a number by the parts that did answer.
    expect(result.limitingSku).toBe("unit-b");
  });

  it("names the lowest sku when several components are unknown", () => {
    const result = deriveBundleAvailability({
      components: [component("unit-z", null), component("unit-b", null), component("unit-m", null)],
    });

    expect(result.limitingSku).toBe("unit-b");
  });

  it("breaks an exact tie by ascending sku code units, regardless of input order", () => {
    const ordered = deriveBundleAvailability({
      components: [component("unit-b", 4), component("unit-a", 4)],
    });
    const reversed = deriveBundleAvailability({
      components: [component("unit-a", 4), component("unit-b", 4)],
    });

    expect(ordered.limitingSku).toBe("unit-a");
    expect(reversed.limitingSku).toBe("unit-a");
    expect(ordered).toEqual(reversed);
  });

  it("excludes add-ons by default and counts them when asked to", () => {
    const components = [component("unit-a", 30), component("unit-addon", 1, 1, true)];

    expect(deriveBundleAvailability({ components }).sellableNow).toBe(30);
    expect(
      deriveBundleAvailability({ components, includeAddonsInStock: true }).sellableNow,
    ).toBe(1);
    expect(
      deriveBundleAvailability({ components, includeAddonsInStock: true }).limitingSku,
    ).toBe("unit-addon");
  });

  it("reports an empty counted set rather than inventing a figure", () => {
    const result = deriveBundleAvailability({
      components: [component("unit-addon", 99, 1, true)],
    });

    expect(result).toEqual({
      sellableNow: null,
      status: "unknown",
      reasonCode: BUNDLE_COMPOSITION_EMPTY,
      limitingSku: null,
    });
    expect(deriveBundleAvailability({ components: [] }).reasonCode).toBe(
      BUNDLE_COMPOSITION_EMPTY,
    );
  });

  it("reads the ladder rungs off the shared single-unit status function", () => {
    const table: Array<[number, string]> = [
      [0, "out_of_stock"],
      [1, "low_stock"],
      [DEFAULT_BUNDLE_LOW_STOCK_THRESHOLD, "low_stock"],
      [DEFAULT_BUNDLE_LOW_STOCK_THRESHOLD + 1, "available"],
    ];

    for (const [sellableNow, expected] of table) {
      const result = deriveBundleAvailability({ components: [component("unit-a", sellableNow)] });
      expect(result.status).toBe(expected);
      // The identity that makes the import load-bearing: the bundle's rung is the
      // single-unit rung at the bundle's own threshold, not a second ladder.
      expect(result.status).toBe(
        offerAvailabilityStatusFor(sellableNow, DEFAULT_BUNDLE_LOW_STOCK_THRESHOLD),
      );
    }
  });

  it("honours a caller-supplied threshold", () => {
    const components = [component("unit-a", 8)];

    expect(deriveBundleAvailability({ components }).status).toBe("available");
    expect(deriveBundleAvailability({ components, lowStockThreshold: 10 }).status).toBe(
      "low_stock",
    );
  });

  it("reports out_of_stock when a component cannot carry one whole bundle", () => {
    const result = deriveBundleAvailability({
      components: [component("unit-a", 1, 4), component("unit-b", 500)],
    });

    expect(result.sellableNow).toBe(0);
    expect(result.status).toBe("out_of_stock");
    expect(result.reasonCode).toBe("out_of_stock");
    expect(result.limitingSku).toBe("unit-a");
  });
});
