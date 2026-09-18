/**
 * The Auth Send Email hook. Live, not a candidate.
 *
 * Supabase Auth targets `/api/auth-send-email` in staging and production - the
 * hooks were repointed here on 2026-09-04 and the hosted Edge Functions were
 * undeployed the same day, so this owns the raw-stream, signature, render/send
 * and ledger contract for every magic link, recovery and confirmation the
 * product sends. Rotating its signing secret is a human-only control-plane act.
 */
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import { readHiddenPreviewEnabled, readObservedEnvironment } from "../../_lib/observability/environment.js";
import { renderEmail } from "../../../src/domains/communications/email/render.js";
import { readEmailOriginConfiguration, resolveEmailOrigin, type EmailOriginPolicyError } from "../../../src/domains/communications/email/originPolicy.js";
import type { EmailBrand } from "../../../src/lib/brand/brandConfig.js";
import { buildAuthVerifyUrl } from "./authVerifyUrl.js";
import {
  AuthEmailContentUnavailableError,
  type AuthEmailContentPort,
  type AuthEmailPersistencePort,
  type AuthEmailTransportPort,
  type AuthEmailTransportResult,
} from "./ports.js";
import { verifyStandardWebhookSignature } from "./standardWebhooks.js";

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
};

const KNOWN_ACTION_TYPES = new Set([
  "magiclink", "signup", "recovery", "invite", "email_change",
  "email_change_current", "email_change_new", "email",
]);

interface SendEmailHookPayload {
  user?: { id?: string; email?: string; user_metadata?: Record<string, unknown> | null };
  email_data?: {
    token?: string;
    token_hash?: string;
    redirect_to?: string;
    email_action_type?: string;
    site_url?: string;
  };
}

export interface AuthSendEmailHookDeps {
  transport: AuthEmailTransportPort;
  persistence: AuthEmailPersistencePort;
  content: AuthEmailContentPort;
  fromEmail: string;
  hookSecret: string;
  authServiceUrl: string;
  /** App-layer defaults injected at composition; no brand/env ownership lives here. */
  defaultOrigin: string;
  productionEmailHosts: string[];
  legacyBaseUrl?: string | null;
  emailBrandForOrigin: (origin: string) => EmailBrand;
  defaultSandboxRecipient: string;
  defaultRedirectTo?: string;
  env: Record<string, string | undefined>;
  now?: () => number;
}

type AuthEmailDeliveryMode = "standard" | "sandbox_recipient" | "production_like_real";
function json(res: VercelResponse, status: number, body: unknown): void {
  for (const [key, value] of Object.entries(CORS_HEADERS)) res.setHeader(key, value);
  res.status(status).json(body);
}

function hookError(res: VercelResponse, httpCode: number, message: string): void {
  json(res, httpCode, { error: { http_code: httpCode, message } });
}

async function readRawBody(req: VercelRequest): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function resolveRedirectTarget(
  data: { redirect_to?: string; site_url?: string } | undefined,
  defaultRedirectTo: string | undefined,
): { redirectTo: string; source: "redirect_to" | "site_url" | "default_redirect" } {
  if (data?.redirect_to?.trim()) return { redirectTo: data.redirect_to, source: "redirect_to" };
  if (data?.site_url?.trim()) return { redirectTo: data.site_url, source: "site_url" };
  return { redirectTo: defaultRedirectTo ?? "", source: "default_redirect" };
}

/**
 * An email carries no base URL, so a relative action link is not a degraded
 * link - it is an unclickable one. The Edge runtime supplied this origin for
 * free; a Node deployment must be configured with it, and one that is not must
 * refuse rather than send mail whose only working path is the OTP fallback.
 */
function absoluteAuthServiceUrl(value: string): boolean {
  try { const url = new URL(value); return url.protocol === "https:" || url.protocol === "http:"; }
  catch { return false; }
}

function uuidOrNull(value: string | undefined): string | null {
  return value && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : null;
}

