import { createHmac, timingSafeEqual } from "node:crypto";

/** Svix's default replay window, retained from the Edge webhook handler. */
export const RESEND_SVIX_TOLERANCE_SECONDS = 5 * 60;

export interface ResendWebhookSignatureInput {
  rawBody: string;
  webhookId: string | undefined;
  timestamp: string | undefined;
  signature: string | undefined;
  secret: string;
  /** Injectable UTC-seconds clock for deterministic characterization tests. */
  now?: () => number;
}

/**
 * Verifies Resend's Svix signature over the untouched request bytes.
 *
 * The provider accepts both the documented `v1,<base64>` member and the
 * historical bare base64 member. Do not parse or normalize `rawBody` before
 * calling this function: the bytes themselves are signed.
 */
export function verifyResendWebhookSignature(input: ResendWebhookSignatureInput): boolean {
  const { webhookId, timestamp, signature, rawBody, secret } = input;
  if (!webhookId || !timestamp || !signature || !secret) return false;

  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds)) return false;
  const now = input.now ?? (() => Math.floor(Date.now() / 1000));
  if (Math.abs(now() - timestampSeconds) > RESEND_SVIX_TOLERANCE_SECONDS) return false;

  const secretKey = signingSecret(secret);
  if (secretKey === null) return false;

  const expected = createHmac("sha256", secretKey)
    .update(`${webhookId}.${timestamp}.${rawBody}`)
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
