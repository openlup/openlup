import { describe, expect, it, vi } from "vitest";
import { createCommerceRuntimeService } from "./commerceRuntimeService.js";
import {
  makeInventoryPort,
  makeOrderPort,
  makePaymentPort,
  makeReadinessPort,
  orderDraftSummary,
} from "./commerceRuntimeService.fixtures.js";
import {
  ProviderAttemptExecutionError,
  ProviderAttemptInFlightError,
  ProviderAttemptPostDispatchError,
  ProviderAttemptPreDispatchError,
} from "../../shared/preparedProviderAttempt.js";
import { isRetryableAttemptStatus } from "@openlup/core/payment";

const PROVIDER_REFUSAL = {
  phase: "response_decode",
  code: "tpay_request_refused",
  dispatchState: "refused",
} as const;

function tpaySubmit(idempotencyKey: string) {
  return {
    idempotencyKey,
    mode: "one_time" as const,
    clientId: "22222222-2222-4222-8222-222222222222",
    shippingAddressId: "33333333-3333-4333-8333-333333333333",
    orderDraft: orderDraftSummary(),
    paymentProvider: "tpay" as const,
    providerFlow: "blik_one_time" as const,
    paymentExecution: { provider: "tpay" as const, flow: "blik_one_time" as const, blikToken: "123456" },
    metadata: {},
  };
}

