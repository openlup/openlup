import type { CatalogAllergenSlug, CatalogProductSlug } from "../catalog/types.js";
import type { CommerceOfferAvailabilityStatus } from "./offerAvailabilityContracts.js";
import {
  COMMERCE_RECOMMENDATION_REASON_CODES,
  COMMERCE_RECOMMENDATION_STATUSES,
} from "./recommendationConstants.js";
import type {
  BuildCartRecommendationPolicies,
  CommercePackageSizePolicy,
  DailyEnergyEvidence,
} from "./recommendationPolicyDeps.js";
import {
  excludedByAllergens,
  matchesPreference,
  orderVariantsBySlug,
  selectLimitedSafeFallbackVariants,
  selectPreferredVariants,
  selectRecommendationVariants,
} from "./recommendationVariantSelection.js";
import {
  mapSuggestedVariants,
  roundOneDecimal,
  uniqueReasonCodes,
  withDailyGrams,
} from "./recommendationEngineHelpers.js";

export const COMMERCE_RECOMMENDATION_VERSION = "commerce-recommendation.v2";
export { COMMERCE_RECOMMENDATION_REASON_CODES, COMMERCE_RECOMMENDATION_STATUSES };
export type { BuildCartRecommendationPolicies } from "./recommendationPolicyDeps.js";

export type RecommendationAgeBand = "puppy" | "young" | "adult" | "senior";
export type RecommendationActivityLevel = "low" | "normal" | "high";
export type RecommendationBcs = "thin" | "ideal" | "overweight";
export type RecommendationSizeKind = "unit_count" | "total_weight_g" | "feeding_days";
export type RecommendationStatus = (typeof COMMERCE_RECOMMENDATION_STATUSES)[number];
export type CommerceRecommendationReasonCode =
  (typeof COMMERCE_RECOMMENDATION_REASON_CODES)[number];

export interface RecommendationPetProfile {
  ageBand: RecommendationAgeBand;
  weightKg: number;
  activityLevel?: RecommendationActivityLevel;
  bcs?: RecommendationBcs;
  allergenSlugs?: readonly string[];
  dailyKcalOverride?: number | null;
}

export interface RecommendationVariant {
  variantId: string;
  sku: string;
  slug: CatalogProductSlug;
  kcalPer100g: number;
  netWeightG: number;
  allergenSlugs: readonly CatalogAllergenSlug[];
  purchaseAvailability?: CommerceOfferAvailabilityStatus;
  sellableNow?: number | null; // internal sellable-stock cap; null/undefined ⇒ no cap
}

export interface BuildCartRecommendationInput {
  petProfile: RecommendationPetProfile;
  variants: readonly RecommendationVariant[];
  selectedFlavorSlugs?: readonly string[];
  selectedVariantIds?: readonly string[];
  allowedVariantIds?: readonly string[];
  desiredSizeKind: RecommendationSizeKind;
  cadenceDays: number;
  consciousAllergenOverride?: boolean;
  stockBoundedQuantities?: boolean;
  /** Omitted means `cadence_target`: every pre-starter-pack caller is unchanged. */
  sizePolicy?: CommercePackageSizePolicy;
}

export interface RecommendedCartLine {
  variantId: string;
  sku: string;
  slug: CatalogProductSlug;
  qty: number;
  netWeightG: number;
  kcalPerUnit: number;
  allergenSlugs: readonly CatalogAllergenSlug[];
  purchaseAvailability?: CommerceOfferAvailabilityStatus;
  // Internal sellable-stock cap carried onto the line so the mix editor bounds "+". `null` ⇒ no cap.
  sellableNow?: number | null;
}

export interface AllergenConflict {
  variantId: string;
  sku: string;
  allergenSlugs: readonly CatalogAllergenSlug[];
}

export interface ExcludedRecommendationProduct extends AllergenConflict {
  slug: CatalogProductSlug;
  reason: "allergen_conflict";
}

export interface SuggestedRecommendationVariant {
  variantId: string;
  sku: string;
  slug: CatalogProductSlug;
  purchaseAvailability?: CommerceOfferAvailabilityStatus;
  sellableNow?: number | null;
}

