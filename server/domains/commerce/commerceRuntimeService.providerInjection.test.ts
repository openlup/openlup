import { describe, expect, it, vi } from "vitest";
import { createCommerceRuntimeService } from "./commerceRuntimeService.js";
import {
  makeInventoryPort,
  makeOrderPort,
  makePaymentPort,
  makeReadinessPort,
  orderDraftSummary,
} from "./commerceRuntimeService.fixtures.js";

describe("commerce runtime service — provider injection (W11.7)", () => {
  it("forwards providerFlow to the execution port and propagates clientSecret to the response", async () => {
    const execute = vi.fn().mockResolvedValue({
      provider: "stripe",
      providerAttemptId: "pi_real_1",
      providerSessionId: "pi_real_1",
      attemptStatus: "requires_action",
      nextActionKind: "3ds_challenge",
      clientSecret: "pi_real_1_secret_zzz",
      customerProviderRef: null,
      paymentMethodRef: null,
      webhookExpected: true,
      requestPayload: { providerFlow: "one_time_payment" },
      responsePayload: { providerStatus: "requires_action" },
    });
    const resolveExecutionPort = vi.fn().mockReturnValue({ execute });
    const paymentPort = makePaymentPort();

    const service = createCommerceRuntimeService({
      orderPort: makeOrderPort(),
      inventoryPort: makeInventoryPort(),
      paymentPort,
      readinessPort: makeReadinessPort(),
      resolveExecutionPort,
    });

    const response = await service.startRuntime({
      idempotencyKey: "wave-a-stripe",
      mode: "one_time",
      clientId: "22222222-2222-4222-8222-222222222222",
      shippingAddressId: "33333333-3333-4333-8333-333333333333",
      orderDraft: orderDraftSummary(),
      paymentProvider: "stripe",
      providerFlow: "one_time_payment",
      // Advisory issuer declaration. Recorded beside the execution rather than
      // inside it, so it reaches the audit record even on a rail that never
      // collects one — and cannot ride into the provider call.
      declaredBankId: "ing",
      metadata: {},
    });

    expect(resolveExecutionPort).toHaveBeenCalledWith("stripe");
    expect(paymentPort.prepareProviderAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: "wave-a-stripe:payment-execution:prepare-attempt",
        provider: "stripe",
        requestPayload: expect.objectContaining({ declaredBankId: "ing" }),
      }),
    );
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ providerFlow: "one_time_payment" }),
    );
    expect(JSON.stringify(execute.mock.calls[0])).not.toContain("declaredBankId");
    expect(paymentPort.finalizeProviderAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: "wave-a-stripe:payment-execution:finalize-attempt",
        paymentAttemptId: "55555555-5555-4555-8555-555555555555",
        attemptStatus: "requires_action",
      }),
    );
    expect(paymentPort.recordAttempt).not.toHaveBeenCalled();
    expect(paymentPort.prepareProviderAttempt.mock.invocationCallOrder[0]).toBeLessThan(
      execute.mock.invocationCallOrder[0],
    );
    expect(execute.mock.invocationCallOrder[0]).toBeLessThan(
      paymentPort.finalizeProviderAttempt.mock.invocationCallOrder[0],
    );
    expect(response.runtime.payment.provider).toBe("stripe");
    expect(response.runtime.payment.providerClientSecret).toBe("pi_real_1_secret_zzz");
    expect(response.runtime.payment.continuationActionOrigin).toBe("fresh_execution");
  });

  it("propagates null clientSecret when the adapter does not provide one", async () => {
    const execute = vi.fn().mockResolvedValue({
      provider: "hidden_rehearsal",
      providerAttemptId: null,
      providerSessionId: null,
      attemptStatus: "processing",
      nextActionKind: null,
      requestPayload: {},
      responsePayload: { providerCall: false },
    });

    const service = createCommerceRuntimeService({
      orderPort: makeOrderPort(),
      inventoryPort: makeInventoryPort(),
      paymentPort: makePaymentPort(),
      readinessPort: makeReadinessPort(),
      executionPort: { execute },
    });

    const response = await service.startRuntime({
      idempotencyKey: "wave-a-noop",
      mode: "one_time",
      clientId: "22222222-2222-4222-8222-222222222222",
      shippingAddressId: "33333333-3333-4333-8333-333333333333",
      orderDraft: orderDraftSummary(),
      paymentProvider: "hidden_rehearsal",
      providerFlow: "one_time_payment",
      metadata: {},
    });

    expect(response.runtime.payment.providerClientSecret).toBeNull();
    expect(response.runtime.payment.continuationActionOrigin).toBeNull();
  });

});
