import { afterEach, describe, expect, it, vi } from "vitest";
import { createManagedInventoryReservationPort } from "./inventoryReservationPort.js";
import {
  CommerceRuntimePersistenceError,
  type FinalizedCheckoutOrder,
} from "../../../../src/domains/commerce/runtimePorts.js";

const STOCK_AUTHORITY = "omnipack";
const MIXED_CASE_STOCK_AUTHORITY = "OmniPack";

describe("createManagedInventoryReservationPort", () => {
  const originalTtl = process.env.COMMERCE_CHECKOUT_RESERVATION_TTL_MINUTES;

  afterEach(() => {
    if (originalTtl === undefined) delete process.env.COMMERCE_CHECKOUT_RESERVATION_TTL_MINUTES;
    else process.env.COMMERCE_CHECKOUT_RESERVATION_TTL_MINUTES = originalTtl;
    vi.restoreAllMocks();
  });

  it("passes a product-agnostic expiry for checkout payment-window reservations", async () => {
    const rpc = vi.fn(async () => ({
      data: batchReservationData(order({ mode: "one_time", subscriptionCycleId: null })),
      error: null,
    }));
    const port = createManagedInventoryReservationPort(
      { rpc, from: vi.fn() as never },
      { now: () => new Date("2026-06-16T10:00:00.000Z"), checkoutReservationTtlMinutes: 1440 },
    );

    await port.reserveOrderItems({
      idempotencyKey: "reserve-1",
      order: order({ mode: "one_time", subscriptionCycleId: null }),
      paymentStatus: "created",
    });

    expect(rpc).toHaveBeenCalledWith("inventory_reserve_order_items", expect.objectContaining({
      p_kind: "checkout_payment_window",
      p_expires_at: "2026-06-17T10:00:00.000Z",
      p_provider_kind: null,
      p_items: [{
        orderItemId: "44444444-4444-4444-8444-444444444444",
        skuId: "55555555-5555-4555-8555-555555555555",
        quantity: 1,
      }],
    }));
    expect(JSON.stringify(rpc.mock.calls)).not.toContain("DEPLOYMENT-SKU");
  });

  it("passes the configured authority key so inventory can use external stock-master reservations", async () => {
    const rpc = vi.fn(async () => ({
      data: batchReservationData(order({ mode: "one_time", subscriptionCycleId: null })),
      error: null,
    }));
    const port = createManagedInventoryReservationPort(
      { rpc, from: vi.fn() as never },
      { now: () => new Date("2026-06-16T10:00:00.000Z"), checkoutReservationTtlMinutes: 1440 },
    );

    await port.reserveOrderItems({
      idempotencyKey: "reserve-1",
      order: order({ mode: "one_time", subscriptionCycleId: null }),
      paymentStatus: "created",
      metadata: {
        selectedDelivery: {
          providerKind: MIXED_CASE_STOCK_AUTHORITY,
          carrierCode: "DPD kurier",
          serviceCode: "DPD kurier",
        },
      },
    });

    expect(rpc).toHaveBeenCalledWith("inventory_reserve_order_items", expect.objectContaining({
      p_provider_kind: STOCK_AUTHORITY,
      p_metadata: expect.objectContaining({
        source: "commerce.runtime.hidden.v0",
        providerKind: STOCK_AUTHORITY,
        stockAuthority: "external_stock_master_with_local_reservations",
      }),
    }));
  });

  it("retries the legacy reservation RPC in preview when the provider-aware signature is not deployed yet", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({
        data: null,
        error: {
          code: "PGRST202",
          message: "Could not find the function public.inventory_reserve_order in the schema cache",
        },
      })
      .mockResolvedValueOnce({
        data: null,
        error: {
          code: "PGRST202",
          message: "Could not find the function public.inventory_reserve_order in the schema cache",
        },
      })
      .mockResolvedValueOnce({
        data: { reservationId: "77777777-7777-4777-8777-777777777777", reservationIds: ["77777777-7777-4777-8777-777777777777"] },
        error: null,
      });
    const port = createManagedInventoryReservationPort(
      { rpc, from: vi.fn() as never },
      {
        now: () => new Date("2026-06-16T10:00:00.000Z"),
        checkoutReservationTtlMinutes: 1440,
        legacySchemaFallback: { enabled: true, environmentLabel: "preview" },
      },
    );

    await port.reserveOrderItems({
      idempotencyKey: "reserve-1",
      order: order({ mode: "one_time", subscriptionCycleId: null }),
      paymentStatus: "created",
      metadata: {
        selectedDelivery: {
          providerKind: MIXED_CASE_STOCK_AUTHORITY,
          carrierCode: "DPD kurier",
          serviceCode: "DPD kurier",
        },
      },
    });

    expect(rpc).toHaveBeenCalledTimes(3);
    expect(rpc.mock.calls[0]?.[0]).toBe("inventory_reserve_order_items");
    expect(rpc.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ p_provider_kind: STOCK_AUTHORITY }));
    expect(rpc.mock.calls[1]?.[0]).toBe("inventory_reserve_order");
    expect(rpc.mock.calls[1]?.[1]).toEqual(expect.objectContaining({ p_provider_kind: STOCK_AUTHORITY }));
    expect(rpc.mock.calls[2]?.[1]).not.toHaveProperty("p_provider_kind");
    expect(rpc.mock.calls[2]?.[1]).toEqual(expect.objectContaining({
      p_metadata: {
        source: "commerce.runtime.hidden.v0",
        schemaFallback: "legacy_inventory_reserve_order_without_provider_kind",
      },
    }));
    expect(JSON.stringify(rpc.mock.calls[2]?.[1])).not.toContain("external_stock_master_with_local_reservations");
    expect(warn).toHaveBeenCalledWith(
      "inventory_reserve_order_items_schema_fallback",
      expect.stringContaining(`"providerKind":"${STOCK_AUTHORITY}"`),
    );
    expect(warn).toHaveBeenCalledWith(
      "inventory_reserve_order_items_schema_fallback",
      expect.stringContaining("\"environment\":\"preview\""),
    );
    expect(warn).toHaveBeenCalledWith(
      "inventory_reserve_order_provider_kind_schema_fallback",
      expect.stringContaining(`"providerKind":"${STOCK_AUTHORITY}"`),
    );
  });

  it("does not retry the legacy reservation RPC in production", async () => {
    const rpc = vi.fn(async () => ({
      data: null,
      error: {
        code: "PGRST202",
        message: "Could not find the function public.inventory_reserve_order in the schema cache",
      },
    }));
    const port = createManagedInventoryReservationPort(
      { rpc, from: vi.fn() as never },
      {
        now: () => new Date("2026-06-16T10:00:00.000Z"),
        checkoutReservationTtlMinutes: 1440,
        legacySchemaFallback: { enabled: false, environmentLabel: "production" },
      },
    );

    await expect(port.reserveOrderItems({
      idempotencyKey: "reserve-1",
      order: order({ mode: "one_time", subscriptionCycleId: null }),
      paymentStatus: "created",
      metadata: { selectedDelivery: { providerKind: STOCK_AUTHORITY } },
    })).rejects.toMatchObject({ name: "CommerceRuntimePersistenceError" });

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("inventory_reserve_order_items", expect.any(Object));
  });

  it("leaves subscription retry-window reservations without checkout expiry", async () => {
    const rpc = vi.fn(async () => ({
      data: batchReservationData(order({
        mode: "subscription_cycle",
        subscriptionCycleId: "33333333-3333-4333-8333-333333333334",
      })),
      error: null,
    }));
    const port = createManagedInventoryReservationPort(
      { rpc, from: vi.fn() as never },
      { now: () => new Date("2026-06-16T10:00:00.000Z"), checkoutReservationTtlMinutes: 1440 },
    );

    await port.reserveOrderItems({
      idempotencyKey: "reserve-1",
      order: order({
        mode: "subscription_cycle",
        subscriptionCycleId: "33333333-3333-4333-8333-333333333334",
      }),
      paymentStatus: "created",
    });

    expect(rpc).toHaveBeenCalledWith("inventory_reserve_order_items", expect.objectContaining({
      p_kind: "subscription_retry_window",
      p_expires_at: null,
    }));
  });

  // The two order-cancelling RPCs now live in
  // server/adapters/supabase/commerce/checkoutCompensation.ts, which keeps their
  // exact argument objects under characterization there. What this module still
  // owns is the wiring: forward the caller's input verbatim to the injected
  // adapter, return its answer unchanged, and refuse to pretend a compensation
  // ran when no adapter was composed.
  it("forwards abandoned-order cancellation verbatim to the injected compensation adapter", async () => {
    const cancelAbandonedOrder = vi.fn(async () => ({ cancelled: true }));
    const port = createManagedInventoryReservationPort(
      { rpc: vi.fn() as never, from: vi.fn() as never },
      {
        compensation: {
          cancelAbandonedOrder,
          cancelUnstartedPromotionOrder: vi.fn(async () => ({ cancelled: false })),
        },
      },
    );

    const input = {
      idempotencyKey: "intent-2026-06-05-rex",
      orderId: "11111111-1111-4111-8111-111111111111",
      reason: "checkout_stock_unavailable",
    };
    await expect(port.cancelAbandonedOrder(input)).resolves.toEqual({ cancelled: true });
    expect(cancelAbandonedOrder).toHaveBeenCalledWith(input);
  });

  it("forwards promotion-order cancellation verbatim and returns cancelled=false unchanged", async () => {
    const cancelUnstartedPromotionOrder = vi.fn(async () => ({ cancelled: false }));
    const port = createManagedInventoryReservationPort(
      { rpc: vi.fn() as never, from: vi.fn() as never },
      {
        compensation: {
          cancelAbandonedOrder: vi.fn(async () => ({ cancelled: true })),
          cancelUnstartedPromotionOrder,
        },
      },
    );

    const input = {
      idempotencyKey: "intent-2026-06-05-rex",
      orderId: "11111111-1111-4111-8111-111111111111",
      reason: "checkout_orchestration_failed_before_runtime",
    };
    await expect(port.cancelUnstartedPromotionOrder(input)).resolves.toEqual({ cancelled: false });
    expect(cancelUnstartedPromotionOrder).toHaveBeenCalledWith(input);
  });

  it("fails closed when a composition wires it as the compensation port without an adapter", async () => {
    const port = createManagedInventoryReservationPort({ rpc: vi.fn() as never, from: vi.fn() as never });

    await expect(port.cancelAbandonedOrder({
      idempotencyKey: "intent-2026-06-05-rex",
      orderId: "11111111-1111-4111-8111-111111111111",
      reason: "checkout_stock_unavailable",
    })).rejects.toBeInstanceOf(CommerceRuntimePersistenceError);
    await expect(port.cancelUnstartedPromotionOrder({
      idempotencyKey: "intent-2026-06-05-rex",
      orderId: "11111111-1111-4111-8111-111111111111",
      reason: "checkout_orchestration_failed_before_runtime",
    })).rejects.toBeInstanceOf(CommerceRuntimePersistenceError);
  });
});

