// eslint-disable-next-line no-restricted-imports -- copied application example using the installed Platform authoring entry
import { defineCatalogPack } from "@openlup/platform/catalog";

export const pack = defineCatalogPack({
  id: "stationery", namespace: "stationery", version: 1, openlupRange: "1.x",
  capabilities: {}, taxClasses: [{ key: "standard" }],
  types: [{
    key: "stationery:notebook", version: 1, taxClass: "standard",
    units: [
      { code: "openlup:g", dimension: "mass", integral: false,
        factor: { canonicalUnit: "openlup:g", unscaled: "1", scale: 0 } },
      { code: "stationery:each", dimension: "count", integral: true,
        factor: { canonicalUnit: "openlup:piece", unscaled: "1", scale: 0 } },
    ],
    netContentUnits: ["openlup:g"],
    attributes: [{ key: "lined", scope: "variant", valueType: { kind: "boolean" }, required: true,
      cardinality: { min: 1, max: 1 }, filterable: true, facetable: true, public: true,
      displayOrder: 0, labels: { en: "Lined" } }],
    dimensions: [{ key: "lined", kind: "boolean" }],
    axes: [{ key: "lined", attributeKey: "lined" }],
    validateContent(content: unknown) {
      const presentation = content && typeof content === "object" && "presentation" in content
        ? content.presentation : undefined;
      if (presentation && typeof presentation === "object" && "title" in presentation
        && typeof presentation.title === "string" && presentation.title.trim()) return [];
      return [{ path: "presentation.title", code: "title_required" }];
    },
  }],
});
