import { afterEach, describe, expect, it, vi } from "vitest";
import { createNewPurchaseStockAvailabilityPort, type NewPurchaseStockRow, type NewPurchaseStockAvailabilityOptions } from "@openlup/platform/inventory";
import type { BundleStockAvailability, BundleStockRequestItem } from "@openlup/platform/catalog";

// Synthetic transport vocabulary belongs only to this binding fixture.
const transport = {
  read: "fixture_stock_read", missingCode: "fixture_function_missing",
  skus: "fixture_skus", horizonDays: "fixture_horizon_days", excludeOrderId: "fixture_excluded_order",
  providerStock: "fixture_provider_stock", balances: "fixture_balances", reservations: "fixture_reservations",
  skuRows: "fixture_sku_rows", locations: "fixture_locations", lots: "fixture_lots",
} as const;

// Binding fixture only: the private RPC/parser/fallback implementation is not imported.
// Calls below preserve W1's observation assertions; they do not prove a transport or SQL.
function createNewPurchaseStockAvailabilityPortFromClient(
  client: { rpc: (name: string, args: Record<string, unknown>) => Promise<{ data: Record<string, unknown>[] | null; error: { code: string; message: string } | null }>; from: (table: string) => unknown },
  options: NewPurchaseStockAvailabilityOptions,
) {
  return createNewPurchaseStockAvailabilityPort({
    readPort: { async read(input) {
      const { data, error } = await client.rpc(transport.read, {
        [transport.skus]: input.skus, [transport.horizonDays]: input.horizonDays, [transport.excludeOrderId]: input.excludeOrderId,
      });
      if (error) throw new Error(error.code === transport.missingCode ? "fixture_missing" : error.message);
      return new Map((data ?? []).map(raw => [String(raw.sku), {
        sku: raw.sku, catalogSkuId: raw.catalog_sku_id, source: raw.source,
        providerForSale: raw.provider_for_sale, activeHolds: raw.active_holds, safetyStock: raw.safety_stock,
        available: raw.available, stale: raw.stale, renewalDemand: raw.renewal_demand,
        availableForNewPurchases: raw.available_for_new_purchases, excludedOrderHolds: raw.excluded_order_holds,
      } as NewPurchaseStockRow]));
    } },
    functionMissingFallback: () => ({ async getAvailability({ items }) {
      for (const table of [transport.providerStock, transport.balances, transport.reservations]) client.from(table);
      return items.map(item => project({ ...item, sellableNow: 30, source: "inventory", lowStockThreshold: 20 }));
    } }),
    functionMissingError: "fixture_missing", defaultLowStockThreshold: 20, defaultHorizonDays: 14,
    deriveOfferAvailability: project, observe: console,
  }, options);
}
function project(input: BundleStockRequestItem & { sellableNow: number | null; source: string; lowStockThreshold: number }): BundleStockAvailability {
  const status = input.sellableNow === null ? "unknown" : input.sellableNow <= 0 ? "out_of_stock" : input.sellableNow <= input.lowStockThreshold ? "low_stock" : "available";
  return { sku: input.sku, productSlug: input.productSlug, variantId: input.variantId, status,
    visibleInConfigurator: status !== "out_of_stock", sellableNow: input.sellableNow,
    reasonCode: status === "available" ? "stock_available" : status === "unknown" ? "stock_unknown" : status, source: input.source };
}

const items = ["fresh", "short", "stale", "local", "missing"].map(sku => ({ sku, productSlug: sku, variantId: sku, requestedQuantity: 1, checkoutMode: "one_time" as const }));
function row(sku: string, patch: Record<string, unknown> = {}) {
  return { sku, catalog_sku_id: `id-${sku}`, source: "provider", provider_for_sale: 50,
    active_holds: 2, safety_stock: 1, available: 47, stale: false, renewal_demand: 17,
    available_for_new_purchases: 30, excluded_order_holds: 0, ...patch };
}
function setup(error: { code: string; message: string } | null = null) {
  const rpc = vi.fn(async () => ({ data: error ? null : [row("fresh"), row("short", { available_for_new_purchases: 0 }),
    row("stale", { stale: true }), row("local", { source: "local" })], error }));
  const from = vi.fn((_table: string) => { throw new Error("unexpected local fallback"); });
  return { rpc, from, port: createNewPurchaseStockAvailabilityPortFromClient({ rpc, from } as never, { mode: "new_purchase" }) };
}
afterEach(() => vi.restoreAllMocks());

describe("W1 actual stock read → storefront availability", () => {
  it("projects a mixed batch without treating local or missing provider stock as healthy", async () => {
    const f = setup();
    const result = await f.port.getAvailability({ items });
    expect(result.map(r => [r.sku, r.status, r.sellableNow, r.source])).toEqual([
      ["fresh", "available", 30, "inventory_provider"], ["short", "out_of_stock", 0, "inventory_provider"],
      ["stale", "out_of_stock", 0, "inventory_provider"], ["local", "out_of_stock", 0, "inventory_provider"],
      ["missing", "out_of_stock", 0, "inventory_provider"],
    ]);
    expect(result.slice(2).map(r => r.reasonCode)).toEqual(["provider_stock_stale", "provider_stock_missing", "provider_stock_missing"]);
    expect(f.rpc).toHaveBeenCalledExactlyOnceWith(transport.read, {
      [transport.skus]: items.map(i => i.sku), [transport.horizonDays]: 14, [transport.excludeOrderId]: null,
    });
    expect(f.from).not.toHaveBeenCalled();
  });
  it("uses physical availability for renewal edits and the protected budget for new purchases", async () => {
    const f = setup();
    const renewal = createNewPurchaseStockAvailabilityPortFromClient(f as never, { mode: "renewal" });
    expect(await renewal.getAvailability({ items: [items[0]!] })).toMatchObject([{ sellableNow: 47 }]);
    expect(await f.port.getAvailability({ items: [items[0]!] })).toMatchObject([{ sellableNow: 30 }]);
  });
  it("keeps a real read failure unknown and visible without trying the legacy read", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = setup({ code: "57014", message: "timeout" });
    expect(await f.port.getAvailability({ items: [items[0]!] })).toEqual([{
      sku: "fresh", productSlug: "fresh", variantId: "fresh", status: "unknown", visibleInConfigurator: true, sellableNow: null,
      reasonCode: "inventory_read_failed", source: "inventory",
    }]);
    expect(f.from).not.toHaveBeenCalled();
  });
  it("enters the legacy read only for a recognized missing-function error", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = setup({ code: transport.missingCode, message: `Could not find the function ${transport.read}` });
    f.from.mockImplementation((table: string) => {
      const data = table === transport.balances ? [{ on_hand: 30, unavailable: 0, safety_stock: 0,
        [transport.skuRows]: { sku: "fresh" }, [transport.locations]: { status: "active", fulfillable: true }, [transport.lots]: null }] : [];
      const query = { select: vi.fn(), in: vi.fn(), then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data, error: null }).then(resolve) };
      query.select.mockReturnValue(query); query.in.mockReturnValue(query); return query as never;
    });
    const result = await f.port.getAvailability({ items: [items[0]!] });
    expect(f.from.mock.calls).toEqual([[transport.providerStock], [transport.balances], [transport.reservations]]);
    expect(result).toMatchObject([{ status: "available", sellableNow: 30, source: "inventory" }]);
  });
});
