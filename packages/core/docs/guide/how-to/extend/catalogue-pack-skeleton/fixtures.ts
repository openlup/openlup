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
  drafts: [{ schemaVersion: 1, product: { id: productId, type, dimensions: ["lined"], sharedContent: { title: "Notebook" } },
    skus: [{ id: skuId, productId, options, netContent: count }] }],
  quantities: [{ type, value: count }],
  attributes: [{ type, input: { skus: [{ id: skuId, attributes: { lined: true } }] }, publicationRevision: "1" }],
  combinations: [{ type, input: { axes: ["lined"], typed: true, retained: [],
    incoming: [{ skuId, state: "active", optionValues: options }] } }],
} satisfies Omit<CatalogConformanceSubject["packs"][number], "pack">;
