import { describe, expect, it } from "vitest";
import * as app from "./targetPriceAllocation.js";
import * as core from "@openlup/core/pricing";
import { quoteLineSchema } from "../commerce/contracts.js";
import { COMMERCE_CURRENCIES } from "../commerce/types.js";

const currency = COMMERCE_CURRENCIES[0];

/** Wrap one allocated line in the smallest quote line the real schema accepts. */
function asQuoteLine(line: core.BundleAllocatedLine, productSlug: string) {
  const grossAmount = { amountMinor: line.lineSubtotalMinor, currency };
  return {
    sku: line.sku,
    productSlug,
    quantity: line.quantity,
    unitPriceGross: { amountMinor: line.effectiveUnitPriceMinor, currency },
    lineSubtotalGross: grossAmount,
    tax: {
      included: true as const,
      country: "ZZ",
      category: "standard",
      vatRateBps: 0,
      legalBasis: "neutral test basis",
      netAmount: grossAmount,
      vatAmount: { amountMinor: 0, currency },
      grossAmount,
    },
  };
}

const compositions = [
  // Divides evenly on every component.
  { components: [{ sku: "UNIT-A", unitPriceMinor: 1_000, quantity: 4 }], targetPriceMinor: 3_600 },
  // Does not divide: the component must emit two lines to stay exact.
  { components: [{ sku: "UNIT-A", unitPriceMinor: 1_000, quantity: 3 }], targetPriceMinor: 2_500 },
  // Several rounding-hostile components at once.
  {
    components: [
      { sku: "UNIT-A", unitPriceMinor: 1_009, quantity: 7 },
      { sku: "UNIT-B", unitPriceMinor: 2_503, quantity: 3 },
      { sku: "UNIT-C", unitPriceMinor: 97, quantity: 11 },
    ],
    targetPriceMinor: 9_999,
  },
  // The floor pass engages: the cheap component would otherwise round to nothing.
  {
    components: [
      { sku: "UNIT-A", unitPriceMinor: 9_973, quantity: 2 },
      { sku: "UNIT-B", unitPriceMinor: 3, quantity: 1 },
    ],
    targetPriceMinor: 400,
  },
];

describe("target price allocation app shim", () => {
  it("re-exports package-owned allocation behavior", () => {
    expect(app.allocateBundleTargetPrice).toBe(core.allocateBundleTargetPrice);
    expect(app.BUNDLE_ALLOCATION_FAILURE_CODES).toBe(core.BUNDLE_ALLOCATION_FAILURE_CODES);
    expect(app.DEFAULT_MINIMUM_UNIT_PAYABLE_MINOR).toBe(core.DEFAULT_MINIMUM_UNIT_PAYABLE_MINOR);
  });

  it("emits lines that the real quote line schema accepts and that still sum to the target", () => {
    for (const composition of compositions) {
      const result = app.allocateBundleTargetPrice(composition);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;

      let charged = 0;
      for (const line of result.lines) {
        // The identity the schema refines is exactly what the two-line split protects:
        // unitPriceGross.amountMinor * quantity === lineSubtotalGross.amountMinor.
        const parsed = quoteLineSchema.parse(asQuoteLine(line, "unit-a"));
        expect(parsed.unitPriceGross.amountMinor * parsed.quantity)
          .toBe(parsed.lineSubtotalGross.amountMinor);
        charged += parsed.lineSubtotalGross.amountMinor;
      }

      expect(charged).toBe(composition.targetPriceMinor);
    }
  });

  it("proves the replay would catch a rounded unit price instead of a split", () => {
    const result = app.allocateBundleTargetPrice({
      components: [{ sku: "UNIT-A", unitPriceMinor: 1_000, quantity: 3 }],
      targetPriceMinor: 2_500,
    });

    expect(result).toMatchObject({ ok: true, components: [{ hasSplitPricing: true }] });
    // One rounded line carrying the whole subtotal is what the split exists to avoid;
    // the schema rejects it, so this test fails loudly if the kernel ever regresses.
    expect(() => quoteLineSchema.parse(asQuoteLine(
      { sku: "UNIT-A", quantity: 3, effectiveUnitPriceMinor: 833, lineSubtotalMinor: 2_500 },
      "unit-a",
    ))).toThrow(/subtotal must match unit price and quantity/);
  });
});
