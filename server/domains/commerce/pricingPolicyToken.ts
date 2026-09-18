import { createHmac, timingSafeEqual } from "node:crypto";

import {
  OFFER_POLICY_V1,
  OFFER_POLICY_V2,
  OFFER_POLICY_V2_CAPABILITY,
  PROMOTION_ENGINE_V1,
  PROMOTION_ENGINE_V2,
  type OfferPolicyVersion,
  type PromotionEngineVersion,
} from "../../../src/domains/commerce/offerPolicyContracts.js";

const TOKEN_PREFIX = "pp1";
// Rollout contract: an already-started checkout keeps its assigned policy for
// at least the 72-hour compatibility window, including during a rollback.
const DEFAULT_TTL_MS = 72 * 60 * 60 * 1_000;

export interface PricingPolicyTokenPayload {
  assignmentKeyHash: string;
  issuedAtMs: number;
  expiresAtMs: number;
  offerPolicyVersion: OfferPolicyVersion;
  promotionEngineVersion: PromotionEngineVersion;
}

interface CreateTokenInput extends Omit<PricingPolicyTokenPayload, "assignmentKeyHash"> {
  assignmentKey: string;
}

export function createPricingPolicyToken(input: CreateTokenInput, secret: string): string {
  assertSecret(secret);
  const payload: PricingPolicyTokenPayload = {
    assignmentKeyHash: assignmentHash(input.assignmentKey, secret),
    issuedAtMs: input.issuedAtMs,
    expiresAtMs: input.expiresAtMs,
    offerPolicyVersion: input.offerPolicyVersion,
    promotionEngineVersion: input.promotionEngineVersion,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${TOKEN_PREFIX}.${encoded}.${sign(encoded, secret)}`;
}

export function verifyPricingPolicyToken(
  token: string,
  secret: string,
  nowMs = Date.now(),
): PricingPolicyTokenPayload | null {
  if (secret.trim().length < 32) return null;
  const [prefix, encoded, signature, extra] = token.split(".");
  if (prefix !== TOKEN_PREFIX || !encoded || !signature || extra) return null;
  if (!safeEqual(signature, sign(encoded, secret))) return null;
  try {
    const value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Record<string, unknown>;
    const pairIsValid =
      (value.offerPolicyVersion === OFFER_POLICY_V1 && value.promotionEngineVersion === PROMOTION_ENGINE_V1) ||
      (value.offerPolicyVersion === OFFER_POLICY_V2 && value.promotionEngineVersion === PROMOTION_ENGINE_V2);
    if (
      !pairIsValid || typeof value.assignmentKeyHash !== "string" ||
      typeof value.issuedAtMs !== "number" || typeof value.expiresAtMs !== "number" ||
      value.issuedAtMs > nowMs || value.expiresAtMs < nowMs
    ) return null;
    return value as unknown as PricingPolicyTokenPayload;
  } catch {
    return null;
  }
}

export function resolvePricingPolicy(input: {
  assignmentKey?: string;
  capability?: string;
  token?: string;
  secret: string;
  v2Enabled: boolean;
  rolloutBps: number;
  nowMs?: number;
  ttlMs?: number;
}) {
  const nowMs = input.nowMs ?? Date.now();
  const existing = input.token ? verifyPricingPolicyToken(input.token, input.secret, nowMs) : null;
  const boundExisting = existing && input.assignmentKey &&
    existing.assignmentKeyHash === assignmentHash(input.assignmentKey, input.secret)
      ? existing : null;
  if (boundExisting) return { ...boundExisting, pricingPolicyToken: input.token };

  const eligible = input.v2Enabled && input.capability === OFFER_POLICY_V2_CAPABILITY &&
    Boolean(input.assignmentKey) && input.secret.trim().length >= 32;
  const rolloutBps = Math.max(0, Math.min(10_000, Math.trunc(input.rolloutBps)));
  const v2 = eligible && cohort(input.assignmentKey!, input.secret) < rolloutBps;
  const offerPolicyVersion = v2 ? OFFER_POLICY_V2 : OFFER_POLICY_V1;
  const promotionEngineVersion = v2 ? PROMOTION_ENGINE_V2 : PROMOTION_ENGINE_V1;
  if (!eligible) return { offerPolicyVersion, promotionEngineVersion };

  return {
    offerPolicyVersion,
    promotionEngineVersion,
    pricingPolicyToken: createPricingPolicyToken({
      assignmentKey: input.assignmentKey!, issuedAtMs: nowMs,
      expiresAtMs: nowMs + (input.ttlMs ?? DEFAULT_TTL_MS),
      offerPolicyVersion, promotionEngineVersion,
    }, input.secret),
  };
}

function assignmentHash(value: string, secret: string): string {
  return createHmac("sha256", secret).update(`pricing-policy-identity:${value}`).digest("hex");
}
function cohort(value: string, secret: string): number {
  return Number.parseInt(createHmac("sha256", secret).update(`pricing-policy-cohort:${value}`).digest("hex").slice(0, 8), 16) % 10_000;
}
function sign(value: string, secret: string): string {
  return createHmac("sha256", secret).update(`${TOKEN_PREFIX}.${value}`).digest("base64url");
}
function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function assertSecret(secret: string): void {
  if (secret.trim().length < 32) throw new Error("pricing_policy_token_secret_too_short");
}
