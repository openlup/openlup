import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { validateCatalogAttributes, catalogAttributesReadyForPublication, prepareCatalogAttributeProjection, CATALOG_CONFORMANCE_RULES } from "../../src/catalog/index.js";
import type { AttributeDefinition, CatalogAttributeValueType } from "../../src/catalog/contracts/attributes.js";
import type { CatalogProductTypeInput } from "../../src/catalog/contracts/productTypes.js";
import type { CatalogAttributeInput, CatalogAttributeValidation } from "../../src/catalog/attributeValidation.js";
import type { CatalogAttributeReferencePort, CatalogAttributeReference } from "../../src/catalog/attributeReferencePort.js";

import { catalogAttributeStorageBytes } from "../../src/catalog/attributeSchemas.js";

const first = "00000000-0000-4000-8000-000000000001";
const second = "00000000-0000-4000-8000-000000000002";
function attribute(key: string, valueType: CatalogAttributeValueType, extra: Partial<AttributeDefinition> = {}): AttributeDefinition {
  return { key, scope: "product", valueType, required: false, cardinality: { min: 0, max: 1 }, filterable: false, facetable: false, public: true, displayOrder: 0, labels: {}, ...extra };
}
const flag = attribute("flag", { kind: "boolean" });
function definition(attributes: readonly AttributeDefinition[], extra: Partial<CatalogProductTypeInput> = {}): CatalogProductTypeInput {
  return { key: "example:item", version: 2,
    units: [{ code: "openlup:g", dimension: "mass", integral: false }, { code: "openlup:piece", dimension: "count", integral: true }],
    netContentUnits: ["openlup:g"], dimensions: [], attributes, validateContent: () => [], ...extra };
}
const subject = (values: unknown): CatalogAttributeInput => ({ productAttributes: values, skus: [{ id: first }] });
function issues(result: CatalogAttributeValidation) {
  if (result.valid) throw new Error("expected invalid supplied facts");
  return result.issues;
}
function rows(result: CatalogAttributeValidation, revision = "7") {
  const prepared = prepareCatalogAttributeProjection(result, revision);
  if (!prepared.prepared) throw new Error(JSON.stringify(prepared.issues));
  return prepared.rows;
}

