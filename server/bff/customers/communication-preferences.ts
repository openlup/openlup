import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import { sendBffError } from "../../_lib/bff/response.js";
import { withObservedRoute } from "../../_lib/observability/route.js";
import { createCustomerCommunicationPreferencesHandler } from "../../domains/communications/customerCommunicationPreferencesHandler.js";
import { customerSelfServiceEnabled } from "./shared.js";
import { createCustomerCommunicationPreferencesBinding } from "../../runtime/customers/customerCommunicationPreferencesBinding.js";
import { resolveBundleId } from "../../domains/platform-runtime/platformKernel.js";

async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (!customerSelfServiceEnabled()) {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Customer self-service is disabled", {
      details: { feature: "customer_self_service", reason: "feature_flag_disabled" },
    });
    return;
  }

  const binding = createCustomerCommunicationPreferencesBinding(req);
  if (!binding) {
    if (resolveBundleId(process.env) === "node-postgres") {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Customer self-service is not configured");
    } else {
      // Preserve the managed composition's existing failure envelope.
      sendBffError(res, "INTERNAL", "Supabase environment is not configured");
    }
    return;
  }
  return createCustomerCommunicationPreferencesHandler(binding)(req, res);
}

export default withObservedRoute({
  route: "/api/bff/customers/communication-preferences",
  domain: "communications",
  surface: "customer",
  risk: "validation_mutation",
  featureFlags: ["COMMERCE_CUSTOMER_SELF_SERVICE_ENABLED", "COMMERCE_V2_W12_CUSTOMER_AUTH_UI"],
}, handler);
