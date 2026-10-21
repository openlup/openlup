import type { AcquisitionQuote, AcquisitionTermsExpectation, PricingPolicySnapshot } from "@openlup/platform/pricing/contracts";
import { isPersistedPricingPolicyAssignment } from "./configuratorPricingPolicyPersistence";

/** Explicit top-level acquisition DTO binding; incumbent quote/cache inputs stay unchanged. */
export type ReferenceQuote = AcquisitionQuote & {
  pricingPolicy?: PricingPolicySnapshot;
  promotionAcceptanceToken?: string;
};
export interface ReferenceQuoteExpectation {
  totalGross: ReferenceQuote["totalGross"];
  pricingPolicy?: PricingPolicySnapshot;
  promotionAcceptanceToken: string;
  acquisitionTerms?: AcquisitionTermsExpectation;
}

export function referenceQuoteExpectation(quote: ReferenceQuote): ReferenceQuoteExpectation | null {
  if (!quote.promotionAcceptanceToken || !isPersistedPricingPolicyAssignment(quote.pricingPolicy)) return null;
  return {
    totalGross: { ...quote.totalGross },
    ...(quote.pricingPolicy ? { pricingPolicy: { ...quote.pricingPolicy } } : {}),
    promotionAcceptanceToken: quote.promotionAcceptanceToken,
    ...(quote.acquisitionTerms ? { acquisitionTerms: {
      revision: quote.acquisitionTerms.revision,
      delivery2DiscountBps: quote.acquisitionTerms.delivery2DiscountBps,
    } } : {}),
  };
}

/** Saved totals never replace the selected fresh, signed quote or explicit consent. */
export function referenceQuoteConsentMatches(expected: ReferenceQuoteExpectation | null, quote: ReferenceQuote | null): boolean {
  if (!expected || !quote) return false;
  const actual = referenceQuoteExpectation(quote);
  return actual !== null &&
    expected.totalGross.amountMinor === actual.totalGross.amountMinor &&
    expected.totalGross.currency === actual.totalGross.currency &&
    expected.promotionAcceptanceToken === actual.promotionAcceptanceToken &&
    expected.pricingPolicy?.offerPolicyVersion === actual.pricingPolicy?.offerPolicyVersion &&
    expected.pricingPolicy?.promotionEngineVersion === actual.pricingPolicy?.promotionEngineVersion &&
    expected.pricingPolicy?.pricingPolicyToken === actual.pricingPolicy?.pricingPolicyToken &&
    expected.acquisitionTerms?.revision === actual.acquisitionTerms?.revision &&
    expected.acquisitionTerms?.delivery2DiscountBps === actual.acquisitionTerms?.delivery2DiscountBps;
}
