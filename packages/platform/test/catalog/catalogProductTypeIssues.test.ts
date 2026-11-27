import { describe, expect, it } from "vitest";
import { catalogProductTypeIssues, createCatalogProductTypeRegistry } from "../../src/catalog/productTypeSchemas.js";
import { CATALOG_CONFORMANCE_RULES, catalogPackInstallIssues, catalogPackManifest, catalogVariantOptions,
  installCatalogDefinitions, withCatalogPublicationRules } from "../../src/catalog/index.js";
import { inspectCatalogPack, invalidCatalogPack } from "../../src/catalog/productTypeIssues.js";
import * as browserContracts from "../../src/catalog/contracts/index.js";
import type { CatalogPackInput } from "../../src/catalog/contracts/catalogPack.js";
import type { CatalogProductTypeDefinition } from "../../src/catalog/contracts/productTypes.js";
const definition: CatalogProductTypeDefinition = {
  key: "example:item", version: 1, units: [{ code: "openlup:piece", dimension: "count", integral: true }],
  netContentUnits: ["openlup:piece"], dimensions: [], validateContent: () => [],
};
describe("shared definition issues", () => {
  it("axis_values_and_units_mismatch_refuse_axis_mismatch", () => {
    const options = catalogVariantOptions([
      { key: "finish", kind: "choice", values: [{ id: "a" }, { id: "b" }], labels: {} },
      { key: "amount", kind: "quantity", dimension: "count", units: ["openlup:piece", "example:each"], labels: {} },
    ]);
    const units = [...definition.units, { code: "example:each", dimension: "count", integral: true },
      { code: "example:pair", dimension: "count", integral: true }];
    const type = { ...definition, units, ...options };
    expect(catalogProductTypeIssues([{ ...type, dimensions: [
      { key: "finish", kind: "choice", values: ["a", "c"] },
      { key: "amount", kind: "quantity", dimension: "count", units: ["openlup:piece", "example:pair"] },
    ] }])).toEqual([
      { code: "definition_axis_mismatch", path: "/0/axes/0" },
      { code: "definition_axis_mismatch", path: "/0/axes/1" },
    ]);
    expect(catalogProductTypeIssues([{ ...type, dimensions: [
      { key: "finish", kind: "choice", values: ["b", "a"] },
      { key: "amount", kind: "quantity", dimension: "count", units: ["example:each", "openlup:piece"] },
    ] }])).toEqual([]);
  });
  it("duplicate_axis_attribute_refuses", () => {
    const options = catalogVariantOptions([{ key: "lined", kind: "boolean", labels: {} }]);
    const duplicate = { key: "printed", attributeKey: "lined" };
    expect(catalogProductTypeIssues([{ ...definition, ...options, dimensions: [...options.dimensions, { key: "printed", kind: "boolean" }],
      axes: [...options.axes, duplicate] }])).toEqual([{ code: "definition_duplicate_axis_attribute", path: "/0/axes/1/attributeKey" }]);
  });
  it("type_without_axes_is_byte_identical", () => {
    const input = { ...definition, units: [...definition.units, ...definition.units], netContentUnits: ["example:unknown"],
      dimensions: [{ key: "finish", kind: "choice", values: ["matte", "matte"] }] };
    // Snapshot of the definition owner's output at e18695316.
    expect(JSON.stringify(catalogProductTypeIssues([definition, input]))).toBe(
      '[{"code":"definition_duplicate_identity","path":"/1/key"},'
      + '{"code":"definition_duplicate_unit","path":"/1/units/1/code","fix":"Remove the duplicate unit code."},'
      + '{"code":"definition_unknown_net_content_unit","path":"/1/netContentUnits/0","fix":"Declare the unit or remove its reference."},'
      + '{"code":"definition_duplicate_choice","path":"/1/dimensions/0/values/1"}]',
    );
  });
  it("keeps conformance guidance in the server entry", () => {
    expect(browserContracts).not.toHaveProperty("CATALOG_CONFORMANCE_RULES");
    expect(CATALOG_CONFORMANCE_RULES.quantity_not_exactly_representable).toMatchObject({
      severity: "error", rule: expect.any(String), fix: expect.any(String),
      recipe: "how-to/extend/catalogue-extension.md#add-unit",
    });
  });
  it("registry_issue_codes_carry_path", () => {
    const input = { ...definition, units: [...definition.units, ...definition.units], netContentUnits: ["example:unknown"], dimensions: [{ key: "finish", kind: "choice", values: ["matte", "matte"] }] };
    const issues = catalogProductTypeIssues([input]);
    expect(issues).toEqual([
      { code: "definition_duplicate_unit", path: "/0/units/1/code", fix: "Remove the duplicate unit code." },
      { code: "definition_unknown_net_content_unit", path: "/0/netContentUnits/0", fix: "Declare the unit or remove its reference." },
      { code: "definition_duplicate_choice", path: "/0/dimensions/0/values/1" },
    ]);
    try { createCatalogProductTypeRegistry([input as CatalogProductTypeDefinition]); expect.fail("registry admitted invalid definition"); }
    catch (error) { expect(error).toMatchObject({ message: "invalid_catalog_type_definition", code: "invalid_catalog_type_definition", issue: issues[0] }); }
    for (const issue of issues) expect(CATALOG_CONFORMANCE_RULES[issue.code]).toMatchObject({ severity: "error", fix: expect.any(String), recipe: expect.stringContaining("catalogue-extension.md#") });
    expect(catalogProductTypeIssues([{ ...definition, "bad/~field": true }])).toContainEqual({ code: "definition_unknown_field", path: "/0/bad~1~0field" });
  });
  it.each([
    [{ key: "invalid" }, "definition_key_invalid", "/0/key"],
    [{ version: 0 }, "definition_version_invalid", "/0/version"],
    [{ validateContent: null }, "definition_callback_missing", "/0/validateContent"],
    [{ units: [{ code: "invalid", dimension: "mass", integral: false }] }, "definition_unit_invalid", "/0/units/0/code"],
    [{ dimensions: [{ key: "bad!", kind: "boolean" }] }, "definition_dimension_invalid", "/0/dimensions/0/key"],
    [{ netContentUnits: [] }, "definition_net_content_invalid", "/0/netContentUnits"],
    [{ units: [...definition.units, ...definition.units] }, "definition_duplicate_unit", "/0/units/1/code"],
    [{ dimensions: [{ key: "finish", kind: "boolean" }, { key: "finish", kind: "boolean" }] }, "definition_duplicate_dimension", "/0/dimensions/1/key"],
    [{ netContentUnits: ["openlup:piece", "openlup:piece"] }, "definition_duplicate_net_content_unit", "/0/netContentUnits/1"],
    [{ dimensions: [{ key: "size", kind: "quantity", dimension: "count", units: ["openlup:piece", "openlup:piece"] }] }, "definition_duplicate_dimension_unit", "/0/dimensions/0/units/1"],
    [{ dimensions: [{ key: "size", kind: "quantity", dimension: "mass", units: ["openlup:piece"] }] }, "definition_dimension_unit_mismatch", "/0/dimensions/0/units/0"],
    [{ validatorRef: "unversioned" }, "definition_validator_ref_invalid", "/0/validatorRef"],
    [{ units: [{ ...definition.units[0], factor: { canonicalUnit: "openlup:g", unscaled: "1", scale: 0 } }] }, "definition_unit_factor_invalid", "/0/units/0/factor"],
  ])("reports admission fault %s", (change, code, path) => {
    expect(catalogProductTypeIssues([{ ...definition, ...change }])).toContainEqual(expect.objectContaining({ code, path }));
  });
  it("retains distinct duplicate, role and axis refusals", () => {
    expect(catalogProductTypeIssues([{ ...definition, taxClass: "standard" }])).toEqual([]);
    expect(catalogProductTypeIssues([definition, definition])).toContainEqual({ code: "definition_duplicate_identity", path: "/1/key" });
    const input = { ...definition, units: [...definition.units, { code: "openlup:g", dimension: "mass", integral: false }], dimensions: [
      { key: "first", kind: "quantity", dimension: "mass", units: ["openlup:g"], role: "net_content" },
      { key: "second", kind: "quantity", dimension: "count", units: ["openlup:piece"], role: "net_content" },
    ], axes: [{ key: "missing", attributeKey: "missing" }] };
    expect(catalogProductTypeIssues([input])).toEqual(expect.arrayContaining([
      { code: "definition_net_content_unit_mismatch", path: "/0/dimensions/0/units/0" },
      { code: "definition_multiple_net_content_dimensions", path: "/0/dimensions/1/role" },
      { code: "definition_unknown_axis_attribute", path: "/0/axes/0/attributeKey" },
      { code: "definition_unknown_axis_dimension", path: "/0/axes/0/key" },
    ]));
  });
  it("refuses unknown attribute units and product-owned axis attributes", () => {
    const attribute = { key: "amount", scope: "product", valueType: { kind: "quantity", dimension: "mass", units: ["example:missing"] }, required: false, cardinality: { min: 0, max: 1 }, filterable: true, facetable: false, public: true, displayOrder: 0, labels: {} };
    const input = { ...definition, attributes: [attribute], axes: [{ key: "amount", attributeKey: "amount" }], dimensions: [{ key: "amount", kind: "quantity", dimension: "count", units: ["openlup:piece"] }] };
    expect(catalogProductTypeIssues([input])).toEqual([
      { code: "definition_unknown_attribute_unit", path: "/0/attributes/0/valueType/units/0" },
      { code: "definition_axis_scope_invalid", path: "/0/axes/0/attributeKey" },
    ]);
  });
  it("checks definition metadata without evaluating attribute values or callbacks", () => {
    const attribute = { key: "finish", scope: "variant", valueType: { kind: "enum", values: [{ id: "matte" }, { id: "matte" }] }, required: true, cardinality: { min: 1, max: 1 }, filterable: false, facetable: true, public: true, displayOrder: 0, labels: {} };
    const input = { ...definition, attributes: [attribute, attribute], dimensions: [{ key: "finish", kind: "choice", values: ["matte"] }], axes: [{ key: "finish", attributeKey: "finish" }, { key: "finish", attributeKey: "finish" }], validateContent: () => { throw new Error("must not run"); } };
    expect(catalogProductTypeIssues([input]).map(({ code }) => code)).toEqual(expect.arrayContaining(["definition_duplicate_attribute", "definition_facetable_not_filterable", "definition_duplicate_enum_value", "definition_duplicate_axis"]));
  });
});

