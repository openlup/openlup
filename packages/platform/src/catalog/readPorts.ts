import type { SellableCatalogItem, SellableCatalogProfile, CatalogSkuEnvelopeSelector, NeutralSkuEnvelopeV1 } from "./contracts/index.js";

/**
 * Minimal neutral catalog seam used by the local reference storefront. It is
 * independent of richer application catalog read ports.
 */
export interface SellableCatalogPort {
  getStorefrontProfile(): Promise<SellableCatalogProfile>;
  listSellableItems(): Promise<SellableCatalogItem[]>;
}

/**
 * Dark W2a read seam. Its row-safe return value deliberately contains document
 * references, never a document payload or a SKU-level document override.
 */
export interface CatalogSkuEnvelopeReadPort {
  listSkuEnvelopes(query: CatalogSkuEnvelopeListQuery): Promise<CatalogSkuEnvelopePage>;
  /**
   * Page only active trade items that are sellable in at least one commerce
   * channel. This is intentionally distinct from the neutral inventory-style
   * listing above: consumers such as compatibility must not discover dormant
   * SKUs and then try to filter them with a second authority.
   */
  listActiveSkuEnvelopes(query: CatalogActiveSkuEnvelopeListQuery): Promise<CatalogSkuEnvelopePage>;
  getSkuEnvelope(selector: CatalogSkuEnvelopeSelector): Promise<NeutralSkuEnvelopeV1 | null>;
  /** Compatibility lookup for callers that already persist the neutral SKU UUID. */
  getSkuEnvelopeById(skuId: string): Promise<NeutralSkuEnvelopeV1 | null>;
}

/**
 * Additive discovery capability. Existing commerce consumers remain typed to
 * {@link CatalogSkuEnvelopeReadPort} and therefore cannot accidentally use it.
 */
export interface PublicCatalogSkuEnvelopeReadPort extends CatalogSkuEnvelopeReadPort {
  /**
   * Public discovery's active-only page. Unlike the commerce method above it
   * intentionally includes temporarily unsellable active variants.
   */
  listPublicActiveSkuEnvelopes(query: CatalogSkuEnvelopeListQuery): Promise<CatalogSkuEnvelopePage>;
  /** Active-only cursor page restricted to one already-authoritative product. */
  listPublicActiveProductSkuEnvelopes(
    productId: string,
    query: CatalogSkuEnvelopeListQuery,
  ): Promise<CatalogSkuEnvelopePage>;
}

export interface CatalogSkuEnvelopeListQuery {
  cursor: string | null;
  limit: number;
}

export interface CatalogActiveSkuEnvelopeListQuery extends CatalogSkuEnvelopeListQuery {
  /** Optional server-selected scope; supplied selections contain 1–100 unique SKU codes. */
  skuCodes?: readonly string[];
}

export interface CatalogSkuEnvelopePage {
  items: NeutralSkuEnvelopeV1[];
  nextCursor: string | null;
}

