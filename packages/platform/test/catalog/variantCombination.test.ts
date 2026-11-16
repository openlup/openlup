import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalCatalogOption } from "../../src/catalog/contracts/productTypes.js";
import { catalogOptionValueSchema } from "../../src/catalog/productTypeSchemas.js";
import type { CatalogOptionValue, CatalogProductTypeInput } from "../../src/catalog/contracts/productTypes.js";
import { canonicalizeCatalogCombinationV2, classifyCatalogCombinationConflictV2, validateCatalogCombinationChangesV2 } from "../../src/catalog/variantCombination.js";

const attribute = { scope: "variant" as const, required: true, cardinality: { min: 1, max: 1 },
  filterable: false, facetable: false, public: true, displayOrder: 0, labels: {} };
const definition: CatalogProductTypeInput = {
  key: "example:combination", version: 1, netContentUnits: ["openlup:g"], validateContent: () => [],
  units: [
    { code: "openlup:g", dimension: "mass", integral: false, factor: { canonicalUnit: "openlup:g", unscaled: "1", scale: 0 } },
    { code: "openlup:kg", dimension: "mass", integral: false, factor: { canonicalUnit: "openlup:g", unscaled: "1000", scale: 0 } },
    { code: "example:small", dimension: "mass", integral: false, factor: { canonicalUnit: "openlup:g", unscaled: "1", scale: 12 } },
  ],
  dimensions: [{ key: "size", kind: "quantity", dimension: "mass", units: ["openlup:g", "openlup:kg", "example:small"] },
    { key: "finish", kind: "choice", values: ["matte", "gloss"] }, { key: "enabled", kind: "boolean" }],
  attributes: [
    { ...attribute, key: "amount", valueType: { kind: "quantity", dimension: "mass", units: ["openlup:g", "openlup:kg", "example:small"] } },
    { ...attribute, key: "surface", valueType: { kind: "enum", values: [{ id: "matte", labels: { en: "Matte" } }, { id: "gloss" }] } },
    { ...attribute, key: "enabled", valueType: { kind: "boolean" } },
  ],
  axes: [{ key: "finish", attributeKey: "surface" }, { key: "size", attributeKey: "amount" }, { key: "enabled", attributeKey: "enabled" }],
};
const quantity = (unscaled: string, scale = 0, unit = "openlup:g"): CatalogOptionValue =>
  ({ kind: "quantity", value: { dimension: "mass", unscaled, scale, unit } });
const options = { size: quantity("1000"), finish: { kind: "choice", value: "matte" }, enabled: { kind: "boolean", value: false } } as const;
const axes = ["size", "enabled", "finish"];
const canonical = (values: Readonly<Record<string, CatalogOptionValue>> = options, selected: readonly string[] = axes, metadata = definition) => canonicalizeCatalogCombinationV2({ definition: metadata, axes: selected, options: values });

it("catalog_equivalent_units_share_combination_identity", () => {
  const identity = canonical();
  for (const value of [quantity("1", 0, "openlup:kg"), quantity("1000000", 3), quantity("1000")]) {
    expect(canonical({ ...options, size: value })).toEqual(identity);
  }
  expect(Buffer.from(identity.combinationDigest).toString("hex")).toBe(createHash("sha256").update(identity.canonicalOptionBytes).digest("hex"));
  const boundary = canonical({ ...options, size: quantity(`1${"0".repeat(39)}`) });
  for (const scale of [1, 12]) {
    const equivalent = quantity(`1${"0".repeat(39 + scale)}`, scale);
    expect(canonical({ ...options, size: equivalent })).toEqual(boundary);
    // The unchanged v1 wire schema deliberately keeps its original 40-digit ceiling.
    expect(catalogOptionValueSchema.safeParse(equivalent).success).toBe(false);
  }
  expect(catalogOptionValueSchema.safeParse(quantity(`1${"0".repeat(39)}`)).success).toBe(true);
  expect(canonicalCatalogOption(quantity("1", 0, "openlup:kg"))).not.toEqual(canonicalCatalogOption(quantity("1000")));
});

