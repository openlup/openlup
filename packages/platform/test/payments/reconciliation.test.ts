import { describe, expect, it, vi } from "vitest";
import {
  createCheckoutRecoveryPaymentResolver,
  runPaymentProviderReconciliationWorker,
  verifyPaymentAttemptNow,
} from "@openlup/platform/payments";
import type {
  ClaimedPaymentAttempt,
  ProviderReconciliationStatus,
  VerifiableAttemptSnapshot,
} from "@openlup/platform/payments/contracts";

// Pins current behavior for OSS M07 extraction; must not change with refactors.
// Imports stay payment-domain only. Native tests retain absence admission/locking proof.
const NOW = "2026-10-21T10:00:00.000Z";
const attempt: ClaimedPaymentAttempt = { paymentAttemptId: "attempt-original", paymentIntentId: "intent-original",
  paymentId: "payment-original", orderId: "order-original", subscriptionId: "sub-original", subscriptionCycleId: "cycle-original",
  provider: "provider-a", providerPaymentId: "remote-original", providerAttemptId: "remote-original", providerSessionId: null,
  attemptStatus: "processing", intentStatus: "processing", amountMinor: 9000, currency: "XXX", orderMode: "subscription_cycle",
  cycleRetryAttempt: 1, cycleNextRetryAt: null, localUpdatedAt: "2026-10-20T10:00:00.000Z" };
const reading: ProviderReconciliationStatus = { status: "unknown", providerStatus: "unknown", occurredAt: null,
  failureReason: null, amountMinor: null, currency: null, rawPayload: {} };
function fixture() {
  const port = { claimPreparedAttempts: vi.fn().mockResolvedValue([]), claimStaleAttempts: vi.fn().mockResolvedValue([]),
    recordEvidence: vi.fn().mockResolvedValue({ replayed: false }),
    reopenPreparedAttemptAfterAbsence: vi.fn().mockResolvedValue({ replayed: false }),
    applyTerminalResult: vi.fn().mockResolvedValue({ replayed: false, correctionStatus: "corrected", subscriptionWebhookDunning: null }) };
  const readPayment = vi.fn().mockResolvedValue(reading);
  const run = (probe?: () => Promise<"found" | "absent">) => runPaymentProviderReconciliationWorker({ port,
    providers: { "provider-a": { readPayment, ...(probe ? { findPaymentByLocalIntent: probe } : {}) } }, now: NOW,
    autoReopenPreparedAbsence: true, capabilities: { get: () => ({ terminalOutcomeReporting: {
      kind: "status_field", silenceBecomesSuspectAfterMinutes: 60 } }) } } as never);
  return { port, readPayment, run };
}

