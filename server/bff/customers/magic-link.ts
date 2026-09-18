import { withObservedRoute } from "../../_lib/observability/route.js";
import { customerAuthUiEnabled } from "../../_lib/config/featureFlags.js";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import {
  sendBffError,
  sendBffSuccess,
  sendMethodNotAllowed,
} from "../../_lib/bff/response.js";
import {
  customerMagicLinkRequestSchema,
  customerMagicLinkResponseSchema,
} from "../../../src/domains/customers/contracts.js";
import {
  checkAndRecordCustomerMagicLinkAttempt,
  extractClientIp,
  type CustomerMagicLinkRateLimitClient,
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
  type CustomerSupabaseClient,
} from "./shared.js";
import { resolveBundleId } from "../../domains/platform-runtime/platformKernel.js";
import { resolveCustomerSessionBinding } from "../../runtime/customers/customerSessionBinding.js";

type SessionResolver = typeof resolveCustomerSessionBinding;

/**
 * Latency floor (ms) applied to every terminal response so timing does not
 * reveal which code path ran — success, quota denial, user-not-found, or the
 * fail-closed rpc_error 503 all return after the same floor.
 */
const MAGIC_LINK_RESPONSE_FLOOR_MS = 400;

/**
 * POST /api/bff/customers/magic-link — hidden passwordless auth request (W12.1).
 *
 * Valid email requests always receive the same accepted response. Supabase Auth
 * errors and rate-limit denials are deliberately not surfaced to avoid account
 * enumeration and OTP spam feedback loops.
 */
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

async function handler(
  req: VercelRequest,
  res: VercelResponse,
  resolveSession: SessionResolver,
): Promise<void> {
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

  if (req.method !== "POST") {
    sendMethodNotAllowed(res, ["POST"]);
    return;
  }

  const request = customerMagicLinkRequestSchema.safeParse(req.body);
  if (!request.success) {
    sendBffError(res, "BAD_REQUEST", "Invalid magic-link request", {
      details: request.error.flatten(),
    });
    return;
  }

  if (resolveBundleId(process.env) === "node-postgres") {
    const startedAt = Date.now();
    const resolved = resolveSession(process.env);
    if (!resolved.binding) {
      await padResponseTime(startedAt, MAGIC_LINK_RESPONSE_FLOOR_MS);
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Customer auth is not configured", {
        details: { feature: "customer_auth", reason: resolved.error },
      });
      return;
    }
    await resolved.binding.requestChallenge(request.data.email);
    await padResponseTime(startedAt, MAGIC_LINK_RESPONSE_FLOOR_MS);
    sendAccepted(res);
    return;
  }

  const env = readCustomerSelfServiceEnv();
  if (!env) {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Customer auth is not configured", {
      details: {
        feature: "customer_auth",
        requiredEnv: "SUPABASE_URL/SUPABASE_ANON_KEY/SUPABASE_SERVICE_ROLE_KEY",
      },
    });
    return;
  }

  const startedAt = Date.now();

  // Quota admission is a trusted-server operation. Keep its service credential
  // separate from the anonymous Auth client so it cannot send customer OTPs.
  const anonymousAuthClient = createCustomerClient(env, null);
  const rateLimitClient = createCustomerServiceClient(env);

  const decision = await checkAndRecordCustomerMagicLinkAttempt({
    client: rateLimitClient as unknown as CustomerMagicLinkRateLimitClient,
    ip: extractClientIp(req.headers),
    email: request.data.email,
  });

  // Fail closed when the limiter itself is down: a downed rate limiter must not
  // open a brute-force / enumeration window. Pad to the same floor as accepted
  // paths so the 503 is not distinguishable by response speed.
  if (!decision.allowed && decision.reason === "rpc_error") {
    console.warn(
      "customer_magic_link_rate_limit_unavailable",
      JSON.stringify({ reason: decision.reason }),
    );
    await padResponseTime(startedAt, MAGIC_LINK_RESPONSE_FLOOR_MS);
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Magic link service temporarily unavailable");
    return;
  }

  if (decision.allowed) {
    const origin = readRequestOrigin(req);
    if (origin) {
      const outcome = await sendMagicLink(
        anonymousAuthClient,
        request.data.email,
        origin,
        request.data.locale,
        request.data.returnTo,
      );
      console.info(
        "customer_magic_link_outcome",
        JSON.stringify({ outcome: outcome.status, code: outcome.code ?? null, locale: request.data.locale }),
      );
    } else {
      // No trustworthy origin on a deploy: a magic link built from a localhost
      // origin would be dead on arrival (links to the user's machine, not the
      // app). Skip the send rather than email a broken link, but still return
      // the same accepted response + timing floor so the bad-config path is not
      // distinguishable from a real send.
      console.warn("customer_magic_link_outcome", JSON.stringify({ outcome: "bad_origin" }));
    }
  } else {
    console.warn(
      "customer_magic_link_outcome",
      JSON.stringify({ outcome: "rate_limited", reason: decision.reason ?? "unknown" }),
    );
  }

  // Every accepted terminal path (magic link sent, user-not-found, quota denial)
  // shares the same latency floor so timing does not leak which one ran.
  await padResponseTime(startedAt, MAGIC_LINK_RESPONSE_FLOOR_MS);
  sendAccepted(res);
}

async function sendMagicLink(
  client: CustomerSupabaseClient,
  email: string,
  origin: string,
  locale: "pl" | "en",
  returnTo?: string,
): Promise<{ status: "sent" | "auth_error" | "threw"; code?: string }> {
  try {
    const callbackUrl = new URL(customerAuthCallbackPath(locale), origin);
    if (returnTo) callbackUrl.searchParams.set("returnTo", returnTo);
    const { error } = await client.auth.signInWithOtp({
      email,
      options: {
        shouldCreateUser: false,
        emailRedirectTo: callbackUrl.toString(),
      },
    });

    if (error) {
      console.warn("customer_magic_link_send_failed", JSON.stringify({ code: error.name }));
      return { status: "auth_error", code: error.name };
    }
    return { status: "sent" };
  } catch (error) {
    const code = error instanceof Error ? error.name : "unknown";
    console.warn(
      "customer_magic_link_send_threw",
      JSON.stringify({ error: code }),
    );
    return { status: "threw", code };
  }
}

function customerAuthCallbackPath(locale: "pl" | "en"): string {
  return locale === "en" ? "/account/auth/callback" : "/konto/auth/callback";
}

function sendAccepted(res: VercelResponse): void {
  sendBffSuccess(res, customerMagicLinkResponseSchema.parse({ accepted: true }));
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
