import { describe, expect, it, vi } from "vitest";
import { runPaymentProviderReconciliationWorker } from "@openlup/platform/payments";
import type { ClaimedPaymentAttempt, ProviderReconciliationStatus } from "@openlup/platform/payments/contracts";

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
      occurredAt: "2026-10-20T10:01:00.000Z", amountMinor: 9000, currency: "XXX" });
    await f.run();
    expect(f.port.applyTerminalResult).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      expectedOrderId: "order-original", expectedPaymentIntentId: "intent-original", expectedPaymentAttemptId: "attempt-original",
      expectedPaymentId: "payment-original", resultStatus: "succeeded", occurredAt: "2026-10-20T10:01:00.000Z",
    }));
  });

  it.each([{ amountMinor: 8999, currency: "XXX" }, { amountMinor: 9000, currency: "invalid" }])(
    "refuses terminal money drift %j after an earlier ambiguous observation", async (money) => {
      const f = fixture(); f.port.claimStaleAttempts.mockResolvedValue([attempt]);
      await f.run();
      f.readPayment.mockResolvedValue({ ...reading, status: "succeeded", providerStatus: "succeeded", ...money });
      const result = await f.run();
      expect(result).toMatchObject({ manualReview: 1, amountCurrencyMismatches: 1, corrected: 0 });
      expect(f.port.applyTerminalResult).not.toHaveBeenCalled();
      expect(f.port.recordEvidence.mock.calls[1][0]).toMatchObject({ correctionStatus: "failed",
        payload: expect.objectContaining({ applied: false }) });
    });
});
