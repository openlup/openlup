import type { CatalogReadPort } from "../../../src/domains/catalog/ports.js";
import type { CatalogSpecies } from "../../../src/domains/catalog/types.js";

import type { CommerceQuoteCatalogItem as NeutralQuoteCatalogItem } from "@openlup/platform/pricing";
export { CommerceQuoteCatalogReadError } from "@openlup/platform/pricing";
export type { CommerceQuoteCatalogReadRefusalCode } from "@openlup/platform/pricing";

export interface CommerceQuoteCatalogItem extends NeutralQuoteCatalogItem {
  energyPer100g: number | null;
  allergenSlugs?: readonly string[];
  species?: CatalogSpecies;
}

export interface CommerceQuoteCatalogReadPort {
  listQuoteCatalogItems(): Promise<CommerceQuoteCatalogItem[]>;
}

/** Legacy-only adapter for composition roots not yet cut over to D1. */
export function createLegacyCommerceQuoteCatalogReadPort(
  catalogReadPort: CatalogReadPort,
): CommerceQuoteCatalogReadPort {
  return {
    async listQuoteCatalogItems(): Promise<CommerceQuoteCatalogItem[]> {
      const products = await catalogReadPort.listProducts();
      return products.flatMap((product) => product.variants.map((sku) => ({
        skuId: sku.variantId,
        skuCode: sku.sku,
        variantId: sku.variantId,
        productSlug: product.slug,
        netWeightG: sku.netWeightGrams,
        energyPer100g: product.composition?.kcalPer100g ?? null,
        allergenSlugs: product.composition?.allergenSlugs ?? [],
        species: product.species,
        isPrimarySku: sku.variantId === product.primarySku.variantId,
        isAddon: sku.isAddon ?? false,
        sellability: {
          oneTime: sku.sellability?.oneTime ?? true,
          subscription: sku.sellability?.subscription ?? true,
        },
        documentRevision: { id: null, digest: null },
      })));
    },
  };
}