it("keeps exact factor and declaration refusals at their original pack positions", () => {
  const custom = { code: "example:case", dimension: "count", integral: false };
  const pack = { id: "example:item", namespace: "example", version: 1, openlupRange: "1.x", capabilities: {}, taxClasses: [],
    types: [{ ...definition, version: 2 }, { ...definition, units: [...definition.units, custom, ...definition.units],
      netContentUnits: [custom.code, "example:unknown", custom.code] }] };
  const { issues } = inspectCatalogPack(pack, true);
  const expected = [
    { code: "definition_unit_factor_invalid", path: "/types/1/units/1/factor", quantityCause: "quantity_unknown_unit", fix: expect.any(String) },
    { code: "definition_duplicate_unit", path: "/types/1/units/2/code", fix: "Remove the duplicate unit code." },
    { code: "definition_duplicate_net_content_unit", path: "/types/1/netContentUnits/2", fix: "Remove the duplicate net-content unit." },
    { code: "definition_unknown_net_content_unit", path: "/types/1/netContentUnits/1", fix: "Declare the unit or remove its reference." },
  ];
  expect(issues).toEqual(expected);
  issues.forEach((issue, index) => {
    expect(invalidCatalogPack(issue)).toMatchObject({ message: "invalid_catalog_pack", issue: expected[index] });
  });
});

