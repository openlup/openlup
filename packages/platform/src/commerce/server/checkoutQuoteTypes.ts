import type { AcquisitionTermsExpectation, ResolvedAcquisitionTerms, CreateQuoteResponse, CommerceQuoteContext, PricingPolicySnapshot } from "../../pricing/index.js";
export interface CheckoutQuoteSnapshot extends CreateQuoteResponse {
  quote: CreateQuoteResponse["quote"] & { context?: CommerceQuoteContext & { pricingPolicy?: PricingPolicySnapshot; acquisitionTerms?: ResolvedAcquisitionTerms; shippingTerms?: unknown; offerVersion?: string } };
}
export interface ExpectedCheckoutQuote {
  totalGross: { amountMinor: number; currency: string };
  pricingPolicy?: PricingPolicySnapshot;
  acquisitionTerms?: AcquisitionTermsExpectation;
}
