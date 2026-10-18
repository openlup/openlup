import { bindManagedIdentityEmailTrust } from "../../runtime/auth/emailTrustBinding.js";
import { createReconcileAccountHandler } from "@openlup/platform/identity";
import { customerAuthUiEnabled } from "../../_lib/config/featureFlags.js";
import { withObservedRoute } from "../../_lib/observability/route.js";
import { readObservedResponseContext } from "../../_lib/observability/requestContext.js";
import { sendBffError } from "../../_lib/bff/response.js";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import { createSupabaseIdentityVerifier } from "@openlup/platform/identity";
import { createSupabaseAccountLinkStore } from "@openlup/platform/identity";
import { createCustomerClients, readCustomerRouteEnv, readCustomerSelfServiceEnv, readBearerToken } from "./shared.js";

async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (!customerAuthUiEnabled()) {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Customer accounts are disabled");
    return;
  }
  const env = readCustomerSelfServiceEnv();
  if (!env) {
    sendBffError(res, "INTERNAL", "Supabase environment is not configured");
    return;
  }
  const clients = createCustomerClients(env, readBearerToken(req));
  return createReconcileAccountHandler({
    verifier: createSupabaseIdentityVerifier(clients.customerClient),
    store: createSupabaseAccountLinkStore(clients.serviceClient),
    emailTrustPolicy: { assess: () => bindManagedIdentityEmailTrust(readCustomerRouteEnv(), env).assess() },
    responseRequestId: (response) => readObservedResponseContext(response)?.requestId,
  })(req, res);
}
export default withObservedRoute({
  route: "/api/bff/customers/reconcile-account", domain: "customers", surface: "customer", risk: "mutation",
  featureFlags: ["COMMERCE_V2_W12_CUSTOMER_AUTH_UI"],
}, handler);
