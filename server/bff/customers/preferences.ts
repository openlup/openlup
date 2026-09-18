import { withObservedRoute } from "../../_lib/observability/route.js";
import { customerAuthUiEnabled, customerPreferencesFlagEnabled } from "../../_lib/config/featureFlags.js";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import { sendBffError } from "../../_lib/bff/response.js";
import { createCustomerPaymentPreferencesHandler } from "../../domains/customers/customerPreferencesHandler.js";
import { createSupabaseCustomerPaymentPreferencesPort } from "../../adapters/supabase/customerPreferencePorts.js";
import {
  authenticateCustomerUser,
  createCustomerClient,
  readBearerToken,
  readCustomerSupabaseReadEnv,
} from "./shared.js";

async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (!customerPreferencesEnabled()) {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Customer preferences are disabled", {
      details: {
        feature: "customer_preferences",
        featureFlag: "COMMERCE_CUSTOMER_PREFERENCES_ENABLED",
        reason: "feature_flag_disabled",
      },
    });
    return;
  }

  const env = readCustomerSupabaseReadEnv();
  if (!env) {
    sendBffError(res, "INTERNAL", "Supabase environment is not configured");
    return;
  }

  const accessToken = readBearerToken(req);
  const client = createCustomerClient(env, accessToken);

  return createCustomerPaymentPreferencesHandler({
    preferencesPort: createSupabaseCustomerPaymentPreferencesPort(client),
    authenticateUser: () => authenticateCustomerUser(client, accessToken),
  })(req, res);
}

function customerPreferencesEnabled(): boolean {
  return customerAuthUiEnabled() && customerPreferencesFlagEnabled();
}

export default withObservedRoute({
  route: "/api/bff/customers/preferences",
  domain: "customers",
  surface: "customer",
  risk: "mutation",
  featureFlags: ["COMMERCE_CUSTOMER_PREFERENCES_ENABLED","COMMERCE_V2_W12_CUSTOMER_AUTH_UI"],
}, handler);
