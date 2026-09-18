import type { RecommendationVariant } from "./recommendationEngine.js";
import { defaultOfferAvailability } from "./offerAvailability.js";
import type { CommerceOfferAvailability } from "./offerAvailabilityContracts.js";
import type {
  CommerceProductCompatibilityItem,
} from "./productCompatibilityContracts.js";

export function buildProductCompatibility(
  variants: readonly RecommendationVariant[],
  allergenSlugs: readonly string[],
  offerAvailabilityBySku: ReadonlyMap<string, CommerceOfferAvailability> = new Map(),
): CommerceProductCompatibilityItem[] {
  const allergens = new Set(allergenSlugs);

  return variants.map((variant) => {
    const conflictAllergenSlugs = variant.allergenSlugs.filter((slug) => allergens.has(slug));
    const availability = offerAvailabilityBySku.get(variant.sku) ?? defaultOfferAvailability({
      sku: variant.sku,
      productSlug: variant.slug,
      variantId: variant.variantId,
      requestedQuantity: 1,
      checkoutMode: "one_time",
    });
    return {
      variantId: variant.variantId,
      sku: variant.sku,
      slug: variant.slug,
      selectable: conflictAllergenSlugs.length === 0,
      purchaseAvailability: availability.status,
      visibleInConfigurator: availability.visibleInConfigurator,
      sellableNow: availability.sellableNow,
      conflictAllergenSlugs,
    };
  });
}
