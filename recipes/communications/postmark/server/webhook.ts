import { createHash, timingSafeEqual } from "node:crypto";
import {
  processEmailObservation,
  type EmailObservationPort,
} from "@openlup/platform/communications";

const DEFAULT_MAX_WEBHOOK_BODY_BYTES = 262_144; // 256 KiB

const POSTMARK_EVENT_MAP = new Map<string, string>([
  ["Delivery", "email.delivered"],
  ["Bounce", "email.bounced"],
  ["SpamComplaint", "email.complained"],
  ["Open", "email.opened"],
  ["Click", "email.clicked"],
  ["SubscriptionChange", "email.suppressed"],
]);

export interface VerifyPostmarkBasicAuthInput {
  readonly authorizationHeader: string | undefined | null;
  readonly username: string;
  readonly password: string;
}

export interface PostmarkWebhookHandlerOptions {
  readonly port: EmailObservationPort;
  readonly username: string;
  readonly password: string;
  readonly maxBodyBytes?: number;
  readonly receivedAt?: () => Date;
}

export interface PostmarkWebhookRequest {
  readonly method?: string;
  readonly rawBody: string | Uint8Array;
  readonly headers?: Readonly<Record<string, string | undefined>>;
}

export interface PostmarkWebhookResponse {
  readonly status: number;
  readonly body: Record<string, unknown> | "ok";
}

function constantTimeEqualUtf8(left: string, right: string): boolean {
  const leftBuf = Buffer.from(left, "utf8");
  const rightBuf = Buffer.from(right, "utf8");
  const leftDigest = createHash("sha256").update(leftBuf).digest();
  const rightDigest = createHash("sha256").update(rightBuf).digest();
  const digestEqual = timingSafeEqual(leftDigest, rightDigest);
  if (leftBuf.length !== rightBuf.length) {
    return false;
  }
  return digestEqual && timingSafeEqual(leftBuf, rightBuf);
}

/**
 * Verifies Postmark HTTP Basic Auth using constant-time UTF-8 buffer comparison.
 * Enforces non-empty credentials, exact `Basic ` scheme, and exact byte length.
 */
export function verifyPostmarkBasicAuth(input: VerifyPostmarkBasicAuthInput): boolean {
  if (
    typeof input.username !== "string"
    || input.username.length === 0
    || input.username.includes(":")
    || typeof input.password !== "string"
    || input.password.length === 0
  ) {
    return false;
  }
  if (typeof input.authorizationHeader !== "string" || !input.authorizationHeader.startsWith("Basic ")) {
    return false;
  }
  const expectedToken = Buffer.from(`${input.username}:${input.password}`, "utf8").toString("base64");
  const expectedHeader = `Basic ${expectedToken}`;
  return constantTimeEqualUtf8(input.authorizationHeader, expectedHeader);
}

function readAuthorizationHeader(
  headers: Readonly<Record<string, string | undefined>> | undefined,
): string | undefined {
  if (!headers || typeof headers !== "object") return undefined;
  let found: string | undefined;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== "authorization") continue;
    if (typeof value !== "string") return undefined;
    if (found !== undefined && found !== value) return undefined;
    found = value;
  }
  return found;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function resolvePostmarkEventTime(
  payload: Record<string, unknown>,
  receivedAt: Date,
): { readonly eventAt: string; readonly source: string } {
  for (const field of ["DeliveredAt", "BouncedAt", "ChangedAt", "ReceivedAt"] as const) {
    const candidate = payload[field];
    if (typeof candidate === "string" && Number.isFinite(Date.parse(candidate))) {
      return {
        eventAt: new Date(candidate).toISOString(),
        source: `postmark_${field}`,
      };
    }
  }
  return {
    eventAt: receivedAt.toISOString(),
    source: "received_at",
  };
}

