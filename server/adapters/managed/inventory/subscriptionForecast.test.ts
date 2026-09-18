import { describe, expect, it } from "vitest";
import {
  readSubscriptionForecast,
} from "./subscriptionForecast.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const SKU_ID = "11111111-1111-4111-8111-111111111111";
const STOCK_AUTHORITY = "omnipack";

describe("readSubscriptionForecast", () => {
  it("builds the subscription forecast from managed read models only", async () => {
    const dueAt = new Date(Date.now() + 5 * DAY_MS).toISOString();
    const syncedAt = new Date(Date.now() - DAY_MS).toISOString();
    const staleAfter = new Date(Date.now() + DAY_MS).toISOString();
    const supplyAt = new Date(Date.now() + 25 * DAY_MS).toISOString();

    const forecast = await readSubscriptionForecast(client({
      fulfillment_provider_stock_current: [
        {
          provider_kind: STOCK_AUTHORITY,
          catalog_sku_id: SKU_ID,
          sku: "SKU-001",
          provider_for_sale_quantity: 12,
          last_synced_at: syncedAt,
          stale_after: staleAfter,
        },
      ],
      subscriptions: [
        { id: "sub-active", status: "active", cadence_days: 30, next_cycle_at: dueAt },
        { id: "sub-paused", status: "paused", cadence_days: 30, next_cycle_at: dueAt },
        { id: "sub-cancelled", status: "cancelled", cadence_days: 30, next_cycle_at: dueAt },
      ],
      subscription_lines: [
        { subscription_id: "sub-active", variant_id: SKU_ID, qty: 5 },
        { subscription_id: "sub-paused", variant_id: SKU_ID, qty: 99 },
      ],
      catalog_skus: [
        { id: SKU_ID, sku: "SKU-001" },
      ],
      inventory_reservations: [
        { sku_id: SKU_ID, quantity: 2, metadata: { providerKind: STOCK_AUTHORITY }, status: "reserved" },
        { sku_id: SKU_ID, quantity: 9, metadata: { providerKind: "alternate" }, status: "reserved" },
      ],
      inventory_balances: [
        {
          sku_id: SKU_ID,
          location_id: "loc-1",
          lot_id: null,
          on_hand: 20,
          reserved: 0,
          unavailable: 0,
          incoming: 0,
          safety_stock: 1,
          catalog_skus: { sku: "SKU-001" },
          inventory_locations: { code: "primary", kind: "internal_warehouse", status: "active", fulfillable: true },
          inventory_lots: null,
        },
      ],
      inventory_supply_plans: [
        { sku_id: SKU_ID, quantity: 10, expected_at: supplyAt, status: "planned" },
      ],
    }) as never, { horizonDays: 60, protectionDays: 45 });

    expect(forecast.totals.activeSubscriptionCount).toBe(1);
    expect(forecast.totals.excludedSubscriptionCount).toBe(2);
    expect(forecast.skus).toEqual([
      expect.objectContaining({
        skuId: SKU_ID,
        sku: "SKU-001",
        providerCurrentForSale: 12,
        openHardReservations: 2,
        safetyStock: 1,
        sellableNow: 9,
        activeSubscriptionDemand30: 5,
        activeSubscriptionDemand45: 10,
        activeSubscriptionDemand60: 10,
        plannedSupply: 10,
        horizonMissingQty: 0,
        protectionMissingQty: 0,
        missingQty: 0,
        recommendedProductionQty: 0,
      }),
    ]);
  });
});

function client(tables: Record<string, Array<Record<string, unknown>>>) {
  return {
    from(table: string) {
      return query(tables[table] ?? []);
    },
  };
}

function query(rows: Array<Record<string, unknown>>) {
  const filters: Array<{ column: string; value: unknown }> = [];
  const inFilters: Array<{ column: string; values: unknown[] }> = [];
  const builder = {
    select: () => builder,
    eq: (column: string, value: unknown) => {
      filters.push({ column, value });
      return builder;
    },
    in: (column: string, values: unknown[]) => {
      inFilters.push({ column, values });
      return builder;
    },
    order: () => builder,
    then: (resolve: (value: { data: unknown[]; error: null }) => unknown) => {
      const data = rows.filter((row) =>
        filters.every((filter) => row[filter.column] === filter.value)
        && inFilters.every((filter) => filter.values.includes(row[filter.column]))
      );
      return Promise.resolve({ data, error: null }).then(resolve);
    },
  };
  return builder;
}