function deliveryMode(
  result: AuthEmailTransportResult,
  env: Record<string, string | undefined>,
  recipient: string,
  defaultSandboxRecipient: string,
): AuthEmailDeliveryMode {
  // Preserve the existing Auth-hook audit vocabulary even though the Node
  // transport's lower-level egress seam uses a richer set of route names.
  if (result.outcome.egressMode === "production") return "standard";
  if ((env.EMAIL_DELIVERY_PROFILE ?? "").trim().toLowerCase() !== "production_like") return "standard";
  const sandboxRecipients = parseEmailList(
    env.EMAIL_SANDBOX_RECIPIENTS ?? env.COMMS_SANDBOX_SINK_ADDRESS ?? defaultSandboxRecipient,
  );
  return result.outcome.egressMode === "sandbox_sink"
    || (result.outcome.adminDisabled === true && sandboxRecipients.has(recipient.trim().toLowerCase()))
    ? "sandbox_recipient"
    : "production_like_real";
}

function parseEmailList(value: string | undefined): Set<string> {
  return new Set((value ?? "")
    .split(/[,\s;]+/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean));
}

function selectFromEmail(
  deps: AuthSendEmailHookDeps,
  recipient: string,
): string {
  const env = deps.env;
  if ((env.EMAIL_DELIVERY_PROFILE ?? "").trim().toLowerCase() !== "production_like") return deps.fromEmail;
  const sandboxRecipients = parseEmailList(
    env.EMAIL_SANDBOX_RECIPIENTS ?? env.COMMS_SANDBOX_SINK_ADDRESS ?? deps.defaultSandboxRecipient,
  );
  if (sandboxRecipients.has(recipient.trim().toLowerCase())) return deps.fromEmail;
  return env.EMAIL_REAL_DELIVERY_FROM_EMAIL?.trim()
    || env.AUTH_EMAIL_REAL_DELIVERY_FROM_EMAIL?.trim()
    || deps.fromEmail;
}

function validateAuthEmailRedirectOrigin(
  deps: AuthSendEmailHookDeps,
  redirectTo: string,
): { ok: true; environment: string; origin: string; production: boolean }
  | { ok: false; error: EmailOriginPolicyError } {
  const env = deps.env;
  const originConfiguration = readEmailOriginConfiguration(env, {
    defaultOrigin: deps.defaultOrigin,
    productionEmailHosts: deps.productionEmailHosts,
  });
  const environment = env.EMAIL_ENVIRONMENT ?? readObservedEnvironment(env);
  const configured = resolveEmailOrigin({
    ...originConfiguration,
    explicitBaseUrl: env.APP_BASE_URL?.trim() || deps.legacyBaseUrl,
    customerAuthRedirectOrigin: env.CUSTOMER_AUTH_REDIRECT_ORIGIN,
    siteUrl: env.SITE_URL,
    hiddenPreviewEnabled: readHiddenPreviewEnabled(env),
    environment,
  });
  if (configured.ok === false) return { ok: false, error: configured.error };
  const redirect = resolveEmailOrigin({
    ...originConfiguration,
    explicitBaseUrl: redirectTo,
    hiddenPreviewEnabled: readHiddenPreviewEnabled(env),
    environment,
  });
  if (redirect.ok === false) return { ok: false, error: redirect.error };
  return {
    ok: true,
    environment: configured.resolved.environment,
    origin: redirect.origin,
    production: configured.resolved.production,
  };
}

function persistenceOutcome(result: AuthEmailTransportResult) {
  return {
    ok: result.outcome.ok,
    messageId: result.outcome.messageId,
    providerError: result.outcome.providerError,
    aborted: result.outcome.aborted,
    skipReason: result.outcome.adminDisabled === true
      ? "admin_disabled" as const
      : result.outcome.suppressed === "drop" ? "egress_suppressed" as const : null,
  };
}

