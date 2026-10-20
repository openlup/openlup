export const SUBSCRIPTION_PRICE_POLICY_SCHEMA_VERSION = "subscription-price-policy.v1";
export const SUBSCRIPTION_PRICE_POLICY_DEFAULT_DISCOUNT_BPS = 1_000;
export const SUBSCRIPTION_PRICE_POLICY_DEFAULT_QUANTUM_MINOR = 10;

export interface SubscriptionPricePolicySemantics {
  discountBps: number;
  roundingQuantumMinor: number;
  roundingRule: "FLOOR_TO_QUANTUM";
}

export interface SubscriptionPricePolicyCanonicalInput extends SubscriptionPricePolicySemantics {
  id: string;
  revisionNo: number;
  priceListId: string;
  regionCode: string;
  currency: string;
  channel: string;
  effectiveFrom: string;
  effectiveTo: string | null;
}

export interface SubscriptionPricePolicyRevision extends SubscriptionPricePolicyCanonicalInput {
  digest: string;
}

export type SubscriptionPricePolicyDigestRefusal = "subscription_price_policy_digest_mismatch";
