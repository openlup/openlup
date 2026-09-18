import { describe, expect, it, vi } from "vitest";

import type { PaymentExecutionResult } from "../../src/domains/payment/types.js";
import { recordPaymentAttempt } from "./recordPaymentAttempt.js";

function executionResult(overrides: Partial<PaymentExecutionResult> = {}): PaymentExecutionResult {
  return {
    provider: "stripe",
    providerAttemptId: "pi_attempt_1",
    providerSessionId: "sess_1",
    attemptStatus: "processing",
    nextActionKind: "redirect",
    // Extra fields that MUST NOT be forwarded to recordAttempt:
    clientSecret: "secret_should_not_leak",
    redirectUrl: "https://example.test/redirect",
    requestPayload: { source: "test", providerIdempotencyKey: "k" },
    responsePayload: { providerCall: true },
    ...overrides,
  };
}

describe("recordPaymentAttempt", () => {
  it("forwards exactly the 7 execution fields plus the caller-supplied key + intent id", async () => {
    const recordAttempt = vi.fn().mockResolvedValue({
      paymentAttemptId: "att_1",
      status: "processing",
      replayed: false,
    });
    const execution = executionResult();

    const result = await recordPaymentAttempt(
      { recordAttempt },
      { idempotencyKey: "checkout-1:payment-attempt", paymentIntentId: "intent_1", execution },
    );

    expect(recordAttempt).toHaveBeenCalledTimes(1);
    // Byte-for-byte the object the inline call-sites used to build — and ONLY
    // those keys (no clientSecret/redirectUrl leakage from the execution result).
    expect(recordAttempt).toHaveBeenCalledWith({
      idempotencyKey: "checkout-1:payment-attempt",
      paymentIntentId: "intent_1",
      provider: "stripe",
      providerAttemptId: "pi_attempt_1",
      providerSessionId: "sess_1",
      attemptStatus: "processing",
      nextActionKind: "redirect",
      requestPayload: { source: "test", providerIdempotencyKey: "k" },
      responsePayload: { providerCall: true },
    });
    // Return value is the port result, unchanged.
    expect(result).toEqual({ paymentAttemptId: "att_1", status: "processing", replayed: false });
  });

  it("passes the caller key through verbatim — never derived (subscription :record-attempt scope)", async () => {
    const recordAttempt = vi.fn().mockResolvedValue({
      paymentAttemptId: "att_2",
      status: "failed",
      replayed: false,
    });

    await recordPaymentAttempt(
      { recordAttempt },
      {
        idempotencyKey: "subscription:sub_1:cycle:2026-07-01T00:00:00Z:payment-execution:record-attempt",
        paymentIntentId: "intent_2",
        execution: executionResult({ attemptStatus: "requires_action" }),
      },
    );

    expect(recordAttempt.mock.calls[0][0].idempotencyKey).toBe(
      "subscription:sub_1:cycle:2026-07-01T00:00:00Z:payment-execution:record-attempt",
    );
  });

  it("forwards null provider artifact fields untouched (no-op rehearsal / declines)", async () => {
    const recordAttempt = vi.fn().mockResolvedValue({
      paymentAttemptId: "att_3",
      status: "processing",
      replayed: true,
    });

    await recordPaymentAttempt(
      { recordAttempt },
      {
        idempotencyKey: "recovery-1:payment-attempt",
        paymentIntentId: "intent_3",
        execution: executionResult({
          provider: "hidden_rehearsal",
          providerAttemptId: null,
          providerSessionId: null,
          nextActionKind: null,
        }),
      },
    );

    expect(recordAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "hidden_rehearsal",
        providerAttemptId: null,
        providerSessionId: null,
        nextActionKind: null,
      }),
    );
  });
});
