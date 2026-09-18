import { describe, expect, it, vi } from "vitest";

import { createPostgresAdminInventoryPort } from "./adminInventory.js";

const SKU_ID = "11111111-1111-4111-8111-111111111111";
const ORDER_ID = "22222222-2222-4222-8222-222222222222";
const CYCLE_ID = "33333333-3333-4333-8333-333333333333";
const RESERVATION_ID = "44444444-4444-4444-8444-444444444444";
const NOW = "2026-08-15T10:00:00.000Z";

describe("postgres admin inventory readback", () => {
  it("returns the stock and exact consumed reservation created by a renewal cycle", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("subscription_renewal_operations operation")) return { rows: [{
        id: RESERVATION_ID, order_id: ORDER_ID, cycle_id: CYCLE_ID,
        status: "consumed", expires_at: null, created_at: NOW,
        identity_key: "subscription:s:cycle:t", operation_fingerprint: "a".repeat(64),
        terminal_outcome: "succeeded", total_count: "1",
      }] };
      return { rows: [{
        sku_id: SKU_ID, sku: "SKU-1", source_key: "primary",
        on_hand: 8, reserved: 0, last_synced_at: NOW,
        stale_after: "2026-08-16T10:00:00.000Z", total_count: "1",
      }] };
    });
    const port = createPostgresAdminInventoryPort({ query }, () => NOW);

    await expect(port.listStock({ page: 1, pageSize: 25, includeZero: false }))
      .resolves.toMatchObject({
        contractVersion: "inventory.v0", totalCount: 1,
        stock: [{ skuId: SKU_ID, sku: "SKU-1", availableNow: 8 }],
      });
    await expect(port.listReservations({ page: 1, pageSize: 25 }))
      .resolves.toMatchObject({
        contractVersion: "inventory.v0", totalCount: 1,
        reservations: [{
          id: RESERVATION_ID, orderId: ORDER_ID,
          subscriptionCycleId: CYCLE_ID, status: "consumed",
        }],
      });
    expect(query.mock.calls[1]?.[0]).toContain("operation.identity_key");
  });

  it("uses the same held reservations in operator ATP and refuses local stock mutation", async () => {
    const query = vi.fn(async (_sql: string, _params?: readonly unknown[]) => ({ rows: [{
      sku_id: SKU_ID, sku: "SKU-1", source_key: "primary",
      on_hand: 3, reserved: 2, last_synced_at: NOW,
      stale_after: "2026-08-16T10:00:00.000Z", total_count: 0,
    }] }));
    const port = createPostgresAdminInventoryPort({ query }, () => NOW);
    await expect(port.checkAtp({
      contractVersion: "inventory.v0",
      requestedAt: NOW,
      orderMode: "subscription_cycle",
      region: "PL",
      noSplitShipment: true,
      minShelfLifeDays: 0,
      lines: [{ skuId: SKU_ID, sku: "SKU-1", quantity: 2 }],
    })).resolves.toMatchObject({ status: "insufficient" });
    expect(query.mock.calls[0]?.[0]).toContain("stock.inventory_class = 'sellable'");
    expect(query.mock.calls[0]?.[0]).toContain("stock.stale_after > $2::timestamptz");
    expect(query.mock.calls[0]?.[1]).toEqual([[SKU_ID], NOW]);
    await expect(port.adjustStock({
      idempotencyKey: "adjustment-1", skuId: SKU_ID,
      locationId: "55555555-5555-4555-8555-555555555555",
      quantityDelta: 1, reason: "manual", actorUserId: "operator-1",
    })).rejects.toThrow("externally observed");
  });

  it("keeps active-demand SKUs without stock visible as missing and counts active subscriptions", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("active_subscription_count")) {
        return { rows: [{ active_subscription_count: "7" }] };
      }
      return { rows: [{
        sku_id: SKU_ID, sku: "SKU-MISSING",
        for_sale_quantity: null, last_synced_at: null, stale_after: null,
        reserved: 0, days_30: 2, days_45: 2, days_60: 2,
      }] };
    });
    const port = createPostgresAdminInventoryPort({ query }, () => NOW);

    await expect(port.forecastSubscriptions({ horizonDays: 60, protectionDays: 45 }))
      .resolves.toMatchObject({
        skus: [{
          skuId: SKU_ID,
          sku: "SKU-MISSING",
          providerCurrentForSale: null,
          stockStatus: "missing",
        }],
        totals: {
          activeSubscriptionCount: 7,
          missingProviderStockSkuCount: 1,
        },
      });
    expect(query.mock.calls[0]?.[0]).toContain("FROM forecast_skus forecast");
    expect(query.mock.calls[0]?.[0]).toContain("LEFT JOIN sellable_stock stock");
    expect(query.mock.calls[0]?.[0]).toContain("WHERE line.sku = forecast.sku");
    expect(query.mock.calls[1]?.[0]).toContain("count(*)::integer AS active_subscription_count");
  });
});