it("catalog_axis_reorder_preserves_sku_identity", () => {
  expect(canonical(options, [...axes].reverse())).toEqual(canonical());
  expect(axes).toEqual(["size", "enabled", "finish"]);
  const relabelled = { ...definition, labels: { en: "New title" }, axes: definition.axes?.map(axis => ({ ...axis, labels: { en: "New axis" } })),
    attributes: definition.attributes?.map(value => value.valueType.kind === "enum" ? { ...value,
      valueType: { ...value.valueType, values: value.valueType.values.map(entry => ({ ...entry, labels: { en: "New label" } })) } } : value) };
  expect(canonical(options, axes, relabelled)).toEqual(canonical());
  expect(canonical({ ...options, enabled: { kind: "boolean", value: true } })).not.toEqual(canonical());
  expect(canonical({ ...options, finish: { kind: "choice", value: "gloss" } })).not.toEqual(canonical());
});

describe("combination validation table", () => {
  it.each([
    ["unknown axis", ["unknown"], {}, "axis_not_installed"],
    ["repeated axis", ["finish", "finish"], { finish: options.finish }, "duplicate_axis"],
    ["incomplete supplied combination", axes, { finish: options.finish }, "option_missing"],
    ["extra option", ["finish"], options, "option_not_selected"],
    ["enum label is not ID", ["finish"], { finish: { kind: "choice", value: "Matte" } }, "option_invalid"],
    ["boolean spelling", ["enabled"], { enabled: { kind: "boolean", value: "false" } }, "option_invalid"],
    ["unknown unit", ["size"], { size: quantity("1", 0, "example:unknown") }, "option_invalid"],
    ["precision overflow", ["size"], { size: quantity("1", 1, "example:small") }, "quantity_not_exactly_representable"],
    ["numeric overflow", ["size"], { size: quantity("9".repeat(40), 0, "openlup:kg") }, "quantity_overflow"],
    ["beyond canonical integer bound", ["size"], { size: quantity(`1${"0".repeat(40)}`) }, "quantity_overflow"],
    ["extra quantity option field", ["size"], { size: { ...quantity("1"), extra: true } }, "option_invalid"],
    ["extra quantity value field", ["size"], { size: { kind: "quantity", value: { dimension: "mass", unit: "openlup:g", unscaled: "1", scale: 0, extra: true } } }, "option_invalid"],
  ])("%s", (_name, selected, values, code) => {
    expect(() => canonicalizeCatalogCombinationV2({ definition, axes: selected as string[], options: values as Record<string, CatalogOptionValue> })).toThrow(code as string);
  });
  it("requires explicit unit factors even for standard units", () => {
    expect(() => canonical(options, axes, { ...definition, units: definition.units.map(({ factor: _factor, ...unit }) => unit) })).toThrow("unit_factor_missing");
  });
});

it("classifies duplicate and collision without merging identities", () => {
  const a = canonical(), b = canonical({ ...options, finish: { kind: "choice", value: "gloss" } });
  expect(classifyCatalogCombinationConflictV2(a, b)).toBe("distinct");
  expect(classifyCatalogCombinationConflictV2(a, canonical())).toBe("duplicate");
  expect(classifyCatalogCombinationConflictV2(a, { ...b, combinationDigest: a.combinationDigest })).toBe("collision");
});

it("prepares incremental changes while retaining omitted identities and withdrawal facts", () => {
  const fact = { skuId: "a", state: "active" as const, optionValues: options, identity: canonical() };
  const prepare = (incoming: Parameters<typeof validateCatalogCombinationChangesV2>[0]["incoming"]) =>
    validateCatalogCombinationChangesV2({ definition, axes, typed: true, retained: [fact], incoming });
  expect(prepare([])).toEqual([fact]);
  expect(prepare([{ skuId: "a", state: "withdrawn" }])).toEqual([{ ...fact, state: "withdrawn" }]);
  expect(validateCatalogCombinationChangesV2({ definition, axes: [], typed: true, retained: [fact],
    incoming: [{ skuId: "a", state: "withdrawn" }] })).toEqual([{ ...fact, state: "withdrawn" }]);
  expect(prepare([{ skuId: "a", state: "active", optionValues: { ...options, size: quantity("1", 0, "openlup:kg") } }])[0].identity).toEqual(fact.identity);
  expect(() => prepare([{ skuId: "a", state: "active", optionValues: { ...options, finish: { kind: "choice", value: "gloss" } } }])).toThrow("sku_identity_change_requires_new_sku");
  expect(() => prepare([{ skuId: "b", state: "active", optionValues: options }])).toThrow("duplicate_combination");
  expect(prepare([{ skuId: "a", state: "withdrawn" }, { skuId: "b", state: "active", optionValues: options }])).toHaveLength(2);
});

