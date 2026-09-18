import type { CatalogReadPort } from "../../../src/domains/catalog/ports.js";
import type { CatalogSpecies } from "../../../src/domains/catalog/types.js";

/** Quote-only facts: no copy, route, price, or inventory authority. */
export interface CommerceQuoteCatalogItem {
  skuId: string;
  skuCode: string;
  variantId: string;
  productSlug: string;
  netWeightG: number;
  energyPer100g: number | null;
  /** Strict D1 provides this; optional keeps legacy/test quote fixtures compatible. */
  allergenSlugs?: readonly string[];
  /** Strict D1 supplies the document-declared species; legacy keeps a compatible projection. */
  species?: CatalogSpecies;
  /** Strict D1 identifies the product primary SKU; offer pricing never chooses a secondary SKU. */
  isPrimarySku?: boolean;
  isAddon: boolean;
  sellability: {
    oneTime: boolean;
    subscription: boolean;
  };
  documentRevision: {
    id: string | null;
    digest: string | null;
  };
}

export interface CommerceQuoteCatalogReadPort {
  listQuoteCatalogItems(): Promise<CommerceQuoteCatalogItem[]>;
}

export type CommerceQuoteCatalogReadRefusalCode =
  | "catalog_read_not_configured"
  | "catalog_authority_unavailable"
  | "catalog_authority_changed"
  | "catalog_revision_invalid"
  | "catalog_document_schema_invalid"
  | "catalog_document_digest_mismatch"
  | "catalog_primary_trade_item_invalid"
  | "catalog_cursor_invalid"
  | "catalog_cardinality_exceeded";

export class CommerceQuoteCatalogReadError extends Error {
  constructor(readonly code: CommerceQuoteCatalogReadRefusalCode) {
    super(code);
    this.name = "CommerceQuoteCatalogReadError";
  }
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
        sellability: { oneTime: true, subscription: true },
        documentRevision: { id: null, digest: null },
      })));
    },
  };
}
