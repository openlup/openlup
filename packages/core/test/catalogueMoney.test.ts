import { describe, expect, it } from "vitest";
import { allocateCatalogueDiscountedGrossTotals, cataloguePositionNetFromGross } from "../src/pricing/index.js";

describe("catalogue money donor refusals (L1)", () => {
  it.each([
    { name: "negative charged total", lines: [100], charged: -1 },
    { name: "charged above the position total", lines: [100], charged: 101 },
    { name: "fractional charged total", lines: [100], charged: 99.5 },
    { name: "nonfinite charged total", lines: [100], charged: Number.NaN },
    { name: "negative position", lines: [-1, 100], charged: 98 },
    { name: "fractional position", lines: [100.5], charged: 100 },
    { name: "unsafe position", lines: [Number.MAX_SAFE_INTEGER + 1], charged: 100 },
    { name: "unsafe charged total", lines: [Number.MAX_SAFE_INTEGER], charged: Number.MAX_SAFE_INTEGER + 1 },
  ])("preserves the donor refusal for $name", ({ lines, charged }) => {
    expect(() => allocateCatalogueDiscountedGrossTotals(lines, charged))
      .toThrow(new Error("order_money_invoice_allocation_invalid"));
  });

  it.each([
    { name: "fractional gross", gross: 1.5, rate: 800 },
    { name: "fractional basis points", gross: 100, rate: 0.5 },
  ])("preserves native integer-conversion refusal for $name", ({ gross, rate }) => {
    expect(() => cataloguePositionNetFromGross(gross, rate)).toThrow(RangeError);
  });
});
