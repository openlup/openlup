import { withObservedRoute } from "../../../_lib/observability/route.js";
import type { VercelRequest, VercelResponse } from "../../../_lib/types/vercel.js";
import { sendBffError } from "../../../_lib/bff/response.js";
import { createAdminShippingRateHandler } from "../../../domains/commerce/adminShippingRateHandler.js";
import {
  createSupabaseAdminPromotionsDataPort,
  type AdminPromotionsSupabaseClient,
} from "../../../adapters/supabase/adminPromotions.js";
import {
  authorizeCommerceAdminWithUser,
  createAdminAuthClient,
  createServiceRoleClient,
  readBearerToken,
  readSupabaseAdminCommerceEnv,
} from "./shared.js";

function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const env = readSupabaseAdminCommerceEnv();
  if (!env) {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Admin shipping rate is not configured");
    return Promise.resolve();
  }

  const accessToken = readBearerToken(req);
  const authClient = createAdminAuthClient(env, accessToken);
  const serviceClient = createServiceRoleClient(env);

  return createAdminShippingRateHandler({
    dataPort: createSupabaseAdminPromotionsDataPort(
      serviceClient as unknown as AdminPromotionsSupabaseClient,
    ),
    authorizeAdmin: () => authorizeCommerceAdminWithUser(authClient, accessToken),
  })(req, res);
}

export default withObservedRoute(
  {
    route: "/api/bff/admin/commerce/shipping-rate",
    domain: "commerce",
    surface: "admin",
    risk: "mutation",
  },
  handler,
);
