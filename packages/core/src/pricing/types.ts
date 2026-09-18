/** @beta */
export const PRICING_MODES = ["one_time", "subscription", "any"] as const;
/** @beta */
export type PricingMode = (typeof PRICING_MODES)[number];

/** @beta */
export const PRICING_AMOUNT_KINDS = ["gross", "net"] as const;
/** @beta */
export type PricingAmountKind = (typeof PRICING_AMOUNT_KINDS)[number];

/** @beta */
export interface PricingRegion {
  regionCode: string;
  currency: string;
}

/** @beta */
export interface ResolvedPrice {
  variantId: string;
  mode: PricingMode;
  matchedMinQty: number;
  unitPriceMinor: number;
  amountKind: PricingAmountKind;
  priceListId: string;
  priceEntryId: string;
  resolvedAt: string;
}

/** @beta */
export interface ResolvePriceQuery extends PricingRegion {
  variantId: string;
  mode: PricingMode;
  lineQty: number;
  eligibleCartQty: number;
  atTime?: string;
}
