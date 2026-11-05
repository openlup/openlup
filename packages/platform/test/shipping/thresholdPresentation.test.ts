import { describe, expect, it } from "vitest";
import { summarizeThresholdShipping } from "../../src/shipping/index.js";

const terms = { version: "shipping-threshold.v1" as const, currency: "XXX", flatMinor: 217, freeThresholdMinor: 1201 };
const input = { productPayableMinor: 1200, totalMinor: 1417, shippingGrossMinor: 217, shippingDiscountMinor: 0, terms };

describe("configured delivery presentation", () => {
  it.each([-1, 0, 1])("preserves the configured threshold boundary %i", delta => {
    const payable = terms.freeThresholdMinor + delta;
    const fee = delta < 0 ? terms.flatMinor : 0;
    expect(summarizeThresholdShipping({ ...input, productPayableMinor: payable, totalMinor: payable + fee, shippingGrossMinor: fee }))
      .toEqual({ hasShipping: true, effectiveShippingMinor: fee, shippingIsFree: fee === 0, remainingMinor: delta < 0 ? 1 : 0 });
  });
  it("shows only the remaining product spend and keeps a separate paid delivery", () => {
    expect(summarizeThresholdShipping({ ...input, productPayableMinor: 1000, totalMinor: 1217 }))
      .toEqual({ hasShipping: true, effectiveShippingMinor: 217, shippingIsFree: false, remainingMinor: 201 });
  });
  it.each([{ shippingGrossMinor: 0, shippingDiscountMinor: 0 }, { shippingGrossMinor: 217, shippingDiscountMinor: 217 }])(
    "shows free delivery only from effective money: %o", shipping => {
      expect(summarizeThresholdShipping({ ...input, ...shipping }))
        .toEqual({ hasShipping: true, effectiveShippingMinor: 0, shippingIsFree: true, remainingMinor: 0 });
    },
  );
  it.each([{ stale: true }, { terms: null }, { productPayableMinor: null }, { totalMinor: null }])(
    "suppresses the helper for stale or incomplete quote evidence: %o", unavailable => {
      expect(summarizeThresholdShipping({ ...input, ...unavailable }).remainingMinor).toBe(0);
    },
  );
  it("does not turn an absent shipping fact into free delivery", () => {
    expect(summarizeThresholdShipping({ ...input, shippingGrossMinor: null }))
      .toEqual({ hasShipping: false, effectiveShippingMinor: 0, shippingIsFree: false, remainingMinor: 0 });
  });
});
