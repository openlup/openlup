import {
  type BuildCartRecommendationPolicies,
  type RecommendationVariant,
} from "../../domains/commerce/recommendationPolicyDeps.js";

const TEST_DAILY_ENERGY_POLICY_VERSION = "test.energy_policy.generic.v1";
const TEST_DAILY_ENERGY_SOURCE = "test_energy_policy";

export const TEST_RECOMMENDATION_POLICIES: BuildCartRecommendationPolicies = {
  resolveDailyEnergy(input) {
    return {
      ok: true,
      evidence: {
        policyVersion: TEST_DAILY_ENERGY_POLICY_VERSION,
        source: TEST_DAILY_ENERGY_SOURCE,
        ageBand: input.ageBand,
        activityLevel: input.activityLevel ?? "normal",
        bcs: input.bcs ?? "ideal",
        kcalPerKgBodyWeight075: 95,
        dailyKcal: 613,
      },
      reasonCodes: ["energy_policy_fediaf_2025"],
    };
  },
  buildPackageQuantity(variants, dailyKcal, _cadenceDays, options) {
    const pool = options?.stockBounded
      ? [...variants, ...(options.extraVariants ?? [])]
      : [...variants];
    const lines = pool.map((variant) =>
      toRecommendationLine(
        variant,
        options?.stockBounded ? Math.min(2, variant.sellableNow ?? 2) : 3,
      ),
    );
    const totalKcal = lines.reduce((sum, line) => sum + line.qty * line.kcalPerUnit, 0);
    const totalWeightG = lines.reduce((sum, line) => sum + line.qty * line.netWeightG, 0);
    const totalUnits = lines.reduce((sum, line) => sum + line.qty, 0);
    return {
      lines,
      totalUnits,
      totalWeightG,
      totalKcal,
      feedingDays: totalKcal / dailyKcal,
      dailyGrams: Math.round((dailyKcal * totalWeightG) / totalKcal),
      minimumApplied: false,
      largeQuantityWarning: false,
      maxExceeded: false,
      rebalanced: false,
      stockClamped: options?.stockBounded ?? false,
      stockConstrained: false,
    };
  },
};

function toRecommendationLine(variant: RecommendationVariant, qty: number) {
  return {
    variantId: variant.variantId,
    sku: variant.sku,
    slug: variant.slug,
    qty,
    netWeightG: variant.netWeightG,
    kcalPerUnit: Math.round((variant.kcalPer100g * variant.netWeightG) / 100),
    allergenSlugs: [...variant.allergenSlugs],
    purchaseAvailability: variant.purchaseAvailability ?? "available",
    sellableNow: variant.sellableNow ?? null,
  };
}