export interface RecommendationEnergyEvidence extends DailyEnergyEvidence {
  dailyGrams: number | null;
}

export interface CartRecommendation {
  version: typeof COMMERCE_RECOMMENDATION_VERSION;
  status: RecommendationStatus;
  reasonCodes: CommerceRecommendationReasonCode[];
  energy: RecommendationEnergyEvidence;
  dailyKcal: number | null;
  dailyGrams: number | null;
  totalWeightG: number;
  feedingDays: number | null;
  desiredSizeKind: RecommendationSizeKind;
  cadenceDays: number;
  lines: RecommendedCartLine[];
  allergenConflicts: AllergenConflict[];
  excludedProducts: ExcludedRecommendationProduct[];
  suggestedVariants?: SuggestedRecommendationVariant[];
  allergenOverrideRecorded: boolean;
}

export type BuildCartRecommendationResult =
  | { ok: true; value: CartRecommendation }
  | {
      ok: false;
      error: {
        code: "invalid_pet_profile" | "invalid_cadence";
        message: string;
      };
    };

export function buildCartRecommendation(
  rawInput: BuildCartRecommendationInput,
  policies: BuildCartRecommendationPolicies,
): BuildCartRecommendationResult {
  // Stable slug pre-sort makes the recommendation port-order-independent (see orderVariantsBySlug).
  const input = { ...rawInput, variants: orderVariantsBySlug(rawInput.variants) };

  if (!Number.isFinite(input.cadenceDays) || input.cadenceDays <= 0) {
    return { ok: false, error: { code: "invalid_cadence", message: "Cadence must be positive" } };
  }

  const energy = policies.resolveDailyEnergy(input.petProfile);
  if (energy.ok === false && energy.code === "invalid_pet_profile") {
    return {
      ok: false,
      error: { code: "invalid_pet_profile", message: "Pet profile must provide positive weight" },
    };
  }

  if (energy.ok === false) {
    return {
      ok: true,
      value: manualRecommendation(input, energy.evidence, energy.reasonCodes),
    };
  }

  const candidates = selectRecommendationVariants(input);
  const excludedProducts = excludedByAllergens(candidates, input.petProfile.allergenSlugs ?? []);
  const safeVariants = candidates.filter(
    (variant) => !excludedProducts.some((excluded) => excluded.variantId === variant.variantId),
  );

  if (candidates.length === 0) {
    return {
      ok: true,
      value: manualRecommendation(input, withDailyGrams(energy.evidence, null), [
        ...energy.reasonCodes,
        "catalog_variants_missing",
      ]),
    };
  }

  if (safeVariants.length === 0) {
    return {
      ok: true,
      value: manualRecommendation(input, withDailyGrams(energy.evidence, null), [
        ...energy.reasonCodes,
        "allergen_conflict_excluded",
        "no_safe_products",
      ], excludedProducts),
    };
  }

  const hasPreference = hasVariantPreference(input);
  const preferredSafeVariants = selectPreferredVariants(input, safeVariants);
  const preferredExcluded = excludedProducts.filter((product) => matchesPreference(input, product));
  const limitedFallbackUsed = hasPreference && preferredSafeVariants.length === 0;
  const variants = limitedFallbackUsed
    ? selectLimitedSafeFallbackVariants(safeVariants)
    : preferredSafeVariants;
  // Safe alternatives are suggestions only. The quantity policy never inserts
  // one of these variants into the customer's selected lines.
  const selectedIds = new Set(variants.map((variant) => variant.variantId));
  const quantity = policies.buildPackageQuantity(variants, energy.evidence.dailyKcal, input.cadenceDays, {
    stockBounded: input.stockBoundedQuantities ?? false,
    extraVariants: safeVariants.filter((variant) => !selectedIds.has(variant.variantId)),
    ...(input.sizePolicy ? { sizePolicy: input.sizePolicy } : {}),
  });
  const reasonCodes = uniqueReasonCodes([
    ...energy.reasonCodes,
    hasPreference && !limitedFallbackUsed ? "preferred_flavors_used" : null,
    limitedFallbackUsed ? "safe_catalog_fallback_used" : null,
    limitedFallbackUsed ? "fallback_limited_to_safe_alternatives" : null,
    excludedProducts.length > 0 ? "allergen_conflict_excluded" : null,
    preferredExcluded.length > 0 ? "safe_catalog_fallback_used" : null,
    "quantity_rounded_to_full_cans",
    quantity.minimumApplied ? "minimum_order_quantity_applied" : null,
    quantity.rebalanced ? "package_rebalanced_to_target_kcal" : null,
    quantity.stockClamped ? "stock_bounded_quantities_applied" : null,
    quantity.stockConstrained ? "stock_limited_below_target" : null,
    quantity.selectedCapacityConstrained
      ? "additional_safe_flavor_selection_required"
      : null,
  ]);

  // There is no total-package cap. Selected stock or the per-variant 99-line cap
  // can still require an explicit additional-flavour choice.
  const status: RecommendationStatus = quantity.selectedCapacityConstrained
    ? "manual_review"
    : preferredExcluded.length > 0 || limitedFallbackUsed ||
        quantity.minimumApplied || quantity.stockConstrained
      ? "warning"
      : "ready_to_buy";
  const recommendationDailyGrams = quantity.totalKcal > 0 ? quantity.dailyGrams : null;
  const recommendationFeedingDays = quantity.totalKcal > 0
    ? roundOneDecimal(quantity.feedingDays)
    : null;

  return {
    ok: true,
    value: {
      version: COMMERCE_RECOMMENDATION_VERSION,
      status,
      reasonCodes,
      energy: withDailyGrams(energy.evidence, recommendationDailyGrams),
      dailyKcal: energy.evidence.dailyKcal,
      dailyGrams: recommendationDailyGrams,
      totalWeightG: quantity.totalWeightG,
      feedingDays: recommendationFeedingDays,
      desiredSizeKind: input.desiredSizeKind,
      cadenceDays: input.cadenceDays,
      lines: quantity.lines,
      allergenConflicts: excludedProducts.map(toAllergenConflict),
      excludedProducts,
      suggestedVariants: mapSuggestedVariants(safeVariants, quantity.suggestedVariantIds ?? []),
      allergenOverrideRecorded: false,
    },
  };
}

