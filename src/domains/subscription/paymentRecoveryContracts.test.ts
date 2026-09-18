import { describe, expect, it } from "vitest";
import {
  SUBSCRIPTION_PAYMENT_RECOVERY_CONTRACT_VERSION,
  subscriptionPaymentRecoveryRequestSchema,
  subscriptionPaymentRecoveryResponseSchema,
} from "./paymentRecoveryContracts.js";

describe("subscription payment recovery contracts", () => {
  it("accepts opaque token plus provider-neutral reusable payment method reference", () => {
    expect(
      subscriptionPaymentRecoveryRequestSchema.parse({
        recoveryToken: "a".repeat(64),
        paymentMethodRef: "pm_reusable_123",
        paymentMethodKind: "card",
      }),
    ).toEqual({
      recoveryToken: "a".repeat(64),
      paymentMethodRef: "pm_reusable_123",
      paymentMethodKind: "card",
    });
  });

  it("represents open retry and expired resume outcomes without naming a PSP", () => {
    const response = {
      contractVersion: SUBSCRIPTION_PAYMENT_RECOVERY_CONTRACT_VERSION,
      recovery: {
        caseId: "11111111-1111-4111-8111-111111111111",
        subscriptionId: "22222222-2222-4222-8222-222222222222",
        cycleId: "33333333-3333-4333-8333-333333333333",
        nextAction: "retry_existing_cycle",
        replayed: false,
      },
    };

    expect(subscriptionPaymentRecoveryResponseSchema.parse(response)).toEqual(response);
    expect(
      subscriptionPaymentRecoveryResponseSchema.parse({
        ...response,
        recovery: { ...response.recovery, nextAction: "resume_subscription" },
      }).recovery.nextAction,
    ).toBe("resume_subscription");
  });
});
