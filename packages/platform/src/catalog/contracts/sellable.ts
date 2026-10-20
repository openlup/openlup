export const SELLABLE_CATALOG_CONTRACT_VERSION = "catalog.sellable.v1";
export interface SellableCatalogItem {
  sku: string; title: string; unitPrice: { amountMinor: number; currency: string };
  permittedPurchaseModes: ("one_time" | "subscription")[];
}
export interface SellableCatalogProfile {
  id: string; brand: string; country: string; currency: string; locale: string; timezone: string;
}
export interface SellableCatalogListResponse {
  contractVersion: typeof SELLABLE_CATALOG_CONTRACT_VERSION;
  profile: SellableCatalogProfile; items: SellableCatalogItem[];
}
