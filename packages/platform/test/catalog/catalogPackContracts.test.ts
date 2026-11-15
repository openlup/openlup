import { describe, expect, it } from "vitest";
import { defineCatalogPack } from "../../src/catalog/contracts/catalogPack.js";
import { catalogDefinitionDigest } from "../../src/catalog/catalogDefinitionDigest.js";
import { catalogPackManifest } from "../../src/catalog/catalogPackManifest.js";
import { createCatalogProductTypeRegistry } from "../../src/catalog/productTypeSchemas.js";
import type { AttributeDefinition } from "../../src/catalog/contracts/attributes.js";
const attribute: AttributeDefinition = {
  key: "finish", scope: "variant", valueType: { kind: "text", maxLength: 64 }, required: true,
  cardinality: { min: 1, max: 1 }, filterable: true, facetable: true, public: true, displayOrder: 0, labels: { en: "Finish" },
};
const definition = {
  key: "example:item", version: 1, units: [{ code: "openlup:piece", dimension: "count" as const, integral: true, factor: { canonicalUnit: "openlup:piece" as const, unscaled: "1", scale: 0 } }],
  netContentUnits: ["openlup:piece"], dimensions: [], attributes: [attribute],
  validatorRef: `sha256:${"a".repeat(64)}`, validateContent: (_input: unknown) => [],
};
describe("catalog pack projection", () => {
  it("freezes literals without validating or executing them at import", () => {
    const pack = defineCatalogPack({ id: "example:pack", namespace: "example", version: 1, openlupRange: "0.44.x", capabilities: { publish: false }, taxClasses: [], types: [{ ...definition, key: "example:item", version: -1, validateContent: () => { throw new Error("not invoked"); } }] });
    expect(Object.isFrozen(pack.types[0].attributes[0].valueType)).toBe(true);
    expect(pack.types[0].version).toBe(-1);
    expect(() => createCatalogProductTypeRegistry(pack.types)).toThrow("invalid_catalog_type_definition");
  });
  it("changes identity for a relaxation and for a validator artifact", () => {
    const original = catalogDefinitionDigest(definition);
    expect(catalogDefinitionDigest({ ...definition, labels: undefined })).toBe(original);
    expect(original).toMatch(/^[a-f0-9]{64}$/u);
    expect(catalogDefinitionDigest({ ...definition, attributes: [{ ...attribute, required: false }] })).not.toBe(original);
    expect(catalogDefinitionDigest({ ...definition, validatorRef: `sha256:${"b".repeat(64)}` })).not.toBe(original);
    expect(catalogDefinitionDigest({ ...definition, attributes: [{ ...attribute, valueType: { kind: "text", maxLength: 65 } }] })).not.toBe(original);
  });
  it("excludes labels and executable callbacks from definition identity", () => {
    expect(catalogDefinitionDigest({ ...definition, labels: { en: "Renamed" }, attributes: [{ ...attribute, labels: { en: "Renamed" } }], validateContent: () => { throw new Error("not invoked"); } })).toBe(catalogDefinitionDigest(definition));
  });
  it("derives an immutable manifest from code and computed definition digests", () => {
    const input = { id: "example:pack", namespace: "example", version: 1, openlupRange: "0.44.x", capabilities: { publish: false }, types: [definition], taxClasses: [{ key: "example:standard", labels: { en: "Standard" } }] };
    const manifest = catalogPackManifest(input);
    expect(manifest.types[0]).toEqual({ key: definition.key, version: 1, definitionDigest: catalogDefinitionDigest(definition) });
    expect(Object.isFrozen(manifest.types[0])).toBe(true);
    expect(manifest.digest).toBe(catalogPackManifest({ ...input, taxClasses: [{ ...input.taxClasses[0], labels: { en: "Renamed" } }] }).digest);
    input.capabilities.publish = true;
    expect(manifest.capabilities.publish).toBe(false);
    expect(catalogPackManifest(input).digest).not.toBe(manifest.digest);
    expect(() => catalogDefinitionDigest({ ...definition, validatorRef: "invalid" })).toThrow("invalid_catalog_type_definition");
  });
});
