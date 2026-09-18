import { describe, expect, it, vi } from "vitest";
import { buildStartedRuntimeResponse } from "./commerceRuntimeStartResponse.js";

type Input = Parameters<typeof buildStartedRuntimeResponse>[0];

describe("started runtime response", () => {
  it("durably closes a synchronous decline before returning the validated runtime", async () => {
    const readiness = { omsEligibility: { allowed: false, reason: "order_not_paid" }, fulfillmentCreate: { allowed: false, reason: "order_not_paid", omsReason: "order_not_paid" } } satisfies Awaited<ReturnType<Input["readinessPort"]["evaluateOrderReadiness"]>>;
    const applyResult = vi.fn<Input["paymentPort"]["applyResult"]>(async () => ({ paymentIntentId: "88888888-8888-4888-8888-888888888888", paymentAttemptId: "55555555-5555-4555-8555-555555555555", paymentId: "99999999-9999-4999-8999-999999999999", orderId: "11111111-1111-4111-8111-111111111111", status: "failed", kind: "recoverable_decline", replayed: false }));
    const evaluateOrderReadiness = vi.fn<Input["readinessPort"]["evaluateOrderReadiness"]>(async () => readiness);
    const paymentPort: Pick<Input["paymentPort"], "applyResult"> = { applyResult };
    const input = {
      paymentExecutionIdempotencyKey: "runtime-key", continuationActionOrigin: "fresh_execution", paymentPort: paymentPort as Input["paymentPort"], readinessPort: { evaluateOrderReadiness },
      order: { orderId: "11111111-1111-4111-8111-111111111111", orderRef: "order_11111111-1111-4111-8111-111111111111", mode: "one_time", clientId: "22222222-2222-4222-8222-222222222222", petId: null, shippingAddressId: "33333333-3333-4333-8333-333333333333", subscriptionId: null, subscriptionCycleId: null, total: { amountMinor: 1490, currency: "PLN" }, items: [{ orderItemId: "44444444-4444-4444-8444-444444444444", skuId: "66666666-6666-4666-8666-666666666666", sku: "CORE", quantity: 1 }], replayed: false },
      reservations: [{ reservationId: "77777777-7777-4777-8777-777777777777", reservationIds: ["77777777-7777-4777-8777-777777777777"], orderItemId: "44444444-4444-4444-8444-444444444444", skuId: "66666666-6666-4666-8666-666666666666", sku: "CORE", status: "reserved", replayed: false }],
      intent: { paymentIntentId: "88888888-8888-4888-8888-888888888888", paymentId: "99999999-9999-4999-8999-999999999999", status: "created" }, execution: { provider: "tpay", providerAttemptId: "provider-attempt", providerSessionId: null, attemptStatus: "processing", nextActionKind: null, requestPayload: {}, responsePayload: {}, providerDecline: { code: "payment_failed", mandateUnsupported: false } }, attempt: { paymentAttemptId: "fallback", status: "processing" },
    } satisfies Input;
    const response = await buildStartedRuntimeResponse(input);

    expect(applyResult).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: "runtime-key:payment-declined", resultStatus: "failed", failureReason: "provider_declined" }));
    expect(response.runtime.payment).toMatchObject({ paymentIntentId: "88888888-8888-4888-8888-888888888888", paymentAttemptId: "55555555-5555-4555-8555-555555555555", status: "failed", attemptStatus: "failed", provider: "tpay" });
    expect(evaluateOrderReadiness).toHaveBeenCalledWith(expect.objectContaining({ orderId: "11111111-1111-4111-8111-111111111111" }));
    expect(applyResult.mock.invocationCallOrder[0]!).toBeLessThan(evaluateOrderReadiness.mock.invocationCallOrder[0]!);
    expect(response.runtime.readiness).toEqual(readiness);
    expect(response.runtime.payment.continuationActionOrigin).toBe("fresh_execution");
  });
});
