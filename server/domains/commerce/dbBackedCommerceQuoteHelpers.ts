export { buildSkuIndex, eligibleQtyForMode, resolveOneTimeComparison, resolveStrictQuotePrice, assertSubscriptionCheapest, toGrossMinor, calculateIncludedVat, mapPricingComponent, moneyIn, sum } from "@openlup/platform/pricing";
export type { SkuIndexEntry, StrictQuotePriceResolution } from "@openlup/platform/pricing";

/**
 * Energy content of one unit of a SKU, from the product's per-100g composition
 * and the SKU's net weight. Null when either input is missing, because an
 * estimate resting on a guessed weight is worse than no estimate at all.
 */
export function catalogEnergyPerUnit(
  kcalPer100g: number | null | undefined,
  netWeightGrams: number | undefined,
): number | null {
  return Number.isFinite(kcalPer100g) && Number.isFinite(netWeightGrams)
    ? Math.round(((kcalPer100g as number) * (netWeightGrams as number)) / 100)
    : null;
}

/** Coverage days, rounded to one decimal. Informational only. */
export function roundCoverage(value: number): number {
  return Math.round(value * 10) / 10;
}
