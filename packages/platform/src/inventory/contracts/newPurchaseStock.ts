export interface NewPurchaseStockRow {
  sku: string;
  catalogSkuId: string | null;
  source: "provider" | "local" | "missing";
  providerForSale: number | null;
  activeHolds: number;
  safetyStock: number;
  available: number | null;
  stale: boolean;
  renewalDemand: number;
  availableForNewPurchases: number | null;
  /** Holds of the excluded order left out of `activeHolds`; 0 when no order is excluded. */
  excludedOrderHolds: number;
}

export type NewPurchaseStockMode = "new_purchase" | "renewal";

export interface NewPurchaseStockAvailabilityOptions {
  mode: NewPurchaseStockMode;
  lowStockThreshold?: number;
  horizonDays?: number;
}

