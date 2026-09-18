import { withObservedRoute } from "../../../../_lib/observability/route.js";
import type { VercelRequest, VercelResponse } from "../../../../_lib/types/vercel.js";
import { composeAdminCatalog } from "./_compose.js";
import { createAdminCatalogActivateHandler } from "../../../../domains/commerce/adminCatalogHandler.js";
import { createSupabaseAdminCatalogDataPort } from "../../../../adapters/supabase/adminCatalog.js";
import { authorizeCommerceAdminWithUser } from "../shared.js";

function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const ctx = composeAdminCatalog(req, res);
  if (!ctx) return Promise.resolve();
  const { accessToken, authClient, serviceClient } = ctx;
  return createAdminCatalogActivateHandler({
    dataPort: createSupabaseAdminCatalogDataPort(serviceClient),
    authorizeAdmin: () => authorizeCommerceAdminWithUser(authClient, accessToken),
  })(req, res);
}

export default withObservedRoute(
  {
    route: "/api/bff/admin/commerce/catalog/activate",
    domain: "commerce",
    surface: "admin",
    risk: "mutation",
  },
  handler,
);
