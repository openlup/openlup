import { withObservedRoute } from "../../_lib/observability/route.js";
import { customerAuthUiEnabled } from "../../_lib/config/featureFlags.js";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import { sendBffError } from "../../_lib/bff/response.js";
import { createCustomerMeHandler } from "../../domains/customers/customerMeHandler.js";
import { createCustomerIdentityBinding } from "../../runtime/customers/customerIdentityBinding.js";

/**
 * GET /api/bff/customers/me — HIDDEN passwordless customer profile (W12.1).
 *
 * Fail-closed: the feature flag is checked FIRST and we return before binding
 * identity or data access. Managed reads retain the bearer-bound anon client;
 * direct PostgreSQL reads use the verified subject in an authenticated actor
 * transaction. Both paths rely on own-row RLS and expose no service-role path.
 */
async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (!customerAuthUiEnabled()) {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Customer accounts are disabled", {
      details: {
        feature: "customer_auth",
        featureFlag: "COMMERCE_V2_W12_CUSTOMER_AUTH_UI",
        reason: "feature_flag_disabled",
      },
    });
    return;
  }

  const binding = createCustomerIdentityBinding(req, process.env);
  if (!binding) {
    sendBffError(res, "INTERNAL", "Supabase environment is not configured");
    return;
  }

  return createCustomerMeHandler(binding)(req, res);
}

export default withObservedRoute({
  route: "/api/bff/customers/me",
  domain: "customers",
  surface: "customer",
  risk: "mutation",
  featureFlags: ["COMMERCE_V2_W12_CUSTOMER_AUTH_UI"],
}, handler);
