import { expect, it } from "vitest";
import { defineCatalogPack, draftsFor, type CatalogPackInput, type CatalogPackDraft, type CatalogTypeDefinitionV2, type CatalogQuantity as PlatformQuantity } from "../../src/catalog/contracts/index.js";
import type { CatalogQuantity } from "@openlup/core/catalog";
import { catalogDraftPayloadSchema } from "../../src/catalog/draftSchemas.js";
import { createCatalogProductTypeRegistry } from "../../src/catalog/productTypeSchemas.js";
import { catalogPackIssues } from "../../src/catalog/productTypeIssues.js";
import { validateCatalogDraft } from "../../src/catalog/draftValidation.js";
import type { VerifiedCatalogPublisher } from "../../src/catalog/publicationPorts.js";

const flags = { scope: "variant", required: true, cardinality: { min: 1, max: 1 }, filterable: true, facetable: true, public: true, displayOrder: 0, labels: { en: "Example" } } as const;
const text = { kind: "text", minLength: 1, maxLength: 80 } as const;
const localized = { kind: "localized_text", maxLength: 80, locales: ["en"], requiredLocales: ["en"] } as const;
const decimal = { kind: "decimal", scale: 2, min: "-10", max: "10" } as const;
const quantity = { kind: "quantity", dimension: "count", units: ["openlup:piece"] } as const;
const boolean = { kind: "boolean" } as const;
const enumeration = { kind: "enum", values: [{ id: "matte", labels: { en: "Matte" } }, { id: "gloss", labels: { en: "Gloss" } }] } as const;
const reference = { kind: "reference", allowlist: ["example:reference"] } as const;
const date = { kind: "date" } as const;
const editableAttribute = { ...flags, key: "editable" as const, required: true as boolean, valueType: boolean };
const attributes = [
  { ...flags, key: "text", valueType: text }, { ...flags, key: "localized", valueType: localized },
  { ...flags, key: "decimal", valueType: decimal }, { ...flags, key: "amount", valueType: quantity },
  { ...flags, key: "flag", valueType: boolean }, { ...flags, key: "finish", valueType: enumeration },
  { ...flags, key: "reference", valueType: reference }, { ...flags, key: "date", valueType: date },
  { ...flags, key: "list_text", valueType: { kind: "list", min: 0, max: 3, item: text } },
  { ...flags, key: "list_localized", valueType: { kind: "list", min: 0, max: 3, item: localized } },
  { ...flags, key: "list_decimal", valueType: { kind: "list", min: 0, max: 3, item: decimal } },
  { ...flags, key: "list_quantity", valueType: { kind: "list", min: 0, max: 3, item: quantity } },
  { ...flags, key: "list_boolean", valueType: { kind: "list", min: 0, max: 3, item: boolean } },
  { ...flags, key: "list_enum", valueType: { kind: "list", min: 0, max: 3, item: enumeration } },
  { ...flags, key: "list_reference", valueType: { kind: "list", min: 0, max: 3, item: reference } },
  { ...flags, key: "list_date", valueType: { kind: "list", min: 0, max: 3, item: date } },
  editableAttribute,
] as const;
const primary = {
  key: "example:item", version: 1,
  units: [
    { code: "openlup:piece", dimension: "count", integral: true, factor: { canonicalUnit: "openlup:piece", unscaled: "1", scale: 0 } },
    { code: "openlup:g", dimension: "mass", integral: false, factor: { canonicalUnit: "openlup:g", unscaled: "1", scale: 0 } },
    { code: "openlup:ml", dimension: "volume", integral: false, factor: { canonicalUnit: "openlup:ml", unscaled: "1", scale: 0 } },
  ], netContentUnits: ["openlup:piece", "openlup:g", "openlup:ml"],
  dimensions: [
    { key: "finish", kind: "choice", values: ["matte", "gloss"] },
    { key: "amount", kind: "quantity", dimension: "count", units: ["openlup:piece"], role: "net_content" },
    { key: "featured", kind: "boolean" },
  ], attributes,
  axes: [{ key: "finish", attributeKey: "finish", labels: { en: "Finish" } }, { key: "amount", attributeKey: "amount" }, { key: "featured", attributeKey: "flag" }],
  taxClass: "example:standard", subscriptionProfileRef: { key: "example:regular", version: 1 },
  validatorRef: `sha256:${"a".repeat(64)}`, labels: { en: "Item" }, validateContent: (_content: unknown) => [],
} as const;
const other = { key: "example:other", version: 1, units: [{ code: "example:other", dimension: "volume", integral: false }], netContentUnits: ["example:other"], dimensions: [], attributes: [], axes: [], validateContent: (_content: unknown) => [] } as const;
const baseline = { id: "example:pack", namespace: "example", version: 1, openlupRange: "0.44.x", capabilities: { publish: false, install: false }, types: [primary, other], taxClasses: [{ key: "example:standard", labels: { en: "Standard" } }], subscriptionProfiles: [{ key: "example:regular", version: 1 }] } as const;
const product = {
  id: "10000000-0000-4000-8000-000000000001", type: { key: "example:item", version: 1 }, slug: "example", primarySkuId: "20000000-0000-4000-8000-000000000001",
  dimensions: ["finish", "amount", "featured"], sharedContent: { title: "Example" },
  documentRevision: { id: "30000000-0000-4000-8000-000000000001", productId: "10000000-0000-4000-8000-000000000001", revisionNo: 1, schemaId: "example:document", documentRef: "example:document", sourceRef: "example:source", digest: "a".repeat(64) },
} as const;
const sku = {
  id: "20000000-0000-4000-8000-000000000001", productId: product.id, code: "EXAMPLE",
  options: { finish: { kind: "choice", value: "matte" }, amount: { kind: "quantity", value: { dimension: "count", unscaled: "1", scale: 0, unit: "openlup:piece" } }, featured: { kind: "boolean", value: true } },
  netContent: { dimension: "count", unscaled: "1", scale: 0, unit: "openlup:piece" }, grossMass: { dimension: "mass", unscaled: "100", scale: 0, unit: "openlup:g" },
  identifiers: [{ scheme: "example:identifier", issuer: "example", value: "ITEM", packagingLevel: "unit", quantity: 1 }], assetRefs: ["example:asset"], priceRef: "example:price", logisticsRef: "example:logistics",
} as const;
const draft = { schemaVersion: 1, product, skus: [sku] } as const;

// Each positive descriptor includes every value kind, all eight scalar list-item kinds,
// unit factors, reference metadata, and every v1 product/SKU field.
const constPack = { ...baseline } as const;
const constDraft = { ...draft } as const;
const readonlyUnits: readonly (typeof primary.units[number])[] = primary.units;
const readonlyAttributes: readonly (typeof attributes[number])[] = attributes;
const readonlyTypes: readonly ((Omit<typeof primary, "units" | "attributes"> & { units: typeof readonlyUnits; attributes: typeof readonlyAttributes }) | typeof other)[] = [{ ...primary, units: readonlyUnits, attributes: readonlyAttributes }, other];
const readonlyPack = { ...baseline, types: readonlyTypes };
const readonlyIdentifiers: readonly (typeof sku.identifiers[number])[] = sku.identifiers;
const readonlyAssets: readonly string[] = sku.assetRefs;
const readonlySkus: readonly (Omit<typeof sku, "identifiers" | "assetRefs"> & { identifiers: typeof readonlyIdentifiers; assetRefs: typeof readonlyAssets })[] = [{ ...sku, identifiers: readonlyIdentifiers, assetRefs: readonlyAssets }];
const readonlyDraft = { ...draft, skus: readonlySkus };
const mutableUnits = primary.units.map((unit) => ({ ...unit, factor: { ...unit.factor } }));
const mutableScalars = {
  text: { ...text }, localized: { ...localized, locales: [...localized.locales], requiredLocales: [...localized.requiredLocales] },
  decimal: { ...decimal }, quantity: { ...quantity, units: [...quantity.units] }, boolean: { ...boolean },
  enumeration: { ...enumeration, values: enumeration.values.map((value) => ({ ...value, labels: { ...value.labels } })) },
  reference: { ...reference, allowlist: [...reference.allowlist] }, date: { ...date },
};
const mutableAttributes = [
  { ...attributes[0], valueType: mutableScalars.text },
  { ...attributes[1], valueType: mutableScalars.localized },
  { ...attributes[2], valueType: mutableScalars.decimal },
  { ...attributes[3], valueType: mutableScalars.quantity },
  { ...attributes[4], valueType: mutableScalars.boolean },
  { ...attributes[5], valueType: mutableScalars.enumeration },
  { ...attributes[6], valueType: mutableScalars.reference },
  { ...attributes[7], valueType: mutableScalars.date },
  { ...attributes[8], valueType: { ...attributes[8].valueType, item: mutableScalars.text } },
  { ...attributes[9], valueType: { ...attributes[9].valueType, item: mutableScalars.localized } },
  { ...attributes[10], valueType: { ...attributes[10].valueType, item: mutableScalars.decimal } },
  { ...attributes[11], valueType: { ...attributes[11].valueType, item: mutableScalars.quantity } },
  { ...attributes[12], valueType: { ...attributes[12].valueType, item: mutableScalars.boolean } },
  { ...attributes[13], valueType: { ...attributes[13].valueType, item: mutableScalars.enumeration } },
  { ...attributes[14], valueType: { ...attributes[14].valueType, item: mutableScalars.reference } },
  { ...attributes[15], valueType: { ...attributes[15].valueType, item: mutableScalars.date } },
  { ...editableAttribute },
];
const mutableDimensions = primary.dimensions.map((dimension) => dimension.kind === "choice" ? { ...dimension, values: [...dimension.values] } : dimension.kind === "quantity" ? { ...dimension, units: [...dimension.units] } : { ...dimension });
const mutablePack = { ...baseline, types: [{ ...primary, units: mutableUnits, attributes: mutableAttributes, dimensions: mutableDimensions, axes: [...primary.axes] }, other], taxClasses: [...baseline.taxClasses], subscriptionProfiles: [...baseline.subscriptionProfiles] };
const mutableDraft = { ...draft, product: { ...product, dimensions: [...product.dimensions] }, skus: [{ ...sku, identifiers: [...sku.identifiers], assetRefs: [...sku.assetRefs] }] };
const { subscriptionProfileRef: _profile, validatorRef: _validator, taxClass: _tax, labels: _labels, axes: _axes, ...withoutOptionalType } = primary;
const { subscriptionProfiles: _profiles, ...withoutOptionalPack } = baseline;
const omittedScalars = {
  text: { kind: "text", maxLength: 80 }, localized: { kind: "localized_text", maxLength: 80, locales: ["en"] },
  decimal: { kind: "decimal", scale: 2 }, quantity, boolean,
  enumeration: { kind: "enum", values: [{ id: "matte" }, { id: "gloss" }] }, reference, date,
} as const;
const omittedAttributes = [
  { ...attributes[0], valueType: omittedScalars.text },
  { ...attributes[1], valueType: omittedScalars.localized },
  { ...attributes[2], valueType: omittedScalars.decimal },
  { ...attributes[3], valueType: omittedScalars.quantity },
  { ...attributes[4], valueType: omittedScalars.boolean },
  { ...attributes[5], valueType: omittedScalars.enumeration },
  { ...attributes[6], valueType: omittedScalars.reference },
  { ...attributes[7], valueType: omittedScalars.date },
  { ...attributes[8], valueType: { ...attributes[8].valueType, item: omittedScalars.text } },
  { ...attributes[9], valueType: { ...attributes[9].valueType, item: omittedScalars.localized } },
  { ...attributes[10], valueType: { ...attributes[10].valueType, item: omittedScalars.decimal } },
  { ...attributes[11], valueType: { ...attributes[11].valueType, item: omittedScalars.quantity } },
  { ...attributes[12], valueType: { ...attributes[12].valueType, item: omittedScalars.boolean } },
  { ...attributes[13], valueType: { ...attributes[13].valueType, item: omittedScalars.enumeration } },
  { ...attributes[14], valueType: { ...attributes[14].valueType, item: omittedScalars.reference } },
  { ...attributes[15], valueType: { ...attributes[15].valueType, item: omittedScalars.date } },
  editableAttribute,
] as const;
const omittedPack = { ...withoutOptionalPack, taxClasses: baseline.taxClasses.map(({ key }) => ({ key })), types: [{ ...withoutOptionalType, units: primary.units.map(({ factor: _factor, ...unit }) => unit), attributes: omittedAttributes }, other] };
const omittedDraft = { schemaVersion: 1, product: { id: product.id, type: product.type, dimensions: product.dimensions }, skus: [{ id: sku.id, productId: sku.productId, options: sku.options }] } as const;
const inlinePack = { ...baseline, types: [{ ...primary }, other] };
const inlineDraft = { schemaVersion: 1, product: { id: product.id, type: product.type, slug: "example", primarySkuId: sku.id, dimensions: product.dimensions, sharedContent: { title: "Example" }, documentRevision: product.documentRevision }, skus: [{ id: sku.id, productId: product.id, code: "EXAMPLE", options: sku.options, netContent: sku.netContent, grossMass: sku.grossMass, identifiers: sku.identifiers, assetRefs: sku.assetRefs, priceRef: "example:price", logisticsRef: "example:logistics" }] } as const;
const referencedType = primary;
const referencedProfile = baseline.subscriptionProfiles;
const referencedPack = { ...baseline, types: [referencedType, other], subscriptionProfiles: referencedProfile } as const;
const referencedProduct = product;
const referencedSku = sku;
const referencedDraft = { schemaVersion: 1, product: referencedProduct, skus: [referencedSku] } as const;

