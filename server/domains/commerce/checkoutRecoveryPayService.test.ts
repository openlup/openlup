import { describe, expect, it, vi } from "vitest";
import { createCheckoutRecoveryPayService } from "./checkoutRecoveryPayService.js";
import type { CheckoutRecoveryOrderSnapshot } from "./checkoutRecoveryOrderPort.js";
import type {
  PaymentControlRuntimePort,
  CommerceCheckoutRuntimePort,
  PreparedProviderAttemptRuntimePort,
} from "../../../src/domains/commerce/runtimePorts.js";
import type { PaymentExecutionPort } from "../../../src/domains/payment/ports.js";
import type {
  PaymentExecutionProvider,
  PaymentExecutionResult,
} from "../../../src/domains/payment/types.js";
import { ProviderAttemptPreDispatchError } from "../../shared/preparedProviderAttempt.js";

const ORDER_ID = "11111111-1111-4111-8111-111111111111";
const INTENT_ID = "22222222-2222-4222-8222-222222222222";
const CLIENT_ID = "33333333-3333-4333-8333-333333333333";
const ATTEMPT_ID = "44444444-4444-4444-8444-444444444444";

function snapshot(overrides: Partial<CheckoutRecoveryOrderSnapshot> = {}): CheckoutRecoveryOrderSnapshot {
  return {
    orderId: ORDER_ID,
    orderRef: `order_${ORDER_ID}`,
    orderNumber: "OPENLUP-11111111",
    clientId: CLIENT_ID,
    status: "pending_payment",
    mode: "subscription_cycle",
    totalMinor: 14900,
    currency: "PLN",
    petName: "Lidka",
    cadenceDays: 30,
    createdAt: "2026-06-25T10:00:00.000Z",
    customerEmail: "anna@example.com",
    customerName: "Anna Kowalska",
    paymentIntentId: INTENT_ID,
    paymentIntentStatus: "failed",
    subscriptionId: "sub-1",
    subscriptionCycleId: "cycle-1",
    ...overrides,
  };
}

function execution(provider: PaymentExecutionProvider): PaymentExecutionResult {
  return {
    provider,
    providerAttemptId: `${provider}-attempt`,
    providerSessionId: null,
    attemptStatus: "processing",
    nextActionKind: null,
    requestPayload: {},
    responsePayload: {},
    clientSecret: provider === "stripe" ? "pi_secret_recovery" : null,
    redirectUrl: null,
  };
}

function buildService(
  provider: PaymentExecutionProvider,
  executionOverride?: Partial<PaymentExecutionResult>,
) {
  const execute = vi.fn<PaymentExecutionPort["execute"]>(async () => ({
    ...execution(provider),
    ...executionOverride,
  }));
  const executePort = {
    execute,
  };

  const recordAttempt = vi.fn<PaymentControlRuntimePort["recordAttempt"]>(async () => ({
    paymentAttemptId: ATTEMPT_ID,
    status: provider === "hidden_rehearsal" ? "succeeded" : "processing",
    replayed: false,
  }));
  const prepareProviderAttempt = vi.fn<PreparedProviderAttemptRuntimePort["prepareProviderAttempt"]>(
    async () => ({
      paymentAttemptId: ATTEMPT_ID,
      status: "created",
      replayed: false,
      providerAttemptId: null,
      providerSessionId: null,
      nextActionKind: null,
    }),
  );
  const finalizeProviderAttempt = vi.fn<PreparedProviderAttemptRuntimePort["finalizeProviderAttempt"]>(
    async (input) => ({
      paymentAttemptId: input.paymentAttemptId,
      status: input.attemptStatus,
      replayed: false,
      providerAttemptId: input.providerAttemptId,
      providerSessionId: input.providerSessionId,
      nextActionKind: input.nextActionKind,
    }),
  );
  const reopenInteractivePreparedAttempt = vi.fn(async () => ({
    paymentAttemptId: ATTEMPT_ID,
    paymentIntentId: INTENT_ID,
    paymentAttemptStatus: "failed" as const,
    paymentIntentStatus: "failed" as const,
    replayed: false,
  }));
  const paymentControlPort = {
    recordAttempt,
    prepareProviderAttempt,
    finalizeProviderAttempt,
    reopenInteractivePreparedAttempt,
  };

  const applyPaymentResult = vi.fn(async (_request: unknown) => ({}) as never);
  const runtimePort = { applyPaymentResult } as unknown as CommerceCheckoutRuntimePort;

  const service = createCheckoutRecoveryPayService({
    paymentControlPort: paymentControlPort as unknown as PaymentControlRuntimePort,
    runtimePort,
    resolveExecutionPort: () => executePort as unknown as PaymentExecutionPort,
    now: () => new Date("2026-06-27T12:00:00.000Z"),
  });

  return { service, executePort, paymentControlPort, applyPaymentResult };
}

