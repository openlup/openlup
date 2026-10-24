import { expect, it, vi } from "vitest";
import { createPostgresStockAvailability } from "../../src/inventory/postgresStockAvailability.js";
it("keeps native one-time availability behind fixed priority and missing/stale stock facts", async () => {
  const row = { sku: "sku", catalogSkuId: null, source: "provider", providerForSale: 10, activeHolds: 3,
    safetyStock: 0, available: 2, stale: true, renewalDemand: 5, availableForNewPurchases: 2, excludedOrderHolds: 0 };
  const query = vi.fn().mockResolvedValue({ rows: [{ response: [row] }] });
  const store = createPostgresStockAvailability({ query }, { sourceKey: "warehouse", now: () => "2026-10-24" });
  expect(await store.readPort.read({ skus: ["sku"], horizonDays: 14, excludeOrderId: null })).toEqual(new Map([["sku", row]]));
  expect(query.mock.calls[0][1]).toEqual(["warehouse", '["sku"]', "2026-10-24"]);
  await expect(store.readPort.read({ skus: ["sku"], horizonDays: 1, excludeOrderId: null })).rejects.toThrow("unsupported");
  await expect(store.readPort.read({ skus: ["sku"], horizonDays: 14, excludeOrderId: "own" })).rejects.toThrow("unsupported");
  expect(query).toHaveBeenCalledTimes(1);
});
it.each([null, -1, "", 1.5, "NaN"])("rejects invalid ATP quantities: %s", async quantity => {
  const query = vi.fn().mockResolvedValue({ rows: [{ response: { available_quantity: quantity } }] });
  const store = createPostgresStockAvailability({ query }, { sourceKey: "warehouse", now: () => "2026-10-24" });
  await expect(store.availableToPromise("sku", "2026-10-24")).rejects.toThrow("quantity_invalid");
  expect(query.mock.calls[0][0]).toContain("false");
});
