/**
 * Node-native Standard Webhooks verifier for the inactive Auth email candidate.
 * It intentionally mirrors the deployed Edge algorithm: `id.timestamp.rawBody`
 * is signed with a decoded `whsec_` key and any space-separated v1 signature may
 * match. Keep this independent of deployable Edge packaging.
 */
import { createHmac } from "node:crypto";

const DEFAULT_TOLERANCE_SECONDS = 5 * 60;

export interface StandardWebhookHeaders {
  id: string | null;
  timestamp: string | null;
  signature: string | null;
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return diff === 0;
}

export function standardWebhookKeyBytes(secret: string): Uint8Array {
  let value = secret.trim();
  if (!value) throw new Error("standard_webhook_secret_empty");
  if (value.startsWith("v1,")) value = value.slice("v1,".length);
  if (value.startsWith("whsec_")) {
    const decoded = decodeStandardWebhookKey(value.slice("whsec_".length));
    // An empty `whsec_` would make a publicly reproducible empty-key HMAC. It
    // is not a usable Standard Webhooks secret even though it is valid base64.
    if (decoded.length === 0) throw new Error("standard_webhook_secret_empty");
    return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  }
  return new TextEncoder().encode(value);
}

function decodeStandardWebhookKey(base64: string): string {
  if (base64.length === 0) return "";
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64) || base64.length % 4 === 1) {
    throw new Error("standard_webhook_secret_invalid_base64");
  }
  const decoded = atob(base64);
  const canonicalPadded = Buffer.from(decoded, "latin1").toString("base64");
  const canonicalUnpadded = canonicalPadded.replace(/=+$/, "");
  if (base64 !== canonicalPadded && base64 !== canonicalUnpadded) {
    throw new Error("standard_webhook_secret_invalid_base64");
  }
  return decoded;
}

async function hmacSha256Base64(keyBytes: Uint8Array, message: string): Promise<string> {
  return createHmac("sha256", Buffer.from(keyBytes)).update(message).digest("base64");
}

export async function verifyStandardWebhookSignature(opts: {
  headers: StandardWebhookHeaders;
  rawBody: string;
  secret: string;
  toleranceSeconds?: number;
  now?: () => number;
}): Promise<boolean> {
  const { headers, rawBody, secret } = opts;
  if (!secret || !headers.id || !headers.timestamp || !headers.signature) return false;
  const timestampSeconds = Number(headers.timestamp);
  if (!Number.isFinite(timestampSeconds)) return false;
  const nowSeconds = Math.floor((opts.now?.() ?? Date.now()) / 1000);
  if (Math.abs(nowSeconds - timestampSeconds) > (opts.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS)) return false;
  let expected: string;
  try {
    expected = await hmacSha256Base64(
      standardWebhookKeyBytes(secret),
      `${headers.id}.${headers.timestamp}.${rawBody}`,
    );
  } catch {
    // A malformed whsec_ value is an invalid verification key, never a reason
    // to bypass signature verification or surface an unhandled request error.
    return false;
  }
  return headers.signature
    .split(" ")
    .map((part) => (part.includes(",") ? part.slice(part.indexOf(",") + 1) : part))
    .some((candidate) => timingSafeEqual(candidate, expected));
}
