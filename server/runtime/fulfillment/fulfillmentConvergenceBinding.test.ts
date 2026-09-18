import { describe, expect, it, vi } from "vitest";
import { resolveFulfillmentStockSyncBinding } from "./fulfillmentConvergenceBinding.js";

describe("fulfillment convergence binding", () => {
  it("fails closed before constructing a direct lane when configuration is incomplete", () => {
    const createLane = vi.fn();
    expect(resolveFulfillmentStockSyncBinding(
      { PLATFORM_BUNDLE: "node-postgres", FULFILLMENT_STOCK_SOURCE_KEY: "source" }, { createLane },
    )).toEqual({ error: "database_url_required" });
    expect(resolveFulfillmentStockSyncBinding(
      { PLATFORM_BUNDLE: "node-postgres", DATABASE_URL: "postgres://platform" }, { createLane },
    )).toEqual({ error: "fulfillment_stock_source_key_required" });
    expect(createLane).not.toHaveBeenCalled();
  });

  it("runs every direct operation inside the capability-local lane and closes it", async () => {
    const query = vi.fn(async (sql: string) => ({ rows: sql.includes("stock_sync_cursors WHERE")
      ? [{ status: "succeeded", cursor: {}, last_stock_synced_at: null, last_movement_occurred_at: null }]
      : [] }));
    const close = vi.fn().mockResolvedValue(undefined);
    const createLane = vi.fn(() => ({
      run: <T>(work: (client: unknown) => Promise<T>) => work({ query }), close,
    }));
    const resolved = resolveFulfillmentStockSyncBinding({
      PLATFORM_BUNDLE: "node-postgres", DATABASE_URL: "postgres://platform",
      FULFILLMENT_STOCK_SOURCE_KEY: " source ",
    }, { createLane });
    expect(resolved.error).toBeUndefined();
    await expect(resolved.binding?.readCursor()).resolves.toEqual({
      status: "succeeded", cursor: {}, lastStockSyncedAt: null, lastMovementOccurredAt: null,
    });
    await resolved.binding?.close();
    expect(createLane).toHaveBeenCalledWith("postgres://platform");
    expect(close).toHaveBeenCalledOnce();
  });

  it("keeps the characterized managed adapter on the managed bundle", async () => {
    const builder = { select: () => builder, eq: () => builder,
      maybeSingle: async () => ({ data: null, error: null }) };
    const managedClient = { from: vi.fn(() => builder), rpc: vi.fn() };
    const resolved = resolveFulfillmentStockSyncBinding(
      { PLATFORM_BUNDLE: "managed" }, { managedClient: managedClient as never },
    );
    await expect(resolved.binding?.readCursor()).resolves.toBeNull();
    await expect(resolved.binding?.close()).resolves.toBeUndefined();
    expect(managedClient.from).toHaveBeenCalledWith("omnipack_stock_sync_cursors");
  });
});