function buildPostmarkObservationMetadata(
  payload: Record<string, unknown>,
  recordType: string,
  eventTimeSource: string,
): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    source: "postmark-webhook",
    recordType,
    eventTimeSource,
    messageStream: typeof payload["MessageStream"] === "string" ? payload["MessageStream"] : null,
    tag: typeof payload["Tag"] === "string" ? payload["Tag"] : null,
  };
  if (recordType === "Click" && typeof payload["OriginalLink"] === "string") {
    metadata["link"] = payload["OriginalLink"];
  }
  if (recordType === "Bounce" || recordType === "SpamComplaint") {
    if (typeof payload["Type"] === "string") metadata["bounceType"] = payload["Type"];
    if (typeof payload["TypeCode"] === "number") metadata["bounceTypeCode"] = payload["TypeCode"];
    if (typeof payload["Inactive"] === "boolean") metadata["inactive"] = payload["Inactive"];
  }
  if (recordType === "SubscriptionChange") {
    if (typeof payload["SuppressionReason"] === "string") {
      metadata["suppressionReason"] = payload["SuppressionReason"];
    }
    if (typeof payload["SuppressSending"] === "boolean") {
      metadata["suppressSending"] = payload["SuppressSending"];
    }
    if (typeof payload["Origin"] === "string") {
      metadata["origin"] = payload["Origin"];
    }
  }
  return metadata;
}

/**
 * Creates a hardened Postmark webhook handler.
 * Enforces Basic Auth before JSON parsing (auth-before-parse), caps raw payload bytes
 * (default 256 KiB), rejects malformed JSON with 400, and normalizes Postmark events
 * through `@openlup/platform/communications`'s `processEmailObservation`.
 */
export function createPostmarkWebhookHandler(
  options: PostmarkWebhookHandlerOptions,
): (request: PostmarkWebhookRequest) => Promise<PostmarkWebhookResponse> {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_WEBHOOK_BODY_BYTES;
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes <= 0) {
    throw new RangeError("createPostmarkWebhookHandler maxBodyBytes must be a positive safe integer");
  }

  return async (request: PostmarkWebhookRequest): Promise<PostmarkWebhookResponse> => {
    if (request.method === "OPTIONS") {
      return { status: 200, body: "ok" };
    }

    const authorizationHeader = readAuthorizationHeader(request.headers);
    if (
      !verifyPostmarkBasicAuth({
        authorizationHeader,
        username: options.username,
        password: options.password,
      })
    ) {
      return { status: 401, body: { error: "Unauthorized" } };
    }

    const rawBytes =
      typeof request.rawBody === "string"
        ? Buffer.from(request.rawBody, "utf8")
        : Buffer.from(
            request.rawBody.buffer,
            request.rawBody.byteOffset,
            request.rawBody.byteLength,
          );

    if (rawBytes.byteLength > maxBodyBytes) {
      return { status: 413, body: { error: "Payload too large" } };
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBytes.toString("utf8"));
    } catch {
      return { status: 400, body: { error: "Invalid JSON payload" } };
    }

    if (!isRecord(payload)) {
      return { status: 400, body: { error: "Invalid JSON payload" } };
    }

    const recordType = typeof payload["RecordType"] === "string" ? payload["RecordType"] : null;
    if (!recordType) {
      return { status: 200, body: { ignored: true } };
    }

    const eventType = POSTMARK_EVENT_MAP.get(recordType);
    if (!eventType) {
      return { status: 200, body: { ignored: true } };
    }

    const rawMessageId = payload["MessageID"];
    const messageId =
      typeof rawMessageId === "string" && rawMessageId.trim().length > 0
        ? rawMessageId.trim()
        : null;
    if (!messageId) {
      return { status: 200, body: { ignored: true } };
    }

    try {
      const disposition = await processEmailObservation({
        port: options.port,
        messageId,
        observation: () => {
          const time = resolvePostmarkEventTime(payload, options.receivedAt?.() ?? new Date());
          return {
            eventType,
            eventAt: time.eventAt,
            metadata: buildPostmarkObservationMetadata(payload, recordType, time.source),
          };
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
