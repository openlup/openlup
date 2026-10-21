import { selectUniqueEffectivePriceList } from "../pricing/index.js";
import { BundleCatalogReadError, type BundleTargetPriceRow } from "./bundleCatalogReadPort.js";

/** Half-open windows share the price authority's effective-time rule. */
function bundlePriceEffective(row: { validFrom: string; validTo: string | null }, atTime: string): boolean {
  try {
    selectUniqueEffectivePriceList([{ value: "row", ...row }], atTime);
    return true;
  } catch { return false; }
}
export function uniqueBundlePrice<T extends { mode: string }>(rows: readonly T[], mode: string): T | null {
  const exact = rows.filter(row => row.mode === mode);
  const candidates = exact.length ? exact : rows.filter(row => row.mode === "any");
  if (candidates.length > 1) throw new BundleCatalogReadError("bundle_price_ambiguous");
  return candidates[0] ?? null;
}
export function selectEffectiveBundleTargetPrice(
  rows: readonly { price: BundleTargetPriceRow; priceListId: string }[],
  context: { priceListId: string | null; currency: string | null; mode: string; atTime: string },
): BundleTargetPriceRow | null {
  if (context.priceListId === null || context.currency === null) return null;
  return uniqueBundlePrice(rows.filter(row => row.priceListId === context.priceListId
    && row.price.currency === context.currency && row.price.active && row.price.amountKind === "gross"
    && row.price.targetPriceMinor > 0 && bundlePriceEffective(row.price, context.atTime)).map(row => row.price), context.mode);
}
