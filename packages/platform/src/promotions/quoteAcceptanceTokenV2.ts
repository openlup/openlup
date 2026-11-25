import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { commerceQuoteV2Schema, quoteDigest, type CommerceQuoteV2 } from "../pricing/index.js";
import { PROMOTION_ACCEPTANCE_MAX_TTL_MS, type PromotionAcceptanceKeyring } from "./promotionQuoteAcceptance.js";
import { promotionQuoteAcceptanceEnvelope } from "./promotionQuoteAcceptanceEnvelope.js";
import { stableJson } from "./promotionQuoteBinding.js";

declare const acceptanceToken: unique symbol;

/** @experimental Signed final quote acceptance wire for authenticated server submit. */
export type QuoteAcceptanceTokenV2 = string & { readonly [acceptanceToken]: true };

const purpose = "commerce.quote-acceptance.v2";
const moneyVersion = "commerce.order-money.v2";
const maxPayload = 8_192;
const signatureLength = 43;
const maxWire = maxPayload + 1 + signatureLength;
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

const digest = z.string().length(64).regex(/^[0-9a-f]{64}$/u);
const uuid = z.string().length(36).regex(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u);
// Match the pricing ref domain for token-only references.
const ref = z.string().min(1).max(256).refine(value => !value.includes("\u0000") && !/[\uD800-\uDFFF]/u.test(value));
type Owner = Readonly<{
  installationRef: string;
  principalKind: "customer";
  principalRef: string;
  customerOrSessionRef: string;
}>;

const ownerShape = z.strictObject({
  installationRef: ref,
  principalKind: z.literal("customer"),
  principalRef: uuid,
  customerOrSessionRef: uuid,
});
const signedScope = {
  owner: ownerShape,
  requestDigest: digest,
  recurringAcceptanceRef: ref.optional(),
};
const scopeShape = z.object(signedScope);
const issuanceScopeShape = scopeShape.extend({ acceptanceRef: ref });

/** @experimental Server-owned inputs for final quote presentation and authenticated submit. */
export type QuoteAcceptanceScopeV2 = Readonly<{
  owner: Owner;
  /** Derived from the owner, checkout scope reference and quote ID. */
  requestDigest: string;
  quote: CommerceQuoteV2;
  recurringAcceptanceRef?: string;
  keyring: Readonly<PromotionAcceptanceKeyring>;
  nowMs: number;
}>;

/** @experimental The values shown before acceptance and verified at authenticated submit. */
export type QuoteAcceptancePresentationV2 = Readonly<{
  quoteDigest: string;
  mandatoryFeeKeys: readonly string[];
  payable: Readonly<{ currency: string; amountMinor: number }>;
}>;

const presentationShape = z.strictObject({
  quoteDigest: digest,
  mandatoryFeeKeys: z.array(ref.refine(value => value.length <= 128)).max(256),
  payable: z.strictObject({
    currency: z.string().length(3).regex(/^[A-Z]{3}$/u),
    amountMinor: z.number().int().nonnegative().refine(value => !Object.is(value, -0)),
  }),
});

const refusals = {
  mismatch: {
    kind: "refused", code: "quote_acceptance_mismatch", field: "/acceptanceToken",
    remedy: "Re-obtain valid acceptance from the authorized presentation path.",
  },
  presentation: {
    kind: "refused", code: "mandatory_fee_requires_all_in_display", field: "/presentationRef",
    remedy: "Present the full payable and applicable fees and obtain fresh acceptance.",
  },
  expired: {
    kind: "refused", code: "quote_acceptance_expired", field: "/acceptanceToken",
    remedy: "Obtain a fresh final presentation and acceptance.",
  },
} as const;

/** @experimental Fixed refusal tuples for final quote presentation and authenticated submit. */
export type QuoteAcceptanceRefusalV2 = (typeof refusals)[keyof typeof refusals];

const envelopeShape = z.strictObject({
  purpose: z.literal(purpose),
  v: z.literal(2),
  kid: z.string().length(16).regex(/^[0-9a-f]{16}$/u),
  exp: z.number().int(),
  ...signedScope,
  acceptanceRef: ref,
  quoteId: uuid,
  quoteDigest: digest,
  moneyVersion: z.literal(moneyVersion),
  moneyDigest: digest,
  // Authenticate a missing presentation ref so it receives the presentation refusal.
  presentationRef: digest.optional(),
});
type Envelope = z.infer<typeof envelopeShape>;
type Claims = Omit<QuoteAcceptanceScopeV2, "quote" | "keyring" | "nowMs"> & Readonly<{
  purpose: typeof purpose;
  v: 2;
  kid: string;
  exp: number;
  acceptanceRef: string;
  quoteId: string;
  quoteDigest: string;
  moneyVersion: typeof moneyVersion;
  moneyDigest: string;
  presentationRef: string;
}>;

function checkClock(nowMs: number): void {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new TypeError("Supply a valid server clock.");
}

function sealedQuote(quote: CommerceQuoteV2): CommerceQuoteV2 {
  const parsed = commerceQuoteV2Schema.safeParse(quote);
  if (!parsed.success) throw new TypeError("Supply a sealed final quote from its owner.");
  return parsed.data;
}

function eligibleKey(key: unknown): key is string {
  return typeof key === "string" && key.length >= 32;
}

const { keyId, sign } = promotionQuoteAcceptanceEnvelope;

function encode(payload: Envelope): string {
  return Buffer.from(stableJson(payload), "utf8").toString("base64url");
}

function mac(encoded: string, key: string): string {
  // The shared signer takes the complete MAC input when offer review is disabled.
  return sign(purpose + "." + encoded, key, false);
}

