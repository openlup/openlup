import { describe, expect, it, vi } from "vitest";
import { DEFAULT_LOW_STOCK_THRESHOLD, deriveOfferAvailability } from "../../src/commerce/index.js";
import { createOfferAvailabilityPort, type OfferAvailabilityQueryClient } from "../../src/commerce/server/index.js";
import { createNewPurchaseStockAvailabilityPort, reservationPolicyFor, type NewPurchaseStockReadPort } from "../../src/inventory/index.js";
import type { NewPurchaseStockRow } from "../../src/inventory/contracts/index.js";
import { createCommerceRuntimeService, makeOrderPort, makePaymentPort, makeReadinessPort, makeInventoryPort, orderDraftSummary, CLIENT_ID, ADDRESS_ID } from "./checkoutTestFixtures.js";

const item = { sku: "ITEM-A", productSlug: "item-a", variantId: "variant-a", requestedQuantity: 1, checkoutMode: "one_time" as const };
const row: NewPurchaseStockRow = { sku: item.sku, catalogSkuId: null, source: "local", providerForSale: null, activeHolds: 2, safetyStock: 1, available: 8, stale: false, renewalDemand: 3, availableForNewPurchases: 5, excludedOrderHolds: 0 };
const options = { mode: "new_purchase" as const };
function stock(readPort: NewPurchaseStockReadPort, functionMissingFallback: Parameters<typeof createNewPurchaseStockAvailabilityPort>[0]["functionMissingFallback"] = null) {
  return createNewPurchaseStockAvailabilityPort({ readPort, functionMissingFallback, functionMissingError: "stock_read_missing", defaultHorizonDays: 14, defaultLowStockThreshold: DEFAULT_LOW_STOCK_THRESHOLD, deriveOfferAvailability, observe: { warn: vi.fn() } }, options);
}

function tables(data: Record<string, unknown[]>, failure: string | null = null) {
  const calls: Array<[string, string, unknown[]]> = [];
  const client: OfferAvailabilityQueryClient = {
    from(table) {
      const result = Promise.resolve({ data: data[table] ?? [], error: failure === table ? { code: "unavailable" } : null });
      const builder = { select: (_columns: string) => builder,
        in: async (column: string, values: unknown[]) => { calls.push([table, column, values]); return result; },
        then: result.then.bind(result) };
      return builder;
    },
  };
  return { client, calls };
}
function physical(client: OfferAvailabilityQueryClient) {
  return createOfferAvailabilityPort(client, { isStockProvider: kind => kind === "stock-source", now: () => new Date(0) });
}

