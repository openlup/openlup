import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import { sendBffError } from "../../_lib/bff/response.js";
import { withObservedRoute } from "../../_lib/observability/route.js";
import { createCustomerPaymentMethodsHandler } from "../../domains/customers/customerPaymentMethodsHandler.js";
import { createSupabaseCustomerPaymentMethodsPort } from "../../adapters/supabase/customerProfilePorts.js";
import {
  authenticateCustomerUser,
  customerSelfServiceEnabled,
} from "./shared.js";
import { composeCustomerSelfService } from "./_compose.js";

async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (!customerPaymentMethodsEnabled()) {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Customer payment methods are disabled", {
      details: {
        feature: "customer_payment_methods",
        reason: "feature_flag_disabled",
      },
    });
    return;
  }

  const ctx = composeCustomerSelfService(req, res);
  if (!ctx) return;
  const { accessToken, clients } = ctx;
  return createCustomerPaymentMethodsHandler({
    paymentMethodsPort: createSupabaseCustomerPaymentMethodsPort(clients.customerClient, clients.serviceClient),
    authenticateUser: () => authenticateCustomerUser(clients.customerClient, accessToken),
  })(req, res);
}

function customerPaymentMethodsEnabled(): boolean {
  return customerSelfServiceEnabled();
}

export default withObservedRoute({
  route: "/api/bff/customers/payment-methods",
  domain: "customers",
  surface: "customer",
  risk: "read",
  featureFlags: ["COMMERCE_CUSTOMER_SELF_SERVICE_ENABLED","COMMERCE_V2_W12_CUSTOMER_AUTH_UI"],
}, handler);
