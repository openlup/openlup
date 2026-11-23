import type { ShippingTerms } from "../shipping/index.js";
import type { ResolvedAcquisitionTerms } from "../pricing/index.js";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { CommerceQuote, CommerceQuoteDiscount } from "../pricing/index.js";
import type { PromotionAcceptanceDiagnostic, PromotionAcceptanceKeyring } from "./promotionQuoteAcceptance.js";
import type { PromotionAcceptanceTelemetry } from "./promotionAcceptanceTelemetry.js";
import {
  projectPromotionQuoteMoney,
  promotionQuoteMoneySections,
  PROMOTION_QUOTE_MONEY_SECTIONS,
  stableJson,
  type PromotionQuoteMismatchField,
} from "./promotionQuoteBinding.js";
const maxTtlMs = 72 * 60 * 60 * 1_000;
const clockSkewMs = 60_000;

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
const compatiblePayloadSchema = payloadSchema.extend({
  ownerQuoteDigest: z.string().regex(/^[0-9a-f]{64}$/).optional(),
}).strict();
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
type PromotionQuoteMoneySectionKey = (typeof PROMOTION_QUOTE_MONEY_SECTIONS)[number];

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

function requestBinding(projectedRequest: unknown, secret: string): string {
  return hmac(secret, stableJson(projectedRequest));
}

function codeBinding(codes: readonly string[], secret: string): string {
  return hmac(secret, stableJson([...new Set(codes.map((code) => code.trim().toUpperCase()))].sort()));
}

function quoteBinding(quote: CommerceQuote, secret: string, acquisitionTerms?: ResolvedAcquisitionTerms, shippingTerms?: ShippingTerms): string {
  return hmac(secret, stableJson(projectPromotionQuoteMoney(quote, acquisitionTerms, shippingTerms)));
}

function sectionBindings(
  quote: CommerceQuote,
  secret: string,
  acquisitionTerms?: ResolvedAcquisitionTerms,
  shippingTerms?: ShippingTerms,
): Record<PromotionQuoteMoneySectionKey, string> {
  const sections = promotionQuoteMoneySections(quote, acquisitionTerms, shippingTerms);
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
  acquisitionTerms?: ResolvedAcquisitionTerms,
  shippingTerms?: ShippingTerms,
): PromotionQuoteMismatchField {
  if (!issued) return "other";
  const verified = sectionBindings(quote, secret, acquisitionTerms, shippingTerms);
  return PROMOTION_QUOTE_MONEY_SECTIONS
    .find((section) => issued[section] !== verified[section]) ?? "other";
}

function keyId(secret: string): string {
  return createHash("sha256").update(secret).digest("hex").slice(0, 16);
}

function hmac(secret: string, value: string): string {
  return createHmac("sha256", secret).update(value).digest("hex");
}

