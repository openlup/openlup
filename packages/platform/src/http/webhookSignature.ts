import { createHmac, timingSafeEqual } from "node:crypto";
import type { HttpRequest } from "./types.js";

/** Hard cap on raw webhook body bytes — the payment provider events are well under 256 KiB. */
export const MAX_WEBHOOK_BODY_BYTES = 1_048_576;

/** Thrown by readRawBody when the streamed body exceeds MAX_WEBHOOK_BODY_BYTES. */
export class WebhookBodyTooLargeError extends Error {
  constructor() {
    super("Webhook body exceeds maximum size");
    this.name = "WebhookBodyTooLargeError";
  }
}

/**
 * Reads the exact raw request body bytes for provider webhook signature
 * verification.
 *
 * `@vercel/node` (v3, the builder for `/api` functions in this Vite project)
 * auto-parses `application/json` request bodies into `req.body` and IGNORES the
 * `export const config = { api: { bodyParser: false } }` opt-out — that opt-out
 * is a Next.js Pages Router convention, not a vanilla `@vercel/node` one
 * (verified empirically against the hidden-preview deploy: a JSON payload posted
 * with `Content-Type: application/json` arrives parsed, the same bytes posted as
 * `text/plain` arrive raw). Re-serializing the parsed object with
 * `JSON.stringify` does NOT reproduce the provider's exact bytes — the payment provider signs
 * pretty-printed JSON, so a compacted re-serialization breaks HMAC verification.
 *
 * Reading the underlying request stream FIRST — before touching `req.body`,
 * whose getter triggers the parse that consumes the stream — preserves the exact
 * bytes when the platform parses lazily. When `req` is not a stream (unit tests
 * pass a plain `{ body }` object) or the stream yields nothing (already
 * consumed), we fall back to `req.body`.
 */
export async function readRawBody(req: HttpRequest): Promise<string> {
  if (isAsyncIterable(req)) {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req as unknown as AsyncIterable<Buffer | string>) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.byteLength;
      // Enforce the cap mid-stream so an oversized body is rejected before it is
      // fully buffered into memory, not after.
      if (total > MAX_WEBHOOK_BODY_BYTES) throw new WebhookBodyTooLargeError();
      chunks.push(buf);
    }
    if (chunks.length > 0) return Buffer.concat(chunks).toString("utf8");
  }

  if (typeof req.body === "string") return capBody(req.body);
  if (Buffer.isBuffer(req.body)) return capBody(req.body.toString("utf8"));
  if (req.body && typeof req.body === "object") return capBody(JSON.stringify(req.body));
  return "";
}

function capBody(body: string): string {
  if (Buffer.byteLength(body, "utf8") > MAX_WEBHOOK_BODY_BYTES) {
    throw new WebhookBodyTooLargeError();
  }
  return body;
}

function isAsyncIterable(value: unknown): boolean {
  return (
    value != null &&
    typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] ===
      "function"
  );
}

export function verifyHmacSignature(input: {
  rawBody: string;
  signatureHeader: string | undefined;
  secret: string;
}): boolean {
  if (!input.signatureHeader || !input.secret) return false;
  return timingSafeStringEqual(input.signatureHeader, hmac(input.rawBody, input.secret));
}

function hmac(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value).digest("hex");
}

/**
 * Constant-time comparison of two shared-secret strings.
 *
 * Exported because it is not payment-specific: any route holding a shared token has to compare it
 * the same way, and a second hand-rolled copy of a security primitive is how one of them quietly
 * stops being constant-time. The length check comes first because `timingSafeEqual` THROWS on a
 * length mismatch rather than returning false, and the length of a shared token is not the secret.
 */
export function timingSafeStringEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
