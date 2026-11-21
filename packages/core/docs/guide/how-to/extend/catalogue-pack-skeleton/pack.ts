// eslint-disable-next-line no-restricted-imports -- copied application example using the installed Platform authoring entry
import { defineCatalogPack } from "@openlup/platform/catalog";

export const pack = defineCatalogPack({
  id: "stationery", namespace: "stationery", version: 1, openlupRange: "1.x",
  capabilities: {}, taxClasses: [{ key: "standard" }],
  types: [{
    key: "stationery:notebook", version: 1, taxClass: "standard",
    units: [{ code: "stationery:each", dimension: "count", integral: true,
      factor: { canonicalUnit: "openlup:piece", unscaled: "1", scale: 0 } }],
    netContentUnits: ["stationery:each"],
    attributes: [{ key: "lined", scope: "variant", valueType: { kind: "boolean" }, required: true,
      cardinality: { min: 1, max: 1 }, filterable: true, facetable: true, public: true,
      displayOrder: 0, labels: { en: "Lined" } }],
    dimensions: [{ key: "lined", kind: "boolean" }],
    axes: [{ key: "lined", attributeKey: "lined" }],
    validateContent(content: unknown) {
      if (content && typeof content === "object" && "title" in content
        && typeof content.title === "string" && content.title.trim()) return [];
      return [{ path: "title", code: "title_required" }];
    },
  }],
});
