import type { ShippingTerms } from "../shipping/index.js";
import type { ResolvedAcquisitionTerms } from "../pricing/index.js";
import type { CommerceQuote } from "../pricing/index.js";
import type { PromotionAcceptanceTelemetry } from "./promotionAcceptanceTelemetry.js";
import { type PromotionQuoteMismatchField } from "./promotionQuoteBinding.js";
import { promotionQuoteAcceptanceEnvelope } from "./promotionQuoteAcceptanceEnvelope.js";

export const PROMOTION_ACCEPTANCE_MAX_TTL_MS = promotionQuoteAcceptanceEnvelope.maxTtlMs;
export const PROMOTION_ACCEPTANCE_CLOCK_SKEW_MS = 60_000 satisfies typeof promotionQuoteAcceptanceEnvelope.clockSkewMs;
const {
  payloadSchema, v2Discounts, keyId, requestBinding, codeBinding, quoteBinding, sectionBindings,
  sign, expiryBucket, rejected, assertSecret, verifyLegacy,
} = promotionQuoteAcceptanceEnvelope;
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

export function createPromotionQuoteAcceptance<Request extends { promoCodes: string[] }>({
  projectRequest, purpose,
}: {
  projectRequest(request: Request): unknown;
  /** A separate token domain for explicit offer review, including quotes without adjustments. */
  purpose?: "offer-review";
}) {
  const reviewsOffer = purpose === "offer-review";
  function issuePromotionQuoteAcceptance(input: {
    request: Request;
    quote: CommerceQuote;
    acquisitionTerms?: ResolvedAcquisitionTerms;
    shippingTerms?: ShippingTerms;
    keyring: PromotionAcceptanceKeyring;
    now?: Date;
  }): string | null {
    return issuePromotionQuoteAcceptanceWithOutcome(input).token;
  }

  function issuePromotionQuoteAcceptanceWithOutcome(input: {
    request: Request;
    quote: CommerceQuote;
    acquisitionTerms?: ResolvedAcquisitionTerms;
    shippingTerms?: ShippingTerms;
    keyring: PromotionAcceptanceKeyring;
    now?: Date;
  }): { token: string | null; diagnostic: PromotionAcceptanceDiagnostic } {
    const evidence = v2Discounts(input.quote);
    if (!reviewsOffer && evidence.length === 0 && !input.acquisitionTerms && !input.shippingTerms) return {
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
      requestBinding: requestBinding(projectRequest(input.request), input.keyring.current),
      codeBinding: codeBinding(input.request.promoCodes, input.keyring.current),
      quoteBinding: quoteBinding(input.quote, input.keyring.current, input.acquisitionTerms, input.shippingTerms),
      sectionBindings: sectionBindings(input.quote, input.keyring.current, input.acquisitionTerms, input.shippingTerms),
      totalMinor: input.quote.totalGross.amountMinor,
      currency: input.quote.totalGross.currency,
    });
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
    return {
      token: `${encoded}.${sign(encoded, input.keyring.current, reviewsOffer)}`,
      diagnostic: {
        accepted: true,
        reason: "issued",
        keySlot: "current",
        expiryBucket: expiryBucket(exp, nowMs),
      },
    };
  }

  function verifyPromotionQuoteAcceptance(input: {
    token: string;
    request: Request;
    quote: CommerceQuote;
    acquisitionTerms?: ResolvedAcquisitionTerms;
    shippingTerms?: ShippingTerms;
    expectedTotal: { amountMinor: number; currency: string };
    keyring: PromotionAcceptanceKeyring;
    now?: Date;
  }): boolean {
    return verifyPromotionQuoteAcceptanceWithOutcome(input).accepted;
  }

  function verifyPromotionQuoteAcceptanceWithOutcome(input: {
    token: string;
    request: Request;
    quote: CommerceQuote;
    acquisitionTerms?: ResolvedAcquisitionTerms;
    shippingTerms?: ShippingTerms;
    expectedTotal: { amountMinor: number; currency: string };
    keyring: PromotionAcceptanceKeyring;
    now?: Date;
  }): PromotionAcceptanceDiagnostic {
    return verifyLegacy(input, reviewsOffer, () => projectRequest(input.request));
  }

  return { issuePromotionQuoteAcceptance, issuePromotionQuoteAcceptanceWithOutcome, verifyPromotionQuoteAcceptance, verifyPromotionQuoteAcceptanceWithOutcome };
}
