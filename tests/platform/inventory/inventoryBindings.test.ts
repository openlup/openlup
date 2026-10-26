import { expect, it, vi } from "vitest";
import { z } from "zod";
import { checkReadiness, type ReadinessInput } from "@openlup/core/readiness";
import { createInventoryBindings, type InventoryBindingDependencies, type NewPurchaseStockReadPort } from "@openlup/platform/inventory";
import { createM06InventoryReferenceBinding } from "../../../server/runtime/public-reference/m06InventoryBinding.js";

const provider = { stockMasterProvider: "fixture", providerSchema: z.literal("fixture") };
const executor = { query: vi.fn(async () => ({ rows: [] })) };
const native = () => createInventoryBindings({ dataKind: "postgres", provider, executor, now: () => "2026-10-20T12:00:00.000Z" });

it("selects one executor/store and validates the exact injected provider on readback", async () => {
  const createManagedStore = vi.fn(() => null);
  const binding = createInventoryBindings({ dataKind: "postgres", provider, executor, createManagedStore });
  expect(binding.readiness).toEqual({ ready: true, reason: null });
  expect(createManagedStore).not.toHaveBeenCalled();
  await binding.readPort!.listStock({ page: 1, pageSize: 10, includeZero: true });
  expect(executor.query).toHaveBeenCalledOnce();
  const store = native();
  const managed = vi.fn((received: InventoryBindingDependencies["provider"]) => {
    expect(received).toBe(provider);
    return { readPort: store.readPort!, mutationPort: store.mutationPort! };
  });
  executor.query.mockClear();
  const selected = createInventoryBindings({ dataKind: "supabase", provider, executor, createManagedStore: managed });
  expect(managed).toHaveBeenCalledOnce();
  expect(executor.query).not.toHaveBeenCalled();
  const forecast = await selected.readPort!.forecastSubscriptions({ horizonDays: 60, protectionDays: 45 });
  expect(forecast.stockMasterProvider).toBe("fixture");
  const planted = createInventoryBindings({ dataKind: "supabase", provider: { stockMasterProvider: "other", providerSchema: z.literal("other") }, createManagedStore: () => ({ readPort: store.readPort!, mutationPort: store.mutationPort! }) });
  await expect(planted.readPort!.forecastSubscriptions({ horizonDays: 60, protectionDays: 45 })).rejects.toThrow();
  expect(createInventoryBindings({ dataKind: "postgres", provider: { ...provider, stockMasterProvider: "other" }, executor }).readiness.reason).toBe("inventory_provider_mismatch");
});

it("refuses missing/incompatible stores and required native new-purchase reads through readiness", async () => {
  expect(createInventoryBindings({ dataKind: "postgres", provider }).readiness.reason).toBe("inventory_executor_required");
  expect(createInventoryBindings({ dataKind: "supabase", provider }).readiness.reason).toBe("inventory_managed_store_required");
  expect(createInventoryBindings({ dataKind: "unknown", provider }).readiness.reason).toBe("inventory_store_incompatible");
  expect(createInventoryBindings({ dataKind: "supabase", provider, createManagedStore: () => ({ readPort: {}, mutationPort: {} }) as never }).readiness.reason).toBe("inventory_store_incompatible");
  const binding = createM06InventoryReferenceBinding({ store: { dataKind: "postgres", executor }, version: "0.17.0", requiredSchema: { version: "complete", migration: "complete", objects: [] }, bundleCatalogReadPort: {} as never,
    stock: { functionMissingFallback: null, functionMissingError: "missing", defaultLowStockThreshold: 20, defaultHorizonDays: 60, observe: { warn: vi.fn() } }, options: { mode: "new_purchase" }, requireNewPurchaseStockRead: true });
  expect(binding.unsupported.newPurchaseStockRead).toBe("inventory_native_new_purchase_stock_read_unsupported");
  expect(binding.readiness).toEqual({ ready: false, reason: "inventory_native_new_purchase_stock_read_unsupported" });
  expect(binding.stock).toBeNull();
  expect(binding.availability).toBeNull();
  const input: ReadinessInput = {
    candidate: { artifact: "fixture", configuration: "fixture", environment: "fixture", database: "fixture", schema: "complete" }, inventoryComplete: true,
    loadedPackages: [{ name: "@openlup/core", version: "0.17.0", kind: "kernel" }, { name: "@openlup/platform", version: "0.17.0", kind: "rail", modules: ["inventory"] }],
    contributions: binding.contributions, vocabulary: [], exemptions: [], bindings: { ports: binding.ports, routes: {}, triggers: {}, env: {} },
    schemaProbe: { observe: async () => ({ database: "fixture", version: "complete", objects: [] }) },
  };
  expect((await checkReadiness(input)).issues).toContainEqual(expect.objectContaining({ code: "OPENLUP_E_PORT_MISSING", subject: "newPurchaseStockRead" }));
  const ports = { ...binding.ports }; delete ports["@openlup/platform/inventory:listStock"];
  expect((await checkReadiness({ ...input, bindings: { ...input.bindings, ports } })).state).not.toBe("ready");
});

it("K2c composes the selected M06 reader into the existing reference stock port without allocation", async () => {
  const read = vi.fn(async () => new Map([["ITEM-A", { sku: "ITEM-A", catalogSkuId: null, source: "local" as const,
    providerForSale: null, activeHolds: 2, safetyStock: 1, available: 8, stale: false,
    renewalDemand: 3, availableForNewPurchases: 5, excludedOrderHolds: 0 }]]));
  const store = native();
  const selected = createM06InventoryReferenceBinding({ store: { dataKind: "supabase", createManagedStore: () => ({ readPort: store.readPort!, mutationPort: store.mutationPort! }), newPurchaseStockReadPort: { read } }, version: "0.17.0", requiredSchema: { version: "complete", migration: "complete", objects: [] }, bundleCatalogReadPort: {} as never,
    stock: { functionMissingFallback: null, functionMissingError: "missing", defaultLowStockThreshold: 20, defaultHorizonDays: 14, observe: { warn: vi.fn() } }, options: { mode: "new_purchase" }, requireNewPurchaseStockRead: true });
  expect(selected.newPurchaseStockReadPort?.read).toBe(read);
  expect(selected.ports["@openlup/platform/inventory:newPurchaseStockRead"]).toBe(read);
  expect((await selected.stock!.getAvailability({ items: [{ sku: "ITEM-A", productSlug: "item-a", variantId: "variant-a", requestedQuantity: 1, checkoutMode: "one_time" }] }))[0]).toMatchObject({ sellableNow: 5, reasonCode: "low_stock" });
  expect(read.mock.calls).toEqual([[{ skus: ["ITEM-A"], horizonDays: 14, excludeOrderId: null }]]);
});

it("keeps the native binding refusal despite the separate SQL stock-read seam", () => {
  const read = vi.fn<NewPurchaseStockReadPort["read"]>();
  const binding = createInventoryBindings({ dataKind: "postgres", provider: { stockMasterProvider: "stock-source", providerSchema: z.literal("stock-source") }, executor: { query: async () => ({ rows: [] }) }, newPurchaseStockReadPort: { read } });
  expect(binding.newPurchaseStockReadPort).toBeNull();
  expect(binding.unsupported.newPurchaseStockRead).toBe("inventory_native_new_purchase_stock_read_unsupported");
  expect(read).not.toHaveBeenCalled();
});
