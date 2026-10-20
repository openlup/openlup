import type { CommerceMoney } from "./money.js";
import type { PricingPolicySnapshot } from "./offerPolicy.js";
export const COMMERCE_OFFER_PRICING_CONTRACT_VERSION = "commerce.offer-pricing.v1" as const;
export const COMMERCE_OFFER_PRICING_V2_CONTRACT_VERSION = "commerce.offer-pricing.v2" as const;
export interface CommerceOfferPrice {
  packageGross: CommerceMoney;
  unitGross: CommerceMoney;
}
export interface CommerceProductOfferPricing {
  productSlug: string;
  unitCount: number;
  oneTime: CommerceOfferPrice;
  subscriptionInitial: CommerceOfferPrice;
  subscriptionRecurring: CommerceOfferPrice;
  catalogAnchorUnitGross: CommerceMoney;
  initialDiscountPercent: number;
  recurringDiscountPercent: number;
}
export type CommerceOfferPricingResponse<ScopeV1 extends string = string, ScopeV2 extends string = string> = {
  contractVersion: typeof COMMERCE_OFFER_PRICING_CONTRACT_VERSION;
  scope: ScopeV1;
  products: CommerceProductOfferPricing[];
  minimum: { oneTime: CommerceProductOfferPricing; subscription: CommerceProductOfferPricing };
} | {
  contractVersion: typeof COMMERCE_OFFER_PRICING_V2_CONTRACT_VERSION;
  scope: ScopeV2;
  products: CommerceProductOfferPricing[];
  minimum: { oneTime: CommerceProductOfferPricing; subscription: CommerceProductOfferPricing };
  pricingPolicy: PricingPolicySnapshot;
  shipping: { gross: CommerceMoney; discountGross: CommerceMoney; payable: CommerceMoney };
  minimumProductPayable: CommerceMoney;
};

/** Complete opt-in v3 response; the incumbent v1/v2 union stays unchanged. */
export const COMMERCE_OFFER_PRICING_V3_CONTRACT_VERSION = "commerce.offer-pricing.v3" as const;
export type AcquisitionOfferPricingResponse<ScopeV2 extends string = string> =
  Omit<Extract<CommerceOfferPricingResponse<string, ScopeV2>, { contractVersion: typeof COMMERCE_OFFER_PRICING_V2_CONTRACT_VERSION }>, "contractVersion"> & {
    contractVersion: typeof COMMERCE_OFFER_PRICING_V3_CONTRACT_VERSION;
    acquisitionTerms: import("./acquisitionTerms.js").AcquisitionTerms;
    observedAt: string;
    validUntil: string;
  };
