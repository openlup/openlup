import { catalogVariantOptions, type CatalogDraftPayloadV3, type CatalogPackInput } from "@openlup/platform/catalog";
import type { CatalogConformanceSubject } from "@openlup/platform/catalog/testing";

const title = "Fernwake Wet Food";
const productId = "00000000-0000-4000-8000-000000000401";
const type = { key: "petfood:wet", version: 1 };
const variants = [
  { weight: "400", flavour: "duck", gtin: "0400000004013",
    id: "00000000-0000-4000-8000-000000000402" },
  { weight: "800", flavour: "turkey", gtin: "0400000004020",
    id: "00000000-0000-4000-8000-000000000403" },
] as const;
const options = catalogVariantOptions([
  { key: "weight", kind: "quantity", dimension: "mass", units: ["openlup:g"], role: "net_content", labels: { en: "Weight" } },
  { key: "flavour", kind: "choice", values: [{ id: "duck", labels: { en: "Duck" } }, { id: "turkey", labels: { en: "Turkey" } }],
    labels: { en: "Flavour" } },
]);

export const pack = {
  id: "pet-food", namespace: "petfood", version: 1, openlupRange: "1.x",
  capabilities: {}, taxClasses: [{ key: "standard" }],
  types: [{
    ...options, ...type, taxClass: "standard", netContentUnits: ["openlup:g"],
    units: [{ code: "openlup:g", dimension: "mass", integral: false,
      factor: { canonicalUnit: "openlup:g", unscaled: "1", scale: 0 } }],
    attributes: [
      ...options.attributes,
      { key: "life_stage", scope: "product", valueType: { kind: "enum", values: [{ id: "adult" }, { id: "senior" }] },
        required: true, cardinality: { min: 1, max: 1 }, public: true, filterable: false, facetable: false,
        displayOrder: 2, labels: { en: "Life stage" } },
    ],
    validateContent(content) {
      const presentation = content && typeof content === "object" && "presentation" in content ? content.presentation : null;
      return presentation && typeof presentation === "object" && "title" in presentation
        && typeof presentation.title === "string" && presentation.title.trim()
        ? [] : [{ path: "presentation.title", code: "title_required" }];
    },
  }],
} satisfies CatalogPackInput;

const skus = variants.map(({ id, weight, flavour, gtin }) => {
  const netContent = { dimension: "mass", unit: "openlup:g", unscaled: weight, scale: 0 } as const;
  return {
    id, productId, code: `FERNWAKE-${weight}`, netContent,
    options: { weight: { kind: "quantity" as const, value: netContent }, flavour: { kind: "choice" as const, value: flavour } },
    attributes: { weight: netContent, flavour },
    identifiers: [{ scheme: "gs1:gtin", issuer: "petfood:fixture", value: gtin, packagingLevel: "unit" as const }],
  };
});

const draft: CatalogDraftPayloadV3 = {
  schemaVersion: 3,
  product: {
    id: productId, type, dimensions: ["weight", "flavour"], slug: "fernwake-wet-food", primarySkuId: variants[0].id,
    attributes: { life_stage: "adult" },
    sharedContent: {
      schemaVersion: 1, catalogAction: "create", presentation: { title },
      offerMemberships: [], requestedModes: [], publicationSkus: [],
    },
  },
  skus,
  publication: {
    kind: "release", evidence: {},
    operations: [{ op: "create_product", productId, productSlug: "fernwake-wet-food", name: title }],
  },
};

export const referenceEntry = { pack, drafts: [draft] };

export const offlineFixture = {
  ...referenceEntry,
  quantities: skus.map(({ netContent }) => ({ type, value: netContent, targetUnit: "openlup:g" })),
  combinations: [{ type, input: { axes: ["weight", "flavour"], typed: true, retained: [],
    incoming: skus.map(({ id, options: optionValues }) => ({ skuId: id, state: "active" as const, optionValues })) } }],
} satisfies CatalogConformanceSubject["packs"][number];

const reusedGtin = structuredClone(draft);
reusedGtin.skus[1]!.identifiers![0]!.value = skus[0]!.identifiers[0]!.value;
export const negativeFixture = {
  ...offlineFixture, drafts: [reusedGtin],
} satisfies CatalogConformanceSubject["packs"][number];
