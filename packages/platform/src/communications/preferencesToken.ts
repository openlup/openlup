import type { CommunicationPurposeRegistry } from "./contracts/consent.js";
import { createHmac, timingSafeEqual } from "node:crypto";

export type LegacyCommunicationPreferencePurpose = "tester_program" | "marketing_launch_offer" | "marketing_newsletter";

export interface CommunicationPreferenceTokenPayload<Purpose extends string = LegacyCommunicationPreferencePurpose> {
  email: string;
  purpose: Purpose;
  expiresAt: number;
}

export function verifyCommunicationPreferenceToken(token: string, secret: string, nowMs?: number): CommunicationPreferenceTokenPayload | null;
export function verifyCommunicationPreferenceToken<Purpose extends string>(token: string, secret: string, nowMs: number | undefined, registry: CommunicationPurposeRegistry<Purpose>): CommunicationPreferenceTokenPayload<Purpose> | null;
export function verifyCommunicationPreferenceToken(
  token: string,
  secret: string,
  nowMs = Date.now(),
  registry?: CommunicationPurposeRegistry<string>,
): CommunicationPreferenceTokenPayload<string> | null {
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
      typeof purpose !== "string" || (registry ? !registry.has(purpose) :
      purpose !== "tester_program" &&
      purpose !== "marketing_launch_offer" &&
      purpose !== "marketing_newsletter")
    ) {
      return null;
    }
    return { email, purpose, expiresAt };
  } catch {
    return null;
  }
}

export function createCommunicationPreferenceToken<Purpose extends string = LegacyCommunicationPreferencePurpose>(
  payload: CommunicationPreferenceTokenPayload<Purpose>,
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
