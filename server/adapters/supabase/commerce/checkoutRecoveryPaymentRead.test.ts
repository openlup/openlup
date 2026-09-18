import { describe, expect, it, vi } from "vitest";
import {
  readLatestCheckoutRecoveryPayment,
  type CheckoutRecoveryPaymentReadClient,
} from "./checkoutRecoveryPaymentRead.js";

function clientFor(input: {
  intents?: unknown[];
  intentError?: { message?: string } | null;
  attempt?: unknown;
  attemptError?: { message?: string } | null;
}) {
  const from = vi.fn((table: string) => {
    const query = {
      select: vi.fn(() => query),
      eq: vi.fn(() => query),
      order: vi.fn(() => query),
      limit: vi.fn(async () => ({
        data: input.intents ?? [],
        error: input.intentError ?? null,
      })),
      maybeSingle: vi.fn(async () => ({
        data: input.attempt ?? null,
        error: input.attemptError ?? null,
      })),
      then: undefined,
    };
    return query;
  });
  return { client: { from } as unknown as CheckoutRecoveryPaymentReadClient, from };
}

describe("readLatestCheckoutRecoveryPayment", () => {
  it("returns the newest open intent with provider evidence", async () => {
    const { client, from } = clientFor({
      intents: [{
        id: "pi-local-1",
        status: "processing",
        subscription_cycle_id: "cycle-1",
        active_attempt_id: "attempt-1",
        provider_payment_id: "pi_stripe_1",
        updated_at: "2026-07-21T12:00:00Z",
      }],
      attempt: {
        id: "attempt-1",
        provider: "stripe",
        provider_attempt_id: "fallback",
        provider_session_id: null,
        idempotency_key: "checkout-inline-recovery:old:payment-execution:prepare-attempt",
        request_payload: { retryRequestId: "retry-tab-1" },
      },
    });

    await expect(readLatestCheckoutRecoveryPayment(client, "order-1")).resolves.toEqual({
      id: "pi-local-1",
      status: "processing",
      subscriptionCycleId: "cycle-1",
      open: true,
      priorPaymentEvidence: {
        paymentIntentId: "pi-local-1",
        paymentAttemptId: "attempt-1",
        provider: "stripe",
        providerPaymentId: "pi_stripe_1",
        idempotencyKey: "checkout-inline-recovery:old:payment-execution:prepare-attempt",
        retryRequestId: "retry-tab-1",
      },
    });
    expect(from).toHaveBeenCalledWith("commerce_payment_intents");
    expect(from).toHaveBeenCalledWith("commerce_payment_attempts");
  });

  it("uses Tpay transactionId instead of the merchant TR-* title", async () => {
    const { client } = clientFor({
      intents: [{
        id: "pi-local-2",
        status: "expired",
        subscription_cycle_id: null,
        active_attempt_id: "attempt-2",
        provider_payment_id: null,
        updated_at: "2026-07-21T12:00:00Z",
      }],
      attempt: {
        id: "attempt-2",
        provider: "tpay",
        provider_attempt_id: "TR-merchant-title",
        provider_session_id: "transaction-id",
        idempotency_key: "checkout-recovery-pay-old",
        request_payload: {},
      },
    });

    const result = await readLatestCheckoutRecoveryPayment(client, "order-2");
    expect(result?.open).toBe(false);
    expect(result?.priorPaymentEvidence?.providerPaymentId).toBe("transaction-id");
  });

  it("returns null when the order has no payment intent", async () => {
    const { client } = clientFor({ intents: [] });
    await expect(readLatestCheckoutRecoveryPayment(client, "order-3")).resolves.toBeNull();
  });

  it("fails closed when either Supabase read fails", async () => {
    const intentFailure = clientFor({ intentError: { message: "intent unavailable" } });
    await expect(readLatestCheckoutRecoveryPayment(intentFailure.client, "order-4"))
      .rejects.toThrow("commerce_payment_intents: intent unavailable");

    const attemptFailure = clientFor({
      intents: [{
        id: "pi-local-5",
        status: "failed",
        subscription_cycle_id: null,
        active_attempt_id: "attempt-5",
        provider_payment_id: null,
        updated_at: "2026-07-21T12:00:00Z",
      }],
      attemptError: { message: "attempt unavailable" },
    });
    await expect(readLatestCheckoutRecoveryPayment(attemptFailure.client, "order-5"))
      .rejects.toThrow("commerce_payment_attempts: attempt unavailable");
  });
});
