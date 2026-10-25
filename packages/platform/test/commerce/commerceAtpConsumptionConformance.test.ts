import { describe, expect, it } from "vitest";
import { createCommerceRuntimeService, makeOrderPort, makeInventoryPort, makePaymentPort, makeReadinessPort, orderDraftSummary, CLIENT_ID, ADDRESS_ID } from "./checkoutTestFixtures.js";
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
