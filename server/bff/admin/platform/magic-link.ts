import { readObservedResponseContext } from "../../../_lib/observability/requestContext.js";
import { createAdminMagicLinkHandler } from "@openlup/platform/identity";
import { withObservedRoute } from "../../../_lib/observability/route.js";
import type { VercelRequest, VercelResponse } from "../../../_lib/types/vercel.js";
import {
  readSupabaseAdminServiceEnv,
} from "../../../_lib/admin-domain/auth.js";
import {
  createAdminMagicLinkRuntime,
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

const ADMIN_AUTH_CALLBACK_PATH = "/admin/auth/callback";

async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  return createAdminMagicLinkHandler({
    responseRequestId: (res) => readObservedResponseContext(res)?.requestId,
    requestSchema: adminMagicLinkRequestSchema, responseSchema: adminMagicLinkResponseSchema,
    readEnvironment: readSupabaseAdminServiceEnv, createRuntime: createAdminMagicLinkRuntime,
    checkAttempt: checkAndRecordAdminMagicLinkAttempt, extractClientIp, padResponseTime,
    resolveOrigin: readRequestOrigin, callbackPath: ADMIN_AUTH_CALLBACK_PATH,
  })(req, res);
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
