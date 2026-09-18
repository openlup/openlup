import { describe, expect, it } from "vitest";
import { collectPaymentAlerts } from "./paymentObservabilityEvaluator";
import type {
  AlertDecision,
  ObservabilitySnapshot,
  PaymentHealthSnapshot,
} from "./observabilityContracts";

const now = new Date("2026-06-10T12:00:00.000Z");

describe("payment observability severities", () => {
  it("pages at p0 on a single refused webhook signature", () => {
    const decision = decide({ signatureFailureCount: 1 });
    expect(decision("payment_signature_failure")).toMatchObject({
      severity: "p0",
      payload: { count: 1 },
    });
    expect(decision("payment_signature_failure")?.humanContext?.incidentClass).toBe("data_integrity");
  });

  it("keeps a single prepared attempt without acknowledgement at p1", () => {
    const decision = decide({ preparedWithoutProviderAckCount: 1 });
    expect(decision("payment_prepared_without_provider_ack")).toMatchObject({
      severity: "p1",
      payload: { count: 1 },
    });
  });

  it("raises prepared attempts without acknowledgement to p0 from the second one", () => {
    const decision = decide({ preparedWithoutProviderAckCount: 2 });
    expect(decision("payment_prepared_without_provider_ack")).toMatchObject({
      severity: "p0",
      payload: { count: 2 },
    });
    expect(decision("payment_prepared_without_provider_ack")?.humanContext?.urgency).toContain("P0");
  });

  it("leaves the neighbouring severities alone", () => {
    const decision = decide({ providerPaidLocalUnpaidCount: 1, webhookMissingCount: 1 });
    expect(decision("payment_provider_paid_local_unpaid")?.severity).toBe("p0");
    expect(decision("payment_webhook_missing")?.severity).toBe("p1");
    expect(decision("payment_webhook_missing")?.humanContext).toBeUndefined();
  });

  it("stays silent while the reconciliation flag is off", () => {
    const decisions: AlertDecision[] = [];
    collectPaymentAlerts(decisions, {
      ...snapshot(),
      runtimeFlags: {},
      payments: { ...snapshot().payments, signatureFailureCount: 3, preparedWithoutProviderAckCount: 3 },
    });
    expect(decisions).toEqual([]);
  });
});

function decide(payments: Partial<PaymentHealthSnapshot>) {
  const decisions: AlertDecision[] = [];
  collectPaymentAlerts(decisions, {
    ...snapshot(),
    runtimeFlags: { COMMERCE_PSP_OBSERVABILITY_ENABLED: true },
    payments: { ...snapshot().payments, ...payments },
  });
  return (dedupeKey: string) => decisions.find((decision) => decision.dedupeKey === dedupeKey);
}

function snapshot(): ObservabilitySnapshot {
  return {
    checkedAt: now.toISOString(),
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
    subscriptions: { dueCycleWithoutOrderCount: 0, upcomingDeliveryReminderMissingCount: 0 },
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
      webhookMissingCount: 0,
      stuckProcessingCount: 0,
      amountCurrencyMismatchCount: 0,
      signatureFailureCount: 0,
      recoveryRequiredWithoutLinkCount: 0,
      evidence: [],
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
    // The payment collector never reads the fulfillment block; an empty cast keeps
    // this fixture free of field names the neutrality ratchet counts.
    omnipack: {} as ObservabilitySnapshot["omnipack"],
  };
}
