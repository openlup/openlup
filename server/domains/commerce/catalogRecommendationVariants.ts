import type { CatalogReadPort } from "../../../src/domains/catalog/ports.js";
import type { CatalogProduct } from "../../../src/domains/catalog/types.js";
import type { RecommendationVariant } from "../../../src/domains/commerce/recommendationEngine.js";
import type { CommerceOfferAvailabilityRequestItem } from "../../../src/domains/commerce/offerAvailabilityContracts.js";

export interface CatalogRecommendationVariant extends RecommendationVariant {
  permittedPurchaseModes: readonly CommerceOfferAvailabilityRequestItem["checkoutMode"][];
}

export type CatalogRecommendationVariantRefusalCode =
  | "catalog_read_not_configured" | "catalog_authority_unavailable"
  | "catalog_authority_changed" | "catalog_revision_invalid"
  | "catalog_document_schema_invalid" | "catalog_document_digest_mismatch"
  | "catalog_primary_trade_item_invalid";

export class CatalogRecommendationVariantReadError extends Error {
  constructor(readonly refusalCode: CatalogRecommendationVariantRefusalCode) {
    super(refusalCode);
    this.name = "CatalogRecommendationVariantReadError";
  }

  get code(): CatalogRecommendationVariantRefusalCode { return this.refusalCode; }
}

export interface CatalogRecommendationVariantReadPort {
  listRecommendationVariants(): Promise<CatalogRecommendationVariant[]>;
}

export function createCatalogRecommendationVariantReadPort(
  catalogReadPort: CatalogReadPort,
): CatalogRecommendationVariantReadPort {
  return {
    async listRecommendationVariants() {
      return catalogProductsToRecommendationVariants(await catalogReadPort.listProducts()).map((variant) => ({
        ...variant,
        // Legacy published variants historically served both purchase modes.
        permittedPurchaseModes: ["one_time", "subscription"] as const,
      }));
    },
  };
}

export function catalogProductsToRecommendationVariants(
  products: readonly CatalogProduct[],
): RecommendationVariant[] {
  const variants: RecommendationVariant[] = [];

  for (const product of products) {
    if (product.publicationStatus !== "published") continue;
    const kcalPer100g = product.composition.kcalPer100g ?? product.metadata.kcalPer100g;
    if (!kcalPer100g || kcalPer100g <= 0) continue;

    for (const sku of product.variants) {
      if (sku.publicationStatus !== "published" || sku.netWeightGrams <= 0) continue;
      variants.push({
        variantId: sku.variantId,
        sku: sku.sku,
        slug: product.slug,
        kcalPer100g,
        netWeightG: sku.netWeightGrams,
        allergenSlugs: product.composition.allergenSlugs,
      });
    }
  }

  return variants;
}