describe("catalog attribute owner validation", () => {
  it("catalog_attribute_scope_conflict_refused", async () => {
    const type = definition([flag, attribute("local", { kind: "boolean" }, { scope: "variant" })]);
    expect(issues(await validateCatalogAttributes(type, { productAttributes: { local: true }, skus: [{ id: first, attributes: { flag: true } }] }))).toEqual([
      { path: "/productAttributes/local", code: "attribute_scope_conflict" },
      { path: "/skus/0/attributes/flag", code: "attribute_scope_conflict" },
    ]);
  });
  it("catalog_attribute_unknown_key_refused", async () => {
    expect(issues(await validateCatalogAttributes(definition([flag]), subject({ "unknown/~key": true })))).toEqual([
      { path: "/productAttributes/unknown~1~0key", code: "attribute_unknown_key" },
    ]);
  });
  it("catalog_required_locale_blocks_publish", async () => {
    const type = definition([attribute("name", { kind: "localized_text", maxLength: 30, locales: ["en", "fr"], requiredLocales: ["fr"] })]);
    const result = await validateCatalogAttributes(type, subject({ name: { en: "Name" } }));
    expect(result).toMatchObject({ valid: true, readinessIssues: [{ path: "/productAttributes/name/fr", code: "attribute_required_locale_missing" }] });
    expect(catalogAttributesReadyForPublication(result)).toBe(false);
    expect(prepareCatalogAttributeProjection(result, "7")).toMatchObject({ prepared: false, issues: [{ code: "attribute_required_locale_missing" }] });
    const complete = await validateCatalogAttributes(type, subject({ name: { en: "Name", fr: "Nom" } }));
    expect(catalogAttributesReadyForPublication(complete)).toBe(true);
    // L1 admission preparation only. LC1/LC2 own actual publish refusal and zero-effect proof.
  });
  it("separates missing required values from malformed supplied values", async () => {
    const type = definition([{ ...flag, required: true }]);
    for (const input of [subject({}), subject(null), { skus: [{ id: first }] }]) {
      const result = await validateCatalogAttributes(type, input);
      expect(result).toMatchObject({ valid: true, readinessIssues: [{ path: "/productAttributes/flag", code: "attribute_required_missing" }] });
      expect(catalogAttributesReadyForPublication(result)).toBe(false);
    }
    const invalid = await validateCatalogAttributes(type, subject({ flag: null }));
    expect(issues(invalid)).toContainEqual({ path: "/productAttributes/flag", code: "attribute_value_invalid" });
    expect(catalogAttributesReadyForPublication(invalid)).toBe(false);
    expect(prepareCatalogAttributeProjection(invalid, "7").prepared).toBe(false);
  });
  it("distinguishes false, absent and an empty list", async () => {
    const type = definition([flag, attribute("items", { kind: "list", item: { kind: "boolean" }, min: 0, max: 3 }, { cardinality: { min: 0, max: 3 } })]);
    const result = await validateCatalogAttributes(type, subject({ flag: false, items: [] }));
    expect(rows(result)).toHaveLength(1);
    expect(rows(result)[0]).toMatchObject({ attribute_key: "flag", bool_value: false });
    expect(rows(await validateCatalogAttributes(type, subject({})))).toEqual([]);
    expect(rows(await validateCatalogAttributes(type, subject({ items: [false, true] })))).toEqual([
      expect.objectContaining({ value_ordinal: 0, bool_value: false }), expect.objectContaining({ value_ordinal: 1, bool_value: true }),
    ]);
  });
  it.each([
    ["text minimum", { kind: "text", minLength: 2, maxLength: 4 }, "x"],
    ["text maximum", { kind: "text", maxLength: 4 }, "12345"],
    ["text kind", { kind: "text", maxLength: 4 }, 1],
    ["localized unknown locale", { kind: "localized_text", maxLength: 4, locales: ["en"] }, { fr: "ok" }],
    ["localized maximum", { kind: "localized_text", maxLength: 4, locales: ["en"] }, { en: "12345" }],
    ["localized scalar", { kind: "localized_text", maxLength: 4, locales: ["en"] }, "name"],
    ["decimal number", { kind: "decimal", scale: 2 }, 1.5],
    ["decimal exponent", { kind: "decimal", scale: 2 }, "1e2"],
    ["decimal scale", { kind: "decimal", scale: 2 }, "0.001"],
    ["decimal positive sign", { kind: "decimal", scale: 2 }, "+1"],
    ["decimal leading zero", { kind: "decimal", scale: 2 }, "01"],
    ["decimal below minimum", { kind: "decimal", scale: 2, min: "-1.23" }, "-1.24"],
    ["decimal above maximum", { kind: "decimal", scale: 2, max: "1.23" }, "1.24"],
    ["enum label", { kind: "enum", values: [{ id: "stable", labels: { en: "Label" } }] }, "Label"],
    ["boolean number", { kind: "boolean" }, 0],
    ["invalid calendar date", { kind: "date" }, "2024-02-30"],
    ["non-leap date", { kind: "date" }, "2025-02-29"],
    ["timestamp", { kind: "date" }, "2024-02-29T00:00:00Z"],
    ["unsupported zero year", { kind: "date" }, "0000-01-01"],
    ["reference outside allowlist", { kind: "reference", allowlist: ["example:asset"] }, { namespace: "other:asset", id: "a" }],
    ["reference URL", { kind: "reference", allowlist: ["example:asset"] }, "https://example.test/a"],
    ["quantity dimension", { kind: "quantity", dimension: "mass", units: ["openlup:g"] }, { dimension: "count", unit: "openlup:piece", unscaled: "1", scale: 0 }],
    ["quantity unknown field", { kind: "quantity", dimension: "mass", units: ["openlup:g"] }, { dimension: "mass", unit: "openlup:g", unscaled: "1", scale: 0, other: true }],
  ] as const)("refuses malformed supplied values: %s", async (_name, valueType, value) => {
    expect((await validateCatalogAttributes(definition([attribute("value", valueType)]), subject({ value }))).valid).toBe(false);
  });
  it.each([
    ["text", { kind: "text", maxLength: 4 }, "text", { text_value: "text" }],
    ["decimal", { kind: "decimal", scale: 4 }, "-9007199254740993.0123", { numeric_value: "-9007199254740993.0123" }],
    ["decimal zero", { kind: "decimal", scale: 1 }, "-0.0", { numeric_value: "-0.0" }],
    ["date", { kind: "date" }, "2024-02-29", { date_value: "2024-02-29" }],
    ["enum", { kind: "enum", values: [{ id: "stable", labels: { en: "Label" } }] }, "stable", { text_value: "stable" }],
    ["localized", { kind: "localized_text", maxLength: 10, locales: ["en", "fr"] }, { fr: "Nom", en: "Name" }, { text_value: '{"en":"Name","fr":"Nom"}' }],
  ] as const)("preserves the declared scalar: %s", async (_name, valueType, value, expected) => {
    const result = await validateCatalogAttributes(definition([attribute("value", valueType)]), subject({ value }));
    expect(rows(result)[0]).toMatchObject(expected);
  });
  it("uses exact decimal comparisons at bounds above Number precision", async () => {
    const type = definition([attribute("value", { kind: "decimal", scale: 2, min: "9007199254740993.01", max: "9007199254740993.02" })]);
    expect((await validateCatalogAttributes(type, subject({ value: "9007199254740993.00" }))).valid).toBe(false);
    expect(rows(await validateCatalogAttributes(type, subject({ value: "9007199254740993.01" })))[0].numeric_value).toBe("9007199254740993.01");
    expect((await validateCatalogAttributes(type, subject({ value: "9007199254740993.03" }))).valid).toBe(false);
  });
  it.each([
    ["list lower bound", { min: 1, max: 3 }, { min: 0, max: 3 }, []],
    ["list upper bound", { min: 0, max: 1 }, { min: 0, max: 3 }, [true, false]],
    ["cardinality lower bound", { min: 0, max: 3 }, { min: 2, max: 3 }, [true]],
    ["cardinality upper bound", { min: 0, max: 3 }, { min: 0, max: 1 }, [true, false]],
    ["nested list", { min: 0, max: 3 }, { min: 0, max: 3 }, [[true]]],
  ])("refuses %s", async (_name, bounds, cardinality, value) => {
    const type = definition([attribute("items", { kind: "list", item: { kind: "boolean" }, ...bounds }, { cardinality })]);
    expect((await validateCatalogAttributes(type, subject({ items: value }))).valid).toBe(false);
  });
  it("keeps a permitted required empty list distinct from absence", async () => {
    const type = definition([attribute("items", { kind: "list", min: 0, max: 3, item: { kind: "boolean" } }, { required: true, cardinality: { min: 0, max: 3 } })]);
    expect(catalogAttributesReadyForPublication(await validateCatalogAttributes(type, subject({ items: [] })))).toBe(true);
    expect(catalogAttributesReadyForPublication(await validateCatalogAttributes(type, subject({})))).toBe(false);
  });
  it("honors scalar and absent cardinality", async () => {
    const type = definition([{ ...flag, cardinality: { min: 1, max: 1 } }]);
    expect(await validateCatalogAttributes(type, subject({}))).toMatchObject({ valid: true, readinessIssues: [{ code: "attribute_required_missing" }] });
    expect((await validateCatalogAttributes(definition([{ ...flag, cardinality: { min: 0, max: 0 } }]), subject({ flag: false }))).valid).toBe(false);
  });
  it("reuses definition refusals and keeps cross-field policy in the callback", async () => {
    const callback = vi.fn(() => []);
    const type = definition([{ ...flag, facetable: true }], { validateContent: callback });
    expect(issues(await validateCatalogAttributes(type, subject({ flag: true })))).toContainEqual({ path: "/definition/attributes/0/facetable", code: "definition_facetable_not_filterable" });
    expect(callback).not.toHaveBeenCalled();
    expect(await validateCatalogAttributes(definition([flag], { validateContent: callback }), subject({ flag: true }))).toMatchObject({ valid: true });
    expect(callback).not.toHaveBeenCalled();
  });
  it("refuses huge, recursive, lossy and non-object input before reference I/O", async () => {
    const circular: Record<string, unknown> = {}; circular.value = circular;
    let deep: unknown = true;
    for (let i = 0; i < 50; i++) deep = { next: deep };
    const resolve = vi.fn();
    for (const values of ["object", [], circular, deep, { value: "x".repeat(1_048_576) }, { value: undefined }, { value: NaN }, { value: 1n }, { value: "\u0000" }, { value: "\uD800" }]) {
      expect((await validateCatalogAttributes(definition([flag]), subject(values), { resolve })).valid).toBe(false);
    }
    expect(resolve).not.toHaveBeenCalled();
  });
  it("refuses duplicate SKU UUIDs and unknown SKU fields", async () => {
    expect((await validateCatalogAttributes(definition([flag]), { skus: [{ id: first }, { id: first }] })).valid).toBe(false);
    expect((await validateCatalogAttributes(definition([flag]), { skus: [{ id: "bad" }] })).valid).toBe(false);
    expect((await validateCatalogAttributes(definition([flag]), { skus: [{ id: first, extra: true }] } as CatalogAttributeInput)).valid).toBe(false);
  });
  it("has exhaustive structured guidance for attribute codes", () => {
    for (const [code, guidance] of Object.entries(CATALOG_CONFORMANCE_RULES)) if (code.startsWith("attribute_")) {
      expect(guidance).toMatchObject({ severity: "error", fix: expect.any(String), recipe: "how-to/extend/catalogue-extension.md#add-attribute" });
    }
  });
});

