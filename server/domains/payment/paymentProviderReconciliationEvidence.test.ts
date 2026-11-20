import { describe, expect, it } from "vitest";
import {
  applyResultKey,
  evidencePayload,
  observedEvidenceKey,
  terminalAmountMismatch,
} from "./paymentProviderReconciliationEvidence.js";
import type {
  ClaimedPaymentAttempt,
  ProviderReconciliationStatus,
} from "./paymentProviderReconciliationContracts.js";

describe("paymentProviderReconciliationEvidence", () => {
  it("builds deterministic keys and sanitized evidence payloads", () => {
    const attempt = claimedAttempt();
    const providerStatus = status();

    expect(applyResultKey(attempt, "succeeded")).toBe(
      `payment-provider-reconciliation:${attempt.paymentAttemptId}:apply:succeeded`,
    );
    expect(observedEvidenceKey(
      attempt,
      "pending",
      "observed",
      "2026-07-03T10:29:59.000Z",
    )).toContain(":observed:pending:");
    expect(evidencePayload(attempt, providerStatus, { applied: false })).toMatchObject({
      source: "payment-provider-reconciliation.v0",
      provider: "stripe",
      providerPayload: { status: "processing" },
      applied: false,
    });
  });

  it("fails terminal correction on amount/currency drift", () => {
    const attempt = claimedAttempt({ amountMinor: 1200, currency: "PLN" });

    expect(terminalAmountMismatch(attempt, status({ amountMinor: 1300 }))).toBe("provider_amount_mismatch");
    expect(terminalAmountMismatch(attempt, status({ currency: "EUR" }))).toBe("provider_currency_mismatch");
    expect(terminalAmountMismatch(attempt, status())).toBeNull();
  });
});

function status(overrides: Partial<ProviderReconciliationStatus> = {}): ProviderReconciliationStatus {
  return {
    status: "pending",
    providerStatus: "processing",
    occurredAt: null,
    failureReason: null,
    amountMinor: 1200,
    currency: "PLN",
    rawPayload: { status: "processing" },
    ...overrides,
  };
}

function claimedAttempt(overrides: Partial<ClaimedPaymentAttempt> = {}): ClaimedPaymentAttempt {
  return {
    paymentAttemptId: "11111111-1111-4111-8111-111111111111",
    paymentIntentId: "22222222-2222-4222-8222-222222222222",
    paymentId: "33333333-3333-4333-8333-333333333333",
    orderId: "44444444-4444-4444-8444-444444444444",
    subscriptionId: "55555555-5555-4555-8555-555555555555",
    subscriptionCycleId: "66666666-6666-4666-8666-666666666666",
    provider: "stripe",
    providerPaymentId: "pi_test",
    providerAttemptId: "pi_test",
    providerSessionId: "pi_test",
    attemptStatus: "processing",
    intentStatus: "processing",
    amountMinor: 1200,
    currency: "PLN",
    orderMode: "subscription_cycle",
    cycleRetryAttempt: 0,
    cycleNextRetryAt: null,
    localUpdatedAt: "2026-07-03T09:30:00.000Z",
    ...overrides,
  };
}
