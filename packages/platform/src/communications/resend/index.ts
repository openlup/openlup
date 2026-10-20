import { createHmac, timingSafeEqual } from "node:crypto";
import { createGuardedEmailTransport, type EmailEgressPolicy, type EmailEgressContext } from "../emailEgress.js";
import type { EmailMessage, EmailSendResult, EmailTransport } from "../emailTransport.js";
import { processEmailObservation, type EmailObservationPort } from "../emailObservation.js";
import { runDeliveryReconciliation, type DeliveryReconciliationPort, type DeliveryReconciliationResult } from "../deliveryReconciliation.js";

/** Opt-in Node sender. Every send obtains a fresh validated host egress decision. */
export function createResendTransport(input: {
  policy: EmailEgressPolicy;
  environmentTagName: string;
  fetch?: typeof fetch;
}): EmailTransport {
  return createGuardedEmailTransport({
    providerKind: "resend",
    policy: input.policy,
    send: (message, context) => postResendEmail(message, context, input.environmentTagName, input.fetch ?? fetch),
  });
}

const RESEND_ENDPOINT = "https://api.resend.com/emails";
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

async function postResendEmail(
  input: EmailMessage, context: Readonly<EmailEgressContext>, environmentTagName: string, fetcher: typeof fetch,
): Promise<EmailSendResult> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${context.credential}`,
    "Content-Type": "application/json",
  };
  if (input.idempotencyKey !== undefined) headers["Idempotency-Key"] = input.idempotencyKey;
  if (context.mode === "sandbox_sink") headers["X-Original-Recipient"] = context.intendedRecipient;
  try {
    const res = await fetcher(RESEND_ENDPOINT, {
      method: "POST",
      headers,
      body: JSON.stringify({
        from: input.from,
        to: [context.recipient],
        subject: input.subject,
        html: input.html,
        ...(input.text === undefined ? {} : { text: input.text }),
        ...(input.replyTo === undefined ? {} : { reply_to: input.replyTo }),
        ...(input.attachments === undefined ? {} : { attachments: input.attachments }),
        tags: [{
          name: environmentTagName,
          value: context.environmentTag,
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
          egressMode: context.mode,
          egressReason: context.reason,
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
        egressMode: context.mode,
        egressReason: context.reason,
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
        egressMode: context.mode,
        egressReason: context.reason,
      },
      providerResponse: { exception: true, aborted },
    };
  }
}

interface ResendEmailReadResult {
  ok: boolean;
  httpStatus: number;
  lastEvent: string | null;
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
async function getResendEmail(input: {
  apiKey: string;
  resendId: string;
  signal?: AbortSignal;
}, fetcher: typeof fetch): Promise<ResendEmailReadResult> {
  try {
    const res = await fetcher(`${RESEND_ENDPOINT}/${encodeURIComponent(input.resendId)}`, {
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

/** Poll existing IDs through the neutral runner; never retries a send. */
export function runResendDeliveryReconciliation(input: {
  port: DeliveryReconciliationPort;
  now: string;
  graceMinutes: number;
  limit: number;
  apiKey: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}): Promise<DeliveryReconciliationResult> {
  return runDeliveryReconciliation({
    port: input.port, now: input.now, graceMinutes: input.graceMinutes, limit: input.limit,
    readEmail: messageId => getResendEmail({ apiKey: input.apiKey, resendId: messageId, signal: input.signal }, input.fetch ?? fetch),
    observationFor: read => {
      const status = read.lastEvent;
      if (!status || !["delivered", "delivery_delayed", "bounced", "complained", "failed"].includes(status)) return null;
      return { eventType: `email.${status}`, terminal: ["bounced", "complained", "failed"].includes(status) };
    },
  });
}

const eventKinds = new Map([
  ["email.sent", "sent"], ["email.delivered", "delivered"], ["email.delivery_delayed", "delivery_delayed"],
  ["email.opened", "open"], ["email.clicked", "click"], ["email.bounced", "bounce"],
  ["email.complained", "complaint"], ["email.failed", "failed"], ["email.suppressed", "suppressed"], ["email.scheduled", "scheduled"],
]);

/** Authenticate untouched bytes before decoding. now returns UTC seconds; receiver defaults to non-production. */
export function createResendWebhookHandler(input: {
  port: EmailObservationPort;
  webhookSecret: string;
  environmentTagName: string;
  resolveReceiverEnvironmentTag?: () => "production" | "non_production";
  now?: () => number;
  receivedAt?: () => Date;
}): (request: {
  method?: string;
  rawBody: string | Uint8Array;
  headers: { webhookId?: string; timestamp?: string; signature?: string };
}) => Promise<{ status: number; body: Record<string, unknown> | "ok" }> {
  return async request => {
    if (request.method === "OPTIONS") return { status: 200, body: "ok" };
    if (!verifyResendWebhookSignature({ ...request.headers, rawBody: request.rawBody, secret: input.webhookSecret, now: input.now })) {
      return { status: 401, body: { error: "Invalid signature" } };
    }
    try {
      const payload: unknown = JSON.parse(typeof request.rawBody === "string" ? request.rawBody : Buffer.from(request.rawBody).toString("utf8"));
      const type = isRecord(payload) ? payload.type : null;
      const data = isRecord(payload) ? payload.data : null;
      const eventType = typeof type === "string" ? eventKinds.get(type) : undefined;
      if (!eventType) return { status: 200, body: { ignored: true } };
      const messageId = isRecord(data) && typeof data.email_id === "string" ? data.email_id : null;
      if (!messageId) return { status: 200, body: { ignored: true, reason: "missing_email_id" } };
      const tag = readEnvironmentTag(data, input.environmentTagName);
      if (tag && tag !== (input.resolveReceiverEnvironmentTag?.() ?? "non_production")) {
        return { status: 200, body: { ignored: true, reason: "foreign_send_not_found" } };
      }
      const disposition = await processEmailObservation({
        port: input.port, messageId,
        observation: () => {
          const time = resolveEventTime(isRecord(payload) ? payload.created_at : null, request.headers.timestamp, input.receivedAt?.() ?? new Date());
          return { eventType, eventAt: time.eventAt, metadata: {
            providerEventId: request.headers.webhookId ?? null, eventMetadata: data ?? {},
            link: isRecord(data) && isRecord(data.click) && typeof data.click.link === "string" ? data.click.link : null,
            source: "resend-webhook", eventTimeSource: time.source,
          } };
        },
      });
      return disposition.outcome === "send_not_found"
        ? { status: 200, body: { ignored: true, reason: "send_not_found" } }
        : { status: 200, body: { success: true } };
    } catch {
      return { status: 500, body: { error: "Webhook processing failed" } };
    }
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function readEnvironmentTag(data: unknown, tagName: string): "production" | "non_production" | null {
  if (!isRecord(data)) return null;
  const tags = data.tags;
  const value = Array.isArray(tags)
    ? tags.find(entry => isRecord(entry) && entry.name === tagName)?.value
    : isRecord(tags) ? tags[tagName] : null;
  return value === "production" || value === "non_production" ? value : null;
}
function resolveEventTime(createdAt: unknown, timestamp: string | undefined, receivedAt: Date) {
  if (typeof createdAt === "string" && Number.isFinite(Date.parse(createdAt))) {
    return { eventAt: new Date(createdAt).toISOString(), source: "provider_created_at" };
  }
  const seconds = Number(timestamp);
  if (Number.isFinite(seconds) && seconds > 0) return { eventAt: new Date(seconds * 1000).toISOString(), source: "svix_timestamp" };
  return { eventAt: receivedAt.toISOString(), source: "received_at" };
}

function verifyResendWebhookSignature(input: { rawBody: string | Uint8Array; webhookId?: string; timestamp?: string; signature?: string; secret: string; now?: () => number }): boolean {
  const { webhookId, timestamp, signature, rawBody, secret } = input;
  if (!webhookId || !timestamp || !signature || !secret) return false;

  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds)) return false;
  const now = input.now ?? (() => Math.floor(Date.now() / 1000));
  if (Math.abs(now() - timestampSeconds) > 300) return false;

  const secretKey = signingSecret(secret);
  if (secretKey === null) return false;

  const expected = createHmac("sha256", secretKey)
    .update(`${webhookId}.${timestamp}.`).update(rawBody)
    .digest("base64");
  return signature.split(" ").some((member) =>
    timingSafeStringEqual(member, `v1,${expected}`) || timingSafeStringEqual(member, expected));
}

function signingSecret(secret: string): Buffer | string | null {
  if (!secret.startsWith("whsec_")) return secret;
  // Svix encodes endpoint secrets after the whsec_ prefix. Buffer preserves the
  // decoded bytes for node:crypto rather than treating the base64 text as a key.
  // Buffer.from(base64) is deliberately permissive, so reject empty, malformed,
  // or non-canonical input before it can silently become an empty/partial key.
  const encoded = secret.slice("whsec_".length);
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 === 1) return null;
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.length === 0) return null;
  const canonicalPadded = decoded.toString("base64");
  const canonicalUnpadded = canonicalPadded.replace(/=+$/, "");
  return encoded === canonicalPadded || encoded === canonicalUnpadded ? decoded : null;
}

function timingSafeStringEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
