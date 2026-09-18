import { describe, expect, it } from "vitest";
import { readProviderStockCurrent } from "./providerStock.js";
import type { CommerceOmsClient } from "./types.js";

describe("supabase commerce OMS provider stock", () => {
  it("reads OmniPack stock current rows for order item SKU ids", async () => {
    const client = fakeClient({
      data: [{
        provider_kind: "omnipack",
        sku: "BEEF",
        provider_for_sale_quantity: 350,
        provider_total_quantity: 400,
        last_synced_at: "2026-07-01T10:00:00.000Z",
        stale_after: "2026-07-01T10:30:00.000Z",
      }],
      error: null,
    });

    await expect(readProviderStockCurrent(client, [
      orderItem("sku-1"),
      orderItem("sku-1"),
      orderItem(null),
    ])).resolves.toEqual([
      expect.objectContaining({ provider_kind: "omnipack", provider_for_sale_quantity: 350 }),
    ]);
    expect(client.calls).toEqual([
      ["from", "fulfillment_provider_stock_current"],
      ["select", "provider_kind, sku, provider_for_sale_quantity, provider_total_quantity, last_synced_at, stale_after"],
      ["eq", "provider_kind", "omnipack"],
      ["in", "catalog_sku_id", ["sku-1"]],
    ]);
  });

  it("treats missing optional provider stock table as no evidence", async () => {
    await expect(readProviderStockCurrent(fakeClient({
      data: null,
      error: { message: "relation fulfillment_provider_stock_current does not exist" },
    }), [orderItem("sku-1")])).resolves.toEqual([]);
  });
});

function orderItem(skuId: string | null) {
  return { id: `item-${skuId ?? "none"}`, sku_id: skuId, quantity: 1 };
}

function fakeClient(result: { data: unknown; error: { message?: string } | null }) {
  const calls: unknown[][] = [];
  const query = {
    select(columns: string) {
      calls.push(["select", columns]);
      return this;
    },
    eq(column: string, value: unknown) {
      calls.push(["eq", column, value]);
      return this;
    },
    in(column: string, value: unknown[]) {
      calls.push(["in", column, value]);
      return Promise.resolve(result);
    },
  };
  return {
    calls,
    from(table: string) {
      calls.push(["from", table]);
      return query;
    },
  } as unknown as CommerceOmsClient & { calls: unknown[][] };
}