export function findAllergenConflicts(
  variants: readonly RecommendationVariant[],
  petAllergenSlugs: readonly string[],
): AllergenConflict[] {
  return excludedByAllergens(variants, petAllergenSlugs).map(toAllergenConflict);
}

function manualRecommendation(
  input: BuildCartRecommendationInput,
  energy: DailyEnergyEvidence | RecommendationEnergyEvidence,
  reasons: readonly string[],
  excludedProducts: readonly ExcludedRecommendationProduct[] = [],
): CartRecommendation {
  return {
    version: COMMERCE_RECOMMENDATION_VERSION,
    status: "manual_review",
    reasonCodes: uniqueReasonCodes(reasons),
    energy: withDailyGrams(energy, "dailyGrams" in energy ? energy.dailyGrams : null),
    dailyKcal: energy.dailyKcal,
    dailyGrams: "dailyGrams" in energy ? energy.dailyGrams : null,
    totalWeightG: 0,
    feedingDays: null,
    desiredSizeKind: input.desiredSizeKind,
    cadenceDays: input.cadenceDays,
    lines: [],
    allergenConflicts: excludedProducts.map(toAllergenConflict),
    excludedProducts: [...excludedProducts],
    allergenOverrideRecorded: false,
  };
}

function toAllergenConflict(product: ExcludedRecommendationProduct): AllergenConflict {
  return {
    variantId: product.variantId,
    sku: product.sku,
    allergenSlugs: [...product.allergenSlugs],
  };
}

function hasVariantPreference(input: BuildCartRecommendationInput): boolean {
  return (input.selectedVariantIds?.length ?? 0) > 0 ||
    (input.selectedFlavorSlugs?.length ?? 0) > 0;
}
