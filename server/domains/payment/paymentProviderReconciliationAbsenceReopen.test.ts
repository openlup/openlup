import { describe, expect, it, vi } from "vitest";
import { runPaymentProviderReconciliationWorker } from "./paymentProviderReconciliationWorker.js";
import type {
  ClaimedPaymentAttempt,
  PaymentProviderReconciliationPort,
} from "./paymentProviderReconciliationContracts.js";

const NOW = "2026-07-03T10:00:00.000Z";

// Companion tests for paymentProviderReconciliationAbsenceReopen.ts. The hook
// is exercised through the worker entry (runPaymentProviderReconciliationWorker
// with autoReopenPreparedAbsence) because the worker's prepared-attempts loop
// owns the evidence ordering the reopen RPC's preconditions depend on.

describe("prepared-absence auto-reopen", () => {
  const preparedOverrides = {
    attemptStatus: "created",
    providerPaymentId: null,
    providerAttemptId: null,
    providerSessionId: null,
    localUpdatedAt: "2026-07-03T09:00:00.000Z", // 60 min before NOW
  } as const;

  it("reopens a stranded prepared attempt when the flag is on and the provider proves absence", async () => {
    const attempt = claimedAttempt(preparedOverrides);
    const port = fakePort([], [], [attempt]);
    const findPaymentByLocalIntent = vi.fn(async () => "absent" as const);

    const result = await runPaymentProviderReconciliationWorker({
      port,
      providers: { stripe: { readPayment: vi.fn(), findPaymentByLocalIntent } },
      now: NOW,
      autoReopenPreparedAbsence: true,
    });

    expect(findPaymentByLocalIntent).toHaveBeenCalledWith({ attempt });
    expect(port.reopenPreparedAttemptAfterAbsence).toHaveBeenCalledWith({
      idempotencyKey: `payment-provider-reconciliation:${attempt.paymentAttemptId}:absence-reopen`,
      paymentAttemptId: attempt.paymentAttemptId,
      expectedPaymentIntentId: attempt.paymentIntentId,
      expectedSubscriptionCycleId: attempt.subscriptionCycleId,
      operatorRef: "payment-provider-reconciliation@auto",
      absenceCheckedAt: NOW,
      nextRetryAt: NOW,
      absenceEvidence: {
        providerAbsenceConfirmed: true,
        source: "payment-provider-reconciliation.auto-reopen.v0",
        basis: "stripe_intent_correlated_search_absent",
        probedAt: NOW,
      },
    });
    // The stranded attempt still counts as a failure signal for the watchdog;
    // the reopen is an additional remediation counter, not a silencer.
    expect(result).toMatchObject({
      ok: false,
      preparedWithoutProviderAck: 1,
      preparedAttemptsReopened: 1,
      failures: 1,
    });
  });

  it("does not reopen when the flag is off (default)", async () => {
    const attempt = claimedAttempt(preparedOverrides);
    const port = fakePort([], [], [attempt]);
    const findPaymentByLocalIntent = vi.fn(async () => "absent" as const);

    const result = await runPaymentProviderReconciliationWorker({
      port,
      providers: { stripe: { readPayment: vi.fn(), findPaymentByLocalIntent } },
      now: NOW,
    });

    expect(findPaymentByLocalIntent).not.toHaveBeenCalled();
    expect(port.reopenPreparedAttemptAfterAbsence).not.toHaveBeenCalled();
    expect(result.preparedAttemptsReopened).toBe(0);
  });

  it("keeps one-time prepared attempts operator-manual even when auto-reopen is enabled", async () => {
    const attempt = claimedAttempt({
      ...preparedOverrides,
      orderMode: "one_time",
      subscriptionId: null,
      subscriptionCycleId: null,
    });
    const port = fakePort([], [], [attempt]);
    const readPayment = vi.fn();
    const findPaymentByLocalIntent = vi.fn(async () => "absent" as const);

    const result = await runPaymentProviderReconciliationWorker({
      port,
      providers: { stripe: { readPayment, findPaymentByLocalIntent } },
      now: NOW,
      autoReopenPreparedAbsence: true,
    });

    expect(readPayment).not.toHaveBeenCalled();
    expect(findPaymentByLocalIntent).not.toHaveBeenCalled();
    expect(port.reopenPreparedAttemptAfterAbsence).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      preparedWithoutProviderAck: 1,
      preparedAttemptsReopened: 0,
      providerCalls: 0,
    });
  });

  it("does not reopen when the provider payment is FOUND (crash-after-charge window) and records operator evidence", async () => {
    const attempt = claimedAttempt(preparedOverrides);
    const port = fakePort([], [], [attempt]);

    const result = await runPaymentProviderReconciliationWorker({
      port,
      providers: {
        stripe: { readPayment: vi.fn(), findPaymentByLocalIntent: vi.fn(async () => "found" as const) },
      },
      now: NOW,
      autoReopenPreparedAbsence: true,
    });

    expect(port.reopenPreparedAttemptAfterAbsence).not.toHaveBeenCalled();
    expect(result.preparedAttemptsReopened).toBe(0);
    expect(port.recordEvidence).toHaveBeenCalledWith(expect.objectContaining({
      providerStatus: "provider_payment_found_after_prepare",
      correctionStatus: "observed",
      payload: expect.objectContaining({
        providerAbsenceConfirmed: false,
        operatorReviewRequired: true,
        reopenBlocked: "provider_payment_exists",
      }),
    }));
  });

  it("silently skips attempts younger than the stranded-age guard", async () => {
    const attempt = claimedAttempt({ ...preparedOverrides, localUpdatedAt: "2026-07-03T09:45:00.000Z" });
    const port = fakePort([], [], [attempt]);
    const findPaymentByLocalIntent = vi.fn(async () => "absent" as const);

    const result = await runPaymentProviderReconciliationWorker({
      port,
      providers: { stripe: { readPayment: vi.fn(), findPaymentByLocalIntent } },
      now: NOW,
      autoReopenPreparedAbsence: true,
    });

    expect(findPaymentByLocalIntent).not.toHaveBeenCalled();
    expect(port.reopenPreparedAttemptAfterAbsence).not.toHaveBeenCalled();
    expect(result.preparedAttemptsReopened).toBe(0);
  });

  it("skips providers without an absence probe (Tpay stays operator-manual)", async () => {
    const attempt = claimedAttempt({ ...preparedOverrides, provider: "tpay" });
    const port = fakePort([], [], [attempt]);

    const result = await runPaymentProviderReconciliationWorker({
      port,
      providers: { tpay: { readPayment: vi.fn() } },
      now: NOW,
      autoReopenPreparedAbsence: true,
    });

    expect(port.reopenPreparedAttemptAfterAbsence).not.toHaveBeenCalled();
    expect(result.preparedAttemptsReopened).toBe(0);
  });

  it("tolerates RPC precondition rejects as observed evidence without failing the pass harder", async () => {
    const attempt = claimedAttempt(preparedOverrides);
    const port = fakePort([], [], [attempt]);
    (port.reopenPreparedAttemptAfterAbsence as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("commerce_payment_control_reopen_prepared_attempt_after_absence: prepared_attempt_absence_reopen_too_fresh 22023"),
    );

    const result = await runPaymentProviderReconciliationWorker({
      port,
      providers: {
        stripe: { readPayment: vi.fn(), findPaymentByLocalIntent: vi.fn(async () => "absent" as const) },
      },
      now: NOW,
      autoReopenPreparedAbsence: true,
    });

    expect(result.preparedAttemptsReopened).toBe(0);
    expect(result.failures).toBe(1); // only the stranded-attempt failure, no extra
    expect(port.recordEvidence).toHaveBeenCalledWith(expect.objectContaining({
      providerStatus: "absence_reopen_precondition_reject",
      correctionStatus: "observed",
    }));
  });

  it("records probe failures as observed evidence and does not reopen", async () => {
    const attempt = claimedAttempt(preparedOverrides);
    const port = fakePort([], [], [attempt]);

    const result = await runPaymentProviderReconciliationWorker({
      port,
      providers: {
        stripe: {
          readPayment: vi.fn(),
          findPaymentByLocalIntent: vi.fn(async () => {
            throw new Error("stripe_search_unavailable");
          }),
        },
      },
      now: NOW,
      autoReopenPreparedAbsence: true,
    });

    expect(port.reopenPreparedAttemptAfterAbsence).not.toHaveBeenCalled();
    expect(result.preparedAttemptsReopened).toBe(0);
    expect(port.recordEvidence).toHaveBeenCalledWith(expect.objectContaining({
      providerStatus: "absence_probe_failed",
      correctionStatus: "observed",
      payload: expect.objectContaining({ probeError: "stripe_search_unavailable" }),
    }));
  });
});

function fakePort(
  attempts: ClaimedPaymentAttempt[],
  calls: string[] = [],
  preparedAttempts: ClaimedPaymentAttempt[] = [],
): PaymentProviderReconciliationPort {
  return {
    claimPreparedAttempts: vi.fn(async () => preparedAttempts),
    claimStaleAttempts: vi.fn(async () => attempts),
    recordEvidence: vi.fn(async () => {
      calls.push("evidence");
      return { replayed: false };
    }),
    applyTerminalResult: vi.fn(async () => {
      throw new Error("unexpected terminal result");
    }),
    reopenPreparedAttemptAfterAbsence: vi.fn(async () => {
      calls.push("reopen");
      return { replayed: false };
    }),
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
