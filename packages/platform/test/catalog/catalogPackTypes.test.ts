import { expect, it } from "vitest";
import { defineCatalogPack, draftsFor, type CatalogPackInput, type CatalogTypeDefinitionV2, type CatalogQuantity as PlatformQuantity } from "../../src/catalog/contracts/index.js";
import type { CatalogQuantity } from "@openlup/core/catalog";
import type { AttributeDefinition, CatalogDraftPayload, CatalogDraftCommand, CatalogPackDraft } from "../../src/catalog/contracts/index.js";
import { catalogDraftPayloadSchema } from "../../src/catalog/draftSchemas.js";
import { createCatalogProductTypeRegistry } from "../../src/catalog/productTypeSchemas.js";
import { validateCatalogDraft } from "../../src/catalog/draftValidation.js";
const referencedAttribute = {
  key: "amount", scope: "variant", valueType: { kind: "boolean" }, required: true as boolean,
  cardinality: { min: 1, max: 1 }, filterable: false, facetable: false, public: true, displayOrder: 0, labels: {},
} satisfies AttributeDefinition;
const quantityListAttribute = {
  ...referencedAttribute, key: "amounts",
  valueType: { kind: "list", min: 0, max: 2, item: { kind: "quantity", dimension: "count", units: ["openlup:piece"] } },
} as const satisfies AttributeDefinition;
const pack = defineCatalogPack({
  id: "example:pack", namespace: "example", version: 1, openlupRange: "0.44.x", capabilities: { publish: false },
  taxClasses: [{ key: "example:standard" }], subscriptionProfiles: [{ key: "example:regular", version: 1 }],
  types: [{
    key: "example:item", version: 1, units: [{ code: "openlup:piece", dimension: "count", integral: true }, { code: "example:gram", dimension: "mass", integral: false, factor: { canonicalUnit: "openlup:g", unscaled: "1", scale: 0 } }],
    netContentUnits: ["openlup:piece"], dimensions: [{ key: "finish", kind: "choice", values: ["matte", "gloss"] }, { key: "size", kind: "choice", values: ["compact", "large"] }], attributes: [referencedAttribute],
    validateContent: (_content: unknown) => [], taxClass: "example:standard", subscriptionProfileRef: { key: "example:regular", version: 1 },
  }, {
    key: "example:other", version: 1, units: [{ code: "openlup:g", dimension: "mass", integral: false }],
    netContentUnits: ["openlup:g"], dimensions: [{ key: "size", kind: "choice", values: ["small"] }], validateContent: (_content: unknown) => [],
  }, {
    key: "example:plain", version: 1, units: [{ code: "openlup:piece", dimension: "count", integral: true }],
    netContentUnits: ["openlup:piece"], dimensions: [], validateContent: (_content: unknown) => [],
  }],
});
const product = { id: "10000000-0000-4000-8000-000000000001", type: { key: "example:item", version: 1 }, dimensions: ["finish"] } as const;
const sku = { id: "20000000-0000-4000-8000-000000000001", productId: product.id, options: { finish: { kind: "choice", value: "matte" } } } as const;
it("define_catalog_pack_types_reject_undeclared_keys", () => {
  expect(draftsFor(pack)([{ schemaVersion: 1, product, skus: [sku] }])).toHaveLength(1);
  const plain = { ...product, type: { key: pack.types[2].key, version: pack.types[2].version }, dimensions: [] } as const;
  expect(draftsFor(pack)([{ schemaVersion: 1, product: plain, skus: [{ ...sku, options: {} }] }])).toHaveLength(1);
  expect(draftsFor(pack)([{ schemaVersion: 1, product: { ...product, dimensions: ["finish", "size"] }, skus: [{ ...sku, options: { ...sku.options, size: { kind: "choice", value: "compact" } } }] }])).toHaveLength(1);
  expect(pack.types[0].attributes[0].required).toBe(true);
  expect(defineCatalogPack({ ...pack, types: [{ ...pack.types[0], attributes: [quantityListAttribute] }] }).types[0].attributes[0].valueType.item.units).toEqual(["openlup:piece"]);
  const explicit = draftsFor(pack)([{ schemaVersion: 1, product, skus: [{
    id: "20000000-0000-4000-8000-000000000001", productId: "10000000-0000-4000-8000-000000000001", code: "EXPLICIT",
    options: { finish: { kind: "choice", value: "matte" } },
    netContent: { dimension: "count", unscaled: "1", scale: 0, unit: "openlup:piece" },
    grossMass: { dimension: "mass", unscaled: "100", scale: 0, unit: "example:gram" },
    identifiers: [{ scheme: "example:identifier", issuer: "example", value: "item-1", packagingLevel: "unit" }],
    assetRefs: ["example:asset"],
  }] }]);
  const wire = catalogDraftPayloadSchema.parse(explicit[0]);
  expect(validateCatalogDraft(wire, createCatalogProductTypeRegistry(pack.types)).valid).toBe(true);
  const annotated: CatalogPackDraft<typeof pack, "finish"> = { schemaVersion: 1, product, skus: [{
    id: "20000000-0000-4000-8000-000000000001", productId: "10000000-0000-4000-8000-000000000001",
    options: { finish: { kind: "choice", value: "matte" } },
  }] };
  expect(annotated.product.dimensions).toEqual(["finish"]);
  const compileOnly = (): void => {
    // @ts-expect-error a zero-dimension type has closed empty options.
    draftsFor(pack)([{ schemaVersion: 1, product: plain, skus: [{ ...sku, options: { undeclared: { kind: "choice", value: "invalid" } } }] }]);
    // @ts-expect-error installed but unselected dimensions are not SKU options.
    draftsFor(pack)([{ schemaVersion: 1, product, skus: [{ ...sku, options: { ...sku.options, size: { kind: "choice", value: "compact" } } }] }]);
    // @ts-expect-error every selected dimension must have its option in complete authoring.
    draftsFor(pack)([{ schemaVersion: 1, product: { ...product, dimensions: ["finish", "size"] }, skus: [sku] }]);
    // @ts-expect-error referenced attribute objects are recursively readonly in the returned pack.
    pack.types[0].attributes[0].required = false;
    // @ts-expect-error list item quantities cannot reference undeclared units.
    defineCatalogPack({ ...pack, types: [{ ...pack.types[0], attributes: [{ ...quantityListAttribute, valueType: { ...quantityListAttribute.valueType, item: { ...quantityListAttribute.valueType.item, units: ["example:undeclared"] } } }] }] });
    // @ts-expect-error Unknown type key.
    draftsFor(pack)([{ schemaVersion: 1, product: { ...product, type: { key: "example:missing", version: 1 } }, skus: [] }]);
    // @ts-expect-error The other type's axis is not an item axis.
    draftsFor(pack)([{ schemaVersion: 1, product, skus: [{ ...sku, options: { size: { kind: "choice", value: "small" } } }] }]);
    // @ts-expect-error Choice values are inferred literals.
    draftsFor(pack)([{ schemaVersion: 1, product, skus: [{ ...sku, options: { finish: { kind: "choice", value: "missing" } } }] }]);
    // @ts-expect-error Net content uses the admitted piece unit, not another type's gram unit.
    draftsFor(pack)([{ schemaVersion: 1, product, skus: [{ id: "20000000-0000-4000-8000-000000000001", productId: "10000000-0000-4000-8000-000000000001", code: "EXPLICIT", options: { finish: { kind: "choice", value: "matte" } }, netContent: { dimension: "count", unscaled: "1", scale: 0, unit: "openlup:g" }, grossMass: { dimension: "mass", unscaled: "100", scale: 0, unit: "example:gram" }, identifiers: [{ scheme: "example:identifier", issuer: "example", value: "item-1", packagingLevel: "unit" }], assetRefs: ["example:asset"] }] }]);
    // @ts-expect-error Unknown product dimension.
    draftsFor(pack)([{ schemaVersion: 1, product: { ...product, dimensions: ["missing"] }, skus: [] }]);
    const widened: CatalogPackInput = pack;
    // @ts-expect-error Literal inference cannot be recovered from widened descriptors.
    draftsFor(widened);
    // @ts-expect-error The definition's unit reference crosses type boundaries.
    defineCatalogPack({ ...pack, types: [{ ...pack.types[0], netContentUnits: ["openlup:g"] }] });
    // @ts-expect-error Undeclared tax class.
    defineCatalogPack({ ...pack, types: [{ ...pack.types[0], taxClass: "example:missing" }] });
    // @ts-expect-error Profile versions are inferred too.
    defineCatalogPack({ ...pack, types: [{ ...pack.types[0], subscriptionProfileRef: { key: "example:regular", version: 2 } }] });
    // @ts-expect-error Type keys use the declared namespace.
    defineCatalogPack({ ...pack, types: [{ ...pack.types[0], key: "other:item" }] });
  };
  expect(compileOnly).toBeTypeOf("function");
});
// Both public imports name the same Core shape, in both assignment directions.
const coreQuantity: CatalogQuantity = { dimension: "mass", unscaled: "1", scale: 0, unit: "openlup:g" };
const platformQuantity: PlatformQuantity = coreQuantity;
const back: CatalogQuantity = platformQuantity;
it("keeps quantity re-exports identical and metadata free of callbacks", () => {
  const callbackInMetadata: "validateContent" extends keyof CatalogTypeDefinitionV2 ? true : false = false;
  expect(callbackInMetadata).toBe(false);
  expect(back).toBe(coreQuantity);
});

it("matches v1 runtime validation for the product's selected dimensions", () => {
  const authored = draftsFor(pack)([{ schemaVersion: 1, product, skus: [sku] }]);
  // The existing schema is the handoff from readonly authoring to mutable wire DTOs.
  const payload: CatalogDraftPayload = catalogDraftPayloadSchema.parse(authored[0]);
  const command: CatalogDraftCommand = { schemaVersion: 1, action: "create", draftId: product.id, commandKey: "example:create", expectedRevision: 0, payload };
  const registry = createCatalogProductTypeRegistry(pack.types);
  const result = validateCatalogDraft(command.payload!, registry);
  expect(result.valid).toBe(true);
  if (result.valid) expect(result.readiness.publication.issues.some(({ code }) => code === "option_missing")).toBe(false);
  const undeclared = catalogDraftPayloadSchema.parse({ ...payload, skus: [{ ...payload.skus[0], options: { ...payload.skus[0].options, size: { kind: "choice", value: "compact" } } }] });
  expect(validateCatalogDraft(undeclared, registry)).toMatchObject({ valid: false, issues: [{ path: "skus.0.options.size", code: "dimension_not_declared" }] });
});
