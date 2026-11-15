import { draftsFor } from "@openlup/platform/catalog/contracts";
import { pack } from "./pack.ts";

/** A v1 proposal only; prices, attribute values and publication are separate owners. */
export const drafts = draftsFor(pack)([{
  schemaVersion: 1,
  product: { id: "00000000-0000-4000-8000-000000000001", type: { key: "stationery:notebook", version: 1 },
    slug: "notebook", dimensions: [], sharedContent: { title: "Notebook" },
    primarySkuId: "00000000-0000-4000-8000-000000000002" },
  skus: [{ id: "00000000-0000-4000-8000-000000000002", productId: "00000000-0000-4000-8000-000000000001",
    code: "NOTEBOOK", options: {}, netContent: { dimension: "count", unit: "stationery:each", unscaled: "1", scale: 0 } }],
}]);
