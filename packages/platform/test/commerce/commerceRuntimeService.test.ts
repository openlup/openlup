import { afterEach, describe, expect, it, vi } from "vitest";
import { createCommerceRuntimeService, makeOrderPort, makeInventoryPort, makePaymentPort, makeReadinessPort, orderDraftSummary, CLIENT_ID, ADDRESS_ID, type ResultRequest } from "./checkoutTestFixtures.js";
afterEach(() => vi.restoreAllMocks());
const start = { idempotencyKey: "runtime-a", mode: "one_time" as const, clientId: CLIENT_ID, shippingAddressId: ADDRESS_ID, orderDraft: orderDraftSummary(), paymentProvider: "hidden_rehearsal" as const, providerFlow: "one_time_payment" as const, metadata: {} };
function ports() { return { orderPort: makeOrderPort(), inventoryPort: makeInventoryPort(), paymentPort: makePaymentPort(), readinessPort: makeReadinessPort() }; }
describe("neutral runtime execution", () => {
  it("retains finalized order and reservation identity across admission contention before dispatch", async () => {
    const f = ports();
    const busy = new Error("inventory_admission_busy");
    f.inventoryPort.reserveOrderItems.mockRejectedValueOnce(busy);
    const execute = vi.fn(async () => ({ provider: "hidden_rehearsal" as const, providerAttemptId: null,
      providerSessionId: null, attemptStatus: "processing" as const, nextActionKind: null, requestPayload: {}, responsePayload: {} }));
    const service = createCommerceRuntimeService({ ...f, executionPort: { execute } });
    await expect(service.startRuntime(start)).rejects.toBe(busy);
    expect(f.paymentPort.createIntent).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(f.inventoryPort.releaseOrderReservations).not.toHaveBeenCalled();
    await service.startRuntime(start);
    expect(f.orderPort.finalizeOrderForCheckout.mock.calls[1]).toEqual(f.orderPort.finalizeOrderForCheckout.mock.calls[0]);
    expect(f.inventoryPort.reserveOrderItems.mock.calls[1]).toEqual(f.inventoryPort.reserveOrderItems.mock.calls[0]);
    expect(f.paymentPort.createIntent).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
  });
  it("resolves execution before every durable write", async () => { const f = ports(); const service = createCommerceRuntimeService({ ...f, resolveExecutionPort: () => { throw new Error("provider_unavailable"); } }); await expect(service.startRuntime(start)).rejects.toThrow("provider_unavailable"); expect(f.orderPort.finalizeOrderForCheckout).not.toHaveBeenCalled(); expect(f.inventoryPort.reserveOrderItems).not.toHaveBeenCalled(); expect(f.paymentPort.createIntent).not.toHaveBeenCalled(); });
  it("uses one finalized order and stable inventory/intent keys", async () => { const f = ports(); const result = await createCommerceRuntimeService(f).startRuntime(start); expect(f.orderPort.finalizeOrderForCheckout).toHaveBeenCalledExactlyOnceWith(start); expect(f.inventoryPort.reserveOrderItems).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: "runtime-a:inventory" })); expect(f.paymentPort.createIntent).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: "runtime-a:payment-intent", targetKind: "one_time_order", subscriptionId: null, subscriptionCycleId: null })); expect(result.runtime.payment).toMatchObject({ provider: "hidden_rehearsal", providerClientSecret: null, continuationActionOrigin: null }); });
  it("forwards host-defined method metadata unchanged to execution", async () => {
    const f = ports();
    const execute = vi.fn(async () => ({ provider: "hidden_rehearsal" as const,
      providerAttemptId: null, providerSessionId: null, attemptStatus: "processing" as const,
      nextActionKind: null, requestPayload: {}, responsePayload: {} }));
    await createCommerceRuntimeService({ ...f, executionPort: { execute } }).startRuntime({
      ...start, paymentMethodRef: "opaque-method", paymentMethodAliasType: "stored_reference",
      paymentMethodRecurringModel: "subsequent",
    });
    expect(execute).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      paymentMethodRef: "opaque-method", paymentMethodAliasType: "stored_reference",
      paymentMethodRecurringModel: "subsequent",
    }));
  });
  it.each(["failed", "expired"])("releases only a terminal %s result and skips readiness", async resultStatus => { const f = ports(); f.paymentPort.applyResult.mockResolvedValueOnce({ paymentIntentId: ADDRESS_ID, paymentId: ADDRESS_ID, paymentAttemptId: ADDRESS_ID, orderId: CLIENT_ID, status: resultStatus, kind: "applied", replayed: false }); const result = await createCommerceRuntimeService(f).applyPaymentResult({ idempotencyKey: "result-a", orderId: CLIENT_ID, paymentIntentId: ADDRESS_ID, resultStatus }); expect(f.inventoryPort.releaseOrderReservations).toHaveBeenCalledExactlyOnceWith({ idempotencyKey: "result-a:inventory-release", orderId: CLIENT_ID, reason: `payment_${resultStatus}` }); expect(f.readinessPort.evaluateOrderReadiness).not.toHaveBeenCalled(); expect(result.reservationRelease).toEqual({ attempted: true, releasedCount: 1 }); expect(result.readiness).toBeNull(); });
  it("preserves a recoverable decline and refuses another order before inventory/readiness", async () => { const f = ports(); f.paymentPort.applyResult.mockResolvedValueOnce({ paymentIntentId: ADDRESS_ID, paymentId: ADDRESS_ID, paymentAttemptId: ADDRESS_ID, orderId: CLIENT_ID, status: "failed", kind: "recoverable_decline", replayed: false }); const req: ResultRequest = { idempotencyKey: "result-a", orderId: CLIENT_ID, paymentIntentId: ADDRESS_ID, resultStatus: "failed" }; const service = createCommerceRuntimeService(f); expect((await service.applyPaymentResult(req)).reservationRelease).toEqual({ attempted: false, releasedCount: 0 }); expect(f.inventoryPort.releaseOrderReservations).not.toHaveBeenCalled(); f.readinessPort.evaluateOrderReadiness.mockClear(); f.paymentPort.applyResult.mockResolvedValueOnce({ paymentIntentId: ADDRESS_ID, paymentId: ADDRESS_ID, paymentAttemptId: ADDRESS_ID, orderId: ADDRESS_ID, status: "failed", kind: "applied", replayed: false }); await expect(service.applyPaymentResult(req)).rejects.toMatchObject({ name: "CommerceRuntimeConflictError", details: { requestOrderId: CLIENT_ID, paymentResultOrderId: ADDRESS_ID } }); expect(f.inventoryPort.releaseOrderReservations).not.toHaveBeenCalled(); expect(f.readinessPort.evaluateOrderReadiness).not.toHaveBeenCalled(); });
});
