// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";

import type { CheckoutRecoveryOrderSummary } from "@/domains/commerce/checkoutRecoveryContracts";
import {
  checkoutRecoveryStripeConfirmationStarted,
  clearCheckoutRecoveryStripeSession,
  clearAllCheckoutRecoveryStripeSessions,
  hasCheckoutRecoveryStripeIdentity,
  setCheckoutRecoveryStripeConfirmationStarted,
  persistCheckoutRecoveryStripeSession,
} from "./checkoutRecoveryStripeSession";

const ORDER: CheckoutRecoveryOrderSummary = {
  orderId: "11111111-1111-4111-8111-111111111111",
  orderRef: "order_11111111-1111-4111-8111-111111111111",
  orderNumber: "OPENLUP-11111111",
  clientId: "33333333-3333-4333-8333-333333333333",
  paymentIntentId: "22222222-2222-4222-8222-222222222222",
  mode: "subscription_cycle",
  total: { amountMinor: 14900, currency: "PLN" },
  petName: "Lidka",
  cadenceDays: 30,
  createdAt: "2026-06-25T10:00:00.000Z",
};

const RESULT = {
  contractVersion: "commerce.checkout-recovery.v1" as const,
  orderId: ORDER.orderId,
  paymentIntentId: ORDER.paymentIntentId,
  clientId: ORDER.clientId,
  status: "processing" as const,
  paymentAttemptId: "44444444-4444-4444-8444-444444444444",
  provider: "stripe",
  providerPaymentId: "pi_recovery_1",
  failureReason: null,
  clientAction: { kind: "provider_embedded" as const, provider: "stripe" as const, clientSecret: "pi_secret" },
};

describe("checkoutRecoveryStripeSession", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it("accepts only the exact order, intent, client and Stripe response", () => {
    expect(hasCheckoutRecoveryStripeIdentity(ORDER, RESULT)).toBe(true);
    expect(hasCheckoutRecoveryStripeIdentity(ORDER, { ...RESULT, orderId: crypto.randomUUID() })).toBe(false);
    expect(hasCheckoutRecoveryStripeIdentity(ORDER, { ...RESULT, provider: "tpay" })).toBe(false);
  });

  it("stores only the local confirmation marker, never PSP credentials or fake identity", () => {
    persistCheckoutRecoveryStripeSession(ORDER, RESULT);
    const stored = JSON.stringify(window.sessionStorage);
    expect(stored).not.toContain("pi_secret");
    expect(stored).not.toContain(RESULT.paymentAttemptId);
    expect(stored).not.toContain(RESULT.providerPaymentId);
    expect(stored).not.toContain("recovery-resumed");
  });

  it("never restores Elements after card confirmation has started", () => {
    persistCheckoutRecoveryStripeSession(ORDER, RESULT);
    setCheckoutRecoveryStripeConfirmationStarted(ORDER.orderId, true);
    expect(checkoutRecoveryStripeConfirmationStarted(ORDER)).toBe(true);
    setCheckoutRecoveryStripeConfirmationStarted(ORDER.orderId, false);
    expect(checkoutRecoveryStripeConfirmationStarted(ORDER)).toBe(false);
  });

  it("clears every recovery Stripe session on canonical unrecoverable entry", () => {
    persistCheckoutRecoveryStripeSession(ORDER, RESULT);
    clearAllCheckoutRecoveryStripeSessions();
    expect(window.sessionStorage.length).toBe(0);
  });

  it("clears one recovery Stripe session", () => {
    persistCheckoutRecoveryStripeSession(ORDER, RESULT);
    clearCheckoutRecoveryStripeSession(ORDER.orderId);
    expect(window.sessionStorage.length).toBe(0);
  });
});
