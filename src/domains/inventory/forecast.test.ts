import { describe, expect, it } from "vitest";
import { buildSubscriptionInventoryForecast, forecastSubscriptionInventoryShortages } from "./forecast.js";
import type { InventoryForecastDemandLine, InventoryForecastSupplyLine, InventoryStockLine } from "./contracts.js";

const skuId = "11111111-1111-4111-8111-111111111111";
const now = "2026-06-30T10:00:00+00:00";

describe("inventory subscription demand forecast", () => {
  it("separates forecast demand from hard reservations", () => {
    const response = forecastSubscriptionInventoryShortages({
      stock: [stock({ onHand: 4, reserved: 0 })],
      supply: [],
      demand: [demand({ quantity: 6 })],
    });

    expect(response.shortages).toEqual([expect.objectContaining({
      demandQuantity: 6,
      availableOrExpectedQuantity: 4,
      missingQuantity: 2,
    })]);
  });

  it("ignores skipped and cancelled cycles", () => {
    const response = forecastSubscriptionInventoryShortages({
      stock: [],
      supply: [],
      demand: [
        demand({ status: "skipped", quantity: 6 }),
        demand({ status: "cancelled", quantity: 6 }),
      ],
    });

    expect(response.shortages).toEqual([]);
  });

  it("counts planned supply only when it arrives before demand", () => {
    const response = forecastSubscriptionInventoryShortages({
      stock: [stock({ onHand: 2 })],
      supply: [
        supply({ quantity: 3, expectedAt: "2026-06-08T10:00:00+00:00" }),
        supply({ quantity: 99, expectedAt: "2026-06-20T10:00:00+00:00" }),
      ],
      demand: [demand({ quantity: 6, dueAt: "2026-06-10T10:00:00+00:00" })],
    });

    expect(response.shortages[0]).toMatchObject({
      availableOrExpectedQuantity: 5,
      missingQuantity: 1,
    });
  });

  it("builds the 30/45/60 day subscription forecast over provider-current stock", () => {
    const response = buildSubscriptionInventoryForecast({
      generatedAt: now,
      horizonDays: 60,
      protectionDays: 45,
      providerCurrent: [{
        skuId,
        sku: "OPENLUP-DOG-LAMB-CAN-400G",
        forSaleQuantity: 20,
        lastSyncedAt: now,
        staleAfter: "2026-06-30T12:00:00+00:00",
      }],
      openHardReservations: [{ skuId, quantity: 3 }],
      stock: [stock({ safetyStock: 2 })],
      demand: [
        demand({ quantity: 5, dueAt: "2026-07-10T10:00:00+00:00" }),
        demand({ quantity: 6, dueAt: "2026-08-05T10:00:00+00:00" }),
        demand({ quantity: 7, dueAt: "2026-08-20T10:00:00+00:00" }),
      ],
      supply: [supply({ quantity: 4, expectedAt: "2026-08-01T10:00:00+00:00" })],
      activeSubscriptionCount: 3,
      excludedSubscriptionCount: 1,
    });

    expect(response.skus[0]).toMatchObject({
      providerCurrentForSale: 20,
      openHardReservations: 3,
      safetyStock: 2,
      sellableNow: 15,
      activeSubscriptionDemand30: 5,
      activeSubscriptionDemand45: 11,
      activeSubscriptionDemand60: 18,
      plannedSupply: 4,
      horizonMissingQty: 0,
      protectionMissingQty: 0,
      missingQty: 0,
      recommendedProductionQty: 0,
    });
    expect(response.totals.activeSubscriptionCount).toBe(3);
    expect(response.totals.excludedSubscriptionCount).toBe(1);
  });

  it("uses planned supply before due date and recommends production for protection-window gaps only", () => {
    const response = buildSubscriptionInventoryForecast({
      generatedAt: now,
      horizonDays: 60,
      protectionDays: 45,
      providerCurrent: [{
        skuId,
        sku: "OPENLUP-DOG-LAMB-CAN-400G",
        forSaleQuantity: 4,
        lastSyncedAt: now,
        staleAfter: "2026-06-30T12:00:00+00:00",
      }],
      openHardReservations: [],
      stock: [],
      demand: [
        demand({ quantity: 5, dueAt: "2026-07-20T10:00:00+00:00" }),
        demand({ quantity: 10, dueAt: "2026-08-20T10:00:00+00:00" }),
      ],
      supply: [
        supply({ quantity: 2, expectedAt: "2026-07-10T10:00:00+00:00" }),
        supply({ quantity: 8, expectedAt: "2026-08-10T10:00:00+00:00" }),
      ],
      activeSubscriptionCount: 2,
      excludedSubscriptionCount: 0,
    });

    expect(response.skus[0]).toMatchObject({
      shortageDate: "2026-08-20T10:00:00+00:00",
      horizonMissingQty: 1,
      protectionMissingQty: 0,
      missingQty: 0,
      recommendedProductionQty: 0,
      plannedSupply: 10,
    });
    expect(response.totals).toMatchObject({
      horizonShortageSkuCount: 1,
      protectionShortageSkuCount: 0,
      shortageSkuCount: 1,
    });
  });

  it("fails forecast sellable closed when provider stock is stale or missing", () => {
    const response = buildSubscriptionInventoryForecast({
      generatedAt: now,
      horizonDays: 60,
      protectionDays: 45,
      providerCurrent: [{
        skuId,
        sku: "OPENLUP-DOG-LAMB-CAN-400G",
        forSaleQuantity: 99,
        lastSyncedAt: "2026-06-29T10:00:00+00:00",
        staleAfter: "2026-06-29T12:00:00+00:00",
      }],
      openHardReservations: [],
      stock: [],
      demand: [demand({ quantity: 6, dueAt: "2026-07-10T10:00:00+00:00" })],
      supply: [],
      activeSubscriptionCount: 1,
      excludedSubscriptionCount: 0,
    });

    expect(response.skus[0]).toMatchObject({
      stockStatus: "stale",
      sellableNow: 0,
      horizonMissingQty: 6,
      protectionMissingQty: 6,
      missingQty: 6,
      recommendedProductionQty: 6,
    });
    expect(response.totals.staleProviderStockSkuCount).toBe(1);
  });
});

function demand(overrides: Partial<InventoryForecastDemandLine> = {}): InventoryForecastDemandLine {
  return {
    subscriptionId: "22222222-2222-4222-8222-222222222222",
    subscriptionCycleId: "33333333-3333-4333-8333-333333333333",
    skuId,
    sku: "OPENLUP-DOG-LAMB-CAN-400G",
    quantity: 4,
    dueAt: "2026-06-10T10:00:00+00:00",
    status: "planned",
    ...overrides,
  };
}

function supply(overrides: Partial<InventoryForecastSupplyLine> = {}): InventoryForecastSupplyLine {
  return {
    skuId,
    quantity: 4,
    expectedAt: "2026-06-08T10:00:00+00:00",
    status: "planned",
    ...overrides,
  };
}

function stock(overrides: Partial<InventoryStockLine> = {}): InventoryStockLine {
  return {
    skuId,
    sku: "OPENLUP-DOG-LAMB-CAN-400G",
    locationId: "44444444-4444-4444-8444-444444444444",
    locationCode: "pl-main",
    locationKind: "internal_warehouse",
    locationStatus: "active",
    fulfillable: true,
    lotId: null,
    lotCode: null,
    lotStatus: "available",
    expiresAt: null,
    onHand: 10,
    reserved: 0,
    unavailable: 0,
    incoming: 0,
    safetyStock: 0,
    ...overrides,
  };
}
