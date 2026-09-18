import { describe, expect, it } from "vitest";
import { parseCatalogActiveSkuSelection } from "./catalogActiveSkuSelection.js";

describe("active SKU selection", () => {
  it("preserves omission and parses exact codes using the existing selector normalization", () => {
    expect(parseCatalogActiveSkuSelection(undefined)).toBeUndefined();
    const codes = ["  ITEM-A  ", "item-a", "0._:-", "X".repeat(160)];
    const parsed = parseCatalogActiveSkuSelection(codes);
    expect(parsed).toEqual(["ITEM-A", "item-a", "0._:-", "X".repeat(160)]);
    codes[0] = "CHANGED";
    expect(parsed?.[0]).toBe("ITEM-A");
  });

  it("accepts the full bounded selection", () => {
    const codes = Array.from({ length: 100 }, (_, index) => `ITEM-${index}`);
    expect(parseCatalogActiveSkuSelection(codes)).toEqual(codes);
  });

  it.each([
    { label: "null", value: null },
    { label: "scalar", value: "ITEM-A" },
    { label: "object", value: { 0: "ITEM-A", length: 1 } },
    { label: "empty", value: [] },
    { label: "excessive", value: Array.from({ length: 101 }, (_, index) => `ITEM-${index}`) },
    { label: "duplicate", value: ["ITEM-A", "ITEM-A"] },
    { label: "normalized duplicate", value: ["ITEM-A", " ITEM-A "] },
    { label: "blank code", value: ["  "] },
    { label: "long code", value: ["X".repeat(161)] },
    { label: "embedded whitespace", value: ["ITEM A"] },
    { label: "non-ASCII code", value: ["ITEM-ą"] },
    { label: "query syntax", value: ["ITEM-A') OR true--"] },
    { label: "number", value: [1] },
    { label: "missing entry", value: [undefined] },
    { label: "sparse entry", value: Array<string>(1) },
  ])("refuses $label without silently broadening the selection", ({ value }) => {
    expect(() => parseCatalogActiveSkuSelection(value)).toThrow("catalog_active_sku_selection_invalid");
  });
});
