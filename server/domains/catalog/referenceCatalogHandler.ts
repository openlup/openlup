import type { HttpRequest, HttpResponse } from "../../_lib/types/http.js";
import {
  sendBffError,
  sendBffSuccess,
  sendMethodNotAllowed,
} from "../../_lib/bff/response.js";
import {
  SELLABLE_CATALOG_CONTRACT_VERSION,
  sellableCatalogListResponseSchema,
} from "../../../src/domains/catalog/contracts.js";
import type { SellableCatalogPort } from "../../../src/domains/catalog/ports.js";

export function createReferenceCatalogItemsHandler({
  catalogPort,
}: {
  catalogPort: SellableCatalogPort;
}) {
  return async function handler(req: HttpRequest, res: HttpResponse): Promise<void> {
    if (req.method !== "GET") {
      sendMethodNotAllowed(res, ["GET"]);
      return;
    }

    try {
      const response = sellableCatalogListResponseSchema.safeParse({
        contractVersion: SELLABLE_CATALOG_CONTRACT_VERSION,
        profile: await catalogPort.getStorefrontProfile(),
        items: await catalogPort.listSellableItems(),
      });
      if (!response.success) {
        sendBffError(res, "INVALID_RESPONSE", "Reference catalog returned invalid items");
        return;
      }
      sendBffSuccess(res, response.data, { contractVersion: SELLABLE_CATALOG_CONTRACT_VERSION }, {
        cacheControl: "no-store",
      });
    } catch {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Reference catalog is unavailable");
    }
  };
}