describe("payment ambiguity boundary characterization", () => {
  it("keeps watchdog no-ack, a failed probe and a later found payment away from money and reopen", async () => {
    const f = fixture();
    f.port.claimPreparedAttempts.mockResolvedValue([{ ...attempt, providerPaymentId: null, providerAttemptId: null, attemptStatus: "created" }]);
    await f.run();
    const probe = vi.fn<() => Promise<"found" | "absent">>().mockRejectedValueOnce(new Error("lookup_timeout")).mockResolvedValueOnce("found");
    await f.run(probe); await f.run(probe);
    expect(f.port.recordEvidence.mock.calls.map(([input]) => input.providerStatus)).toEqual([
      "prepared_without_provider_ack", "prepared_without_provider_ack", "absence_probe_failed",
      "prepared_without_provider_ack", "provider_payment_found_after_prepare",
    ]);
    expect(f.port.reopenPreparedAttemptAfterAbsence).not.toHaveBeenCalled();
    expect(f.readPayment).not.toHaveBeenCalled(); expect(f.port.applyTerminalResult).not.toHaveBeenCalled();
  });

  it("reopens only correlated absence, then keeps overdue unknown nonfinancial until exact late readback", async () => {
    const f = fixture();
    f.port.claimPreparedAttempts.mockResolvedValueOnce([{ ...attempt, providerPaymentId: null, providerAttemptId: null, attemptStatus: "created" }]);
    const absent = vi.fn(async (): Promise<"absent"> => "absent");
    await f.run(absent);
    expect(f.port.reopenPreparedAttemptAfterAbsence).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      paymentAttemptId: "attempt-original", expectedPaymentIntentId: "intent-original", expectedSubscriptionCycleId: "cycle-original",
      absenceEvidence: expect.objectContaining({ providerAbsenceConfirmed: true }),
    }));
    f.port.claimStaleAttempts.mockResolvedValue([attempt]);
    const unknown = await f.run();
    expect(unknown).toMatchObject({ unknown: 1, manualReview: 1, silenceOverdue: 1, corrected: 0 });
    expect(f.port.applyTerminalResult).not.toHaveBeenCalled();
    f.readPayment.mockResolvedValue({ ...reading, status: "succeeded", providerStatus: "succeeded",
      occurredAt: "2026-10-20T10:01:00.000Z", amountMinor: 9000, currency: "XXX", capturedAmountBasis: "provider_capture_v1" });
    await f.run();
    expect(f.port.applyTerminalResult).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      expectedOrderId: "order-original", expectedPaymentIntentId: "intent-original", expectedPaymentAttemptId: "attempt-original",
      expectedPaymentId: "payment-original", resultStatus: "succeeded", occurredAt: "2026-10-20T10:01:00.000Z",
    }));
  });

  it("counts a committed capture review without counting a correction or failure", async () => {
    const f = fixture();
    f.port.claimStaleAttempts.mockResolvedValue([attempt]);
    f.readPayment.mockResolvedValue({ ...reading, status: "succeeded", providerStatus: "succeeded",
      occurredAt: NOW, amountMinor: 9000, currency: "XXX", capturedAmountBasis: "provider_capture_v1" });
    f.port.applyTerminalResult.mockResolvedValue({ correctionStatus: "ignored", replayed: false,
      paymentResult: { kind: "ignored_success_requiring_review" } });
    expect(await f.run()).toMatchObject({ ignored: 1, manualReview: 1, corrected: 0, succeeded: 0, failures: 0 });
    expect(f.port.recordEvidence).not.toHaveBeenCalled();
  });

  it.each([
    [{ amountMinor: 8999, currency: "XXX" }, "provider_amount_mismatch"],
    [{ amountMinor: 9000, currency: "invalid" }, "provider_currency_mismatch"],
    [{ amountMinor: null, currency: "XXX" }, "provider_amount_missing"],
    [{ amountMinor: 0, currency: "XXX" }, "provider_amount_mismatch"],
    [{ amountMinor: 9000, currency: null }, "provider_currency_missing"],
    [{ amountMinor: 9000, currency: " " }, "provider_currency_missing"],
  ] as const)(
    "refuses incomplete or mismatched success money %j after an earlier ambiguous observation", async (money, reason) => {
      const f = fixture(); f.port.claimStaleAttempts.mockResolvedValue([attempt]);
      await f.run();
      f.readPayment.mockResolvedValue({ ...reading, status: "succeeded", providerStatus: "succeeded", capturedAmountBasis: "provider_capture_v1", ...money });
      const result = await f.run();
      expect(result).toMatchObject({ manualReview: 1, amountCurrencyMismatches: 1, corrected: 0 });
      expect(f.port.applyTerminalResult).not.toHaveBeenCalled();
      expect(f.port.recordEvidence.mock.calls[1][0]).toMatchObject({ correctionStatus: "failed",
        payload: expect.objectContaining({ applied: false, failureReason: reason }) });
    });
});

