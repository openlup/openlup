import type { CatalogAcceptedReferenceV2, CatalogQuantity } from "@openlup/core/catalog";

/** Quote-only facts: no copy, route, price, or inventory authority. */
export interface CommerceQuoteCatalogItem {
  skuId: string;
  skuCode: string;
  variantId: string;
  productSlug: string;
  netWeightG: number;
  /** Identifies the product primary SKU for offer selection; secondary SKUs are excluded. */
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
  | "quantity_requires_v2"
  | "catalog_read_not_configured"
  | "catalog_authority_unavailable"
  | "catalog_authority_unsupported"
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


/** Exact catalogue facts for quote and effect admission. @experimental */
export interface CommerceQuoteCatalogItemV2 extends Omit<CommerceQuoteCatalogItem, "netWeightG"> {
  productId: string;
  netContent: CatalogQuantity;
  grossMass: CatalogQuantity | null;
  acceptedReference: CatalogAcceptedReferenceV2;
}

/** @experimental */
export interface CommerceQuoteCatalogReadPortV2 {
  listQuoteCatalogItems(): Promise<CommerceQuoteCatalogItemV2[]>;
}
