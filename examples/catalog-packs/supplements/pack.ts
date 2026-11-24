import { catalogVariantOptions, type CatalogDraftPayloadV3, type CatalogPackInput } from "@openlup/platform/catalog";
import type { CatalogConformanceSubject } from "@openlup/platform/catalog/testing";

const title = "Northglass Capsules";
const productId = "00000000-0000-4000-8000-000000000101";
const type = { key: "supp:capsules", version: 1 };
const sizes = [
  { unit: "supp:pack-60", count: "60", mass: "42", gtin: "0400000001012",
    id: "00000000-0000-4000-8000-000000000102" },
  { unit: "supp:pack-120", count: "120", mass: "84", gtin: "0400000001029",
    id: "00000000-0000-4000-8000-000000000103" },
] as const;
const options = catalogVariantOptions([{
  key: "count", kind: "quantity", dimension: "count", units: sizes.map(({ unit }) => unit), labels: { en: "Count" },
}]);
const productAttribute = {
  scope: "product", required: true, cardinality: { min: 1, max: 1 },
  public: true, filterable: false, facetable: false,
} as const;

export const pack = {
  id: "supplements", namespace: "supp", version: 1, openlupRange: "1.x",
  capabilities: {}, taxClasses: [{ key: "standard" }, { key: "reduced" }],
  types: [{
    ...options, ...type, taxClass: "reduced", netContentUnits: ["openlup:g"],
    units: [
      { code: "openlup:g", dimension: "mass", integral: false,
        factor: { canonicalUnit: "openlup:g", unscaled: "1", scale: 0 } },
      { code: "openlup:piece", dimension: "count", integral: true,
        factor: { canonicalUnit: "openlup:piece", unscaled: "1", scale: 0 } },
      ...sizes.map(({ unit, count }) => ({
        code: unit, dimension: "count" as const, integral: true,
        factor: { canonicalUnit: "openlup:piece" as const, unscaled: count, scale: 0 },
      })),
    ],
    attributes: [
      ...options.attributes,
      { ...productAttribute, key: "serving_size", displayOrder: 1, labels: { en: "Serving size" },
        valueType: { kind: "quantity", dimension: "count", units: ["openlup:piece"] } },
      { ...productAttribute, key: "servings", displayOrder: 2, labels: { en: "Servings" },
        valueType: { kind: "decimal", scale: 0 } },
    ],
    validateContent(content) {
      const presentation = content && typeof content === "object" && "presentation" in content ? content.presentation : null;
      return presentation && typeof presentation === "object" && "title" in presentation
        && typeof presentation.title === "string" && presentation.title.trim()
        ? [] : [{ path: "presentation.title", code: "title_required" }];
    },
  }],
} satisfies CatalogPackInput;

const skus = sizes.map(({ id, unit, count, mass, gtin }) => {
  const value = { dimension: "count", unit, unscaled: "1", scale: 0 } as const;
  return {
    id, productId, code: `NORTHGLASS-${count}`,
    options: { count: { kind: "quantity" as const, value } }, attributes: { count: value },
    netContent: { dimension: "mass" as const, unit: "openlup:g", unscaled: mass, scale: 0 },
    identifiers: [{ scheme: "gs1:gtin", issuer: "supp:fixture", value: gtin, packagingLevel: "unit" as const }],
  };
});

const draft: CatalogDraftPayloadV3 = {
  schemaVersion: 3,
  product: {
    id: productId, type, dimensions: ["count"], slug: "northglass-capsules", primarySkuId: sizes[0].id,
    attributes: { serving_size: { dimension: "count", unit: "openlup:piece", unscaled: "2", scale: 0 }, servings: "30" },
    sharedContent: {
      schemaVersion: 1, catalogAction: "create", presentation: { title },
      offerMemberships: [], requestedModes: [], publicationSkus: [],
    },
  },
  skus,
  publication: {
    kind: "release", evidence: {},
    operations: [{ op: "create_product", productId, productSlug: "northglass-capsules", name: title }],
  },
};

export const referenceEntry = { pack, drafts: [draft] };

export const offlineFixture = {
  ...referenceEntry,
  quantities: skus.map(({ attributes }) => ({ type, value: attributes.count, targetUnit: "openlup:piece" })),
  combinations: [{ type, input: { axes: ["count"], typed: true, retained: [],
    incoming: skus.map(({ id, options: optionValues }) => ({ skuId: id, state: "active" as const, optionValues })) } }],
} satisfies CatalogConformanceSubject["packs"][number];

export const negativeFixture = {
  ...offlineFixture,
  pack: { ...pack, taxClasses: pack.taxClasses.filter(({ key }) => key !== "reduced") },
} satisfies CatalogConformanceSubject["packs"][number];
