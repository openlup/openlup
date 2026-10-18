import { readObservedResponseContext } from "../../_lib/observability/requestContext.js";
import { createCustomerVerifyOtpHandler } from "@openlup/platform/identity";
import { withObservedRoute } from "../../_lib/observability/route.js";
import { customerAuthUiEnabled } from "../../_lib/config/featureFlags.js";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import { resolveCustomerSessionBinding } from "../../runtime/customers/customerSessionBinding.js";

type SessionResolver = typeof resolveCustomerSessionBinding;

export function createCustomerVerifyOtpRoute(
  resolveSession: SessionResolver = resolveCustomerSessionBinding,
) {
  return withObservedRoute({
    route: "/api/bff/customers/verify-otp",
    domain: "customers",
    surface: "customer",
    risk: "mutation",
    featureFlags: ["COMMERCE_V2_W12_CUSTOMER_AUTH_UI"],
  }, (req, res) => handler(req, res, resolveSession));
}

async function handler(req: VercelRequest, res: VercelResponse, resolveSession: SessionResolver): Promise<void> {
  return createCustomerVerifyOtpHandler({ responseRequestId: (res) => readObservedResponseContext(res)?.requestId, enabled: customerAuthUiEnabled, env: process.env, resolveSession })(req, res);
}
export default withObservedRoute({
  route: "/api/bff/customers/verify-otp",
  domain: "customers",
  surface: "customer",
  risk: "mutation",
  featureFlags: ["COMMERCE_V2_W12_CUSTOMER_AUTH_UI"],
}, (req, res) => handler(req, res, resolveCustomerSessionBinding));
