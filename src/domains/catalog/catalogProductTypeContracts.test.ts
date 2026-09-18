import { describe, expect, it } from "vitest";
import {
  canonicalCatalogOption, catalogQuantitySchema, createCatalogProductTypeRegistry,
  validateCatalogQuantity, type CatalogProductTypeDefinition,
} from "./catalogProductTypeContracts.js";

const definition: CatalogProductTypeDefinition = {
  key: "example:article", version: 1, units: [
    { code: "si:gram", dimension: "mass", integral: false },
    { code: "si:millilitre", dimension: "volume", integral: false },
    { code: "item:piece", dimension: "count", integral: true },
  ], netContentUnits: ["si:gram", "si:millilitre", "item:piece"],
  dimensions: [{ key: "finish", kind: "choice", values: ["matte", "gloss"] }], validateContent: () => [],
};

describe("installed catalog types", () => {
  it("resolves only installed immutable namespace/version definitions", () => {
    const input = { ...definition, units: [...definition.units] };
    const registry = createCatalogProductTypeRegistry([input]);
    input.units.pop();
    expect(registry.resolve(definition)?.units).toHaveLength(3);
    expect(Object.isFrozen(registry.resolve(definition)?.dimensions)).toBe(true);
    expect(registry.resolve({ ...definition, version: 2 })).toBeUndefined();
    expect(() => createCatalogProductTypeRegistry([definition, definition])).toThrow();
    expect(() => createCatalogProductTypeRegistry([{ ...definition, key: "unqualified" }])).toThrow();
    expect(() => createCatalogProductTypeRegistry([{ ...definition, netContentUnits: ["unknown:unit"] }])).toThrow();
    expect(() => createCatalogProductTypeRegistry([{ ...definition, dimensions: [{ key: "size", kind: "quantity", dimension: "mass", units: ["item:piece"] }] }])).toThrow();
  });
  it.each([
    ["mass", "si:gram", "9007199254740993001", 3, true],
    ["volume", "si:millilitre", "125", 2, true],
    ["count", "item:piece", "200", 2, true],
    ["count", "item:piece", "25", 1, false],
    ["mass", "item:piece", "1", 0, false],
    ["count", "other:piece", "1", 0, false],
  ] as const)("checks exact quantity %s/%s", (dimension, unit, unscaled, scale, expected) => {
    const quantity = catalogQuantitySchema.parse({ dimension, unit, unscaled, scale });
    expect(validateCatalogQuantity(quantity, definition)).toBe(expected);
    expect(quantity.unscaled).toBe(unscaled);
  });
  it.each([0, 1.5, "0", "-1", "+1", "01", "1.0", "1e3"])("rejects a noncanonical positive coefficient %s", (unscaled) => {
    expect(catalogQuantitySchema.safeParse({ dimension: "mass", unit: "si:gram", unscaled, scale: 0 }).success).toBe(false);
  });
  it("collapses exact decimal option spellings without converting units", () => {
    const option = { kind: "quantity" as const, value: { dimension: "mass" as const, unit: "si:gram", unscaled: "1200", scale: 2 } };
    expect(canonicalCatalogOption(option)).toBe(canonicalCatalogOption({ ...option, value: { ...option.value, unscaled: "12", scale: 0 } }));
    expect(canonicalCatalogOption(option)).not.toBe(canonicalCatalogOption({ ...option, value: { ...option.value, unit: "si:kilogram" } }));
  });
});
