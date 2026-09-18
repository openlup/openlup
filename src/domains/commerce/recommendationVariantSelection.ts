import type {
  BuildCartRecommendationInput,
  ExcludedRecommendationProduct,
  RecommendationVariant,
} from "./recommendationEngine.js";

const SAFE_FALLBACK_FLAVOR_RANK = [
  "venison",
  "turkey",
  "beef",
  "pork",
  "lamb",
  "salmon",
] as const;

// Determinism: the DB catalog read port has no `.order()`, so variants arrive in
// nondeterministic order. A stable slug pre-sort at the engine entry makes the whole
// recommendation byte-identical regardless of port order (fallback re-sorts by rank).
export function orderVariantsBySlug(
  variants: readonly RecommendationVariant[],
): RecommendationVariant[] {
  return [...variants].sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
}

export function selectRecommendationVariants(
  input: BuildCartRecommendationInput,
): RecommendationVariant[] {
  const allowed = input.allowedVariantIds ? new Set(input.allowedVariantIds) : null;

  return input.variants.filter((variant) => {
    if (!isPositiveNumber(variant.kcalPer100g) || !isPositiveNumber(variant.netWeightG)) return false;
    if (allowed && !allowed.has(variant.variantId)) return false;
    return true;
  });
}

export function selectPreferredVariants(
  input: BuildCartRecommendationInput,
  variants: readonly RecommendationVariant[],
): RecommendationVariant[] {
  const hasPreference = (input.selectedVariantIds?.length ?? 0) > 0 ||
    (input.selectedFlavorSlugs?.length ?? 0) > 0;
  if (!hasPreference) return [...variants];
  return variants.filter((variant) => matchesPreference(input, variant));
}

export function selectLimitedSafeFallbackVariants(
  variants: readonly RecommendationVariant[],
  limit = 2,
): RecommendationVariant[] {
  return [...variants]
    .sort((a, b) => fallbackRank(a.slug) - fallbackRank(b.slug) || a.sku.localeCompare(b.sku))
    .slice(0, limit);
}

export function matchesPreference(
  input: BuildCartRecommendationInput,
  variant: Pick<RecommendationVariant, "variantId" | "slug">,
): boolean {
  const selectedVariants = input.selectedVariantIds ? new Set(input.selectedVariantIds) : null;
  const selectedFlavors = input.selectedFlavorSlugs ? new Set(input.selectedFlavorSlugs) : null;
  return Boolean(selectedVariants?.has(variant.variantId) || selectedFlavors?.has(variant.slug));
}

export function excludedByAllergens(
  variants: readonly RecommendationVariant[],
  petAllergenSlugs: readonly string[],
): ExcludedRecommendationProduct[] {
  const petAllergens = new Set(petAllergenSlugs);
  if (petAllergens.size === 0) return [];

  return variants
    .map((variant) => ({
      variantId: variant.variantId,
      sku: variant.sku,
      slug: variant.slug,
      allergenSlugs: variant.allergenSlugs.filter((slug) => petAllergens.has(slug)),
      reason: "allergen_conflict" as const,
    }))
    .filter((excluded) => excluded.allergenSlugs.length > 0);
}

function isPositiveNumber(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function fallbackRank(slug: string): number {
  const index = (SAFE_FALLBACK_FLAVOR_RANK as readonly string[]).indexOf(slug);
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}
