import { withObservedRoute } from "../../_lib/observability/route.js";
import { customerAuthUiEnabled } from "../../_lib/config/featureFlags.js";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import { sendBffError, sendBffSuccess, sendMethodNotAllowed } from "../../_lib/bff/response.js";
import { z } from "../../../src/lib/validation/zod.js";
import { resolveCustomerSessionBinding } from "../../runtime/customers/customerSessionBinding.js";

const customerOtpVerifyRequestSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(160),
  token: z.string().trim().min(16).max(256),
}).strict();

const customerOtpVerifyResponseSchema = z.object({
  accessToken: z.string().min(1),
  expiresAt: z.string().datetime({ offset: true }),
  user: z.object({ id: z.guid(), email: z.string().email() }).strict(),
}).strict();

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

async function handler(
  req: VercelRequest,
  res: VercelResponse,
  resolveSession: SessionResolver,
): Promise<void> {
  if (!customerAuthUiEnabled()) {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Customer accounts are disabled");
    return;
  }
  if (req.method !== "POST") return sendMethodNotAllowed(res, ["POST"]);
  const request = customerOtpVerifyRequestSchema.safeParse(req.body);
  if (!request.success) {
    sendBffError(res, "BAD_REQUEST", "Invalid one-time code request", { details: request.error.flatten() });
    return;
  }
  const resolved = resolveSession(process.env);
  if (!resolved.binding) {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Customer auth is not configured", {
      details: { feature: "customer_auth", reason: resolved.error },
    });
    return;
  }
  const session = await resolved.binding.verifyChallenge(request.data.token);
  if (!session) {
    sendBffError(res, "UNAUTHORIZED", "One-time code is invalid or expired");
    return;
  }
  sendBffSuccess(res, customerOtpVerifyResponseSchema.parse(session));
}

export default withObservedRoute({
  route: "/api/bff/customers/verify-otp",
  domain: "customers",
  surface: "customer",
  risk: "mutation",
  featureFlags: ["COMMERCE_V2_W12_CUSTOMER_AUTH_UI"],
}, (req, res) => handler(req, res, resolveCustomerSessionBinding));
