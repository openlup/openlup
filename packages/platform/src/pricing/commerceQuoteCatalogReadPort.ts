/** Quote-only facts: no copy, route, price, or inventory authority. */
export interface CommerceQuoteCatalogItem {
  skuId: string;
  skuCode: string;
  variantId: string;
  productSlug: string;
  netWeightG: number;
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