describe("allowlisted batch reference resolution", () => {
  const reference = { namespace: "example:asset", id: "stable" };
  const type = definition([attribute("asset", { kind: "reference", allowlist: ["example:asset"] }),
    attribute("assets", { kind: "list", min: 0, max: 3, item: { kind: "reference", allowlist: ["example:asset"] } }, { scope: "variant", cardinality: { min: 0, max: 3 } })]);
  it("catalog_attribute_reference_must_resolve", async () => {
    for (const status of ["dangling", "private", "unavailable"] as const) {
      const result = await validateCatalogAttributes(type, subject({ asset: reference }), { resolve: async () => [{ ...reference, status }] });
      expect(issues(result)).toEqual([{ path: "/productAttributes/asset", code: "attribute_reference_unresolved" }]);
    }
    for (const port of [undefined, { resolve: async () => [] }, { resolve: async () => { throw new Error("private details"); } }]) {
      expect(issues(await validateCatalogAttributes(type, subject({ asset: reference }), port))).toEqual([{ path: "/productAttributes/asset", code: "attribute_reference_unresolved" }]);
    }
  });
  it("deduplicates once across product and all SKU values and maps every failed path", async () => {
    const resolve = vi.fn(async (refs: readonly CatalogAttributeReference[]) => refs.map((ref: typeof reference) => ({ ...ref, status: "resolved" as const })));
    const input = { productAttributes: { asset: reference }, skus: [{ id: first, attributes: { assets: [reference, reference] } }, { id: second, attributes: { assets: [reference] } }] };
    expect(rows(await validateCatalogAttributes(type, input, { resolve }))).toHaveLength(5);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith([reference]);
    const unresolved = await validateCatalogAttributes(type, input, { resolve: async () => [] });
    expect(issues(unresolved).map(({ path }) => path)).toEqual(["/productAttributes/asset", "/skus/0/attributes/assets/0", "/skus/0/attributes/assets/1", "/skus/1/attributes/assets/0"]);
  });
  it("refuses missing, duplicate or mismatched resolver evidence", async () => {
    for (const resolved of [[], [{ ...reference, id: "other", status: "resolved" }], [{ ...reference, status: "resolved" }, { ...reference, status: "resolved" }]]) {
      const port = { resolve: async () => resolved } as CatalogAttributeReferencePort;
      expect((await validateCatalogAttributes(type, subject({ asset: reference }), port)).valid).toBe(false);
    }
  });
  it("snapshots values and freezes validated output across the resolver await", async () => {
    const input = subject({ asset: reference });
    const result = await validateCatalogAttributes(type, input, { resolve: async (refs) => {
      (input.productAttributes as Record<string, unknown>).asset = { ...reference, id: "changed" };
      expect(Object.isFrozen(refs)).toBe(true);
      expect(Object.isFrozen(refs[0])).toBe(true);
      return [{ ...refs[0], status: "resolved" }];
    } });
    expect(rows(result)[0].ref_value).toBe('["example:asset","stable"]');
    expect(Object.isFrozen(result)).toBe(true);
    if (result.valid) expect(Object.isFrozen(result.skus[0].values[0])).toBe(true);
  });
});

