import { describe, expect, it, vi } from "vitest";
import { createCommerceRuntimeService, makeOrderPort, makeInventoryPort, makePaymentPort, makeReadinessPort, orderDraftSummary, CLIENT_ID, ADDRESS_ID } from "./checkoutTestFixtures.js";
describe("runtime decline continuation", () => {
  it.each([0, 2])("settles only failed with attempt sequence %s and retains the order reservation", async paymentAttemptSequence => {
    const paymentPort = makePaymentPort(), inventoryPort = makeInventoryPort(); paymentPort.applyResult.mockResolvedValueOnce({ paymentIntentId: ADDRESS_ID, paymentId: ADDRESS_ID, paymentAttemptId: ADDRESS_ID, orderId: CLIENT_ID, status: "failed", kind: "recoverable_decline", replayed: false });
    const execute = vi.fn(async () => ({ provider: "redirect" as const, providerAttemptId: null, providerSessionId: null, attemptStatus: "processing" as const, nextActionKind: null, requestPayload: {}, responsePayload: {}, providerDecline: { code: "declined", mandateUnsupported: true } }));
    const result = await createCommerceRuntimeService({ orderPort: makeOrderPort(), inventoryPort, paymentPort, readinessPort: makeReadinessPort(), executionPort: { execute } }).startRuntime({ idempotencyKey: "runtime-a", paymentAttemptSequence, mode: "one_time", clientId: CLIENT_ID, shippingAddressId: ADDRESS_ID, orderDraft: orderDraftSummary(), paymentProvider: "redirect", providerFlow: "one_time_payment", metadata: {} });
    expect(paymentPort.applyResult).toHaveBeenCalledOnce(); expect(paymentPort.applyResult).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: `runtime-a:payment-execution${paymentAttemptSequence ? ":attempt:2" : ""}:payment-declined`, resultStatus: "failed" })); expect(result.runtime.payment).toMatchObject({ status: "failed", attemptStatus: "failed" }); expect(inventoryPort.releaseOrderReservations).not.toHaveBeenCalled();
  });
});
