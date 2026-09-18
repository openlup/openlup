import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import { customerAddressesFlagEnabled, customerAuthUiEnabled } from "../../_lib/config/featureFlags.js";
import { sendBffError } from "../../_lib/bff/response.js";
import { withObservedRoute } from "../../_lib/observability/route.js";
import { consoleOperationalEventRecorder } from "../../_lib/observability/operationalEvents.js";
import { createCustomerAddressesHandler } from "../../domains/customers/customerAddressesHandler.js";
import { createSupabaseCustomerSelfServicePort } from "../../adapters/supabase/customerSelfService.js";
import { createSupabaseCustomerAddressBookPort } from "../../adapters/supabase/customerProfilePorts.js";
import {
  authenticateCustomerUser,
  createCustomerClient,
  createCustomerServiceClient,
  customerSelfServiceEnabled,
  readBearerToken,
  readCustomerSupabaseReadEnv,
  readCustomerSelfServiceEnv,
} from "./shared.js";
import type { CustomerSelfServiceEnv, CustomerSupabaseReadEnv } from "./shared.js";

async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (!customerAddressesEnabled(req)) {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Customer addresses are disabled", {
      details: { feature: "customer_addresses", reason: "feature_flag_disabled" },
    });
    return;
  }

  const env = req.method === "GET" ? readCustomerSupabaseReadEnv() : readCustomerSelfServiceEnv();
  if (!env) {
    sendBffError(res, "INTERNAL", "Supabase environment is not configured");
    return;
  }

  const accessToken = readBearerToken(req);
  const customerClient = createCustomerClient(env, accessToken);
  const mutationPort = isCustomerSelfServiceEnv(env)
    ? createSupabaseCustomerSelfServicePort({
      customerClient,
      serviceClient: createCustomerServiceClient(env),
      operationalEvents: consoleOperationalEventRecorder,
    })
    : undefined;
  return createCustomerAddressesHandler({
    addressBookPort: createSupabaseCustomerAddressBookPort(customerClient),
    addressMutationPort: mutationPort,
    authenticateUser: () => authenticateCustomerUser(customerClient, accessToken),
  })(req, res);
}

function customerAddressesEnabled(req: VercelRequest): boolean {
  const base = customerAuthUiEnabled() && customerAddressesFlagEnabled();
  return req.method === "GET" ? base : base && customerSelfServiceEnabled();
}

function isCustomerSelfServiceEnv(
  env: CustomerSelfServiceEnv | CustomerSupabaseReadEnv,
): env is CustomerSelfServiceEnv {
  return "serviceRoleKey" in env && typeof env.serviceRoleKey === "string";
}

export default withObservedRoute({
  route: "/api/bff/customers/addresses",
  domain: "customers",
  surface: "customer",
  risk: "mutation",
  featureFlags: [
    "COMMERCE_CUSTOMER_ADDRESSES_ENABLED",
    "COMMERCE_CUSTOMER_SELF_SERVICE_ENABLED",
    "COMMERCE_V2_W12_CUSTOMER_AUTH_UI",
  ],
}, handler);