describe("pure single-projection preparation", () => {
  it("repeats product attributes per SKU and keeps variant values local in deterministic order", async () => {
    const local = attribute("local", { kind: "boolean" }, { scope: "variant" });
    const result = await validateCatalogAttributes(definition([local, flag]), { productAttributes: { flag: false }, skus: [
      { id: second, attributes: { local: true } }, { id: first, attributes: { local: false } },
    ] });
    expect(rows(result).map(({ sku_id, attribute_key, bool_value, definition_version, value_ordinal }) => [sku_id, attribute_key, bool_value, definition_version, value_ordinal])).toEqual([
      [first, "flag", false, 2, 0], [first, "local", false, 2, 0], [second, "flag", false, 2, 0], [second, "local", true, 2, 0],
    ]);
    expect(rows(result)[0]).toEqual({ sku_id: first, publication_revision: "7", attribute_key: "flag", definition_version: 2, value_ordinal: 0, value_kind: "boolean",
      text_value: null, numeric_value: null, bool_value: false, date_value: null, ref_value: null, quantity_dimension: null, canonical_unit: null, canonical_value: null });
  });
  it("isolates explicit publication revisions with no mixed rows or prior-result mutation", async () => {
    const result = await validateCatalogAttributes(definition([flag]), subject({ flag: true }));
    const before = rows(result, "9007199254740993"), after = rows(result, "9007199254740994");
    expect(before.every(({ publication_revision }) => publication_revision === "9007199254740993")).toBe(true);
    expect(after.every(({ publication_revision }) => publication_revision === "9007199254740994")).toBe(true);
    for (const revision of ["", "0", "-1", "01", "1.5", "9223372036854775808", undefined, 7]) {
      expect(prepareCatalogAttributeProjection(result, revision as string)).toMatchObject({ prepared: false, issues: [{ code: "attribute_publication_revision_invalid" }] });
    }
  });
  it("canonicalizes quantities through installed exact units and refuses loss before SQL", async () => {
    const quantity = attribute("amount", { kind: "quantity", dimension: "mass", units: ["example:small", "openlup:g"] });
    const type = definition([quantity], { units: [
      { code: "openlup:g", dimension: "mass", integral: false },
      { code: "example:small", dimension: "mass", integral: false, factor: { canonicalUnit: "openlup:g", unscaled: "1", scale: 12 } },
    ] });
    const exact = await validateCatalogAttributes(type, subject({ amount: { dimension: "mass", unit: "example:small", unscaled: "1", scale: 0 } }));
    expect(rows(exact)[0]).toMatchObject({ quantity_dimension: "mass", canonical_unit: "openlup:g", canonical_value: "0.000000000001" });
    const inexact = await validateCatalogAttributes(type, subject({ amount: { dimension: "mass", unit: "example:small", unscaled: "1", scale: 1 } }));
    expect(issues(inexact)).toEqual([{ path: "/productAttributes/amount", code: "quantity_not_exactly_representable" }]);
    expect(prepareCatalogAttributeProjection(inexact, "7").prepared).toBe(false);
  });
  it("refuses canonical quantity overflow and fractional counts", async () => {
    const type = definition([attribute("amount", { kind: "quantity", dimension: "mass", units: ["example:large"] })], { units: [
      { code: "openlup:g", dimension: "mass", integral: false },
      { code: "example:large", dimension: "mass", integral: false, factor: { canonicalUnit: "openlup:g", unscaled: "10", scale: 0 } },
    ] });
    expect(issues(await validateCatalogAttributes(type, subject({ amount: { dimension: "mass", unit: "example:large", unscaled: "9".repeat(40), scale: 0 } })))).toContainEqual({ path: "/productAttributes/amount", code: "quantity_overflow" });
    const counts = definition([attribute("amount", { kind: "quantity", dimension: "count", units: ["openlup:piece"] })]);
    expect(issues(await validateCatalogAttributes(counts, subject({ amount: { dimension: "count", unit: "openlup:piece", unscaled: "15", scale: 1 } })))).toContainEqual({ path: "/productAttributes/amount", code: "quantity_fractional_count" });
  });
});