it.each(["openlup:piece", "openlup:l"])("refuses a factorless %s declared as mass for net content", code => {
  const pack = { id: "example:item", namespace: "example", version: 1, openlupRange: "1.x", capabilities: {}, taxClasses: [],
    types: [{ ...definition, version: 2 }, { ...definition, units: [...definition.units.filter(unit => unit.code !== code),
      { code, dimension: "mass", integral: true }], netContentUnits: [code] }] };
  const unitIndex = pack.types[1]!.units.length - 1;
  expect(inspectCatalogPack(pack, true).issues).toEqual([{
    code: "definition_unit_factor_invalid", path: `/types/1/units/${unitIndex}/factor`,
    quantityCause: "quantity_cross_dimension", fix: expect.any(String),
  }]);
});

it("installCatalogDefinitions inspects the pack only once before issuing SQL", async () => {
  const rulesSource = Buffer.from(`module.exports = {
    validateContent: () => [],
    validateProduct: () => [],
    identifyDocument: () => null,
    inspectDocument: () => null,
    matchesDocument: () => false,
    deriveSkuFacts: () => ({}),
    classifySkuChange: () => "inconclusive",
  };`);
  const base = withCatalogPublicationRules<CatalogPackInput>({
    id: "example:single-inspect", namespace: "example", version: 1, openlupRange: "1.x",
    capabilities: { publish: false }, types: [definition], taxClasses: [{ key: "example:standard" }],
  }, () => rulesSource);
  const expectedDigest = catalogPackManifest(base).digest;
  let rangeReads = 0;
  const tracked: CatalogPackInput = { ...base };
  Object.defineProperty(tracked, "openlupRange", {
    enumerable: true,
    get() {
      rangeReads += 1;
      return base.openlupRange;
    },
  });
  expect(catalogPackInstallIssues(tracked)).toEqual([]);
  const readsPerInspection = rangeReads;
  expect(readsPerInspection).toBeGreaterThan(0);

  rangeReads = 0;
  let queries = 0;
  const receipt = await installCatalogDefinitions({
    async query() {
      queries += 1;
      return {
        rows: [{
          receipt: {
            packId: base.id, version: base.version, manifestDigest: expectedDigest,
            installedAt: "2026-11-27T00:00:00.000Z", types: [], taxClasses: ["example:standard"],
          },
        }],
      };
    },
  }, tracked);
  expect(queries).toBe(1);
  expect(receipt.manifestDigest).toBe(expectedDigest);
  expect(rangeReads).toBe(readsPerInspection);
});
