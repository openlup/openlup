import { describe, expect, it } from "vitest";
import type { CustomerAccountV2Response } from "../../../src/domains/customers/accountV2Contracts.js";
import { buildActionRequired } from "./customerAccountActionRequiredReadModel.js";

const subscriptionId = "11111111-1111-4111-8111-111111111111";
const now = "2026-07-03T10:00:00.000Z";

describe("customer account action-required payment method lifecycle", () => {
  it("does not ask for a new method when the renewal method is still chargeable", () => {
    expect(buildActionRequired([
      subscription({ paymentMethodKind: "card", paymentMethodStatus: "expiring" }),
    ], [])).toEqual([]);
  });

  it("surfaces non-chargeable rich payment statuses even when legacy kind exists", () => {
    const actions = buildActionRequired([
      subscription({ paymentMethodKind: "card", paymentMethodStatus: "requires_action" }),
    ], []);

    expect(actions).toEqual([
      expect.objectContaining({
        actionId: `subscription:${subscriptionId}:payment_method_missing`,
        kind: "payment_method_missing",
        blockedReason: "missing_payment_method",
        failureCause: "unknown" as const,
        recoveryEligible: false,
        dueAt: now,
      }),
    ]);
  });

  it("keeps existing dunning recovery state higher priority than missing-method hints", () => {
    const actions = buildActionRequired(
      [subscription({ paymentMethodKind: "card", paymentMethodStatus: "revoked" })],
      [],
      new Map([
        [
          subscriptionId,
          {
            subscriptionId,
            orderId: "order-1",
            blockedReason: "payment_blocked",
            failureCause: "unknown" as const,
            recoveryEligible: true,
            dueAt: now,
            nextRetryAt: now,
          },
        ],
      ]),
    );

    expect(actions).toEqual([
      expect.objectContaining({
        actionId: `subscription:${subscriptionId}:payment_blocked`,
        kind: "payment_recovery",
        cta: "repair_payment",
      }),
    ]);
  });

  it("tells an expired dunning journey apart from one that is still retrying", () => {
    const actions = buildActionRequired(
      [subscription({ status: "paused", paymentMethodKind: "card", paymentMethodStatus: "revoked" })],
      [],
      new Map([[
        subscriptionId,
        {
          subscriptionId,
          orderId: "22222222-2222-4222-8222-222222222222",
          blockedReason: "payment_expired" as const,
          failureCause: "unknown" as const,
          recoveryEligible: true,
          dueAt: now,
          nextRetryAt: null,
        },
      ]]),
    );

    // A terminal case must not borrow the open case's promise. Nothing is
    // retrying, so `nextRetryAt` stays null and the copy says the retries are
    // spent rather than "blocked until the method is recovered".
    expect(actions).toEqual([
      expect.objectContaining({
        actionId: `subscription:${subscriptionId}:payment_expired`,
        kind: "payment_recovery",
        messageCode: "payment_expired",
        blockedReason: "payment_expired",
        failureCause: "unknown" as const,
        cta: "repair_payment",
        recoveryEligible: true,
        nextRetryAt: null,
      }),
    ]);
    expect(actions[0].body).toContain("skipped");
  });

  it("distinguishes a paid initial order missing its mandate from unpaid checkout", () => {
    const actions = buildActionRequired(
      [subscription({ status: "pending_activation", paymentMethodKind: null, paymentMethodStatus: "missing" })],
      [],
      new Map([[
        subscriptionId,
        {
          subscriptionId,
          orderId: "22222222-2222-4222-8222-222222222222",
          blockedReason: "subscription_activation_missing_mandate",
          failureCause: "unknown" as const,
          recoveryEligible: false,
          dueAt: now,
          nextRetryAt: null,
        },
      ]]),
    );

    expect(actions).toEqual([expect.objectContaining({
      actionId: `subscription:${subscriptionId}:activation_missing_mandate`,
      messageCode: "subscription_activation_missing_mandate",
      cta: "repair_payment",
      orderId: "22222222-2222-4222-8222-222222222222",
    })]);
  });

  it("keeps paid activation repair actions bound to the exact subscription", () => {
    const otherSubscriptionId = "33333333-3333-4333-8333-333333333333";
    const targetOrderId = "44444444-4444-4444-8444-444444444444";
    const actions = buildActionRequired(
      [
        subscription(),
        subscription({
          subscriptionId: otherSubscriptionId,
          status: "pending_activation",
          paymentMethodKind: null,
          paymentMethodStatus: "missing",
        }),
      ],
      [],
      new Map([[
        otherSubscriptionId,
        {
          subscriptionId: otherSubscriptionId,
          orderId: targetOrderId,
          blockedReason: "subscription_activation_missing_mandate",
          failureCause: "unknown" as const,
          recoveryEligible: false,
          dueAt: now,
          nextRetryAt: null,
        },
      ]]),
    );

    expect(actions).toEqual([expect.objectContaining({
      actionId: `subscription:${otherSubscriptionId}:activation_missing_mandate`,
      entityId: otherSubscriptionId,
      subscriptionId: otherSubscriptionId,
      orderId: targetOrderId,
      cta: "repair_payment",
    })]);
    expect(actions).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ subscriptionId }),
    ]));
  });
});

function subscription(
  patch: Partial<CustomerAccountV2Response["subscriptions"][number]> = {},
): CustomerAccountV2Response["subscriptions"][number] {
  return {
    subscriptionId,
    petId: null,
    shippingAddressId: null,
    status: "active",
    pausePreset: null,
    pauseStartedAt: null,
    pauseEndsAt: null,
    cadenceDays: 28,
    nextCycleAt: now,
    editCutoffAt: now,
    canEditUpcomingPackage: true,
    editBlockedReason: null,
    paymentMethodKind: "card",
    paymentMethodStatus: "usable",
    templateVersion: 1,
    sizeConstraint: null,
    packageSummary: "1 recipe",
    recurringPrice: null,
    lines: [],
    ...patch,
  };
}