function batchReservationData(input: FinalizedCheckoutOrder) {
  return {
    reservations: input.items.map((item) => ({
      orderItemId: item.orderItemId,
      reservationId: "77777777-7777-4777-8777-777777777777",
      reservationIds: ["77777777-7777-4777-8777-777777777777"],
      replayed: false,
    })),
  };
}

function order(input: {
  mode: FinalizedCheckoutOrder["mode"];
  subscriptionCycleId: string | null;
}): FinalizedCheckoutOrder {
  return {
    orderId: "11111111-1111-4111-8111-111111111111",
    orderRef: "order_11111111-1111-4111-8111-111111111111",
    mode: input.mode,
    clientId: "22222222-2222-4222-8222-222222222222",
    petId: null,
    shippingAddressId: "33333333-3333-4333-8333-333333333333",
    subscriptionId: input.mode === "subscription_cycle" ? "33333333-3333-4333-8333-333333333333" : null,
    subscriptionCycleId: input.subscriptionCycleId,
    total: { amountMinor: 1490, currency: "PLN" },
    items: [{
      orderItemId: "44444444-4444-4444-8444-444444444444",
      skuId: "55555555-5555-4555-8555-555555555555",
      sku: "GENERIC-SKU",
      quantity: 1,
    }],
    replayed: false,
  };
}