export function createAuthSendEmailHookCandidate(deps: AuthSendEmailHookDeps) {
  return async function authSendEmailHookCandidate(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method === "OPTIONS") {
      for (const [key, value] of Object.entries(CORS_HEADERS)) res.setHeader(key, value);
      res.status(200).send("ok");
      return;
    }
    if (req.method !== "POST") return hookError(res, 405, "Method not allowed");
    if (!deps.hookSecret) {
      console.error("[auth-send-email] SEND_EMAIL_HOOK_SECRET not configured");
      return hookError(res, 500, "Hook secret not configured");
    }
    if (!absoluteAuthServiceUrl(deps.authServiceUrl)) {
      console.error("[auth-send-email] auth service URL not configured");
      return hookError(res, 500, "Auth service URL not configured");
    }

    let rawBody: string;
    try { rawBody = await readRawBody(req); }
    catch { return hookError(res, 400, "Invalid JSON payload"); }
    const valid = await verifyStandardWebhookSignature({
      headers: {
        id: typeof req.headers["webhook-id"] === "string" ? req.headers["webhook-id"] : null,
        timestamp: typeof req.headers["webhook-timestamp"] === "string" ? req.headers["webhook-timestamp"] : null,
        signature: typeof req.headers["webhook-signature"] === "string" ? req.headers["webhook-signature"] : null,
      },
      rawBody,
      secret: deps.hookSecret,
      now: deps.now,
    });
    if (!valid) return hookError(res, 401, "Invalid signature");

    let payload: SendEmailHookPayload;
    try { payload = JSON.parse(rawBody) as SendEmailHookPayload; }
    catch { return hookError(res, 400, "Invalid JSON payload"); }

    const email = payload.user?.email;
    const data = payload.email_data;
    const actionType = data?.email_action_type;
    const tokenHash = data?.token_hash;
    const redirect = resolveRedirectTarget(data, deps.defaultRedirectTo);
    if (!email || !actionType || !tokenHash) return hookError(res, 400, "Missing user email or email_data");
    const redirectPolicy = validateAuthEmailRedirectOrigin(deps, redirect.redirectTo);
    if (redirectPolicy.ok === false) return hookError(res, 500, `Email origin policy failed: ${redirectPolicy.error}`);
    if (!KNOWN_ACTION_TYPES.has(actionType)) console.warn("[auth-send-email] unknown email_action_type:", actionType);

    let content: ReturnType<AuthEmailContentPort["buildAuthEmailContent"]>;
    try { content = deps.content.buildAuthEmailContent({
        actionType, userMetadata: payload.user?.user_metadata, redirectTo: redirect.redirectTo,
        actionLink: buildAuthVerifyUrl(deps.authServiceUrl, actionType, tokenHash, redirect.redirectTo),
        otp: data?.token ?? null,
      });
    } catch (error) { if (error instanceof AuthEmailContentUnavailableError) return hookError(res, 503, error.message);
      throw error;
    }
    const rendered = renderEmail({
      brand: deps.emailBrandForOrigin(redirectPolicy.origin), locale: content.locale,
      subject: content.subject, preheader: content.preheader, blocks: content.blocks,
    });
    const sendAttemptId = crypto.randomUUID();
    const authUserId = uuidOrNull(payload.user?.id);
    const aggregateId = authUserId ?? crypto.randomUUID();
    // Match the hosted hook's ordering: persistence/control failure is a
    // retryable refusal before any email side effect, never a post-send false 5xx.
    const templateSlug = `auth-${actionType}`;
    const enabled = await deps.persistence.isTemplateEnabled(templateSlug, new AbortController().signal);
    const sendResult = enabled
      ? await deps.transport.send({
        sender: selectFromEmail(deps, email), recipient: email,
        subject: rendered.subject, html: rendered.html, text: rendered.text,
      })
      : {
        outcome: { ok: true, messageId: null, providerError: null, aborted: false, adminDisabled: true },
        providerResponse: { skipped: "admin_disabled" },
      };
    const mode = deliveryMode(sendResult, deps.env, email, deps.defaultSandboxRecipient);
    const originMetadata = {
      emailBaseUrl: redirectPolicy.origin,
      emailOriginSource: redirect.source,
      emailEnvironment: redirectPolicy.environment,
    };
    await deps.persistence.recordSend({
      templateSlug,
      recipientEmail: email,
      authUserId,
      aggregateId,
      dedupeKey: `auth-send-email:${actionType}:${sendAttemptId}`,
      providerKind: deps.transport.providerKind,
      outcome: persistenceOutcome(sendResult),
      providerResponse: sendResult.providerResponse,
      metadata: {
        ...originMetadata,
        authEmailDeliveryMode: mode,
        deliveryMode: mode,
        triggerSource: "auth-send-email",
        triggerReason: actionType,
        providerKind: deps.transport.providerKind,
        sendAttemptId,
        aggregateType: "auth_user",
        aggregateId,
      },
    });
    if (!sendResult.outcome.ok) {
      console.error("[auth-send-email] transport send failed:", sendResult.outcome.providerError);
      return hookError(res, 502, "Email delivery failed");
    }
    json(res, 200, {});
  };
}
