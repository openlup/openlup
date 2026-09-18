import { describe, expect, it, vi } from "vitest";

import {
  ProviderAttemptExecutionError,
  ProviderAttemptPreDispatchError,
} from "../../shared/preparedProviderAttempt.js";
import {
  checkoutProviderAttemptFailure,
  logCheckoutProviderAttemptFailure,
  reopenExhaustedPreDispatchRecoveryAttempt,
  trustedPreDispatchEvidence,
} from "./commerceProviderAttemptFailure.js";
import type { PaymentControlRuntimePort } from "../../../src/domains/commerce/runtimePorts.js";

describe("commerce provider-attempt failure facts", () => {
  it("maps only typed pre-dispatch facts and preserves the retry count", () => {
    const source = new ProviderAttemptPreDispatchError({
      phase: "oauth",
      code: "tpay_oauth_invalid_response",
      dispatchState: "not_dispatched",
    }, "attempt-1").withRetryCount(1);

    expect(checkoutProviderAttemptFailure(source)).toMatchObject({
      reason: "provider_attempt_not_dispatched",
      paymentAttemptId: "attempt-1",
      phase: "oauth",
      code: "tpay_oauth_invalid_response",
      dispatchState: "not_dispatched",
      retryCount: 1,
    });
    expect(trustedPreDispatchEvidence(source)).toEqual({
      mode: "trusted_pre_dispatch",
      dispatchState: "not_dispatched",
      phase: "oauth",
      reasonCode: "tpay_oauth_invalid_response",
    });
  });

  it("maps a provider refusal to its own evidence mode, never the pre-dispatch one", () => {
    const source = new ProviderAttemptPreDispatchError({
      phase: "response_decode",
      code: "tpay_request_refused",
      dispatchState: "refused",
    }, "attempt-2");

    // The client-facing reason is deliberately shared: from the browser's side
    // both facts mean the same actionable thing - no provider call is
    // outstanding, retry now - so no new client code or copy is introduced.
    expect(checkoutProviderAttemptFailure(source)).toMatchObject({
      reason: "provider_attempt_not_dispatched",
      paymentAttemptId: "attempt-2",
      phase: "response_decode",
      code: "tpay_request_refused",
      dispatchState: "refused",
    });
    expect(trustedPreDispatchEvidence(source)).toEqual({
      mode: "trusted_provider_refusal",
      dispatchState: "refused",
      phase: "response_decode",
      reasonCode: "tpay_request_refused",
    });
  });

  it.each([
    ["a refusal state carrying a pre-dispatch phase", { phase: "oauth", code: "tpay_request_refused", dispatchState: "refused" }],
    ["a refusal state carrying a pre-dispatch code", { phase: "response_decode", code: "tpay_oauth_timeout", dispatchState: "refused" }],
    ["a pre-dispatch state carrying the refusal code", { phase: "response_decode", code: "tpay_request_refused", dispatchState: "not_dispatched" }],
  ])("refuses evidence for %s", (_label, failure) => {
    // Each grade is matched whole. A half-populated error satisfies neither, and
    // must never fall back to the other grade's claim.
    expect(trustedPreDispatchEvidence(
      new ProviderAttemptPreDispatchError(
        failure as ConstructorParameters<typeof ProviderAttemptPreDispatchError>[0],
        "attempt-3",
      ),
    )).toBeNull();
  });

  it("keeps execution uncertainty fenced and rejects untyped errors", () => {
    expect(checkoutProviderAttemptFailure(
      new ProviderAttemptExecutionError(new TypeError("socket lost")),
    )).toMatchObject({
      reason: "provider_attempt_in_flight",
      phase: "transaction_dispatch",
      code: "provider_execution_failed",
      dispatchState: "unknown",
      retryCount: 0,
    });
    expect(checkoutProviderAttemptFailure(new Error("untyped"))).toBeNull();
  });

  it("logs the closed HTTP projection without provider prose or payment secrets", () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const source = new ProviderAttemptExecutionError({
      phase: "response_decode",
      code: "tpay_request_failed",
      dispatchState: "unknown",
      failureDiagnostic: {
        httpStatus: 400,
        requestId: "d3a9826d92c48cb8c185",
        providerErrorCodes: ["invalid_request_body"],
        fieldNames: ["payer.email"],
      },
      rawBody: "buyer@example.com BLIK=123456 PAYID=secret",
    });

    try {
      const failure = checkoutProviderAttemptFailure(source);
      expect(failure).not.toBeNull();
      logCheckoutProviderAttemptFailure(failure!);
      const serialized = String(errorLog.mock.calls[0]?.[1]);
      expect(JSON.parse(serialized)).toMatchObject({
        httpStatus: 400,
        requestId: "d3a9826d92c48cb8c185",
        providerErrorCodes: ["invalid_request_body"],
        fieldNames: ["payer.email"],
      });
      for (const secret of ["buyer@example.com", "123456", "PAYID=secret", "rawBody"]) {
        expect(serialized).not.toContain(secret);
      }
    } finally {
      errorLog.mockRestore();
    }
  });
});

