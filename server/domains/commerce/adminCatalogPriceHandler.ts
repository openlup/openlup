import type { AdminPromotionsDataPort } from "./adminPromotionsDataPort.js";
import type { AuthorizeCommerceAdmin } from "./adminPromotionsHandler.js";
import { createLegacyCatalogMutationFenceHandler } from "./adminCatalogHandler.js";

/**
 * W3c fence for the duplicate legacy price route. Authentication remains in
 * force, then the route returns the same refusal as the generic catalog writes.
 */

export interface AdminCatalogPriceHandlerDeps {
  dataPort: AdminPromotionsDataPort;
  authorizeAdmin: AuthorizeCommerceAdmin;
}

export function createAdminCatalogPriceHandler({
  authorizeAdmin,
}: AdminCatalogPriceHandlerDeps) {
  return createLegacyCatalogMutationFenceHandler(authorizeAdmin);
}
