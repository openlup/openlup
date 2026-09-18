import { withObservedRoute } from "../../_lib/observability/route.js";
import type { HttpRequest, HttpResponse } from "../../_lib/types/http.js";
import { sendBffError } from "../../_lib/bff/response.js";
import { localReferenceDemoProfileEnabled, createLocalReferenceDemoSellableCatalogPort } from "../../adapters/localReferenceStoreAdapter.js";
import { createReferenceCatalogItemsHandler } from "../../domains/catalog/referenceCatalogHandler.js";

async function handler(req: HttpRequest, res: HttpResponse): Promise<void> {
  // Fail before constructing any service-capable dependency. This route is
  // intentionally invisible outside a local loopback demo process.
  if (!localReferenceDemoProfileEnabled()) {
    sendBffError(res, "NOT_FOUND", "Reference catalog not found");
    return;
  }
  return createReferenceCatalogItemsHandler({
    catalogPort: createLocalReferenceDemoSellableCatalogPort(),
  })(req, res);
}

export default withObservedRoute({
  route: "/api/bff/catalog/items",
  domain: "catalog",
  surface: "public",
  risk: "read",
  featureFlags: [],
}, handler);
