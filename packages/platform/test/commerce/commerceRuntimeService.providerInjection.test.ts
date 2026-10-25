import { afterEach, describe, expect, it, vi } from "vitest";
import { runtimeBindings, createCommerceRuntimeService, makeOrderPort, makeInventoryPort, makePaymentPort, makeReadinessPort, orderDraftSummary, CLIENT_ID, ADDRESS_ID } from "./checkoutTestFixtures.js";
afterEach(() => vi.restoreAllMocks());
describe("runtime injected execution authority", () => {
  it("passes existing execution/control capabilities by identity, keeps advisory data outside the provider call and preserves the sequence dialect", async () => {
    const prepared = vi.spyOn(runtimeBindings, "executePreparedProviderAttempt"), resolvePrepared = vi.spyOn(runtimeBindings, "preparedProviderAttemptPort"), uncertainty = vi.spyOn(runtimeBindings, "preserveProviderDispatchUncertainty");
    const execute = vi.fn(async () => ({ provider: "embedded" as const, providerAttemptId: "attempt-a", providerSessionId: "session-a", attemptStatus: "requires_action" as const, nextActionKind: "3ds_challenge", clientSecret: "synthetic-secret", requestPayload: {}, responsePayload: {} }));
    const paymentPort = makePaymentPort(), executionPort = { execute }, resolveExecutionPort = vi.fn(() => executionPort);
    const request = { idempotencyKey: "runtime-a", mode: "one_time" as const, clientId: CLIENT_ID, shippingAddressId: ADDRESS_ID, orderDraft: orderDraftSummary(), paymentProvider: "embedded" as const, providerFlow: "one_time_payment" as const, metadata: {}, declaredBankId: "issuer-a" };
    const service = createCommerceRuntimeService({ orderPort: makeOrderPort(), inventoryPort: makeInventoryPort(), paymentPort, readinessPort: makeReadinessPort(), resolveExecutionPort });
    const first = await service.startRuntime(request); await service.startRuntime({ ...request, paymentAttemptSequence: 2 });
    expect(resolveExecutionPort).toHaveBeenCalledWith("embedded"); expect(resolvePrepared).toHaveBeenCalledWith(paymentPort, "embedded");
    expect(prepared).toHaveBeenNthCalledWith(1, expect.objectContaining({ paymentPort, executionPort, prepareIdempotencyKey: "runtime-a:payment-execution:prepare-attempt", finalizeIdempotencyKey: "runtime-a:payment-execution:finalize-attempt", prepareRequestPayload: expect.objectContaining({ declaredBankId: "issuer-a" }) }));
    expect(prepared).toHaveBeenNthCalledWith(2, expect.objectContaining({ prepareIdempotencyKey: "runtime-a:payment-execution:attempt:2:prepare-attempt" }));
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ providerFlow: "one_time_payment" })); expect(JSON.stringify(execute.mock.calls)).not.toContain("declaredBankId"); expect(paymentPort.recordAttempt).not.toHaveBeenCalled(); expect(uncertainty).toHaveBeenCalledTimes(2); expect(first.runtime.payment).toMatchObject({ provider: "embedded", providerClientSecret: "synthetic-secret", continuationActionOrigin: "fresh_execution" });
  });
});
