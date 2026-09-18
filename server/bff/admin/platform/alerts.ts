import { createSupabaseDataGateway } from "../../../adapters/supabase/dataGateway.js";
import { readSupabaseDataGatewayEnv } from "../../../adapters/supabase/dataGatewayClientFactory.js";
import { withObservedRoute } from "../../../_lib/observability/route.js";
import type { VercelRequest, VercelResponse } from "../../../_lib/types/vercel.js";
import { sendBffError } from "../../../_lib/bff/response.js";
import { createAdminAlertsOverviewHandler } from "../../../domains/platform/adminAlertsHandlers.js";
import { createGatewayAdminAlertsReadPort } from "../../../adapters/supabase/platform/adminAlertsPort.js";
import {
  authorizeAdminWithUser,
  createAdminAuthClient,
  readBearerToken,
  readSupabaseAdminAuthEnv,
} from "../../../_lib/admin-domain/auth.js";

async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  // Identity is checked with a user-scoped anon client (canonical admin pattern);
  // the ledger read then goes through the platform data gateway, because
  // platform_alerts REVOKEs ALL from `authenticated` and needs service-role.
  const authEnv = readSupabaseAdminAuthEnv();
  const gatewayEnv = readSupabaseDataGatewayEnv();
  if (!authEnv || !gatewayEnv) {
    sendBffError(res, "INTERNAL", "Supabase environment is not configured");
    return;
  }

  const accessToken = readBearerToken(req);
  const authClient = createAdminAuthClient(authEnv, accessToken);

  return createAdminAlertsOverviewHandler({
    readPort: createGatewayAdminAlertsReadPort(createSupabaseDataGateway(gatewayEnv)),
    // Admin only: distributors must not see platform alerts.
    authorizeAdmin: () => authorizeAdminWithUser(authClient, accessToken, { allowedRoles: ["admin"] }),
  })(req, res);
}

// Deliberately no featureFlags entry: withObservedRoute's featureFlags are log
// metadata, not a gate. Declaring one here would imply a protection this route
// does not have. Access is controlled by admin authentication; the browser
// surface is gated separately by VITE_PLATFORM_ALERTS_ADMIN_ENABLED.
export default withObservedRoute({
  route: "/api/bff/admin/platform/alerts",
  domain: "platform",
  surface: "admin",
  risk: "read",
}, handler);
