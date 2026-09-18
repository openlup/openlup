import { resolveEgressMode, type EgressMode } from "#communications-egress-policy";

export interface ResendEmailSendInput {
  apiKey: string;
  fromEmail: string;
  to: string;
  subject: string;
  html: string;
  /** Optional plain-text alternative; omitted from the outbound payload when absent. */
  text?: string;
  /** Optional reply mailbox. Kept absent from the outbound payload unless set. */
  replyTo?: string;
  idempotencyKey?: string;
  attachments?: ReadonlyArray<{ filename: string; content: string }>;
  signal?: AbortSignal;
  /** Runtime env for the egress decision; defaults to process.env. Injectable for tests. */
  env?: Record<string, string | undefined>;
}

export interface ResendEmailSendOutcome {
  ok: boolean;
  resendId: string | null;
  httpStatus: number;
  providerError: string | null;
  /** Sanitized provider machine code when Resend returned one (for retry policy). */
  providerErrorCode?: string | null;
  aborted: boolean;
  /** Set when the egress gateway intentionally did not deliver to the real recipient. */
  suppressed?: "drop" | null;
  /** The egress mode the gateway resolved for this send. */
  egressMode?: EgressMode;
  egressReason?: string;
}

export interface ResendEmailPostResult {
  outcome: ResendEmailSendOutcome;
  providerResponse: Record<string, unknown>;
}

const RESEND_ENDPOINT = "https://api.resend.com/emails";
// Environment provenance tag. It had a byte-identical twin under the retired
// Edge tree; this is the only copy since 2026-09-04. The production webhook
// route uses it to distinguish a staging-originated lifecycle event from a
// genuine prod send_not_found. `egress.mode === "production"` is the
// unspoofable positive prod-ref confirmation from resolveEgressMode.
const EMAIL_ENVIRONMENT_TAG_NAME = "openlup_env";
const PROVIDER_ERROR_MAX = 240;
const PROVIDER_ERROR_CODE_MAX = 80;
const EMAIL_ADDRESS_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}...` : value;
}

function sanitizeProviderText(value: string): string {
  return truncate(value.replace(EMAIL_ADDRESS_PATTERN, "[email]").replace(/\s+/g, " ").trim(), PROVIDER_ERROR_MAX);
}

function sanitizeProviderCode(value: string): string {
  return truncate(value.replace(/[^A-Za-z0-9._:-]/g, "_"), PROVIDER_ERROR_CODE_MAX);
}

function providerErrorFromBody(body: Record<string, unknown>, httpStatus: number): string {
  const errField = body.error;
  if (typeof errField === "string") return sanitizeProviderText(errField);
  if (errField && typeof errField === "object") {
    const message = (errField as Record<string, unknown>).message;
    if (typeof message === "string") return sanitizeProviderText(message);
  }
  if (typeof body.message === "string") return sanitizeProviderText(body.message);
  return `Resend HTTP ${httpStatus}`;
}

function providerErrorCodeFromBody(body: Record<string, unknown>): string | null {
  const errField = body.error;
  const errorRecord = errField && typeof errField === "object"
    ? (errField as Record<string, unknown>)
    : {};
  const candidates = [
    errorRecord.code,
    errorRecord.name,
    errorRecord.type,
    body.code,
    body.name,
    body.type,
  ];
  const value = candidates.find((candidate) => typeof candidate === "string" && candidate.trim() !== "");
  return typeof value === "string" ? sanitizeProviderCode(value) : null;
}

function providerErrorResponse(body: Record<string, unknown>, httpStatus: number): Record<string, unknown> {
  const providerErrorMessage = providerErrorFromBody(body, httpStatus);
  const providerErrorCode = providerErrorCodeFromBody(body);
  return {
    http_status: httpStatus,
    provider_error_message: providerErrorMessage,
    ...(providerErrorCode ? { provider_error_code: providerErrorCode } : {}),
  };
}

export async function postResendEmail(input: ResendEmailSendInput): Promise<ResendEmailPostResult> {
  // Fail-closed egress gateway: decide who (if anyone) we may actually mail.
  const egress = resolveEgressMode(input.env ?? process.env, input.to);
  if (egress.blockedReason) {
    return {
      outcome: {
        ok: false,
        resendId: null,
        httpStatus: 0,
        providerError: egress.blockedReason,
        aborted: false,
        egressMode: egress.mode,
        egressReason: egress.reason,
      },
      providerResponse: {
        egress_reason: "email_delivery_profile_blocked",
        deliveryMode: egress.reason.startsWith("production_like_sandbox")
          ? "sandbox"
          : "production_like_real",
      },
    };
  }
  if (egress.mode === "drop") {
    // Cannot positively confirm production and no sink configured. Do NOT POST.
    // Returned ok+suppressed so the outbox treats it as terminal (no retry storm)
    // while recording that nothing reached a real recipient.
    console.error(
      JSON.stringify({ level: "error", event: "comms_egress_drop", reason: egress.reason }),
    );
    return {
      outcome: {
        ok: true,
        resendId: null,
        httpStatus: 0,
        providerError: null,
        aborted: false,
        suppressed: "drop",
        egressMode: egress.mode,
        egressReason: egress.reason,
      },
      providerResponse: { suppressed: "drop", egress_reason: egress.reason },
    };
  }
  const effectiveTo = egress.recipient ?? input.to;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${egress.apiKeyOverride ?? input.apiKey}`,
    "Content-Type": "application/json",
  };
  if (input.idempotencyKey !== undefined) {
    headers["Idempotency-Key"] = input.idempotencyKey;
  }
  // Off-prod sink redirect: keep the intended recipient visible to testers,
  // but never deliver to it.
  if (egress.mode === "sandbox_sink") {
    headers["X-Original-Recipient"] = egress.intendedRecipient;
  }
  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers,
      body: JSON.stringify({
        from: input.fromEmail,
        to: [effectiveTo],
        subject: input.subject,
        html: input.html,
        ...(input.text === undefined ? {} : { text: input.text }),
        ...(input.replyTo === undefined ? {} : { reply_to: input.replyTo }),
        ...(input.attachments === undefined ? {} : { attachments: input.attachments }),
        tags: [{
          name: EMAIL_ENVIRONMENT_TAG_NAME,
          value: egress.mode === "production" ? "production" : "non_production",
        }],
      }),
      signal: input.signal,
    });
    const parsed = await res.json().catch(() => ({}));
    const body = typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
    if (!res.ok) {
      const providerErrorMessage = providerErrorFromBody(body, res.status);
      const providerErrorCode = providerErrorCodeFromBody(body);
      return {
        outcome: {
          ok: false,
          resendId: null,
          httpStatus: res.status,
          providerError: providerErrorMessage,
          providerErrorCode,
          aborted: false,
          egressMode: egress.mode,
          egressReason: egress.reason,
        },
        providerResponse: providerErrorResponse(body, res.status),
      };
    }
    const id = typeof body.id === "string" ? body.id : null;
    return {
      outcome: {
        ok: true,
        resendId: id,
        httpStatus: res.status,
        providerError: null,
        aborted: false,
        egressMode: egress.mode,
        egressReason: egress.reason,
      },
      providerResponse: { id },
    };
  } catch (err) {
    const aborted =
      input.signal?.aborted === true ||
      (err instanceof Error && err.name === "AbortError");
    const msg = err instanceof Error ? err.message : String(err);
    return {
      outcome: {
        ok: false,
        resendId: null,
        httpStatus: 0,
        providerError: sanitizeProviderText(msg),
        aborted,
        egressMode: egress.mode,
        egressReason: egress.reason,
      },
      providerResponse: { exception: true, aborted },
    };
  }
}

