import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { createNewPurchaseStockAvailabilityPort, type NewPurchaseStockReadPort, type NewPurchaseStockMode as ServerStockMode } from "@openlup/platform/inventory";
import type { NewPurchaseStockRow, NewPurchaseStockMode, NewPurchaseStockAvailabilityOptions } from "@openlup/platform/inventory/contracts";
import type { BundleStockPort, BundleStockAvailability, BundleStockRequestItem } from "@openlup/platform/catalog";

const item = (sku: string): BundleStockRequestItem => ({ sku, productSlug: sku, variantId: sku, requestedQuantity: 1, checkoutMode: "one_time" });
const row = (sku: string, available: number | null): NewPurchaseStockRow => ({ sku, available, availableForNewPurchases: available, source: "local", catalogSkuId: null, providerForSale: null, activeHolds: 0, safetyStock: 0, stale: false, renewalDemand: 0, excludedOrderHolds: 0 });
function fixture(readPort: NewPurchaseStockReadPort, mode: NewPurchaseStockMode = "new_purchase") {
  const deriveOfferAvailability = vi.fn((input: BundleStockRequestItem & { sellableNow: number | null; source: string }): BundleStockAvailability => ({
    sku: input.sku, productSlug: input.productSlug, variantId: input.variantId, sellableNow: input.sellableNow,
    status: "unknown", visibleInConfigurator: true, reasonCode: "host_projection", source: input.source,
  }));
  const fallback = { getAvailability: vi.fn(async ({ items }: { items: readonly BundleStockRequestItem[] }) => items.map(input => deriveOfferAvailability({ ...input, sellableNow: 19, source: "fallback" }))) };
  const observe = { warn: vi.fn() };
  const bindings = { readPort, deriveOfferAvailability, functionMissingFallback: () => fallback, functionMissingError: "missing_function", defaultLowStockThreshold: 7, defaultHorizonDays: 11, observe };
  const options: NewPurchaseStockAvailabilityOptions = { mode };
  return { port: createNewPurchaseStockAvailabilityPort(bindings, options), bindings, deriveOfferAvailability, fallback, observe };
}

describe("normalized new-purchase boundary", () => {
  it("returns the merged stock port and never reads an empty request", async () => {
    const read = vi.fn();
    const f = fixture({ read });
    expectTypeOf(f.port).toEqualTypeOf<BundleStockPort>();
    expectTypeOf<ServerStockMode>().toEqualTypeOf<NewPurchaseStockMode>();
    expect(await f.port.getAvailability({ items: [] })).toEqual([]);
    expect(read).not.toHaveBeenCalled();
    expect(f.deriveOfferAvailability).not.toHaveBeenCalled();
    expect(f.observe.warn).not.toHaveBeenCalled();
  });

  it("retains order, duplicates, local/null/clamp mechanics and host defaults", async () => {
    const read = vi.fn(async () => new Map([["negative", row("negative", -4)], ["null", row("null", null)]]));
    const f = fixture({ read });
    const items = [item("negative"), item("null"), item("absent"), item("negative")];
    const result = await f.port.getAvailability({ items });
    expect(result.map(value => [value.sku, value.sellableNow, value.source])).toEqual([["negative", 0, "inventory"], ["null", null, "inventory"], ["absent", null, "inventory"], ["negative", 0, "inventory"]]);
    expect(read).toHaveBeenCalledExactlyOnceWith({ skus: items.map(value => value.sku), horizonDays: 11, excludeOrderId: null });
    expect(f.deriveOfferAvailability).toHaveBeenNthCalledWith(1, { ...items[0], sellableNow: 0, lowStockThreshold: 7, source: "inventory" });
    const override = createNewPurchaseStockAvailabilityPort(f.bindings, { mode: "renewal", lowStockThreshold: 0, horizonDays: 0 });
    await override.getAvailability({ items: [item("null")] });
    expect(read).toHaveBeenLastCalledWith({ skus: ["null"], horizonDays: 0, excludeOrderId: null });
    expect(f.deriveOfferAvailability).toHaveBeenLastCalledWith({ ...item("null"), sellableNow: null, lowStockThreshold: 0, source: "inventory" });
  });

  it("falls back only for the exact recognized Error and preserves observation/fault modes", async () => {
    const read = vi.fn(async (): Promise<Map<string, NewPurchaseStockRow>> => { throw new Error("missing_function"); });
    const f = fixture({ read });
    const items = [item("XXX")];
    expect(await f.port.getAvailability({ items })).toMatchObject([{ source: "fallback", sellableNow: 19 }]);
    expect(f.observe.warn).toHaveBeenCalledWith("[new-purchase-stock] function missing; falling back to the core availability read");
    read.mockRejectedValueOnce("missing_function");
    expect(await f.port.getAvailability({ items })).toEqual([{ sku: "XXX", productSlug: "XXX", variantId: "XXX", status: "unknown", visibleInConfigurator: true, sellableNow: null, reasonCode: "inventory_read_failed", source: "inventory" }]);
    expect(f.observe.warn).toHaveBeenLastCalledWith("[new-purchase-stock] availability read failed", { reason: "missing_function" });
    expect(f.fallback.getAvailability).toHaveBeenCalledTimes(1);
    read.mockRejectedValueOnce(new Error("busy"));
    await f.port.getAvailability({ items });
    expect(f.fallback.getAvailability).toHaveBeenCalledTimes(1);
    expect(f.observe.warn).toHaveBeenLastCalledWith("[new-purchase-stock] availability read failed", { reason: "busy" });
    read.mockRejectedValueOnce(new Error("missing_function"));
    f.fallback.getAvailability.mockRejectedValueOnce(new Error("fallback_failed"));
    await expect(f.port.getAvailability({ items })).rejects.toThrow("fallback_failed");
  });
});
