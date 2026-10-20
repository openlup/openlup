import { describe, expect, it, vi } from "vitest";
import { createManagedInventoryReservationPort } from "../../../server/adapters/managed/commerce/inventoryReservationPort.js";
import { createCommerceRuntimeService } from "../../../server/domains/commerce/commerceRuntimeService.js";
import { makeOrderPort, makePaymentPort, makeReadinessPort, orderDraftSummary } from "../../../server/domains/commerce/commerceRuntimeService.fixtures.js";

const AT = "2026-10-20T10:00:00.000Z";
function setup(error: { code: string; message: string } | null = null) {
  const orderPort = makeOrderPort();
  const rpc = vi.fn(async (name: string) => ({ data: name === "inventory_reserve_order_items" ? { reservations: [{
    orderItemId: "44444444-4444-4444-8444-444444444444", reservationId: "77777777-7777-4777-8777-777777777777", reservationIds: ["77777777-7777-4777-8777-777777777777"], replayed: true,
  }] } : {}, error }));
  const query = { select: vi.fn(), eq: vi.fn(), then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: [{ id: "77777777-7777-4777-8777-777777777777" }], error: null }).then(resolve) };
  query.select.mockReturnValue(query); query.eq.mockReturnValue(query);
  const from = vi.fn(() => query);
  const cancelAbandonedOrder = vi.fn(async () => ({ cancelled: true }));
  const inventory = createManagedInventoryReservationPort({ rpc, from } as never, {
    now: () => new Date(AT), checkoutReservationTtlMinutes: 1,
    legacySchemaFallback: { enabled: true, environmentLabel: "test" },
    compensation: { cancelAbandonedOrder, cancelUnstartedPromotionOrder: vi.fn() },
  });
  const paymentPort = makePaymentPort();
  const execute = vi.fn(async () => ({ provider: "hidden_rehearsal", providerAttemptId: "attempt", providerSessionId: null,
    attemptStatus: "processing", nextActionKind: null, requestPayload: {}, responsePayload: {} }));
  const service = createCommerceRuntimeService({ orderPort, inventoryPort: inventory, paymentPort,
    readinessPort: makeReadinessPort(), resolveExecutionPort: () => ({ execute }) } as never);
  return { rpc, from, query, inventory, cancelAbandonedOrder, orderPort, paymentPort, execute, service };
}
const input = () => ({ idempotencyKey: "original-checkout", mode: "one_time" as const,
  clientId: "22222222-2222-4222-8222-222222222222", shippingAddressId: "33333333-3333-4333-8333-333333333333",
  orderDraft: orderDraftSummary(), paymentProvider: "hidden_rehearsal" as const, providerFlow: "one_time_payment" as const,
  paymentExecution: { provider: "hidden_rehearsal" as const }, metadata: {} });

describe("W2 runtime → managed reservation lifecycle", () => {
  it("carries policy, original identity and decoded replay through the real runtime before payment", async () => {
    const f = setup();
    await f.service.startRuntime(input());
    expect(f.rpc).toHaveBeenCalledExactlyOnceWith("inventory_reserve_order_items", expect.objectContaining({
      p_idempotency_key: "original-checkout:inventory", p_kind: "checkout_payment_window",
      p_expires_at: "2026-10-21T10:00:00.000Z", p_items: [{ orderItemId: "44444444-4444-4444-8444-444444444444",
        skuId: "66666666-6666-4666-8666-666666666666", quantity: 1 }],
    }));
    expect(f.rpc.mock.invocationCallOrder[0]).toBeLessThan(f.paymentPort.createIntent.mock.invocationCallOrder[0]!);
    expect(f.execute).toHaveBeenCalledOnce();
    const finalized = await f.orderPort.finalizeOrderForCheckout({} as never);
    expect(await f.inventory.reserveOrderItems({ idempotencyKey: "original-checkout:inventory", order: finalized, paymentStatus: "created" }))
      .toEqual([{ reservationId: "77777777-7777-4777-8777-777777777777", reservationIds: ["77777777-7777-4777-8777-777777777777"], orderItemId: finalized.items[0].orderItemId,
        skuId: finalized.items[0].skuId, sku: finalized.items[0].sku, status: "reserved", replayed: true }]);
  });
  it.each([{ code: "55P03", message: "inventory_admission_busy" }, { code: "23505", message: "inventory_insufficient" }])(
    "refuses payment after actual adapter refusal without legacy item fallback: $code", async error => {
      const f = setup(error);
      await expect(f.service.startRuntime(input())).rejects.toMatchObject({ name: error.code === "55P03" ? "CommerceRuntimePersistenceError" : "CommerceRuntimeConflictError" });
      expect(f.rpc.mock.calls.map(([name]) => name)).toEqual(["inventory_reserve_order_items"]);
      expect(f.paymentPort.createIntent).not.toHaveBeenCalled();
      expect(f.execute).not.toHaveBeenCalled();
    },
  );
  it("releases only selected reserved rows with stable suffixes, then forwards compensation unchanged", async () => {
    const f = setup();
    expect(await f.inventory.releaseOrderReservations({ idempotencyKey: "release-original", orderId: "order-a", reason: "abandoned" }))
      .toEqual({ releasedCount: 1 });
    expect(f.query.eq.mock.calls).toEqual([["order_id", "order-a"], ["status", "reserved"]]);
    expect(f.rpc).toHaveBeenCalledExactlyOnceWith("inventory_release_reservation", {
      p_idempotency_key: "release-original:77777777-7777-4777-8777-777777777777", p_reservation_id: "77777777-7777-4777-8777-777777777777", p_reason: "abandoned",
      p_metadata: { source: "commerce.runtime.hidden.v0" },
    });
    const request = { idempotencyKey: "cancel-original", orderId: "order-a", reason: "abandoned" };
    expect(await f.inventory.cancelAbandonedOrder(request)).toEqual({ cancelled: true });
    expect(f.cancelAbandonedOrder).toHaveBeenCalledExactlyOnceWith(request);
  });
});
