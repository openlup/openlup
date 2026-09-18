import { withObservedRoute } from "../../../_lib/observability/route.js";
import type { VercelRequest, VercelResponse } from "../../../_lib/types/vercel.js";
import {
  sendBffError,
  sendBffSuccess,
  sendMethodNotAllowed,
} from "../../../_lib/bff/response.js";
import {
  readSupabaseAdminServiceEnv,
} from "../../../_lib/admin-domain/auth.js";
import {
  createAdminMagicLinkRuntime,
  type AdminMagicLinkAuthClient,
} from "../../../adapters/supabase/platform/adminPlatformPort.js";
import {
  adminMagicLinkRequestSchema,
  adminMagicLinkResponseSchema,
} from "../../../../src/domains/platform/contracts.js";
import {
  checkAndRecordAdminMagicLinkAttempt,
  extractClientIp,
} from "../../../_lib/rate-limit/adminMagicLinkRateLimit.js";
import {
  deployedRuntimeAssumed,
  productionEnvironmentMarkerPresent,
  unlabelledEnvironment,
} from "../../../_lib/observability/environment.js";
import { padResponseTime } from "../../../_lib/timing.js";

const ADMIN_MAGIC_LINK_RESPONSE_FLOOR_MS = 400;
const ADMIN_AUTH_CALLBACK_PATH = "/admin/auth/callback";

async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== "POST") {
    sendMethodNotAllowed(res, ["POST"]);
    return;
  }

  const request = adminMagicLinkRequestSchema.safeParse(req.body);
  if (!request.success) {
    sendBffError(res, "BAD_REQUEST", "Invalid admin magic-link request", {
      details: request.error.flatten(),
    });
    return;
  }

  const env = readSupabaseAdminServiceEnv();
  if (!env) {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Admin auth is not configured", {
      details: { feature: "admin_auth", requiredEnv: "SUPABASE_SERVICE_ROLE_KEY" },
    });
    return;
  }

  const startedAt = Date.now();
  const runtime = createAdminMagicLinkRuntime(env);

  const decision = await checkAndRecordAdminMagicLinkAttempt({
    client: runtime.rateLimitClient,
    ip: extractClientIp(req.headers),
    email: request.data.email,
  });

  if (!decision.allowed && decision.reason === "rpc_error") {
    console.warn("admin_magic_link_rate_limit_unavailable", JSON.stringify({ reason: decision.reason }));
    await padResponseTime(startedAt, ADMIN_MAGIC_LINK_RESPONSE_FLOOR_MS);
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Magic link service temporarily unavailable");
    return;
  }

  if (decision.allowed) {
    let eligibility: Awaited<ReturnType<typeof runtime.platformPort.checkAdminMagicLinkEligibility>>;
    try {
      eligibility = await runtime.platformPort.checkAdminMagicLinkEligibility(request.data.email);
    } catch {
      console.warn("admin_magic_link_lookup_failed", JSON.stringify({ outcome: "lookup_error" }));
      await padResponseTime(startedAt, ADMIN_MAGIC_LINK_RESPONSE_FLOOR_MS);
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Magic link service temporarily unavailable");
      return;
    }

    if (eligibility === "eligible") {
      const origin = readRequestOrigin(req);
      if (origin) {
        const outcome = await sendMagicLink(runtime.authClient, request.data.email, origin);
        console.info(
          "admin_magic_link_outcome",
          JSON.stringify({ outcome: outcome.status, code: outcome.code ?? null }),
        );
      } else {
        console.warn("admin_magic_link_outcome", JSON.stringify({ outcome: "bad_origin" }));
      }
    } else {
      console.warn("admin_magic_link_outcome", JSON.stringify({ outcome: eligibility }));
    }
  } else {
    console.warn(
      "admin_magic_link_outcome",
      JSON.stringify({ outcome: "rate_limited", reason: decision.reason ?? "unknown" }),
    );
  }

  await padResponseTime(startedAt, ADMIN_MAGIC_LINK_RESPONSE_FLOOR_MS);
  sendBffSuccess(res, adminMagicLinkResponseSchema.parse({ accepted: true }));
}

async function sendMagicLink(
  client: AdminMagicLinkAuthClient,
  email: string,
  origin: string,
): Promise<{ status: "sent" | "auth_error" | "threw"; code?: string }> {
  try {
    const { error } = await client.auth.signInWithOtp({
      email,
      options: {
        shouldCreateUser: false,
        emailRedirectTo: `${origin}${ADMIN_AUTH_CALLBACK_PATH}`,
      },
    });

    if (error) {
      console.warn("admin_magic_link_send_failed", JSON.stringify({ code: error.name ?? "AuthError" }));
      return { status: "auth_error", code: error.name ?? "AuthError" };
    }
    return { status: "sent" };
  } catch (error) {
    const code = error instanceof Error ? error.name : "unknown";
    console.warn("admin_magic_link_send_threw", JSON.stringify({ error: code }));
    return { status: "threw", code };
  }
}

function readRequestOrigin(req: VercelRequest): string | null {
  const appBaseUrl = process.env.APP_BASE_URL?.trim();
  if (appBaseUrl) {
    const origin = normalizeOrigin(appBaseUrl);
    if (origin) return origin;
    console.warn("admin_magic_link_origin", JSON.stringify({ outcome: "invalid_app_base_url" }));
    return null;
  }

  const compatibilityOrigin = process.env.SITE_URL?.trim();
  if (compatibilityOrigin) {
    const origin = normalizeOrigin(compatibilityOrigin);
    if (origin) return origin;
    console.warn("admin_magic_link_origin", JSON.stringify({ outcome: "invalid_configured_origin" }));
    return null;
  }

  // Production never derives a passwordless callback from a spoofable header.
  if (productionEnvironmentMarkerPresent(process.env)) {
    console.warn(
      "admin_magic_link_origin",
      JSON.stringify({ outcome: "missing_configured_origin_production", remedy: "set APP_BASE_URL" }),
    );
    return null;
  } else if (unlabelledEnvironment(process.env)) {
    console.warn(
      "admin_magic_link_origin",
      JSON.stringify({
        outcome: "missing_explicit_origin_unknown_env",
        remedy: "set APP_BASE_URL or declare the application environment",
      }),
    );
    return null;
  }

  const protoHeader = firstHeader(req.headers["x-forwarded-proto"]) ?? "https";
  const proto = protoHeader === "http" || protoHeader === "https" ? protoHeader : "https";
  const host = firstHeader(req.headers["x-forwarded-host"]) ?? firstHeader(req.headers.host);

  const onDeploy = deployedRuntimeAssumed(process.env);
  if (!host) return onDeploy ? null : `${proto}://localhost`;

  const origin = normalizeOrigin(`${proto}://${host}`);
  if (!origin) return null;

  const hostname = new URL(origin).hostname.toLowerCase();
  const isLoopback = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  if (isLoopback && onDeploy) return null;

  return origin;
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
  route: "/api/bff/admin/platform/magic-link",
  domain: "platform",
  surface: "admin",
  risk: "mutation",
}, handler);
