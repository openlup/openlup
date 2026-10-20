import type { HttpRequest, HttpResponse } from "../http/index.js";
import type { BffResponder } from "../bff/index.js";
import {
  SELLABLE_CATALOG_CONTRACT_VERSION,
  sellableCatalogListResponseSchema,
} from "./sellableSchemas.js";
import type { SellableCatalogPort } from "./readPorts.js";

export function createReferenceCatalogItemsHandler({
  catalogPort, responder,
}: {
  catalogPort: SellableCatalogPort;
  responder: BffResponder;
}) {
  const { sendBffError, sendBffSuccess, sendMethodNotAllowed } = responder;
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
