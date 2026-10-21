import { describe, expect, it, vi } from "vitest";
import { createStripeSandboxPaymentExecutionAdapter, type StripeIntentLike } from "../../../src/payments/stripe/stripeSandboxPaymentExecutionAdapter.js";
import { createStripePaymentReconciliationProvider } from "../../../src/payments/stripe/stripePaymentReconciliationProvider.js";
import type { ClaimedPaymentAttempt } from "../../../src/payments/stripe/donorContracts.js";
import type { PaymentExecutionInput } from "../../../src/payments/stripe/donorContracts.js";

const input: PaymentExecutionInput = {
  idempotencyKey: "fixture:execute", providerIdempotencyKey: "fixture:provider",
  providerRequestFingerprint: "fixture-fingerprint", paymentIntentId: "fixture-intent",
  amountMinor: 2599, currency: "EUR", mode: "one_time", orderRef: "fixture-order",
};
const attempt: ClaimedPaymentAttempt = {
  paymentAttemptId: "fixture-attempt", paymentIntentId: input.paymentIntentId, paymentId: "fixture-payment",
  orderId: "fixture-order", subscriptionId: null, subscriptionCycleId: null, provider: "stripe",
  providerPaymentId: "pi_fixture", providerAttemptId: "pi_fixture", providerSessionId: "pi_fixture",
  attemptStatus: "processing", intentStatus: "processing", amountMinor: 2599, currency: "EUR",
  orderMode: "one_time", cycleRetryAttempt: 0, cycleNextRetryAt: null, localUpdatedAt: "2026-10-21T10:00:00Z",
};
function subject(intent: StripeIntentLike) {
  return {
    execute: createStripeSandboxPaymentExecutionAdapter({ client: {
      createPaymentIntent: vi.fn(async () => intent), createSetupIntent: vi.fn(async () => intent),
    } }).execute,
    reader: createStripePaymentReconciliationProvider({ retrievePaymentIntent: vi.fn(async () => intent) }),
  };
}

describe("A2 Stripe status characterization", () => {
  it("T1 records a fresh unconfirmed intent as sent_to_provider", async () => {
    const f = subject({ id: "pi_fixture", status: "requires_payment_method", payment_method: null,
      latest_charge: null, last_payment_error: null, client_secret: "fixture" });
    await expect(f.execute(input)).resolves.toMatchObject({ attemptStatus: "sent_to_provider",
      providerAttemptId: "pi_fixture", webhookExpected: true, nextActionKind: null });
  });

  it("T2 distinguishes requires_action execution from purpose-sensitive readback", async () => {
    const f = subject({ id: "pi_fixture", status: "requires_action", client_secret: "fixture",
      amount: 2599, currency: "eur", next_action: { type: "use_stripe_sdk" } });
    await expect(f.execute(input)).resolves.toMatchObject({ attemptStatus: "requires_action", nextActionKind: "3ds_challenge" });
    const request = { providerPaymentId: "pi_fixture", attempt };
    await expect(f.reader.readPayment(request)).resolves.toMatchObject({ status: "failed" });
    await expect(f.reader.readRecoveryPayment(request)).resolves.toMatchObject({ status: { status: "failed" } });
    await expect(f.reader.readRecoveryPayment({ ...request, purpose: "active_checkout" }))
      .resolves.toMatchObject({ status: { status: "pending" }, identityMatches: true,
        configuredMoneyMatches: true, clientAction: { kind: "provider_embedded", clientSecret: "fixture" } });
  });

  it("T3 keeps an unknown status nonterminal at execution and unknown at readback", async () => {
    const f = subject({ id: "pi_fixture", status: "vendor_future_state" });
    await expect(f.execute(input)).resolves.toMatchObject({ attemptStatus: "processing", nextActionKind: null });
    await expect(f.reader.readPayment({ providerPaymentId: "pi_fixture", attempt }))
      .resolves.toMatchObject({ status: "unknown", providerStatus: "vendor_future_state", failureReason: null });
  });
});
