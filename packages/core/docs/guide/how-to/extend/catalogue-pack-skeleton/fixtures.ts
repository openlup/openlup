// eslint-disable-next-line no-restricted-imports -- copied application example using the installed fixture types
import type { CatalogConformanceSubject } from "@openlup/platform/catalog/testing";
import { pack } from "./pack.ts";

const { key, version } = pack.types[0];
const type = { key, version };
const productId = "00000000-0000-4000-8000-000000000001";
const skuId = "00000000-0000-4000-8000-000000000002";
const count = { dimension: "count", unit: "stationery:each", unscaled: "1", scale: 0 } as const;
const options = { lined: { kind: "boolean", value: true } } as const;

export const fixtures = {
  drafts: [{
    schemaVersion: 3,
    product: {
      id: productId, type, slug: "notebook", dimensions: ["lined"], primarySkuId: skuId,
      sharedContent: {
        schemaVersion: 1, catalogAction: "create", presentation: { title: "Notebook" },
        offerMemberships: [], requestedModes: [], publicationSkus: [],
      },
    },
    skus: [{
      id: skuId, productId, code: "NOTEBOOK", options, attributes: { lined: true },
      netContent: { dimension: "mass", unit: "openlup:g", unscaled: "100", scale: 0 },
      identifiers: [{ scheme: "gs1:gtin", issuer: "stationery", value: "5901234123457", packagingLevel: "unit" }],
    }],
    publication: {
      kind: "release", evidence: {},
      operations: [{ op: "create_product", productId, productSlug: "notebook", name: "Notebook" }],
    },
  }],
  quantities: [{ type, value: count }],
  attributes: [{ type, input: { skus: [{ id: skuId, attributes: { lined: true } }] }, publicationRevision: "1" }],
  combinations: [{ type, input: { axes: ["lined"], typed: true, retained: [],
    incoming: [{ skuId, state: "active", optionValues: options }] } }],
} satisfies Omit<CatalogConformanceSubject["packs"][number], "pack">;
