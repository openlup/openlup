import type { CatalogReadPort } from "../../../src/domains/catalog/ports.js";
import {
  COMMERCE_PRODUCT_COMPATIBILITY_CONTRACT_VERSION,
  commerceProductCompatibilityResponseSchema,
  type CommerceProductCompatibilityRequest,
  type CommerceProductCompatibilityResponse,
} from "../../../src/domains/commerce/productCompatibilityContracts.js";
import { buildProductCompatibility } from "../../../src/domains/commerce/productCompatibility.js";
import type {
  CommerceOfferAvailabilityPort,
  CommerceProductCompatibilityPort,
} from "../../../src/domains/commerce/ports.js";
import { availabilityBySku } from "../../../src/domains/commerce/offerAvailability.js";
import {
  createCatalogRecommendationVariantReadPort,
  type CatalogRecommendationVariantReadPort,
} from "./catalogRecommendationVariants.js";
import { createStaticOfferAvailabilityPort } from "./staticOfferAvailabilityPort.js";

export class CommerceProductCompatibilityError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "CommerceProductCompatibilityError";
    this.code = code;
    this.details = details;
  }
}

export {
  CatalogRecommendationVariantReadError as CatalogCompatibilityVariantReadError,
} from "./catalogRecommendationVariants.js";
export type {
  CatalogRecommendationVariantReadPort as CatalogCompatibilityVariantReadPort,
  CatalogRecommendationVariantRefusalCode as CatalogCompatibilityVariantRefusalCode,
} from "./catalogRecommendationVariants.js";

export function createCatalogBackedProductCompatibilityPort(
  catalogReadPort: CatalogReadPort,
  offerAvailabilityPort: CommerceOfferAvailabilityPort = createStaticOfferAvailabilityPort(),
): CommerceProductCompatibilityPort {
  return createVariantBackedProductCompatibilityPort(
    createCatalogRecommendationVariantReadPort(catalogReadPort),
    offerAvailabilityPort,
  );
}

export function createVariantBackedProductCompatibilityPort(
  variantReadPort: CatalogRecommendationVariantReadPort,
  offerAvailabilityPort: CommerceOfferAvailabilityPort = createStaticOfferAvailabilityPort(),
): CommerceProductCompatibilityPort {
  return {
    async getCompatibility(
      request: CommerceProductCompatibilityRequest,
    ): Promise<CommerceProductCompatibilityResponse> {
      const variants = await variantReadPort.listRecommendationVariants();
      if (variants.length === 0) {
        throw new CommerceProductCompatibilityError(
          "catalog_variants_missing",
          "Catalog has no active products for compatibility checks",
        );
      }

      const availability = await offerAvailabilityPort.getAvailability({
        items: variants.map((variant) => ({
          sku: variant.sku,
          productSlug: variant.slug,
          variantId: variant.variantId,
          requestedQuantity: 1,
          checkoutMode: "one_time",
        })),
      });

      return commerceProductCompatibilityResponseSchema.parse({
        contractVersion: COMMERCE_PRODUCT_COMPATIBILITY_CONTRACT_VERSION,
        products: buildProductCompatibility(
          variants,
          request.allergenSlugs,
          availabilityBySku(availability),
        ),
      });
    },
  };
}
