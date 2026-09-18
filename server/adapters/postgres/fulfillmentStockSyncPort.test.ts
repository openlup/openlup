import { describe, expect, it, vi } from "vitest";
import { createPostgresFulfillmentStockSyncPort } from "./fulfillmentStockSyncPort.js";

describe("createPostgresFulfillmentStockSyncPort", () => {
  it("records neutral current stock and snapshots with parameterized fingerprints", async () => {
    const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows: [{ response: { replayed: false, readBack: true } }] }));
    const port = createPostgresFulfillmentStockSyncPort({ query } as never, { sourceKey: "primary" });
    const base = {
      idempotencyKey: "sync-1:sku", sku: "SKU-1", providerTotalQuantity: 9,
      providerForSaleQuantity: 7, providerReservedUnavailableQuantity: 2,
      inventoryClass: "sellable" as const, syncRunId: "sync-1", evidence: { ignored: "provider-payload" },
    };
    await expect(port.recordProviderStockCurrent({
      ...base, lastSyncedAt: "2026-08-13T10:00:00.000Z", staleAfter: "2026-08-13T16:00:00.000Z",
    })).resolves.toEqual({ replayed: false, readBack: true });
    await expect(port.recordStockSnapshot({
      ...base, localOnHand: 0, localReserved: 0, localUnavailable: 0,
      localSafetyStock: 0, mismatchKind: "none",
    })).resolves.toEqual({ replayed: false, readBack: true });
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0][0]).toContain("fulfillment_record_stock_current");
    expect(query.mock.calls[0][1]).toEqual(expect.arrayContaining(["primary", "sync-1:sku", "SKU-1", 9, 7, 2]));
    expect(String(query.mock.calls[0][1]?.[2])).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(query.mock.calls)).not.toContain("provider-payload");
  });

  it("reads cursor/classes, represents absent local inventory honestly, and resolves evidence", async () => {
    const query = vi.fn(async (sql: string, _values?: unknown[]) => {
      if (sql.includes("stock_sync_cursors WHERE")) return { rows: [{
        status: "succeeded", cursor: { checked: 1 },
        last_stock_synced_at: "2026-08-13T10:00:00.000Z", last_movement_occurred_at: null,
      }] };
      if (sql.includes("catalog_skus")) return { rows: [{ sku: "SKU-1" }] };
      if (sql.includes("resolve_stock_evidence")) return { rows: [{ response: { resolved: 2 } }] };
      return { rows: [] };
    });
    const port = createPostgresFulfillmentStockSyncPort({ query } as never, {
      sourceKey: "primary", inventoryClasses: new Map([["BOX", "packaging"]]),
    });
    await expect(port.readCursor()).resolves.toEqual({
      status: "succeeded", cursor: { checked: 1 },
      lastStockSyncedAt: "2026-08-13T10:00:00.000Z", lastMovementOccurredAt: null,
    });
    await expect(port.readLocalInventoryStock()).resolves.toEqual([]);
    await expect(port.readActiveReservations(["SKU-1"], "2026-08-13T10:00:00.000Z")).resolves.toEqual(new Map());
    await expect(port.readSkuInventoryClasses(["SKU-1", "BOX", "UNKNOWN"])).resolves.toEqual(new Map([
      ["SKU-1", "sellable"], ["BOX", "packaging"], ["UNKNOWN", null],
    ]));
    await expect(port.resolveLowStockEvidence({
      sku: "SKU-1", activeThresholdKinds: [], syncRunId: "sync-1", evidence: {},
    })).resolves.toEqual({ resolved: 2 });
  });

  it("refuses an empty source key before any query", () => {
    expect(() => createPostgresFulfillmentStockSyncPort({ query: vi.fn() } as never, { sourceKey: " " }))
      .toThrow("fulfillment_stock_source_key_required");
  });
});
