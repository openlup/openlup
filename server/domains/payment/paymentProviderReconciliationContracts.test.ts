import { describe, expect, it } from "vitest";
import type {
  InteractivePreparedAttemptManualReconciliationPort,
  PaymentProviderReconciliationPort,
} from "./paymentProviderReconciliationContracts.js";

describe("payment provider reconciliation contracts", () => {
  it("accepts a reconciliation port with one atomic terminal operation", async () => {
    const port: PaymentProviderReconciliationPort & InteractivePreparedAttemptManualReconciliationPort = {
      async claimPreparedAttempts() {
        return [];
      },
      async claimStaleAttempts() {
        return [];
      },
      async recordEvidence() {
        return { replayed: false };
      },
      async applyTerminalResult(input) {
        return {
          replayed: false,
          paymentResult: {
            paymentIntentId: input.expectedPaymentIntentId,
            paymentAttemptId: input.expectedPaymentAttemptId,
            paymentId: input.expectedPaymentId,
            orderId: input.expectedOrderId,
            status: input.resultStatus,
            kind: "state_changed",
            replayed: false,
          },
          correctionStatus: "corrected",
          subscriptionWebhookDunning: null,
        };
      },
      async reopenPreparedAttemptAfterAbsence() {
        return { replayed: false };
      },
      async reopenInteractivePreparedAttemptAfterAbsence(input) {
        return {
          paymentAttemptId: input.paymentAttemptId,
          paymentIntentId: input.expectedPaymentIntentId,
          paymentAttemptStatus: "failed",
          paymentIntentStatus: "failed",
          replayed: false,
        };
      },
    };

    await expect(port.claimStaleAttempts({
      now: "2026-07-03T10:00:00.000Z",
      staleAfterSeconds: 900,
      limit: 1,
      claimKey: "claim-1",
    })).resolves.toEqual([]);
    await expect(port.claimPreparedAttempts({
      now: "2026-07-03T10:00:00.000Z",
      staleAfterSeconds: 900,
      limit: 1,
      claimKey: "claim-prepared-1",
    })).resolves.toEqual([]);
    await expect(port.applyTerminalResult({
      idempotencyKey: "apply-1",
      expectedOrderId: "order-1",
      expectedPaymentIntentId: "intent-1",
      expectedPaymentAttemptId: "attempt-1",
      expectedPaymentId: "payment-1",
      provider: "stripe",
      providerPaymentId: "pi_test",
      localStatus: "processing",
      providerStatus: "succeeded",
      resultStatus: "succeeded",
      occurredAt: "2026-07-03T10:00:00.000Z",
      failureReason: null,
      checkedAt: "2026-07-03T10:00:00.000Z",
      payload: {},
    })).resolves.toMatchObject({
      correctionStatus: "corrected",
      paymentResult: { status: "succeeded", replayed: false },
    });
    await expect(port.reopenInteractivePreparedAttemptAfterAbsence({
      idempotencyKey: "interactive-prepared-manual-absence-0001",
      paymentAttemptId: "attempt-1",
      expectedPaymentIntentId: "intent-1",
      expectedOrderId: "order-1",
      expectedSubscriptionId: "subscription-1",
      expectedSubscriptionCycleId: "cycle-1",
      operatorRef: "ops-ticket-105",
      absenceCheckedAt: "2026-08-28T12:00:00.000Z",
      absenceEvidence: {
        providerAbsenceConfirmed: true,
        watchdogEvidence: true,
        evidenceCode: "operator_verified_absence",
      },
    })).resolves.toMatchObject({
      paymentAttemptStatus: "failed",
      paymentIntentStatus: "failed",
    });
  });
});
