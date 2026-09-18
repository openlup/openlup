import { describe, expect, it, vi } from "vitest";
import type {
  PaymentControlRuntimePort,
  PreparedProviderAttemptRuntimePort,
} from "../../src/domains/commerce/runtimePorts.js";
import type { PaymentExecutionPort } from "../../src/domains/payment/ports.js";
import {
  ProviderAttemptFinalizationError,
  ProviderAttemptExecutionError,
  ProviderAttemptInFlightError,
  ProviderAttemptPreDispatchError,
  executePreparedProviderAttempt,
  preparedProviderAttemptPort,
  requiresPreparedProviderAttempt,
} from "./preparedProviderAttempt.js";

describe("prepared provider attempt helpers", () => {
  it("requires durable prepared-attempt ordering only for real PSP providers", () => {
    expect(requiresPreparedProviderAttempt("stripe")).toBe(true);
    expect(requiresPreparedProviderAttempt("tpay")).toBe(true);
    expect(requiresPreparedProviderAttempt("hidden_rehearsal")).toBe(false);
    expect(requiresPreparedProviderAttempt("noop_payment")).toBe(false);
  });

  it("returns a prepared-attempt capable payment port", () => {
    const port = {
      prepareProviderAttempt: vi.fn(),
      finalizeProviderAttempt: vi.fn(),
    } as unknown as PaymentControlRuntimePort;

    expect(preparedProviderAttemptPort(port, "stripe")).toMatchObject(port);
  });

  it("throws the caller-provided error when the port is not durable-capable", () => {
    const error = new Error("custom_unavailable");

    expect(() =>
      preparedProviderAttemptPort(
        {} as PaymentControlRuntimePort,
        "tpay",
        () => error,
      ),
    ).toThrow(error);
  });

  it("prepares, executes, and finalizes a real-provider attempt in order", async () => {
    const paymentPort = makePreparedPaymentPort();
    const executionPort = makeExecutionPort();

    const result = await executePreparedProviderAttempt({
      paymentPort,
      executionPort,
      provider: "tpay",
      paymentIntentId: "intent-1",
      executionInput: executionInput(),
      prepareIdempotencyKey: "checkout-1:prepare-attempt",
      finalizeIdempotencyKey: "checkout-1:finalize-attempt",
      providerIdempotencyKey: "provider-key-1",
      providerRequestFingerprint: "provider-fingerprint-1",
      providerFlow: "pbl_one_time",
      paymentMethodRef: null,
      prepareRequestPayload: { source: "test" },
    });

    expect(result).toEqual({
      execution: expect.objectContaining({ providerAttemptId: "provider-attempt-1" }),
      attempt: { paymentAttemptId: "attempt-1", status: "processing" },
    });
    expect(paymentPort.prepareProviderAttempt.mock.invocationCallOrder[0]).toBeLessThan(
      executionPort.execute.mock.invocationCallOrder[0],
    );
    expect(executionPort.execute.mock.invocationCallOrder[0]).toBeLessThan(
      paymentPort.finalizeProviderAttempt.mock.invocationCallOrder[0],
    );
  });

  it("does not call the provider when prepare replays a stale prepared attempt", async () => {
    const paymentPort = makePreparedPaymentPort();
    const executionPort = makeExecutionPort();
    paymentPort.prepareProviderAttempt.mockResolvedValueOnce({
      paymentAttemptId: "attempt-1",
      status: "created",
      replayed: true,
      providerAttemptId: null,
      providerSessionId: null,
      nextActionKind: null,
    });

    await expect(executePreparedProviderAttempt({
      paymentPort,
      executionPort,
      provider: "stripe",
      paymentIntentId: "intent-1",
      executionInput: executionInput(),
      prepareIdempotencyKey: "checkout-1:prepare-attempt",
      finalizeIdempotencyKey: "checkout-1:finalize-attempt",
      providerIdempotencyKey: "provider-key-1",
      providerRequestFingerprint: "provider-fingerprint-1",
      providerFlow: "one_time_payment",
      prepareRequestPayload: { source: "test" },
    })).rejects.toMatchObject({
      name: "ProviderAttemptInFlightError",
      code: "provider_attempt_in_flight",
      paymentAttemptId: "attempt-1",
    });

    expect(executionPort.execute).not.toHaveBeenCalled();
    expect(paymentPort.finalizeProviderAttempt).not.toHaveBeenCalled();
  });

  it("validates deterministic input before preparing a durable attempt", async () => {
    const paymentPort = makePreparedPaymentPort();
    const execute = vi.fn<PaymentExecutionPort["execute"]>();
    const executionPort: PaymentExecutionPort = {
      validateInput: vi.fn(() => {
        throw new Error("tpay_blik_recurring_activation_not_enabled");
      }),
      execute,
    };

    await expect(executePreparedProviderAttempt({
      paymentPort,
      executionPort,
      provider: "tpay",
      paymentIntentId: "intent-1",
      executionInput: executionInput(),
      prepareIdempotencyKey: "checkout-1:prepare-attempt",
      finalizeIdempotencyKey: "checkout-1:finalize-attempt",
      providerIdempotencyKey: "provider-key-1",
      providerRequestFingerprint: "provider-fingerprint-1",
      providerFlow: "blik_recurring_activation",
      prepareRequestPayload: { source: "test" },
    })).rejects.toThrow("tpay_blik_recurring_activation_not_enabled");

    expect(paymentPort.prepareProviderAttempt).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(paymentPort.finalizeProviderAttempt).not.toHaveBeenCalled();
  });

  it("keeps a prepared attempt observable when provider execution throws", async () => {
    const paymentPort = makePreparedPaymentPort();
    const executionPort = makeExecutionPort();
    executionPort.execute.mockRejectedValueOnce(new Error("tpay_request_timeout"));

    await expect(executePreparedProviderAttempt({
      paymentPort,
      executionPort,
      provider: "tpay",
      paymentIntentId: "intent-1",
      executionInput: executionInput(),
      prepareIdempotencyKey: "checkout-1:prepare-attempt",
      finalizeIdempotencyKey: "checkout-1:finalize-attempt",
      providerIdempotencyKey: "provider-key-1",
      providerRequestFingerprint: "provider-fingerprint-1",
      providerFlow: "pbl_one_time",
      prepareRequestPayload: { source: "test" },
    })).rejects.toMatchObject({
      name: "ProviderAttemptExecutionError",
      code: "provider_execution_failed",
      message: "provider_execution_failed:tpay_request_timeout",
    });

    expect(paymentPort.prepareProviderAttempt).toHaveBeenCalledTimes(1);
    expect(executionPort.execute).toHaveBeenCalledTimes(1);
    expect(paymentPort.finalizeProviderAttempt).not.toHaveBeenCalled();
  });

  it("propagates only the closed provider diagnostic and never finalizes an unknown dispatch", async () => {
    const paymentPort = makePreparedPaymentPort();
    const executionPort = makeExecutionPort();
    executionPort.execute.mockRejectedValueOnce({
      phase: "response_decode",
      code: "tpay_request_failed",
      dispatchState: "unknown",
      failureDiagnostic: {
        httpStatus: 400,
        requestId: "d3a9826d92c48cb8c185",
        providerErrorCodes: ["invalid_request_body"],
        fieldNames: ["payer.email"],
      },
      rawBody: "buyer@example.com BLIK=123456",
    });

    const error = await executePreparedProviderAttempt(
      preparedInput(paymentPort, executionPort),
    ).catch((failure: unknown) => failure);

    expect(error).toMatchObject({
      name: "ProviderAttemptExecutionError",
      paymentAttemptId: "attempt-1",
      phase: "response_decode",
      errorCode: "tpay_request_failed",
      dispatchState: "unknown",
      failureDiagnostic: {
        httpStatus: 400,
        requestId: "d3a9826d92c48cb8c185",
        providerErrorCodes: ["invalid_request_body"],
        fieldNames: ["payer.email"],
      },
    });
    expect(JSON.stringify(error)).not.toContain("buyer@example.com");
    expect(JSON.stringify(error)).not.toContain("123456");
    expect(executionPort.execute).toHaveBeenCalledOnce();
    expect(paymentPort.finalizeProviderAttempt).not.toHaveBeenCalled();
  });

  it("retries one proven pre-dispatch execution on the same durable attempt", async () => {
    const paymentPort = makePreparedPaymentPort();
    const executionPort = makeExecutionPort();
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    executionPort.execute
      .mockRejectedValueOnce(preDispatchFailure())
      .mockResolvedValueOnce({
        provider: "tpay",
        providerAttemptId: "provider-attempt-1",
        providerSessionId: "provider-session-1",
        attemptStatus: "processing",
        nextActionKind: null,
        requestPayload: { request: true },
        responsePayload: { response: true },
      });

    try {
      await expect(executePreparedProviderAttempt(preparedInput(paymentPort, executionPort))).resolves.toMatchObject({
        attempt: { paymentAttemptId: "attempt-1", status: "processing" },
      });
      expect(executionPort.execute).toHaveBeenCalledTimes(2);
      expect(paymentPort.finalizeProviderAttempt).toHaveBeenCalledTimes(1);
      expect(errorLog).toHaveBeenCalledWith(
        "provider_attempt_predispatch_retry",
        expect.stringContaining('"retryOrdinal":1'),
      );
    } finally {
      errorLog.mockRestore();
    }
  });

  it("returns a typed pre-dispatch error after its one same-attempt retry", async () => {
    const paymentPort = makePreparedPaymentPort();
    const executionPort = makeExecutionPort();
    executionPort.execute.mockRejectedValueOnce(preDispatchFailure()).mockRejectedValueOnce(preDispatchFailure());

    await expect(executePreparedProviderAttempt(preparedInput(paymentPort, executionPort))).rejects.toMatchObject({
      name: "ProviderAttemptPreDispatchError",
      paymentAttemptId: "attempt-1",
      phase: "oauth",
      code: "tpay_oauth_failed",
      dispatchState: "not_dispatched",
      retryCount: 1,
    });
    expect(executionPort.execute).toHaveBeenCalledTimes(2);
    expect(paymentPort.finalizeProviderAttempt).not.toHaveBeenCalled();
  });

  // ⛔ Characterization. A twice-proven pre-dispatch failure escapes RAW even when
  // the caller supplies `executionError`, and both interactive callers depend on
  // it: commerceRuntimeService and checkoutRecoveryPayService each catch this
  // exact instance to read `paymentAttemptId`/`phase`/`code` — the inputs
  // `trustedPreDispatchEvidence()` gates the no-dispatch reopen on. Mapping it
  // here would destroy that evidence and silently strand the prepared attempt
  // `created` on BOTH paths. Callers own the mapping, after the reopen.
  it("escapes a twice-proven pre-dispatch failure raw, past any executionError mapper", async () => {
    const paymentPort = makePreparedPaymentPort();
    const executionPort = makeExecutionPort();
    const executionError = vi.fn(() => new ProviderAttemptExecutionError("must_not_map_pre_dispatch"));
    executionPort.execute.mockRejectedValueOnce(preDispatchFailure()).mockRejectedValueOnce(preDispatchFailure());
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await expect(executePreparedProviderAttempt({
        ...preparedInput(paymentPort, executionPort),
        executionError,
      })).rejects.toMatchObject({
        name: "ProviderAttemptPreDispatchError",
        paymentAttemptId: "attempt-1",
        dispatchState: "not_dispatched",
        retryCount: 1,
      });
      expect(executionError).not.toHaveBeenCalled();
    } finally {
      errorLog.mockRestore();
    }
  });

  it("replays the same finalize identity once without another provider call", async () => {
    const paymentPort = makePreparedPaymentPort();
    const executionPort = makeExecutionPort();
    paymentPort.finalizeProviderAttempt
      .mockRejectedValueOnce(new Error("local write response lost"))
      .mockResolvedValueOnce({
        paymentAttemptId: "attempt-1",
        status: "processing",
        replayed: true,
        providerAttemptId: "provider-attempt-1",
        providerSessionId: "provider-session-1",
        nextActionKind: null,
      });

    await expect(executePreparedProviderAttempt(preparedInput(paymentPort, executionPort))).resolves.toMatchObject({
      attempt: { paymentAttemptId: "attempt-1", status: "processing" },
    });
    expect(executionPort.execute).toHaveBeenCalledOnce();
    expect(paymentPort.finalizeProviderAttempt).toHaveBeenCalledTimes(2);
    expect(paymentPort.finalizeProviderAttempt.mock.calls[0]?.[0]?.idempotencyKey)
      .toBe(paymentPort.finalizeProviderAttempt.mock.calls[1]?.[0]?.idempotencyKey);
  });

  it("keeps an acknowledged provider result uncertain when durable finalization throws", async () => {
    const paymentPort = makePreparedPaymentPort();
    const executionPort = makeExecutionPort();
    paymentPort.finalizeProviderAttempt
      .mockRejectedValueOnce(new Error("payment_control_timeout"))
      .mockRejectedValueOnce(new Error("payment_control_timeout"));

    await expect(executePreparedProviderAttempt({
      paymentPort,
      executionPort,
      provider: "tpay",
      paymentIntentId: "intent-1",
      executionInput: executionInput(),
      prepareIdempotencyKey: "checkout-1:prepare-attempt",
      finalizeIdempotencyKey: "checkout-1:finalize-attempt",
      providerIdempotencyKey: "provider-key-1",
      providerRequestFingerprint: "provider-fingerprint-1",
      providerFlow: "pbl_one_time",
      prepareRequestPayload: { source: "test" },
    })).rejects.toMatchObject({
      name: "ProviderAttemptFinalizationError",
      code: "provider_finalization_failed",
      message: "provider_finalization_failed:payment_control_timeout",
    } satisfies Partial<ProviderAttemptFinalizationError>);

    expect(paymentPort.prepareProviderAttempt).toHaveBeenCalledTimes(1);
    expect(executionPort.execute).toHaveBeenCalledTimes(1);
    expect(paymentPort.finalizeProviderAttempt).toHaveBeenCalledTimes(2);
  });

  it("lets callers map replay and execution errors into local domain errors", async () => {
    const replayPort = makePreparedPaymentPort();
    replayPort.prepareProviderAttempt.mockResolvedValueOnce({
      paymentAttemptId: "attempt-1",
      status: "created",
      replayed: true,
      providerAttemptId: null,
      providerSessionId: null,
      nextActionKind: null,
    });

    await expect(executePreparedProviderAttempt({
      paymentPort: replayPort,
      executionPort: makeExecutionPort(),
      provider: "tpay",
      paymentIntentId: "intent-1",
      executionInput: executionInput(),
      prepareIdempotencyKey: "checkout-1:prepare-attempt",
      finalizeIdempotencyKey: "checkout-1:finalize-attempt",
      providerIdempotencyKey: "provider-key-1",
      providerRequestFingerprint: "provider-fingerprint-1",
      providerFlow: "pbl_one_time",
      prepareRequestPayload: { source: "test" },
      replayError: () => new ProviderAttemptInFlightError({
        paymentAttemptId: "attempt-2",
        status: "created",
        providerAttemptId: null,
        providerSessionId: null,
      }),
    })).rejects.toMatchObject({ paymentAttemptId: "attempt-2" });

    const executionPort = makeExecutionPort();
    executionPort.execute.mockRejectedValueOnce(new Error("stripe_timeout"));
    await expect(executePreparedProviderAttempt({
      paymentPort: makePreparedPaymentPort(),
      executionPort,
      provider: "stripe",
      paymentIntentId: "intent-1",
      executionInput: executionInput(),
      prepareIdempotencyKey: "checkout-2:prepare-attempt",
      finalizeIdempotencyKey: "checkout-2:finalize-attempt",
      providerIdempotencyKey: "provider-key-2",
      providerRequestFingerprint: "provider-fingerprint-2",
      providerFlow: "one_time_payment",
      prepareRequestPayload: { source: "test" },
      executionError: () => new ProviderAttemptExecutionError("mapped_timeout"),
    })).rejects.toMatchObject({ message: "provider_execution_failed:mapped_timeout" });
  });
});

