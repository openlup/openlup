import { expect, it } from "vitest";
import { CATALOG_QUANTITY_UNITS, canonicalizeCatalogQuantity, type CatalogQuantity, type CatalogQuantityUnit } from "@openlup/core/catalog";
import { resolveTypedCatalogQuantity, validateTypedCatalogAmounts } from "../../src/catalog/physicalQuantity.js";
import { catalogPublicationAdmissionRefusal, renderPublicationIssue, CatalogPublicationError } from "../../src/catalog/publicationError.js";
import { catalogPublicationIntegralGrams } from "../../src/catalog/publicationValidation.js";

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
it.each(cases)("canonicalizes or refuses %j with Core quantity rules", (input, expected, units) => {
  if (typeof expected === "string") expect(() => canonicalizeCatalogQuantity(input, units)).toThrow(expected);
  else expect(canonicalizeCatalogQuantity(input, units)).toEqual(expected);
});

const builtIns = CATALOG_QUANTITY_UNITS.map(({ factor: _factor, ...unit }) => unit);
const explicitMl = custom("openlup:ml", "volume", "10", 1);
const platformCases: Array<[unknown, CatalogQuantity | string, (typeof builtIns[number] | CatalogQuantityUnit)[]?]> = [
  ...cases.filter(([, expected]) => typeof expected === "string" || expected.unscaled.length <= 40)
    .map(([input, expected, units]): [CatalogQuantity, CatalogQuantity | string, CatalogQuantityUnit[]?] =>
      units ? [input, expected, [...units]] : [input, expected]),
  [ml("9".repeat(41), 1), "quantity_overflow"],
  [volume("openlup:l", "9".repeat(39), 1), "quantity_overflow"],
  [volume(fluidOunce.code, "100", 4), ml("295735295625", 12), [fluidOunce]],
  [ml("9".repeat(40)), ml("9".repeat(40))],
  [ml("9".repeat(40), 12), ml("9".repeat(40), 12)],
  [ml(), ml(), [explicitMl]],
  [ml("15", 1), "quantity_fractional_count", [{ ...explicitMl, integral: true }]],
  [ml("20", 1), ml("2"), [{ ...explicitMl, integral: true }]],
  [count("openlup:piece", "15", 1), "quantity_fractional_count", [{ code: "openlup:piece", dimension: "count", integral: false }]],
  [volume("openlup:kg"), "quantity_cross_dimension", [{ code: "openlup:kg", dimension: "volume", integral: false }]],
  [{ dimension: "volume", unit: "openlup:ml", unscaled: "1" }, "quantity_invalid"],
];
it.each(platformCases)("resolves Platform term %j exactly", (input, expected, units = builtIns) => {
  const definition = { units, netContentUnits: [...new Set(units.map(({ code }) => code))] };
  const resolve = () => resolveTypedCatalogQuantity(input, definition);
  if (typeof expected === "string") expect(resolve).toThrow(expect.objectContaining({ code: expected }));
  else expect(resolve()).toEqual(expected);
});

it("refuses a Core-valid 41-digit result from a 40-digit authored coefficient", () => {
  const doubled = custom("example:doubled", "volume", "2", 0);
  const authored = volume(doubled.code, "9".repeat(40), 1);
  expect(canonicalizeCatalogQuantity(authored, [doubled])).toEqual(ml("1" + "9".repeat(39) + "8", 1));
  const definition = { units: [doubled], netContentUnits: [doubled.code] };
  expect(() => resolveTypedCatalogQuantity(authored, definition)).toThrow(expect.objectContaining({ code: "quantity_overflow" }));
});

it.each([
  [ml("01"), null, false, "catalog_publication_net_content_invalid", "/operations/4/sku/netContent", "quantity_invalid"],
  [count(halfPiece.code, "2"), null, false, "catalog_publication_quantity_definition_unqualified", "definition.units", "quantity_fractional_count"],
  [ml(), null, true, "catalog_publication_gross_mass_required", "/operations/4/sku/grossMass", undefined],
  [ml(), ml(), true, "catalog_publication_gross_mass_invalid", "/operations/4/sku/grossMass", "quantity_cross_dimension"],
  [ml(), quantity("mass", "example:missing"), false, "catalog_publication_gross_mass_invalid", "/operations/4/sku/grossMass", "quantity_unknown_unit"],
  [ml(), { dimension: "mass", unit: "openlup:g", unscaled: 10, scale: 0 }, false, "catalog_publication_gross_mass_invalid", "/operations/4/sku/grossMass", "quantity_invalid"],
] as const)("preserves typed quantity diagnostics through both publication mappers", (netContent, grossMass, required, code, path, quantityCause) => {
  const selection = { path: "/operations/4/sku", subject: "ARTICLE" };
  const definition = { units: [...builtIns, halfPiece], netContentUnits: ["openlup:ml", halfPiece.code] };
  try {
    validateTypedCatalogAmounts({ netContent, grossMass }, definition, selection, required);
    expect.fail("expected a typed amount refusal");
  } catch (error) {
    if (!(error instanceof CatalogPublicationError)) throw error;
    const details = { path, subject: "ARTICLE", ...(quantityCause === undefined ? {} : { quantityCause }) };
    const phase = code === "catalog_publication_gross_mass_required" ? "activation" : "structural";
    expect(renderPublicationIssue(error.diagnostic)).toEqual({ ...details, code, phase, message: expect.any(String) });
    expect(catalogPublicationAdmissionRefusal(error)).toEqual({ ...details, outcome: "validation_issue", reason: code, message: expect.any(String) });
  }
});

it("keeps factorless integral grams on the original comparator", () => {
  const grams = quantity("mass", "openlup:g");
  expect(catalogPublicationIntegralGrams(grams, { key: "example:mass", version: 1,
    units: [{ code: grams.unit, dimension: "mass", integral: true }], netContentUnits: [grams.unit],
    dimensions: [], validateContent: () => [] })).toBe("1");
});

it("converts independent gross in a declared mass unit outside the net allowlist", () => {
  const netContent = ml("50"), grossMass = quantity("mass", "openlup:kg", "1", 1);
  const definition = { units: builtIns, netContentUnits: ["openlup:ml"] };
  const selection = { path: "/skus/0", subject: "ARTICLE" };
  expect(validateTypedCatalogAmounts({ netContent, grossMass }, definition, selection, true))
    .toEqual({ netContent, grossMass: quantity("mass", "openlup:g", "100") });
  expect(validateTypedCatalogAmounts({ netContent }, definition, selection, false)).toEqual({ netContent, grossMass: null });
});