describe("independent attribute-object rendered storage ceiling", () => {
  const fixtures = [
    { name: "boolean list", item: { kind: "boolean" } as const, max: 180_000,
      under: () => Array(174_760).fill(true), underBytes: 1_048_571,
      over: () => Array(174_761).fill(true), overBytes: 1_048_577,
      reported: () => Array(180_000).fill(true), reportedBytes: 1_080_011 },
    { name: "101-character string list", item: { kind: "text", maxLength: 101 } as const, max: 10_000,
      under: () => [...Array(9_986).fill("x".repeat(101)), "x".repeat(30)], underBytes: 1_048_575,
      over: () => [...Array(9_986).fill("x".repeat(101)), "x".repeat(32)], overBytes: 1_048_577,
      reported: () => Array(10_000).fill("x".repeat(101)), reportedBytes: 1_050_011 },
  ];
  for (const fixture of fixtures) for (const scope of ["product", "variant"] as const) {
    for (const boundary of ["under", "over", "reported"] as const) {
      it(`catalog_attribute_storage_bound: ${fixture.name}, ${scope}, ${boundary}`, async () => {
        const values = { items: fixture[boundary]() };
        const type = definition([attribute("items", { kind: "list", item: fixture.item, min: 0, max: fixture.max }, {
          scope, cardinality: { min: 0, max: fixture.max },
        })]);
        const input = scope === "product" ? subject(values) : { skus: [{ id: first, attributes: values }] };
        // Both reviewer examples and their adjacent boundaries fit the separate compact aggregate bound.
        expect(new TextEncoder().encode(JSON.stringify(input)).byteLength).toBeLessThan(1_048_576);
        expect(catalogAttributeStorageBytes(values)).toBe(fixture[`${boundary}Bytes`]);
        const result = await validateCatalogAttributes(type, input);
        expect(result.valid).toBe(boundary === "under");
        expect(catalogAttributesReadyForPublication(result)).toBe(boundary === "under");
        expect(prepareCatalogAttributeProjection(result, "7").prepared).toBe(boundary === "under");
        if (boundary !== "under") expect(issues(result)).toEqual([{
          path: scope === "product" ? "/productAttributes" : "/skus/0/attributes",
          code: "attribute_storage_too_large",
        }]);
      });
    }
  }
  it("counts escaped strings, Unicode, nested separators and ordinary numeric scales", () => {
    const value = { "é": ["\n\t\b\f\r\\\"", "😀"], quantity: { scale: 12 }, empty: {} };
    const rendered = '{"é": ["\\n\\t\\b\\f\\r\\\\\\"", "😀"], "quantity": {"scale": 12}, "empty": {}}';
    expect(catalogAttributeStorageBytes(value)).toBe(new TextEncoder().encode(rendered).byteLength);
  });
  it("conservatively bounds numeric exponent expansion rather than counting its compact token", () => {
    expect(catalogAttributeStorageBytes({ value: 1e-7 })).toBeGreaterThanOrEqual('{"value": 0.0000001}'.length);
    expect(catalogAttributeStorageBytes({ value: 1e21 })).toBeGreaterThanOrEqual('{"value": 1000000000000000000000}'.length);
    expect(catalogAttributeStorageBytes({ value: -5e-324 })).toBeGreaterThanOrEqual(338);
  });
  it("does not sum separate storage ceilings across product and SKU objects", async () => {
    const type = definition(["product", "variant"].map((scope) => attribute(scope, { kind: "list", item: { kind: "boolean" }, min: 0, max: 90_000 }, {
      scope: scope as "product" | "variant", cardinality: { min: 0, max: 90_000 },
    })));
    const result = await validateCatalogAttributes(type, {
      productAttributes: { product: Array(90_000).fill(true) }, skus: [{ id: first, attributes: { variant: Array(90_000).fill(true) } }],
    });
    expect(catalogAttributesReadyForPublication(result)).toBe(true);
  });
});