function makePreparedPaymentPort() {
  return {
    createIntent: vi.fn(),
    recordAttempt: vi.fn(),
    applyResult: vi.fn(),
    prepareProviderAttempt: vi.fn<PreparedProviderAttemptRuntimePort["prepareProviderAttempt"]>(
      async () => ({
        paymentAttemptId: "attempt-1",
        status: "created",
        replayed: false,
        providerAttemptId: null,
        providerSessionId: null,
        nextActionKind: null,
      }),
    ),
    finalizeProviderAttempt: vi.fn<PreparedProviderAttemptRuntimePort["finalizeProviderAttempt"]>(
      async (input) => ({
        paymentAttemptId: input.paymentAttemptId,
        status: input.attemptStatus,
        replayed: false,
        providerAttemptId: input.providerAttemptId,
        providerSessionId: input.providerSessionId,
        nextActionKind: input.nextActionKind,
      }),
    ),
  };
}

function makeExecutionPort() {
  return {
    execute: vi.fn<PaymentExecutionPort["execute"]>(async () => ({
      provider: "tpay",
      providerAttemptId: "provider-attempt-1",
      providerSessionId: "provider-session-1",
      attemptStatus: "processing",
      nextActionKind: null,
      clientSecret: null,
      redirectUrl: "https://secure.tpay.com/tx",
      requestPayload: { request: true },
      responsePayload: { response: true },
    })),
  };
}

