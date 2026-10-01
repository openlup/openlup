import type { CatalogReadPort } from "../../../src/domains/catalog/ports.js";
import type { CatalogProduct, CatalogSku } from "../../../src/domains/catalog/types.js";
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
      const products = await catalogReadPort.listProducts();
      const skuByVariantId = new Map<string, CatalogSku>(products.flatMap((product) =>
        product.variants.map((sku) => [sku.variantId, sku] as const)));
      return catalogProductsToRecommendationVariants(products).map((variant) => ({
        ...variant,
        permittedPurchaseModes: permittedPurchaseModes(skuByVariantId.get(variant.variantId)?.sellability),
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

/** The purchase modes a SKU's stored sellability allows. A catalog source that
 *  states no sellability keeps the historical answer: both modes. */
function permittedPurchaseModes(
  sellability: CatalogSku["sellability"],
): CatalogRecommendationVariant["permittedPurchaseModes"] {
  const modes: CommerceOfferAvailabilityRequestItem["checkoutMode"][] = [];
  if (sellability?.oneTime ?? true) modes.push("one_time");
  if (sellability?.subscription ?? true) modes.push("subscription");
  return modes;
}