it("sku_identity_change_requires_new_sku", () => {
  const fact = { skuId: "a", state: "active" as const, optionValues: options, identity: canonical() };
  expect(() => validateCatalogCombinationChangesV2({ definition, axes, typed: true, retained: [fact],
    incoming: [{ skuId: "a", state: "active", optionValues: { ...options, finish: { kind: "choice", value: "gloss" } } }] }))
    .toThrow(expect.objectContaining({ code: "sku_identity_change_requires_new_sku", path: "a" }));
});

it.each(["inconsistent digest", "inconsistent bytes", "digest collision"] as const)(
  "combination_identity_integrity_failed: %s", fault => {
    const identity = canonical();
    const different = canonical({ ...options, finish: { kind: "choice", value: "gloss" } });
    const corrupted = fault === "inconsistent digest" ? { ...identity, combinationDigest: different.combinationDigest }
      : { ...different, combinationDigest: identity.combinationDigest };
    const fact = { skuId: "a", state: "active" as const, optionValues: options, identity: corrupted };
    const retained = fault === "digest collision" ? [
      { ...fact, skuId: "b", identity }, fact,
    ] : [fact];
    expect(() => validateCatalogCombinationChangesV2({ definition, axes, typed: fault !== "digest collision", retained, incoming: [] }))
      .toThrow(expect.objectContaining({ code: "combination_identity_integrity_failed", path: "a" }));
  },
);

it("distinguishes legacy absence from incomplete typed options and the empty identity", () => {
  const input = { definition, axes: [], typed: false, retained: [], incoming: [{ skuId: "a", state: "active" as const }] };
  expect(validateCatalogCombinationChangesV2(input)[0].identity).toBeNull();
  expect(() => validateCatalogCombinationChangesV2({ ...input, typed: true })).toThrow("option_missing");
  expect(validateCatalogCombinationChangesV2({ ...input, typed: true, incoming: [{ ...input.incoming[0], optionValues: {} }] })[0].identity)
    .toEqual(canonicalizeCatalogCombinationV2({ definition, axes: [], options: {} }));
  expect(() => validateCatalogCombinationChangesV2({ ...input, incoming: [{ ...input.incoming[0], optionValues: {} }], axes })).toThrow("option_missing");
});

it("separates payload and configured retained product capacity without a Cartesian product", () => {
  const retained = Array.from({ length: 15_768 }, (_, i) => ({ skuId: String(i), state: "withdrawn" as const, optionValues: null, identity: null }));
  const input = { definition, axes: [], typed: false, retained, incoming: [] };
  expect(validateCatalogCombinationChangesV2(input)).toHaveLength(15_768);
  expect(() => validateCatalogCombinationChangesV2({ ...input, capacity: 15_767 })).toThrow("product_capacity_exceeded");
  expect(() => validateCatalogCombinationChangesV2({ ...input, capacity: 0 })).toThrow("product_capacity_invalid");
  const incoming = Array.from({ length: 10_000 }, (_, i) => ({ skuId: String(i), state: "withdrawn" as const }));
  expect(validateCatalogCombinationChangesV2({ ...input, incoming, capacity: 15_768 })).toHaveLength(15_768);
  expect(() => validateCatalogCombinationChangesV2({ ...input, incoming: [...incoming, { skuId: "new", state: "active" }] })).toThrow("sku_payload_limit");
});
