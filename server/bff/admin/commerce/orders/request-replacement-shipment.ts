import { withObservedRoute } from "../../../../_lib/observability/route.js";
import type { VercelRequest, VercelResponse } from "../../../../_lib/types/vercel.js";
import { sendBffError } from "../../../../_lib/bff/response.js";
import { createAdminCommerceOrderRequestReplacementShipmentHandler } from "../../../../domains/commerce/commerceOmsReplacementShipmentHandler.js";
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

  return createAdminCommerceOrderRequestReplacementShipmentHandler({
    omsPort: createSupabaseCommerceOmsPort(serviceClient as unknown as CommerceOmsSupabaseClient),
    authorizeAdmin: () => authorizeCommerceAdminWithUser(authClient, accessToken),
  })(req, res);
}

// No `featureFlags` entry, and that is a decision rather than an omission: see
// section 4 of docs/plan/oms-replacement-r2c-operator-surface.md. The command is
// admin-authenticated, reachable only from one operator button, and refuses closed
// eighteen ways before it mutates anything.
export default withObservedRoute({
  route: "/api/bff/admin/commerce/orders/request-replacement-shipment",
  domain: "commerce",
  surface: "admin",
  risk: "mutation",
}, handler);
