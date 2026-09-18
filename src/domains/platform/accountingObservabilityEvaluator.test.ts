import { describe, expect, it } from "vitest";
import { JOB_CATALOG } from "./jobCatalog";
import { evaluateObservability } from "./observabilityEvaluator";
import type { ObservabilitySnapshot } from "./observabilityContracts";

const now = new Date("2026-06-06T10:00:00.000Z");

describe("accounting observability evaluator", () => {
  it("raises the customer-delivery alert even while accounting observability is disabled", () => {
    const decisions = evaluateObservability({
      ...baseSnapshot(),
      accounting: { ...baseSnapshot().accounting, issuedWithoutCustomerDeliveryCount: 3 },
    }, JOB_CATALOG, now);

    const decision = decisions.find((d) => d.dedupeKey === "invoice_issued_without_customer_delivery");
    expect(decision).toBeDefined();
    expect(decision?.severity).toBe("p1");
    expect(decision?.payload).toMatchObject({ count: 3 });
  });

  it("detects invoice and KSeF gaps only while accounting observability is enabled", () => {
    const decisions = evaluateObservability({
      ...baseSnapshot(),
      runtimeFlags: { COMMERCE_ACCOUNTING_OBSERVABILITY_ENABLED: true },
      accounting: {
        shippedWithoutInvoiceCount: 1,
        missingInvoiceHandoffs: [{
          kind: "handoff_missing_invoice_request",
          fulfillmentOrderId: "fulfillment-1",
          orderId: "order-1",
          status: "handed_over",
          handedOverAt: "2026-06-06T09:00:00.000Z",
          ageSeconds: 3600,
          reason: "no_accounting_invoice_for_fulfillment_handoff",
          recoveryAction: "replay_accounting_invoice_issue_request_from_handoff",
          observedAt: now.toISOString(),
        }],
        pendingOutboxCount: 1,
        failedOutboxCount: 1,
        failedCorrectionOutboxCount: 1,
        deliveryPendingCount: 1,
        deliveryFailedCount: 1,
        b2bWaitingKsefCount: 1,
        ksefPendingTooLongCount: 1,
        ksefRejectedCount: 1,
        correctionKsefPendingTooLongCount: 1,
        correctionKsefRejectedCount: 1,
        b2cEmailFailedCount: 1,
        blockedInvoiceCount: 1,
        invalidTaxIdBlockedCount: 1,
      },
    }, JOB_CATALOG, now);

    expect(decisions.map((decision) => decision.dedupeKey)).toEqual(expect.arrayContaining([
      "accounting_shipped_without_invoice",
      "accounting_invoice_outbox_stale",
      "accounting_invoice_outbox_failed",
      "accounting_correction_outbox_failed",
      "accounting_invoice_delivery_pending",
      "accounting_invoice_delivery_failed",
      "accounting_b2b_waiting_ksef",
      "accounting_ksef_pending_stale",
      "accounting_ksef_rejected",
      "accounting_correction_ksef_pending_stale",
      "accounting_correction_ksef_rejected",
      "accounting_b2c_email_failed",
      "accounting_invoice_blocked",
      "accounting_invoice_invalid_tax_id",
    ]));
    expect(decisions.find((decision) => decision.dedupeKey === "accounting_shipped_without_invoice")?.payload)
      .toMatchObject({
        count: 1,
        recoveryAction: "replay_accounting_invoice_issue_request_from_handoff",
        missingInvoiceHandoffs: [expect.objectContaining({
          fulfillmentOrderId: "fulfillment-1",
          orderId: "order-1",
          ageSeconds: 3600,
        })],
      });
    expect(JSON.stringify(decisions)).not.toContain("client_secret");
    expect(JSON.stringify(decisions)).not.toContain("Bearer");

    const disabled = evaluateObservability({
      ...baseSnapshot(),
      accounting: { ...baseSnapshot().accounting, failedOutboxCount: 1 },
    }, JOB_CATALOG, now);
    expect(disabled.map((decision) => decision.dedupeKey)).not.toContain("accounting_invoice_outbox_failed");
  });
});

function baseSnapshot(): ObservabilitySnapshot {
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
    subscriptions: {
      dueCycleWithoutOrderCount: 0,
      upcomingDeliveryReminderMissingCount: 0,
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