function executionInput() {
  return {
    idempotencyKey: "checkout-1:payment-execution",
    providerIdempotencyKey: "provider-key-1",
    providerRequestFingerprint: "provider-fingerprint-1",
    paymentIntentId: "intent-1",
    amountMinor: 1490,
    currency: "PLN",
    mode: "one_time" as const,
    orderRef: "order-1",
    orderId: "order-uuid-1",
    providerFlow: "pbl_one_time" as const,
  };
}

function preparedInput(
  paymentPort: ReturnType<typeof makePreparedPaymentPort>,
  executionPort: ReturnType<typeof makeExecutionPort>,
) {
  return {
    paymentPort,
    executionPort,
    provider: "tpay" as const,
    paymentIntentId: "intent-1",
    executionInput: executionInput(),
    prepareIdempotencyKey: "checkout-1:prepare-attempt",
    finalizeIdempotencyKey: "checkout-1:finalize-attempt",
    providerIdempotencyKey: "provider-key-1",
    providerRequestFingerprint: "provider-fingerprint-1",
    providerFlow: "pbl_one_time",
    prepareRequestPayload: { source: "test" },
  };
}

function preDispatchFailure() {
  return new ProviderAttemptPreDispatchError({
    phase: "oauth",
    code: "tpay_oauth_failed",
    dispatchState: "not_dispatched",
  });
}
