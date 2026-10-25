import { expect, it, vi } from "vitest";
import { z } from "zod";
import { createInventoryBindings, createNewPurchaseStockAvailabilityPort, type NewPurchaseStockRow } from "@openlup/platform/inventory";
import type { BundleStockRequestItem } from "@openlup/platform/catalog";

const item = { sku: "SKU-EXAMPLE", productSlug: "example", variantId: "variant-example", requestedQuantity: 1, checkoutMode: "one_time" as const };
const row: NewPurchaseStockRow = { sku: item.sku, catalogSkuId: null, source: "local", providerForSale: null,
  activeHolds: 2, safetyStock: 1, available: 8, stale: false, renewalDemand: 3, availableForNewPurchases: 5, excludedOrderHolds: 0 };
const stock = {
  functionMissingFallback: null, functionMissingError: "missing", defaultLowStockThreshold: 1, defaultHorizonDays: 14, observe: { warn: vi.fn() },
  deriveOfferAvailability: (input: BundleStockRequestItem & { sellableNow: number | null; source: string }) => ({
    sku: input.sku, productSlug: input.productSlug, variantId: input.variantId, sellableNow: input.sellableNow,
    status: "available" as const, visibleInConfigurator: true, reasonCode: "stock_available", source: input.source,
  }),
};

it("W2 preserves the normalized new-purchase quantity, fixed default horizon and read-only transcript", async () => {
  const read = vi.fn(async () => new Map([[item.sku, row]]));
  const port = createNewPurchaseStockAvailabilityPort({ ...stock, readPort: { read } }, { mode: "new_purchase" });
  expect((await port.getAvailability({ items: [item] }))[0].sellableNow).toBe(5);
  expect(read.mock.calls).toEqual([[{ skus: [item.sku], horizonDays: 14, excludeOrderId: null }]]);
});

it("W2 binds native ATP rather than a host override and exposes no renewal waiver or allocation call", async () => {
  const nativeRow = { ...row, source: "provider", providerForSale: 10, safetyStock: 0, available: 5 };
  const query = vi.fn(async (_text: string, _values?: unknown[]) => ({ rows: [{ response: [nativeRow] }] }));
  const injected = { read: vi.fn() };
  const now = () => new Date(0).toISOString();
  const binding = createInventoryBindings({ dataKind: "postgres", provider: { stockMasterProvider: "fixture", providerSchema: z.literal("fixture") },
    executor: { query }, stockSourceKey: "EXAMPLE-source", now, newPurchaseStockReadPort: injected });
  expect(binding.readiness).toEqual({ ready: true, reason: null });
  expect(binding.unsupported.newPurchaseStockRead).toBeNull();
  for (const mode of ["new_purchase", "renewal"] as const) {
    const port = createNewPurchaseStockAvailabilityPort({ ...stock, readPort: binding.newPurchaseStockReadPort! }, { mode });
    expect((await port.getAvailability({ items: [item] }))[0].sellableNow).toBe(5);
  }
  const sql = `SELECT public.inventory_new_purchase_stock_read(
          $1::text,$2::jsonb,$3::timestamptz) AS response`;
  expect(query.mock.calls).toEqual([[sql, ["EXAMPLE-source", JSON.stringify([item.sku]), now()]], [sql, ["EXAMPLE-source", JSON.stringify([item.sku]), now()]]]);
  expect(injected.read).not.toHaveBeenCalled();
  query.mockClear();
  for (const input of [{ horizonDays: 13, excludeOrderId: null }, { horizonDays: 15, excludeOrderId: null }, { horizonDays: 14, excludeOrderId: "EXAMPLE-order" }]) {
    await expect(binding.newPurchaseStockReadPort!.read({ skus: [item.sku], ...input })).rejects.toThrow("native_stock_read_options_unsupported");
  }
  expect(await binding.newPurchaseStockReadPort!.read({ skus: [], horizonDays: 14, excludeOrderId: null })).toEqual(new Map());
  expect(query).not.toHaveBeenCalled();
});