export interface ResendEmailReadResult {
  ok: boolean;
  httpStatus: number;
  // Resend GET /emails/{id} `last_event` (e.g. "sent", "delivered",
  // "bounced", "complained", "delivery_delayed", "failed"); null when the
  // read failed or the field is absent.
  lastEvent: string | null;
  // Recipient echoed by GET /emails/{id}; used only so a poller-recovered
  // complaint can apply the same suppression as the webhook path.
  recipientEmail: string | null;
  providerError: string | null;
}

function readFirstRecipient(value: unknown): string | null {
  if (typeof value === "string" && value.includes("@")) return value;
  if (!Array.isArray(value)) return null;
  return value.find((recipient): recipient is string =>
    typeof recipient === "string" && recipient.includes("@")
  ) ?? null;
}

// Read-only status retrieval for the delivery reconciliation poller
// (docs/platform/RUNTIME_AND_SELF_HOSTING.md Wave 4). No egress gating needed: this never
// sends mail — it only reads the provider's view of an already-sent message.
export async function getResendEmail(input: {
  apiKey: string;
  resendId: string;
  signal?: AbortSignal;
}): Promise<ResendEmailReadResult> {
  try {
    const res = await fetch(`${RESEND_ENDPOINT}/${encodeURIComponent(input.resendId)}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${input.apiKey}` },
      signal: input.signal,
    });
    const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return {
        ok: false,
        httpStatus: res.status,
        lastEvent: null,
        recipientEmail: null,
        providerError: providerErrorFromBody(parsed, res.status),
      };
    }
    const lastEvent = typeof parsed.last_event === "string" ? parsed.last_event : null;
    return {
      ok: true,
      httpStatus: res.status,
      lastEvent,
      recipientEmail: readFirstRecipient(parsed.to),
      providerError: null,
    };
  } catch (error) {
    return {
      ok: false,
      httpStatus: 0,
      lastEvent: null,
      recipientEmail: null,
      providerError: error instanceof Error ? sanitizeProviderCode(error.message) : "fetch_failed",
    };
  }
}
