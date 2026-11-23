/**
 * Narrow structural client contract and zero-SDK hardened HTTP client for
 * Postmark Transactional Email REST API (ADR-001: zero vendor SDK, zero ambient
 * environment reads, zero ambient fetch, pinned HTTPS origin, redirect: "error").
 */

export type PostmarkFetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export const POSTMARK_API_ORIGIN = "https://api.postmarkapp.com";
export const POSTMARK_EMAIL_ENDPOINT = `${POSTMARK_API_ORIGIN}/email`;

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 524_288; // 512 KiB
const SANITIZED_TEXT_MAX = 240;
const EMAIL_ADDRESS_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu;

export interface PostmarkEmailHeader {
  readonly Name: string;
  readonly Value: string;
}

export interface PostmarkAttachment {
  readonly Name: string;
  readonly Content: string;
  readonly ContentType: string;
}

export interface PostmarkSendEmailInput {
  readonly serverToken: string;
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  readonly htmlBody: string;
  readonly textBody?: string;
  readonly replyTo?: string;
  readonly messageStream?: string;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly headers?: readonly PostmarkEmailHeader[];
  readonly attachments?: readonly PostmarkAttachment[];
  readonly signal?: AbortSignal;
}

export interface PostmarkSendResponse {
  readonly MessageID?: string | null;
  readonly ErrorCode?: number | null;
  readonly SubmittedAt?: string | null;
  readonly Message?: string | null;
}

export interface PostmarkClient {
  sendEmail(input: PostmarkSendEmailInput): Promise<PostmarkSendResponse>;
}

export interface PostmarkHttpClientOptions {
  /** Explicitly injected fetch implementation (never ambient global fetch). */
  readonly fetchImpl: PostmarkFetchLike;
  readonly messageStream?: string;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}

/**
 * Redacted Postmark transport error carrying only bounded diagnostic codes and HTTP status.
 * Raw HTTP response bodies, server tokens, and recipient addresses never enter Error.message.
 */
export class PostmarkTransportError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly aborted: boolean;
  readonly errorCode: number | null;
  readonly retryAfterSeconds: number | null;

  constructor(params: {
    readonly code: string;
    readonly httpStatus: number;
    readonly aborted: boolean;
    readonly errorCode?: number | null;
    readonly retryAfterSeconds?: number | null;
  }) {
    super(params.code);
    this.name = "PostmarkTransportError";
    this.code = params.code;
    this.httpStatus = params.httpStatus;
    this.aborted = params.aborted;
    this.errorCode = params.errorCode ?? null;
    this.retryAfterSeconds = params.retryAfterSeconds ?? null;
  }
}

/**
 * Sanitizes provider text by redacting explicit secrets (and their URL-encoded forms),
 * stripping email addresses, collapsing whitespace, and bounding output length.
 */
export function sanitizePostmarkText(
  raw: string,
  secretsToRedact: readonly string[] = [],
): string {
  let redacted = raw;
  for (const secret of secretsToRedact) {
    if (secret.length < 4) continue;
    redacted = redacted.split(secret).join("[redacted]");
    const encoded = encodeURIComponent(secret);
    if (encoded !== secret) {
      redacted = redacted.split(encoded).join("[redacted]");
      redacted = redacted.split(encoded.toLowerCase()).join("[redacted]");
    }
  }
  const normalized = redacted
    .replace(EMAIL_ADDRESS_PATTERN, "[email]")
    .replace(/\s+/gu, " ")
    .trim();
  if (normalized.length > SANITIZED_TEXT_MAX) {
    return `${normalized.slice(0, SANITIZED_TEXT_MAX - 1)}...`;
  }
  return normalized;
}

/** Parses an HTTP `Retry-After` header into non-negative whole seconds. */
export function parseRetryAfterSeconds(
  headerValue: string | null,
  nowMs: number = Date.now(),
): number | null {
  if (typeof headerValue !== "string") return null;
  const trimmed = headerValue.trim();
  if (!trimmed) return null;
  if (/^\d+$/u.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isSafeInteger(seconds) && seconds >= 0 ? seconds : null;
  }
  const dateMs = Date.parse(trimmed);
  if (!Number.isFinite(dateMs)) return null;
  return Math.max(0, Math.ceil((dateMs - nowMs) / 1000));
}

