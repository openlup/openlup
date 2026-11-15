import { describe, expect, it } from "vitest";
import {
  CATALOG_QUANTITY_UNITS, canonicalizeCatalogQuantity, compareCatalogQuantities, convertCatalogQuantity,
  parseCatalogQuantity, type CatalogQuantity, type CatalogQuantityUnit,
} from "../src/catalog/index.js";
const quantity = (unscaled: string, scale = 0, unit = "openlup:g", dimension: CatalogQuantity["dimension"] = "mass"): CatalogQuantity => ({ dimension, unscaled, scale, unit });
describe("exact catalog quantities", () => {
  it("catalog_quantity_roundtrips_large_decimal_strings", () => {
    const input = quantity("900719925474099312345678901234567890123456", 9);
    expect(parseCatalogQuantity(input)).toEqual(input);
    expect(convertCatalogQuantity(convertCatalogQuantity(input, "openlup:kg"), "openlup:g")).toEqual(input);
    expect(compareCatalogQuantities(input, quantity("900719925474099312345678901234567890123455", 9))).toBe(1);
    expect(compareCatalogQuantities(input, input)).toBe(0);
    expect(compareCatalogQuantities(quantity("1"), input)).toBe(-1);
  });
  it("catalog_quantity_normalises_equivalent_units", () => {
    expect(canonicalizeCatalogQuantity(quantity("1250", 3, "openlup:kg"))).toEqual(quantity("1250"));
    expect(canonicalizeCatalogQuantity(quantity("125000", 2))).toEqual(quantity("1250"));
    expect(compareCatalogQuantities(quantity("1", 0, "openlup:l", "volume"), quantity("1000", 0, "openlup:ml", "volume"))).toBe(0);
    expect(convertCatalogQuantity(quantity("1"), "openlup:kg")).toEqual(quantity("1", 3, "openlup:kg"));
  });
  it("catalog_quantity_refuses_cross_dimension_conversion", () => {
    expect(() => convertCatalogQuantity(quantity("1"), "openlup:ml")).toThrow("quantity_cross_dimension");
    expect(() => compareCatalogQuantities(quantity("1"), quantity("1", 0, "openlup:piece", "count"))).toThrow("quantity_cross_dimension");
    expect(() => parseCatalogQuantity(quantity("1", 0, "openlup:g", "volume"))).toThrow("quantity_cross_dimension");
  });
  it("catalog_count_refuses_fractional_items", () => {
    expect(() => parseCatalogQuantity(quantity("11", 1, "openlup:piece", "count"))).toThrow("quantity_fractional_count");
    expect(canonicalizeCatalogQuantity(quantity("100", 2, "openlup:piece", "count"))).toEqual(quantity("1", 0, "openlup:piece", "count"));
  });
  it("refuses unknown units, overflow and inexact canonical factors without rounding", () => {
    expect(() => parseCatalogQuantity(quantity("1", 0, "example:missing"))).toThrow("quantity_unknown_unit");
    expect(() => parseCatalogQuantity(quantity("1".repeat(53)))).toThrow("quantity_overflow");
    expect(() => canonicalizeCatalogQuantity(quantity("9".repeat(40), 0, "openlup:kg"))).toThrow("quantity_overflow");
    const unit: CatalogQuantityUnit = { code: "example:small", dimension: "mass", integral: false, factor: { canonicalUnit: "openlup:g", unscaled: "1", scale: 12 } };
    const units = [...CATALOG_QUANTITY_UNITS, unit];
    expect(() => canonicalizeCatalogQuantity(quantity("1", 1, unit.code), units)).toThrow("quantity_not_exactly_representable");
    expect(canonicalizeCatalogQuantity(quantity("10", 1, unit.code), units)).toEqual(quantity("1", 12));
    const thirds = [...units, { ...unit, code: "example:triple", factor: { ...unit.factor, unscaled: "3", scale: 0 } }];
    expect(() => convertCatalogQuantity(quantity("1"), "example:triple", thirds)).toThrow("quantity_not_exactly_representable");
    expect(convertCatalogQuantity(quantity("3"), "example:triple", thirds)).toEqual(quantity("1", 0, "example:triple"));
  });
  it.each(["0", "-1", "+1", "01", "1.0", "1e3"])("refuses malformed coefficient %s", (value) => {
    expect(() => parseCatalogQuantity(quantity(value))).toThrow("quantity_invalid");
  });
  it.each([-1, 13, 1.5, NaN, Infinity])("refuses invalid scale %s", (scale) => {
    expect(() => parseCatalogQuantity(quantity("1", scale))).toThrow("quantity_invalid");
  });
});
