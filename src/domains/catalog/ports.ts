import type {
  CatalogAllergen,
  CatalogProduct,
  CatalogProductSlug,
} from "./types.js";

export interface CatalogReadPort {
  listProducts(): Promise<CatalogProduct[]>;
  getProductBySlug(slug: CatalogProductSlug): Promise<CatalogProduct | null>;
  listAllergens(): Promise<CatalogAllergen[]>;
}

export type { SellableCatalogPort, CatalogSkuEnvelopeReadPort, PublicCatalogSkuEnvelopeReadPort, CatalogSkuEnvelopeListQuery, CatalogActiveSkuEnvelopeListQuery, CatalogSkuEnvelopePage } from "@openlup/platform/catalog";

export class CatalogProductNotFoundError extends Error {
  constructor(slug: CatalogProductSlug) {
    super(`Catalog product not found: ${slug}`);
    this.name = "CatalogProductNotFoundError";
  }
}

export type CatalogPrimarySkuUnresolvedReason = "primary_sku_missing" | "primary_sku_not_in_rows";

/**
 * The sellable-catalog read met an active product with SKU rows whose declared
 * `primary_sku_id` is empty or names none of those rows. The row-assembled read
 * ports refuse rather than choose a primary SKU from row order.
 */
export class CatalogPrimarySkuUnresolvedError extends Error {
  readonly code = "catalog_primary_sku_unresolved" as const;
  readonly productSlug: CatalogProductSlug;
  readonly reason: CatalogPrimarySkuUnresolvedReason;

  constructor(productSlug: CatalogProductSlug, reason: CatalogPrimarySkuUnresolvedReason) {
    super(`catalog_primary_sku_unresolved: ${productSlug} (${reason})`);
    this.name = "CatalogPrimarySkuUnresolvedError";
    // Explicit fields: bare type stripping refuses parameter properties.
    this.productSlug = productSlug;
    this.reason = reason;
  }
}

import type { AdminCatalogSkuPacksResponse } from "./contracts.js";

export interface CatalogSkuPacksReadPort {
  getCatalogSkuPacks(): Promise<AdminCatalogSkuPacksResponse>;
}
