import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { CreateQuoteRequest } from "../../../src/domains/commerce/contracts.js";
import type { CommerceQuote, CommerceQuoteDiscount } from "../../../src/domains/commerce/types.js";
import type { PromotionAcceptanceTelemetry } from "./promotionAcceptanceTelemetry.js";
import {
  projectPromotionQuoteMoney,
  promotionQuoteMoneySections,
  PROMOTION_QUOTE_MONEY_SECTIONS,
  stableJson,
  type PromotionQuoteMismatchField,
} from "./promotionQuoteBinding.js";

export const PROMOTION_ACCEPTANCE_MAX_TTL_MS = 72 * 60 * 60 * 1_000;
export const PROMOTION_ACCEPTANCE_CLOCK_SKEW_MS = 60_000;

const payloadSchema = z.object({
  v: z.literal(1),
  kid: z.string().regex(/^[0-9a-f]{16}$/),
  iat: z.number().int().nonnegative(),
  exp: z.number().int().positive(),
  engine: z.literal("promotion-engine.v2"),
  requestBinding: z.string().regex(/^[0-9a-f]{64}$/),
  codeBinding: z.string().regex(/^[0-9a-f]{64}$/),
  quoteBinding: z.string().regex(/^[0-9a-f]{64}$/),
  // Legacy payloads still parse, but their whole-quote binding is rejected.
  // Quote refresh issues a new money-bound token; missing sections report other.
  sectionBindings: z.object(Object.fromEntries(PROMOTION_QUOTE_MONEY_SECTIONS
    .map((section) => [section, z.string().regex(/^[0-9a-f]{64}$/)])) as Record<
      PromotionQuoteMoneySectionKey, z.ZodString>).strict().optional(),
  totalMinor: z.number().int().nonnegative(),
  currency: z.string().length(3),
}).strict();

type PromotionQuoteMoneySectionKey = (typeof PROMOTION_QUOTE_MONEY_SECTIONS)[number];

export interface PromotionAcceptanceKeyring {
  current: string;
  previous?: string | null;
}

export type PromotionAcceptanceDiagnostic = {
  accepted: boolean;
  reason: PromotionAcceptanceTelemetry["reason"];
  keySlot: PromotionAcceptanceTelemetry["keySlot"];
  expiryBucket: PromotionAcceptanceTelemetry["expiryBucket"];
  /** Present only on `quote_mismatch`: which money section diverged. */
  mismatchField?: PromotionQuoteMismatchField;
};

export function issuePromotionQuoteAcceptance(input: {
  request: CreateQuoteRequest;
  quote: CommerceQuote;
  keyring: PromotionAcceptanceKeyring;
  now?: Date;
}): string | null {
  return issuePromotionQuoteAcceptanceWithOutcome(input).token;
}

export function issuePromotionQuoteAcceptanceWithOutcome(input: {
  request: CreateQuoteRequest;
  quote: CommerceQuote;
  keyring: PromotionAcceptanceKeyring;
  now?: Date;
}): { token: string | null; diagnostic: PromotionAcceptanceDiagnostic } {
  const evidence = v2Discounts(input.quote);
  if (evidence.length === 0) return {
    token: null,
    diagnostic: rejected("no_v2_adjustment"),
  };
  assertSecret(input.keyring.current);
  const nowMs = (input.now ?? new Date()).getTime();
  const codeExpiry = Math.min(...evidence.map((discount) =>
    discount.promotionCodeValidTo ? Date.parse(discount.promotionCodeValidTo) : Number.POSITIVE_INFINITY));
  const exp = Math.min(nowMs + PROMOTION_ACCEPTANCE_MAX_TTL_MS, codeExpiry);
  if (!Number.isFinite(exp) || exp <= nowMs) return {
    token: null,
    diagnostic: rejected("ttl_invalid"),
  };
  const payload = payloadSchema.parse({
    v: 1,
    kid: keyId(input.keyring.current),
    iat: nowMs,
    exp,
    engine: "promotion-engine.v2",
    requestBinding: requestBinding(input.request, input.keyring.current),
    codeBinding: codeBinding(input.request.promoCodes, input.keyring.current),
    quoteBinding: quoteBinding(input.quote, input.keyring.current),
    sectionBindings: sectionBindings(input.quote, input.keyring.current),
    totalMinor: input.quote.totalGross.amountMinor,
    currency: input.quote.totalGross.currency,
  });
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return {
    token: `${encoded}.${sign(encoded, input.keyring.current)}`,
    diagnostic: {
      accepted: true,
      reason: "issued",
      keySlot: "current",
      expiryBucket: expiryBucket(exp, nowMs),
    },
  };
}

