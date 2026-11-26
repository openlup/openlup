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

export interface CommerceQuoteCatalogReadPort<
  Item extends CommerceQuoteCatalogItem = CommerceQuoteCatalogItem,
> {
  listQuoteCatalogItems(): Promise<Item[]>;
}

/** Share one lazy authority read, including rejection, within one quote composition. */
export function memoizeCommerceQuoteCatalogReads<Item extends CommerceQuoteCatalogItem>(
  inner: CommerceQuoteCatalogReadPort<Item>,
): CommerceQuoteCatalogReadPort<Item> {
  let pending: Promise<Item[]> | undefined;
  return {
    listQuoteCatalogItems() {
      pending ??= inner.listQuoteCatalogItems();
      return pending;
    },
  };
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

