import { describe, expect, it } from "vitest";
import {
  getPaymentExecutionAdapter,
  NoopSettlementNotAllowedError,
  UnknownPaymentProviderError,
} from "./paymentAdapterRegistry.js";

const executionInput = {
  idempotencyKey: "wave-test",
  providerIdempotencyKey: "openlup:hidden_rehearsal:00000000-0000-0000-0000-000000000000:wave-test",
  providerRequestFingerprint: "hidden_rehearsal|00000000-0000-0000-0000-000000000000|1490|PLN|one_time|order_abc",
  paymentIntentId: "00000000-0000-0000-0000-000000000000",
  amountMinor: 1490,
  currency: "PLN" as const,
  mode: "one_time" as const,
  orderRef: "order_abc",
};

describe("paymentAdapterRegistry", () => {
  it("resolves the hidden_rehearsal no-op adapter with no provider call", async () => {
    const adapter = getPaymentExecutionAdapter("hidden_rehearsal", {}, true);
    const result = await adapter.execute(executionInput);

    expect(result).toEqual({
      provider: "hidden_rehearsal",
      providerAttemptId: null,
      providerSessionId: null,
      attemptStatus: "processing",
      nextActionKind: null,
      requestPayload: {
        source: "commerce.runtime.hidden.v0",
        providerIdempotencyKey: executionInput.providerIdempotencyKey,
        providerRequestFingerprint: executionInput.providerRequestFingerprint,
      },
      responsePayload: { providerCall: false },
    });
  });

  it("resolves the noop_payment provider via the widened enum", async () => {
    const adapter = getPaymentExecutionAdapter("noop_payment", {}, true);
    const result = await adapter.execute(executionInput);

    expect(result.provider).toBe("noop_payment");
    expect(result.responsePayload).toEqual({ providerCall: false });
  });

  it("throws for an unknown (not-yet-implemented) PSP so it cannot silently no-op", () => {
    expect(() => getPaymentExecutionAdapter("stripe", {}, true)).toThrow(UnknownPaymentProviderError);
    expect(() => getPaymentExecutionAdapter("tpay", {}, true)).toThrow(/Unknown payment execution provider/);
  });

  it("refuses no-op providers when no-op settlement is not allowed (production seam)", () => {
    expect(() => getPaymentExecutionAdapter("hidden_rehearsal", {}, false)).toThrow(
      NoopSettlementNotAllowedError,
    );
    expect(() => getPaymentExecutionAdapter("noop_payment", {}, false)).toThrow(
      /No-op payment settlement is not allowed/,
    );
  });

  it("routes selected providers only when an execution adapter is explicitly injected", async () => {
    const stripeDouble = {
      execute: async () => ({
        provider: "hidden_rehearsal" as const,
        providerAttemptId: "stripe_double_attempt",
        providerSessionId: "stripe_double_session",
        attemptStatus: "requires_action" as const,
        nextActionKind: "3ds_challenge" as const,
        requestPayload: { providerKind: "stripe" },
        responsePayload: { providerCall: false },
      }),
    };

    // Injected real adapters bypass the no-op seam even when noop is disallowed.
    const adapter = getPaymentExecutionAdapter("stripe", { stripe: stripeDouble }, false);
    const result = await adapter.execute(executionInput);

    expect(result.providerAttemptId).toBe("stripe_double_attempt");
    expect(result.responsePayload).toEqual({ providerCall: false });
  });
});
