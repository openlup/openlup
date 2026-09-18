import { describe, expect, it, vi } from "vitest";
import {
  createManagedSubscriptionRuntimePort,
} from "./subscriptionRuntimePort.js";

const recoveryToken = ["01234567", "89abcdef"].join("").repeat(4);

describe("managed subscription runtime port", () => {
  it("calls the activation RPC with reusable payment method fields", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: {
        contractVersion: "commerce.v0",
        subscriptionActivation: {
          subscriptionId: "41111111-1111-4111-8111-111111111111",
          orderId: "42222222-2222-4222-8222-222222222222",
          paymentIntentId: "43333333-3333-4333-8333-333333333333",
          status: "active",
          nextCycleAt: "2026-07-05T12:00:00.000Z",
          cadenceDays: 30,
          replayed: false,
        },
      },
      error: null,
    });
    const port = createManagedSubscriptionRuntimePort({ rpc });

    await expect(
      port.activateSubscriptionFromPaidCheckoutOrder({
        idempotencyKey: "activate-sub-1",
        orderId: "42222222-2222-4222-8222-222222222222",
        paymentIntentId: "43333333-3333-4333-8333-333333333333",
        paymentMethodRef: "pm_reusable",
        paymentMethodKind: "opaque_psp",
        paidAt: "2026-06-05T12:00:00.000Z",
      }),
    ).resolves.toMatchObject({
      subscriptionActivation: {
        subscriptionId: "41111111-1111-4111-8111-111111111111",
        replayed: false,
      },
    });

    expect(rpc).toHaveBeenCalledWith("subscription_activate_from_paid_checkout_order", {
      p_idempotency_key: "activate-sub-1",
      p_order_id: "42222222-2222-4222-8222-222222222222",
      p_payment_intent_id: "43333333-3333-4333-8333-333333333333",
      p_payment_method_ref: "pm_reusable",
      p_payment_method_kind: "opaque_psp",
      p_paid_at: "2026-06-05T12:00:00.000Z",
    });
  });

  it("calls the dunning RPC with final failure as expired", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: {
        contractVersion: "commerce.v0",
        subscriptionDunning: {
          caseId: "41111111-1111-4111-8111-111111111111",
          subscriptionId: "42222222-2222-4222-8222-222222222222",
          cycleId: "43333333-3333-4333-8333-333333333333",
          orderId: "44444444-4444-4444-8444-444444444444",
          paymentIntentId: "45555555-5555-4555-8555-555555555555",
          status: "expired",
          retryAttempt: 4,
          nextRetryAt: null,
          customerNotificationQueued: true,
          adminNotificationCount: 0,
          recoveryTokenPurpose: "resume_subscription",
          recoveryUrlPath: `/konto/platnosc/napraw?token=${recoveryToken}`,
          replayed: false,
        },
      },
      error: null,
    });
    const port = createManagedSubscriptionRuntimePort({ rpc });

    await expect(
      port.handleSubscriptionPaymentFailure({
        idempotencyKey: "dunning-final-1",
        cycleId: "43333333-3333-4333-8333-333333333333",
        subscriptionId: "42222222-2222-4222-8222-222222222222",
        orderId: "44444444-4444-4444-8444-444444444444",
        paymentIntentId: "45555555-5555-4555-8555-555555555555",
        retryAttempt: 4,
        nextRetryAt: null,
        failureReason: "card_declined",
        occurredAt: "2026-06-05T12:00:00.000Z",
      }),
    ).resolves.toMatchObject({
      subscriptionDunning: {
        status: "expired",
        recoveryTokenPurpose: "resume_subscription",
      },
    });

    expect(rpc).toHaveBeenCalledWith("subscription_handle_payment_failure_dunning", {
      p_idempotency_key: "dunning-final-1",
      p_cycle_id: "43333333-3333-4333-8333-333333333333",
      p_subscription_id: "42222222-2222-4222-8222-222222222222",
      p_order_id: "44444444-4444-4444-8444-444444444444",
      p_payment_intent_id: "45555555-5555-4555-8555-555555555555",
      p_retry_attempt: 4,
      p_next_retry_at: null,
      p_failure_reason: "card_declined",
      p_occurred_at: "2026-06-05T12:00:00.000Z",
    });
  });

  it("calls the expired resume RPC with fresh cycle/order snapshots", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: {
        contractVersion: "commerce.v0",
        subscriptionDunningResume: {
          caseId: "41111111-1111-4111-8111-111111111111",
          subscriptionId: "42222222-2222-4222-8222-222222222222",
          previousCycleId: "43333333-3333-4333-8333-333333333333",
          cycleOrder: {
            subscriptionId: "42222222-2222-4222-8222-222222222222",
            cycleId: "46666666-6666-4666-8666-666666666666",
            cycleNumber: 5,
            orderId: "order_47777777-7777-4777-8777-777777777777",
            paymentId: "payment_48888888-8888-4888-8888-888888888888",
            status: "payment_pending",
            outboxEventType: "commerce.subscription_payment.requested",
            idempotencyKey: "resume-expired-1:cycle_order",
            replayed: false,
          },
          replayed: false,
        },
      },
      error: null,
    });
    const port = createManagedSubscriptionRuntimePort({ rpc });
    const templateSnapshot = { cadence_days: 30, lines: [{ variant_id: "sku-1", qty: 1 }] };
    const pricingSnapshot = { source: "test" };
    const orderSnapshot = {
      contractVersion: "commerce.v0",
      source: "subscription.own_engine.v0",
      status: "pending_payment",
      paymentStatus: "pending",
      currency: "XTS",
      taxIncluded: true,
      lines: [{ sku: "SKU-001", quantity: 1 }],
      totals: { totalGross: { amountMinor: 1290, currency: "XTS" } },
    };

    await expect(
      port.resumeSubscriptionFromExpiredDunning({
        idempotencyKey: "resume-expired-1",
        recoveryToken,
        paymentMethodRef: "pm_reusable",
        paymentMethodKind: "opaque_psp",
        cycleNumber: 5,
        scheduledAt: "2026-06-05T12:00:00.000Z",
        templateSnapshot,
        pricingSnapshot,
        orderSnapshot,
        requestedAt: "2026-06-05T12:00:00.000Z",
      }),
    ).resolves.toMatchObject({
      subscriptionDunningResume: {
        previousCycleId: "43333333-3333-4333-8333-333333333333",
        cycleOrder: { cycleNumber: 5, status: "payment_pending" },
      },
    });

    expect(rpc).toHaveBeenCalledWith("subscription_resume_from_dunning_with_cycle_order", {
      p_idempotency_key: "resume-expired-1",
      p_recovery_token: recoveryToken,
      p_payment_method_ref: "pm_reusable",
      p_payment_method_kind: "opaque_psp",
      p_cycle_number: 5,
      p_scheduled_at: "2026-06-05T12:00:00.000Z",
      p_template_snapshot: templateSnapshot,
      p_pricing_snapshot: pricingSnapshot,
      p_order_snapshot: orderSnapshot,
      p_requested_at: "2026-06-05T12:00:00.000Z",
    });
  });

  it("maps subscription RPC conflicts to domain conflicts", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: { code: "23505", message: "subscription_activation_idempotency_conflict" },
    });
    const port = createManagedSubscriptionRuntimePort({ rpc });

    await expect(
      port.activateSubscriptionFromPaidCheckoutOrder({
        idempotencyKey: "activate-sub-1",
        orderId: "42222222-2222-4222-8222-222222222222",
        paymentIntentId: "43333333-3333-4333-8333-333333333333",
        paymentMethodRef: "pm_reusable",
        paymentMethodKind: "opaque_psp",
        paidAt: "2026-06-05T12:00:00.000Z",
      }),
    ).rejects.toMatchObject({ name: "SubscriptionRuntimeConflictError" });
  });
});
