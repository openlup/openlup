import {
  INVENTORY_CONTRACT_VERSION,
  inventoryForecastResponseSchema,
  inventorySubscriptionForecastResponseSchema,
  type InventoryForecastDemandLine,
  type InventoryForecastResponse,
  type InventoryForecastSupplyLine,
  type InventoryStockLine,
  type InventorySubscriptionForecastResponse,
} from "./contracts.js";
import { availableNow } from "./atp.js";

const DAY_MS = 24 * 60 * 60 * 1000;

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

export function forecastSubscriptionInventoryShortages(input: {
  demand: InventoryForecastDemandLine[];
  supply: InventoryForecastSupplyLine[];
  stock: InventoryStockLine[];
}): InventoryForecastResponse {
  const demand = input.demand
    .filter((line) => !["skipped", "cancelled"].includes(line.status))
    .sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt));
  const runningAvailable = input.stock.reduce<Record<string, number>>((available, line) => {
    available[line.skuId] = (available[line.skuId] ?? 0) + availableNow(line);
    return available;
  }, {});
  const plannedSupply = input.supply
    .filter((line) => line.status === "planned")
    .sort((a, b) => Date.parse(a.expectedAt) - Date.parse(b.expectedAt));
  const usedSupplyIndexes = new Set<number>();

  const shortages = demand.flatMap((line) => {
    for (const [index, supply] of plannedSupply.entries()) {
      if (usedSupplyIndexes.has(index)) continue;
      if (supply.skuId !== line.skuId) continue;
      if (Date.parse(supply.expectedAt) > Date.parse(line.dueAt)) continue;
      runningAvailable[line.skuId] = (runningAvailable[line.skuId] ?? 0) + supply.quantity;
      usedSupplyIndexes.add(index);
    }

    const available = runningAvailable[line.skuId] ?? 0;
    if (available >= line.quantity) {
      runningAvailable[line.skuId] = available - line.quantity;
      return [];
    }

    runningAvailable[line.skuId] = 0;
    return [{
      skuId: line.skuId,
      sku: line.sku,
      dueAt: line.dueAt,
      demandQuantity: line.quantity,
      availableOrExpectedQuantity: available,
      missingQuantity: line.quantity - available,
    }];
  });

  return inventoryForecastResponseSchema.parse({
    contractVersion: INVENTORY_CONTRACT_VERSION,
    shortages,
  });
}

export function buildSubscriptionInventoryForecast(input: {
  generatedAt: string;
  horizonDays: number;
  protectionDays: number;
  providerCurrent: InventoryProviderStockLine[];
  openHardReservations: InventoryHardReservationLine[];
  stock: InventoryStockLine[];
  demand: InventoryForecastDemandLine[];
  supply: InventoryForecastSupplyLine[];
  activeSubscriptionCount: number;
  excludedSubscriptionCount: number;
}): InventorySubscriptionForecastResponse {
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

  const skus = [...skuIds].map((skuId) => {
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

  return inventorySubscriptionForecastResponseSchema.parse({
    contractVersion: INVENTORY_CONTRACT_VERSION,
    generatedAt: input.generatedAt,
    stockMasterProvider: "omnipack",
    horizonDays: input.horizonDays,
    protectionDays: input.protectionDays,
    skus,
    totals: {
      activeSubscriptionCount: input.activeSubscriptionCount,
      excludedSubscriptionCount: input.excludedSubscriptionCount,
      missingProviderStockSkuCount: skus.filter((line) => line.stockStatus === "missing").length,
      staleProviderStockSkuCount: skus.filter((line) => line.stockStatus === "stale").length,
      horizonShortageSkuCount: skus.filter((line) => line.shortageDate !== null).length,
      protectionShortageSkuCount: skus.filter((line) => line.protectionMissingQty > 0).length,
      shortageSkuCount: skus.filter((line) => line.shortageDate !== null).length,
      recommendedProductionQty: sum(skus.map((line) => line.recommendedProductionQty)),
    },
  });
}

function simulateSubscriptionCoverage(input: {
  generatedAtMs: number;
  protectionAtMs: number;
  sellableNow: number;
  demand: InventoryForecastDemandLine[];
  supply: InventoryForecastSupplyLine[];
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

function demandQuantityWithin(lines: InventoryForecastDemandLine[], dueAtOrBeforeMs: number): number {
  return sum(lines
    .filter((line) => Date.parse(line.dueAt) <= dueAtOrBeforeMs)
    .map((line) => line.quantity));
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
