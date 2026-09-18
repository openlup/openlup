import { withObservedRoute } from "../../../../_lib/observability/route.js";
import type { VercelRequest, VercelResponse } from "../../../../_lib/types/vercel.js";
import { composeAdminCatalog } from "./_compose.js";
import { createAdminCatalogDeactivateHandler } from "../../../../domains/commerce/adminCatalogHandler.js";
import { createSupabaseAdminCatalogDataPort } from "../../../../adapters/supabase/adminCatalog.js";
import { authorizeCommerceAdminWithUser } from "../shared.js";

/**
 * Compatibility route for the retired deactivate mutation. It preserves the
 * normal admin authorization path and then returns the W3c mutation-fence
 * refusal; it cannot deactivate a product.
 */
function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const ctx = composeAdminCatalog(req, res);
  if (!ctx) return Promise.resolve();
  const { accessToken, authClient, serviceClient } = ctx;
  return createAdminCatalogDeactivateHandler({
    dataPort: createSupabaseAdminCatalogDataPort(serviceClient),
    authorizeAdmin: () => authorizeCommerceAdminWithUser(authClient, accessToken),
  })(req, res);
}

export default withObservedRoute(
  {
    route: "/api/bff/admin/commerce/catalog/deactivate",
    domain: "commerce",
    surface: "admin",
    risk: "mutation",
  },
  handler,
);
