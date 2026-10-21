import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  buildSubscriptionInventoryForecast,
  forecastSubscriptionInventoryShortages,
  calculateSubscriptionForecastSkus,
  calculateSubscriptionForecastTotals,
} from "../../src/inventory/index.js";
import type {
  SubscriptionForecastCalculationInput,
  SubscriptionForecastCounts,
  SubscriptionForecastSku,
  SubscriptionForecastTotals,
} from "../../src/inventory/contracts/index.js";

const AT = "2026-10-20T10:00:00.000Z";
const SKU = "11111111-1111-4111-8111-111111111111";
const SECOND = "22222222-2222-4222-8222-222222222222";
const due = "2026-10-25T22:00:00.000Z";
function input(): SubscriptionForecastCalculationInput {
  return {
    generatedAt: AT, horizonDays: 60, protectionDays: 45,
    providerCurrent: [{ skuId: SKU, sku: "B", forSaleQuantity: 6, lastSyncedAt: AT, staleAfter: "2026-10-21T10:00:00.000Z" }],
    openHardReservations: [{ skuId: SKU, quantity: 2 }],
    stock: [{ skuId: SKU, sku: "B", fulfillable: true, locationStatus: "active", safetyStock: 1 }],
    demand: [{ skuId: SKU, sku: "B", quantity: 5, dueAt: due, status: "planned" }],
    supply: [],
  };
}
const counts: SubscriptionForecastCounts = { activeSubscriptionCount: 2, excludedSubscriptionCount: 1 };

describe("separate dated forecast calculation and retained inventory forecast", () => {
  it("orders same-date supply before demand, sorts SKUs and separates protection from horizon gaps", () => {
    const request = input();
    request.demand.push(
      { skuId: SKU, sku: "B", quantity: 4, dueAt: "2026-12-10T10:00:00.000Z", status: "planned" },
      { skuId: SKU, sku: "B", quantity: 100, dueAt: due, status: "skipped" },
      { skuId: SKU, sku: "B", quantity: 100, dueAt: due, status: "cancelled" },
      { skuId: SKU, sku: "B", quantity: 100, dueAt: "2027-01-01T10:00:00.000Z", status: "planned" },
    );
    request.supply.push(
      { skuId: SKU, quantity: 2, expectedAt: due, status: "planned" },
      { skuId: SKU, quantity: 100, expectedAt: due, status: "received" },
      { skuId: SKU, quantity: 100, expectedAt: "2027-01-01T10:00:00.000Z", status: "planned" },
    );
    request.providerCurrent.push({ ...request.providerCurrent[0]!, skuId: SECOND, sku: "A" });
    const before = JSON.stringify(request);
    const skus: SubscriptionForecastSku[] = calculateSubscriptionForecastSkus(request);
    expect(skus.map(line => line.sku)).toEqual(["A", "B"]);
    expect(skus[1]).toMatchObject({ sellableNow: 3, plannedSupply: 2, activeSubscriptionDemand30: 5,
      activeSubscriptionDemand45: 5, activeSubscriptionDemand60: 9, coverageDays: 51,
      shortageDate: "2026-12-10T10:00:00.000Z", horizonMissingQty: 4, protectionMissingQty: 0, recommendedProductionQty: 0 });
    const totals: SubscriptionForecastTotals = calculateSubscriptionForecastTotals(counts, skus);
    expect(totals).toEqual({ ...counts, missingProviderStockSkuCount: 0, staleProviderStockSkuCount: 0,
      horizonShortageSkuCount: 1, protectionShortageSkuCount: 0, shortageSkuCount: 1, recommendedProductionQty: 0 });
    expect(JSON.stringify(request)).toBe(before);
  });

  it("keeps missing and stale physical stock distinct and subtracts only active fulfillable safety stock", () => {
    const request = input();
    request.providerCurrent[0]!.staleAfter = AT;
    request.demand.push({ ...request.demand[0]!, skuId: SECOND, sku: "A" });
    const skus = calculateSubscriptionForecastSkus(request);
    expect(skus.map(line => [line.stockStatus, line.sellableNow, line.missingQty, line.coverageDays]))
      .toEqual([["missing", 0, 5, 6], ["stale", 0, 5, 6]]);
    expect(calculateSubscriptionForecastTotals(counts, skus)).toMatchObject({ missingProviderStockSkuCount: 1, staleProviderStockSkuCount: 1, recommendedProductionQty: 10 });
    request.providerCurrent[0]!.staleAfter = "2026-10-21T10:00:00.000Z";
    request.stock.push({ ...request.stock[0]!, fulfillable: false, safetyStock: 100 },
      { ...request.stock[0]!, locationStatus: "inactive", safetyStock: 100 });
    expect(calculateSubscriptionForecastSkus(request)[1]!.sellableNow).toBe(3);
    request.openHardReservations[0]!.quantity = 10;
    expect(calculateSubscriptionForecastSkus(request)[1]!.sellableNow).toBe(0);
  });

  it("preserves caller-owned validation, fractional rounding, missing defaults and totals getter order", () => {
    const request = input();
    request.demand[0]!.quantity = 5.5;
    expect(calculateSubscriptionForecastSkus(request)[0]).toMatchObject({ coverageDays: 6, missingQty: 2.5 });
    request.generatedAt = "invalid";
    expect(calculateSubscriptionForecastSkus(request)[0]).toMatchObject({ activeSubscriptionDemand60: 0, coverageDays: null, shortageDate: null });
    expect(() => calculateSubscriptionForecastSkus({ ...request, supply: undefined } as unknown as SubscriptionForecastCalculationInput)).toThrow(TypeError);
    const read: string[] = [];
    expect(calculateSubscriptionForecastTotals({
      get activeSubscriptionCount() { read.push("active"); return 2; },
      get excludedSubscriptionCount() { read.push("excluded"); return 1; },
    }, [])).toMatchObject(counts);
    expect(read).toEqual(["active", "excluded"]);
  });

  it("retains strict inventory validation and requires matching injected provider identity", () => {
    const source = input();
    const request = { ...source, stock: [], ...counts,
      demand: source.demand.map(line => ({ ...line, subscriptionId: SKU, subscriptionCycleId: null, status: "planned" as const })),
      supply: source.supply.map(line => ({ ...line, status: "planned" as const })),
    };
    const config = { stockMasterProvider: "source-a", providerSchema: z.literal("source-a") };
    expect(buildSubscriptionInventoryForecast(request, config)).toMatchObject({ stockMasterProvider: "source-a", skus: [{ sellableNow: 4, missingQty: 1 }] });
    expect(() => buildSubscriptionInventoryForecast(request, { ...config, stockMasterProvider: "source-b" })).toThrow();
    expect(() => buildSubscriptionInventoryForecast(request, { ...config, stockMasterProvider: undefined } as never)).toThrow();
    expect(() => buildSubscriptionInventoryForecast({ ...request, demand: [{ ...request.demand[0]!, quantity: 5.5, subscriptionId: SKU, subscriptionCycleId: null, status: "planned" }] }, config)).toThrow();
    const demand = { ...request.demand[0]!, subscriptionId: SKU, subscriptionCycleId: null, status: "planned" as const };
    expect(forecastSubscriptionInventoryShortages({ stock: [], demand: [demand, { ...demand, status: "skipped" }],
      supply: [{ skuId: SKU, quantity: 2, expectedAt: due, status: "planned" }] })).toEqual({ contractVersion: "inventory.v0", shortages: [{ skuId: SKU, sku: "B", dueAt: due,
      demandQuantity: 5, availableOrExpectedQuantity: 2, missingQuantity: 3 }] });
  });
});
