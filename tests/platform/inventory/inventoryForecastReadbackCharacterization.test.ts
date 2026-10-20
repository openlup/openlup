import { afterEach, describe, expect, it, vi } from "vitest";
import { readSubscriptionForecast } from "../../../server/adapters/managed/inventory/subscriptionForecast.js";
import { createPostgresAdminInventoryPort } from "../../../server/adapters/postgres/inventory/adminInventory.js";
import { inventorySubscriptionForecastResponseSchema } from "../../../src/domains/inventory/contracts.js";

const PROVIDER = inventorySubscriptionForecastResponseSchema.shape.stockMasterProvider.value;
const AT = "2026-10-20T10:00:00.000Z", SKU = "11111111-1111-4111-8111-111111111111";
function managed(stale = false, missing = false) {
  const tables: Record<string, Record<string, unknown>[]> = {
    fulfillment_provider_stock_current: missing ? [] : [{ provider_kind: PROVIDER, catalog_sku_id: SKU, sku: "A",
      provider_for_sale_quantity: 6, last_synced_at: AT, stale_after: stale ? AT : "2026-10-21T10:00:00.000Z" }],
    subscriptions: [{ id: "sub-a", status: "active", cadence_days: 28, next_cycle_at: "2026-10-25T10:00:00.000Z" }],
    subscription_lines: [{ subscription_id: "sub-a", variant_id: SKU, qty: 5 }], catalog_skus: [{ id: SKU, sku: "A" }],
    inventory_reservations: [{ sku_id: SKU, quantity: 2, status: "reserved", metadata: { providerKind: PROVIDER }, expires_at: "2026-10-19T10:00:00.000Z" }],
    inventory_supply_plans: [{ sku_id: SKU, quantity: 6, expected_at: "2026-10-24T10:00:00.000Z", status: "planned" }],
  };
  const transcript: unknown[][] = [];
  const from = vi.fn((table: string) => {
    let rows = tables[table] ?? [];
    const b = { select: (columns: string) => { transcript.push([table, "select", columns]); return b; },
      eq: (key: string, value: unknown) => { rows = rows.filter(r => r[key] === value); transcript.push([table, "eq", key, value]); return b; },
      in: (key: string, values: unknown[]) => { rows = rows.filter(r => values.includes(r[key])); return b; }, order: () => b,
      then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(resolve) };
    return b;
  });
  return { from, transcript };
}
afterEach(() => vi.useRealTimers());

describe("W5 selected forecast readback preserves store differences", () => {
  it("maps dated managed supply and still counts an expired reserved row in the forecast projection", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date(AT));
    const f = managed();
    const result = await readSubscriptionForecast(f as never, { horizonDays: 60, protectionDays: 45 });
    expect(inventorySubscriptionForecastResponseSchema.safeParse(result).success).toBe(true);
    expect(result.skus).toMatchObject([{ stockStatus: "fresh", sellableNow: 4, openHardReservations: 2,
      plannedSupply: 6, activeSubscriptionDemand30: 5, activeSubscriptionDemand60: 10, missingQty: 0 }]);
    expect(f.transcript.filter(c => c[0] === "inventory_reservations")).toEqual([
      ["inventory_reservations", "select", "sku_id, quantity, metadata"], ["inventory_reservations", "eq", "status", "reserved"],
    ]); // Advisory projection has no lease expiry predicate; decisive admission remains SQL-owned.
    expect(f.from.mock.calls.map(([table]) => table)).not.toContain("subscription_cycles");
  });
  it.each(["stale", "missing"] as const)("keeps managed %s distinct with zero sellable physical stock", async state => {
    vi.useFakeTimers(); vi.setSystemTime(new Date(AT));
    const result = await readSubscriptionForecast(managed(state === "stale", state === "missing") as never,
      { horizonDays: 60, protectionDays: 45 });
    expect(result.skus).toMatchObject([{ stockStatus: state, sellableNow: 0, openHardReservations: 2 }]);
  });
  it("keeps the direct stale-stock aggregate projection, nullable coverage and absent supply rather than managed parity", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ sku_id: SKU, sku: "A", for_sale_quantity: 6, reserved: 2,
      last_synced_at: AT, stale_after: AT, days_30: 5, days_45: 10, days_60: 10 }] })
      .mockResolvedValueOnce({ rows: [{ active_subscription_count: 1 }] });
    const result = await createPostgresAdminInventoryPort({ query } as never, () => AT)
      .forecastSubscriptions({ horizonDays: 60, protectionDays: 45 });
    expect(inventorySubscriptionForecastResponseSchema.safeParse(result).success).toBe(true);
    expect(result.skus).toMatchObject([{ stockStatus: "stale", sellableNow: 4, openHardReservations: 2,
      plannedSupply: 0, coverageDays: null, shortageDate: null, missingQty: 6, recommendedProductionQty: 6 }]);
    expect(query.mock.calls[0]?.[1]).toEqual([AT, 60]);
    expect(query.mock.calls[0]?.[0]).toContain("reservation.status IN ('held', 'committed')");
    expect(query.mock.calls[0]?.[0]).not.toContain("reservation.expires_at");
  });
});