export function verifyPromotionQuoteAcceptance(input: {
  token: string;
  request: CreateQuoteRequest;
  quote: CommerceQuote;
  expectedTotal: { amountMinor: number; currency: string };
  keyring: PromotionAcceptanceKeyring;
  now?: Date;
}): boolean {
  return verifyPromotionQuoteAcceptanceWithOutcome(input).accepted;
}

export function verifyPromotionQuoteAcceptanceWithOutcome(input: {
  token: string;
  request: CreateQuoteRequest;
  quote: CommerceQuote;
  expectedTotal: { amountMinor: number; currency: string };
  keyring: PromotionAcceptanceKeyring;
  now?: Date;
}): PromotionAcceptanceDiagnostic {
  const verified = verifyEnvelopeWithOutcome(input.token, input.keyring, input.now ?? new Date());
  if (verified.verified === false) return verified.diagnostic;
  const { payload, secret } = verified;
  const base = { keySlot: verified.keySlot, expiryBucket: verified.expiryBucket };
  if (payload.requestBinding !== requestBinding(input.request, secret)) {
    return { accepted: false, reason: "request_mismatch", ...base };
  }
  if (payload.codeBinding !== codeBinding(input.request.promoCodes, secret)) {
    return { accepted: false, reason: "code_mismatch", ...base };
  }
  if (payload.quoteBinding !== quoteBinding(input.quote, secret)) {
    const mismatchField = namedMismatchField(payload.sectionBindings, input.quote, secret);
    return { accepted: false, reason: "quote_mismatch", mismatchField, ...base };
  }
  if (payload.totalMinor !== input.expectedTotal.amountMinor) {
    return { accepted: false, reason: "total_mismatch", ...base };
  }
  if (payload.currency !== input.expectedTotal.currency) {
    return { accepted: false, reason: "currency_mismatch", ...base };
  }
  if (v2Discounts(input.quote).length === 0) {
    return { accepted: false, reason: "no_v2_adjustment_in_quote", ...base };
  }
  return { accepted: true, reason: "accepted", ...base };
}

function verifyEnvelopeWithOutcome(
  token: string,
  keyring: PromotionAcceptanceKeyring,
  now: Date,
): ({
  verified: true;
  payload: z.infer<typeof payloadSchema>;
  secret: string;
  keySlot: "current" | "previous";
  expiryBucket: PromotionAcceptanceTelemetry["expiryBucket"];
} | { verified: false; diagnostic: PromotionAcceptanceDiagnostic }) {
  const [encoded, signature, extra] = token.split(".");
  if (!encoded || !signature || extra || encoded.length > 8_192 || signature.length !== 43) {
    return { verified: false, diagnostic: rejected("malformed") };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return { verified: false, diagnostic: rejected("malformed") };
  }
  const payload = payloadSchema.safeParse(parsed);
  if (!payload.success) return { verified: false, diagnostic: rejected("malformed") };
  const candidates = [
    { slot: "current" as const, secret: keyring.current },
    { slot: "previous" as const, secret: keyring.previous },
  ].filter((candidate): candidate is { slot: "current" | "previous"; secret: string } =>
    typeof candidate.secret === "string" && candidate.secret.length >= 32);
  const candidate = candidates.find((value) => keyId(value.secret) === payload.data.kid);
  if (!candidate) return { verified: false, diagnostic: rejected("unknown_key") };
  if (!safeEqual(signature, sign(encoded, candidate.secret))) {
    return { verified: false, diagnostic: rejected("signature_invalid") };
  }
  const nowMs = now.getTime();
  const safeBase = { keySlot: candidate.slot, expiryBucket: expiryBucket(payload.data.exp, nowMs) };
  if (payload.data.exp <= payload.data.iat ||
    payload.data.exp - payload.data.iat > PROMOTION_ACCEPTANCE_MAX_TTL_MS) {
    return { verified: false, diagnostic: { accepted: false, reason: "ttl_invalid", ...safeBase } };
  }
  if (payload.data.iat > nowMs + PROMOTION_ACCEPTANCE_CLOCK_SKEW_MS) {
    return { verified: false, diagnostic: { accepted: false, reason: "not_yet_valid", ...safeBase } };
  }
  if (nowMs >= payload.data.exp) {
    return { verified: false, diagnostic: { accepted: false, reason: "expired", ...safeBase } };
  }
  return {
    verified: true,
    payload: payload.data,
    secret: candidate.secret,
    keySlot: candidate.slot,
    expiryBucket: expiryBucket(payload.data.exp, nowMs),
  };
}

