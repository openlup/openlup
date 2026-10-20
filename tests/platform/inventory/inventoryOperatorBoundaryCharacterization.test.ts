import { describe, expect, it, vi } from "vitest";
import { createManagedInventoryPort } from "../../../server/adapters/managed/inventory/inventoryPort.js";
import { createPostgresAdminInventoryPort } from "../../../server/adapters/postgres/inventory/adminInventory.js";
import { createAdminInventoryStockHandler, createAdminInventoryReservationsHandler, createAdminInventoryStockAdjustmentHandler } from "../../../server/domains/inventory/inventoryHandlers.js";

const SKU = "11111111-1111-4111-8111-111111111111", LOC = "22222222-2222-4222-8222-222222222222";
const authorizeAdmin = async () => ({ ok: true as const, userId: "admin-session" });
function response() {
  const res = { status: vi.fn(), json: vi.fn(), setHeader: vi.fn() };
  res.status.mockReturnValue(res); res.json.mockReturnValue(res); return res;
}
function managed() {
  const rows = [{ sku_id: SKU, location_id: LOC, lot_id: null, on_hand: 12, reserved: 2, unavailable: 1, incoming: 9, safety_stock: 1,
    catalog_skus: { sku: "A" }, inventory_locations: { code: "warehouse", kind: "internal_warehouse", status: "active", fulfillable: true } }];
  const query = { select: vi.fn(), order: vi.fn(), eq: vi.fn(), range: vi.fn(async () => ({ data: rows, count: 1, error: null })) };
  query.select.mockReturnValue(query); query.order.mockReturnValue(query); query.eq.mockReturnValue(query);
  const from = vi.fn(() => query), rpc = vi.fn();
  return { from, rpc, query, port: createManagedInventoryPort({ from, rpc } as never) };
}
const adjustment = { idempotencyKey: "adjust-original", skuId: SKU, locationId: LOC, quantityDelta: 1, reason: "recount" };

describe("W9 operator authority → selected store readback/refusal", () => {
  it("blocks a denied operator before the actual managed adapter performs any read", async () => {
    const f = managed(), res = response();
    await createAdminInventoryStockHandler({ inventoryPort: f.port,
      authorizeAdmin: async () => ({ ok: false, code: "FORBIDDEN", message: "Admin required" }) })(
      { method: "GET", query: {} } as never, res as never);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(f.from).not.toHaveBeenCalled(); expect(f.rpc).not.toHaveBeenCalled();
  });
  it("projects actual managed stock through schema validation without selling incoming units", async () => {
    const f = managed(), res = response();
    await createAdminInventoryStockHandler({ inventoryPort: f.port, authorizeAdmin })(
      { method: "GET", query: {} } as never, res as never);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ ok: true, data: expect.objectContaining({ stock: [expect.objectContaining({
      skuId: SKU, locationId: LOC, availableNow: 8, incoming: 9, unavailable: 1, safetyStock: 1,
    })], totalCount: 1 }) });
    expect(f.from).toHaveBeenCalledExactlyOnceWith("inventory_balances");
    expect(f.query.range).toHaveBeenCalledExactlyOnceWith(0, 24);
    expect(f.rpc).not.toHaveBeenCalled();
  });
  it("keeps direct reservation compatibility fields through the operator response", async () => {
    const query = vi.fn(async (_sql: string, _args: unknown[]) => ({ rows: [{ id: LOC, order_id: SKU, cycle_id: null, status: "reserved", expires_at: null,
      created_at: "2026-10-20T10:00:00.000Z", total_count: 1 }] }));
    const res = response();
    await createAdminInventoryReservationsHandler({ authorizeAdmin, inventoryPort: createPostgresAdminInventoryPort({ query } as never) })(
      { method: "GET", query: { status: "reserved" } } as never, res as never);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ ok: true, data: expect.objectContaining({ reservations: [{ id: LOC, orderId: SKU,
      subscriptionCycleId: null, status: "reserved", kind: "subscription_retry_window", expiresAt: null, createdAt: "2026-10-20T10:00:00.000Z" }] }) });
    expect(query.mock.calls[0]?.[1]).toEqual(["reserved", null, 25, 0]);
  });
  it("refuses flag-off managed and unsupported direct adjustment without a store write", async () => {
    const f = managed(), disabled = response(), unsupported = response();
    await createAdminInventoryStockAdjustmentHandler({ authorizeAdmin, inventoryPort: f.port, mutationsEnabled: () => false })(
      { method: "POST", body: adjustment } as never, disabled as never);
    const query = vi.fn();
    await createAdminInventoryStockAdjustmentHandler({ authorizeAdmin,
      inventoryPort: createPostgresAdminInventoryPort({ query } as never), mutationsEnabled: () => true })(
      { method: "POST", body: adjustment } as never, unsupported as never);
    expect(disabled.status).toHaveBeenCalledWith(403);
    expect(unsupported.status).toHaveBeenCalledWith(503);
    expect(unsupported.json).toHaveBeenCalledWith(expect.objectContaining({ ok: false, error: expect.objectContaining({ code: "UPSTREAM_UNAVAILABLE" }) }));
    expect(f.rpc).not.toHaveBeenCalled(); expect(query).not.toHaveBeenCalled();
  });
});