function assertValidTokenOrStream(value: unknown, kind: "token" | "stream"): string {
  if (
    typeof value !== "string"
    || value.trim().length === 0
    || /[\r\n\p{Cc}\p{Cf}]/u.test(value)
  ) {
    throw new PostmarkTransportError({
      code: kind === "token" ? "postmark_invalid_server_token" : "postmark_invalid_message_stream",
      httpStatus: 0,
      aborted: false,
    });
  }
  return value.trim();
}

function isAbortLikeError(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  if (error instanceof Error) {
    return error.name === "AbortError" || error.name === "TimeoutError";
  }
  return false;
}

function raceWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  onAbort?: () => void,
): Promise<T> {
  if (signal.aborted) {
    onAbort?.();
    return Promise.reject(new DOMException("aborted", "AbortError"));
  }
  return new Promise<T>((resolve, reject) => {
    const handleAbort = () => {
      onAbort?.();
      reject(new DOMException("aborted", "AbortError"));
    };
    signal.addEventListener("abort", handleAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", handleAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", handleAbort);
        reject(err);
      },
    );
  });
}

async function readBoundedResponseText(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<string> {
  const contentLengthHeader = response.headers.get("content-length");
  if (contentLengthHeader !== null) {
    const declared = Number(contentLengthHeader);
    if (Number.isFinite(declared) && declared > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new PostmarkTransportError({
        code: "postmark_response_too_large",
        httpStatus: response.status,
        aborted: false,
      });
    }
  }

  if (response.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    try {
      while (true) {
        const { done, value } = await raceWithAbort(reader.read(), signal, () => {
          void reader.cancel().catch(() => undefined);
        });
        if (done) break;
        if (value) {
          totalBytes += value.byteLength;
          if (totalBytes > maxBytes) {
            await reader.cancel().catch(() => undefined);
            throw new PostmarkTransportError({
              code: "postmark_response_too_large",
              httpStatus: response.status,
              aborted: false,
            });
          }
          chunks.push(value);
        }
      }
    } finally {
      reader.releaseLock();
    }

    const merged = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(merged);
    } catch {
      throw new PostmarkTransportError({
        code: "postmark_invalid_utf8_response",
        httpStatus: response.status,
        aborted: false,
      });
    }
  }

  const text = await raceWithAbort(response.text(), signal);
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    throw new PostmarkTransportError({
      code: "postmark_response_too_large",
      httpStatus: response.status,
      aborted: false,
    });
  }
  return text;
}

/**
 * Creates a hardened zero-dependency HTTP client pinned to `https://api.postmarkapp.com/email`.
 * Enforces `redirect: "error"`, composed `AbortSignal.timeout` + caller `signal`, streaming
 * 512 KiB response cap, clean non-2xx body cancellation, `Retry-After` parsing on 429,
 * and email/token redaction.
 */
