export interface InventoryProviderStockLine {
  skuId: string;
  sku: string;
  forSaleQuantity: number;
  lastSyncedAt: string;
  staleAfter: string;
}

export interface InventoryHardReservationLine {
  skuId: string;
  quantity: number;
}

/** Structural inputs for dated subscription stock coverage; validation belongs to the caller. */
export interface SubscriptionForecastProviderStockLine {
  skuId: string;
  sku: string;
  forSaleQuantity: number;
  lastSyncedAt: string;
  staleAfter: string;
}

export interface SubscriptionForecastHardReservationLine {
  skuId: string;
  quantity: number;
}

export interface SubscriptionForecastStockLine {
  skuId: string;
  sku: string;
  fulfillable: boolean;
  locationStatus: string;
  safetyStock: number;
}

export interface SubscriptionForecastDemandLine {
  skuId: string;
  sku: string;
  quantity: number;
  dueAt: string;
  status: string;
}

export interface SubscriptionForecastSupplyLine {
  skuId: string;
  quantity: number;
  expectedAt: string;
  status: string;
}

export interface SubscriptionForecastCalculationInput {
  generatedAt: string;
  horizonDays: number;
  protectionDays: number;
  providerCurrent: SubscriptionForecastProviderStockLine[];
  openHardReservations: SubscriptionForecastHardReservationLine[];
  stock: SubscriptionForecastStockLine[];
  demand: SubscriptionForecastDemandLine[];
  supply: SubscriptionForecastSupplyLine[];
}

export interface SubscriptionForecastCounts {
  activeSubscriptionCount: number;
  excludedSubscriptionCount: number;
}

export interface SubscriptionForecastSku {
  skuId: string;
  sku: string;
  providerCurrentForSale: number | null;
  providerStockLastSyncedAt: string | null;
  providerStockStaleAfter: string | null;
  stockStatus: "missing" | "stale" | "fresh";
  openHardReservations: number;
  safetyStock: number;
  sellableNow: number;
  activeSubscriptionDemand30: number;
  activeSubscriptionDemand45: number;
  activeSubscriptionDemand60: number;
  plannedSupply: number;
  coverageDays: number | null;
  shortageDate: string | null;
  horizonMissingQty: number;
  protectionMissingQty: number;
  missingQty: number;
  recommendedProductionQty: number;
}

export interface SubscriptionForecastTotals extends SubscriptionForecastCounts {
  missingProviderStockSkuCount: number;
  staleProviderStockSkuCount: number;
  horizonShortageSkuCount: number;
  protectionShortageSkuCount: number;
  shortageSkuCount: number;
  recommendedProductionQty: number;
}
