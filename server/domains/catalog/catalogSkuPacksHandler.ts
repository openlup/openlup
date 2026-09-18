import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import {
  sendBffError,
  sendBffSuccess,
  sendMethodNotAllowed,
} from "../../_lib/bff/response.js";
import { adminCatalogSkuPacksResponseSchema } from "../../../src/domains/catalog/contracts.js";
import type { CatalogSkuPacksReadPort } from "../../../src/domains/catalog/ports.js";

export interface CatalogSkuPacksHandlerDeps {
  packsPort: CatalogSkuPacksReadPort;
  authorizeAdmin: (req: VercelRequest) => Promise<boolean>;
}

// Admin read endpoint (Wave H) over catalog_sku_eans — a read-only per-SKU EAN/pack projection for
// the CatalogPage packs panel. Read-only: it never mutates packs (push/pull own writes).
export function createCatalogSkuPacksHandler({
  packsPort,
  authorizeAdmin,
}: CatalogSkuPacksHandlerDeps) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method !== "GET") {
      sendMethodNotAllowed(res, ["GET"]);
      return;
    }

    let authorized = false;
    try {
      authorized = await authorizeAdmin(req);
    } catch {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Admin authorization failed");
      return;
    }

    if (!authorized) {
      sendBffError(res, "UNAUTHORIZED", "Admin session required");
      return;
    }

    try {
      const result = await packsPort.getCatalogSkuPacks();
      const response = adminCatalogSkuPacksResponseSchema.safeParse(result);
      if (!response.success) {
        sendBffError(res, "INVALID_RESPONSE", "Catalog packs returned invalid response");
        return;
      }
      sendBffSuccess(res, response.data);
    } catch {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Catalog packs read failed");
    }
  };
}
