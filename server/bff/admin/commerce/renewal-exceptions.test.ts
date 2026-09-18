import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ObservabilitySnapshot } from "../../../../src/domains/platform/observabilityContracts.js";
import type { VercelRequest, VercelResponse } from "../../../_lib/types/vercel.js";
import handler, { createRenewalExceptionEvidencePort, mapSnapshotToRenewalExceptionEvidence } from "./renewal-exceptions.js";

const ENV_KEYS = [
  "SUPABASE_URL",
  "VITE_SUPABASE_URL",
  "VITE_SUPABASE_ANON_KEY",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("admin commerce renewal exceptions BFF route", () => {
  it("exports an observed route handler", () => {
    expect(handler).toBeTypeOf("function");
  });

  it("fails closed when Supabase env is absent", async () => {
    const res = createResponse();
    await handler(request(), res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({ code: "UPSTREAM_UNAVAILABLE" }),
    }));
  });

  it("maps subscription evidence but excludes one-time payment ambiguity from renewal exceptions", () => {
    const evidence = mapSnapshotToRenewalExceptionEvidence(snapshot());
    expect(evidence).toMatchObject({
      dueCycleWithoutOrderCount: 1,
      dueCycleEvidence: [{ kind: "due_cycle_without_order", subscriptionId: "sub-due" }],
      paymentEvidence: [{ kind: "prepared_without_provider_ack", paymentIntentId: "intent-1" }],
      fulfillmentEvidence: [{
        kind: "paid_renewal_without_fulfillment",
        orderId: "order-1",
        triageContext: expect.objectContaining({ localPaymentStatus: "succeeded" }),
      }],
    });
    expect(JSON.stringify(evidence)).not.toContain("pi_secret");
    expect(JSON.stringify(evidence)).not.toContain("evt_secret");
    expect(JSON.stringify(evidence)).not.toContain("one-time-intent");
  });

  it("composes the recovery baseline over the requested window", async () => {
    const windows: string[] = [];
    const port = createRenewalExceptionEvidencePort(
      { collectSnapshot: () => Promise.resolve(snapshot()) },
      {
        casesOpenedSince: (windowStart) => {
          windows.push(windowStart);
          return Promise.resolve([
            { id: "c-1", status: "recovered", retry_attempt: 1, payment_intent_id: "intent-1" },
            { id: "c-2", status: "expired", retry_attempt: 2, payment_intent_id: "intent-2" },
          ]);
        },
        amountsByPaymentIntentId: () => Promise.resolve([
          { id: "intent-1", amount_cents: 12_900, currency: "XTS", rail: { provider: "rail-a" } },
          { id: "intent-2", amount_cents: 12_900, currency: "XTS", rail: { provider: "rail-a" } },
        ]),
      },
    );

    const evidence = await port.collectEvidence(new Date("2026-07-03T12:00:00.000Z"), { windowDays: 30 });

    expect(windows).toEqual(["2026-06-03T12:00:00.000Z"]);
    expect(evidence.dunningRecovery).toMatchObject({
      windowDays: 30,
      recoveryRateByCount: 0.5,
      byRung: { "1": { recoveryRateByCount: 1 }, "2": { recoveryRateByCount: 0 } },
      byRail: { "rail-a": { recoveryRateByCount: 0.5 } },
    });
    // The exception rows are unchanged by the baseline riding alongside them.
    expect(evidence.dueCycleWithoutOrderCount).toBe(1);
  });

  it("serves the exception queue with an absent baseline when the baseline read fails", async () => {
    const port = createRenewalExceptionEvidencePort(
      { collectSnapshot: () => Promise.resolve(snapshot()) },
      {
        casesOpenedSince: () => Promise.reject(new Error("subscription_dunning_cases_recovery_baseline: boom")),
        amountsByPaymentIntentId: () => Promise.resolve([]),
      },
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const evidence = await port.collectEvidence(new Date("2026-07-03T12:00:00.000Z"), { windowDays: 90 });

    // The whole point: a telemetry read that fails must not remove the triage
    // queue an operator works from. Absent, not thrown, and not a zeroed cohort
    // that would read as "nothing recovered".
    expect(evidence.dunningRecovery).toBeUndefined();
    expect(evidence.paymentEvidence).toHaveLength(1);
    expect(evidence.fulfillmentEvidence).toHaveLength(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

function request(): VercelRequest {
  return { method: "POST", body: {}, query: {}, headers: {} } as unknown as VercelRequest;
}

function createResponse(): VercelResponse {
  const res = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() } as unknown as VercelResponse;
  vi.mocked(res.status).mockReturnValue(res);
  vi.mocked(res.json).mockReturnValue(res);
  return res;
}

function snapshot(): ObservabilitySnapshot {
  return {
    checkedAt: "2026-07-03T12:00:00.000Z",
    runtimeFlags: {},
    jobControls: [],
    recentJobRuns: [],
    queues: [],
    recipients: [],
    dunning: {
      overdueRetryCount: 0,
      expiredWithoutCustomerNoticeCount: 0,
      failureWithoutAdminAlertCount: 0,
      failedAdminNotificationCount: 0,
      skippedAdminNotificationCount: 0,
      expiredCount24h: 0,
      recoveredCount24h: 0,
    },
    subscriptions: {
      dueCycleWithoutOrderCount: 1,
      upcomingDeliveryReminderMissingCount: 0,
      evidence: [
        {
          kind: "due_cycle_without_order",
          subscriptionId: "sub-due",
          nextCycleAt: "2026-07-03T10:00:00.000Z",
          reason: "active_subscription_due_without_order_evidence",
          ageSeconds: 7200,
          owner: "commerce/subscription-support",
          customerSafeStatus: "operator_review_required",
          operatorNextAction: "inspect_subscription_scheduler",
          observedAt: "2026-07-03T12:00:00.000Z",
          triageContext: {
            localPaymentStatus: null,
            subscriptionCycleStatus: null,
            orderStatus: null,
            outboxStatus: null,
            outboxAvailableAt: null,
            outboxAttempts: null,
            fulfillmentEligibilityReason: "cycle_order_missing",
            fulfillmentRecoveryPosture: "not_retryable",
            lockedCycleSummary: null,
            futureTemplateSummary: null,
          },
        },
        {
          kind: "paid_renewal_without_fulfillment",
          subscriptionId: "sub-1",
          subscriptionCycleId: "cycle-1",
          orderId: "order-1",
          reason: "paid_subscription_cycle_order_without_fulfillment_order",
          ageSeconds: 2000,
          owner: "commerce/fulfillment",
          customerSafeStatus: "paid_fulfillment_pending",
          operatorNextAction: "inspect_fulfillment_dispatch",
          observedAt: "2026-07-03T12:00:00.000Z",
          triageContext: {
            localPaymentStatus: "succeeded",
            subscriptionCycleStatus: "paid",
            orderStatus: "paid",
            outboxStatus: "pending",
            outboxAvailableAt: null,
            outboxAttempts: null,
            fulfillmentEligibilityReason: "order_paid_outbox_pending",
            fulfillmentRecoveryPosture: "wait_for_outbox",
            lockedCycleSummary: null,
            futureTemplateSummary: null,
          },
        },
      ],
    },
    emails: {
      criticalFailedCount: 0,
      failedBySource: {},
      customerTimelineFailedCount: 0,
      customerTimelineMissedCount: 0,
      customerTimelineOverdueCount: 0,
      failedByPurpose: {},
      auditIncompleteCount: 0,
      previewProductionDomainLinkCount: 0,
      webhookGapCount: 0,
      communicationOutboxFailedCount: 0,
    },
    payments: {
      providerPaidLocalUnpaidCount: 0,
      localPaidProviderUnpaidCount: 0,
      preparedWithoutProviderAckCount: 2,
      webhookMissingCount: 0,
      stuckProcessingCount: 0,
      amountCurrencyMismatchCount: 0,
      signatureFailureCount: 0,
      recoveryRequiredWithoutLinkCount: 0,
      evidence: [{
        kind: "prepared_without_provider_ack",
        provider: "stripe",
        paymentIntentId: "intent-1",
        paymentAttemptId: "attempt-1",
        subscriptionId: "sub-1",
        subscriptionCycleId: "cycle-1",
        providerPaymentId: "pi_secret",
        providerEventId: "evt_secret",
        reason: "prepared_subscription_attempt_without_provider_ack",
        observedAt: "2026-07-03T12:00:00.000Z",
        ageSeconds: 1800,
      }, {
        kind: "prepared_without_provider_ack",
        provider: "tpay",
        paymentIntentId: "one-time-intent",
        paymentAttemptId: "one-time-attempt",
        orderId: "one-time-order",
        subscriptionId: null,
        subscriptionCycleId: null,
        reason: "prepared_attempt_without_provider_ack",
        observedAt: "2026-07-03T12:00:00.000Z",
        ageSeconds: 1900,
      }],
    },
    accounting: {
      shippedWithoutInvoiceCount: 0,
      missingInvoiceHandoffs: [],
      pendingOutboxCount: 0,
      failedOutboxCount: 0,
      failedCorrectionOutboxCount: 0,
      ksefPendingTooLongCount: 0,
      ksefRejectedCount: 0,
      correctionKsefPendingTooLongCount: 0,
      correctionKsefRejectedCount: 0,
      b2cEmailFailedCount: 0,
    },
    omnipack: {
      dispatchFailureCount: 0,
      staleStockSyncCount: 0,
      actionableShortageEvidenceCount: 0,
      providerLowerMismatchCount: 0,
      providerHigherMismatchCount: 0,
      recentQuarantinedInboundCount: 0,
      latestStatusEvidenceAt: null,
      latestStockSyncAt: null,
    },
  };
}
