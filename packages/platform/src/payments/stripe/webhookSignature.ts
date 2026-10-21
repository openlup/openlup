import { createHmac, timingSafeEqual } from "node:crypto";
export const STRIPE_TIMESTAMP_TOLERANCE_SECONDS = 300;

export function verifyStripeSignature(input: {
  rawBody: string;
  signatureHeader: string | undefined;
  /**
   * One or many endpoint secrets to accept. Multi-secret support lets a single
   * route accept signatures from both the dashboard webhook endpoint and a
   * local `stripe listen` CLI tunnel; the signature is accepted if ANY secret
   * verifies. An empty array (or missing single secret) fails closed.
   */
  endpointSecret: string | readonly string[];
  /** Injectable clock (UTC seconds) for deterministic tests; defaults to now. */
  now?: () => number;
}): boolean {
  const parts = Object.fromEntries(
    (input.signatureHeader ?? "")
      .split(",")
      .map((part) => part.split("="))
      .filter(([key, value]) => key && value) as Array<[string, string]>,
  );
  const timestamp = parts.t;
  const signature = parts.v1;
  if (!timestamp || !signature) return false;
  // Reject replays outside the tolerance window before doing the HMAC work. A
  // valid signature on a stale timestamp (captured-and-replayed event) must not
  // pass; the future-skew bound tolerates small clock drift between Stripe and us.
  const timestampSec = Number(timestamp);
  if (!Number.isFinite(timestampSec)) return false;
  const now = input.now ?? (() => Math.floor(Date.now() / 1000));
  const ageSec = now() - timestampSec;
  if (ageSec > STRIPE_TIMESTAMP_TOLERANCE_SECONDS) return false;
  if (ageSec < -STRIPE_TIMESTAMP_TOLERANCE_SECONDS) return false;
  const secrets = Array.isArray(input.endpointSecret)
    ? input.endpointSecret
    : input.endpointSecret
      ? [input.endpointSecret]
      : [];
  return secrets.some((secret) => {
    if (!secret) return false;
    const expected = hmac(`${timestamp}.${input.rawBody}`, secret);
    return timingSafeStringEqual(signature, expected);
  });
}

function hmac(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value).digest("hex");
}

function timingSafeStringEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