describe("released 1.2.0 readback compatibility", () => {
  // c6419ad88:packages/platform/src/payments/paymentProviderReconciliationEvidence.ts:33-44
  // checks a non-null amount first, then a truthy currency case-insensitively.
  // Worker: paymentProviderReconciliationWorker.ts:193-224.
  // Verify-now: paymentVerifyNowService.ts:53-85.
  // Recovery: checkoutRecoveryPaymentResolver.ts:75-104.
  it.each([
    ["matching", { currency: "xxx" }, null, "succeeded", "paid", "succeeded"],
    ["amount mismatch before currency", { amountMinor: 8999, currency: "YYY" }, "provider_amount_mismatch", "manual_review", "manual_review", null],
    ["currency mismatch", { currency: "YYY" }, "provider_currency_mismatch", "manual_review", "manual_review", null],
    ["missing amount and currency", { amountMinor: null, currency: null }, null, "succeeded", "paid", "succeeded"],
    ["empty currency", { currency: "" }, null, "succeeded", "paid", "succeeded"],
    ["blank currency", { currency: " " }, "provider_currency_mismatch", "manual_review", "manual_review", null],
    ["failed with missing money", { status: "failed", amountMinor: null, currency: null }, null, "failed", "retry_new", "failed"],
    ["failed with mismatched money", { status: "failed", amountMinor: 0 }, "provider_amount_mismatch", "manual_review", "manual_review", null],
    ["pending", { status: "pending", amountMinor: 0 }, null, "pending", "awaiting_provider", null],
    ["unknown", { status: "unknown", currency: "YYY" }, null, "pending", "awaiting_provider", null],
    ["attested matching money", { capturedAmountBasis: "provider_capture_v1" }, null, "succeeded", "paid", "succeeded"],
    ["attested missing amount", { capturedAmountBasis: "provider_capture_v1", amountMinor: null }, "provider_amount_missing", "manual_review", "manual_review", null],
    ["attested blank currency", { capturedAmountBasis: "provider_capture_v1", currency: " " }, "provider_currency_missing", "manual_review", "manual_review", null],
  ] as const)("%s through worker, verify-now and recovery", async (
    _label, override, mismatch, verifyStatus, recoveryKind, appliedStatus,
  ) => {
    const readback: ProviderReconciliationStatus = {
      ...reading, status: "succeeded", amountMinor: attempt.amountMinor, currency: attempt.currency, ...override,
    };
    readback.providerStatus = readback.status;
    const f = fixture();
    f.port.claimStaleAttempts.mockResolvedValue([attempt]);
    f.readPayment.mockResolvedValue(readback);
    const apply = f.port.applyTerminalResult;
    const expectApplication = () => {
      if (appliedStatus === null) {
        expect(apply).not.toHaveBeenCalled();
        return;
      }
      expect(apply).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ resultStatus: appliedStatus }));
      if (!("capturedAmountBasis" in override)) {
        expect(apply.mock.calls[0][0].payload).not.toHaveProperty("capturedAmountBasis");
      }
    };

    const worker = await f.run();
    expect(worker).toMatchObject({ corrected: appliedStatus === null ? 0 : 1, amountCurrencyMismatches: mismatch === null ? 0 : 1 });
    if (mismatch) {
      expect(f.port.recordEvidence).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        correctionStatus: "failed", payload: expect.objectContaining({ failureReason: mismatch }),
      }));
    } else if (verifyStatus === "pending") {
      expect(f.port.recordEvidence).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        correctionStatus: "observed", payload: expect.objectContaining({ normalizedStatus: readback.status }),
      }));
    }
    expectApplication();
    apply.mockClear();

    const snapshot: VerifiableAttemptSnapshot = {
      orderId: attempt.orderId, orderClientId: "client-original", orderMode: "one_time",
      paymentIntentId: attempt.paymentIntentId, intentStatus: attempt.intentStatus,
      paymentAttemptId: attempt.paymentAttemptId, paymentId: attempt.paymentId, attemptStatus: attempt.attemptStatus,
      provider: attempt.provider, providerAttemptId: attempt.providerAttemptId, providerSessionId: attempt.providerSessionId,
      intentProviderPaymentId: attempt.providerPaymentId, amountMinor: attempt.amountMinor, currency: attempt.currency,
      localUpdatedAt: attempt.localUpdatedAt,
    };
    const deps = {
      readPort: { readVerifiableAttempt: async () => snapshot },
      applyPort: f.port,
      providers: {
        "provider-a": {
          readPayment: f.readPayment,
          resolvePaymentReference: () => attempt.providerPaymentId,
          readRecoveryPayment: async () => ({
            status: readback, identityMatches: true, configuredMoneyMatches: true, manualReviewRequired: false, clientAction: null,
          }),
        },
      },
      now: () => new Date(NOW),
    };
    expect(await verifyPaymentAttemptNow({ ...deps, snapshot })).toMatchObject({
      status: verifyStatus, applied: appliedStatus !== null,
    });
    expectApplication();
    apply.mockClear();

    expect(await createCheckoutRecoveryPaymentResolver(deps).resolve({
      orderId: attempt.orderId, paymentIntentId: attempt.paymentIntentId,
    })).toEqual({ kind: recoveryKind });
    expectApplication();
  });
});
