import { withObservedRoute } from "../../../../_lib/observability/route.js";
import type { VercelRequest, VercelResponse } from "../../../../_lib/types/vercel.js";
import { composeAdminCatalog } from "./_compose.js";
import { createAdminCatalogListHandler } from "../../../../domains/commerce/adminCatalogReadHandler.js";
import { createSupabaseAdminCatalogReadDataPort } from "../../../../adapters/supabase/adminCatalogRead.js";
import { authorizeCommerceAdminWithUser } from "../shared.js";

function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const ctx = composeAdminCatalog(req, res);
  if (!ctx) return Promise.resolve();
  const { accessToken, authClient, serviceClient } = ctx;
  return createAdminCatalogListHandler({
    dataPort: createSupabaseAdminCatalogReadDataPort(serviceClient),
    authorizeAdmin: () => authorizeCommerceAdminWithUser(authClient, accessToken),
  })(req, res);
}

export default withObservedRoute(
  {
    route: "/api/bff/admin/commerce/catalog/list",
    domain: "commerce",
    surface: "admin",
    risk: "read",
  },
  handler,
);
