import type {
  RecommendationActivityLevel,
  RecommendationAgeBand,
  RecommendationBcs,
  RecommendedCartLine,
  RecommendationVariant,
} from "./recommendationEngine.js";

export const COMMERCE_PACKAGE_QUANTITY_POLICY_VERSION =
  "commerce.package_quantity_policy.v1";

/** Neutral commerce minimum for every customer-configured order. */
export const COMMERCE_MIN_ORDER_UNITS = 14;

/** Compatibility alias for recommendation-policy consumers. */
export const COMMERCE_MIN_AUTO_ORDER_UNITS = COMMERCE_MIN_ORDER_UNITS;

export interface DailyEnergyInput {
  ageBand: RecommendationAgeBand;
  weightKg: number;
  activityLevel?: RecommendationActivityLevel;
  bcs?: RecommendationBcs;
  dailyKcalOverride?: number | null;
}

export interface DailyEnergyEvidence {
  policyVersion: string;
  source: string;
  ageBand: RecommendationAgeBand;
  activityLevel: RecommendationActivityLevel;
  bcs: RecommendationBcs;
  kcalPerKgBodyWeight075: number | null;
  dailyKcal: number | null;
}

export type DailyEnergyResult =
  | {
      ok: true;
      evidence: DailyEnergyEvidence & { dailyKcal: number; kcalPerKgBodyWeight075: number };
      reasonCodes: string[];
    }
  | {
      ok: false;
      code: "invalid_pet_profile" | "unsupported_life_stage";
      evidence: DailyEnergyEvidence;
      reasonCodes: string[];
    };

export interface PackageQuantityResult {
  lines: RecommendedCartLine[];
  /** Canonical package unit count. Downstream pet-food adapters may map one unit to one can. */
  totalUnits: number;
  totalWeightG: number;
  totalKcal: number;
  feedingDays: number;
  dailyGrams: number;
  minimumApplied: boolean;
  largeQuantityWarning: boolean;
  maxExceeded: boolean;
  rebalanced: boolean;
  stockClamped: boolean;
  stockConstrained: boolean;
  /** Selected flavours cannot jointly satisfy MOQ/target under stock + per-line caps. */
  selectedCapacityConstrained?: boolean;
  /** Selected flavours with no sellable unit, retained as an explicit selection problem. */
  unavailableSelectedVariantIds?: string[];
  /** Safe alternatives are suggestions only; they are never inserted into `lines`. */
  suggestedVariantIds?: string[];
}

/**
 * How large the package should be.
 *
 * `cadence_target` (default) sizes it to the dog's energy need over the cadence —
 * the only behaviour before the starter-pack offer. `minimum_order` sizes it to
 * the shop's minimum order instead, ignoring the cadence target; the cadence is
 * still carried for audit, so a `minimum_order` package at cadence 28 honestly
 * reports how few days it actually covers.
 */
export type CommercePackageSizePolicy = "cadence_target" | "minimum_order";

export interface BuildPackageQuantityOptions {
  stockBounded?: boolean;
  extraVariants?: readonly RecommendationVariant[];
  /** Defaults to `cadence_target`, i.e. every pre-starter-pack caller is unchanged. */
  sizePolicy?: CommercePackageSizePolicy;
}

export type CommerceDailyEnergyPolicy = (input: DailyEnergyInput) => DailyEnergyResult;
export type CommercePackageQuantityPolicy = (
  variants: readonly RecommendationVariant[],
  dailyKcal: number,
  cadenceDays: number,
  options?: BuildPackageQuantityOptions,
) => PackageQuantityResult;

export interface BuildCartRecommendationPolicies {
  resolveDailyEnergy: CommerceDailyEnergyPolicy;
  buildPackageQuantity: CommercePackageQuantityPolicy;
}

export type {
  RecommendationActivityLevel,
  RecommendationAgeBand,
  RecommendationBcs,
  RecommendedCartLine,
  RecommendationVariant,
} from "./recommendationEngine.js";