describe("recovery-path pre-dispatch reopen", () => {
  it("writes the recovery-dialect receipt for a trusted pre-dispatch failure", async () => {
    const reopenInteractivePreparedAttempt = vi.fn(async () => ({
      paymentAttemptId: "attempt-1",
      paymentIntentId: "intent-1",
      paymentAttemptStatus: "failed" as const,
      paymentIntentStatus: "failed" as const,
      replayed: false,
    }));

    await expect(reopenExhaustedPreDispatchRecoveryAttempt({
      error: preDispatchError("attempt-1"),
      paymentPort: { reopenInteractivePreparedAttempt } as unknown as PaymentControlRuntimePort,
      paymentExecutionIdempotencyKey: "checkout-recovery-pay-x:payment-execution",
      paymentIntentId: "intent-1",
      order: { orderId: "order-1", subscriptionId: "sub-1", subscriptionCycleId: "cycle-1" },
    })).resolves.toBe(true);

    // Same D15 derivation as the checkout dialect, parented on the recovery
    // execution key (D7) instead of the checkout one (D5).
    expect(reopenInteractivePreparedAttempt).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: "checkout-recovery-pay-x:payment-execution:reopen-not-dispatched",
      paymentAttemptId: "attempt-1",
      expectedOrderId: "order-1",
      expectedSubscriptionId: "sub-1",
      expectedSubscriptionCycleId: "cycle-1",
    }));
  });

  it("refuses an untrusted phase without touching the control plane", async () => {
    const reopenInteractivePreparedAttempt = vi.fn();
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    // response_decode can have reached the PSP, so it is not in the trusted set.
    const untrusted = preDispatchError("attempt-1");
    (untrusted as { phase: string }).phase = "response_decode";

    try {
      await expect(reopenExhaustedPreDispatchRecoveryAttempt({
        error: untrusted,
        paymentPort: { reopenInteractivePreparedAttempt } as unknown as PaymentControlRuntimePort,
        paymentExecutionIdempotencyKey: "checkout-recovery-pay-y:payment-execution",
        paymentIntentId: "intent-1",
        order: { orderId: "order-1", subscriptionId: null, subscriptionCycleId: null },
      })).resolves.toBe(false);
      expect(reopenInteractivePreparedAttempt).not.toHaveBeenCalled();
    } finally {
      errorLog.mockRestore();
    }
  });

  it("treats an identity mismatch as uncertain and never reports success", async () => {
    const reopenInteractivePreparedAttempt = vi.fn(async () => ({
      paymentAttemptId: "some-other-attempt",
      paymentIntentId: "intent-1",
      paymentAttemptStatus: "failed" as const,
      paymentIntentStatus: "failed" as const,
      replayed: false,
    }));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await expect(reopenExhaustedPreDispatchRecoveryAttempt({
        error: preDispatchError("attempt-1"),
        paymentPort: { reopenInteractivePreparedAttempt } as unknown as PaymentControlRuntimePort,
        paymentExecutionIdempotencyKey: "checkout-recovery-pay-z:payment-execution",
        paymentIntentId: "intent-1",
        order: { orderId: "order-1", subscriptionId: "sub-1", subscriptionCycleId: "cycle-1" },
      })).resolves.toBe(false);
      expect(reopenInteractivePreparedAttempt).toHaveBeenCalledTimes(2);
    } finally {
      errorLog.mockRestore();
    }
  });
});

function preDispatchError(paymentAttemptId: string) {
  return new ProviderAttemptPreDispatchError({
    phase: "oauth",
    code: "tpay_oauth_timeout",
    dispatchState: "not_dispatched",
  }, paymentAttemptId);
}
