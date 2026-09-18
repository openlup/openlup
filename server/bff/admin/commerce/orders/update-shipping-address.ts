import { withObservedRoute } from "../../../../_lib/observability/route.js";
import type { VercelRequest, VercelResponse } from "../../../../_lib/types/vercel.js";
import { sendBffError } from "../../../../_lib/bff/response.js";
import { createAdminCommerceOrderUpdateShippingAddressHandler } from "../../../../domains/commerce/commerceOmsHandlers.js";
import {
  createSupabaseCommerceOmsPort,
  type CommerceOmsSupabaseClient,
} from "../../../../adapters/supabase/commerceOmsPort.js";
import {
  authorizeCommerceAdminWithUser,
  createAdminAuthClient,
  createServiceRoleClient,
  readBearerToken,
  readSupabaseAdminCommerceEnv,
} from "../shared.js";

function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const env = readSupabaseAdminCommerceEnv();
  if (!env) {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Admin commerce OMS is not configured");
    return Promise.resolve();
  }

  const accessToken = readBearerToken(req);
  const authClient = createAdminAuthClient(env, accessToken);
  const serviceClient = createServiceRoleClient(env);

  return createAdminCommerceOrderUpdateShippingAddressHandler({
    omsPort: createSupabaseCommerceOmsPort(serviceClient as unknown as CommerceOmsSupabaseClient),
    authorizeAdmin: () => authorizeCommerceAdminWithUser(authClient, accessToken),
  })(req, res);
}

export default withObservedRoute({
  route: "/api/bff/admin/commerce/orders/update-shipping-address",
  domain: "commerce",
  surface: "admin",
  risk: "mutation",
}, handler);
