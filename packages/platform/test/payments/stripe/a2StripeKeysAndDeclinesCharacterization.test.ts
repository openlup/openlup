import { describe, expect, it, vi } from "vitest";
import { createStripeSandboxPaymentExecutionAdapter, type StripeSandboxClient } from "../../../src/payments/stripe/stripeSandboxPaymentExecutionAdapter.js";
import type { PaymentExecutionInput } from "../../../src/payments/stripe/donorContracts.js";

const input: PaymentExecutionInput = {
  idempotencyKey: "checkout-fixture:payment-execution",
  providerIdempotencyKey: "openlup:stripe:11111111-1111-4111-8111-111111111111:checkout-fixture:payment-execution",
  providerRequestFingerprint: "fixture-fingerprint", paymentIntentId: "11111111-1111-4111-8111-111111111111",
  amountMinor: 2599, currency: "EUR", mode: "one_time", orderRef: "fixture-order", clientId: "fixture-client",
};
function client() {
  return { createPaymentIntent: vi.fn<StripeSandboxClient["createPaymentIntent"]>(async () => ({ id: "pi_fixture", status: "processing" })),
    createSetupIntent: vi.fn<StripeSandboxClient["createSetupIntent"]>(async () => ({ id: "seti_fixture", status: "requires_confirmation" })),
    ensureCustomer: vi.fn(async () => "cus_fixture") };
}
const renewal = { ...input, mode: "subscription_cycle" as const, providerFlow: "off_session_payment" as const,
  customerRef: "cus_fixture", paymentMethodRef: "pm_fixture" };

describe("A2 Stripe keys and declines characterization", () => {
  it("K1 forwards exact D14 and stable customer key bytes for payment and setup", async () => {
    const sdk = client();
    const adapter = createStripeSandboxPaymentExecutionAdapter({ client: sdk });
    await adapter.execute({ ...input, saveForFutureUse: true });
    expect(sdk.ensureCustomer).toHaveBeenCalledExactlyOnceWith(
      { clientId: "fixture-client", metadata: { clientId: "fixture-client" } },
      { idempotencyKey: "openlup:stripe:customer:fixture-client" });
    expect(sdk.createPaymentIntent.mock.calls[0][1]).toEqual({
      idempotencyKey: "openlup:stripe:11111111-1111-4111-8111-111111111111:checkout-fixture:payment-execution" });
    expect(sdk.createPaymentIntent.mock.calls[0][0]).toMatchObject({ customer: "cus_fixture", setupFutureUsage: "off_session" });
    await adapter.execute({ ...input, providerFlow: "setup_reusable_method" });
    expect(sdk.createSetupIntent.mock.calls[0][1]).toEqual({
      idempotencyKey: "openlup:stripe:11111111-1111-4111-8111-111111111111:checkout-fixture:payment-execution" });
  });

  it("K2 reports an off-session issuer refusal as neutral facts", async () => {
    const sdk = client();
    sdk.createPaymentIntent.mockRejectedValue(Object.assign(new Error("fixture refusal"), {
      type: "StripeCardError", code: "card_declined", decline_code: "insufficient_funds",
      advice_code: "try_again_later", payment_intent: { id: "pi_refused", status: "requires_payment_method" },
    }));
    const result = await createStripeSandboxPaymentExecutionAdapter({ client: sdk }).execute(renewal);
    expect(sdk.createPaymentIntent.mock.calls[0][0]).toMatchObject({ offSession: true, paymentMethod: "pm_fixture" });
    expect(result).toMatchObject({ attemptStatus: "processing", providerAttemptId: null, providerSessionId: null,
      webhookExpected: false, clientSecret: null, providerDecline: { code: "card_declined", mandateUnsupported: false,
        declineCode: "insufficient_funds", adviceCode: "try_again_later", neutralReasonHints: ["transient"] } });
    expect(result.responsePayload.providerErrorCodes).toEqual(["card_declined", "insufficient_funds", "try_again_later"]);
    expect(JSON.stringify(result)).not.toContain("fixture refusal");
  });

  it("K3 throws non-issuer and network errors without converting them to declines", async () => {
    for (const error of [Object.assign(new Error("fixture network"), { code: "ECONNRESET" }),
      Object.assign(new Error("fixture rate limit"), { type: "RateLimit", code: "lock_timeout" })]) {
      const sdk = client();
      sdk.createPaymentIntent.mockRejectedValue(error);
      await expect(createStripeSandboxPaymentExecutionAdapter({ client: sdk }).execute(renewal)).rejects.toBe(error);
    }
  });
});
