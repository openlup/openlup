import { catalogInternalGtin, catalogVariantOptions, type CatalogDraftPayloadV3, type CatalogPackInput } from "@openlup/platform/catalog";
import type { CatalogConformanceSubject } from "@openlup/platform/catalog/testing";

const title = "Lumenfen Foundation";
const productId = "00000000-0000-4000-8000-000000000201";
const type = { key: "cosmo:foundation", version: 1 };
const variants = [
  { unit: "cosmo:bottle-30", volume: "30", mass: "33", shade: "ivory", sequence: 301,
    id: "00000000-0000-4000-8000-000000000202" },
  { unit: "cosmo:bottle-50", volume: "50", mass: "55", shade: "sand", sequence: 302,
    id: "00000000-0000-4000-8000-000000000203" },
] as const;
const options = catalogVariantOptions([
  { key: "volume", kind: "quantity", dimension: "volume", units: variants.map(({ unit }) => unit), labels: { en: "Volume" } },
  { key: "shade", kind: "choice", values: [{ id: "ivory", labels: { en: "Ivory" } }, { id: "sand", labels: { en: "Sand" } }],
    labels: { en: "Shade" } },
]);
const productAttribute = {
  scope: "product", required: true, cardinality: { min: 1, max: 1 },
  public: true, filterable: false, facetable: false,
} as const;

export const pack = {
  id: "cosmetics", namespace: "cosmo", version: 1, openlupRange: "1.x",
  capabilities: {}, taxClasses: [{ key: "standard" }],
  types: [{
    ...options, ...type, taxClass: "standard", netContentUnits: ["openlup:g"],
    units: [
      { code: "openlup:g", dimension: "mass", integral: false,
        factor: { canonicalUnit: "openlup:g", unscaled: "1", scale: 0 } },
      { code: "openlup:ml", dimension: "volume", integral: false,
        factor: { canonicalUnit: "openlup:ml", unscaled: "1", scale: 0 } },
      ...variants.map(({ unit, volume }) => ({
        code: unit, dimension: "volume" as const, integral: false,
        factor: { canonicalUnit: "openlup:ml" as const, unscaled: volume, scale: 0 },
      })),
    ],
    attributes: [
      ...options.attributes,
      { ...productAttribute, key: "inci", displayOrder: 2, labels: { en: "INCI" },
        valueType: { kind: "text", maxLength: 2000 } },
      { ...productAttribute, key: "pao_months", displayOrder: 3, labels: { en: "Months after opening" },
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

const skus = variants.map(({ id, unit, volume, mass, shade, sequence }) => {
  const value = { dimension: "volume", unit, unscaled: "1", scale: 0 } as const;
  return {
    id, productId, code: `LUMENFEN-${volume}-${shade.toUpperCase()}`,
    options: { volume: { kind: "quantity" as const, value }, shade: { kind: "choice" as const, value: shade } },
    attributes: { volume: value, shade },
    netContent: { dimension: "mass" as const, unit: "openlup:g", unscaled: mass, scale: 0 },
    identifiers: [{ scheme: "gs1:gtin", issuer: "cosmo:internal",
      value: catalogInternalGtin(sequence), packagingLevel: "unit" as const }],
  };
});

const draft: CatalogDraftPayloadV3 = {
  schemaVersion: 3,
  product: {
    id: productId, type, dimensions: ["volume", "shade"], slug: "lumenfen-foundation", primarySkuId: variants[0].id,
    attributes: { inci: "Aqua, Glycerin", pao_months: "12" },
    sharedContent: {
      schemaVersion: 1, catalogAction: "create", presentation: { title },
      offerMemberships: [], requestedModes: [], publicationSkus: [],
    },
  },
  skus,
  publication: {
    kind: "release", evidence: {},
    operations: [{ op: "create_product", productId, productSlug: "lumenfen-foundation", name: title }],
  },
};

export const referenceEntry = { pack, drafts: [draft] };

const combination = {
  type, input: { axes: ["volume", "shade"], typed: true, retained: [],
    incoming: skus.map(({ id, options: optionValues }) => ({ skuId: id, state: "active" as const, optionValues })) },
};
export const offlineFixture = {
  ...referenceEntry,
  quantities: skus.map(({ attributes }) => ({ type, value: attributes.volume, targetUnit: "openlup:ml" })),
  combinations: [combination],
} satisfies CatalogConformanceSubject["packs"][number];

const first = skus[0]!;
export const negativeFixture = {
  ...offlineFixture,
  combinations: [{ ...combination, input: { ...combination.input,
    incoming: [{ skuId: first.id, state: "active", optionValues: { shade: first.options.shade } }] } }],
} satisfies CatalogConformanceSubject["packs"][number];
