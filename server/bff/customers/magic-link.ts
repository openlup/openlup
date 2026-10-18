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
import {
  deployedRuntimeAssumed,
  productionEnvironmentMarkerPresent,
  unlabelledEnvironment,
} from "../../_lib/observability/environment.js";
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
    resolveOrigin: readRequestOrigin, callbackPath: customerAuthCallbackPath, resolveSession,
  })(req, res);
}
function customerAuthCallbackPath(locale: "pl" | "en"): string {
  return locale === "en" ? "/account/auth/callback" : "/konto/auth/callback";
}
/** Resolve the callback origin without making request headers production authority. */
function readRequestOrigin(req: VercelRequest): string | null {
  const appBaseUrl = process.env.APP_BASE_URL?.trim();
  if (appBaseUrl) {
    const origin = normalizeOrigin(appBaseUrl);
    if (origin) return origin;
    console.warn("customer_magic_link_origin", JSON.stringify({ outcome: "invalid_app_base_url" }));
    return null;
  }

  const compatibilityOrigin = process.env.CUSTOMER_AUTH_REDIRECT_ORIGIN?.trim();
  if (compatibilityOrigin) return compatibilityOrigin.replace(/\/+$/, "");

  if (productionEnvironmentMarkerPresent(process.env)) {
    console.warn(
      "customer_magic_link_origin",
      JSON.stringify({ outcome: "missing_configured_origin_production", remedy: "set APP_BASE_URL" }),
    );
    return null;
  } else if (unlabelledEnvironment(process.env)) {
    console.warn(
      "customer_magic_link_origin",
      JSON.stringify({
        outcome: "missing_explicit_origin_unknown_env",
        remedy: "set APP_BASE_URL or declare the application environment",
      }),
    );
    return null;
  }

  const proto = firstHeader(req.headers["x-forwarded-proto"]) ?? "https";
  const host = firstHeader(req.headers["x-forwarded-host"]) ?? firstHeader(req.headers.host);

  const onDeploy = deployedRuntimeAssumed(process.env);
  if (!host) return onDeploy ? null : `${proto}://localhost`;

  const hostname = host.split(":")[0]?.toLowerCase();
  const isLoopback = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  if (isLoopback && onDeploy) return null;

  return `${proto}://${host}`;
}

function normalizeOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

function firstHeader(value: string | string[] | undefined): string | null {
  if (typeof value === "string" && value.trim()) return value.split(",")[0]?.trim() ?? null;
  if (Array.isArray(value) && typeof value[0] === "string" && value[0].trim()) {
    return value[0].split(",")[0]?.trim() ?? null;
  }
  return null;
}

export default withObservedRoute({
  route: "/api/bff/customers/magic-link",
  domain: "customers",
  surface: "customer",
  risk: "mutation",
  featureFlags: ["COMMERCE_V2_W12_CUSTOMER_AUTH_UI"],
}, (req, res) => handler(req, res, resolveCustomerSessionBinding));
