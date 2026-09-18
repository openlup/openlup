import { describe, expect, it } from "vitest";

import {
  allocateChargedGrossTotals,
  allocateDiscountedGrossTotals,
} from "./accountingLineAllocation.js";

describe("accounting line allocation", () => {
  it("allocates charged gross with stable largest-remainder ties", () => {
    expect(allocateChargedGrossTotals([100, 100, 100], 299)).toEqual([100, 100, 99]);
    expect(allocateChargedGrossTotals([100, 200], 300)).toEqual([100, 200]);
  });

  it("allocates the discount with the order writer tie-break", () => {
    expect(allocateDiscountedGrossTotals([100, 100, 100], 299)).toEqual([99, 100, 100]);
    expect(allocateDiscountedGrossTotals([100, 200], 300)).toEqual([100, 200]);
  });

  it("fails closed on invalid totals", () => {
    expect(() => allocateChargedGrossTotals([100], 101)).toThrow(
      "accounting_invoice_lines_below_charged_total",
    );
    expect(() => allocateChargedGrossTotals([100.5], 100)).toThrow(
      "accounting_invoice_line_totals_invalid",
    );
    expect(() => allocateDiscountedGrossTotals([100], -1)).toThrow(
      "accounting_invoice_charged_total_invalid",
    );
  });
});
