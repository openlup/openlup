import { createMagicLinkOriginResolver, normalizeMagicLinkReturnPath } from "./authVerifyUrl.js";
import { createIdentityResponder, type IdentityResponseOptions } from "./response.js";
import type { HttpRequest, HttpResponse } from "../http/index.js";
import { resolveBundleId } from "../kernel/index.js";
import type { MagicLinkAuthClient, MagicLinkRateLimitClient, MagicLinkDecision } from "./magicLinkPorts.js";
import { resolveCustomerSessionBinding } from "./customerSessionBinding.js";
import type { z } from "zod";
export type CustomerMagicLinkEnvironment = { url: string; anonKey: string; serviceRoleKey: string };
export interface CustomerMagicLinkHandlerOptions<E extends CustomerMagicLinkEnvironment = CustomerMagicLinkEnvironment> extends IdentityResponseOptions {
  enabled: () => boolean;
  env: Record<string, string | undefined>;
  disabledDetails?: Record<string, unknown>;
  requestSchema: z.ZodType<{ email: string; locale: "pl" | "en"; returnTo?: string }>;
  responseSchema: z.ZodType<{ accepted: true }>;
  readEnvironment: () => E | null;
  createCustomerClient: (env: E, token: null) => MagicLinkAuthClient;
  createCustomerServiceClient: (env: E) => unknown;
  checkAttempt: (input: { client: MagicLinkRateLimitClient; ip: string; email: string }) => Promise<MagicLinkDecision>;
  extractClientIp: (headers: HttpRequest["headers"]) => string;
  padResponseTime: (startedAt: number, floor: number) => Promise<void>;
  redirectOrigins?: readonly string[];
  resolveOrigin?: (req: HttpRequest) => string | null;
  callbackPath: (locale: "pl" | "en") => string;
  resolveSession: typeof resolveCustomerSessionBinding;
}
const MAGIC_LINK_RESPONSE_FLOOR_MS = 400;
export function createCustomerMagicLinkHandler<E extends CustomerMagicLinkEnvironment>(options: CustomerMagicLinkHandlerOptions<E>) {
const { sendBffError, sendBffSuccess, sendMethodNotAllowed } = createIdentityResponder(options);
const readRequestOrigin = options.resolveOrigin ?? createMagicLinkOriginResolver(options.redirectOrigins ?? []);
const { enabled: customerAuthUiEnabled, env: environment, readEnvironment: readCustomerSelfServiceEnv, createCustomerClient, createCustomerServiceClient, checkAttempt: checkAndRecordCustomerMagicLinkAttempt, extractClientIp, padResponseTime, requestSchema: customerMagicLinkRequestSchema, responseSchema: customerMagicLinkResponseSchema, resolveSession, callbackPath: customerAuthCallbackPath } = options;
return async (req: HttpRequest, res: HttpResponse): Promise<void> => {
  if (!customerAuthUiEnabled()) {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Customer accounts are disabled", {
      details: {
        feature: "customer_auth",
        ...options.disabledDetails,
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

  const startedAt = Date.now();
  const origin = readRequestOrigin(req);
  if (!origin) {
    await padResponseTime(startedAt, MAGIC_LINK_RESPONSE_FLOOR_MS);
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Magic link origin is not configured", {
      details: { reason: "magic_link_origin_not_configured" },
    });
    return;
  }

  if (resolveBundleId(environment) === "node-postgres") {
    const resolved = resolveSession(environment);
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

  const anonymousAuthClient = createCustomerClient(env, null);
  const rateLimitClient = createCustomerServiceClient(env);

  const decision = await checkAndRecordCustomerMagicLinkAttempt({
    client: rateLimitClient as unknown as MagicLinkRateLimitClient,
    ip: extractClientIp(req.headers),
    email: request.data.email,
  });
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
    const outcome = await sendMagicLink(
      anonymousAuthClient,
      request.data.email,
      origin,
      request.data.locale,
      normalizeMagicLinkReturnPath(request.data.returnTo, origin),
    );
    console.info(
      "customer_magic_link_outcome",
      JSON.stringify({ outcome: outcome.status, code: outcome.code ?? null, locale: request.data.locale }),
    );
  } else {
    console.warn(
      "customer_magic_link_outcome",
      JSON.stringify({ outcome: "rate_limited", reason: decision.reason ?? "unknown" }),
    );
  }
  await padResponseTime(startedAt, MAGIC_LINK_RESPONSE_FLOOR_MS);
  sendAccepted(res);
};

async function sendMagicLink(
  client: MagicLinkAuthClient,
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

function sendAccepted(res: HttpResponse): void {
  sendBffSuccess(res, customerMagicLinkResponseSchema.parse({ accepted: true }));
}


}
