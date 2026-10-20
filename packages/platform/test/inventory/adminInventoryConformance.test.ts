import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  createPostgresAdminInventoryPort, createInventorySubscriptionForecastResponseSchema,
  inventoryStockListResponseSchema, inventoryReservationsListResponseSchema,
} from "@openlup/platform/inventory";

const SKU = "11111111-1111-4111-8111-111111111111";
const NOW = "2026-10-20T10:00:00.000Z";
const config = { stockMasterProvider: "source-x", providerSchema: z.literal("source-x") };

describe("native inventory conformance", () => {
  it("retains stock/reservation schemas, query arguments and unsupported adjustment refusal", async () => {
    const query = vi.fn(async (sql: string) => ({ rows: sql.includes("subscription_renewal_operations operation") ? [{
      id: SKU, order_id: SKU, cycle_id: null, status: "expired", expires_at: null, created_at: NOW, total_count: "3",
    }] : [{ sku_id: SKU, sku: "XXX", source_key: "source-x", on_hand: "12", reserved: "2", total_count: "3" }] }));
    const port = createPostgresAdminInventoryPort({ query }, config, () => NOW);
    const stock = inventoryStockListResponseSchema.parse(await port.listStock({ page: 2, pageSize: 2, includeZero: false }));
    expect(stock).toMatchObject({ totalCount: 3, page: 2, stock: [{ availableNow: 10, incoming: 0, safetyStock: 0 }] });
    expect(query.mock.calls[0]).toHaveLength(2);
    const reservations = inventoryReservationsListResponseSchema.parse(await port.listReservations({ page: 2, pageSize: 2, status: "expired" }));
    expect(reservations.reservations[0]).toMatchObject({ status: "expired", kind: "subscription_retry_window", subscriptionCycleId: null });
    expect(query).toHaveBeenNthCalledWith(1, expect.stringContaining("ORDER BY stock.updated_at DESC, stock.source_key, stock.sku"), [null, false, 2, 2]);
    expect(query).toHaveBeenNthCalledWith(2, expect.any(String), ["expired", null, 2, 2]);
    await expect(port.adjustStock({ idempotencyKey: "adjustment", skuId: SKU, locationId: SKU, quantityDelta: 1, reason: "recount", actorUserId: "operator" })).rejects.toThrow("externally observed");
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("validates fixed forecast bytes with the injected provider and rejects substitution", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const port = createPostgresAdminInventoryPort({ query }, config, () => NOW);
    const forecast = await port.forecastSubscriptions({ horizonDays: 60, protectionDays: 45 });
    const fixed = '{"contractVersion":"inventory.v0","generatedAt":"2026-10-20T10:00:00.000Z","stockMasterProvider":"source-x","horizonDays":60,"protectionDays":45,"skus":[],"totals":{"activeSubscriptionCount":0,"excludedSubscriptionCount":0,"missingProviderStockSkuCount":0,"staleProviderStockSkuCount":0,"horizonShortageSkuCount":0,"protectionShortageSkuCount":0,"shortageSkuCount":0,"recommendedProductionQty":0}}';
    expect(JSON.stringify(forecast)).toBe(fixed);
    const schema = createInventorySubscriptionForecastResponseSchema(config.providerSchema);
    expect(schema.safeParse({ ...forecast, stockMasterProvider: "source-y" }).success).toBe(false);
    const substituted = createPostgresAdminInventoryPort({ query }, { ...config, stockMasterProvider: "source-y" }, () => NOW);
    await expect(substituted.forecastSubscriptions({ horizonDays: 60, protectionDays: 45 })).rejects.toThrow();
  });

  it("preserves fresh/stale/missing demand buckets and nullable coverage without a cycle write", async () => {
    const query = vi.fn(async (sql: string) => ({ rows: sql.includes("active_subscription_count") ? [{ active_subscription_count: "7" }] : [
      { sku_id: SKU, sku: "fresh", for_sale_quantity: 10, reserved: 2, days_30: 3, days_45: 9, days_60: 12, stale_after: "2026-10-21T10:00:00.000Z" },
      { sku_id: SKU, sku: "stale", for_sale_quantity: 2, reserved: 4, days_30: 1, days_45: 3, days_60: 5, stale_after: NOW },
      { sku_id: SKU, sku: "missing", for_sale_quantity: null, days_30: 1, days_45: 2, days_60: 3 },
    ] }));
    const forecast = await createPostgresAdminInventoryPort({ query }, config, () => NOW).forecastSubscriptions({ horizonDays: 60, protectionDays: 45 });
    expect(forecast.skus.map(row => [row.stockStatus, row.sellableNow, row.horizonMissingQty, row.protectionMissingQty, row.coverageDays, row.shortageDate])).toEqual([
      ["fresh", 8, 4, 1, null, null], ["stale", 0, 5, 3, null, null], ["missing", 0, 3, 2, null, null],
    ]);
    expect(forecast.totals).toMatchObject({ activeSubscriptionCount: 7, staleProviderStockSkuCount: 1, missingProviderStockSkuCount: 1, recommendedProductionQty: 12 });
    expect(query.mock.calls.every(([sql]) => /^(WITH|SELECT)\b/.test(sql))).toBe(true);
  });
});