describe("commerce runtime service", () => {
  it("resolves explicit provider execution before finalizing an order or creating a payment intent", async () => {
    const orderPort = { finalizeOrderForCheckout: vi.fn() };
    const inventoryPort = {
      reserveOrderItems: vi.fn(),
      releaseOrderReservations: vi.fn(),
    };
    const paymentPort = {
      createIntent: vi.fn(),
      recordAttempt: vi.fn(),
      applyResult: vi.fn(),
    };
    const readinessPort = { evaluateOrderReadiness: vi.fn() };
    const service = createCommerceRuntimeService({
      orderPort,
      inventoryPort,
      paymentPort,
      readinessPort,
      resolveExecutionPort: () => {
        throw new Error("payment_provider_adapter_unavailable:tpay");
      },
    });

    await expect(service.startRuntime({
      idempotencyKey: "wave1-runtime",
      mode: "one_time",
      clientId: "22222222-2222-4222-8222-222222222222",
      shippingAddressId: "33333333-3333-4333-8333-333333333333",
      orderDraft: orderDraftSummary(),
      paymentProvider: "tpay",
      providerFlow: "blik_one_time",
      paymentExecution: { provider: "tpay", flow: "blik_one_time", blikToken: "123456" },
      metadata: {},
    })).rejects.toThrow("payment_provider_adapter_unavailable:tpay");

    expect(orderPort.finalizeOrderForCheckout).not.toHaveBeenCalled();
    expect(inventoryPort.reserveOrderItems).not.toHaveBeenCalled();
    expect(paymentPort.createIntent).not.toHaveBeenCalled();
  });

  it("records provider execution facts returned by the payment execution port", async () => {
    const recordAttempt = vi.fn().mockResolvedValue({
      paymentAttemptId: "55555555-5555-4555-8555-555555555555",
      status: "requires_action",
      replayed: false,
    });
    const execute = vi.fn().mockResolvedValue({
      provider: "hidden_rehearsal",
      providerAttemptId: "psp_attempt_hidden_1",
      providerSessionId: "psp_session_hidden_1",
      attemptStatus: "requires_action",
      nextActionKind: "sca_required",
      clientSecret: "client_secret_redacted",
      redirectUrl: "https://payments.example/redirect",
      reusablePaymentMethodRef: "pm_ref_hidden_1",
      rawProviderPayload: { providerCall: false, simulated: true },
      normalizedError: null,
      requestPayload: { amountMinor: 1490, currency: "PLN" },
      responsePayload: {
        providerCall: false,
        clientSecretPresent: true,
        redirectUrlPresent: true,
      },
    });
    const service = createCommerceRuntimeService({
      orderPort: {
        finalizeOrderForCheckout: vi.fn().mockResolvedValue({
          orderId: "11111111-1111-4111-8111-111111111111",
          orderRef: "order_wave1",
          mode: "one_time",
          clientId: "22222222-2222-4222-8222-222222222222",
          petId: null,
          shippingAddressId: "33333333-3333-4333-8333-333333333333",
          subscriptionId: null,
          subscriptionCycleId: null,
          total: { amountMinor: 1490, currency: "PLN" },
          items: [
            {
              orderItemId: "44444444-4444-4444-8444-444444444444",
              skuId: "66666666-6666-4666-8666-666666666666",
              sku: "CORE-SKU-TEST",
              quantity: 1,
            },
          ],
          replayed: false,
        }),
      },
      inventoryPort: {
        reserveOrderItems: vi.fn().mockResolvedValue([
          {
            reservationId: "77777777-7777-4777-8777-777777777777",
            reservationIds: ["77777777-7777-4777-8777-777777777777"],
            orderItemId: "44444444-4444-4444-8444-444444444444",
            skuId: "66666666-6666-4666-8666-666666666666",
            sku: "CORE-SKU-TEST",
            status: "reserved",
            replayed: false,
          },
        ]),
        releaseOrderReservations: vi.fn(),
      },
      paymentPort: {
        createIntent: vi.fn().mockResolvedValue({
          paymentIntentId: "88888888-8888-4888-8888-888888888888",
          paymentId: "99999999-9999-4999-8999-999999999999",
          status: "created",
          replayed: false,
        }),
        recordAttempt,
        applyResult: vi.fn(),
      },
      readinessPort: {
        evaluateOrderReadiness: vi.fn().mockResolvedValue({
          omsEligibility: { allowed: false, reason: "order_not_paid" },
          fulfillmentCreate: {
            allowed: false,
            reason: "order_not_paid",
            omsReason: "order_not_paid",
          },
        }),
      },
      executionPort: {
        execute,
      },
    });

    const response = await service.startRuntime({
      idempotencyKey: "wave1-runtime",
      mode: "one_time",
      clientId: "22222222-2222-4222-8222-222222222222",
      shippingAddressId: "33333333-3333-4333-8333-333333333333",
      orderDraft: orderDraftSummary(),
      paymentProvider: "hidden_rehearsal",
      providerFlow: "blik_one_time",
      paymentExecution: { provider: "tpay", flow: "blik_one_time", blikToken: "123456" },
      metadata: {},
    });

    expect(recordAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "hidden_rehearsal",
        providerAttemptId: "psp_attempt_hidden_1",
        providerSessionId: "psp_session_hidden_1",
        attemptStatus: "requires_action",
        nextActionKind: "sca_required",
        requestPayload: { amountMinor: 1490, currency: "PLN" },
        responsePayload: {
          providerCall: false,
          clientSecretPresent: true,
          redirectUrlPresent: true,
        },
      }),
    );
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        providerFlow: "blik_one_time",
        transientProviderInput: { provider: "tpay", flow: "blik_one_time", blikToken: "123456" },
      }),
    );
    expect(response.runtime.payment.attemptStatus).toBe("requires_action");
    expect(response.runtime.nextAction.provider).toBe("hidden_rehearsal");
    expect(JSON.stringify(recordAttempt.mock.calls)).not.toContain("123456");
  });

  it("leaves a prepared real-provider attempt unfinalized when the provider call fails", async () => {
    const paymentPort = makePaymentPort();
    const execute = vi.fn().mockRejectedValue(new Error("tpay_request_timeout"));
    const service = createCommerceRuntimeService({
      orderPort: makeOrderPort(),
      inventoryPort: makeInventoryPort(),
      paymentPort,
      readinessPort: makeReadinessPort(),
      executionPort: { execute },
    });

    await expect(service.startRuntime({
      idempotencyKey: "wave1-runtime-tpay-timeout",
      mode: "one_time",
      clientId: "22222222-2222-4222-8222-222222222222",
      shippingAddressId: "33333333-3333-4333-8333-333333333333",
      orderDraft: orderDraftSummary(),
      paymentProvider: "tpay",
      providerFlow: "pbl_one_time",
      paymentExecution: { provider: "tpay", flow: "pbl_one_time", channelId: "108" },
      metadata: {},
    })).rejects.toMatchObject({
      name: "ProviderAttemptExecutionError",
      code: "provider_execution_failed",
      message: "provider_execution_failed:tpay_request_timeout",
    } satisfies Partial<ProviderAttemptExecutionError>);

    expect(paymentPort.prepareProviderAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: "wave1-runtime-tpay-timeout:payment-execution:prepare-attempt",
        provider: "tpay",
      }),
    );
    expect(execute).toHaveBeenCalledTimes(1);
    expect(paymentPort.finalizeProviderAttempt).not.toHaveBeenCalled();
    expect(paymentPort.recordAttempt).not.toHaveBeenCalled();
  });

  it("retries only a proven pre-dispatch failure on the same prepared attempt", async () => {
    const paymentPort = makePaymentPort();
    const execute = vi.fn()
      .mockRejectedValueOnce(new ProviderAttemptPreDispatchError({
        phase: "oauth",
        code: "tpay_oauth_failed",
        dispatchState: "not_dispatched",
      }))
      .mockResolvedValueOnce({
        provider: "tpay",
        providerAttemptId: "provider-attempt-1",
        providerSessionId: null,
        attemptStatus: "processing",
        nextActionKind: null,
        requestPayload: {},
        responsePayload: {},
      });
    const service = createCommerceRuntimeService({
      orderPort: makeOrderPort(),
      inventoryPort: makeInventoryPort(),
      paymentPort,
      readinessPort: makeReadinessPort(),
      executionPort: { execute },
    });

    await expect(service.startRuntime({
      idempotencyKey: "wave1-runtime-tpay-oauth-retry",
      mode: "one_time",
      clientId: "22222222-2222-4222-8222-222222222222",
      shippingAddressId: "33333333-3333-4333-8333-333333333333",
      orderDraft: orderDraftSummary(),
      paymentProvider: "tpay",
      providerFlow: "pbl_one_time",
      paymentExecution: { provider: "tpay", flow: "pbl_one_time", channelId: "108" },
      metadata: {},
    })).resolves.toMatchObject({
      runtime: { payment: { paymentAttemptId: "55555555-5555-4555-8555-555555555555" } },
    });

    expect(paymentPort.prepareProviderAttempt).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(paymentPort.finalizeProviderAttempt).toHaveBeenCalledTimes(1);
  });

  it("reopens an exhausted proven pre-dispatch attempt without fallible post-mutation work", async () => {
    const reopenInteractivePreparedAttempt = vi.fn().mockResolvedValue({
      paymentAttemptId: "55555555-5555-4555-8555-555555555555",
      paymentIntentId: "88888888-8888-4888-8888-888888888888",
      paymentAttemptStatus: "failed",
      paymentIntentStatus: "failed",
      replayed: false,
    });
    const paymentPort = { ...makePaymentPort(), reopenInteractivePreparedAttempt };
    const readinessPort = makeReadinessPort();
    readinessPort.evaluateOrderReadiness.mockRejectedValue(new Error("must_not_run_after_reopen"));
    const execute = vi.fn()
      .mockRejectedValueOnce(new ProviderAttemptPreDispatchError({
        phase: "oauth", code: "tpay_oauth_timeout", dispatchState: "not_dispatched",
      }))
      .mockRejectedValueOnce(new ProviderAttemptPreDispatchError({
        phase: "oauth", code: "tpay_oauth_timeout", dispatchState: "not_dispatched",
      }));
    const service = createCommerceRuntimeService({
      orderPort: makeOrderPort(), inventoryPort: makeInventoryPort(), paymentPort,
      readinessPort, executionPort: { execute },
    });

    const response = await service.startRuntime({
      idempotencyKey: "wave1-runtime-tpay-oauth-exhausted",
      mode: "one_time",
      clientId: "22222222-2222-4222-8222-222222222222",
      shippingAddressId: "33333333-3333-4333-8333-333333333333",
      orderDraft: orderDraftSummary(),
      paymentProvider: "tpay",
      providerFlow: "blik_one_time",
      paymentExecution: { provider: "tpay", flow: "blik_one_time", blikToken: "123456" },
      metadata: {},
    });

    expect(response.runtime.payment).toMatchObject({
      paymentAttemptId: "55555555-5555-4555-8555-555555555555",
      status: "failed",
      attemptStatus: "failed",
    });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(paymentPort.finalizeProviderAttempt).not.toHaveBeenCalled();
    expect(readinessPort.evaluateOrderReadiness).not.toHaveBeenCalled();
    expect(reopenInteractivePreparedAttempt).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: "wave1-runtime-tpay-oauth-exhausted:payment-execution:reopen-not-dispatched",
      evidence: {
        mode: "trusted_pre_dispatch",
        dispatchState: "not_dispatched",
        phase: "oauth",
        reasonCode: "tpay_oauth_timeout",
      },
    }));
  });

  /**
   * The 2026-09-02 incident. Tpay answered the create-transaction with HTTP 400
   * and a request-validation code, which left the prepared attempt `created` -
   * outside the admission gate's retryable set - so every later submit on any
   * rail was refused `provider_attempt_in_flight` until the reconciliation sweep
   * 15-45 minutes later.
   */
  it("releases a provably refused attempt into a status the admission gate admits", async () => {
    const reopenInteractivePreparedAttempt = vi.fn().mockResolvedValue({
      paymentAttemptId: "55555555-5555-4555-8555-555555555555",
      paymentIntentId: "88888888-8888-4888-8888-888888888888",
      paymentAttemptStatus: "failed",
      paymentIntentStatus: "failed",
      replayed: false,
    });
    const paymentPort = { ...makePaymentPort(), reopenInteractivePreparedAttempt };
    const execute = vi.fn()
      .mockRejectedValueOnce(new ProviderAttemptPreDispatchError(PROVIDER_REFUSAL))
      .mockRejectedValueOnce(new ProviderAttemptPreDispatchError(PROVIDER_REFUSAL));
    const service = createCommerceRuntimeService({
      orderPort: makeOrderPort(), inventoryPort: makeInventoryPort(), paymentPort,
      readinessPort: makeReadinessPort(), executionPort: { execute },
    });

    const response = await service.startRuntime(tpaySubmit("wave1-runtime-tpay-refused"));

    // `failed` is the whole point: it is in RETRYABLE_ATTEMPT_STATUSES, so the
    // SQL gate admits a fresh attempt against the same intent.
    expect(response.runtime.payment.attemptStatus).toBe("failed");
    expect(isRetryableAttemptStatus("failed")).toBe(true);
    // The order stays payable and the reservation is never released, so the
    // buyer retries on the same order with the cart intact.
    expect(response.runtime.orderId).toBe("11111111-1111-4111-8111-111111111111");
    expect(paymentPort.finalizeProviderAttempt).not.toHaveBeenCalled();
    expect(reopenInteractivePreparedAttempt).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: "wave1-runtime-tpay-refused:payment-execution:reopen-not-dispatched",
      paymentAttemptId: "55555555-5555-4555-8555-555555555555",
      evidence: {
        mode: "trusted_provider_refusal",
        dispatchState: "refused",
        phase: "response_decode",
        reasonCode: "tpay_request_refused",
      },
    }));
  });

  it("admits the buyer's next submit instead of answering provider_attempt_in_flight", async () => {
    const paymentPort = {
      ...makePaymentPort(),
      reopenInteractivePreparedAttempt: vi.fn().mockResolvedValue({
        paymentAttemptId: "55555555-5555-4555-8555-555555555555",
        paymentIntentId: "88888888-8888-4888-8888-888888888888",
        paymentAttemptStatus: "failed",
        paymentIntentStatus: "failed",
        replayed: false,
      }),
    };
    const execute = vi.fn()
      .mockRejectedValueOnce(new ProviderAttemptPreDispatchError(PROVIDER_REFUSAL))
      .mockRejectedValueOnce(new ProviderAttemptPreDispatchError(PROVIDER_REFUSAL))
      .mockResolvedValue({
        provider: "tpay",
        providerAttemptId: "tr-2",
        providerSessionId: null,
        attemptStatus: "requires_action",
        nextActionKind: "redirect",
        requestPayload: {},
        responsePayload: {},
        redirectUrl: "https://secure.tpay.test/tr-2",
      });
    const service = createCommerceRuntimeService({
      orderPort: makeOrderPort(), inventoryPort: makeInventoryPort(), paymentPort,
      readinessPort: makeReadinessPort(), executionPort: { execute },
    });

    await service.startRuntime(tpaySubmit("wave1-runtime-tpay-refused-first"));
    // The same journey, resubmitted. Nothing here rotates the key or mints a
    // second order: the gate is open because the old attempt is terminal.
    const retry = await service.startRuntime(tpaySubmit("wave1-runtime-tpay-refused-first"));

    expect(retry.runtime.payment.attemptStatus).toBe("requires_action");
    expect(retry.runtime.orderId).toBe("11111111-1111-4111-8111-111111111111");
    expect(paymentPort.finalizeProviderAttempt).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a transport loss", () => new ProviderAttemptExecutionError(new TypeError("socket closed"))],
    ["a lost response after dispatch", () => new ProviderAttemptPostDispatchError(new Error("tpay_request_timeout"))],
  ])("never releases the attempt on %s", async (_label, makeError) => {
    const reopenInteractivePreparedAttempt = vi.fn();
    const paymentPort = { ...makePaymentPort(), reopenInteractivePreparedAttempt };
    const execute = vi.fn().mockImplementation(() => Promise.reject(makeError()));
    const service = createCommerceRuntimeService({
      orderPort: makeOrderPort(), inventoryPort: makeInventoryPort(), paymentPort,
      readinessPort: makeReadinessPort(), executionPort: { execute },
    });

    await expect(service.startRuntime(tpaySubmit("wave1-runtime-tpay-ambiguous"))).rejects.toBeTruthy();

    // The provider may be holding a transaction. Terminalizing the attempt here
    // would open the gate to a second charge, so the attempt stays fenced and
    // reconciliation remains the only thing allowed to resolve it.
    expect(reopenInteractivePreparedAttempt).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("retries the reopen write once and preserves the non-compensatable provider error", async () => {
    const exhausted = new ProviderAttemptPreDispatchError({
      phase: "transaction_dispatch",
      code: "tpay_request_deadline_exhausted",
      dispatchState: "not_dispatched",
    });
    const reopenInteractivePreparedAttempt = vi.fn().mockRejectedValue(new Error("rpc_timeout"));
    const paymentPort = { ...makePaymentPort(), reopenInteractivePreparedAttempt };
    const execute = vi.fn()
      .mockRejectedValueOnce(new ProviderAttemptPreDispatchError({
        phase: "transaction_dispatch",
        code: "tpay_request_deadline_exhausted",
        dispatchState: "not_dispatched",
      }))
      .mockRejectedValueOnce(exhausted);
    const service = createCommerceRuntimeService({
      orderPort: makeOrderPort(), inventoryPort: makeInventoryPort(), paymentPort,
      readinessPort: makeReadinessPort(), executionPort: { execute },
    });

    await expect(service.startRuntime({
      idempotencyKey: "wave1-runtime-tpay-reopen-uncertain",
      mode: "one_time",
      clientId: "22222222-2222-4222-8222-222222222222",
      shippingAddressId: "33333333-3333-4333-8333-333333333333",
      orderDraft: orderDraftSummary(),
      paymentProvider: "tpay",
      providerFlow: "blik_one_time",
      paymentExecution: { provider: "tpay", flow: "blik_one_time", blikToken: "123456" },
      metadata: {},
    })).rejects.toBe(exhausted);

    expect(execute).toHaveBeenCalledTimes(2);
    expect(reopenInteractivePreparedAttempt).toHaveBeenCalledTimes(2);
    expect(paymentPort.finalizeProviderAttempt).not.toHaveBeenCalled();
    expect(exhausted).toMatchObject({
      paymentAttemptId: "55555555-5555-4555-8555-555555555555",
      retryCount: 1,
    });
  });

  it.each([
    ["readiness evaluation", () => { throw new Error("readiness_timeout"); }],
    ["response-schema validation", () => ({})],
  ])("marks a real-PSP %s failure as dispatch-uncertain", async (_stage, readinessResult) => {
    const paymentPort = makePaymentPort();
    const readinessPort = makeReadinessPort();
    readinessPort.evaluateOrderReadiness.mockImplementation(async () => readinessResult() as never);
    const execute = vi.fn().mockResolvedValue({
      provider: "tpay",
      providerAttemptId: "provider-attempt-1",
      providerSessionId: null,
      attemptStatus: "processing",
      nextActionKind: null,
      requestPayload: {},
      responsePayload: {},
    });
    const service = createCommerceRuntimeService({
      orderPort: makeOrderPort(),
      inventoryPort: makeInventoryPort(),
      paymentPort,
      readinessPort,
      executionPort: { execute },
    });

    await expect(service.startRuntime({
      idempotencyKey: "wave1-runtime-post-dispatch",
      mode: "one_time",
      clientId: "22222222-2222-4222-8222-222222222222",
      shippingAddressId: "33333333-3333-4333-8333-333333333333",
      orderDraft: orderDraftSummary(),
      paymentProvider: "tpay",
      providerFlow: "pbl_one_time",
      paymentExecution: { provider: "tpay", flow: "pbl_one_time", channelId: "108" },
      metadata: {},
    })).rejects.toMatchObject({
      name: "ProviderAttemptPostDispatchError",
      code: "provider_post_dispatch_failed",
    } satisfies Partial<ProviderAttemptPostDispatchError>);

    expect(paymentPort.prepareProviderAttempt).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(paymentPort.finalizeProviderAttempt).toHaveBeenCalledTimes(1);
  });

  it("marks a decline-finalization failure after real PSP dispatch as uncertain", async () => {
    const paymentPort = makePaymentPort();
    paymentPort.applyResult.mockRejectedValueOnce(new Error("payment_control_apply_timeout"));
    const readinessPort = makeReadinessPort();
    const execute = vi.fn().mockResolvedValue({
      provider: "tpay",
      providerAttemptId: "provider-attempt-1",
      providerSessionId: null,
      attemptStatus: "processing",
      nextActionKind: null,
      providerDecline: { code: "payment_failed", mandateUnsupported: false },
      requestPayload: {},
      responsePayload: {},
    });
    const service = createCommerceRuntimeService({
      orderPort: makeOrderPort(),
      inventoryPort: makeInventoryPort(),
      paymentPort,
      readinessPort,
      executionPort: { execute },
    });

    await expect(service.startRuntime({
      idempotencyKey: "wave1-runtime-decline-tail",
      mode: "one_time",
      clientId: "22222222-2222-4222-8222-222222222222",
      shippingAddressId: "33333333-3333-4333-8333-333333333333",
      orderDraft: orderDraftSummary(),
      paymentProvider: "tpay",
      providerFlow: "pbl_one_time",
      paymentExecution: { provider: "tpay", flow: "pbl_one_time", channelId: "108" },
      metadata: {},
    })).rejects.toMatchObject({
      name: "ProviderAttemptPostDispatchError",
      code: "provider_post_dispatch_failed",
    } satisfies Partial<ProviderAttemptPostDispatchError>);

    expect(paymentPort.prepareProviderAttempt).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(paymentPort.finalizeProviderAttempt).toHaveBeenCalledTimes(1);
    expect(paymentPort.applyResult).toHaveBeenCalledTimes(1);
    expect(readinessPort.evaluateOrderReadiness).not.toHaveBeenCalled();
  });

  it("does not call the PSP again when a prepared real-provider attempt replays", async () => {
    const paymentPort = makePaymentPort();
    paymentPort.prepareProviderAttempt.mockResolvedValueOnce({
      paymentAttemptId: "55555555-5555-4555-8555-555555555555",
      status: "created",
      replayed: true,
      providerAttemptId: null,
      providerSessionId: null,
      nextActionKind: null,
    });
    const execute = vi.fn().mockResolvedValue({
      provider: "tpay",
      providerAttemptId: "provider-attempt-1",
      providerSessionId: null,
      attemptStatus: "processing",
      nextActionKind: null,
      requestPayload: {},
      responsePayload: {},
    });
    const service = createCommerceRuntimeService({
      orderPort: makeOrderPort(),
      inventoryPort: makeInventoryPort(),
      paymentPort,
      readinessPort: makeReadinessPort(),
      executionPort: { execute },
    });

    await expect(service.startRuntime({
      idempotencyKey: "wave1-runtime-tpay-replay",
      mode: "one_time",
      clientId: "22222222-2222-4222-8222-222222222222",
      shippingAddressId: "33333333-3333-4333-8333-333333333333",
      orderDraft: orderDraftSummary(),
      paymentProvider: "tpay",
      providerFlow: "pbl_one_time",
      paymentExecution: { provider: "tpay", flow: "pbl_one_time", channelId: "108" },
      metadata: {},
    })).rejects.toMatchObject({
      name: "ProviderAttemptInFlightError",
      code: "provider_attempt_in_flight",
      paymentAttemptId: "55555555-5555-4555-8555-555555555555",
    } satisfies Partial<ProviderAttemptInFlightError>);

    expect(paymentPort.prepareProviderAttempt).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
    expect(paymentPort.finalizeProviderAttempt).not.toHaveBeenCalled();
    expect(paymentPort.recordAttempt).not.toHaveBeenCalled();
  });

  it("uses distinct decline idempotency keys for sequential provider attempts", async () => {
    const paymentPort = makePaymentPort();
    paymentPort.prepareProviderAttempt
      .mockResolvedValueOnce({
        paymentAttemptId: "55555555-5555-4555-8555-555555555551",
        status: "created",
        replayed: false,
        providerAttemptId: null,
        providerSessionId: null,
        nextActionKind: null,
      })
      .mockResolvedValueOnce({
        paymentAttemptId: "55555555-5555-4555-8555-555555555552",
        status: "created",
        replayed: false,
        providerAttemptId: null,
        providerSessionId: null,
        nextActionKind: null,
      });
    paymentPort.applyResult
      .mockResolvedValueOnce({
        paymentIntentId: "88888888-8888-4888-8888-888888888888",
        paymentAttemptId: "55555555-5555-4555-8555-555555555551",
        paymentId: "99999999-9999-4999-8999-999999999999",
        orderId: "11111111-1111-4111-8111-111111111111",
        status: "failed",
        kind: "recoverable_decline",
        replayed: false,
      })
      .mockResolvedValueOnce({
        paymentIntentId: "88888888-8888-4888-8888-888888888888",
        paymentAttemptId: "55555555-5555-4555-8555-555555555552",
        paymentId: "99999999-9999-4999-8999-999999999999",
        orderId: "11111111-1111-4111-8111-111111111111",
        status: "failed",
        kind: "recoverable_decline",
        replayed: false,
      });
    const execute = vi.fn().mockResolvedValue({
      provider: "tpay",
      providerAttemptId: null,
      providerSessionId: null,
      attemptStatus: "processing",
      nextActionKind: null,
      providerDecline: { code: "payment_failed", mandateUnsupported: true },
      requestPayload: {},
      responsePayload: { providerCall: true },
    });
    const inventoryPort = makeInventoryPort();
    const service = createCommerceRuntimeService({
      orderPort: makeOrderPort(),
      inventoryPort,
      paymentPort,
      readinessPort: makeReadinessPort(),
      executionPort: { execute },
    });
    const baseRequest = {
      idempotencyKey: "wave1-runtime-tpay-decline",
      mode: "subscription_cycle" as const,
      clientId: "22222222-2222-4222-8222-222222222222",
      shippingAddressId: "33333333-3333-4333-8333-333333333333",
      orderDraft: orderDraftSummary(),
      paymentProvider: "tpay" as const,
      providerFlow: "blik_recurring_activation" as const,
      paymentExecution: {
        provider: "tpay" as const,
        flow: "blik_recurring_activation" as const,
        blikToken: "123456",
        recurringModel: "O" as const,
      },
      metadata: {},
    };

    const first = await service.startRuntime(baseRequest);
    const second = await service.startRuntime({ ...baseRequest, paymentAttemptSequence: 1 });

    expect(paymentPort.prepareProviderAttempt).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        requestPayload: expect.objectContaining({ recurringModel: "O" }),
      }),
    );
    expect(first.runtime.payment.paymentAttemptId).toBe("55555555-5555-4555-8555-555555555551");
    expect(second.runtime.payment.paymentAttemptId).toBe("55555555-5555-4555-8555-555555555552");
    expect(paymentPort.applyResult).toHaveBeenNthCalledWith(1, expect.objectContaining({
      idempotencyKey: "wave1-runtime-tpay-decline:payment-execution:payment-declined",
    }));
    expect(paymentPort.applyResult).toHaveBeenNthCalledWith(2, expect.objectContaining({
      idempotencyKey: "wave1-runtime-tpay-decline:payment-execution:attempt:1:payment-declined",
    }));
    expect(inventoryPort.releaseOrderReservations).not.toHaveBeenCalled();
  });

  it("blocks inventory/readiness side effects when payment-control returns another order", async () => {
    const inventoryPort = {
      reserveOrderItems: vi.fn(),
      releaseOrderReservations: vi.fn(),
    };
    const readinessPort = {
      evaluateOrderReadiness: vi.fn(),
    };
    const service = createCommerceRuntimeService({
      orderPort: { finalizeOrderForCheckout: vi.fn() },
      inventoryPort,
      paymentPort: {
        createIntent: vi.fn(),
        recordAttempt: vi.fn(),
        applyResult: vi.fn().mockResolvedValue({
          paymentIntentId: "49999999-9999-4999-8999-999999999991",
          paymentAttemptId: "4bbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
          paymentId: "4aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
          orderId: "42222222-2222-4222-8222-222222222222",
          status: "failed",
          kind: "payment_failed",
          replayed: false,
        }),
      },
      readinessPort,
    });

    await expect(
      service.applyPaymentResult({
        idempotencyKey: "runtime-payment-1",
        orderId: "41111111-1111-4111-8111-111111111111",
        paymentIntentId: "49999999-9999-4999-8999-999999999991",
        resultStatus: "failed",
        occurredAt: "2026-06-05T12:00:00.000Z",
      }),
    ).rejects.toMatchObject({
      name: "CommerceRuntimeConflictError",
      details: {
        requestOrderId: "41111111-1111-4111-8111-111111111111",
        paymentResultOrderId: "42222222-2222-4222-8222-222222222222",
      },
    });

    expect(inventoryPort.releaseOrderReservations).not.toHaveBeenCalled();
    expect(readinessPort.evaluateOrderReadiness).not.toHaveBeenCalled();
  });

  it("keeps inventory reserved for a recoverable decline on the same order", async () => {
    const inventoryPort = makeInventoryPort();
    const readinessPort = makeReadinessPort();
    const paymentPort = makePaymentPort();
    paymentPort.applyResult.mockResolvedValueOnce({
      paymentIntentId: "49999999-9999-4999-8999-999999999991",
      paymentAttemptId: "4bbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
      paymentId: "4aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
      orderId: "41111111-1111-4111-8111-111111111111",
      status: "failed",
      kind: "recoverable_decline",
      replayed: false,
    });
    const service = createCommerceRuntimeService({
      orderPort: makeOrderPort(),
      inventoryPort,
      paymentPort,
      readinessPort,
    });

    const result = await service.applyPaymentResult({
      idempotencyKey: "runtime-recoverable-decline-1",
      orderId: "41111111-1111-4111-8111-111111111111",
      paymentIntentId: "49999999-9999-4999-8999-999999999991",
      resultStatus: "failed",
      occurredAt: "2026-07-21T12:00:00.000Z",
    });

    expect(result.reservationRelease).toEqual({ attempted: false, releasedCount: 0 });
    expect(inventoryPort.releaseOrderReservations).not.toHaveBeenCalled();
    expect(readinessPort.evaluateOrderReadiness).toHaveBeenCalledWith(expect.objectContaining({
      orderId: "41111111-1111-4111-8111-111111111111",
    }));
  });
});
