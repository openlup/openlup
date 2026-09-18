import { createHmac, timingSafeEqual } from "node:crypto";

export interface CommunicationPreferenceTokenPayload {
  email: string;
  purpose: "tester_program" | "marketing_launch_offer" | "marketing_newsletter";
  expiresAt: number;
}

export function verifyCommunicationPreferenceToken(
  token: string,
  secret: string,
  nowMs = Date.now(),
): CommunicationPreferenceTokenPayload | null {
  const parts = token.split(".");
  if (parts.length !== 2 || !secret) return null;
  const [encoded, signature] = parts;
  const expected = hmac(encoded, secret);
  if (!safeEqual(signature, expected)) return null;

  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Record<string, unknown>;
    const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
    const purpose = payload.purpose;
    const expiresAt = typeof payload.expiresAt === "number" ? payload.expiresAt : 0;
    if (!email.includes("@") || expiresAt < nowMs) return null;
    if (
      purpose !== "tester_program" &&
      purpose !== "marketing_launch_offer" &&
      purpose !== "marketing_newsletter"
    ) {
      return null;
    }
    return { email, purpose, expiresAt };
  } catch {
    return null;
  }
}

export function createCommunicationPreferenceToken(
  payload: CommunicationPreferenceTokenPayload,
  secret: string,
): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${hmac(encoded, secret)}`;
}

function hmac(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value).digest("hex");
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
