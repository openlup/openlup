import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createRuntimeStartResponse } from "../../src/commerce/server/index.js";
import { makeOrderPort, makeInventoryPort, makePaymentPort, makeReadinessPort, type RuntimeResponse, type RuntimeRequest } from "./checkoutTestFixtures.js";
describe("started runtime response", () => {
  it("awaits the injected decline finalizer before readiness and preserves its result", async () => {
    const orderPort = makeOrderPort(), inventoryPort = makeInventoryPort(), paymentPort = makePaymentPort(), readinessPort = makeReadinessPort();
    const order = await orderPort.finalizeOrderForCheckout({} as RuntimeRequest);
    const finalize = vi.fn(async () => ({ paymentAttemptId: "settled-attempt", status: "failed" }));
    const core = createRuntimeStartResponse({ contractVersion: "commerce.v0", responseSchema: z.custom<RuntimeResponse>(), runtimeResponseExtension: () => ({ opaqueExtension: "preserved" }), finalizeDeclinedAttempt: finalize });
    const response = await core.buildStartedRuntimeResponse({ paymentExecutionIdempotencyKey: "runtime-key", continuationActionOrigin: "fresh_execution", paymentPort, readinessPort, order, reservations: await inventoryPort.reserveOrderItems(), intent: { paymentIntentId: "intent-a", paymentId: "payment-a", status: "created" }, execution: { provider: "redirect", providerAttemptId: "provider-attempt", providerSessionId: null, attemptStatus: "processing", nextActionKind: null, requestPayload: {}, responsePayload: {}, providerDecline: { code: "payment_failed", mandateUnsupported: false } }, attempt: { paymentAttemptId: "fallback", status: "processing" } });
    expect(finalize).toHaveBeenCalledExactlyOnceWith(paymentPort, { idempotencyKey: "runtime-key:payment-declined", orderId: order.orderId, paymentIntentId: "intent-a", fallbackAttemptId: "fallback", decline: { code: "payment_failed", mandateUnsupported: false } });
    expect(response.runtime.payment).toMatchObject({ paymentIntentId: "intent-a", paymentAttemptId: "settled-attempt", status: "failed", attemptStatus: "failed", provider: "redirect" });
    expect(readinessPort.evaluateOrderReadiness).toHaveBeenCalledWith({ orderId: order.orderId, fallbackOrderItemCount: 1, allOrderItemsHaveSku: true });
    expect(finalize.mock.invocationCallOrder[0]).toBeLessThan(readinessPort.evaluateOrderReadiness.mock.invocationCallOrder[0]);
    expect(response.runtime.readiness).toEqual(await readinessPort.evaluateOrderReadiness.mock.results[0].value);
    expect(response.runtime.payment.continuationActionOrigin).toBe("fresh_execution");
    expect(response.runtime).toHaveProperty("opaqueExtension", "preserved");
  });
});
