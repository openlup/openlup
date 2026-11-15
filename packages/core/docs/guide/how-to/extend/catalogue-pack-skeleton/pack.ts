import { defineCatalogPack } from "@openlup/platform/catalog/contracts";

/** Fictional stationery metadata, unbound. The artifact pin is illustrative, not installation evidence. */
export const pack = defineCatalogPack({
  id: "stationery", namespace: "stationery", version: 1, openlupRange: "^0.44.0",
  capabilities: {}, taxClasses: [{ key: "standard" }],
  types: [{
    key: "stationery:notebook", version: 1, taxClass: "standard",
    validatorRef: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    units: [{ code: "stationery:each", dimension: "count", integral: true,
      factor: { canonicalUnit: "openlup:piece", unscaled: "1", scale: 0 } }],
    netContentUnits: ["stationery:each"], dimensions: [],
    validateContent: (_content: unknown) => [],
  }],
});
