import type { CommerceRecommendationSnapshot } from "@/domains/commerce/recommendationContracts";
import { COMMERCE_MIN_ORDER_UNITS } from "@/domains/commerce/recommendationPolicyDeps";

/**
 * Line γ seam: the neutral half of the recommendation snapshot module.
 *
 * The checkout machine asks the recommendation exactly two things — *"is this basket
 * something I may take money for"* and *"what shape does the summary render"*. Neither
 * question knows what the basket contains: both are expressed purely over
 * `CommerceRecommendationSnapshot`, which is already a published commerce contract, plus
 * the published minimum-order constant.
 *
 * What stayed in the overlay is the half that *does* know: building the request from a
 * subject profile (weight, age band, body condition, allergens, flavours). That module
 * re-exports this one, so nothing outside the moved set changed its import.
 *
 * ⛔ Do not grow this module with anything that reads the vertical's vocabulary. The test
 * is the one the canon uses: a second vertical must be able to satisfy these functions by
 * producing a snapshot, without editing this file.
 */

export interface RecommendationBundleLine {
  variantId: string;
  slug: string;
  quantity: number;
  purchaseAvailability?: "available" | "low_stock" | "out_of_stock" | "unknown";
  // Internal sellable-stock cap used to bound the mix editor's "+". Never rendered
  // as a number. `null`/`undefined` ⇒ unknown ⇒ no cap.
  sellableNow?: number | null;
}

export interface RecommendationExcludedProduct {
  slug: string;
  allergenSlugs: readonly string[];
}

export interface RecommendationBundleSummary {
  status: CommerceRecommendationSnapshot["status"];
  reasonCodes: CommerceRecommendationSnapshot["reasonCodes"];
  dailyKcal: number | null;
  dailyGrams: number | null;
  totalCans: number;
  totalWeightG: number;
  feedingDays: number | null;
  perFlavor: RecommendationBundleLine[];
  excludedProducts: RecommendationExcludedProduct[];
}

/**
 * Whether a resolved recommendation may be taken to checkout.
 *
 * Every clause is structural: a status that is not held for review, a resolved ration, at
 * least one line, a basket at or above the published minimum, and per-line quantities that
 * are whole numbers inside the representable range.
 */
export function isCheckoutableRecommendation(
  snapshot: CommerceRecommendationSnapshot | null | undefined,
): snapshot is CommerceRecommendationSnapshot {
  return Boolean(
    snapshot &&
      snapshot.status !== "manual_review" &&
      snapshot.dailyKcal &&
      snapshot.lines.length > 0 &&
      snapshot.lines.reduce((sum, line) => sum + line.qty, 0) >= COMMERCE_MIN_ORDER_UNITS &&
      snapshot.lines.every((line) => Number.isInteger(line.qty) && line.qty >= 1 && line.qty <= 99),
  );
}