describe("commerce ATP consumption conformance (W2)", () => {
  it("uses the injected M06 read port, new-purchase quantity and 14-day horizon without allocating", async () => {
    const read = vi.fn<NewPurchaseStockReadPort["read"]>(async () => new Map([[item.sku, row]]));
    const readPort: NewPurchaseStockReadPort = { read };
    expect(readPort.read).toBe(read);
    expect((await stock(readPort).getAvailability({ items: [item] }))[0].sellableNow).toBe(5);
    expect(read.mock.calls).toEqual([[{ skus: [item.sku], horizonDays: 14, excludeOrderId: null }]]);
  });
  it("reads only the three physical tables on the exact missing-function fallback", async () => {
    const db = tables({ inventory_balances: [{ on_hand: 10, unavailable: 1, safety_stock: 1, catalog_skus: { sku: item.sku }, inventory_locations: { status: "active", fulfillable: true } }], inventory_reservations: [{ quantity: 2, status: "reserved", expires_at: null, catalog_skus: { sku: item.sku }, commerce_orders: { status: "paid" } }] });
    const fallback = vi.fn(() => physical(db.client));
    const read = vi.fn<NewPurchaseStockReadPort["read"]>(async () => { throw new Error("stock_read_missing"); });
    expect((await stock({ read }, fallback).getAvailability({ items: [item] }))[0]).toMatchObject({ sellableNow: 6, source: "inventory" });
    expect(fallback).toHaveBeenCalledOnce();
    expect(db.calls).toEqual([
      ["fulfillment_provider_stock_current", "sku", [item.sku]],
      ["inventory_balances", "catalog_skus.sku", [item.sku]],
      ["inventory_reservations", "catalog_skus.sku", [item.sku]],
    ]);
    read.mockRejectedValueOnce(new Error("permission_refused"));
    expect((await stock({ read }, fallback).getAvailability({ items: [item] }))[0]).toMatchObject({ status: "unknown", reasonCode: "inventory_read_failed" });
    expect(fallback).toHaveBeenCalledOnce();
  });
  it("never falls back to local stock for a missing or stale provider row", async () => {
    const other = { ...item, sku: "ITEM-B" };
    const read = vi.fn<NewPurchaseStockReadPort["read"]>(async () => new Map([[item.sku, { ...row, source: "provider", stale: true }], [other.sku, { ...row, sku: other.sku, source: "local" }]]));
    const fallback = vi.fn(() => physical(tables({}).client));
    expect(await stock({ read }, fallback).getAvailability({ items: [item, other] })).toEqual([
      expect.objectContaining({ sellableNow: 0, visibleInConfigurator: false, reasonCode: "provider_stock_stale" }),
      expect.objectContaining({ sellableNow: 0, visibleInConfigurator: false, reasonCode: "provider_stock_missing" }),
    ]);
    expect(fallback).not.toHaveBeenCalled();
    const db = tables({ fulfillment_provider_stock_current: [{ sku: item.sku, provider_kind: "stock-source", provider_for_sale_quantity: 10, stale_after: new Date(1000).toISOString() }], inventory_balances: [{ on_hand: 100, unavailable: 0, safety_stock: 0, catalog_skus: { sku: other.sku }, inventory_locations: { status: "active", fulfillable: true } }] });
    expect((await physical(db.client).getAvailability({ items: [item, other] }))[1]).toMatchObject({ sellableNow: 0, reasonCode: "provider_stock_missing" });
  });
  it("refuses a failed physical read as unknown and does no reads for an empty request", async () => {
    const db = tables({}, "inventory_reservations"), port = physical(db.client);
    expect(await port.getAvailability({ items: [] })).toEqual([]);
    expect(db.calls).toEqual([]);
    expect((await port.getAvailability({ items: [item] }))[0]).toMatchObject({ status: "unknown", visibleInConfigurator: true, sellableNow: null, reasonCode: "inventory_read_failed" });
  });
  it("allocates one-time stock only at runtime with null cycle ownership and stable lease/key inputs", async () => {
    const inventoryPort = makeInventoryPort(), orderPort = makeOrderPort(), paymentPort = makePaymentPort();
    const service = createCommerceRuntimeService({ inventoryPort, orderPort, paymentPort, readinessPort: makeReadinessPort() });
    const start = { idempotencyKey: "one-time-example", mode: "one_time" as const, clientId: CLIENT_ID, shippingAddressId: ADDRESS_ID, orderDraft: orderDraftSummary(), paymentProvider: "hidden_rehearsal" as const, providerFlow: "one_time_payment" as const, metadata: {} };
    const result = await service.startRuntime(start);
    const order = await orderPort.finalizeOrderForCheckout.mock.results[0].value;
    expect(result.runtime.mode).toBe("one_time");
    expect(order).toMatchObject({ mode: "one_time", subscriptionId: null, subscriptionCycleId: null });
    expect(paymentPort.createIntent).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ subscriptionId: null, subscriptionCycleId: null }));
    // Exact calls reject an extra allocation. This port has no subscription-consumption authority.
    expect(inventoryPort.reserveOrderItems.mock.calls).toEqual([[{ idempotencyKey: "one-time-example:inventory", order, paymentStatus: "created", metadata: {} }]]);
    expect(inventoryPort.releaseOrderReservations).not.toHaveBeenCalled();
    expect(reservationPolicyFor({ reservationKind: "checkout_payment_window", paymentTargetKind: "one_time_order", orderMode: "one_time", now: new Date(0), checkoutTtlMinutes: 30 })).toEqual({ ttlMinutes: 1440, expiresAt: new Date(86_400_000).toISOString() });
  });
});

describe("checkout runtime stock ownership", () => {
  it("reserves only the finalized one-time order and preserves null subscription ownership", async () => {
    const orderPort = makeOrderPort(), inventoryPort = makeInventoryPort(), paymentPort = makePaymentPort();
    const result = await createCommerceRuntimeService({ orderPort, inventoryPort, paymentPort, readinessPort: makeReadinessPort() }).startRuntime({ idempotencyKey: "one-time-example", mode: "one_time", clientId: CLIENT_ID, shippingAddressId: ADDRESS_ID, orderDraft: orderDraftSummary(), paymentProvider: "hidden_rehearsal", providerFlow: "one_time_payment", metadata: {} });
    expect(result.runtime.mode).toBe("one_time");
    expect(inventoryPort.reserveOrderItems).toHaveBeenCalledExactlyOnceWith({ idempotencyKey: "one-time-example:inventory", order: await orderPort.finalizeOrderForCheckout.mock.results[0].value, paymentStatus: "created", metadata: {} });
    expect(paymentPort.createIntent).toHaveBeenCalledWith(expect.objectContaining({ targetKind: "one_time_order", subscriptionId: null, subscriptionCycleId: null }));
    expect(inventoryPort.releaseOrderReservations).not.toHaveBeenCalled();
  });
});
