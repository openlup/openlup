import { createIdentityResponder, type IdentityResponseOptions } from "./response.js";
import type { z } from "zod";
import type { HttpRequest, HttpResponse } from "../http/index.js";
import type { MagicLinkAuthClient, MagicLinkRateLimitClient, MagicLinkDecision } from "./magicLinkPorts.js";
export interface AdminMagicLinkHandlerOptions extends IdentityResponseOptions {
  requestSchema: z.ZodType<{ email: string }>;
  responseSchema: z.ZodType<{ accepted: true }>;
  readEnvironment: () => { url: string; anonKey: string; serviceRoleKey: string } | null;
  createRuntime: (env: { url: string; anonKey: string; serviceRoleKey: string }) => {
    authClient: MagicLinkAuthClient;
    rateLimitClient: MagicLinkRateLimitClient;
    platformPort: { checkAdminMagicLinkEligibility(email: string): Promise<string> };
  };
  checkAttempt: (input: { client: MagicLinkRateLimitClient; ip: string; email: string }) => Promise<MagicLinkDecision>;
  extractClientIp: (headers: HttpRequest["headers"]) => string;
  padResponseTime: (startedAt: number, floor: number) => Promise<void>;
  resolveOrigin: (req: HttpRequest) => string | null;
  callbackPath: string;
}
const ADMIN_MAGIC_LINK_RESPONSE_FLOOR_MS = 400;
export function createAdminMagicLinkHandler(options: AdminMagicLinkHandlerOptions) {
const { sendBffError, sendBffSuccess, sendMethodNotAllowed } = createIdentityResponder(options);
const { requestSchema: adminMagicLinkRequestSchema, responseSchema: adminMagicLinkResponseSchema, readEnvironment: readSupabaseAdminServiceEnv, createRuntime: createAdminMagicLinkRuntime, checkAttempt: checkAndRecordAdminMagicLinkAttempt, extractClientIp, padResponseTime, resolveOrigin: readRequestOrigin } = options;
return async (req: HttpRequest, res: HttpResponse): Promise<void> => {
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
};

async function sendMagicLink(
  client: MagicLinkAuthClient,
  email: string,
  origin: string,
): Promise<{ status: "sent" | "auth_error" | "threw"; code?: string }> {
  try {
    const { error } = await client.auth.signInWithOtp({
      email,
      options: {
        shouldCreateUser: false,
        emailRedirectTo: `${origin}${options.callbackPath}`,
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


}
