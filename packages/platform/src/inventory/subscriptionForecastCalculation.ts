import type { SubscriptionForecastCalculationInput, SubscriptionForecastCounts, SubscriptionForecastSku, SubscriptionForecastTotals, SubscriptionForecastDemandLine, SubscriptionForecastSupplyLine } from "./contracts/forecast.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export function calculateSubscriptionForecastSkus(
  input: SubscriptionForecastCalculationInput,
): SubscriptionForecastSku[] {
  const generatedAtMs = Date.parse(input.generatedAt);
  const horizonAtMs = generatedAtMs + input.horizonDays * DAY_MS;
  const protectionAtMs = generatedAtMs + input.protectionDays * DAY_MS;
  const demand = input.demand
    .filter((line) => !["skipped", "cancelled"].includes(line.status))
    .filter((line) => Date.parse(line.dueAt) <= horizonAtMs);
  const plannedSupply = input.supply
    .filter((line) => line.status === "planned")
    .filter((line) => Date.parse(line.expectedAt) <= horizonAtMs);

  const providerBySku = new Map(input.providerCurrent.map((line) => [line.skuId, line]));
  const skuIds = new Set<string>([
    ...input.providerCurrent.map((line) => line.skuId),
    ...input.openHardReservations.map((line) => line.skuId),
    ...input.stock.map((line) => line.skuId),
    ...demand.map((line) => line.skuId),
    ...plannedSupply.map((line) => line.skuId),
  ]);

  const skus = [...skuIds].map<SubscriptionForecastSku>((skuId) => {
    const provider = providerBySku.get(skuId) ?? null;
    const stockLines = input.stock.filter((line) => line.skuId === skuId);
    const demandLines = demand.filter((line) => line.skuId === skuId);
    const supplyLines = plannedSupply.filter((line) => line.skuId === skuId);
    const sku = provider?.sku ?? stockLines[0]?.sku ?? demandLines[0]?.sku ?? "unknown";
    const stockStatus = provider === null
      ? "missing"
      : Date.parse(provider.staleAfter) <= generatedAtMs
        ? "stale"
        : "fresh";
    const openHardReservations = sum(input.openHardReservations
      .filter((line) => line.skuId === skuId)
      .map((line) => line.quantity));
    const safetyStock = sum(stockLines
      .filter((line) => line.fulfillable && line.locationStatus === "active")
      .map((line) => line.safetyStock));
    const sellableNow = stockStatus === "fresh" && provider
      ? Math.max(0, provider.forSaleQuantity - openHardReservations - safetyStock)
      : 0;
    const shortage = simulateSubscriptionCoverage({
      generatedAtMs,
      protectionAtMs,
      sellableNow,
      demand: demandLines,
      supply: supplyLines,
    });

    return {
      skuId,
      sku,
      providerCurrentForSale: provider?.forSaleQuantity ?? null,
      providerStockLastSyncedAt: provider?.lastSyncedAt ?? null,
      providerStockStaleAfter: provider?.staleAfter ?? null,
      stockStatus,
      openHardReservations,
      safetyStock,
      sellableNow,
      activeSubscriptionDemand30: demandQuantityWithin(demandLines, generatedAtMs + 30 * DAY_MS),
      activeSubscriptionDemand45: demandQuantityWithin(demandLines, generatedAtMs + 45 * DAY_MS),
      activeSubscriptionDemand60: demandQuantityWithin(demandLines, generatedAtMs + 60 * DAY_MS),
      plannedSupply: sum(supplyLines.map((line) => line.quantity)),
      coverageDays: shortage.shortageDate
        ? Math.max(0, Math.ceil((Date.parse(shortage.shortageDate) - generatedAtMs) / DAY_MS))
        : null,
      shortageDate: shortage.shortageDate,
      horizonMissingQty: shortage.horizonMissingQty,
      protectionMissingQty: shortage.protectionMissingQty,
      missingQty: shortage.protectionMissingQty,
      recommendedProductionQty: shortage.protectionMissingQty,
    };
  }).sort((a, b) => a.sku.localeCompare(b.sku));

  return skus;
}

/** Kept separate so native envelopes can read their metadata before count getters. */
export function calculateSubscriptionForecastTotals(
  input: SubscriptionForecastCounts,
  skus: SubscriptionForecastSku[],
): SubscriptionForecastTotals {
  return {
    activeSubscriptionCount: input.activeSubscriptionCount,
    excludedSubscriptionCount: input.excludedSubscriptionCount,
    missingProviderStockSkuCount: skus.filter((line) => line.stockStatus === "missing").length,
    staleProviderStockSkuCount: skus.filter((line) => line.stockStatus === "stale").length,
    horizonShortageSkuCount: skus.filter((line) => line.shortageDate !== null).length,
    protectionShortageSkuCount: skus.filter((line) => line.protectionMissingQty > 0).length,
    shortageSkuCount: skus.filter((line) => line.shortageDate !== null).length,
    recommendedProductionQty: sum(skus.map((line) => line.recommendedProductionQty)),
  };
}

function simulateSubscriptionCoverage(input: {
  generatedAtMs: number;
  protectionAtMs: number;
  sellableNow: number;
  demand: SubscriptionForecastDemandLine[];
  supply: SubscriptionForecastSupplyLine[];
}): { shortageDate: string | null; horizonMissingQty: number; protectionMissingQty: number } {
  let available = input.sellableNow;
  let shortageDate: string | null = null;
  let horizonMissingQty = 0;
  let protectionMissingQty = 0;
  const events = [
    ...input.supply.map((line) => ({
      type: "supply" as const,
      at: line.expectedAt,
      quantity: line.quantity,
    })),
    ...input.demand.map((line) => ({
      type: "demand" as const,
      at: line.dueAt,
      quantity: line.quantity,
    })),
  ].sort((a, b) => {
    const dateDelta = Date.parse(a.at) - Date.parse(b.at);
    if (dateDelta !== 0) return dateDelta;
    return a.type === "supply" && b.type === "demand" ? -1 : 1;
  });

  for (const event of events) {
    if (event.type === "supply") {
      available += event.quantity;
      continue;
    }

    if (available >= event.quantity) {
      available -= event.quantity;
      continue;
    }

    const missing = event.quantity - available;
    available = 0;
    shortageDate ??= event.at;
    horizonMissingQty += missing;
    if (Date.parse(event.at) <= input.protectionAtMs) protectionMissingQty += missing;
  }

  return { shortageDate, horizonMissingQty, protectionMissingQty };
}

function demandQuantityWithin(lines: SubscriptionForecastDemandLine[], dueAtOrBeforeMs: number): number {
  return sum(lines
    .filter((line) => Date.parse(line.dueAt) <= dueAtOrBeforeMs)
    .map((line) => line.quantity));
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