describe("checkout-recovery pay service (W4)", () => {
  it("mints a fresh attempt and applies the succeeded result for the rehearsal provider", async () => {
    const { service, executePort, paymentControlPort, applyPaymentResult } =
      buildService("hidden_rehearsal");

    const result = await service.pay({
      order: snapshot(),
      clientId: CLIENT_ID,
      paymentProvider: "hidden_rehearsal",
      paymentExecution: undefined,
      idempotencyKey: "checkout-recovery-pay-abc12345",
    });

    expect(result.status).toBe("paid");
    expect(result.paymentAttemptId).toBe(ATTEMPT_ID);
    expect(result.clientAction).toEqual({ kind: "none" });

    // W4a: the attempt is keyed on the SAME existing intent, not a new one.
    expect(vi.mocked(executePort.execute).mock.calls[0]![0]).toMatchObject({
      paymentIntentId: INTENT_ID,
      orderId: ORDER_ID,
    });
    expect(vi.mocked(paymentControlPort.recordAttempt).mock.calls[0]![0]).toMatchObject({
      paymentIntentId: INTENT_ID,
    });
    expect(paymentControlPort.prepareProviderAttempt).not.toHaveBeenCalled();
    expect(paymentControlPort.finalizeProviderAttempt).not.toHaveBeenCalled();
    // The rehearsal settles synchronously → apply-result flips the order paid + activates the sub.
    expect(applyPaymentResult).toHaveBeenCalledTimes(1);
    expect(applyPaymentResult.mock.calls[0]![0]).toMatchObject({
      orderId: ORDER_ID,
      paymentIntentId: INTENT_ID,
      resultStatus: "succeeded",
    });
  });

  it("returns an embedded Stripe action on the same order/intent without auto-applying a result", async () => {
    const { service, executePort, paymentControlPort, applyPaymentResult } = buildService("stripe");

    const result = await service.pay({
      order: snapshot(),
      clientId: CLIENT_ID,
      paymentProvider: "stripe",
      paymentExecution: undefined,
      idempotencyKey: "checkout-recovery-pay-def67890",
    });

    expect(result.status).toBe("processing");
    expect(result).toMatchObject({
      orderId: ORDER_ID,
      paymentIntentId: INTENT_ID,
      clientId: CLIENT_ID,
      clientAction: {
        kind: "provider_embedded",
        provider: "stripe",
        clientSecret: "pi_secret_recovery",
      },
    });
    expect(paymentControlPort.prepareProviderAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: "checkout-recovery-pay-def67890:payment-execution:prepare-attempt",
        paymentIntentId: INTENT_ID,
        provider: "stripe",
      }),
    );
    expect(executePort.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: ORDER_ID,
        paymentIntentId: INTENT_ID,
        returnContext: "public",
        saveForFutureUse: true,
      }),
    );
    expect(paymentControlPort.finalizeProviderAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: "checkout-recovery-pay-def67890:payment-execution:finalize-attempt",
        paymentAttemptId: ATTEMPT_ID,
        attemptStatus: "processing",
      }),
    );
    expect(paymentControlPort.recordAttempt).not.toHaveBeenCalled();
    expect(paymentControlPort.prepareProviderAttempt.mock.invocationCallOrder[0]).toBeLessThan(
      executePort.execute.mock.invocationCallOrder[0],
    );
    expect(executePort.execute.mock.invocationCallOrder[0]).toBeLessThan(
      paymentControlPort.finalizeProviderAttempt.mock.invocationCallOrder[0],
    );
    // Real PSPs rely on the webhook — the service must never fabricate a paid state.
    expect(applyPaymentResult).not.toHaveBeenCalled();
  });

  it("marks only inline recovery preparation with the exact predecessor and tab request", async () => {
    const { service, paymentControlPort } = buildService("stripe");
    await service.pay({
      order: snapshot(), clientId: CLIENT_ID, paymentProvider: "stripe",
      paymentExecution: undefined,
      idempotencyKey: `checkout-inline-recovery:${ATTEMPT_ID}`,
      exactInlineRetry: {
        expectedPaymentAttemptId: ATTEMPT_ID,
        retryRequestId: "55555555-5555-4555-8555-555555555555",
        purchaseContext: "subscription_initial",
      },
    });

    expect(paymentControlPort.prepareProviderAttempt).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: `checkout-inline-recovery:${ATTEMPT_ID}:payment-execution:prepare-attempt`,
      requestPayload: expect.objectContaining({
        source: "commerce.checkout-inline-recovery.prepare.v1",
        expectedPaymentAttemptId: ATTEMPT_ID,
        retryRequestId: "55555555-5555-4555-8555-555555555555",
        purchaseContext: "subscription_initial",
      }),
    }));
  });

  it("returns the stable unsupported-bank reason with a synchronous Tpay decline", async () => {
    const { service, executePort, applyPaymentResult, paymentControlPort } = buildService("tpay");
    executePort.execute.mockResolvedValueOnce({
      ...execution("tpay"),
      providerDecline: { code: "payment_failed", mandateUnsupported: true },
      webhookExpected: false,
    });

    const result = await service.pay({
      order: snapshot(),
      clientId: CLIENT_ID,
      paymentProvider: "tpay",
      paymentExecution: {
        provider: "tpay",
        flow: "blik_recurring_activation",
        blikToken: "123456",
        recurringModel: "O",
      },
      idempotencyKey: "checkout-recovery-pay-unsupported-bank",
    });

    expect(result).toMatchObject({
      status: "failed",
      failureReason: "blik_recurring_unsupported_bank",
      clientAction: { kind: "none" },
    });
    expect(paymentControlPort.prepareProviderAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        requestPayload: expect.objectContaining({ recurringModel: "O" }),
      }),
    );
    expect(applyPaymentResult).toHaveBeenCalledWith(expect.objectContaining({
      resultStatus: "failed",
      failureReason: "blik_recurring_unsupported_bank",
    }));
  });

  it("returns a Stripe embedded client action with the fresh recovery client secret", async () => {
    const { service } = buildService("stripe", { clientSecret: "pi_secret_recovery" });

    const result = await service.pay({
      order: snapshot({ mode: "one_time_order" }),
      clientId: CLIENT_ID,
      paymentProvider: "stripe",
      paymentExecution: undefined,
      idempotencyKey: "checkout-recovery-pay-stripe123",
    });

    expect(result).toMatchObject({
      status: "processing",
      provider: "stripe",
      providerPaymentId: "stripe-attempt",
      clientAction: {
        kind: "provider_embedded",
        provider: "stripe",
        clientSecret: "pi_secret_recovery",
      },
    });
  });

  it("fails Stripe recovery without blind-failing the prepared attempt when the client secret is missing", async () => {
    const { service, executePort, paymentControlPort, applyPaymentResult } = buildService("stripe");
    executePort.execute.mockResolvedValueOnce({ ...execution("stripe"), clientSecret: null });

    await expect(service.pay({
      order: snapshot(),
      clientId: CLIENT_ID,
      paymentProvider: "stripe",
      paymentExecution: undefined,
      idempotencyKey: "checkout-recovery-pay-nosecret1",
    })).rejects.toMatchObject({
      name: "CheckoutRecoveryPayError",
      code: "stripe_client_secret_missing",
      orderId: ORDER_ID,
    });

    expect(paymentControlPort.prepareProviderAttempt).toHaveBeenCalledTimes(1);
    expect(executePort.execute).toHaveBeenCalledTimes(1);
    expect(paymentControlPort.finalizeProviderAttempt).not.toHaveBeenCalled();
    expect(applyPaymentResult).not.toHaveBeenCalled();
  });

  it("does not mint a fresh provider attempt while the local intent is still processing", async () => {
    const { service, executePort, paymentControlPort } = buildService("stripe");

    await expect(service.pay({
      order: snapshot({ paymentIntentStatus: "processing" }),
      clientId: CLIENT_ID,
      paymentProvider: "stripe",
      paymentExecution: undefined,
      idempotencyKey: "checkout-recovery-pay-processing1",
    })).rejects.toMatchObject({
      name: "CheckoutRecoveryPayError",
      code: "payment_intent_in_flight",
      orderId: ORDER_ID,
    });

    expect(paymentControlPort.prepareProviderAttempt).not.toHaveBeenCalled();
    expect(executePort.execute).not.toHaveBeenCalled();
  });

  it("admits a fresh same-order Tpay attempt only after payment-control terminalized the old intent", async () => {
    const { service, executePort, paymentControlPort } = buildService("tpay");

    await expect(service.pay({
      order: snapshot({ paymentIntentStatus: "failed" }),
      clientId: CLIENT_ID,
      paymentProvider: "tpay",
      paymentExecution: {
        provider: "tpay",
        flow: "blik_recurring_activation",
        blikToken: "000000",
        recurringModel: "O",
      },
      idempotencyKey: "checkout-recovery-pay-after-reopen",
    })).resolves.toMatchObject({
      orderId: ORDER_ID,
      paymentIntentId: INTENT_ID,
      status: "processing",
    });

    expect(paymentControlPort.prepareProviderAttempt).toHaveBeenCalledWith(expect.objectContaining({
      paymentIntentId: INTENT_ID,
      provider: "tpay",
    }));
    expect(executePort.execute).toHaveBeenCalledTimes(1);
  });

  it("derives the Tpay payer from the order's buyer contact when the caller passes none", async () => {
    const { service, executePort } = buildService("tpay");
    await service.pay({
      order: snapshot(),
      clientId: CLIENT_ID,
      paymentProvider: "tpay",
      paymentExecution: { provider: "tpay", flow: "blik_one_time", blikToken: "000000" },
      idempotencyKey: "checkout-recovery-pay-tpay1234",
    });
    // Without a payer Tpay throws tpay_payer_missing; the order's captured contact fills it.
    expect(executePort.execute.mock.calls[0]![0].payer).toEqual({
      email: "anna@example.com",
      name: "Anna Kowalska",
    });
    expect(executePort.execute.mock.calls[0]![0].returnContext).toBe("public");
  });

  it("preserves an explicit recovery payer over the order-contact fallback", async () => {
    const { service, executePort } = buildService("tpay");
    await service.pay({
      order: snapshot(),
      clientId: CLIENT_ID,
      paymentProvider: "tpay",
      paymentExecution: { provider: "tpay", flow: "blik_one_time", blikToken: "000000" },
      idempotencyKey: "checkout-recovery-pay-explicit-payer",
      payer: {
        email: "payer@example.com",
        name: "Explicit Payer",
        ip: "203.0.113.10",
        userAgent: "test-agent",
      },
    });

    expect(executePort.execute.mock.calls[0]![0].payer).toEqual({
      email: "payer@example.com",
      name: "Explicit Payer",
      ip: "203.0.113.10",
      userAgent: "test-agent",
    });
  });

  it("falls back to the email as payer name when the order has no contact name", async () => {
    const { service, executePort } = buildService("tpay");
    await service.pay({
      order: snapshot({ customerName: null }),
      clientId: CLIENT_ID,
      paymentProvider: "tpay",
      paymentExecution: { provider: "tpay", flow: "blik_one_time", blikToken: "000000" },
      idempotencyKey: "checkout-recovery-pay-tpay5678",
    });
    expect(executePort.execute.mock.calls[0]![0].payer).toEqual({
      email: "anna@example.com",
      name: "anna@example.com",
    });
  });

  it("scopes execution idempotency to the FE per-click key so a re-press replays the same attempt", async () => {
    const { service, executePort } = buildService("hidden_rehearsal");
    await service.pay({
      order: snapshot(),
      clientId: CLIENT_ID,
      paymentProvider: "hidden_rehearsal",
      paymentExecution: undefined,
      idempotencyKey: "checkout-recovery-pay-stable99",
    });
    expect(executePort.execute.mock.calls[0]![0].idempotencyKey).toBe(
      "checkout-recovery-pay-stable99:payment-execution",
    );
  });

  it("does not call the PSP again when a real-provider prepare attempt replays", async () => {
    const { service, executePort, paymentControlPort } = buildService("tpay");
    paymentControlPort.prepareProviderAttempt.mockResolvedValueOnce({
      paymentAttemptId: ATTEMPT_ID,
      status: "created",
      replayed: true,
      providerAttemptId: null,
      providerSessionId: null,
      nextActionKind: null,
    });

    await expect(service.pay({
      order: snapshot(),
      clientId: CLIENT_ID,
      paymentProvider: "tpay",
      paymentExecution: { provider: "tpay", flow: "pbl_one_time", channelId: "108" },
      idempotencyKey: "checkout-recovery-pay-replay1",
    })).rejects.toMatchObject({
      name: "CheckoutRecoveryPayError",
      code: "provider_attempt_in_flight",
      orderId: ORDER_ID,
    });

    expect(paymentControlPort.prepareProviderAttempt).toHaveBeenCalledTimes(1);
    expect(executePort.execute).not.toHaveBeenCalled();
    expect(paymentControlPort.finalizeProviderAttempt).not.toHaveBeenCalled();
    expect(paymentControlPort.recordAttempt).not.toHaveBeenCalled();
  });

  it("keeps ambiguous provider timeouts fenced instead of blind-failing the prepared attempt", async () => {
    const { service, executePort, paymentControlPort, applyPaymentResult } = buildService("tpay");
    executePort.execute.mockRejectedValueOnce(new Error("tpay_request_timeout"));

    await expect(service.pay({
      order: snapshot(),
      clientId: CLIENT_ID,
      paymentProvider: "tpay",
      paymentExecution: { provider: "tpay", flow: "pbl_one_time", channelId: "108" },
      idempotencyKey: "checkout-recovery-pay-timeout1",
    })).rejects.toMatchObject({
      name: "CheckoutRecoveryPayError",
      code: "provider_execution_failed",
      orderId: ORDER_ID,
    });

    expect(paymentControlPort.prepareProviderAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: "checkout-recovery-pay-timeout1:payment-execution:prepare-attempt",
        provider: "tpay",
      }),
    );
    expect(executePort.execute).toHaveBeenCalledTimes(1);
    expect(paymentControlPort.finalizeProviderAttempt).not.toHaveBeenCalled();
    expect(paymentControlPort.recordAttempt).not.toHaveBeenCalled();
    expect(applyPaymentResult).not.toHaveBeenCalled();
  });

  it("keeps same-order recovery in flight after both idempotent finalization calls reject", async () => {
    const { service, executePort, paymentControlPort, applyPaymentResult } = buildService("tpay");
    paymentControlPort.finalizeProviderAttempt
      .mockRejectedValueOnce(new Error("payment_control_timeout"))
      .mockRejectedValueOnce(new Error("payment_control_timeout"));

    await expect(service.pay({
      order: snapshot(),
      clientId: CLIENT_ID,
      paymentProvider: "tpay",
      paymentExecution: { provider: "tpay", flow: "pbl_one_time", channelId: "108" },
      idempotencyKey: "checkout-recovery-pay-finalize1",
    })).rejects.toMatchObject({
      name: "CheckoutRecoveryPayError",
      code: "provider_attempt_in_flight",
      orderId: ORDER_ID,
    });

    expect(paymentControlPort.prepareProviderAttempt).toHaveBeenCalledTimes(1);
    expect(executePort.execute).toHaveBeenCalledTimes(1);
    expect(paymentControlPort.finalizeProviderAttempt).toHaveBeenCalledTimes(2);
    expect(paymentControlPort.recordAttempt).not.toHaveBeenCalled();
    expect(applyPaymentResult).not.toHaveBeenCalled();
  });
  // A twice-proven pre-dispatch failure is the dunning customer's worst case: the
  // pay-page click reached the provider's OAuth endpoint, never its transaction
  // endpoint.
  // Before this rail the raw ProviderAttemptPreDispatchError escaped the service,
  // hit the handler's bare `throw error;` as an unhandled 500, and left the
  // prepared attempt `created` — which checkoutRecoveryPaymentResolver reads as a
  // live attempt, so every later click answered awaiting_provider instead of
  // retry_new while the 24/72/168h ladder kept burning.
  it("terminalizes the stranded attempt and refuses structurally after a twice-proven pre-dispatch failure", async () => {
    const { service, executePort, paymentControlPort, applyPaymentResult } = buildService("tpay");
    executePort.execute.mockRejectedValue(preDispatchFailure());
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await expect(service.pay({
        order: snapshot(),
        clientId: CLIENT_ID,
        paymentProvider: "tpay",
        paymentExecution: {
          provider: "tpay",
          flow: "blik_recurring_activation",
          blikToken: "777123",
          recurringModel: "O",
        },
        idempotencyKey: "checkout-recovery-pay-oauth1",
      })).rejects.toMatchObject({
        name: "CheckoutRecoveryPayError",
        code: "provider_execution_failed",
        orderId: ORDER_ID,
      });

      // The same durable attempt was retried once, then terminalized — no second
      // prepare, so no second provider idempotency key and no double-charge risk.
      expect(paymentControlPort.prepareProviderAttempt).toHaveBeenCalledTimes(1);
      expect(executePort.execute).toHaveBeenCalledTimes(2);
      expect(paymentControlPort.finalizeProviderAttempt).not.toHaveBeenCalled();
      expect(paymentControlPort.reopenInteractivePreparedAttempt).toHaveBeenCalledTimes(1);
      expect(paymentControlPort.reopenInteractivePreparedAttempt).toHaveBeenCalledWith({
        idempotencyKey: "checkout-recovery-pay-oauth1:payment-execution:reopen-not-dispatched",
        paymentIntentId: INTENT_ID,
        paymentAttemptId: ATTEMPT_ID,
        expectedOrderId: ORDER_ID,
        expectedSubscriptionId: "sub-1",
        expectedSubscriptionCycleId: "cycle-1",
        evidence: {
          mode: "trusted_pre_dispatch",
          dispatchState: "not_dispatched",
          phase: "oauth",
          reasonCode: "tpay_oauth_failed",
        },
      });
      // ⛔ Subscription invariant: the rescue terminalizes only the local payment
      // aggregate. It must never apply a money result for a cycle the PSP was
      // never asked about, which is what would move the order/subscription.
      expect(applyPaymentResult).not.toHaveBeenCalled();
    } finally {
      errorLog.mockRestore();
    }
  });

  it("still refuses structurally when the reopen write stays uncertain", async () => {
    const { service, executePort, paymentControlPort, applyPaymentResult } = buildService("tpay");
    executePort.execute.mockRejectedValue(preDispatchFailure());
    paymentControlPort.reopenInteractivePreparedAttempt.mockRejectedValue(new Error("rpc_timeout"));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await expect(service.pay({
        order: snapshot(),
        clientId: CLIENT_ID,
        paymentProvider: "tpay",
        paymentExecution: { provider: "tpay", flow: "pbl_one_time", channelId: "108" },
        idempotencyKey: "checkout-recovery-pay-oauth2",
      })).rejects.toMatchObject({
        name: "CheckoutRecoveryPayError",
        code: "provider_execution_failed",
        orderId: ORDER_ID,
      });

      // One same-payload retry, then the refusal is still structured. The RPC may
      // already have committed, so nothing here compensates the order.
      expect(paymentControlPort.reopenInteractivePreparedAttempt).toHaveBeenCalledTimes(2);
      expect(applyPaymentResult).not.toHaveBeenCalled();
      expect(errorLog).toHaveBeenCalledWith(
        "provider_attempt_predispatch_reopen_failed",
        expect.stringContaining('"reason":"rpc_unavailable"'),
      );
    } finally {
      errorLog.mockRestore();
    }
  });

  it("refuses structurally without a reopen when the control plane lacks the capability", async () => {
    const { service, executePort, paymentControlPort } = buildService("tpay");
    executePort.execute.mockRejectedValue(preDispatchFailure());
    // An adopter control plane that never implemented the optional boundary.
    delete (paymentControlPort as { reopenInteractivePreparedAttempt?: unknown })
      .reopenInteractivePreparedAttempt;
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await expect(service.pay({
        order: snapshot(),
        clientId: CLIENT_ID,
        paymentProvider: "tpay",
        paymentExecution: { provider: "tpay", flow: "pbl_one_time", channelId: "108" },
        idempotencyKey: "checkout-recovery-pay-oauth3",
      })).rejects.toMatchObject({
        name: "CheckoutRecoveryPayError",
        code: "provider_execution_failed",
        orderId: ORDER_ID,
      });

      expect(errorLog).toHaveBeenCalledWith(
        "provider_attempt_predispatch_reopen_failed",
        expect.stringContaining('"reason":"capability_unavailable"'),
      );
    } finally {
      errorLog.mockRestore();
    }
  });
});

function preDispatchFailure() {
  return new ProviderAttemptPreDispatchError({
    phase: "oauth",
    code: "tpay_oauth_failed",
    dispatchState: "not_dispatched",
  });
}
