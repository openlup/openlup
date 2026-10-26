import { expect, it, vi } from "vitest";
import { createManagedStockAvailability } from "../../src/inventory/index.js";

const input = { skus: ["SKU"], horizonDays: 14, excludeOrderId: null };
const row = { sku: "SKU", catalogSkuId: null, source: "provider", providerForSale: "20", activeHolds: "5",
  safetyStock: 1, available: "7", stale: false, renewalDemand: 7, availableForNewPurchases: 7, excludedOrderHolds: 0 };
const now = () => "2026-10-25T12:00:00.000Z";
it("sends only SKU JSON and time through a structural PromiseLike RPC and shares native parsing", async () => {
  const rpc = vi.fn(() => Promise.resolve({ data: [row], error: null }));
  const port = createManagedStockAvailability({ rpc }, { now });
  expect(await port.read(input)).toEqual(new Map([["SKU", { ...row, providerForSale: 20, activeHolds: 5, available: 7 }]]));
  expect(rpc).toHaveBeenCalledExactlyOnceWith("inventory_new_purchase_stock_read", { p_skus: ["SKU"], p_as_of: now() });
  expect(await port.read({ ...input, skus: [] })).toEqual(new Map());
  expect(rpc).toHaveBeenCalledTimes(1);
});
it.each([{ horizonDays: 13 }, { horizonDays: 15 }, { excludeOrderId: "order" }])("refuses unsupported options before RPC: %j", async options => {
  const rpc = vi.fn();
  await expect(createManagedStockAvailability({ rpc }, { now }).read({ ...input, ...options })).rejects.toThrow("managed_stock_read_options_unsupported");
  expect(rpc).not.toHaveBeenCalled();
});
it.each([null, {}, [null], [{ ...row, source: "local" }], [{ ...row, stale: "false" }], [{ ...row, sku: 1 }]])("rejects invalid response shape: %j", async data => {
  await expect(createManagedStockAvailability({ rpc: async () => ({ data, error: null }) }, { now }).read(input)).rejects.toThrow("inventory_stock_response_invalid");
});
it.each([null, -1, "", "NaN", 1.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid quantities: %s", async quantity => {
  await expect(createManagedStockAvailability({ rpc: async () => ({ data: [{ ...row, activeHolds: quantity }], error: null }) }, { now }).read(input)).rejects.toThrow("inventory_stock_quantity_invalid");
});
it("preserves RPC errors and transport rejections", async () => {
  const error = { message: "read refused", code: "42501" };
  await expect(createManagedStockAvailability({ rpc: async () => ({ data: null, error }) }, { now }).read(input)).rejects.toBe(error);
  const transport = new Error("transport");
  await expect(createManagedStockAvailability({ rpc: async () => { throw transport; } }, { now }).read(input)).rejects.toBe(transport);
});
