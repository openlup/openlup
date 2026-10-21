/** Shipping promises selected by an opt-in host policy. Runtime validation is server-only. */
export interface ShippingTerms {
  version: "shipping-threshold.v1";
  currency: string;
  flatMinor: number;
  freeThresholdMinor: number;
}
export interface ShippingPolicyEntry {
  enabled: boolean;
  flatMinor: number;
  freeThresholdMinor: number;
  effectiveFrom: string;
}
export interface ShippingPolicy {
  version: "shipping-policy.v1";
  current: ShippingPolicyEntry | null;
  scheduled?: ShippingPolicyEntry | null;
}
export interface ShippingSettings {
  legacyFlatMinor: number;
  policy: ShippingPolicy | null;
}
