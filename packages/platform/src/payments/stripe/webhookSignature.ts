import { createHmac, timingSafeEqual } from "node:crypto";
export const STRIPE_TIMESTAMP_TOLERANCE_SECONDS = 300;

export interface ParsedStripeSignatureHeader {
  timestamp: string;
  timestampSec: number;
  signatures: readonly string[];
}

export function parseStripeSignatureHeader(
  signatureHeader: string | undefined,
): ParsedStripeSignatureHeader | null {
  if (typeof signatureHeader !== "string" || signatureHeader.trim() === "") return null;
  let timestamp: string | null = null;
  const signatures: string[] = [];
  for (const rawPart of signatureHeader.split(",")) {
    const part = rawPart.trim();
    if (!part) continue;
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!value) continue;
    if (key === "t") {
      // Fail closed on conflicting duplicate timestamps.
      if (timestamp !== null && timestamp !== value) return null;
      timestamp = value;
    } else if (key === "v1") {
      signatures.push(value);
    }
  }
  if (!timestamp || signatures.length === 0) return null;
  const timestampSec = Number(timestamp);
  if (!Number.isFinite(timestampSec)) return null;
  return { timestamp, timestampSec, signatures };
}

export function verifyStripeSignature(input: {
  rawBody: string;
  signatureHeader: string | undefined;
  /**
   * One or many endpoint secrets to accept. Multi-secret support lets a single
   * route accept signatures from both the dashboard webhook endpoint and a
   * local `stripe listen` CLI tunnel; the signature is accepted if ANY secret
   * matches ANY `v1` signature in the header. An empty array (or missing single
   * secret) fails closed.
   */
  endpointSecret: string | readonly string[];
  /** Injectable clock (UTC seconds) for deterministic tests; defaults to now. */
  now?: () => number;
}): boolean {
  const parsed = parseStripeSignatureHeader(input.signatureHeader);
  if (!parsed) return false;
  // Reject replays outside the tolerance window before doing the HMAC work. A
  // valid signature on a stale timestamp (captured-and-replayed event) must not
  // pass; the future-skew bound tolerates small clock drift between Stripe and us.
  const now = input.now ?? (() => Math.floor(Date.now() / 1000));
  const ageSec = now() - parsed.timestampSec;
  if (ageSec > STRIPE_TIMESTAMP_TOLERANCE_SECONDS) return false;
  if (ageSec < -STRIPE_TIMESTAMP_TOLERANCE_SECONDS) return false;
  const secrets = Array.isArray(input.endpointSecret)
    ? input.endpointSecret
    : input.endpointSecret
      ? [input.endpointSecret]
      : [];
  let matched = false;
  for (const secret of secrets) {
    if (!secret) continue;
    const expected = hmac(`${parsed.timestamp}.${input.rawBody}`, secret);
    for (const signature of parsed.signatures) {
      if (timingSafeStringEqual(signature, expected)) matched = true;
    }
  }
  return matched;
}

function hmac(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value).digest("hex");
}

function timingSafeStringEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