function decode(token: unknown): { encoded: string; signature: string; payload: Envelope } | undefined {
  if (typeof token !== "string" || token.length > maxWire || /[^A-Za-z0-9_.-]/u.test(token)) return;
  const [encoded, signature, extra] = token.split(".");
  if (!encoded || encoded.length > maxPayload || signature?.length !== signatureLength || extra !== undefined) return;
  const bytes = Buffer.from(encoded, "base64url");
  if (bytes.toString("base64url") !== encoded || Buffer.from(signature, "base64url").toString("base64url") !== signature) return;

  let value: unknown;
  try {
    value = JSON.parse(utf8.decode(bytes));
  } catch {
    return;
  }
  const parsed = envelopeShape.safeParse(value);
  if (!parsed.success || encode(parsed.data) !== encoded) return;
  return { encoded, signature, payload: parsed.data };
}

function present(quote: CommerceQuoteV2): QuoteAcceptancePresentationV2 {
  return {
    quoteDigest: quote.quoteDigest,
    mandatoryFeeKeys: quote.feeLines.map(line => line.feeKey).sort(),
    payable: { currency: quote.currency, amountMinor: quote.payableMinor },
  };
}

function presentationDigest({ quoteDigest: digest, mandatoryFeeKeys, payable }: QuoteAcceptancePresentationV2): string {
  return quoteDigest("commerce.quote-presentation.v2", [digest, mandatoryFeeKeys, payable]);
}

function matchesPresentation(input: unknown, expected: QuoteAcceptancePresentationV2): boolean {
  const parsed = presentationShape.safeParse(input);
  if (!parsed.success) return false;
  const { quoteDigest, mandatoryFeeKeys, payable } = parsed.data;
  const keys = mandatoryFeeKeys.sort();
  return quoteDigest === expected.quoteDigest && payable.currency === expected.payable.currency
    && payable.amountMinor === expected.payable.amountMinor && keys.length === expected.mandatoryFeeKeys.length
    && keys.every((key, index) => key === expected.mandatoryFeeKeys[index]);
}

function matchesScope(payload: Envelope, scope: z.infer<typeof scopeShape>, quote: CommerceQuoteV2, exp: number): boolean {
  const { owner } = scope;
  return payload.owner.installationRef === owner.installationRef
    && payload.owner.principalKind === owner.principalKind
    && payload.owner.principalRef === owner.principalRef
    && payload.owner.customerOrSessionRef === owner.customerOrSessionRef
    && payload.requestDigest === scope.requestDigest
    && payload.recurringAcceptanceRef === scope.recurringAcceptanceRef
    && payload.quoteId === quote.quoteId && payload.quoteDigest === quote.quoteDigest
    && payload.moneyDigest === quote.moneyDigest && payload.exp === exp;
}

/** @experimental Issue a signed token for later authenticated submit from a final server quote. */
export function issueQuoteAcceptanceTokenV2(
  input: QuoteAcceptanceScopeV2 & { acceptanceRef: string; presentation?: QuoteAcceptancePresentationV2 },
): { kind: "issued"; token: QuoteAcceptanceTokenV2; presentationRef: string } | QuoteAcceptanceRefusalV2 {
  checkClock(input.nowMs);
  const scope = issuanceScopeShape.safeParse(input);
  if (!scope.success) throw new TypeError("Supply a valid quote acceptance scope.");
  const key = input.keyring.current;
  if (!eligibleKey(key)) throw new TypeError("Configure a valid current quote acceptance signing key.");

  const quote = sealedQuote(input.quote);
  if (quote.status !== "final") return { ...refusals.mismatch };
  const expected = present(quote);
  if (!matchesPresentation(input.presentation, expected)) return { ...refusals.presentation };
  const exp = Date.parse(quote.taxEvidence.expiresAt);
  if (input.nowMs >= exp || exp - input.nowMs > PROMOTION_ACCEPTANCE_MAX_TTL_MS) return { ...refusals.expired };

  const presentationRef = presentationDigest(expected);
  const encoded = encode({
    ...scope.data, purpose, v: 2, kid: keyId(key), exp, quoteId: quote.quoteId, quoteDigest: quote.quoteDigest,
    moneyVersion, moneyDigest: quote.moneyDigest, presentationRef,
  });
  return { kind: "issued", token: `${encoded}.${mac(encoded, key)}` as QuoteAcceptanceTokenV2, presentationRef };
}

/** @experimental Authenticate the browser's acceptance with server-owned scope and quote at submit. */
export function verifyQuoteAcceptanceTokenV2(
  input: QuoteAcceptanceScopeV2 & { token: unknown; presentationRef?: unknown },
): ({ kind: "verified" } & Claims) | QuoteAcceptanceRefusalV2 {
  const envelope = decode(input.token);
  if (!envelope) return { ...refusals.mismatch };
  const { encoded, signature, payload } = envelope;
  const { current, previous } = input.keyring;
  const key = [current, previous].find(candidate => eligibleKey(candidate) && keyId(candidate) === payload.kid);
  if (!key || !timingSafeEqual(Buffer.from(signature, "ascii"), Buffer.from(mac(encoded, key), "ascii"))) {
    return { ...refusals.mismatch };
  }

  checkClock(input.nowMs);
  const scope = scopeShape.safeParse(input);
  if (!scope.success) throw new TypeError("Supply a valid quote acceptance scope.");
  const quote = sealedQuote(input.quote);
  const exp = Date.parse(quote.taxEvidence.expiresAt);
  if (quote.status !== "final" || !matchesScope(payload, scope.data, quote, exp)) return { ...refusals.mismatch };

  const presentationRef = presentationDigest(present(quote));
  if (payload.presentationRef !== presentationRef || input.presentationRef !== presentationRef) return { ...refusals.presentation };
  if (input.nowMs >= exp) return { ...refusals.expired };
  return { kind: "verified", ...payload, presentationRef };
}
