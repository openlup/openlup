import { defineCatalogPack } from "@openlup/platform/catalog";

export const pack = defineCatalogPack({
  id: "stationery", namespace: "stationery", version: 1, openlupRange: "^0.44.0",
  capabilities: { prepaid: false },
  taxClasses: [{ key: "standard" }],
  subscriptionProfiles: [{ key: "stationery:delivery", version: 1 }],
  subscriptionProfileDefinitions: [{
    key: "stationery:delivery", version: 1, allowedCadenceDays: [28, 120],
    quantities: { minBaseUnits: 1, maxBaseUnits: 4, maxUnitsPerLine: 4, maxBaseLines: 2 },
    addons: { allowedTypeRefs: [], maxLines: 0, maxUnits: 0 },
    swapGroupKeys: [], consumption: { kind: "fixed_units" }, prepaid: "unsupported",
  }],
  types: [{
    key: "stationery:notebook", version: 1, taxClass: "standard",
    subscriptionProfileRef: { key: "stationery:delivery", version: 1 },
    validatorRef: "sha256:05ed336435f8944961eb7fbe9d7916f1ee402adf24ff73f2210b2e6eb4ac0f89",
    units: [
      { code: "stationery:each", dimension: "count", integral: true,
        factor: { canonicalUnit: "openlup:piece", unscaled: "1", scale: 0 } },
      { code: "stationery:gram", dimension: "mass", integral: false,
        factor: { canonicalUnit: "openlup:g", unscaled: "1", scale: 0 } },
    ],
    netContentUnits: ["stationery:each"],
    attributes: [{ key: "lined", scope: "variant", valueType: { kind: "boolean" }, required: true,
      cardinality: { min: 1, max: 1 }, filterable: true, facetable: true, public: true, displayOrder: 0, labels: { en: "Lined" } }],
    dimensions: [{ key: "lined", kind: "boolean" }],
    axes: [{ key: "lined", attributeKey: "lined" }],
    validateContent(content: unknown) {
      if (content && typeof content === "object" && "document" in content && content.document
        && typeof content.document === "object" && "title" in content.document && typeof content.document.title === "string"
        && content.document.title.trim()) return [];
      return [{ path: "document.title", code: "title_required" }];
    },
  }],
});
