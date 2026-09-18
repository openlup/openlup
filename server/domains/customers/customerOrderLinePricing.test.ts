import { describe, expect, it } from "vitest";
import { lineListTotalMinor } from "./customerOrderLinePricing.js";

describe("lineListTotalMinor", () => {
  it("sums base-unit pricing components from an immutable order snapshot", () => {
    expect(
      lineListTotalMinor({
        quoteLine: {
          pricingComponents: [
            { componentType: "base_unit", amountMinor: 1200 },
            { componentType: "discount", amountMinor: -100 },
            { componentType: "base_unit", amountMinor: 300 },
          ],
        },
      }),
    ).toBe(1500);
  });

  it("returns null when the snapshot has no base-unit list total", () => {
    expect(lineListTotalMinor({ quoteLine: { pricingComponents: [] } })).toBeNull();
    expect(lineListTotalMinor({})).toBeNull();
  });
});
