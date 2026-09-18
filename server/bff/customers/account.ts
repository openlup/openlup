import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import { sendBffError } from "../../_lib/bff/response.js";
import { withObservedRoute } from "../../_lib/observability/route.js";
import { createCustomerAccountHandler } from "../../domains/customers/customerAccountHandler.js";
import { withCustomerAccountReadStage } from "../../domains/customers/customerAccountReadDiagnostics.js";
import { createSupabaseCustomerSelfServicePort } from "../../adapters/supabase/customerSelfService.js";
import { createCustomerDeliveryAlignmentRowsReader } from "../../adapters/subscriptionDeliveryAlignmentGateway.js";
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
  const port = createSupabaseCustomerSelfServicePort(clients, createCustomerDeliveryAlignmentRowsReader(clients.serviceClient));
  return createCustomerAccountHandler({
    accountPort: {
      ...port,
      getAccount: (userId) => withCustomerAccountReadStage("account_aggregate", () => port.getAccount(userId)),
    },
    authenticateUser: () => authenticateCustomerUser(clients.customerClient, accessToken),
  })(req, res);
}

export default withObservedRoute({
  route: "/api/bff/customers/account",
  domain: "customers",
  surface: "customer",
  risk: "read",
  featureFlags: ["COMMERCE_CUSTOMER_SELF_SERVICE_ENABLED","COMMERCE_V2_W12_CUSTOMER_AUTH_UI"],
}, handler);