describe("projection text index safety", () => {
  const sample = Array.from({ length: 256 }, (_, i) => createHash("sha256").update(String(i)).digest("hex")).join("");
  for (const scope of ["product", "variant"] as const) for (const filterable of [false, true]) {
    for (const kind of ["text", "localized_text"] as const) for (const bytes of [2_047, 2_048, 2_049]) {
      it(`catalog_attribute_projection_text_bound: ${scope}, ${kind}, filterable=${filterable}, bytes=${bytes}`, async () => {
        const valueType = kind === "text" ? { kind, maxLength: 16_384 } : { kind, maxLength: 16_384, locales: ["en"] };
        const value = kind === "text" ? sample.slice(0, bytes) : { en: sample.slice(0, bytes - 9) };
        const type = definition([attribute("value", valueType, { scope, filterable, facetable: filterable })]);
        const input = scope === "product" ? subject({ value }) : { skus: [{ id: first, attributes: { value } }] };
        const result = await validateCatalogAttributes(type, input);
        expect(result.valid).toBe(bytes <= 2_048);
        expect(catalogAttributesReadyForPublication(result)).toBe(bytes <= 2_048);
        expect(prepareCatalogAttributeProjection(result, "7").prepared).toBe(bytes <= 2_048);
        if (bytes <= 2_048) expect(new TextEncoder().encode(rows(result)[0].text_value!).byteLength).toBe(bytes);
        else expect(issues(result)).toEqual([{
          path: scope === "product" ? "/productAttributes/value" : "/skus/0/attributes/value", code: "attribute_projection_text_too_large",
        }]);
      });
    }
  }
  it.each(["text", "localized_text"] as const)("refuses the incompressible 16384-character reviewer example: %s", async kind => {
    const valueType = kind === "text" ? { kind, maxLength: 16_384 } : { kind, maxLength: 16_384, locales: ["en"] };
    const value = kind === "text" ? sample : { en: sample };
    const result = await validateCatalogAttributes(definition([attribute("value", valueType)]), subject({ value }));
    expect(issues(result)).toEqual([{ path: "/productAttributes/value", code: "attribute_projection_text_too_large" }]);
    expect(prepareCatalogAttributeProjection(result, "7").prepared).toBe(false);
  });
  it.each(["text", "localized_text"] as const)("refuses oversized list elements with their ordinal path: %s", async kind => {
    const item = kind === "text" ? { kind, maxLength: 16_384 } : { kind, maxLength: 16_384, locales: ["en"] };
    const result = await validateCatalogAttributes(definition([attribute("items", { kind: "list", item, min: 0, max: 2 }, { cardinality: { min: 0, max: 2 } })]),
      subject({ items: kind === "text" ? ["small", sample] : [{ en: "small" }, { en: sample }] }));
    expect(issues(result)).toEqual([{ path: "/productAttributes/items/1", code: "attribute_projection_text_too_large" }]);
  });
  it("counts UTF-8 bytes independently of the definition character bound", async () => {
    const type = definition([attribute("value", { kind: "text", maxLength: 16_384 })]);
    expect((await validateCatalogAttributes(type, subject({ value: "😀".repeat(512) }))).valid).toBe(true);
    expect((await validateCatalogAttributes(type, subject({ value: "😀".repeat(512) + "x" }))).valid).toBe(false);
  });
  it("bounds the whole localized map including escaped bytes and every locale", async () => {
    const type = definition([attribute("value", { kind: "localized_text", maxLength: 16_384, locales: ["en", "fr"] })]);
    for (const text of ["é".repeat(1_019) + "x", "\n".repeat(1_019) + "x"]) {
      const under = await validateCatalogAttributes(type, subject({ value: { en: text } }));
      expect(new TextEncoder().encode(rows(under)[0].text_value!).byteLength).toBe(2_048);
      expect((await validateCatalogAttributes(type, subject({ value: { en: text + "x" } }))).valid).toBe(false);
    }
    expect((await validateCatalogAttributes(type, subject({ value: { en: "x".repeat(1_020), fr: "x".repeat(1_020) } }))).valid).toBe(false);
  });
});