function sign(encoded: string, secret: string, reviewsOffer: boolean): string {
  return createHmac("sha256", secret)
    .update(reviewsOffer ? "openlup.offer-review.v1." + encoded : encoded)
    .digest("base64url");
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function assertSecret(secret: string): void {
  if (secret.length < 32) throw new Error("promotion_acceptance_secret_invalid");
}

type AuthenticatedEnvelope = {
  authenticated: true;
  payload: z.infer<typeof compatiblePayloadSchema>;
  secret: string;
  keySlot: "current" | "previous";
};
type EnvelopeResult = AuthenticatedEnvelope | { authenticated: false; diagnostic: PromotionAcceptanceDiagnostic };
type QuoteVerificationInput = {
  quote: CommerceQuote;
  acquisitionTerms?: ResolvedAcquisitionTerms;
  shippingTerms?: ShippingTerms;
  expectedTotal: { amountMinor: number; currency: string };
};

function boundedAsciiToken(token: string): boolean {
  return token.length > 0 && token.length <= 8_300 && !/[^A-Za-z0-9_.-]/.test(token);
}

function authenticateEnvelope(token: string, keyring: PromotionAcceptanceKeyring, reviewsOffer: boolean): EnvelopeResult {
  const malformed = { authenticated: false, diagnostic: rejected("malformed") } as const;
  if (!boundedAsciiToken(token)) return malformed;
  const [encoded, signature, extra] = token.split(".");
  if (!encoded || encoded.length > 8_192 || signature?.length !== 43 || extra !== undefined) return malformed;
  const bytes = Buffer.from(encoded, "base64url");
  if (bytes.toString("base64url") !== encoded || Buffer.from(signature, "base64url").toString("base64url") !== signature) {
    return malformed;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(utf8.decode(bytes));
  } catch {
    return malformed;
  }
  const payload = compatiblePayloadSchema.safeParse(parsed);
  if (!payload.success) return malformed;
  const candidates = [
    { slot: "current" as const, secret: keyring.current },
    { slot: "previous" as const, secret: keyring.previous },
  ];
  const candidate = candidates.find((value) => typeof value.secret === "string" && value.secret.length >= 32
    && keyId(value.secret) === payload.data.kid);
  if (!candidate?.secret) return { authenticated: false, diagnostic: rejected("unknown_key") };
  if (!safeEqual(signature, sign(encoded, candidate.secret, reviewsOffer))) {
    return { authenticated: false, diagnostic: rejected("signature_invalid") };
  }
  return { authenticated: true, payload: payload.data, secret: candidate.secret, keySlot: candidate.slot };
}

function verifyScope({ payload, secret }: AuthenticatedEnvelope, projectedRequest: unknown, promoCodes: readonly string[]) {
  if (payload.requestBinding !== requestBinding(projectedRequest, secret)) return "request_mismatch";
  if (payload.codeBinding !== codeBinding(promoCodes, secret)) return "code_mismatch";
}

function verifyTiming({ payload: { exp, iat }, keySlot }: AuthenticatedEnvelope, now: Date): PromotionAcceptanceDiagnostic {
  const nowMs = now.getTime();
  const base = { keySlot, expiryBucket: expiryBucket(exp, nowMs) };
  if (exp <= iat || exp - iat > maxTtlMs) return { accepted: false, reason: "ttl_invalid", ...base };
  if (iat > nowMs + clockSkewMs) return { accepted: false, reason: "not_yet_valid", ...base };
  if (nowMs >= exp) return { accepted: false, reason: "expired", ...base };
  return { accepted: true, reason: "accepted", ...base };
}

function verifyQuote({ payload, secret }: AuthenticatedEnvelope, timing: PromotionAcceptanceDiagnostic,
  { quote, acquisitionTerms, shippingTerms, expectedTotal }: QuoteVerificationInput, reviewsOffer: boolean): PromotionAcceptanceDiagnostic {
  if (payload.quoteBinding !== quoteBinding(quote, secret, acquisitionTerms, shippingTerms)) {
    const mismatchField = namedMismatchField(payload.sectionBindings, quote, secret, acquisitionTerms, shippingTerms);
    return { ...timing, accepted: false, reason: "quote_mismatch", mismatchField };
  }
  if (payload.totalMinor !== expectedTotal.amountMinor) return { ...timing, accepted: false, reason: "total_mismatch" };
  if (payload.currency !== expectedTotal.currency) return { ...timing, accepted: false, reason: "currency_mismatch" };
  if (!reviewsOffer && v2Discounts(quote).length === 0 && !acquisitionTerms && !shippingTerms) {
    return { ...timing, accepted: false, reason: "no_v2_adjustment_in_quote" };
  }
  return timing;
}

function verifyLegacy(input: QuoteVerificationInput & {
  token: string;
  request: { promoCodes: readonly string[] };
  keyring: PromotionAcceptanceKeyring;
  now?: Date;
}, reviewsOffer: boolean, projectRequest: () => unknown): PromotionAcceptanceDiagnostic {
  const envelope = authenticateEnvelope(input.token, input.keyring, reviewsOffer);
  if (!envelope.authenticated) return envelope.diagnostic;
  if (envelope.payload.ownerQuoteDigest !== undefined) return rejected("malformed");
  const timing = verifyTiming(envelope, input.now ?? new Date());
  if (!timing.accepted) return timing;
  const scope = verifyScope(envelope, projectRequest(), input.request.promoCodes);
  if (scope) return { ...timing, accepted: false, reason: scope };
  return verifyQuote(envelope, timing, input, reviewsOffer);
}

function authenticateSelectedEnvelope(token: string, keyring: PromotionAcceptanceKeyring, reviewsOffer: boolean) {
  if (!boundedAsciiToken(token)) return { authenticated: false, diagnostic: rejected("malformed") } as const;
  const originalTokenDigest = createHash("sha256").update(token, "ascii").digest("hex");
  const envelope = authenticateEnvelope(token, keyring, reviewsOffer);
  return envelope.authenticated ? { ...envelope, originalTokenDigest } : envelope;
}

/** @experimental Package-internal verifier. Callers supply a server-owned scope and owner quote digest. */
export function verifySelectedPromotionQuoteAcceptance(input: QuoteVerificationInput & {
  token: string;
  projectedRequest: unknown;
  promoCodes: readonly string[];
  purpose?: "offer-review";
  expectedOwnerQuoteDigest: string;
  keyring: PromotionAcceptanceKeyring;
  now?: Date;
}): PromotionAcceptanceDiagnostic {
  const reviewsOffer = input.purpose === "offer-review";
  const envelope = authenticateSelectedEnvelope(input.token, input.keyring, reviewsOffer);
  if (!envelope.authenticated) return envelope.diagnostic;
  const scope = verifyScope(envelope, input.projectedRequest, input.promoCodes);
  if (scope) return rejected(scope);
  const timing = verifyTiming(envelope, input.now ?? new Date());
  if (!timing.accepted) return timing;
  if (envelope.payload.ownerQuoteDigest === undefined || envelope.payload.ownerQuoteDigest !== input.expectedOwnerQuoteDigest) {
    return { ...timing, accepted: false, reason: "quote_mismatch" };
  }
  return verifyQuote(envelope, timing, input, reviewsOffer);
}

/** @experimental Shared implementation for the incumbent issuer and verifier. */
export const promotionQuoteAcceptanceEnvelope = {
  maxTtlMs, clockSkewMs, payloadSchema, v2Discounts, keyId, requestBinding, codeBinding, quoteBinding,
  sectionBindings, sign, expiryBucket, rejected, assertSecret, verifyLegacy,
} as const;
