import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import { sendBffError } from "../../_lib/bff/response.js";
import { withObservedRoute } from "../../_lib/observability/route.js";
import { createCustomerBillingProfilesHandler } from "../../domains/customers/customerBillingProfilesHandler.js";
import { createSupabaseCustomerAccountV2Port } from "../../adapters/supabase/customerAccountV2Port.js";
import {
  authenticateCustomerUser,
  customerSelfServiceEnabled,
} from "./shared.js";
import { composeCustomerSelfService } from "./_compose.js";

async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (!customerSelfServiceEnabled()) {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Customer self-service is disabled", {
      details: { feature: "customer_self_service", reason: "feature_flag_disabled" },
    });
    return;
  }
  const ctx = composeCustomerSelfService(req, res);
  if (!ctx) return;
  const { accessToken, clients } = ctx;
  const port = createSupabaseCustomerAccountV2Port(clients);
  return createCustomerBillingProfilesHandler({
    billingPort: port,
    authenticateUser: () => authenticateCustomerUser(clients.customerClient, accessToken),
  })(req, res);
}

export default withObservedRoute({
  route: "/api/bff/customers/billing-profiles",
  domain: "customers",
  surface: "customer",
  risk: "mutation",
  featureFlags: ["COMMERCE_CUSTOMER_SELF_SERVICE_ENABLED", "COMMERCE_V2_W12_CUSTOMER_AUTH_UI"],
}, handler);
