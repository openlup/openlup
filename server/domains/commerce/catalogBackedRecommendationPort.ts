import type { CatalogReadPort } from "../../../src/domains/catalog/ports.js";
import {
  COMMERCE_RECOMMENDATION_CONTRACT_VERSION,
  commerceRecommendationResponseSchema,
  type CommerceRecommendationRequest,
  type CommerceRecommendationResponse,
} from "../../../src/domains/commerce/recommendationContracts.js";
import {
  buildCartRecommendation,
  type BuildCartRecommendationPolicies,
} from "../../../src/domains/commerce/recommendationEngine.js";
import type {
  CommerceOfferAvailabilityPort,
  CommerceRecommendationPort,
} from "../../../src/domains/commerce/ports.js";
import {
  createCatalogRecommendationVariantReadPort,
  type CatalogRecommendationVariantReadPort,
} from "./catalogRecommendationVariants.js";
import { createStaticOfferAvailabilityPort } from "./staticOfferAvailabilityPort.js";

export {
  CatalogRecommendationVariantReadError,
} from "./catalogRecommendationVariants.js";
export type {
  CatalogRecommendationVariantReadPort,
  CatalogRecommendationVariantRefusalCode,
} from "./catalogRecommendationVariants.js";

export class CommerceRecommendationError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "CommerceRecommendationError";
    this.code = code;
    this.details = details;
  }
}

export interface CatalogBackedRecommendationPortOptions {
  // Wave B gate — passed through to the recommendation engine's stock clamp.
  stockBoundedQuantities?: boolean;
  recommendationPolicies: BuildCartRecommendationPolicies;
}

export function createCatalogBackedRecommendationPort(
  catalogReadPort: CatalogReadPort,
  options: CatalogBackedRecommendationPortOptions,
  offerAvailabilityPort: CommerceOfferAvailabilityPort = createStaticOfferAvailabilityPort(),
): CommerceRecommendationPort {
  return createVariantBackedRecommendationPort(
    createCatalogRecommendationVariantReadPort(catalogReadPort),
    options,
    offerAvailabilityPort,
  );
}

export function createVariantBackedRecommendationPort(
  variantReadPort: CatalogRecommendationVariantReadPort,
  options: CatalogBackedRecommendationPortOptions,
  offerAvailabilityPort: CommerceOfferAvailabilityPort = createStaticOfferAvailabilityPort(),
): CommerceRecommendationPort {
  return {
    async recommend(request: CommerceRecommendationRequest): Promise<CommerceRecommendationResponse> {
      const checkoutMode = request.desiredSizeKind === "feeding_days" ? "subscription" : "one_time";
      const variants = (await variantReadPort.listRecommendationVariants())
        .filter((variant) => variant.permittedPurchaseModes.includes(checkoutMode));
      const availability = await offerAvailabilityPort.getAvailability({
        items: variants.map((variant) => ({
          sku: variant.sku,
          productSlug: variant.slug,
          variantId: variant.variantId,
          requestedQuantity: 1,
          checkoutMode,
        })),
      });
      const availabilityBySku = new Map(availability.map((item) => [item.sku, item]));
      const selectedFlavorSlugs = new Set(request.selectedFlavorSlugs ?? []);
      const selectedVariantIds = new Set(request.selectedVariantIds ?? []);
      const recommendationVariants = variants
        .map((variant) => ({
          ...variant,
          purchaseAvailability: availabilityBySku.get(variant.sku)?.status ?? "available",
          // Internal sellable cap carried onto the variant so the recommendation
          // clamp (Wave B) and the mix editor (Wave C) share one source of truth.
          sellableNow: availabilityBySku.get(variant.sku)?.sellableNow ?? null,
        }))
        .filter((variant) =>
          variant.purchaseAvailability !== "out_of_stock" ||
          selectedFlavorSlugs.has(variant.slug) ||
          selectedVariantIds.has(variant.variantId),
        );
      const result = buildCartRecommendation(
        {
          petProfile: request.petProfile,
          variants: recommendationVariants,
          selectedFlavorSlugs: request.selectedFlavorSlugs,
          selectedVariantIds: request.selectedVariantIds,
          allowedVariantIds: request.allowedVariantIds,
          desiredSizeKind: request.desiredSizeKind,
          cadenceDays: request.cadenceDays,
          consciousAllergenOverride: request.consciousAllergenOverride,
          stockBoundedQuantities: options.stockBoundedQuantities ?? false,
          sizePolicy: request.sizePolicy,
        },
        options.recommendationPolicies,
      );

      if (result.ok === false) {
        throw new CommerceRecommendationError(result.error.code, result.error.message, {
          recommendation: "unavailable",
        });
      }

      return commerceRecommendationResponseSchema.parse({
        contractVersion: COMMERCE_RECOMMENDATION_CONTRACT_VERSION,
        recommendation: result.value,
      });
    },
  };
}
