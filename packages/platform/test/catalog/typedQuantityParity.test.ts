import { expect, it } from "vitest";
import { CATALOG_QUANTITY_UNITS, canonicalizeCatalogQuantity, decodeCatalogReadQuantity, type CatalogQuantity, type CatalogQuantityUnit } from "@openlup/core/catalog";
import { productLdV2 } from "../../src/marketing/index.js";

type Dimension = CatalogQuantity["dimension"];
const quantity = (dimension: Dimension, unit: string, unscaled = "1", scale = 0) => ({ dimension, unit, unscaled, scale });
const custom = (code: string, dimension: "count" | "volume", unscaled: string, scale: number): CatalogQuantityUnit => ({
  code, dimension, integral: false, factor: { unscaled, scale, canonicalUnit: dimension === "count" ? "openlup:piece" : "openlup:ml" },
});
const fluidOunce = custom("example:us_fl_oz", "volume", "295735295625", 10);
const halfPiece = custom("example:case", "count", "15", 1);
const wholeCase = custom("example:case", "count", "600", 2);
const volume = (unit: string, unscaled?: string, scale?: number) => quantity("volume", unit, unscaled, scale);
const count = (unit: string, unscaled?: string, scale?: number) => quantity("count", unit, unscaled, scale);
const ml = (unscaled?: string, scale?: number) => volume("openlup:ml", unscaled, scale);
const piece = (unscaled?: string) => count("openlup:piece", unscaled);

const expectedBuiltIns: Record<string, CatalogQuantity> = { "openlup:ml": ml(), "openlup:l": ml("1000"), "openlup:piece": piece() };
const cases: Array<[CatalogQuantity, CatalogQuantity | string, (readonly CatalogQuantityUnit[])?]> = [
  ...CATALOG_QUANTITY_UNITS.flatMap(({ code, dimension }) => (["count", "volume", "mass"] as const)
    .filter(candidate => candidate !== "mass" || dimension !== "mass")
    .map((candidate): [CatalogQuantity, CatalogQuantity | string] => [
      quantity(candidate, code), candidate === dimension ? expectedBuiltIns[code]! : "quantity_cross_dimension",
    ])),
  [volume(fluidOunce.code, "1", 2), ml("295735295625", 12), [fluidOunce]],
  [volume(fluidOunce.code, "1", 3), "quantity_not_exactly_representable", [fluidOunce]],
  [count("openlup:piece", "15", 1), "quantity_fractional_count"],
  [count(halfPiece.code), "quantity_fractional_count", [halfPiece]],
  [count(halfPiece.code, "2"), "quantity_fractional_count", [halfPiece]],
  [count(wholeCase.code, "2"), piece("12"), [wholeCase]],
  [count(wholeCase.code, "15", 1), "quantity_fractional_count", [wholeCase]],
  [volume("example:missing"), "quantity_unknown_unit"],
  [volume(fluidOunce.code), "quantity_unknown_unit", [fluidOunce, fluidOunce]],
  [ml(), "quantity_invalid", [custom("openlup:ml", "volume", "2", 0)]],
  [ml("01"), "quantity_invalid"],
  [ml("9".repeat(53)), "quantity_overflow"],
  [ml("9".repeat(52), 12), ml("9".repeat(52), 12)],
  [ml("9".repeat(41)), "quantity_overflow"],
  [ml("1200", 3), ml("12", 1)],
];
it("covers every Core count and volume built-in and dimension refusal", () => {
  expect(CATALOG_QUANTITY_UNITS.filter(unit => unit.dimension !== "mass").map(unit => unit.code)).toEqual(Object.keys(expectedBuiltIns));
});
it.each(cases)("keeps Core and strict read quantity parity for %j", (input, expected, units) => {
  for (const decode of [canonicalizeCatalogQuantity, decodeCatalogReadQuantity]) {
    if (typeof expected === "string") expect(() => decode(input, units)).toThrow(expected);
    else expect(decode(input, units)).toEqual(expected);
  }
});
it("refuses extra typed wire fields before conversion", () => {
  expect(() => decodeCatalogReadQuantity({ ...ml(), extra: 1 })).toThrow("quantity_invalid");
});
it("projects only exact mass as SEO weight", () => {
  const item = { url: "https://shop.example/item", name: "Item", inLanguage: "en", brandName: "Example", images: [] };
  expect(productLdV2(item.url, { ...item, weight: ml("250") })).not.toHaveProperty("weight");
  expect(productLdV2(item.url, { ...item, weight: piece("5") })).not.toHaveProperty("weight");
  expect(productLdV2(item.url, { ...item, weight: quantity("mass", "openlup:kg", "25", 2) })).toHaveProperty("weight.value", 250);
  expect(() => productLdV2(item.url, { ...item, weight: quantity("mass", "openlup:g", "9007199254740993") })).toThrow(RangeError);
});
