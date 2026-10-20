export const OFFER_POLICY_V1 = "commerce.offer-policy.v1" as const;
export const OFFER_POLICY_V2 = "commerce.offer-policy.v2" as const;
export const PROMOTION_ENGINE_V1 = "promotion-engine.v1" as const;
export const PROMOTION_ENGINE_V2 = "promotion-engine.v2" as const;
export const OFFER_POLICY_V2_CAPABILITY = OFFER_POLICY_V2;

export type OfferPolicyVersion = typeof OFFER_POLICY_V1 | typeof OFFER_POLICY_V2;
export type PromotionEngineVersion = typeof PROMOTION_ENGINE_V1 | typeof PROMOTION_ENGINE_V2;
export interface PricingPolicyRequest {
  capability?: typeof OFFER_POLICY_V2_CAPABILITY;
  token?: string;
}
export interface PricingPolicySnapshot {
  offerPolicyVersion: OfferPolicyVersion;
  promotionEngineVersion: PromotionEngineVersion;
  pricingPolicyToken?: string;
}
