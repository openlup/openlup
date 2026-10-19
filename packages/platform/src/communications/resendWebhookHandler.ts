export const RESEND_EVENT_MAP: Record<string, string> = {
  "email.sent": "sent",
  "email.delivered": "delivered",
  "email.delivery_delayed": "delivery_delayed",
  "email.opened": "open",
  "email.clicked": "click",
  "email.bounced": "bounce",
  "email.complained": "complaint",
  "email.failed": "failed",
  "email.suppressed": "suppressed",
  "email.scheduled": "scheduled",
};

export type EmailEnvironmentTag = "production" | "non_production";
export type ResendWebhookAttemptOutcome =
  | "unsupported_event"
  | "missing_email_id"
  | "send_not_found"
  | "foreign_send_not_found"
  | "processed";

export interface ResendWebhookAttempt {
  resendWebhookId: string | null;
  resendEventType: string | null;
  resendEmailId: string | null;
  outcome: ResendWebhookAttemptOutcome;
  httpStatus: number;
  error?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface ResendWebhookProviderEvent {
  emailSendId: string;
  resendId: string;
  resendEventType: string;
  eventAt: string;
  metadata: Record<string, unknown>;
}

export interface ResendWebhookPort {
  findEmailSendByResendId: (resendId: string) => Promise<{ id: string } | null>;
  applyProviderEvent: (event: ResendWebhookProviderEvent) => Promise<void>;
  recordAttempt: (attempt: ResendWebhookAttempt) => Promise<void>;
}

export interface ResendWebhookRequest {
  method?: string;
  rawBody: string;
  headers: { webhookId?: string; timestamp?: string; signature?: string };
}

export interface ResendWebhookResponse {
  status: number;
  body: Record<string, unknown> | "ok";
}

/** Cryptographic verification is injected by composition so the domain stays provider-client neutral. */
export interface ResendWebhookSignatureInput {
  rawBody: string;
  webhookId: string | undefined;
  timestamp: string | undefined;
  signature: string | undefined;
  secret: string;
  now?: () => number;
}

export interface ResendWebhookHandlerDeps {
  webhookSecret: string;
  createPort: () => ResendWebhookPort;
  verifySignature: (input: ResendWebhookSignatureInput) => boolean;
  environmentTagName: string;
  resolveReceiverEnvironmentTag?: () => EmailEnvironmentTag;
  now?: () => number;
  receivedAt?: () => Date;
}

export function createResendWebhookHandler(deps: ResendWebhookHandlerDeps) {
  // The domain remains deployment-neutral. Composition injects the positive
  // production proof; an omitted resolver fails closed as non-production.
  const resolveReceiverEnvironmentTag = deps.resolveReceiverEnvironmentTag ?? (() => "non_production");
  const receivedAt = deps.receivedAt ?? (() => new Date());

  return async function handleResendWebhook(request: ResendWebhookRequest): Promise<ResendWebhookResponse> {
    if (request.method === "OPTIONS") return { status: 200, body: "ok" };

    if (!deps.verifySignature({
      rawBody: request.rawBody,
      webhookId: request.headers.webhookId,
      timestamp: request.headers.timestamp,
      signature: request.headers.signature,
      secret: deps.webhookSecret,
      now: deps.now,
    })) {
      return { status: 401, body: { error: "Invalid signature" } };
    }

    try {
      const payload = JSON.parse(request.rawBody) as { type?: unknown; data?: unknown; created_at?: unknown };
      const type = payload.type;
      const data = payload.data;
      const resendId = emailId(data);
      const eventType = typeof type === "string" ? RESEND_EVENT_MAP[type] : undefined;
      const webhookId = request.headers.webhookId ?? null;

      if (!eventType) {
        await recordAttemptSafely(deps.createPort, {
          resendWebhookId: webhookId,
          resendEventType: typeof type === "string" ? type : null,
          resendEmailId: resendId,
          outcome: "unsupported_event",
          httpStatus: 200,
          metadata: { data_keys: safeDataKeys(data) },
        });
        return { status: 200, body: { ignored: true } };
      }
      // `eventType` is populated only for a string key from RESEND_EVENT_MAP.
      const resendEventType = type as string;

      if (!resendId) {
        await recordAttemptSafely(deps.createPort, {
          resendWebhookId: webhookId,
          resendEventType,
          resendEmailId: null,
          outcome: "missing_email_id",
          httpStatus: 200,
          metadata: { data_keys: safeDataKeys(data) },
        });
        return { status: 200, body: { ignored: true, reason: "missing_email_id" } };
      }

      const environmentTag = readEmailEnvironmentTag(data, deps.environmentTagName);
      if (environmentTag && environmentTag !== resolveReceiverEnvironmentTag()) {
        // Edge creates this client directly (rather than using its best-effort
        // factory) for a foreign event. Preserve its retry signal if the
        // datastore itself cannot be constructed.
        const port = deps.createPort();
        await recordAttemptSafely(() => port, {
          resendWebhookId: webhookId,
          resendEventType,
          resendEmailId: resendId,
          outcome: "foreign_send_not_found",
          httpStatus: 200,
          metadata: { [deps.environmentTagName]: environmentTag, data_keys: safeDataKeys(data) },
        });
        return { status: 200, body: { ignored: true, reason: "foreign_send_not_found" } };
      }

      const port = deps.createPort();
      const send = await port.findEmailSendByResendId(resendId);
      if (!send) {
        await recordAttemptSafely(() => port, {
          resendWebhookId: webhookId,
          resendEventType,
          resendEmailId: resendId,
          outcome: "send_not_found",
          httpStatus: 200,
          metadata: { data_keys: safeDataKeys(data) },
        });
        return { status: 200, body: { ignored: true, reason: "send_not_found" } };
      }

      const eventTime = resolveResendEventTime(payload, request.headers.timestamp, receivedAt());
      await port.applyProviderEvent({
        emailSendId: send.id,
        resendId,
        resendEventType,
        eventAt: eventTime.eventAt,
        metadata: {
          providerEventId: webhookId,
          eventMetadata: data ?? {},
          link: isRecord(data) && isRecord(data.click) && typeof data.click.link === "string" ? data.click.link : null,
          source: "resend-webhook",
          eventTimeSource: eventTime.source,
        },
      });
      await recordAttemptSafely(() => port, {
        resendWebhookId: webhookId,
        resendEventType,
        resendEmailId: resendId,
        outcome: "processed",
        httpStatus: 200,
        metadata: { send_id: send.id },
      });
      return { status: 200, body: { success: true } };
    } catch (error) {
      return { status: 500, body: { error: String(error) } };
    }
  };
}

export function readEmailEnvironmentTag(data: unknown, tagName: string): EmailEnvironmentTag | null {
  if (!isRecord(data)) return null;
  const tags = data.tags;
  if (Array.isArray(tags)) {
    for (const entry of tags) {
      if (isRecord(entry) && entry.name === tagName) return environmentTag(entry.value);
    }
    return null;
  }
  return isRecord(tags) ? environmentTag(tags[tagName]) : null;
}

export function resolveResendEventTime(
  payload: { created_at?: unknown },
  svixTimestamp: string | undefined,
  receivedAt: Date,
): { eventAt: string; source: "provider_created_at" | "svix_timestamp" | "received_at" } {
  if (typeof payload.created_at === "string" && Number.isFinite(Date.parse(payload.created_at))) {
    return { eventAt: new Date(payload.created_at).toISOString(), source: "provider_created_at" };
  }
  const timestamp = Number(svixTimestamp);
  if (Number.isFinite(timestamp) && timestamp > 0) {
    return { eventAt: new Date(timestamp * 1000).toISOString(), source: "svix_timestamp" };
  }
  return { eventAt: receivedAt.toISOString(), source: "received_at" };
}

async function recordAttemptSafely(createPort: () => ResendWebhookPort, attempt: ResendWebhookAttempt): Promise<void> {
  try {
    await createPort().recordAttempt(attempt);
  } catch {
    // Exactly as on Edge, an observability failure must not turn a benign event
    // into a provider retry. Actual lookup/RPC failures remain 5xx above.
  }
}

function emailId(data: unknown): string | null {
  return isRecord(data) && typeof data.email_id === "string" ? data.email_id : null;
}

function safeDataKeys(data: unknown): string[] {
  return isRecord(data) ? Object.keys(data).slice(0, 50) : [];
}

function environmentTag(value: unknown): EmailEnvironmentTag | null {
  return value === "production" || value === "non_production" ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
