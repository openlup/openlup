import type { VercelRequest, VercelResponse } from "../../../_lib/types/vercel.js";
import { sendBffError } from "../../../_lib/bff/response.js";
import { withObservedRoute } from "../../../_lib/observability/route.js";
import { createCustomerOrderDetailHandler } from "../../../domains/customers/customerOrdersHandler.js";
import { createSupabaseCustomerAccountV2Port } from "../../../adapters/supabase/customerAccountV2Port.js";
import {
  authenticateCustomerUser,
  createCustomerClients,
  customerSelfServiceEnabled,
  readBearerToken,
  readCustomerSelfServiceEnv,
} from "../shared.js";

async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (!customerSelfServiceEnabled()) {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Customer self-service is disabled", {
      details: { feature: "customer_self_service", reason: "feature_flag_disabled" },
    });
    return;
  }
  const env = readCustomerSelfServiceEnv();
  if (!env) return sendBffError(res, "INTERNAL", "Supabase environment is not configured");
  const accessToken = readBearerToken(req);
  const clients = createCustomerClients(env, accessToken);
  const port = createSupabaseCustomerAccountV2Port(clients);
  return createCustomerOrderDetailHandler({
    ordersPort: port,
    authenticateUser: () => authenticateCustomerUser(clients.customerClient, accessToken),
  })(req, res);
}

export default withObservedRoute({
  route: "/api/bff/customers/orders/detail",
  domain: "customers",
  surface: "customer",
  risk: "read",
  featureFlags: ["COMMERCE_CUSTOMER_SELF_SERVICE_ENABLED", "COMMERCE_V2_W12_CUSTOMER_AUTH_UI"],
}, handler);
