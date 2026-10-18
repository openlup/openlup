import { readObservedResponseContext } from "../../_lib/observability/requestContext.js";
import { createCustomerMagicLinkHandler } from "@openlup/platform/identity";
import { withObservedRoute } from "../../_lib/observability/route.js";
import { customerAuthUiEnabled } from "../../_lib/config/featureFlags.js";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import {
  customerMagicLinkRequestSchema,
  customerMagicLinkResponseSchema,
} from "../../../src/domains/customers/contracts.js";
import {
  checkAndRecordCustomerMagicLinkAttempt,
  extractClientIp,
} from "../../_lib/rate-limit/customerMagicLinkRateLimit.js";
import { padResponseTime } from "../../_lib/timing.js";
import {
  createCustomerClient,
  createCustomerServiceClient,
  readCustomerSelfServiceEnv,
} from "./shared.js";
import { resolveCustomerSessionBinding } from "../../runtime/customers/customerSessionBinding.js";

type SessionResolver = typeof resolveCustomerSessionBinding;

export function createCustomerMagicLinkRoute(
  resolveSession: SessionResolver = resolveCustomerSessionBinding,
) {
  return withObservedRoute({
    route: "/api/bff/customers/magic-link",
    domain: "customers",
    surface: "customer",
    risk: "mutation",
    featureFlags: ["COMMERCE_V2_W12_CUSTOMER_AUTH_UI"],
  }, (req, res) => handler(req, res, resolveSession));
}

async function handler(req: VercelRequest, res: VercelResponse, resolveSession: SessionResolver): Promise<void> {
  return createCustomerMagicLinkHandler({
    responseRequestId: (res) => readObservedResponseContext(res)?.requestId,
    enabled: customerAuthUiEnabled, env: process.env,
    disabledDetails: { featureFlag: "COMMERCE_V2_W12_CUSTOMER_AUTH_UI" },
    requestSchema: customerMagicLinkRequestSchema, responseSchema: customerMagicLinkResponseSchema,
    readEnvironment: readCustomerSelfServiceEnv, createCustomerClient, createCustomerServiceClient,
    checkAttempt: checkAndRecordCustomerMagicLinkAttempt, extractClientIp, padResponseTime,
    redirectOrigins: [process.env.APP_BASE_URL?.trim() || process.env.CUSTOMER_AUTH_REDIRECT_ORIGIN?.trim() || ""], callbackPath: customerAuthCallbackPath, resolveSession,
  })(req, res);
}
function customerAuthCallbackPath(locale: "pl" | "en"): string {
  return locale === "en" ? "/account/auth/callback" : "/konto/auth/callback";
}
export default withObservedRoute({
  route: "/api/bff/customers/magic-link",
  domain: "customers",
  surface: "customer",
  risk: "mutation",
  featureFlags: ["COMMERCE_V2_W12_CUSTOMER_AUTH_UI"],
}, (req, res) => handler(req, res, resolveCustomerSessionBinding));
