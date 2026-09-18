import { createHmac, timingSafeEqual } from "node:crypto";

export const COMMUNICATION_INTEGRATION_SIGNATURE_TOLERANCE_SECONDS = 300;
export const COMMUNICATION_INTEGRATION_SIGNATURE_HEADER = "x-openlup-communications-signature";
export const COMMUNICATION_INTEGRATION_TIMESTAMP_HEADER = "x-openlup-communications-timestamp";

export function verifyCommunicationIntegrationEventSignature(input: {
  rawBody: string;
  signatureHeader: string | undefined;
  timestampHeader: string | undefined;
  secret: string;
  now?: () => number;
}): boolean {
  if (!input.secret || !input.signatureHeader || !input.timestampHeader) return false;
  const timestamp = Number(input.timestampHeader);
  if (!Number.isFinite(timestamp)) return false;
  const now = input.now ?? (() => Math.floor(Date.now() / 1000));
  const age = now() - timestamp;
  if (age > COMMUNICATION_INTEGRATION_SIGNATURE_TOLERANCE_SECONDS) return false;
  if (age < -COMMUNICATION_INTEGRATION_SIGNATURE_TOLERANCE_SECONDS) return false;

  const signature = normalizeSignature(input.signatureHeader);
  const expected = signCommunicationIntegrationEvent({
    rawBody: input.rawBody,
    timestamp,
    secret: input.secret,
  });
  return safeEqual(signature, expected);
}

export function signCommunicationIntegrationEvent(input: {
  rawBody: string;
  timestamp: number;
  secret: string;
}): string {
  return createHmac("sha256", input.secret)
    .update(`${input.timestamp}.${input.rawBody}`)
    .digest("hex");
}

function normalizeSignature(value: string): string {
  return value.trim().replace(/^sha256=/i, "");
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
