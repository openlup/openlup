import { COMMERCE_RECOMMENDATION_REASON_CODES } from "./recommendationConstants.js";
import type {
  CommerceRecommendationReasonCode,
  RecommendationEnergyEvidence,
  RecommendationVariant,
  SuggestedRecommendationVariant,
} from "./recommendationEngine.js";
import type { DailyEnergyEvidence } from "./recommendationPolicyDeps.js";

export function mapSuggestedVariants(
  variants: readonly RecommendationVariant[],
  suggestedVariantIds: readonly string[],
): SuggestedRecommendationVariant[] {
  return suggestedVariantIds.flatMap((variantId) => {
    const variant = variants.find((candidate) => candidate.variantId === variantId);
    return variant ? [{
      variantId: variant.variantId,
      sku: variant.sku,
      slug: variant.slug,
      purchaseAvailability: variant.purchaseAvailability,
      sellableNow: variant.sellableNow,
    }] : [];
  });
}

export function withDailyGrams(
  energy: DailyEnergyEvidence,
  dailyGrams: number | null,
): RecommendationEnergyEvidence {
  return { ...energy, dailyGrams };
}

export function uniqueReasonCodes(
  reasons: readonly (string | null)[],
): CommerceRecommendationReasonCode[] {
  const allowed = new Set<string>(COMMERCE_RECOMMENDATION_REASON_CODES);
  return [...new Set(reasons.filter((reason): reason is string => Boolean(reason)))]
    .filter((reason) => allowed.has(reason)) as CommerceRecommendationReasonCode[];
}

export function roundOneDecimal(value: number): number {
  return Math.round(value * 10) / 10;
}