function packCodes(input: unknown): string[] { return [...new Set(catalogPackIssues(input).map(({ code }) => code))].sort(); }
function draftCodes(pack: CatalogPackInput, input: unknown): string[] {
  const parsed = catalogDraftPayloadSchema.safeParse(input);
  if (!parsed.success) return [...new Set(parsed.error.issues.map(({ code }) => code))].sort();
  const result = validateCatalogDraft(parsed.data, createCatalogProductTypeRegistry(pack.types));
  return [...new Set(result.valid ? result.readiness.publication.issues.filter(({ code }) => code === "option_missing").map(({ code }) => code) : result.issues.map(({ code }) => code))].sort();
}
type MatrixCase = { form: string; name: string; expected: readonly string[]; run: () => string[] };
const matrix: MatrixCase[] = [
  { form: 'as const', name: 'complete descriptor and v1 fields', expected: [], run: () => {
    const input = constPack; const authored = defineCatalogPack(input);
    const values = draftsFor(authored)([constDraft]);
    return [...packCodes(input), ...draftCodes(input, values[0])];
  } },
  { form: 'as const', name: 'all optional definition fields may be omitted', expected: [], run: () => {
    const input = { ...constPack, types: [{ key: "example:plain", version: 1, units: primary.units, netContentUnits: primary.netContentUnits, dimensions: [], validateContent: primary.validateContent }], subscriptionProfiles: undefined } as const;
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'as const', name: 'unknown pack field', expected: ['definition_unknown_field'], run: () => {
    const input = { ...constPack, bogus: true } as const;
    // @ts-expect-error unknown pack field.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'as const', name: 'pack id datatype', expected: ['definition_invalid_shape'], run: () => {
    const input = { ...constPack, id: 1 } as const;
    // @ts-expect-error pack id datatype.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'as const', name: 'pack version datatype', expected: ['definition_version_invalid'], run: () => {
    const input = { ...constPack, version: "1" } as const;
    // @ts-expect-error pack version datatype.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'as const', name: 'pack range datatype', expected: ['definition_invalid_shape'], run: () => {
    const input = { ...constPack, openlupRange: 44 } as const;
    // @ts-expect-error pack range datatype.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'as const', name: 'pack capability datatype', expected: ['definition_invalid_shape'], run: () => {
    const input = { ...constPack, capabilities: { publish: "false" } } as const;
    // @ts-expect-error pack capability datatype.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'as const', name: 'misspelled type field', expected: ['definition_unknown_field'], run: () => {
    const input = { ...constPack, types: constPack.types.map((type) => type.key === "example:item" ? { ...type, taxclass: "example:standard" } : type) } as const;
    // @ts-expect-error misspelled type field.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'as const', name: 'unknown factor field', expected: ['definition_unknown_field'], run: () => {
    const input = { ...constPack, types: constPack.types.map((type) => type.key === "example:item" ? { ...type, units: [{ ...primary.units[0], factor: { ...primary.units[0].factor, bogus: true } }], netContentUnits: ["openlup:piece"], dimensions: [], attributes: [], axes: [] } : type) } as const;
    // @ts-expect-error unknown factor field.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'as const', name: 'unit dimension grammar', expected: ['definition_unit_invalid'], run: () => {
    const input = { ...constPack, types: constPack.types.map((type) => type.key === "example:item" ? { ...type, units: [{ ...primary.units[0], dimension: "length" }], netContentUnits: ["openlup:piece"], dimensions: [], attributes: [], axes: [] } : type) } as const;
    // @ts-expect-error unit dimension grammar.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'as const', name: 'factor canonical unit grammar', expected: ['definition_unit_invalid'], run: () => {
    const input = { ...constPack, types: constPack.types.map((type) => type.key === "example:item" ? { ...type, units: [{ ...primary.units[0], factor: { ...primary.units[0].factor, canonicalUnit: "example:missing" } }], netContentUnits: ["openlup:piece"], dimensions: [], attributes: [], axes: [] } : type) } as const;
    // @ts-expect-error factor canonical unit grammar.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'as const', name: 'undeclared net content unit', expected: ['definition_unknown_net_content_unit'], run: () => {
    const input = { ...constPack, types: constPack.types.map((type) => type.key === "example:item" ? { ...type, netContentUnits: [...primary.netContentUnits, "example:missing"] } : type) } as const;
    // @ts-expect-error undeclared net content unit.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'as const', name: 'cross type unit reference', expected: ['definition_unknown_net_content_unit'], run: () => {
    const input = { ...constPack, types: constPack.types.map((type) => type.key === "example:item" ? { ...type, netContentUnits: [...primary.netContentUnits, "example:other"] } : type) } as const;
    // @ts-expect-error cross type unit reference.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'as const', name: 'undeclared list quantity unit', expected: ['definition_unknown_attribute_unit'], run: () => {
    const input = { ...constPack, types: constPack.types.map((type) => type.key === "example:item" ? { ...type, attributes: primary.attributes.map((attribute) => attribute.key === "list_quantity" ? { ...attribute, valueType: { ...attribute.valueType, item: { ...attribute.valueType.item, units: ["example:missing"] as const } } } : attribute) } : type) } as const;
    // @ts-expect-error undeclared list quantity unit.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'as const', name: 'undeclared attribute unit', expected: ['definition_unknown_attribute_unit'], run: () => {
    const input = { ...constPack, types: constPack.types.map((type) => type.key === "example:item" ? { ...type, attributes: primary.attributes.map((attribute) => attribute.key === "amount" ? { ...attribute, valueType: { ...attribute.valueType, units: ["example:missing"] as const } } : attribute) } : type) } as const;
    // @ts-expect-error undeclared attribute unit.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'as const', name: 'quantity axis dimension disagrees with unit', expected: ['definition_dimension_unit_mismatch'], run: () => {
    const input = { ...constPack, types: constPack.types.map((type) => type.key === "example:item" ? { ...type, dimensions: primary.dimensions.map((dimension) => dimension.kind === "quantity" ? { ...dimension, units: ["openlup:ml"] as const } : dimension) } : type) } as const;
    // @ts-expect-error quantity axis dimension disagrees with unit.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'as const', name: 'unknown attribute value kind', expected: ['definition_attribute_invalid'], run: () => {
    const input = { ...constPack, types: constPack.types.map((type) => type.key === "example:item" ? { ...type, attributes: [{ ...flags, key: "custom", valueType: { kind: "custom" } }], axes: [] } : type) } as const;
    // @ts-expect-error unknown attribute value kind.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'as const', name: 'undeclared axis attribute', expected: ['definition_unknown_axis_attribute'], run: () => {
    const input = { ...constPack, types: constPack.types.map((type) => type.key === "example:item" ? { ...type, axes: [{ key: "finish", attributeKey: "missing" }] } : type) } as const;
    // @ts-expect-error undeclared axis attribute.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'as const', name: 'undeclared axis dimension', expected: ['definition_unknown_axis_dimension'], run: () => {
    const input = { ...constPack, types: constPack.types.map((type) => type.key === "example:item" ? { ...type, axes: [{ key: "missing", attributeKey: "finish" }] } : type) } as const;
    // @ts-expect-error undeclared axis dimension.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'as const', name: 'undeclared default tax class', expected: ['definition_unknown_tax_class'], run: () => {
    const input = { ...constPack, types: constPack.types.map((type) => type.key === "example:item" ? { ...type, taxClass: "example:missing" } : type) } as const;
    // @ts-expect-error undeclared default tax class.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'as const', name: 'undeclared profile version', expected: ['definition_unknown_profile_ref'], run: () => {
    const input = { ...constPack, types: constPack.types.map((type) => type.key === "example:item" ? { ...type, subscriptionProfileRef: { key: "example:regular", version: 2 } } : type) } as const;
    // @ts-expect-error undeclared profile version.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'as const', name: 'wrong type namespace', expected: ['pack_type_namespace_mismatch'], run: () => {
    const input = { ...constPack, types: constPack.types.map((type) => type.key === "example:item" ? { ...type, key: "other:item" } : type) } as const;
    // @ts-expect-error wrong type namespace.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'as const', name: 'unknown product type', expected: ['type_not_installed'], run: () => {
    const input = { ...constDraft, product: { ...constDraft.product, type: { key: "example:missing", version: 1 } } } as const;
    // @ts-expect-error unknown product type.
    draftsFor(defineCatalogPack(constPack))([input]);
    return draftCodes(constPack, input);
  } },
  { form: 'as const', name: 'unknown product field', expected: ['unrecognized_keys'], run: () => {
    const input = { ...constDraft, product: { ...constDraft.product, bogus: true } } as const;
    // @ts-expect-error unknown product field.
    draftsFor(defineCatalogPack(constPack))([input]);
    return draftCodes(constPack, input);
  } },
  { form: 'as const', name: 'product identity datatype', expected: ['invalid_type'], run: () => {
    const input = { ...constDraft, product: { ...constDraft.product, id: 1 } } as const;
    // @ts-expect-error product identity datatype.
    draftsFor(defineCatalogPack(constPack))([input]);
    return draftCodes(constPack, input);
  } },
  { form: 'as const', name: 'unknown SKU field', expected: ['unrecognized_keys'], run: () => {
    const input = { ...constDraft, skus: [{ ...sku, bogus: true }] } as const;
    // @ts-expect-error unknown SKU field.
    draftsFor(defineCatalogPack(constPack))([input]);
    return draftCodes(constPack, input);
  } },
  { form: 'as const', name: 'SKU identity datatype', expected: ['invalid_type'], run: () => {
    const input = { ...constDraft, skus: [{ ...sku, id: 1 }] } as const;
    // @ts-expect-error SKU identity datatype.
    draftsFor(defineCatalogPack(constPack))([input]);
    return draftCodes(constPack, input);
  } },
  { form: 'as const', name: 'SKU code datatype', expected: ['invalid_type'], run: () => {
    const input = { ...constDraft, skus: [{ ...sku, code: 1 }] } as const;
    // @ts-expect-error SKU code datatype.
    draftsFor(defineCatalogPack(constPack))([input]);
    return draftCodes(constPack, input);
  } },
  { form: 'as const', name: 'undeclared option key', expected: ['dimension_not_declared'], run: () => {
    const input = { ...constDraft, skus: [{ ...sku, options: { ...sku.options, missing: { kind: "boolean", value: true } } }] } as const;
    // @ts-expect-error undeclared option key.
    draftsFor(defineCatalogPack(constPack))([input]);
    return draftCodes(constPack, input);
  } },
  { form: 'as const', name: 'quantity dimension disagrees with unit', expected: ['net_content_invalid', 'net_content_option_mismatch'], run: () => {
    const input = { ...constDraft, skus: [{ ...sku, netContent: { ...sku.netContent, dimension: "mass" } }] } as const;
    // @ts-expect-error quantity dimension disagrees with unit.
    draftsFor(defineCatalogPack(constPack))([input]);
    return draftCodes(constPack, input);
  } },
  { form: 'as const', name: 'undeclared SKU unit', expected: ['net_content_invalid', 'net_content_option_mismatch'], run: () => {
    const input = { ...constDraft, skus: [{ ...sku, netContent: { ...sku.netContent, unit: "example:other" } }] } as const;
    // @ts-expect-error undeclared SKU unit.
    draftsFor(defineCatalogPack(constPack))([input]);
    return draftCodes(constPack, input);
  } },
  { form: 'as const', name: 'quantity unscaled datatype', expected: ['invalid_type'], run: () => {
    const input = { ...constDraft, skus: [{ ...sku, netContent: { ...sku.netContent, unscaled: 1 } }] } as const;
    // @ts-expect-error quantity unscaled datatype.
    draftsFor(defineCatalogPack(constPack))([input]);
    return draftCodes(constPack, input);
  } },
  { form: 'as const', name: 'gross mass dimension', expected: ['gross_mass_invalid'], run: () => {
    const input = { ...constDraft, skus: [{ ...sku, grossMass: { ...sku.grossMass, dimension: "volume" } }] } as const;
    // @ts-expect-error gross mass dimension.
    draftsFor(defineCatalogPack(constPack))([input]);
    return draftCodes(constPack, input);
  } },
  { form: 'as const', name: 'identifier datatype', expected: ['invalid_type'], run: () => {
    const input = { ...constDraft, skus: [{ ...sku, identifiers: [{ ...sku.identifiers[0], issuer: 1 }] }] } as const;
    // @ts-expect-error identifier datatype.
    draftsFor(defineCatalogPack(constPack))([input]);
    return draftCodes(constPack, input);
  } },
  { form: 'as const', name: 'asset reference datatype', expected: ['invalid_type'], run: () => {
    const input = { ...constDraft, skus: [{ ...sku, assetRefs: [1] }] } as const;
    // @ts-expect-error asset reference datatype.
    draftsFor(defineCatalogPack(constPack))([input]);
    return draftCodes(constPack, input);
  } },
  { form: 'as const', name: 'widened pack evidence is static only', expected: [], run: () => {
    const input: CatalogPackInput = constPack;
    // @ts-expect-error widened pack evidence is static only.
    draftsFor(input);
    return packCodes(input);
  } },
  { form: 'as const', name: 'widened attribute keys are static only', expected: [], run: () => {
    const input = { ...constPack, types: constPack.types.map((type) => ({ ...type, attributes: type.attributes.map((attribute) => ({ ...attribute, key: String(attribute.key) })) })) };
    // @ts-expect-error widened attribute keys are static only.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'as const', name: 'widened namespace evidence is static only', expected: [], run: () => {
    const input = { ...constPack, namespace: String(constPack.namespace) };
    // @ts-expect-error widened namespace evidence is static only.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'as const', name: 'widened type version evidence is static only', expected: [], run: () => {
    const input = { ...constPack, types: constPack.types.map((type) => ({ ...type, version: Number(type.version) })) };
    // @ts-expect-error widened type version evidence is static only.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'as const', name: 'widened tax class evidence is static only', expected: [], run: () => {
    const input = { ...constPack, taxClasses: constPack.taxClasses.map((entry) => ({ ...entry, key: String(entry.key) })) };
    // @ts-expect-error widened tax class evidence is static only.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'readonly arrays', name: 'complete descriptor and v1 fields', expected: [], run: () => {
    const input = readonlyPack; const authored = defineCatalogPack(input);
    const values = draftsFor(authored)([readonlyDraft]);
    return [...packCodes(input), ...draftCodes(input, values[0])];
  } },
  { form: 'readonly arrays', name: 'all optional definition fields may be omitted', expected: [], run: () => {
    const input = { ...readonlyPack, types: [{ key: "example:plain", version: 1, units: primary.units, netContentUnits: primary.netContentUnits, dimensions: [], validateContent: primary.validateContent }], subscriptionProfiles: undefined } as const;
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'readonly arrays', name: 'unknown pack field', expected: ['definition_unknown_field'], run: () => {
    const input = { ...readonlyPack, bogus: true } as const;
    // @ts-expect-error unknown pack field.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'readonly arrays', name: 'pack id datatype', expected: ['definition_invalid_shape'], run: () => {
    const input = { ...readonlyPack, id: 1 } as const;
    // @ts-expect-error pack id datatype.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'readonly arrays', name: 'pack version datatype', expected: ['definition_version_invalid'], run: () => {
    const input = { ...readonlyPack, version: "1" } as const;
    // @ts-expect-error pack version datatype.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'readonly arrays', name: 'pack range datatype', expected: ['definition_invalid_shape'], run: () => {
    const input = { ...readonlyPack, openlupRange: 44 } as const;
    // @ts-expect-error pack range datatype.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'readonly arrays', name: 'pack capability datatype', expected: ['definition_invalid_shape'], run: () => {
    const input = { ...readonlyPack, capabilities: { publish: "false" } } as const;
    // @ts-expect-error pack capability datatype.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'readonly arrays', name: 'misspelled type field', expected: ['definition_unknown_field'], run: () => {
    const input = { ...readonlyPack, types: readonlyPack.types.map((type) => type.key === "example:item" ? { ...type, taxclass: "example:standard" } : type) } as const;
    // @ts-expect-error misspelled type field.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'readonly arrays', name: 'unknown factor field', expected: ['definition_unknown_field'], run: () => {
    const input = { ...readonlyPack, types: readonlyPack.types.map((type) => type.key === "example:item" ? { ...type, units: [{ ...primary.units[0], factor: { ...primary.units[0].factor, bogus: true } }], netContentUnits: ["openlup:piece"], dimensions: [], attributes: [], axes: [] } : type) } as const;
    // @ts-expect-error unknown factor field.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'readonly arrays', name: 'unit dimension grammar', expected: ['definition_unit_invalid'], run: () => {
    const input = { ...readonlyPack, types: readonlyPack.types.map((type) => type.key === "example:item" ? { ...type, units: [{ ...primary.units[0], dimension: "length" }], netContentUnits: ["openlup:piece"], dimensions: [], attributes: [], axes: [] } : type) } as const;
    // @ts-expect-error unit dimension grammar.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'readonly arrays', name: 'factor canonical unit grammar', expected: ['definition_unit_invalid'], run: () => {
    const input = { ...readonlyPack, types: readonlyPack.types.map((type) => type.key === "example:item" ? { ...type, units: [{ ...primary.units[0], factor: { ...primary.units[0].factor, canonicalUnit: "example:missing" } }], netContentUnits: ["openlup:piece"], dimensions: [], attributes: [], axes: [] } : type) } as const;
    // @ts-expect-error factor canonical unit grammar.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'readonly arrays', name: 'undeclared net content unit', expected: ['definition_unknown_net_content_unit'], run: () => {
    const input = { ...readonlyPack, types: readonlyPack.types.map((type) => type.key === "example:item" ? { ...type, netContentUnits: [...primary.netContentUnits, "example:missing"] } : type) } as const;
    // @ts-expect-error undeclared net content unit.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'readonly arrays', name: 'cross type unit reference', expected: ['definition_unknown_net_content_unit'], run: () => {
    const input = { ...readonlyPack, types: readonlyPack.types.map((type) => type.key === "example:item" ? { ...type, netContentUnits: [...primary.netContentUnits, "example:other"] } : type) } as const;
    // @ts-expect-error cross type unit reference.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'readonly arrays', name: 'undeclared list quantity unit', expected: ['definition_unknown_attribute_unit'], run: () => {
    const input = { ...readonlyPack, types: readonlyPack.types.map((type) => type.key === "example:item" ? { ...type, attributes: primary.attributes.map((attribute) => attribute.key === "list_quantity" ? { ...attribute, valueType: { ...attribute.valueType, item: { ...attribute.valueType.item, units: ["example:missing"] as const } } } : attribute) } : type) } as const;
    // @ts-expect-error undeclared list quantity unit.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'readonly arrays', name: 'undeclared attribute unit', expected: ['definition_unknown_attribute_unit'], run: () => {
    const input = { ...readonlyPack, types: readonlyPack.types.map((type) => type.key === "example:item" ? { ...type, attributes: primary.attributes.map((attribute) => attribute.key === "amount" ? { ...attribute, valueType: { ...attribute.valueType, units: ["example:missing"] as const } } : attribute) } : type) } as const;
    // @ts-expect-error undeclared attribute unit.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'readonly arrays', name: 'quantity axis dimension disagrees with unit', expected: ['definition_dimension_unit_mismatch'], run: () => {
    const input = { ...readonlyPack, types: readonlyPack.types.map((type) => type.key === "example:item" ? { ...type, dimensions: primary.dimensions.map((dimension) => dimension.kind === "quantity" ? { ...dimension, units: ["openlup:ml"] as const } : dimension) } : type) } as const;
    // @ts-expect-error quantity axis dimension disagrees with unit.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'readonly arrays', name: 'unknown attribute value kind', expected: ['definition_attribute_invalid'], run: () => {
    const input = { ...readonlyPack, types: readonlyPack.types.map((type) => type.key === "example:item" ? { ...type, attributes: [{ ...flags, key: "custom", valueType: { kind: "custom" } }], axes: [] } : type) } as const;
    // @ts-expect-error unknown attribute value kind.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'readonly arrays', name: 'undeclared axis attribute', expected: ['definition_unknown_axis_attribute'], run: () => {
    const input = { ...readonlyPack, types: readonlyPack.types.map((type) => type.key === "example:item" ? { ...type, axes: [{ key: "finish", attributeKey: "missing" }] } : type) } as const;
    // @ts-expect-error undeclared axis attribute.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'readonly arrays', name: 'undeclared axis dimension', expected: ['definition_unknown_axis_dimension'], run: () => {
    const input = { ...readonlyPack, types: readonlyPack.types.map((type) => type.key === "example:item" ? { ...type, axes: [{ key: "missing", attributeKey: "finish" }] } : type) } as const;
    // @ts-expect-error undeclared axis dimension.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'readonly arrays', name: 'undeclared default tax class', expected: ['definition_unknown_tax_class'], run: () => {
    const input = { ...readonlyPack, types: readonlyPack.types.map((type) => type.key === "example:item" ? { ...type, taxClass: "example:missing" } : type) } as const;
    // @ts-expect-error undeclared default tax class.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'readonly arrays', name: 'undeclared profile version', expected: ['definition_unknown_profile_ref'], run: () => {
    const input = { ...readonlyPack, types: readonlyPack.types.map((type) => type.key === "example:item" ? { ...type, subscriptionProfileRef: { key: "example:regular", version: 2 } } : type) } as const;
    // @ts-expect-error undeclared profile version.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'readonly arrays', name: 'wrong type namespace', expected: ['pack_type_namespace_mismatch'], run: () => {
    const input = { ...readonlyPack, types: readonlyPack.types.map((type) => type.key === "example:item" ? { ...type, key: "other:item" } : type) } as const;
    // @ts-expect-error wrong type namespace.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'readonly arrays', name: 'unknown product type', expected: ['type_not_installed'], run: () => {
    const input = { ...readonlyDraft, product: { ...readonlyDraft.product, type: { key: "example:missing", version: 1 } } } as const;
    // @ts-expect-error unknown product type.
    draftsFor(defineCatalogPack(readonlyPack))([input]);
    return draftCodes(readonlyPack, input);
  } },
  { form: 'readonly arrays', name: 'unknown product field', expected: ['unrecognized_keys'], run: () => {
    const input = { ...readonlyDraft, product: { ...readonlyDraft.product, bogus: true } } as const;
    // @ts-expect-error unknown product field.
    draftsFor(defineCatalogPack(readonlyPack))([input]);
    return draftCodes(readonlyPack, input);
  } },
  { form: 'readonly arrays', name: 'product identity datatype', expected: ['invalid_type'], run: () => {
    const input = { ...readonlyDraft, product: { ...readonlyDraft.product, id: 1 } } as const;
    // @ts-expect-error product identity datatype.
    draftsFor(defineCatalogPack(readonlyPack))([input]);
    return draftCodes(readonlyPack, input);
  } },
  { form: 'readonly arrays', name: 'unknown SKU field', expected: ['unrecognized_keys'], run: () => {
    const input = { ...readonlyDraft, skus: [{ ...sku, bogus: true }] } as const;
    // @ts-expect-error unknown SKU field.
    draftsFor(defineCatalogPack(readonlyPack))([input]);
    return draftCodes(readonlyPack, input);
  } },
  { form: 'readonly arrays', name: 'SKU identity datatype', expected: ['invalid_type'], run: () => {
    const input = { ...readonlyDraft, skus: [{ ...sku, id: 1 }] } as const;
    // @ts-expect-error SKU identity datatype.
    draftsFor(defineCatalogPack(readonlyPack))([input]);
    return draftCodes(readonlyPack, input);
  } },
  { form: 'readonly arrays', name: 'SKU code datatype', expected: ['invalid_type'], run: () => {
    const input = { ...readonlyDraft, skus: [{ ...sku, code: 1 }] } as const;
    // @ts-expect-error SKU code datatype.
    draftsFor(defineCatalogPack(readonlyPack))([input]);
    return draftCodes(readonlyPack, input);
  } },
  { form: 'readonly arrays', name: 'undeclared option key', expected: ['dimension_not_declared'], run: () => {
    const input = { ...readonlyDraft, skus: [{ ...sku, options: { ...sku.options, missing: { kind: "boolean", value: true } } }] } as const;
    // @ts-expect-error undeclared option key.
    draftsFor(defineCatalogPack(readonlyPack))([input]);
    return draftCodes(readonlyPack, input);
  } },
  { form: 'readonly arrays', name: 'quantity dimension disagrees with unit', expected: ['net_content_invalid', 'net_content_option_mismatch'], run: () => {
    const input = { ...readonlyDraft, skus: [{ ...sku, netContent: { ...sku.netContent, dimension: "mass" } }] } as const;
    // @ts-expect-error quantity dimension disagrees with unit.
    draftsFor(defineCatalogPack(readonlyPack))([input]);
    return draftCodes(readonlyPack, input);
  } },
  { form: 'readonly arrays', name: 'undeclared SKU unit', expected: ['net_content_invalid', 'net_content_option_mismatch'], run: () => {
    const input = { ...readonlyDraft, skus: [{ ...sku, netContent: { ...sku.netContent, unit: "example:other" } }] } as const;
    // @ts-expect-error undeclared SKU unit.
    draftsFor(defineCatalogPack(readonlyPack))([input]);
    return draftCodes(readonlyPack, input);
  } },
  { form: 'readonly arrays', name: 'quantity unscaled datatype', expected: ['invalid_type'], run: () => {
    const input = { ...readonlyDraft, skus: [{ ...sku, netContent: { ...sku.netContent, unscaled: 1 } }] } as const;
    // @ts-expect-error quantity unscaled datatype.
    draftsFor(defineCatalogPack(readonlyPack))([input]);
    return draftCodes(readonlyPack, input);
  } },
  { form: 'readonly arrays', name: 'gross mass dimension', expected: ['gross_mass_invalid'], run: () => {
    const input = { ...readonlyDraft, skus: [{ ...sku, grossMass: { ...sku.grossMass, dimension: "volume" } }] } as const;
    // @ts-expect-error gross mass dimension.
    draftsFor(defineCatalogPack(readonlyPack))([input]);
    return draftCodes(readonlyPack, input);
  } },
  { form: 'readonly arrays', name: 'identifier datatype', expected: ['invalid_type'], run: () => {
    const input = { ...readonlyDraft, skus: [{ ...sku, identifiers: [{ ...sku.identifiers[0], issuer: 1 }] }] } as const;
    // @ts-expect-error identifier datatype.
    draftsFor(defineCatalogPack(readonlyPack))([input]);
    return draftCodes(readonlyPack, input);
  } },
  { form: 'readonly arrays', name: 'asset reference datatype', expected: ['invalid_type'], run: () => {
    const input = { ...readonlyDraft, skus: [{ ...sku, assetRefs: [1] }] } as const;
    // @ts-expect-error asset reference datatype.
    draftsFor(defineCatalogPack(readonlyPack))([input]);
    return draftCodes(readonlyPack, input);
  } },
  { form: 'readonly arrays', name: 'widened pack evidence is static only', expected: [], run: () => {
    const input: CatalogPackInput = readonlyPack;
    // @ts-expect-error widened pack evidence is static only.
    draftsFor(input);
    return packCodes(input);
  } },
  { form: 'readonly arrays', name: 'widened attribute keys are static only', expected: [], run: () => {
    const input = { ...readonlyPack, types: readonlyPack.types.map((type) => ({ ...type, attributes: type.attributes.map((attribute) => ({ ...attribute, key: String(attribute.key) })) })) };
    // @ts-expect-error widened attribute keys are static only.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'readonly arrays', name: 'widened namespace evidence is static only', expected: [], run: () => {
    const input = { ...readonlyPack, namespace: String(readonlyPack.namespace) };
    // @ts-expect-error widened namespace evidence is static only.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'readonly arrays', name: 'widened type version evidence is static only', expected: [], run: () => {
    const input = { ...readonlyPack, types: readonlyPack.types.map((type) => ({ ...type, version: Number(type.version) })) };
    // @ts-expect-error widened type version evidence is static only.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'readonly arrays', name: 'widened tax class evidence is static only', expected: [], run: () => {
    const input = { ...readonlyPack, taxClasses: readonlyPack.taxClasses.map((entry) => ({ ...entry, key: String(entry.key) })) };
    // @ts-expect-error widened tax class evidence is static only.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'mutable arrays', name: 'complete descriptor and v1 fields', expected: [], run: () => {
    const input = mutablePack; const authored = defineCatalogPack(input);
    const values = draftsFor(authored)([mutableDraft]);
    return [...packCodes(input), ...draftCodes(input, values[0])];
  } },
  { form: 'mutable arrays', name: 'all optional definition fields may be omitted', expected: [], run: () => {
    const input = { ...mutablePack, types: [{ key: "example:plain", version: 1, units: primary.units, netContentUnits: primary.netContentUnits, dimensions: [], validateContent: primary.validateContent }], subscriptionProfiles: undefined } as const;
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'mutable arrays', name: 'unknown pack field', expected: ['definition_unknown_field'], run: () => {
    const input = { ...mutablePack, bogus: true } as const;
    // @ts-expect-error unknown pack field.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'mutable arrays', name: 'pack id datatype', expected: ['definition_invalid_shape'], run: () => {
    const input = { ...mutablePack, id: 1 } as const;
    // @ts-expect-error pack id datatype.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'mutable arrays', name: 'pack version datatype', expected: ['definition_version_invalid'], run: () => {
    const input = { ...mutablePack, version: "1" } as const;
    // @ts-expect-error pack version datatype.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'mutable arrays', name: 'pack range datatype', expected: ['definition_invalid_shape'], run: () => {
    const input = { ...mutablePack, openlupRange: 44 } as const;
    // @ts-expect-error pack range datatype.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'mutable arrays', name: 'pack capability datatype', expected: ['definition_invalid_shape'], run: () => {
    const input = { ...mutablePack, capabilities: { publish: "false" } } as const;
    // @ts-expect-error pack capability datatype.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'mutable arrays', name: 'misspelled type field', expected: ['definition_unknown_field'], run: () => {
    const input = { ...mutablePack, types: mutablePack.types.map((type) => type.key === "example:item" ? { ...type, taxclass: "example:standard" } : type) } as const;
    // @ts-expect-error misspelled type field.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'mutable arrays', name: 'unknown factor field', expected: ['definition_unknown_field'], run: () => {
    const input = { ...mutablePack, types: mutablePack.types.map((type) => type.key === "example:item" ? { ...type, units: [{ ...primary.units[0], factor: { ...primary.units[0].factor, bogus: true } }], netContentUnits: ["openlup:piece"], dimensions: [], attributes: [], axes: [] } : type) } as const;
    // @ts-expect-error unknown factor field.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'mutable arrays', name: 'unit dimension grammar', expected: ['definition_unit_invalid'], run: () => {
    const input = { ...mutablePack, types: mutablePack.types.map((type) => type.key === "example:item" ? { ...type, units: [{ ...primary.units[0], dimension: "length" }], netContentUnits: ["openlup:piece"], dimensions: [], attributes: [], axes: [] } : type) } as const;
    // @ts-expect-error unit dimension grammar.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'mutable arrays', name: 'factor canonical unit grammar', expected: ['definition_unit_invalid'], run: () => {
    const input = { ...mutablePack, types: mutablePack.types.map((type) => type.key === "example:item" ? { ...type, units: [{ ...primary.units[0], factor: { ...primary.units[0].factor, canonicalUnit: "example:missing" } }], netContentUnits: ["openlup:piece"], dimensions: [], attributes: [], axes: [] } : type) } as const;
    // @ts-expect-error factor canonical unit grammar.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'mutable arrays', name: 'undeclared net content unit', expected: ['definition_unknown_net_content_unit'], run: () => {
    const input = { ...mutablePack, types: mutablePack.types.map((type) => type.key === "example:item" ? { ...type, netContentUnits: [...primary.netContentUnits, "example:missing"] } : type) } as const;
    // @ts-expect-error undeclared net content unit.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'mutable arrays', name: 'cross type unit reference', expected: ['definition_unknown_net_content_unit'], run: () => {
    const input = { ...mutablePack, types: mutablePack.types.map((type) => type.key === "example:item" ? { ...type, netContentUnits: [...primary.netContentUnits, "example:other"] } : type) } as const;
    // @ts-expect-error cross type unit reference.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'mutable arrays', name: 'undeclared list quantity unit', expected: ['definition_unknown_attribute_unit'], run: () => {
    const input = { ...mutablePack, types: mutablePack.types.map((type) => type.key === "example:item" ? { ...type, attributes: primary.attributes.map((attribute) => attribute.key === "list_quantity" ? { ...attribute, valueType: { ...attribute.valueType, item: { ...attribute.valueType.item, units: ["example:missing"] as const } } } : attribute) } : type) } as const;
    // @ts-expect-error undeclared list quantity unit.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'mutable arrays', name: 'undeclared attribute unit', expected: ['definition_unknown_attribute_unit'], run: () => {
    const input = { ...mutablePack, types: mutablePack.types.map((type) => type.key === "example:item" ? { ...type, attributes: primary.attributes.map((attribute) => attribute.key === "amount" ? { ...attribute, valueType: { ...attribute.valueType, units: ["example:missing"] as const } } : attribute) } : type) } as const;
    // @ts-expect-error undeclared attribute unit.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'mutable arrays', name: 'quantity axis dimension disagrees with unit', expected: ['definition_dimension_unit_mismatch'], run: () => {
    const input = { ...mutablePack, types: mutablePack.types.map((type) => type.key === "example:item" ? { ...type, dimensions: primary.dimensions.map((dimension) => dimension.kind === "quantity" ? { ...dimension, units: ["openlup:ml"] as const } : dimension) } : type) } as const;
    // @ts-expect-error quantity axis dimension disagrees with unit.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'mutable arrays', name: 'unknown attribute value kind', expected: ['definition_attribute_invalid'], run: () => {
    const input = { ...mutablePack, types: mutablePack.types.map((type) => type.key === "example:item" ? { ...type, attributes: [{ ...flags, key: "custom", valueType: { kind: "custom" } }], axes: [] } : type) } as const;
    // @ts-expect-error unknown attribute value kind.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'mutable arrays', name: 'undeclared axis attribute', expected: ['definition_unknown_axis_attribute'], run: () => {
    const input = { ...mutablePack, types: mutablePack.types.map((type) => type.key === "example:item" ? { ...type, axes: [{ key: "finish", attributeKey: "missing" }] } : type) } as const;
    // @ts-expect-error undeclared axis attribute.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'mutable arrays', name: 'undeclared axis dimension', expected: ['definition_unknown_axis_dimension'], run: () => {
    const input = { ...mutablePack, types: mutablePack.types.map((type) => type.key === "example:item" ? { ...type, axes: [{ key: "missing", attributeKey: "finish" }] } : type) } as const;
    // @ts-expect-error undeclared axis dimension.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'mutable arrays', name: 'undeclared default tax class', expected: ['definition_unknown_tax_class'], run: () => {
    const input = { ...mutablePack, types: mutablePack.types.map((type) => type.key === "example:item" ? { ...type, taxClass: "example:missing" } : type) } as const;
    // @ts-expect-error undeclared default tax class.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'mutable arrays', name: 'undeclared profile version', expected: ['definition_unknown_profile_ref'], run: () => {
    const input = { ...mutablePack, types: mutablePack.types.map((type) => type.key === "example:item" ? { ...type, subscriptionProfileRef: { key: "example:regular", version: 2 } } : type) } as const;
    // @ts-expect-error undeclared profile version.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'mutable arrays', name: 'wrong type namespace', expected: ['pack_type_namespace_mismatch'], run: () => {
    const input = { ...mutablePack, types: mutablePack.types.map((type) => type.key === "example:item" ? { ...type, key: "other:item" } : type) } as const;
    // @ts-expect-error wrong type namespace.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'mutable arrays', name: 'unknown product type', expected: ['type_not_installed'], run: () => {
    const input = { ...mutableDraft, product: { ...mutableDraft.product, type: { key: "example:missing", version: 1 } } } as const;
    // @ts-expect-error unknown product type.
    draftsFor(defineCatalogPack(mutablePack))([input]);
    return draftCodes(mutablePack, input);
  } },
  { form: 'mutable arrays', name: 'unknown product field', expected: ['unrecognized_keys'], run: () => {
    const input = { ...mutableDraft, product: { ...mutableDraft.product, bogus: true } } as const;
    // @ts-expect-error unknown product field.
    draftsFor(defineCatalogPack(mutablePack))([input]);
    return draftCodes(mutablePack, input);
  } },
  { form: 'mutable arrays', name: 'product identity datatype', expected: ['invalid_type'], run: () => {
    const input = { ...mutableDraft, product: { ...mutableDraft.product, id: 1 } } as const;
    // @ts-expect-error product identity datatype.
    draftsFor(defineCatalogPack(mutablePack))([input]);
    return draftCodes(mutablePack, input);
  } },
  { form: 'mutable arrays', name: 'unknown SKU field', expected: ['unrecognized_keys'], run: () => {
    const input = { ...mutableDraft, skus: [{ ...sku, bogus: true }] } as const;
    // @ts-expect-error unknown SKU field.
    draftsFor(defineCatalogPack(mutablePack))([input]);
    return draftCodes(mutablePack, input);
  } },
  { form: 'mutable arrays', name: 'SKU identity datatype', expected: ['invalid_type'], run: () => {
    const input = { ...mutableDraft, skus: [{ ...sku, id: 1 }] } as const;
    // @ts-expect-error SKU identity datatype.
    draftsFor(defineCatalogPack(mutablePack))([input]);
    return draftCodes(mutablePack, input);
  } },
  { form: 'mutable arrays', name: 'SKU code datatype', expected: ['invalid_type'], run: () => {
    const input = { ...mutableDraft, skus: [{ ...sku, code: 1 }] } as const;
    // @ts-expect-error SKU code datatype.
    draftsFor(defineCatalogPack(mutablePack))([input]);
    return draftCodes(mutablePack, input);
  } },
  { form: 'mutable arrays', name: 'undeclared option key', expected: ['dimension_not_declared'], run: () => {
    const input = { ...mutableDraft, skus: [{ ...sku, options: { ...sku.options, missing: { kind: "boolean", value: true } } }] } as const;
    // @ts-expect-error undeclared option key.
    draftsFor(defineCatalogPack(mutablePack))([input]);
    return draftCodes(mutablePack, input);
  } },
  { form: 'mutable arrays', name: 'quantity dimension disagrees with unit', expected: ['net_content_invalid', 'net_content_option_mismatch'], run: () => {
    const input = { ...mutableDraft, skus: [{ ...sku, netContent: { ...sku.netContent, dimension: "mass" } }] } as const;
    // @ts-expect-error quantity dimension disagrees with unit.
    draftsFor(defineCatalogPack(mutablePack))([input]);
    return draftCodes(mutablePack, input);
  } },
  { form: 'mutable arrays', name: 'undeclared SKU unit', expected: ['net_content_invalid', 'net_content_option_mismatch'], run: () => {
    const input = { ...mutableDraft, skus: [{ ...sku, netContent: { ...sku.netContent, unit: "example:other" } }] } as const;
    // @ts-expect-error undeclared SKU unit.
    draftsFor(defineCatalogPack(mutablePack))([input]);
    return draftCodes(mutablePack, input);
  } },
  { form: 'mutable arrays', name: 'quantity unscaled datatype', expected: ['invalid_type'], run: () => {
    const input = { ...mutableDraft, skus: [{ ...sku, netContent: { ...sku.netContent, unscaled: 1 } }] } as const;
    // @ts-expect-error quantity unscaled datatype.
    draftsFor(defineCatalogPack(mutablePack))([input]);
    return draftCodes(mutablePack, input);
  } },
  { form: 'mutable arrays', name: 'gross mass dimension', expected: ['gross_mass_invalid'], run: () => {
    const input = { ...mutableDraft, skus: [{ ...sku, grossMass: { ...sku.grossMass, dimension: "volume" } }] } as const;
    // @ts-expect-error gross mass dimension.
    draftsFor(defineCatalogPack(mutablePack))([input]);
    return draftCodes(mutablePack, input);
  } },
  { form: 'mutable arrays', name: 'identifier datatype', expected: ['invalid_type'], run: () => {
    const input = { ...mutableDraft, skus: [{ ...sku, identifiers: [{ ...sku.identifiers[0], issuer: 1 }] }] } as const;
    // @ts-expect-error identifier datatype.
    draftsFor(defineCatalogPack(mutablePack))([input]);
    return draftCodes(mutablePack, input);
  } },
  { form: 'mutable arrays', name: 'asset reference datatype', expected: ['invalid_type'], run: () => {
    const input = { ...mutableDraft, skus: [{ ...sku, assetRefs: [1] }] } as const;
    // @ts-expect-error asset reference datatype.
    draftsFor(defineCatalogPack(mutablePack))([input]);
    return draftCodes(mutablePack, input);
  } },
  { form: 'mutable arrays', name: 'widened pack evidence is static only', expected: [], run: () => {
    const input: CatalogPackInput = mutablePack;
    // @ts-expect-error widened pack evidence is static only.
    draftsFor(input);
    return packCodes(input);
  } },
  { form: 'mutable arrays', name: 'widened attribute keys are static only', expected: [], run: () => {
    const input = { ...mutablePack, types: mutablePack.types.map((type) => ({ ...type, attributes: type.attributes.map((attribute) => ({ ...attribute, key: String(attribute.key) })) })) };
    // @ts-expect-error widened attribute keys are static only.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'mutable arrays', name: 'widened namespace evidence is static only', expected: [], run: () => {
    const input = { ...mutablePack, namespace: String(mutablePack.namespace) };
    // @ts-expect-error widened namespace evidence is static only.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'mutable arrays', name: 'widened type version evidence is static only', expected: [], run: () => {
    const input = { ...mutablePack, types: mutablePack.types.map((type) => ({ ...type, version: Number(type.version) })) };
    // @ts-expect-error widened type version evidence is static only.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'mutable arrays', name: 'widened tax class evidence is static only', expected: [], run: () => {
    const input = { ...mutablePack, taxClasses: mutablePack.taxClasses.map((entry) => ({ ...entry, key: String(entry.key) })) };
    // @ts-expect-error widened tax class evidence is static only.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'optional fields omitted', name: 'complete descriptor and v1 fields', expected: [], run: () => {
    const input = omittedPack; const authored = defineCatalogPack(input);
    const values = draftsFor(authored)([omittedDraft]);
    return [...packCodes(input), ...draftCodes(input, values[0])];
  } },
  { form: 'optional fields omitted', name: 'all optional definition fields may be omitted', expected: [], run: () => {
    const input = { ...omittedPack, types: [{ key: "example:plain", version: 1, units: primary.units, netContentUnits: primary.netContentUnits, dimensions: [], validateContent: primary.validateContent }], subscriptionProfiles: undefined } as const;
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'optional fields omitted', name: 'unknown pack field', expected: ['definition_unknown_field'], run: () => {
    const input = { ...omittedPack, bogus: true } as const;
    // @ts-expect-error unknown pack field.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'optional fields omitted', name: 'pack id datatype', expected: ['definition_invalid_shape'], run: () => {
    const input = { ...omittedPack, id: 1 } as const;
    // @ts-expect-error pack id datatype.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'optional fields omitted', name: 'pack version datatype', expected: ['definition_version_invalid'], run: () => {
    const input = { ...omittedPack, version: "1" } as const;
    // @ts-expect-error pack version datatype.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'optional fields omitted', name: 'pack range datatype', expected: ['definition_invalid_shape'], run: () => {
    const input = { ...omittedPack, openlupRange: 44 } as const;
    // @ts-expect-error pack range datatype.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'optional fields omitted', name: 'pack capability datatype', expected: ['definition_invalid_shape'], run: () => {
    const input = { ...omittedPack, capabilities: { publish: "false" } } as const;
    // @ts-expect-error pack capability datatype.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'optional fields omitted', name: 'misspelled type field', expected: ['definition_unknown_field'], run: () => {
    const input = { ...omittedPack, types: omittedPack.types.map((type) => type.key === "example:item" ? { ...type, taxclass: "example:standard" } : type) } as const;
    // @ts-expect-error misspelled type field.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'optional fields omitted', name: 'unknown factor field', expected: ['definition_unknown_field'], run: () => {
    const input = { ...omittedPack, types: omittedPack.types.map((type) => type.key === "example:item" ? { ...type, units: [{ ...primary.units[0], factor: { ...primary.units[0].factor, bogus: true } }], netContentUnits: ["openlup:piece"], dimensions: [], attributes: [], axes: [] } : type) } as const;
    // @ts-expect-error unknown factor field.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'optional fields omitted', name: 'unit dimension grammar', expected: ['definition_unit_invalid'], run: () => {
    const input = { ...omittedPack, types: omittedPack.types.map((type) => type.key === "example:item" ? { ...type, units: [{ ...primary.units[0], dimension: "length" }], netContentUnits: ["openlup:piece"], dimensions: [], attributes: [], axes: [] } : type) } as const;
    // @ts-expect-error unit dimension grammar.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'optional fields omitted', name: 'factor canonical unit grammar', expected: ['definition_unit_invalid'], run: () => {
    const input = { ...omittedPack, types: omittedPack.types.map((type) => type.key === "example:item" ? { ...type, units: [{ ...primary.units[0], factor: { ...primary.units[0].factor, canonicalUnit: "example:missing" } }], netContentUnits: ["openlup:piece"], dimensions: [], attributes: [], axes: [] } : type) } as const;
    // @ts-expect-error factor canonical unit grammar.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'optional fields omitted', name: 'undeclared net content unit', expected: ['definition_unknown_net_content_unit'], run: () => {
    const input = { ...omittedPack, types: omittedPack.types.map((type) => type.key === "example:item" ? { ...type, netContentUnits: [...primary.netContentUnits, "example:missing"] } : type) } as const;
    // @ts-expect-error undeclared net content unit.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'optional fields omitted', name: 'cross type unit reference', expected: ['definition_unknown_net_content_unit'], run: () => {
    const input = { ...omittedPack, types: omittedPack.types.map((type) => type.key === "example:item" ? { ...type, netContentUnits: [...primary.netContentUnits, "example:other"] } : type) } as const;
    // @ts-expect-error cross type unit reference.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'optional fields omitted', name: 'undeclared list quantity unit', expected: ['definition_unknown_attribute_unit'], run: () => {
    const input = { ...omittedPack, types: omittedPack.types.map((type) => type.key === "example:item" ? { ...type, attributes: primary.attributes.map((attribute) => attribute.key === "list_quantity" ? { ...attribute, valueType: { ...attribute.valueType, item: { ...attribute.valueType.item, units: ["example:missing"] as const } } } : attribute) } : type) } as const;
    // @ts-expect-error undeclared list quantity unit.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'optional fields omitted', name: 'undeclared attribute unit', expected: ['definition_unknown_attribute_unit'], run: () => {
    const input = { ...omittedPack, types: omittedPack.types.map((type) => type.key === "example:item" ? { ...type, attributes: primary.attributes.map((attribute) => attribute.key === "amount" ? { ...attribute, valueType: { ...attribute.valueType, units: ["example:missing"] as const } } : attribute) } : type) } as const;
    // @ts-expect-error undeclared attribute unit.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'optional fields omitted', name: 'quantity axis dimension disagrees with unit', expected: ['definition_dimension_unit_mismatch'], run: () => {
    const input = { ...omittedPack, types: omittedPack.types.map((type) => type.key === "example:item" ? { ...type, dimensions: primary.dimensions.map((dimension) => dimension.kind === "quantity" ? { ...dimension, units: ["openlup:ml"] as const } : dimension) } : type) } as const;
    // @ts-expect-error quantity axis dimension disagrees with unit.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'optional fields omitted', name: 'unknown attribute value kind', expected: ['definition_attribute_invalid'], run: () => {
    const input = { ...omittedPack, types: omittedPack.types.map((type) => type.key === "example:item" ? { ...type, attributes: [{ ...flags, key: "custom", valueType: { kind: "custom" } }], axes: [] } : type) } as const;
    // @ts-expect-error unknown attribute value kind.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'optional fields omitted', name: 'undeclared axis attribute', expected: ['definition_unknown_axis_attribute'], run: () => {
    const input = { ...omittedPack, types: omittedPack.types.map((type) => type.key === "example:item" ? { ...type, axes: [{ key: "finish", attributeKey: "missing" }] } : type) } as const;
    // @ts-expect-error undeclared axis attribute.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'optional fields omitted', name: 'undeclared axis dimension', expected: ['definition_unknown_axis_dimension'], run: () => {
    const input = { ...omittedPack, types: omittedPack.types.map((type) => type.key === "example:item" ? { ...type, axes: [{ key: "missing", attributeKey: "finish" }] } : type) } as const;
    // @ts-expect-error undeclared axis dimension.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'optional fields omitted', name: 'undeclared default tax class', expected: ['definition_unknown_tax_class'], run: () => {
    const input = { ...omittedPack, types: omittedPack.types.map((type) => type.key === "example:item" ? { ...type, taxClass: "example:missing" } : type) } as const;
    // @ts-expect-error undeclared default tax class.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'optional fields omitted', name: 'undeclared profile version', expected: ['definition_unknown_profile_ref'], run: () => {
    const input = { ...omittedPack, types: omittedPack.types.map((type) => type.key === "example:item" ? { ...type, subscriptionProfileRef: { key: "example:regular", version: 2 } } : type) } as const;
    // @ts-expect-error undeclared profile version.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'optional fields omitted', name: 'wrong type namespace', expected: ['pack_type_namespace_mismatch'], run: () => {
    const input = { ...omittedPack, types: omittedPack.types.map((type) => type.key === "example:item" ? { ...type, key: "other:item" } : type) } as const;
    // @ts-expect-error wrong type namespace.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'optional fields omitted', name: 'unknown product type', expected: ['type_not_installed'], run: () => {
    const input = { ...omittedDraft, product: { ...omittedDraft.product, type: { key: "example:missing", version: 1 } } } as const;
    // @ts-expect-error unknown product type.
    draftsFor(defineCatalogPack(omittedPack))([input]);
    return draftCodes(omittedPack, input);
  } },
  { form: 'optional fields omitted', name: 'unknown product field', expected: ['unrecognized_keys'], run: () => {
    const input = { ...omittedDraft, product: { ...omittedDraft.product, bogus: true } } as const;
    // @ts-expect-error unknown product field.
    draftsFor(defineCatalogPack(omittedPack))([input]);
    return draftCodes(omittedPack, input);
  } },
  { form: 'optional fields omitted', name: 'product identity datatype', expected: ['invalid_type'], run: () => {
    const input = { ...omittedDraft, product: { ...omittedDraft.product, id: 1 } } as const;
    // @ts-expect-error product identity datatype.
    draftsFor(defineCatalogPack(omittedPack))([input]);
    return draftCodes(omittedPack, input);
  } },
  { form: 'optional fields omitted', name: 'unknown SKU field', expected: ['unrecognized_keys'], run: () => {
    const input = { ...omittedDraft, skus: [{ ...sku, bogus: true }] } as const;
    // @ts-expect-error unknown SKU field.
    draftsFor(defineCatalogPack(omittedPack))([input]);
    return draftCodes(omittedPack, input);
  } },
  { form: 'optional fields omitted', name: 'SKU identity datatype', expected: ['invalid_type'], run: () => {
    const input = { ...omittedDraft, skus: [{ ...sku, id: 1 }] } as const;
    // @ts-expect-error SKU identity datatype.
    draftsFor(defineCatalogPack(omittedPack))([input]);
    return draftCodes(omittedPack, input);
  } },
  { form: 'optional fields omitted', name: 'SKU code datatype', expected: ['invalid_type'], run: () => {
    const input = { ...omittedDraft, skus: [{ ...sku, code: 1 }] } as const;
    // @ts-expect-error SKU code datatype.
    draftsFor(defineCatalogPack(omittedPack))([input]);
    return draftCodes(omittedPack, input);
  } },
  { form: 'optional fields omitted', name: 'undeclared option key', expected: ['dimension_not_declared'], run: () => {
    const input = { ...omittedDraft, skus: [{ ...sku, options: { ...sku.options, missing: { kind: "boolean", value: true } } }] } as const;
    // @ts-expect-error undeclared option key.
    draftsFor(defineCatalogPack(omittedPack))([input]);
    return draftCodes(omittedPack, input);
  } },
  { form: 'optional fields omitted', name: 'quantity dimension disagrees with unit', expected: ['net_content_invalid', 'net_content_option_mismatch'], run: () => {
    const input = { ...omittedDraft, skus: [{ ...sku, netContent: { ...sku.netContent, dimension: "mass" } }] } as const;
    // @ts-expect-error quantity dimension disagrees with unit.
    draftsFor(defineCatalogPack(omittedPack))([input]);
    return draftCodes(omittedPack, input);
  } },
  { form: 'optional fields omitted', name: 'undeclared SKU unit', expected: ['net_content_invalid', 'net_content_option_mismatch'], run: () => {
    const input = { ...omittedDraft, skus: [{ ...sku, netContent: { ...sku.netContent, unit: "example:other" } }] } as const;
    // @ts-expect-error undeclared SKU unit.
    draftsFor(defineCatalogPack(omittedPack))([input]);
    return draftCodes(omittedPack, input);
  } },
  { form: 'optional fields omitted', name: 'quantity unscaled datatype', expected: ['invalid_type'], run: () => {
    const input = { ...omittedDraft, skus: [{ ...sku, netContent: { ...sku.netContent, unscaled: 1 } }] } as const;
    // @ts-expect-error quantity unscaled datatype.
    draftsFor(defineCatalogPack(omittedPack))([input]);
    return draftCodes(omittedPack, input);
  } },
  { form: 'optional fields omitted', name: 'gross mass dimension', expected: ['gross_mass_invalid'], run: () => {
    const input = { ...omittedDraft, skus: [{ ...sku, grossMass: { ...sku.grossMass, dimension: "volume" } }] } as const;
    // @ts-expect-error gross mass dimension.
    draftsFor(defineCatalogPack(omittedPack))([input]);
    return draftCodes(omittedPack, input);
  } },
  { form: 'optional fields omitted', name: 'identifier datatype', expected: ['invalid_type'], run: () => {
    const input = { ...omittedDraft, skus: [{ ...sku, identifiers: [{ ...sku.identifiers[0], issuer: 1 }] }] } as const;
    // @ts-expect-error identifier datatype.
    draftsFor(defineCatalogPack(omittedPack))([input]);
    return draftCodes(omittedPack, input);
  } },
  { form: 'optional fields omitted', name: 'asset reference datatype', expected: ['invalid_type'], run: () => {
    const input = { ...omittedDraft, skus: [{ ...sku, assetRefs: [1] }] } as const;
    // @ts-expect-error asset reference datatype.
    draftsFor(defineCatalogPack(omittedPack))([input]);
    return draftCodes(omittedPack, input);
  } },
  { form: 'optional fields omitted', name: 'widened pack evidence is static only', expected: [], run: () => {
    const input: CatalogPackInput = omittedPack;
    // @ts-expect-error widened pack evidence is static only.
    draftsFor(input);
    return packCodes(input);
  } },
  { form: 'optional fields omitted', name: 'widened attribute keys are static only', expected: [], run: () => {
    const input = { ...omittedPack, types: omittedPack.types.map((type) => ({ ...type, attributes: type.attributes.map((attribute) => ({ ...attribute, key: String(attribute.key) })) })) };
    // @ts-expect-error widened attribute keys are static only.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'optional fields omitted', name: 'widened namespace evidence is static only', expected: [], run: () => {
    const input = { ...omittedPack, namespace: String(omittedPack.namespace) };
    // @ts-expect-error widened namespace evidence is static only.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'optional fields omitted', name: 'widened type version evidence is static only', expected: [], run: () => {
    const input = { ...omittedPack, types: omittedPack.types.map((type) => ({ ...type, version: Number(type.version) })) };
    // @ts-expect-error widened type version evidence is static only.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'optional fields omitted', name: 'widened tax class evidence is static only', expected: [], run: () => {
    const input = { ...omittedPack, taxClasses: omittedPack.taxClasses.map((entry) => ({ ...entry, key: String(entry.key) })) };
    // @ts-expect-error widened tax class evidence is static only.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'inline literals', name: 'complete descriptor and v1 fields', expected: [], run: () => {
    const input = inlinePack;
    const authored = defineCatalogPack({ id: "example:pack", namespace: "example", version: 1, openlupRange: "0.44.x", capabilities: { publish: false, install: false }, types: [primary, other], taxClasses: baseline.taxClasses, subscriptionProfiles: baseline.subscriptionProfiles });
    const values = draftsFor(authored)([{ schemaVersion: 1, product: {
      id: "10000000-0000-4000-8000-000000000001", type: { key: "example:item", version: 1 }, slug: "example", primarySkuId: "20000000-0000-4000-8000-000000000001",
      dimensions: ["finish", "amount", "featured"], sharedContent: { title: "Example" },
      documentRevision: { id: "30000000-0000-4000-8000-000000000001", productId: "10000000-0000-4000-8000-000000000001", revisionNo: 1, schemaId: "example:document", documentRef: "example:document", sourceRef: "example:source", digest: "a".repeat(64) },
    }, skus: [{
      id: "20000000-0000-4000-8000-000000000001", productId: "10000000-0000-4000-8000-000000000001", code: "EXAMPLE",
      options: { finish: { kind: "choice", value: "matte" }, amount: { kind: "quantity", value: { dimension: "count", unscaled: "1", scale: 0, unit: "openlup:piece" } }, featured: { kind: "boolean", value: true } },
      netContent: { dimension: "count", unscaled: "1", scale: 0, unit: "openlup:piece" }, grossMass: { dimension: "mass", unscaled: "100", scale: 0, unit: "openlup:g" },
      identifiers: [{ scheme: "example:identifier", issuer: "example", value: "ITEM", packagingLevel: "unit", quantity: 1 }], assetRefs: ["example:asset"], priceRef: "example:price", logisticsRef: "example:logistics",
    }] }]);
    return [...packCodes(input), ...draftCodes(input, values[0])];
  } },
  { form: 'inline literals', name: 'all optional definition fields may be omitted', expected: [], run: () => {
    const input = { ...inlinePack, types: [{ key: "example:plain", version: 1, units: primary.units, netContentUnits: primary.netContentUnits, dimensions: [], validateContent: primary.validateContent }], subscriptionProfiles: undefined } as const;
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'inline literals', name: 'unknown pack field', expected: ['definition_unknown_field'], run: () => {
    const input = { ...inlinePack, bogus: true } as const;
    // @ts-expect-error unknown pack field.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'inline literals', name: 'pack id datatype', expected: ['definition_invalid_shape'], run: () => {
    const input = { ...inlinePack, id: 1 } as const;
    // @ts-expect-error pack id datatype.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'inline literals', name: 'pack version datatype', expected: ['definition_version_invalid'], run: () => {
    const input = { ...inlinePack, version: "1" } as const;
    // @ts-expect-error pack version datatype.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'inline literals', name: 'pack range datatype', expected: ['definition_invalid_shape'], run: () => {
    const input = { ...inlinePack, openlupRange: 44 } as const;
    // @ts-expect-error pack range datatype.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'inline literals', name: 'pack capability datatype', expected: ['definition_invalid_shape'], run: () => {
    const input = { ...inlinePack, capabilities: { publish: "false" } } as const;
    // @ts-expect-error pack capability datatype.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'inline literals', name: 'misspelled type field', expected: ['definition_unknown_field'], run: () => {
    const input = { ...inlinePack, types: inlinePack.types.map((type) => type.key === "example:item" ? { ...type, taxclass: "example:standard" } : type) } as const;
    // @ts-expect-error misspelled type field.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'inline literals', name: 'unknown factor field', expected: ['definition_unknown_field'], run: () => {
    const input = { ...inlinePack, types: inlinePack.types.map((type) => type.key === "example:item" ? { ...type, units: [{ ...primary.units[0], factor: { ...primary.units[0].factor, bogus: true } }], netContentUnits: ["openlup:piece"], dimensions: [], attributes: [], axes: [] } : type) } as const;
    // @ts-expect-error unknown factor field.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'inline literals', name: 'unit dimension grammar', expected: ['definition_unit_invalid'], run: () => {
    const input = { ...inlinePack, types: inlinePack.types.map((type) => type.key === "example:item" ? { ...type, units: [{ ...primary.units[0], dimension: "length" }], netContentUnits: ["openlup:piece"], dimensions: [], attributes: [], axes: [] } : type) } as const;
    // @ts-expect-error unit dimension grammar.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'inline literals', name: 'factor canonical unit grammar', expected: ['definition_unit_invalid'], run: () => {
    const input = { ...inlinePack, types: inlinePack.types.map((type) => type.key === "example:item" ? { ...type, units: [{ ...primary.units[0], factor: { ...primary.units[0].factor, canonicalUnit: "example:missing" } }], netContentUnits: ["openlup:piece"], dimensions: [], attributes: [], axes: [] } : type) } as const;
    // @ts-expect-error factor canonical unit grammar.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'inline literals', name: 'undeclared net content unit', expected: ['definition_unknown_net_content_unit'], run: () => {
    const input = { ...inlinePack, types: inlinePack.types.map((type) => type.key === "example:item" ? { ...type, netContentUnits: [...primary.netContentUnits, "example:missing"] } : type) } as const;
    // @ts-expect-error undeclared net content unit.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'inline literals', name: 'cross type unit reference', expected: ['definition_unknown_net_content_unit'], run: () => {
    const input = { ...inlinePack, types: inlinePack.types.map((type) => type.key === "example:item" ? { ...type, netContentUnits: [...primary.netContentUnits, "example:other"] } : type) } as const;
    // @ts-expect-error cross type unit reference.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'inline literals', name: 'undeclared list quantity unit', expected: ['definition_unknown_attribute_unit'], run: () => {
    const input = { ...inlinePack, types: inlinePack.types.map((type) => type.key === "example:item" ? { ...type, attributes: primary.attributes.map((attribute) => attribute.key === "list_quantity" ? { ...attribute, valueType: { ...attribute.valueType, item: { ...attribute.valueType.item, units: ["example:missing"] as const } } } : attribute) } : type) } as const;
    // @ts-expect-error undeclared list quantity unit.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'inline literals', name: 'undeclared attribute unit', expected: ['definition_unknown_attribute_unit'], run: () => {
    const input = { ...inlinePack, types: inlinePack.types.map((type) => type.key === "example:item" ? { ...type, attributes: primary.attributes.map((attribute) => attribute.key === "amount" ? { ...attribute, valueType: { ...attribute.valueType, units: ["example:missing"] as const } } : attribute) } : type) } as const;
    // @ts-expect-error undeclared attribute unit.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'inline literals', name: 'quantity axis dimension disagrees with unit', expected: ['definition_dimension_unit_mismatch'], run: () => {
    const input = { ...inlinePack, types: inlinePack.types.map((type) => type.key === "example:item" ? { ...type, dimensions: primary.dimensions.map((dimension) => dimension.kind === "quantity" ? { ...dimension, units: ["openlup:ml"] as const } : dimension) } : type) } as const;
    // @ts-expect-error quantity axis dimension disagrees with unit.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'inline literals', name: 'unknown attribute value kind', expected: ['definition_attribute_invalid'], run: () => {
    const input = { ...inlinePack, types: inlinePack.types.map((type) => type.key === "example:item" ? { ...type, attributes: [{ ...flags, key: "custom", valueType: { kind: "custom" } }], axes: [] } : type) } as const;
    // @ts-expect-error unknown attribute value kind.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'inline literals', name: 'undeclared axis attribute', expected: ['definition_unknown_axis_attribute'], run: () => {
    const input = { ...inlinePack, types: inlinePack.types.map((type) => type.key === "example:item" ? { ...type, axes: [{ key: "finish", attributeKey: "missing" }] } : type) } as const;
    // @ts-expect-error undeclared axis attribute.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'inline literals', name: 'undeclared axis dimension', expected: ['definition_unknown_axis_dimension'], run: () => {
    const input = { ...inlinePack, types: inlinePack.types.map((type) => type.key === "example:item" ? { ...type, axes: [{ key: "missing", attributeKey: "finish" }] } : type) } as const;
    // @ts-expect-error undeclared axis dimension.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'inline literals', name: 'undeclared default tax class', expected: ['definition_unknown_tax_class'], run: () => {
    const input = { ...inlinePack, types: inlinePack.types.map((type) => type.key === "example:item" ? { ...type, taxClass: "example:missing" } : type) } as const;
    // @ts-expect-error undeclared default tax class.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'inline literals', name: 'undeclared profile version', expected: ['definition_unknown_profile_ref'], run: () => {
    const input = { ...inlinePack, types: inlinePack.types.map((type) => type.key === "example:item" ? { ...type, subscriptionProfileRef: { key: "example:regular", version: 2 } } : type) } as const;
    // @ts-expect-error undeclared profile version.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'inline literals', name: 'wrong type namespace', expected: ['pack_type_namespace_mismatch'], run: () => {
    const input = { ...inlinePack, types: inlinePack.types.map((type) => type.key === "example:item" ? { ...type, key: "other:item" } : type) } as const;
    // @ts-expect-error wrong type namespace.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'inline literals', name: 'unknown product type', expected: ['type_not_installed'], run: () => {
    const input = { ...inlineDraft, product: { ...inlineDraft.product, type: { key: "example:missing", version: 1 } } } as const;
    // @ts-expect-error unknown product type.
    draftsFor(defineCatalogPack(inlinePack))([{ schemaVersion: 1, product: { id: input.product.id, type: input.product.type, slug: input.product.slug, primarySkuId: input.product.primarySkuId, dimensions: input.product.dimensions, sharedContent: input.product.sharedContent, documentRevision: input.product.documentRevision }, skus: [{ id: input.skus[0].id, productId: input.skus[0].productId, code: input.skus[0].code, options: input.skus[0].options, netContent: input.skus[0].netContent, grossMass: input.skus[0].grossMass, identifiers: input.skus[0].identifiers, assetRefs: input.skus[0].assetRefs, priceRef: input.skus[0].priceRef, logisticsRef: input.skus[0].logisticsRef }] }]);
    return draftCodes(inlinePack, input);
  } },
  { form: 'inline literals', name: 'unknown product field', expected: ['unrecognized_keys'], run: () => {
    const input = { ...inlineDraft, product: { ...inlineDraft.product, bogus: true } } as const;
    // @ts-expect-error unknown product field.
    draftsFor(defineCatalogPack(inlinePack))([{ schemaVersion: 1, product: { id: input.product.id, type: input.product.type, slug: input.product.slug, primarySkuId: input.product.primarySkuId, dimensions: input.product.dimensions, sharedContent: input.product.sharedContent, documentRevision: input.product.documentRevision, bogus: true }, skus: [{ id: input.skus[0].id, productId: input.skus[0].productId, code: input.skus[0].code, options: input.skus[0].options, netContent: input.skus[0].netContent, grossMass: input.skus[0].grossMass, identifiers: input.skus[0].identifiers, assetRefs: input.skus[0].assetRefs, priceRef: input.skus[0].priceRef, logisticsRef: input.skus[0].logisticsRef }] }]);
    return draftCodes(inlinePack, input);
  } },
  { form: 'inline literals', name: 'product identity datatype', expected: ['invalid_type'], run: () => {
    const input = { ...inlineDraft, product: { ...inlineDraft.product, id: 1 } } as const;
    // @ts-expect-error product identity datatype.
    draftsFor(defineCatalogPack(inlinePack))([{ schemaVersion: 1, product: { id: input.product.id, type: input.product.type, slug: input.product.slug, primarySkuId: input.product.primarySkuId, dimensions: input.product.dimensions, sharedContent: input.product.sharedContent, documentRevision: input.product.documentRevision }, skus: [{ id: input.skus[0].id, productId: input.skus[0].productId, code: input.skus[0].code, options: input.skus[0].options, netContent: input.skus[0].netContent, grossMass: input.skus[0].grossMass, identifiers: input.skus[0].identifiers, assetRefs: input.skus[0].assetRefs, priceRef: input.skus[0].priceRef, logisticsRef: input.skus[0].logisticsRef }] }]);
    return draftCodes(inlinePack, input);
  } },
  { form: 'inline literals', name: 'unknown SKU field', expected: ['unrecognized_keys'], run: () => {
    const input = { ...inlineDraft, skus: [{ ...sku, bogus: true }] } as const;
    // @ts-expect-error unknown SKU field.
    draftsFor(defineCatalogPack(inlinePack))([{ schemaVersion: 1, product: { id: input.product.id, type: input.product.type, slug: input.product.slug, primarySkuId: input.product.primarySkuId, dimensions: input.product.dimensions, sharedContent: input.product.sharedContent, documentRevision: input.product.documentRevision }, skus: [{ id: input.skus[0].id, productId: input.skus[0].productId, code: input.skus[0].code, options: input.skus[0].options, netContent: input.skus[0].netContent, grossMass: input.skus[0].grossMass, identifiers: input.skus[0].identifiers, assetRefs: input.skus[0].assetRefs, priceRef: input.skus[0].priceRef, logisticsRef: input.skus[0].logisticsRef, bogus: true }] }]);
    return draftCodes(inlinePack, input);
  } },
  { form: 'inline literals', name: 'SKU identity datatype', expected: ['invalid_type'], run: () => {
    const input = { ...inlineDraft, skus: [{ ...sku, id: 1 }] } as const;
    // @ts-expect-error SKU identity datatype.
    draftsFor(defineCatalogPack(inlinePack))([{ schemaVersion: 1, product: { id: input.product.id, type: input.product.type, slug: input.product.slug, primarySkuId: input.product.primarySkuId, dimensions: input.product.dimensions, sharedContent: input.product.sharedContent, documentRevision: input.product.documentRevision }, skus: [{ id: input.skus[0].id, productId: input.skus[0].productId, code: input.skus[0].code, options: input.skus[0].options, netContent: input.skus[0].netContent, grossMass: input.skus[0].grossMass, identifiers: input.skus[0].identifiers, assetRefs: input.skus[0].assetRefs, priceRef: input.skus[0].priceRef, logisticsRef: input.skus[0].logisticsRef }] }]);
    return draftCodes(inlinePack, input);
  } },
  { form: 'inline literals', name: 'SKU code datatype', expected: ['invalid_type'], run: () => {
    const input = { ...inlineDraft, skus: [{ ...sku, code: 1 }] } as const;
    // @ts-expect-error SKU code datatype.
    draftsFor(defineCatalogPack(inlinePack))([{ schemaVersion: 1, product: { id: input.product.id, type: input.product.type, slug: input.product.slug, primarySkuId: input.product.primarySkuId, dimensions: input.product.dimensions, sharedContent: input.product.sharedContent, documentRevision: input.product.documentRevision }, skus: [{ id: input.skus[0].id, productId: input.skus[0].productId, code: input.skus[0].code, options: input.skus[0].options, netContent: input.skus[0].netContent, grossMass: input.skus[0].grossMass, identifiers: input.skus[0].identifiers, assetRefs: input.skus[0].assetRefs, priceRef: input.skus[0].priceRef, logisticsRef: input.skus[0].logisticsRef }] }]);
    return draftCodes(inlinePack, input);
  } },
  { form: 'inline literals', name: 'undeclared option key', expected: ['dimension_not_declared'], run: () => {
    const input = { ...inlineDraft, skus: [{ ...sku, options: { ...sku.options, missing: { kind: "boolean", value: true } } }] } as const;
    // @ts-expect-error undeclared option key.
    draftsFor(defineCatalogPack(inlinePack))([{ schemaVersion: 1, product: { id: input.product.id, type: input.product.type, slug: input.product.slug, primarySkuId: input.product.primarySkuId, dimensions: input.product.dimensions, sharedContent: input.product.sharedContent, documentRevision: input.product.documentRevision }, skus: [{ id: input.skus[0].id, productId: input.skus[0].productId, code: input.skus[0].code, options: input.skus[0].options, netContent: input.skus[0].netContent, grossMass: input.skus[0].grossMass, identifiers: input.skus[0].identifiers, assetRefs: input.skus[0].assetRefs, priceRef: input.skus[0].priceRef, logisticsRef: input.skus[0].logisticsRef }] }]);
    return draftCodes(inlinePack, input);
  } },
  { form: 'inline literals', name: 'quantity dimension disagrees with unit', expected: ['net_content_invalid', 'net_content_option_mismatch'], run: () => {
    const input = { ...inlineDraft, skus: [{ ...sku, netContent: { ...sku.netContent, dimension: "mass" } }] } as const;
    // @ts-expect-error quantity dimension disagrees with unit.
    draftsFor(defineCatalogPack(inlinePack))([{ schemaVersion: 1, product: { id: input.product.id, type: input.product.type, slug: input.product.slug, primarySkuId: input.product.primarySkuId, dimensions: input.product.dimensions, sharedContent: input.product.sharedContent, documentRevision: input.product.documentRevision }, skus: [{ id: input.skus[0].id, productId: input.skus[0].productId, code: input.skus[0].code, options: input.skus[0].options, netContent: input.skus[0].netContent, grossMass: input.skus[0].grossMass, identifiers: input.skus[0].identifiers, assetRefs: input.skus[0].assetRefs, priceRef: input.skus[0].priceRef, logisticsRef: input.skus[0].logisticsRef }] }]);
    return draftCodes(inlinePack, input);
  } },
  { form: 'inline literals', name: 'undeclared SKU unit', expected: ['net_content_invalid', 'net_content_option_mismatch'], run: () => {
    const input = { ...inlineDraft, skus: [{ ...sku, netContent: { ...sku.netContent, unit: "example:other" } }] } as const;
    // @ts-expect-error undeclared SKU unit.
    draftsFor(defineCatalogPack(inlinePack))([{ schemaVersion: 1, product: { id: input.product.id, type: input.product.type, slug: input.product.slug, primarySkuId: input.product.primarySkuId, dimensions: input.product.dimensions, sharedContent: input.product.sharedContent, documentRevision: input.product.documentRevision }, skus: [{ id: input.skus[0].id, productId: input.skus[0].productId, code: input.skus[0].code, options: input.skus[0].options, netContent: input.skus[0].netContent, grossMass: input.skus[0].grossMass, identifiers: input.skus[0].identifiers, assetRefs: input.skus[0].assetRefs, priceRef: input.skus[0].priceRef, logisticsRef: input.skus[0].logisticsRef }] }]);
    return draftCodes(inlinePack, input);
  } },
  { form: 'inline literals', name: 'quantity unscaled datatype', expected: ['invalid_type'], run: () => {
    const input = { ...inlineDraft, skus: [{ ...sku, netContent: { ...sku.netContent, unscaled: 1 } }] } as const;
    // @ts-expect-error quantity unscaled datatype.
    draftsFor(defineCatalogPack(inlinePack))([{ schemaVersion: 1, product: { id: input.product.id, type: input.product.type, slug: input.product.slug, primarySkuId: input.product.primarySkuId, dimensions: input.product.dimensions, sharedContent: input.product.sharedContent, documentRevision: input.product.documentRevision }, skus: [{ id: input.skus[0].id, productId: input.skus[0].productId, code: input.skus[0].code, options: input.skus[0].options, netContent: input.skus[0].netContent, grossMass: input.skus[0].grossMass, identifiers: input.skus[0].identifiers, assetRefs: input.skus[0].assetRefs, priceRef: input.skus[0].priceRef, logisticsRef: input.skus[0].logisticsRef }] }]);
    return draftCodes(inlinePack, input);
  } },
  { form: 'inline literals', name: 'gross mass dimension', expected: ['gross_mass_invalid'], run: () => {
    const input = { ...inlineDraft, skus: [{ ...sku, grossMass: { ...sku.grossMass, dimension: "volume" } }] } as const;
    // @ts-expect-error gross mass dimension.
    draftsFor(defineCatalogPack(inlinePack))([{ schemaVersion: 1, product: { id: input.product.id, type: input.product.type, slug: input.product.slug, primarySkuId: input.product.primarySkuId, dimensions: input.product.dimensions, sharedContent: input.product.sharedContent, documentRevision: input.product.documentRevision }, skus: [{ id: input.skus[0].id, productId: input.skus[0].productId, code: input.skus[0].code, options: input.skus[0].options, netContent: input.skus[0].netContent, grossMass: input.skus[0].grossMass, identifiers: input.skus[0].identifiers, assetRefs: input.skus[0].assetRefs, priceRef: input.skus[0].priceRef, logisticsRef: input.skus[0].logisticsRef }] }]);
    return draftCodes(inlinePack, input);
  } },
  { form: 'inline literals', name: 'identifier datatype', expected: ['invalid_type'], run: () => {
    const input = { ...inlineDraft, skus: [{ ...sku, identifiers: [{ ...sku.identifiers[0], issuer: 1 }] }] } as const;
    // @ts-expect-error identifier datatype.
    draftsFor(defineCatalogPack(inlinePack))([{ schemaVersion: 1, product: { id: input.product.id, type: input.product.type, slug: input.product.slug, primarySkuId: input.product.primarySkuId, dimensions: input.product.dimensions, sharedContent: input.product.sharedContent, documentRevision: input.product.documentRevision }, skus: [{ id: input.skus[0].id, productId: input.skus[0].productId, code: input.skus[0].code, options: input.skus[0].options, netContent: input.skus[0].netContent, grossMass: input.skus[0].grossMass, identifiers: input.skus[0].identifiers, assetRefs: input.skus[0].assetRefs, priceRef: input.skus[0].priceRef, logisticsRef: input.skus[0].logisticsRef }] }]);
    return draftCodes(inlinePack, input);
  } },
  { form: 'inline literals', name: 'asset reference datatype', expected: ['invalid_type'], run: () => {
    const input = { ...inlineDraft, skus: [{ ...sku, assetRefs: [1] }] } as const;
    // @ts-expect-error asset reference datatype.
    draftsFor(defineCatalogPack(inlinePack))([{ schemaVersion: 1, product: { id: input.product.id, type: input.product.type, slug: input.product.slug, primarySkuId: input.product.primarySkuId, dimensions: input.product.dimensions, sharedContent: input.product.sharedContent, documentRevision: input.product.documentRevision }, skus: [{ id: input.skus[0].id, productId: input.skus[0].productId, code: input.skus[0].code, options: input.skus[0].options, netContent: input.skus[0].netContent, grossMass: input.skus[0].grossMass, identifiers: input.skus[0].identifiers, assetRefs: input.skus[0].assetRefs, priceRef: input.skus[0].priceRef, logisticsRef: input.skus[0].logisticsRef }] }]);
    return draftCodes(inlinePack, input);
  } },
  { form: 'inline literals', name: 'widened pack evidence is static only', expected: [], run: () => {
    const input: CatalogPackInput = inlinePack;
    // @ts-expect-error widened pack evidence is static only.
    draftsFor(input);
    return packCodes(input);
  } },
  { form: 'inline literals', name: 'widened attribute keys are static only', expected: [], run: () => {
    const input = { ...inlinePack, types: inlinePack.types.map((type) => ({ ...type, attributes: type.attributes.map((attribute) => ({ ...attribute, key: String(attribute.key) })) })) };
    // @ts-expect-error widened attribute keys are static only.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'inline literals', name: 'widened namespace evidence is static only', expected: [], run: () => {
    const input = { ...inlinePack, namespace: String(inlinePack.namespace) };
    // @ts-expect-error widened namespace evidence is static only.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'inline literals', name: 'widened type version evidence is static only', expected: [], run: () => {
    const input = { ...inlinePack, types: inlinePack.types.map((type) => ({ ...type, version: Number(type.version) })) };
    // @ts-expect-error widened type version evidence is static only.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'inline literals', name: 'widened tax class evidence is static only', expected: [], run: () => {
    const input = { ...inlinePack, taxClasses: inlinePack.taxClasses.map((entry) => ({ ...entry, key: String(entry.key) })) };
    // @ts-expect-error widened tax class evidence is static only.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'referenced objects', name: 'complete descriptor and v1 fields', expected: [], run: () => {
    const input = referencedPack; const authored = defineCatalogPack(input);
    const values = draftsFor(authored)([referencedDraft]);
    return [...packCodes(input), ...draftCodes(input, values[0])];
  } },
  { form: 'referenced objects', name: 'all optional definition fields may be omitted', expected: [], run: () => {
    const input = { ...referencedPack, types: [{ key: "example:plain", version: 1, units: primary.units, netContentUnits: primary.netContentUnits, dimensions: [], validateContent: primary.validateContent }], subscriptionProfiles: undefined } as const;
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'referenced objects', name: 'unknown pack field', expected: ['definition_unknown_field'], run: () => {
    const input = { ...referencedPack, bogus: true } as const;
    // @ts-expect-error unknown pack field.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'referenced objects', name: 'pack id datatype', expected: ['definition_invalid_shape'], run: () => {
    const input = { ...referencedPack, id: 1 } as const;
    // @ts-expect-error pack id datatype.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'referenced objects', name: 'pack version datatype', expected: ['definition_version_invalid'], run: () => {
    const input = { ...referencedPack, version: "1" } as const;
    // @ts-expect-error pack version datatype.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'referenced objects', name: 'pack range datatype', expected: ['definition_invalid_shape'], run: () => {
    const input = { ...referencedPack, openlupRange: 44 } as const;
    // @ts-expect-error pack range datatype.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'referenced objects', name: 'pack capability datatype', expected: ['definition_invalid_shape'], run: () => {
    const input = { ...referencedPack, capabilities: { publish: "false" } } as const;
    // @ts-expect-error pack capability datatype.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'referenced objects', name: 'misspelled type field', expected: ['definition_unknown_field'], run: () => {
    const input = { ...referencedPack, types: referencedPack.types.map((type) => type.key === "example:item" ? { ...type, taxclass: "example:standard" } : type) } as const;
    // @ts-expect-error misspelled type field.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'referenced objects', name: 'unknown factor field', expected: ['definition_unknown_field'], run: () => {
    const input = { ...referencedPack, types: referencedPack.types.map((type) => type.key === "example:item" ? { ...type, units: [{ ...primary.units[0], factor: { ...primary.units[0].factor, bogus: true } }], netContentUnits: ["openlup:piece"], dimensions: [], attributes: [], axes: [] } : type) } as const;
    // @ts-expect-error unknown factor field.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'referenced objects', name: 'unit dimension grammar', expected: ['definition_unit_invalid'], run: () => {
    const input = { ...referencedPack, types: referencedPack.types.map((type) => type.key === "example:item" ? { ...type, units: [{ ...primary.units[0], dimension: "length" }], netContentUnits: ["openlup:piece"], dimensions: [], attributes: [], axes: [] } : type) } as const;
    // @ts-expect-error unit dimension grammar.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'referenced objects', name: 'factor canonical unit grammar', expected: ['definition_unit_invalid'], run: () => {
    const input = { ...referencedPack, types: referencedPack.types.map((type) => type.key === "example:item" ? { ...type, units: [{ ...primary.units[0], factor: { ...primary.units[0].factor, canonicalUnit: "example:missing" } }], netContentUnits: ["openlup:piece"], dimensions: [], attributes: [], axes: [] } : type) } as const;
    // @ts-expect-error factor canonical unit grammar.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'referenced objects', name: 'undeclared net content unit', expected: ['definition_unknown_net_content_unit'], run: () => {
    const input = { ...referencedPack, types: referencedPack.types.map((type) => type.key === "example:item" ? { ...type, netContentUnits: [...primary.netContentUnits, "example:missing"] } : type) } as const;
    // @ts-expect-error undeclared net content unit.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'referenced objects', name: 'cross type unit reference', expected: ['definition_unknown_net_content_unit'], run: () => {
    const input = { ...referencedPack, types: referencedPack.types.map((type) => type.key === "example:item" ? { ...type, netContentUnits: [...primary.netContentUnits, "example:other"] } : type) } as const;
    // @ts-expect-error cross type unit reference.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'referenced objects', name: 'undeclared list quantity unit', expected: ['definition_unknown_attribute_unit'], run: () => {
    const input = { ...referencedPack, types: referencedPack.types.map((type) => type.key === "example:item" ? { ...type, attributes: primary.attributes.map((attribute) => attribute.key === "list_quantity" ? { ...attribute, valueType: { ...attribute.valueType, item: { ...attribute.valueType.item, units: ["example:missing"] as const } } } : attribute) } : type) } as const;
    // @ts-expect-error undeclared list quantity unit.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'referenced objects', name: 'undeclared attribute unit', expected: ['definition_unknown_attribute_unit'], run: () => {
    const input = { ...referencedPack, types: referencedPack.types.map((type) => type.key === "example:item" ? { ...type, attributes: primary.attributes.map((attribute) => attribute.key === "amount" ? { ...attribute, valueType: { ...attribute.valueType, units: ["example:missing"] as const } } : attribute) } : type) } as const;
    // @ts-expect-error undeclared attribute unit.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'referenced objects', name: 'quantity axis dimension disagrees with unit', expected: ['definition_dimension_unit_mismatch'], run: () => {
    const input = { ...referencedPack, types: referencedPack.types.map((type) => type.key === "example:item" ? { ...type, dimensions: primary.dimensions.map((dimension) => dimension.kind === "quantity" ? { ...dimension, units: ["openlup:ml"] as const } : dimension) } : type) } as const;
    // @ts-expect-error quantity axis dimension disagrees with unit.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'referenced objects', name: 'unknown attribute value kind', expected: ['definition_attribute_invalid'], run: () => {
    const input = { ...referencedPack, types: referencedPack.types.map((type) => type.key === "example:item" ? { ...type, attributes: [{ ...flags, key: "custom", valueType: { kind: "custom" } }], axes: [] } : type) } as const;
    // @ts-expect-error unknown attribute value kind.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'referenced objects', name: 'undeclared axis attribute', expected: ['definition_unknown_axis_attribute'], run: () => {
    const input = { ...referencedPack, types: referencedPack.types.map((type) => type.key === "example:item" ? { ...type, axes: [{ key: "finish", attributeKey: "missing" }] } : type) } as const;
    // @ts-expect-error undeclared axis attribute.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'referenced objects', name: 'undeclared axis dimension', expected: ['definition_unknown_axis_dimension'], run: () => {
    const input = { ...referencedPack, types: referencedPack.types.map((type) => type.key === "example:item" ? { ...type, axes: [{ key: "missing", attributeKey: "finish" }] } : type) } as const;
    // @ts-expect-error undeclared axis dimension.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'referenced objects', name: 'undeclared default tax class', expected: ['definition_unknown_tax_class'], run: () => {
    const input = { ...referencedPack, types: referencedPack.types.map((type) => type.key === "example:item" ? { ...type, taxClass: "example:missing" } : type) } as const;
    // @ts-expect-error undeclared default tax class.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'referenced objects', name: 'undeclared profile version', expected: ['definition_unknown_profile_ref'], run: () => {
    const input = { ...referencedPack, types: referencedPack.types.map((type) => type.key === "example:item" ? { ...type, subscriptionProfileRef: { key: "example:regular", version: 2 } } : type) } as const;
    // @ts-expect-error undeclared profile version.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'referenced objects', name: 'wrong type namespace', expected: ['pack_type_namespace_mismatch'], run: () => {
    const input = { ...referencedPack, types: referencedPack.types.map((type) => type.key === "example:item" ? { ...type, key: "other:item" } : type) } as const;
    // @ts-expect-error wrong type namespace.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'referenced objects', name: 'unknown product type', expected: ['type_not_installed'], run: () => {
    const input = { ...referencedDraft, product: { ...referencedDraft.product, type: { key: "example:missing", version: 1 } } } as const;
    // @ts-expect-error unknown product type.
    draftsFor(defineCatalogPack(referencedPack))([input]);
    return draftCodes(referencedPack, input);
  } },
  { form: 'referenced objects', name: 'unknown product field', expected: ['unrecognized_keys'], run: () => {
    const input = { ...referencedDraft, product: { ...referencedDraft.product, bogus: true } } as const;
    // @ts-expect-error unknown product field.
    draftsFor(defineCatalogPack(referencedPack))([input]);
    return draftCodes(referencedPack, input);
  } },
  { form: 'referenced objects', name: 'product identity datatype', expected: ['invalid_type'], run: () => {
    const input = { ...referencedDraft, product: { ...referencedDraft.product, id: 1 } } as const;
    // @ts-expect-error product identity datatype.
    draftsFor(defineCatalogPack(referencedPack))([input]);
    return draftCodes(referencedPack, input);
  } },
  { form: 'referenced objects', name: 'unknown SKU field', expected: ['unrecognized_keys'], run: () => {
    const input = { ...referencedDraft, skus: [{ ...sku, bogus: true }] } as const;
    // @ts-expect-error unknown SKU field.
    draftsFor(defineCatalogPack(referencedPack))([input]);
    return draftCodes(referencedPack, input);
  } },
  { form: 'referenced objects', name: 'SKU identity datatype', expected: ['invalid_type'], run: () => {
    const input = { ...referencedDraft, skus: [{ ...sku, id: 1 }] } as const;
    // @ts-expect-error SKU identity datatype.
    draftsFor(defineCatalogPack(referencedPack))([input]);
    return draftCodes(referencedPack, input);
  } },
  { form: 'referenced objects', name: 'SKU code datatype', expected: ['invalid_type'], run: () => {
    const input = { ...referencedDraft, skus: [{ ...sku, code: 1 }] } as const;
    // @ts-expect-error SKU code datatype.
    draftsFor(defineCatalogPack(referencedPack))([input]);
    return draftCodes(referencedPack, input);
  } },
  { form: 'referenced objects', name: 'undeclared option key', expected: ['dimension_not_declared'], run: () => {
    const input = { ...referencedDraft, skus: [{ ...sku, options: { ...sku.options, missing: { kind: "boolean", value: true } } }] } as const;
    // @ts-expect-error undeclared option key.
    draftsFor(defineCatalogPack(referencedPack))([input]);
    return draftCodes(referencedPack, input);
  } },
  { form: 'referenced objects', name: 'quantity dimension disagrees with unit', expected: ['net_content_invalid', 'net_content_option_mismatch'], run: () => {
    const input = { ...referencedDraft, skus: [{ ...sku, netContent: { ...sku.netContent, dimension: "mass" } }] } as const;
    // @ts-expect-error quantity dimension disagrees with unit.
    draftsFor(defineCatalogPack(referencedPack))([input]);
    return draftCodes(referencedPack, input);
  } },
  { form: 'referenced objects', name: 'undeclared SKU unit', expected: ['net_content_invalid', 'net_content_option_mismatch'], run: () => {
    const input = { ...referencedDraft, skus: [{ ...sku, netContent: { ...sku.netContent, unit: "example:other" } }] } as const;
    // @ts-expect-error undeclared SKU unit.
    draftsFor(defineCatalogPack(referencedPack))([input]);
    return draftCodes(referencedPack, input);
  } },
  { form: 'referenced objects', name: 'quantity unscaled datatype', expected: ['invalid_type'], run: () => {
    const input = { ...referencedDraft, skus: [{ ...sku, netContent: { ...sku.netContent, unscaled: 1 } }] } as const;
    // @ts-expect-error quantity unscaled datatype.
    draftsFor(defineCatalogPack(referencedPack))([input]);
    return draftCodes(referencedPack, input);
  } },
  { form: 'referenced objects', name: 'gross mass dimension', expected: ['gross_mass_invalid'], run: () => {
    const input = { ...referencedDraft, skus: [{ ...sku, grossMass: { ...sku.grossMass, dimension: "volume" } }] } as const;
    // @ts-expect-error gross mass dimension.
    draftsFor(defineCatalogPack(referencedPack))([input]);
    return draftCodes(referencedPack, input);
  } },
  { form: 'referenced objects', name: 'identifier datatype', expected: ['invalid_type'], run: () => {
    const input = { ...referencedDraft, skus: [{ ...sku, identifiers: [{ ...sku.identifiers[0], issuer: 1 }] }] } as const;
    // @ts-expect-error identifier datatype.
    draftsFor(defineCatalogPack(referencedPack))([input]);
    return draftCodes(referencedPack, input);
  } },
  { form: 'referenced objects', name: 'asset reference datatype', expected: ['invalid_type'], run: () => {
    const input = { ...referencedDraft, skus: [{ ...sku, assetRefs: [1] }] } as const;
    // @ts-expect-error asset reference datatype.
    draftsFor(defineCatalogPack(referencedPack))([input]);
    return draftCodes(referencedPack, input);
  } },
  { form: 'referenced objects', name: 'widened pack evidence is static only', expected: [], run: () => {
    const input: CatalogPackInput = referencedPack;
    // @ts-expect-error widened pack evidence is static only.
    draftsFor(input);
    return packCodes(input);
  } },
  { form: 'referenced objects', name: 'widened attribute keys are static only', expected: [], run: () => {
    const input = { ...referencedPack, types: referencedPack.types.map((type) => ({ ...type, attributes: type.attributes.map((attribute) => ({ ...attribute, key: String(attribute.key) })) })) };
    // @ts-expect-error widened attribute keys are static only.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'referenced objects', name: 'widened namespace evidence is static only', expected: [], run: () => {
    const input = { ...referencedPack, namespace: String(referencedPack.namespace) };
    // @ts-expect-error widened namespace evidence is static only.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'referenced objects', name: 'widened type version evidence is static only', expected: [], run: () => {
    const input = { ...referencedPack, types: referencedPack.types.map((type) => ({ ...type, version: Number(type.version) })) };
    // @ts-expect-error widened type version evidence is static only.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'referenced objects', name: 'widened tax class evidence is static only', expected: [], run: () => {
    const input = { ...referencedPack, taxClasses: referencedPack.taxClasses.map((entry) => ({ ...entry, key: String(entry.key) })) };
    // @ts-expect-error widened tax class evidence is static only.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'as const', name: 'selected subset needs only its options', expected: [], run: () => {
    const input = { ...constDraft, product: { ...constDraft.product, dimensions: ["finish"] }, skus: [{ ...sku, options: { finish: sku.options.finish } }] } as const;
    draftsFor(defineCatalogPack(constPack))([input]);
    return draftCodes(constPack, input);
  } },
  { form: 'as const', name: 'zero selection has empty options', expected: [], run: () => {
    const input = { ...constDraft, product: { ...constDraft.product, dimensions: [] }, skus: [{ ...sku, options: {} }] } as const;
    draftsFor(defineCatalogPack(constPack))([input]);
    return draftCodes(constPack, input);
  } },
  { form: 'as const', name: 'installed but unselected options', expected: ['dimension_not_declared'], run: () => {
    const input = { ...constDraft, product: { ...constDraft.product, dimensions: ["finish"] }, skus: [sku] } as const;
    // @ts-expect-error installed but unselected options.
    draftsFor(defineCatalogPack(constPack))([input]);
    return draftCodes(constPack, input);
  } },
  { form: 'as const', name: 'empty selection refuses unknown options', expected: ['dimension_not_declared'], run: () => {
    const input = { ...constDraft, product: { ...constDraft.product, dimensions: [] }, skus: [{ ...sku, options: { missing: { kind: "boolean", value: true } } }] } as const;
    // @ts-expect-error empty selection refuses unknown options.
    draftsFor(defineCatalogPack(constPack))([input]);
    return draftCodes(constPack, input);
  } },
  { form: 'as const', name: 'missing selected options report readiness', expected: ['option_missing'], run: () => {
    const input = { ...constDraft, skus: [{ ...sku, options: { finish: sku.options.finish } }] } as const;
    // @ts-expect-error missing selected options report readiness.
    draftsFor(defineCatalogPack(constPack))([input]);
    return draftCodes(constPack, input);
  } },
  { form: 'as const', name: 'admitted mass quantity', expected: [], run: () => {
    const input = { ...constDraft, product: { ...constDraft.product, dimensions: ["finish", "featured"] }, skus: [{ ...sku, options: { finish: sku.options.finish, featured: sku.options.featured }, netContent: { dimension: "mass", unit: "openlup:g", unscaled: "1", scale: 0 } }] } as const;
    draftsFor(defineCatalogPack(constPack))([input]);
    return draftCodes(constPack, input);
  } },
  { form: 'as const', name: 'admitted volume quantity', expected: [], run: () => {
    const input = { ...constDraft, product: { ...constDraft.product, dimensions: ["finish", "featured"] }, skus: [{ ...sku, options: { finish: sku.options.finish, featured: sku.options.featured }, netContent: { dimension: "volume", unit: "openlup:ml", unscaled: "1", scale: 0 } }] } as const;
    draftsFor(defineCatalogPack(constPack))([input]);
    return draftCodes(constPack, input);
  } },
  { form: 'as const', name: 'returned referenced metadata is readonly', expected: [], run: () => {
    const defined = defineCatalogPack(constPack);
    const definition = defined.types.find((item) => item.key === "example:item");
    if (!definition) throw new Error("matrix type missing");
    const attribute = definition.attributes.find((item) => item.key === "editable");
    if (!attribute) throw new Error("matrix attribute missing");
    expect(() => {
      // @ts-expect-error even an identical boolean assignment violates the readonly projection.
      attribute.required = true;
    }).toThrow(TypeError);
    return packCodes(defined);
  } },
  { form: 'as const', name: 'validator artifact prefix', expected: ['definition_validator_ref_invalid'], run: () => {
    const input = { ...constPack, types: constPack.types.map((type) => type.key === "example:item" ? { ...type, validatorRef: "unversioned" } : type) } as const;
    // @ts-expect-error authoring artifact references use a build-pinned sha256 prefix.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'readonly arrays', name: 'selected subset needs only its options', expected: [], run: () => {
    const input = { ...readonlyDraft, product: { ...readonlyDraft.product, dimensions: ["finish"] }, skus: [{ ...sku, options: { finish: sku.options.finish } }] } as const;
    draftsFor(defineCatalogPack(readonlyPack))([input]);
    return draftCodes(readonlyPack, input);
  } },
  { form: 'readonly arrays', name: 'zero selection has empty options', expected: [], run: () => {
    const input = { ...readonlyDraft, product: { ...readonlyDraft.product, dimensions: [] }, skus: [{ ...sku, options: {} }] } as const;
    draftsFor(defineCatalogPack(readonlyPack))([input]);
    return draftCodes(readonlyPack, input);
  } },
  { form: 'readonly arrays', name: 'installed but unselected options', expected: ['dimension_not_declared'], run: () => {
    const input = { ...readonlyDraft, product: { ...readonlyDraft.product, dimensions: ["finish"] }, skus: [sku] } as const;
    // @ts-expect-error installed but unselected options.
    draftsFor(defineCatalogPack(readonlyPack))([input]);
    return draftCodes(readonlyPack, input);
  } },
  { form: 'readonly arrays', name: 'empty selection refuses unknown options', expected: ['dimension_not_declared'], run: () => {
    const input = { ...readonlyDraft, product: { ...readonlyDraft.product, dimensions: [] }, skus: [{ ...sku, options: { missing: { kind: "boolean", value: true } } }] } as const;
    // @ts-expect-error empty selection refuses unknown options.
    draftsFor(defineCatalogPack(readonlyPack))([input]);
    return draftCodes(readonlyPack, input);
  } },
  { form: 'readonly arrays', name: 'missing selected options report readiness', expected: ['option_missing'], run: () => {
    const input = { ...readonlyDraft, skus: [{ ...sku, options: { finish: sku.options.finish } }] } as const;
    // @ts-expect-error missing selected options report readiness.
    draftsFor(defineCatalogPack(readonlyPack))([input]);
    return draftCodes(readonlyPack, input);
  } },
  { form: 'readonly arrays', name: 'admitted mass quantity', expected: [], run: () => {
    const input = { ...readonlyDraft, product: { ...readonlyDraft.product, dimensions: ["finish", "featured"] }, skus: [{ ...sku, options: { finish: sku.options.finish, featured: sku.options.featured }, netContent: { dimension: "mass", unit: "openlup:g", unscaled: "1", scale: 0 } }] } as const;
    draftsFor(defineCatalogPack(readonlyPack))([input]);
    return draftCodes(readonlyPack, input);
  } },
  { form: 'readonly arrays', name: 'admitted volume quantity', expected: [], run: () => {
    const input = { ...readonlyDraft, product: { ...readonlyDraft.product, dimensions: ["finish", "featured"] }, skus: [{ ...sku, options: { finish: sku.options.finish, featured: sku.options.featured }, netContent: { dimension: "volume", unit: "openlup:ml", unscaled: "1", scale: 0 } }] } as const;
    draftsFor(defineCatalogPack(readonlyPack))([input]);
    return draftCodes(readonlyPack, input);
  } },
  { form: 'readonly arrays', name: 'returned referenced metadata is readonly', expected: [], run: () => {
    const defined = defineCatalogPack(readonlyPack);
    const definition = defined.types.find((item) => item.key === "example:item");
    if (!definition) throw new Error("matrix type missing");
    const attribute = definition.attributes.find((item) => item.key === "editable");
    if (!attribute) throw new Error("matrix attribute missing");
    expect(() => {
      // @ts-expect-error even an identical boolean assignment violates the readonly projection.
      attribute.required = true;
    }).toThrow(TypeError);
    return packCodes(defined);
  } },
  { form: 'readonly arrays', name: 'validator artifact prefix', expected: ['definition_validator_ref_invalid'], run: () => {
    const input = { ...readonlyPack, types: readonlyPack.types.map((type) => type.key === "example:item" ? { ...type, validatorRef: "unversioned" } : type) } as const;
    // @ts-expect-error authoring artifact references use a build-pinned sha256 prefix.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'mutable arrays', name: 'selected subset needs only its options', expected: [], run: () => {
    const input = { ...mutableDraft, product: { ...mutableDraft.product, dimensions: ["finish"] }, skus: [{ ...sku, options: { finish: sku.options.finish } }] } as const;
    draftsFor(defineCatalogPack(mutablePack))([input]);
    return draftCodes(mutablePack, input);
  } },
  { form: 'mutable arrays', name: 'zero selection has empty options', expected: [], run: () => {
    const input = { ...mutableDraft, product: { ...mutableDraft.product, dimensions: [] }, skus: [{ ...sku, options: {} }] } as const;
    draftsFor(defineCatalogPack(mutablePack))([input]);
    return draftCodes(mutablePack, input);
  } },
  { form: 'mutable arrays', name: 'installed but unselected options', expected: ['dimension_not_declared'], run: () => {
    const input = { ...mutableDraft, product: { ...mutableDraft.product, dimensions: ["finish"] }, skus: [sku] } as const;
    // @ts-expect-error installed but unselected options.
    draftsFor(defineCatalogPack(mutablePack))([input]);
    return draftCodes(mutablePack, input);
  } },
  { form: 'mutable arrays', name: 'empty selection refuses unknown options', expected: ['dimension_not_declared'], run: () => {
    const input = { ...mutableDraft, product: { ...mutableDraft.product, dimensions: [] }, skus: [{ ...sku, options: { missing: { kind: "boolean", value: true } } }] } as const;
    // @ts-expect-error empty selection refuses unknown options.
    draftsFor(defineCatalogPack(mutablePack))([input]);
    return draftCodes(mutablePack, input);
  } },
  { form: 'mutable arrays', name: 'missing selected options report readiness', expected: ['option_missing'], run: () => {
    const input = { ...mutableDraft, skus: [{ ...sku, options: { finish: sku.options.finish } }] } as const;
    // @ts-expect-error missing selected options report readiness.
    draftsFor(defineCatalogPack(mutablePack))([input]);
    return draftCodes(mutablePack, input);
  } },
  { form: 'mutable arrays', name: 'admitted mass quantity', expected: [], run: () => {
    const input = { ...mutableDraft, product: { ...mutableDraft.product, dimensions: ["finish", "featured"] }, skus: [{ ...sku, options: { finish: sku.options.finish, featured: sku.options.featured }, netContent: { dimension: "mass", unit: "openlup:g", unscaled: "1", scale: 0 } }] } as const;
    draftsFor(defineCatalogPack(mutablePack))([input]);
    return draftCodes(mutablePack, input);
  } },
  { form: 'mutable arrays', name: 'admitted volume quantity', expected: [], run: () => {
    const input = { ...mutableDraft, product: { ...mutableDraft.product, dimensions: ["finish", "featured"] }, skus: [{ ...sku, options: { finish: sku.options.finish, featured: sku.options.featured }, netContent: { dimension: "volume", unit: "openlup:ml", unscaled: "1", scale: 0 } }] } as const;
    draftsFor(defineCatalogPack(mutablePack))([input]);
    return draftCodes(mutablePack, input);
  } },
  { form: 'mutable arrays', name: 'returned referenced metadata is readonly', expected: [], run: () => {
    const defined = defineCatalogPack(mutablePack);
    const definition = defined.types.find((item) => item.key === "example:item");
    if (!definition) throw new Error("matrix type missing");
    const attribute = definition.attributes.find((item) => item.key === "editable");
    if (!attribute) throw new Error("matrix attribute missing");
    expect(() => {
      // @ts-expect-error even an identical boolean assignment violates the readonly projection.
      attribute.required = true;
    }).toThrow(TypeError);
    return packCodes(defined);
  } },
  { form: 'mutable arrays', name: 'validator artifact prefix', expected: ['definition_validator_ref_invalid'], run: () => {
    const input = { ...mutablePack, types: mutablePack.types.map((type) => type.key === "example:item" ? { ...type, validatorRef: "unversioned" } : type) } as const;
    // @ts-expect-error authoring artifact references use a build-pinned sha256 prefix.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'optional fields omitted', name: 'selected subset needs only its options', expected: [], run: () => {
    const input = { ...omittedDraft, product: { ...omittedDraft.product, dimensions: ["finish"] }, skus: [{ ...sku, options: { finish: sku.options.finish } }] } as const;
    draftsFor(defineCatalogPack(omittedPack))([input]);
    return draftCodes(omittedPack, input);
  } },
  { form: 'optional fields omitted', name: 'zero selection has empty options', expected: [], run: () => {
    const input = { ...omittedDraft, product: { ...omittedDraft.product, dimensions: [] }, skus: [{ ...sku, options: {} }] } as const;
    draftsFor(defineCatalogPack(omittedPack))([input]);
    return draftCodes(omittedPack, input);
  } },
  { form: 'optional fields omitted', name: 'installed but unselected options', expected: ['dimension_not_declared'], run: () => {
    const input = { ...omittedDraft, product: { ...omittedDraft.product, dimensions: ["finish"] }, skus: [sku] } as const;
    // @ts-expect-error installed but unselected options.
    draftsFor(defineCatalogPack(omittedPack))([input]);
    return draftCodes(omittedPack, input);
  } },
  { form: 'optional fields omitted', name: 'empty selection refuses unknown options', expected: ['dimension_not_declared'], run: () => {
    const input = { ...omittedDraft, product: { ...omittedDraft.product, dimensions: [] }, skus: [{ ...sku, options: { missing: { kind: "boolean", value: true } } }] } as const;
    // @ts-expect-error empty selection refuses unknown options.
    draftsFor(defineCatalogPack(omittedPack))([input]);
    return draftCodes(omittedPack, input);
  } },
  { form: 'optional fields omitted', name: 'missing selected options report readiness', expected: ['option_missing'], run: () => {
    const input = { ...omittedDraft, skus: [{ ...sku, options: { finish: sku.options.finish } }] } as const;
    // @ts-expect-error missing selected options report readiness.
    draftsFor(defineCatalogPack(omittedPack))([input]);
    return draftCodes(omittedPack, input);
  } },
  { form: 'optional fields omitted', name: 'admitted mass quantity', expected: [], run: () => {
    const input = { ...omittedDraft, product: { ...omittedDraft.product, dimensions: ["finish", "featured"] }, skus: [{ ...sku, options: { finish: sku.options.finish, featured: sku.options.featured }, netContent: { dimension: "mass", unit: "openlup:g", unscaled: "1", scale: 0 } }] } as const;
    draftsFor(defineCatalogPack(omittedPack))([input]);
    return draftCodes(omittedPack, input);
  } },
  { form: 'optional fields omitted', name: 'admitted volume quantity', expected: [], run: () => {
    const input = { ...omittedDraft, product: { ...omittedDraft.product, dimensions: ["finish", "featured"] }, skus: [{ ...sku, options: { finish: sku.options.finish, featured: sku.options.featured }, netContent: { dimension: "volume", unit: "openlup:ml", unscaled: "1", scale: 0 } }] } as const;
    draftsFor(defineCatalogPack(omittedPack))([input]);
    return draftCodes(omittedPack, input);
  } },
  { form: 'optional fields omitted', name: 'returned referenced metadata is readonly', expected: [], run: () => {
    const defined = defineCatalogPack(omittedPack);
    const definition = defined.types.find((item) => item.key === "example:item");
    if (!definition) throw new Error("matrix type missing");
    const attribute = definition.attributes.find((item) => item.key === "editable");
    if (!attribute) throw new Error("matrix attribute missing");
    expect(() => {
      // @ts-expect-error even an identical boolean assignment violates the readonly projection.
      attribute.required = true;
    }).toThrow(TypeError);
    return packCodes(defined);
  } },
  { form: 'optional fields omitted', name: 'validator artifact prefix', expected: ['definition_validator_ref_invalid'], run: () => {
    const input = { ...omittedPack, types: omittedPack.types.map((type) => type.key === "example:item" ? { ...type, validatorRef: "unversioned" } : type) } as const;
    // @ts-expect-error authoring artifact references use a build-pinned sha256 prefix.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'inline literals', name: 'selected subset needs only its options', expected: [], run: () => {
    const input = { ...inlineDraft, product: { ...inlineDraft.product, dimensions: ["finish"] }, skus: [{ ...sku, options: { finish: sku.options.finish } }] } as const;
    draftsFor(defineCatalogPack(inlinePack))([{ schemaVersion: 1, product: { id: input.product.id, type: input.product.type, slug: input.product.slug, primarySkuId: input.product.primarySkuId, dimensions: input.product.dimensions, sharedContent: input.product.sharedContent, documentRevision: input.product.documentRevision }, skus: [{ id: input.skus[0].id, productId: input.skus[0].productId, code: input.skus[0].code, options: input.skus[0].options, netContent: input.skus[0].netContent, grossMass: input.skus[0].grossMass, identifiers: input.skus[0].identifiers, assetRefs: input.skus[0].assetRefs, priceRef: input.skus[0].priceRef, logisticsRef: input.skus[0].logisticsRef }] }]);
    return draftCodes(inlinePack, input);
  } },
  { form: 'inline literals', name: 'zero selection has empty options', expected: [], run: () => {
    const input = { ...inlineDraft, product: { ...inlineDraft.product, dimensions: [] }, skus: [{ ...sku, options: {} }] } as const;
    draftsFor(defineCatalogPack(inlinePack))([{ schemaVersion: 1, product: { id: input.product.id, type: input.product.type, slug: input.product.slug, primarySkuId: input.product.primarySkuId, dimensions: input.product.dimensions, sharedContent: input.product.sharedContent, documentRevision: input.product.documentRevision }, skus: [{ id: input.skus[0].id, productId: input.skus[0].productId, code: input.skus[0].code, options: input.skus[0].options, netContent: input.skus[0].netContent, grossMass: input.skus[0].grossMass, identifiers: input.skus[0].identifiers, assetRefs: input.skus[0].assetRefs, priceRef: input.skus[0].priceRef, logisticsRef: input.skus[0].logisticsRef }] }]);
    return draftCodes(inlinePack, input);
  } },
  { form: 'inline literals', name: 'installed but unselected options', expected: ['dimension_not_declared'], run: () => {
    const input = { ...inlineDraft, product: { ...inlineDraft.product, dimensions: ["finish"] }, skus: [sku] } as const;
    // @ts-expect-error installed but unselected options.
    draftsFor(defineCatalogPack(inlinePack))([{ schemaVersion: 1, product: { id: input.product.id, type: input.product.type, slug: input.product.slug, primarySkuId: input.product.primarySkuId, dimensions: input.product.dimensions, sharedContent: input.product.sharedContent, documentRevision: input.product.documentRevision }, skus: [{ id: input.skus[0].id, productId: input.skus[0].productId, code: input.skus[0].code, options: input.skus[0].options, netContent: input.skus[0].netContent, grossMass: input.skus[0].grossMass, identifiers: input.skus[0].identifiers, assetRefs: input.skus[0].assetRefs, priceRef: input.skus[0].priceRef, logisticsRef: input.skus[0].logisticsRef }] }]);
    return draftCodes(inlinePack, input);
  } },
  { form: 'inline literals', name: 'empty selection refuses unknown options', expected: ['dimension_not_declared'], run: () => {
    const input = { ...inlineDraft, product: { ...inlineDraft.product, dimensions: [] }, skus: [{ ...sku, options: { missing: { kind: "boolean", value: true } } }] } as const;
    // @ts-expect-error empty selection refuses unknown options.
    draftsFor(defineCatalogPack(inlinePack))([{ schemaVersion: 1, product: { id: input.product.id, type: input.product.type, slug: input.product.slug, primarySkuId: input.product.primarySkuId, dimensions: input.product.dimensions, sharedContent: input.product.sharedContent, documentRevision: input.product.documentRevision }, skus: [{ id: input.skus[0].id, productId: input.skus[0].productId, code: input.skus[0].code, options: input.skus[0].options, netContent: input.skus[0].netContent, grossMass: input.skus[0].grossMass, identifiers: input.skus[0].identifiers, assetRefs: input.skus[0].assetRefs, priceRef: input.skus[0].priceRef, logisticsRef: input.skus[0].logisticsRef }] }]);
    return draftCodes(inlinePack, input);
  } },
  { form: 'inline literals', name: 'missing selected options report readiness', expected: ['option_missing'], run: () => {
    const input = { ...inlineDraft, skus: [{ ...sku, options: { finish: sku.options.finish } }] } as const;
    // @ts-expect-error missing selected options report readiness.
    draftsFor(defineCatalogPack(inlinePack))([{ schemaVersion: 1, product: { id: input.product.id, type: input.product.type, slug: input.product.slug, primarySkuId: input.product.primarySkuId, dimensions: input.product.dimensions, sharedContent: input.product.sharedContent, documentRevision: input.product.documentRevision }, skus: [{ id: input.skus[0].id, productId: input.skus[0].productId, code: input.skus[0].code, options: input.skus[0].options, netContent: input.skus[0].netContent, grossMass: input.skus[0].grossMass, identifiers: input.skus[0].identifiers, assetRefs: input.skus[0].assetRefs, priceRef: input.skus[0].priceRef, logisticsRef: input.skus[0].logisticsRef }] }]);
    return draftCodes(inlinePack, input);
  } },
  { form: 'inline literals', name: 'admitted mass quantity', expected: [], run: () => {
    const input = { ...inlineDraft, product: { ...inlineDraft.product, dimensions: ["finish", "featured"] }, skus: [{ ...sku, options: { finish: sku.options.finish, featured: sku.options.featured }, netContent: { dimension: "mass", unit: "openlup:g", unscaled: "1", scale: 0 } }] } as const;
    draftsFor(defineCatalogPack(inlinePack))([{ schemaVersion: 1, product: { id: input.product.id, type: input.product.type, slug: input.product.slug, primarySkuId: input.product.primarySkuId, dimensions: input.product.dimensions, sharedContent: input.product.sharedContent, documentRevision: input.product.documentRevision }, skus: [{ id: input.skus[0].id, productId: input.skus[0].productId, code: input.skus[0].code, options: input.skus[0].options, netContent: input.skus[0].netContent, grossMass: input.skus[0].grossMass, identifiers: input.skus[0].identifiers, assetRefs: input.skus[0].assetRefs, priceRef: input.skus[0].priceRef, logisticsRef: input.skus[0].logisticsRef }] }]);
    return draftCodes(inlinePack, input);
  } },
  { form: 'inline literals', name: 'admitted volume quantity', expected: [], run: () => {
    const input = { ...inlineDraft, product: { ...inlineDraft.product, dimensions: ["finish", "featured"] }, skus: [{ ...sku, options: { finish: sku.options.finish, featured: sku.options.featured }, netContent: { dimension: "volume", unit: "openlup:ml", unscaled: "1", scale: 0 } }] } as const;
    draftsFor(defineCatalogPack(inlinePack))([{ schemaVersion: 1, product: { id: input.product.id, type: input.product.type, slug: input.product.slug, primarySkuId: input.product.primarySkuId, dimensions: input.product.dimensions, sharedContent: input.product.sharedContent, documentRevision: input.product.documentRevision }, skus: [{ id: input.skus[0].id, productId: input.skus[0].productId, code: input.skus[0].code, options: input.skus[0].options, netContent: input.skus[0].netContent, grossMass: input.skus[0].grossMass, identifiers: input.skus[0].identifiers, assetRefs: input.skus[0].assetRefs, priceRef: input.skus[0].priceRef, logisticsRef: input.skus[0].logisticsRef }] }]);
    return draftCodes(inlinePack, input);
  } },
  { form: 'inline literals', name: 'returned referenced metadata is readonly', expected: [], run: () => {
    const defined = defineCatalogPack(inlinePack);
    const definition = defined.types.find((item) => item.key === "example:item");
    if (!definition) throw new Error("matrix type missing");
    const attribute = definition.attributes.find((item) => item.key === "editable");
    if (!attribute) throw new Error("matrix attribute missing");
    expect(() => {
      // @ts-expect-error even an identical boolean assignment violates the readonly projection.
      attribute.required = true;
    }).toThrow(TypeError);
    return packCodes(defined);
  } },
  { form: 'inline literals', name: 'validator artifact prefix', expected: ['definition_validator_ref_invalid'], run: () => {
    const input = { ...inlinePack, types: inlinePack.types.map((type) => type.key === "example:item" ? { ...type, validatorRef: "unversioned" } : type) } as const;
    // @ts-expect-error authoring artifact references use a build-pinned sha256 prefix.
    defineCatalogPack(input);
    return packCodes(input);
  } },
  { form: 'referenced objects', name: 'selected subset needs only its options', expected: [], run: () => {
    const input = { ...referencedDraft, product: { ...referencedDraft.product, dimensions: ["finish"] }, skus: [{ ...sku, options: { finish: sku.options.finish } }] } as const;
    draftsFor(defineCatalogPack(referencedPack))([input]);
    return draftCodes(referencedPack, input);
  } },
  { form: 'referenced objects', name: 'zero selection has empty options', expected: [], run: () => {
    const input = { ...referencedDraft, product: { ...referencedDraft.product, dimensions: [] }, skus: [{ ...sku, options: {} }] } as const;
    draftsFor(defineCatalogPack(referencedPack))([input]);
    return draftCodes(referencedPack, input);
  } },
  { form: 'referenced objects', name: 'installed but unselected options', expected: ['dimension_not_declared'], run: () => {
    const input = { ...referencedDraft, product: { ...referencedDraft.product, dimensions: ["finish"] }, skus: [sku] } as const;
    // @ts-expect-error installed but unselected options.
    draftsFor(defineCatalogPack(referencedPack))([input]);
    return draftCodes(referencedPack, input);
  } },
  { form: 'referenced objects', name: 'empty selection refuses unknown options', expected: ['dimension_not_declared'], run: () => {
    const input = { ...referencedDraft, product: { ...referencedDraft.product, dimensions: [] }, skus: [{ ...sku, options: { missing: { kind: "boolean", value: true } } }] } as const;
    // @ts-expect-error empty selection refuses unknown options.
    draftsFor(defineCatalogPack(referencedPack))([input]);
    return draftCodes(referencedPack, input);
  } },
  { form: 'referenced objects', name: 'missing selected options report readiness', expected: ['option_missing'], run: () => {
    const input = { ...referencedDraft, skus: [{ ...sku, options: { finish: sku.options.finish } }] } as const;
    // @ts-expect-error missing selected options report readiness.
    draftsFor(defineCatalogPack(referencedPack))([input]);
    return draftCodes(referencedPack, input);
  } },
  { form: 'referenced objects', name: 'admitted mass quantity', expected: [], run: () => {
    const input = { ...referencedDraft, product: { ...referencedDraft.product, dimensions: ["finish", "featured"] }, skus: [{ ...sku, options: { finish: sku.options.finish, featured: sku.options.featured }, netContent: { dimension: "mass", unit: "openlup:g", unscaled: "1", scale: 0 } }] } as const;
    draftsFor(defineCatalogPack(referencedPack))([input]);
    return draftCodes(referencedPack, input);
  } },
  { form: 'referenced objects', name: 'admitted volume quantity', expected: [], run: () => {
    const input = { ...referencedDraft, product: { ...referencedDraft.product, dimensions: ["finish", "featured"] }, skus: [{ ...sku, options: { finish: sku.options.finish, featured: sku.options.featured }, netContent: { dimension: "volume", unit: "openlup:ml", unscaled: "1", scale: 0 } }] } as const;
    draftsFor(defineCatalogPack(referencedPack))([input]);
    return draftCodes(referencedPack, input);
  } },
  { form: 'referenced objects', name: 'returned referenced metadata is readonly', expected: [], run: () => {
    const defined = defineCatalogPack(referencedPack);
    const definition = defined.types.find((item) => item.key === "example:item");
    if (!definition) throw new Error("matrix type missing");
    const attribute = definition.attributes.find((item) => item.key === "editable");
    if (!attribute) throw new Error("matrix attribute missing");
    expect(() => {
      // @ts-expect-error even an identical boolean assignment violates the readonly projection.
      attribute.required = true;
    }).toThrow(TypeError);
    return packCodes(defined);
  } },
  { form: 'referenced objects', name: 'validator artifact prefix', expected: ['definition_validator_ref_invalid'], run: () => {
    const input = { ...referencedPack, types: referencedPack.types.map((type) => type.key === "example:item" ? { ...type, validatorRef: "unversioned" } : type) } as const;
    // @ts-expect-error authoring artifact references use a build-pinned sha256 prefix.
    defineCatalogPack(input);
    return packCodes(input);
  } },
];
it("define_catalog_pack_types_reject_undeclared_keys", () => {
  const forms = ["as const", "readonly arrays", "mutable arrays", "optional fields omitted", "inline literals", "referenced objects"];
  for (const form of forms) expect(matrix.filter((row) => row.form === form)).toHaveLength(49);
  for (const row of matrix) expect.soft(row.run(), `${row.form}: ${row.name}`).toEqual([...row.expected].sort());
  const { validateContent: _callback, ...metadata } = primary;
  const publicMetadata: CatalogTypeDefinitionV2 = metadata;
  expect(publicMetadata.validatorRef).toBe(primary.validatorRef);
  const p = defineCatalogPack(baseline);
  const selection: CatalogPackDraft<typeof p, "finish"> = { schemaVersion: 1, product: { id: product.id, type: product.type, dimensions: ["finish"] }, skus: [{ id: sku.id, productId: product.id, options: { finish: { kind: "choice", value: "matte" } } }] };
  expect(draftCodes(p, selection)).toEqual([]);
  const core: CatalogQuantity = sku.netContent;
  const platform: PlatformQuantity = core;
  const back: CatalogQuantity = platform;
  expect(back).toBe(core);
  expect(Object.isFrozen(p.types[0].attributes[0])).toBe(true);
});

it("define_catalog_pack_types_reject_undeclared_keys_v2_required_attributes", () => {
  const pack = defineCatalogPack({ id: "example:v2", namespace: "example", version: 1, openlupRange: "0.44.x", capabilities: {}, taxClasses: [],
    types: [{ key: "example:v2", version: 1, units: [{ code: "openlup:piece", dimension: "count", integral: true }], netContentUnits: ["openlup:piece"], dimensions: [],
      attributes: [
        { key: "title", scope: "product", valueType: { kind: "text", maxLength: 120 }, required: true, cardinality: { min: 1, max: 1 }, filterable: false, facetable: false, public: true, displayOrder: 0, labels: {} },
        { key: "enabled", scope: "variant", valueType: { kind: "boolean" }, required: true, cardinality: { min: 1, max: 1 }, filterable: false, facetable: false, public: true, displayOrder: 0, labels: {} },
      ], validateContent: () => [] }],
  });
  const product = { id: "10000000-0000-4000-8000-000000000001", type: { key: "example:v2", version: 1 }, dimensions: [] } as const;
  const sku = { id: "20000000-0000-4000-8000-000000000001", productId: product.id, options: {} } as const;
  const author = draftsFor(pack);
  author([{ schemaVersion: 2, product: { ...product, attributes: { title: "Synthetic" } }, skus: [{ ...sku, attributes: { enabled: true } }] }]);
  // @ts-expect-error inline v2 drafts require the product's declared required attribute.
  author([{ schemaVersion: 2, product, skus: [{ ...sku, attributes: { enabled: true } }] }]);
  const referenced = { schemaVersion: 2, product: { ...product, attributes: { title: "Synthetic" } }, skus: [sku] } as const;
  // @ts-expect-error referenced v2 drafts require the variant's declared required attribute.
  author([referenced]);
  const readonlyDrafts = [{ schemaVersion: 2, product: { ...product, attributes: {} }, skus: [{ ...sku, attributes: { enabled: true } }] }] as const;
  // @ts-expect-error readonly arrays do not hide missing required product keys.
  author(readonlyDrafts);
  const mutableDrafts = [{ schemaVersion: 2 as const, product: { ...product, attributes: { title: "Synthetic" } }, skus: [{ ...sku, attributes: {} }] }];
  // @ts-expect-error mutable arrays do not hide missing required variant keys.
  author(mutableDrafts);
  // @ts-expect-error unknown product attribute keys are closed even on referenced objects.
  author([{ schemaVersion: 2, product: { ...product, attributes: { title: "Synthetic", invented: "extra" } }, skus: [{ ...sku, attributes: { enabled: true } }] }]);
  // @ts-expect-error a supplied variant value must match its declared kind.
  author([{ schemaVersion: 2, product: { ...product, attributes: { title: "Synthetic" } }, skus: [{ ...sku, attributes: { enabled: "yes" } }] }]);
  expect(pack.types[0].attributes.map(attribute => attribute.key)).toEqual(["title", "enabled"]);
});
it("catalog_publish_denies_machine_and_distributor", () => {
  // @ts-expect-error a draft actor string cannot mint the opaque human publisher.
  const draftActor: VerifiedCatalogPublisher = { actorId: "operator:synthetic" };
  // @ts-expect-error a service credential cannot mint the opaque human publisher.
  const service: VerifiedCatalogPublisher = { credential: "synthetic-service", machine: true };
  // @ts-expect-error a distributor role cannot mint the opaque human publisher.
  const distributor: VerifiedCatalogPublisher = { role: "distributor" };
  expect([draftActor, service, distributor]).toHaveLength(3);
});
