import { describe, expect, it } from "vitest";
import {
  CHECKOUT_RECOVERY_CONTRACT_VERSION,
  checkoutRecoveryPayRequestSchema,
  checkoutRecoveryPayResponseSchema,
  checkoutRecoveryRedeemRequestSchema,
  checkoutRecoveryRedeemResponseSchema,
  checkoutRecoveryStartRequestSchema,
  checkoutRecoveryStartResponseSchema,
} from "./checkoutRecoveryContracts.js";

const ORDER_ID = "11111111-1111-4111-8111-111111111111";
const INTENT_ID = "22222222-2222-4222-8222-222222222222";
const CLIENT_ID = "33333333-3333-4333-8333-333333333333";
const SUBSCRIPTION_ID = "55555555-5555-4555-8555-555555555555";

describe("checkout-recovery contracts (W4)", () => {
  it("rejects an empty redeem token", () => {
    expect(checkoutRecoveryRedeemRequestSchema.safeParse({ token: "" }).success).toBe(false);
  });

  it("accepts a trimmed redeem token", () => {
    const parsed = checkoutRecoveryRedeemRequestSchema.parse({ token: "  abc123  " });
    expect(parsed.token).toBe("abc123");
  });

  it("discriminates the recoverable redeem response on `recoverable`", () => {
    const recoverable = checkoutRecoveryRedeemResponseSchema.parse({
      contractVersion: CHECKOUT_RECOVERY_CONTRACT_VERSION,
      recoverable: true,
      order: {
        orderId: ORDER_ID,
        orderRef: `order_${ORDER_ID}`,
        orderNumber: "OPENLUP-11111111",
        clientId: CLIENT_ID,
        paymentIntentId: INTENT_ID,
        mode: "subscription_cycle",
        total: { amountMinor: 14900, currency: "PLN" },
        petName: "Lidka",
        cadenceDays: 30,
        createdAt: "2026-06-25T10:00:00.000Z",
      },
    });
    expect(recoverable.recoverable).toBe(true);
  });

  it("requires an explicit fallback on the unrecoverable redeem response", () => {
    const unrecoverable = checkoutRecoveryRedeemResponseSchema.parse({
      contractVersion: CHECKOUT_RECOVERY_CONTRACT_VERSION,
      recoverable: false,
      fallback: "fresh_checkout",
    });
    expect(unrecoverable).toMatchObject({ recoverable: false, fallback: "fresh_checkout" });

    const accountFallback = checkoutRecoveryRedeemResponseSchema.parse({
      contractVersion: CHECKOUT_RECOVERY_CONTRACT_VERSION,
      recoverable: false,
      fallback: "customer_account",
    });
    expect(accountFallback).toMatchObject({ recoverable: false, fallback: "customer_account" });

    expect(
      checkoutRecoveryRedeemResponseSchema.safeParse({
        contractVersion: CHECKOUT_RECOVERY_CONTRACT_VERSION,
        recoverable: false,
      }).success,
    ).toBe(false);
  });

  it("carries the already-paid order through the unrecoverable 3DS race", () => {
    const response = checkoutRecoveryRedeemResponseSchema.parse({
      contractVersion: CHECKOUT_RECOVERY_CONTRACT_VERSION,
      recoverable: false,
      fallback: "customer_account",
      paidOrder: {
        orderId: ORDER_ID,
        orderRef: `order_${ORDER_ID}`,
        clientId: CLIENT_ID,
      },
    });

    expect(response).toMatchObject({
      recoverable: false,
      paidOrder: { orderId: ORDER_ID, clientId: CLIENT_ID },
    });
  });

  it("accepts a terminal paid status on an unrecoverable redeem response", () => {
    const parsed = checkoutRecoveryRedeemResponseSchema.parse({
      contractVersion: CHECKOUT_RECOVERY_CONTRACT_VERSION,
      recoverable: false,
      fallback: "fresh_checkout",
      terminalStatus: "paid",
    });
    expect(parsed).toMatchObject({
      recoverable: false,
      fallback: "fresh_checkout",
      terminalStatus: "paid",
    });
  });

  it("defaults the pay provider to the hidden rehearsal and enforces an idempotency key floor", () => {
    const parsed = checkoutRecoveryPayRequestSchema.parse({
      token: "raw-token",
      idempotencyKey: "checkout-recovery-pay-abc12345",
    });
    expect(parsed.paymentProvider).toBe("hidden_rehearsal");

    expect(
      checkoutRecoveryPayRequestSchema.safeParse({
        token: "raw-token",
        idempotencyKey: "short",
      }).success,
    ).toBe(false);
  });

  it("validates the pay response shape", () => {
    const parsed = checkoutRecoveryPayResponseSchema.parse({
      contractVersion: CHECKOUT_RECOVERY_CONTRACT_VERSION,
      orderId: ORDER_ID,
      paymentIntentId: INTENT_ID,
      clientId: CLIENT_ID,
      status: "failed",
      paymentAttemptId: "44444444-4444-4444-8444-444444444444",
      provider: "hidden_rehearsal",
      providerPaymentId: "rehearsal-attempt",
      failureReason: "blik_recurring_unsupported_bank",
      clientAction: { kind: "none" },
    });
    expect(parsed.status).toBe("failed");
    expect(parsed.failureReason).toBe("blik_recurring_unsupported_bank");
  });

  it("accepts a uuid subscriptionId OR a uuid orderId on the start request (W5)", () => {
    expect(checkoutRecoveryStartRequestSchema.safeParse({ subscriptionId: "nope" }).success).toBe(false);
    expect(checkoutRecoveryStartRequestSchema.safeParse({ orderId: "nope" }).success).toBe(false);

    const bySub = checkoutRecoveryStartRequestSchema.parse({ subscriptionId: SUBSCRIPTION_ID });
    expect("subscriptionId" in bySub && bySub.subscriptionId).toBe(SUBSCRIPTION_ID);

    const byOrder = checkoutRecoveryStartRequestSchema.parse({ orderId: ORDER_ID });
    expect("orderId" in byOrder && byOrder.orderId).toBe(ORDER_ID);

    // Exactly one key — empty, both, or unknown keys are rejected (strict union).
    expect(checkoutRecoveryStartRequestSchema.safeParse({}).success).toBe(false);
    expect(
      checkoutRecoveryStartRequestSchema.safeParse({ subscriptionId: SUBSCRIPTION_ID, orderId: ORDER_ID }).success,
    ).toBe(false);
  });

  it("discriminates the start response on `recoverable` (W5)", () => {
    const recoverable = checkoutRecoveryStartResponseSchema.parse({
      contractVersion: CHECKOUT_RECOVERY_CONTRACT_VERSION,
      recoverable: true,
      token: "raw-token-xyz",
      mode: "subscription_cycle",
    });
    expect(recoverable).toMatchObject({ recoverable: true, token: "raw-token-xyz" });

    const unrecoverable = checkoutRecoveryStartResponseSchema.parse({
      contractVersion: CHECKOUT_RECOVERY_CONTRACT_VERSION,
      recoverable: false,
      fallback: "customer_account",
    });
    expect(unrecoverable).toMatchObject({ recoverable: false, fallback: "customer_account" });

    // A recoverable response without a token must fail.
    expect(
      checkoutRecoveryStartResponseSchema.safeParse({
        contractVersion: CHECKOUT_RECOVERY_CONTRACT_VERSION,
        recoverable: true,
        mode: "subscription_cycle",
      }).success,
    ).toBe(false);
  });
});
