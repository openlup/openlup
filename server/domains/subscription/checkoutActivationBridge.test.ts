import { describe, expect, it, vi } from "vitest";
import {
  createCheckoutActivationBridge,
  type CheckoutPaymentSucceededInput,
} from "./checkoutActivationBridge.js";
import type { HiddenSubscriptionRuntimePort } from "../../../src/domains/subscription/runtimePorts.js";

const ORDER_ID = "44444444-4444-4444-8444-444444444444";
const PAYMENT_INTENT_ID = "55555555-5555-4555-8555-555555555555";
const SUBSCRIPTION_ID = "66666666-6666-4666-8666-666666666666";

describe("checkout activation bridge", () => {
  it("ignores one-time checkout payments", async () => {
    const deps = createDeps({ checkoutKind: "one_time", cadenceDays: null });

    const result = await createCheckoutActivationBridge(deps).onCheckoutPaymentSucceeded(input());

    expect(result).toEqual({ checkoutKind: "one_time", activationStatus: "not_applicable" });
    expect(deps.runtimePort.activateSubscriptionFromPaidCheckoutOrder).not.toHaveBeenCalled();
  });

  it("blocks subscription activation without a reusable payment method and records audit", async () => {
    const deps = createDeps({ checkoutKind: "subscription_initial", cadenceDays: 21 });

    const result = await createCheckoutActivationBridge(deps).onCheckoutPaymentSucceeded(
      input({ paymentMethodRef: null, paymentMethodKind: null }),
    );

    expect(result).toEqual({
      checkoutKind: "subscription_initial",
      activationStatus: "blocked_missing_payment_method",
      supportCode: "subscription_activation_missing_reusable_payment_method",
    });
    expect(deps.auditPort.recordBlockedSubscriptionActivation).toHaveBeenCalledWith({
      idempotencyKey: `checkout-subscription-activation:${ORDER_ID}:${PAYMENT_INTENT_ID}:blocked`,
      orderId: ORDER_ID,
      paymentIntentId: PAYMENT_INTENT_ID,
      reason: "missing_reusable_payment_method",
      supportCode: "subscription_activation_missing_reusable_payment_method",
    });
    expect(deps.runtimePort.activateSubscriptionFromPaidCheckoutOrder).not.toHaveBeenCalled();
  });

  it("activates subscription checkout with a stable idempotency key", async () => {
    const deps = createDeps({ checkoutKind: "subscription_initial", cadenceDays: 21 });

    const result = await createCheckoutActivationBridge(deps).onCheckoutPaymentSucceeded(input());

    expect(deps.runtimePort.activateSubscriptionFromPaidCheckoutOrder).toHaveBeenCalledWith({
      idempotencyKey: `checkout-subscription-activation:${ORDER_ID}:${PAYMENT_INTENT_ID}`,
      orderId: ORDER_ID,
      paymentIntentId: PAYMENT_INTENT_ID,
      paymentMethodRef: "pm_reusable_123",
      paymentMethodKind: "card",
      paidAt: "2026-06-06T10:00:00.000Z",
    });
    expect(result).toMatchObject({
      checkoutKind: "subscription_initial",
      activationStatus: "activated",
      subscriptionActivation: { subscriptionId: SUBSCRIPTION_ID },
    });
  });
});

function createDeps(context: { checkoutKind: "one_time" | "subscription_initial"; cadenceDays: number | null }) {
  return {
    contextPort: {
      getCheckoutActivationContext: vi.fn().mockResolvedValue(context),
    },
    runtimePort: {
      activateSubscriptionFromPaidCheckoutOrder: vi.fn().mockResolvedValue({
        contractVersion: "commerce.v0",
        subscriptionActivation: {
          subscriptionId: SUBSCRIPTION_ID,
          orderId: ORDER_ID,
          paymentIntentId: PAYMENT_INTENT_ID,
          status: "active",
          nextCycleAt: "2026-06-27T10:00:00.000Z",
          cadenceDays: 21,
          replayed: false,
        },
      }),
    } as unknown as HiddenSubscriptionRuntimePort,
    auditPort: {
      recordBlockedSubscriptionActivation: vi.fn().mockResolvedValue(undefined),
    },
  };
}

function input(overrides: Partial<CheckoutPaymentSucceededInput> = {}): CheckoutPaymentSucceededInput {
  return {
    orderId: ORDER_ID,
    paymentIntentId: PAYMENT_INTENT_ID,
    paymentMethodRef: "pm_reusable_123",
    paymentMethodKind: "card",
    paidAt: "2026-06-06T10:00:00.000Z",
    ...overrides,
  };
}