function rejected(reason: PromotionAcceptanceTelemetry["reason"]): PromotionAcceptanceDiagnostic {
  return { accepted: false, reason, keySlot: "none", expiryBucket: "none" };
}

function expiryBucket(exp: number, now: number): PromotionAcceptanceTelemetry["expiryBucket"] {
  const remaining = exp - now;
  if (remaining <= 0) return "expired";
  if (remaining < 60 * 60 * 1_000) return "lt_1h";
  if (remaining < 24 * 60 * 60 * 1_000) return "1_24h";
  return "24_72h";
}

function v2Discounts(quote: CommerceQuote): CommerceQuoteDiscount[] {
  return quote.discounts.filter((discount) =>
    discount.promotionEngineVersion === "promotion-engine.v2" &&
    discount.reasonCode === "promotion_code_v2");
}

function requestBinding(request: CreateQuoteRequest, secret: string): string {
  return hmac(secret, stableJson({
    mode: request.mode,
    cadenceDays: request.cadenceDays ?? null,
    lines: request.lines.map((line) => ({
      sku: line.sku, quantity: line.quantity, variantId: line.variantId ?? null,
      modeAtLine: line.modeAtLine ?? request.mode,
    })),
    sizeConstraint: request.sizeConstraint ? {
      kind: request.sizeConstraint.kind,
      value: request.sizeConstraint.value,
      dailyKcalOverride: request.sizeConstraint.dailyKcalOverride ?? null,
    } : null,
    visitorId: request.visitorId ?? null,
    customerEmail: request.customerEligibilityContext?.email?.trim().toLowerCase() ?? null,
  }));
}

function codeBinding(codes: readonly string[], secret: string): string {
  return hmac(secret, stableJson([...new Set(codes.map((code) => code.trim().toUpperCase()))].sort()));
}

function quoteBinding(quote: CommerceQuote, secret: string): string {
  return hmac(secret, stableJson(projectPromotionQuoteMoney(quote)));
}

function sectionBindings(
  quote: CommerceQuote,
  secret: string,
): Record<PromotionQuoteMoneySectionKey, string> {
  const sections = promotionQuoteMoneySections(quote);
  return Object.fromEntries(PROMOTION_QUOTE_MONEY_SECTIONS
    .map((section) => [section, hmac(secret, stableJson(sections[section]))])) as Record<
      PromotionQuoteMoneySectionKey, string>;
}

/**
 * The verifier holds only the issuer's HMACs, never the issued quote, so the
 * differing section is found by comparing per-section hashes in a fixed order.
 */
function namedMismatchField(
  issued: Record<PromotionQuoteMoneySectionKey, string> | undefined,
  quote: CommerceQuote,
  secret: string,
): PromotionQuoteMismatchField {
  if (!issued) return "other";
  const verified = sectionBindings(quote, secret);
  return PROMOTION_QUOTE_MONEY_SECTIONS
    .find((section) => issued[section] !== verified[section]) ?? "other";
}

function keyId(secret: string): string {
  return createHash("sha256").update(secret).digest("hex").slice(0, 16);
}

function hmac(secret: string, value: string): string {
  return createHmac("sha256", secret).update(value).digest("hex");
}

function sign(encoded: string, secret: string): string {
  return createHmac("sha256", secret).update(encoded).digest("base64url");
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function assertSecret(secret: string): void {
  if (secret.length < 32) throw new Error("promotion_acceptance_secret_invalid");
}