export function createPostmarkHttpClient(options: PostmarkHttpClientOptions): PostmarkClient {
  if (typeof options.fetchImpl !== "function") {
    throw new TypeError("createPostmarkHttpClient requires an explicit fetchImpl");
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("createPostmarkHttpClient timeoutMs must be a positive finite number");
  }
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0) {
    throw new RangeError("createPostmarkHttpClient maxResponseBytes must be a positive safe integer");
  }
  const defaultMessageStream =
    options.messageStream !== undefined
      ? assertValidTokenOrStream(options.messageStream, "stream")
      : undefined;

  const pinnedUrl = new URL(POSTMARK_EMAIL_ENDPOINT);
  if (
    pinnedUrl.protocol !== "https:"
    || pinnedUrl.origin !== POSTMARK_API_ORIGIN
    || pinnedUrl.pathname !== "/email"
  ) {
    throw new PostmarkTransportError({
      code: "postmark_origin_mismatch",
      httpStatus: 0,
      aborted: false,
    });
  }

  return {
    async sendEmail(input: PostmarkSendEmailInput): Promise<PostmarkSendResponse> {
      const serverToken = assertValidTokenOrStream(input.serverToken, "token");
      const messageStream =
        input.messageStream !== undefined
          ? assertValidTokenOrStream(input.messageStream, "stream")
          : defaultMessageStream;

      const payload: Record<string, unknown> = {
        From: input.from,
        To: input.to,
        Subject: input.subject,
        HtmlBody: input.htmlBody,
      };
      if (input.textBody !== undefined) payload["TextBody"] = input.textBody;
      if (input.replyTo !== undefined) payload["ReplyTo"] = input.replyTo;
      if (messageStream !== undefined) payload["MessageStream"] = messageStream;
      if (input.metadata !== undefined && Object.keys(input.metadata).length > 0) {
        payload["Metadata"] = input.metadata;
      }
      if (input.headers !== undefined && input.headers.length > 0) {
        payload["Headers"] = input.headers;
      }
      if (input.attachments !== undefined && input.attachments.length > 0) {
        payload["Attachments"] = input.attachments;
      }

      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const composedSignal = input.signal
        ? AbortSignal.any([timeoutSignal, input.signal])
        : timeoutSignal;

      if (composedSignal.aborted) {
        throw new PostmarkTransportError({
          code: "postmark_timeout",
          httpStatus: 0,
          aborted: true,
        });
      }

      let response: Response;
      try {
        response = await raceWithAbort(
          options.fetchImpl(pinnedUrl.href, {
            method: "POST",
            headers: {
              "X-Postmark-Server-Token": serverToken,
              Accept: "application/json",
              "Content-Type": "application/json",
            },
            body: JSON.stringify(payload),
            redirect: "error",
            signal: composedSignal,
          }),
          composedSignal,
        );
      } catch (error) {
        if (error instanceof PostmarkTransportError) throw error;
        const aborted = isAbortLikeError(error, composedSignal);
        throw new PostmarkTransportError({
          code: aborted ? "postmark_timeout" : "postmark_transport_error",
          httpStatus: 0,
          aborted,
        });
      }

      if (!response.ok) {
        const status = response.status;
        const retryAfterSeconds =
          status === 429 ? parseRetryAfterSeconds(response.headers.get("retry-after")) : null;
        await response.body?.cancel().catch(() => undefined);
        throw new PostmarkTransportError({
          code: status === 429 ? "postmark_rate_limited" : `postmark_http_${status}`,
          httpStatus: status,
          aborted: false,
          retryAfterSeconds,
        });
      }

      let rawText: string;
      try {
        rawText = await readBoundedResponseText(response, maxResponseBytes, composedSignal);
      } catch (error) {
        if (error instanceof PostmarkTransportError) throw error;
        const aborted = isAbortLikeError(error, composedSignal);
        throw new PostmarkTransportError({
          code: aborted ? "postmark_timeout" : "postmark_transport_error",
          httpStatus: aborted ? 0 : response.status,
          aborted,
        });
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(rawText);
      } catch {
        throw new PostmarkTransportError({
          code: "postmark_malformed_response",
          httpStatus: response.status,
          aborted: false,
        });
      }

      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new PostmarkTransportError({
          code: "postmark_malformed_response",
          httpStatus: response.status,
          aborted: false,
        });
      }

      const obj = parsed as Record<string, unknown>;
      return {
        MessageID: typeof obj["MessageID"] === "string" ? obj["MessageID"] : null,
        ErrorCode:
          typeof obj["ErrorCode"] === "number" && Number.isFinite(obj["ErrorCode"])
            ? obj["ErrorCode"]
            : 0,
        SubmittedAt: typeof obj["SubmittedAt"] === "string" ? obj["SubmittedAt"] : null,
        Message:
          typeof obj["Message"] === "string"
            ? sanitizePostmarkText(obj["Message"], [serverToken])
            : null,
      };
    },
  };
}
