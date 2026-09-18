import { describe, expect, it, vi } from "vitest";
import type { ProviderReconciliationStatus } from "./paymentProviderReconciliationContracts.js";
import {
  verifyPaymentAttemptNow,
  type VerifiableAttemptSnapshot,
} from "./paymentVerifyNowService.js";

const snapshot: VerifiableAttemptSnapshot = {
  orderId: "11111111-1111-4111-8111-111111111111",
  orderClientId: "22222222-2222-4222-8222-222222222222",
  orderMode: "one_time_order",
  paymentIntentId: "33333333-3333-4333-8333-333333333333",
  intentStatus: "processing",
  intentProviderPaymentId: null,
  paymentAttemptId: "44444444-4444-4444-8444-444444444444",
  paymentId: "55555555-5555-4555-8555-555555555555",
  attemptStatus: "processing",
  provider: "stripe",
  providerAttemptId: "pi_existing",
  providerSessionId: null,
  amountMinor: 1_299,
  currency: "PLN",
  localUpdatedAt: "2026-07-27T10:00:00.000Z",
};

describe("verifyPaymentAttemptNow", () => {
  it("reuses a supplied recovery read without calling the provider again", async () => {
    const readPayment = vi.fn();
    const applyTerminalResult = vi.fn();
    const providerStatus: ProviderReconciliationStatus = {
      status: "pending",
      providerStatus: "processing",
      occurredAt: null,
      failureReason: null,
      amountMinor: 1_299,
      currency: "PLN",
      rawPayload: {},
    };

    await expect(verifyPaymentAttemptNow({
      snapshot,
      applyPort: { applyTerminalResult } as never,
      providers: { stripe: { readPayment } } as never,
      providerPaymentId: "pi_existing",
      providerStatus,
      now: () => new Date("2026-07-27T10:01:00.000Z"),
    })).resolves.toMatchObject({
      status: "pending",
      verified: true,
      applied: false,
    });
    expect(readPayment).not.toHaveBeenCalled();
    expect(applyTerminalResult).not.toHaveBeenCalled();
  });
});
