import type { VercelRequest, VercelResponse } from "../../../_lib/types/vercel.js";
import { pspRecoveryEnabled, subscriptionMutationsEnabled } from "../../../_lib/config/featureFlags.js";
import { sendBffError } from "../../../_lib/bff/response.js";
import { withObservedRoute } from "../../../_lib/observability/route.js";
import { createCustomerPaymentRecoveryStartHandler } from "../../../domains/customers/customerPaymentRecoveryStartHandler.js";
import { createSupabaseCustomerSubscriptionFacadePort } from "../../../adapters/supabase/customerSubscriptionFacade.js";
import {
  authenticateCustomerUser,
  createCustomerClients,
  customerSelfServiceEnabled,
  readBearerToken,
  readCustomerSelfServiceEnv,
} from "../shared.js";

async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (!customerPaymentRecoveryStartEnabled()) {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Customer payment recovery start is disabled", {
      details: { feature: "customer_payment_recovery_start", reason: "feature_flag_disabled" },
    });
    return;
  }

  const env = readCustomerSelfServiceEnv();
  if (!env) {
    sendBffError(res, "INTERNAL", "Supabase environment is not configured");
    return;
  }

  const accessToken = readBearerToken(req);
  const clients = createCustomerClients(env, accessToken);
  const port = createSupabaseCustomerSubscriptionFacadePort(clients);
  return createCustomerPaymentRecoveryStartHandler({
    paymentRecoveryStartPort: port,
    authenticateUser: () => authenticateCustomerUser(clients.customerClient, accessToken),
  })(req, res);
}

function customerPaymentRecoveryStartEnabled(): boolean {
  return customerSelfServiceEnabled() &&
    subscriptionMutationsEnabled() &&
    pspRecoveryEnabled();
}

export default withObservedRoute({
  route: "/api/bff/customers/payment-recovery/start",
  domain: "customers",
  surface: "customer",
  risk: "mutation",
  featureFlags: ["COMMERCE_CUSTOMER_SELF_SERVICE_ENABLED","COMMERCE_V2_W12_CUSTOMER_AUTH_UI","COMMERCE_SUBSCRIPTION_MUTATIONS_ENABLED","COMMERCE_PSP_RECOVERY_ENABLED"],
}, handler);
