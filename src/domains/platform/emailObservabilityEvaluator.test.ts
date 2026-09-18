import { describe, expect, it } from "vitest";
import type { ObservabilitySnapshot } from "./observabilityContracts";
import { evaluateObservability } from "./observabilityEvaluator";

const now = new Date("2026-06-06T10:00:00.000Z");

describe("email observability evaluator", () => {
  it("detects email audit, preview domain, webhook, and communication outbox gaps", () => {
    const decisions = evaluateObservability({
      ...snapshot(),
      emails: {
        ...snapshot().emails,
        auditIncompleteCount: 2,
        previewProductionDomainLinkCount: 1,
        webhookGapCount: 3,
        communicationOutboxFailedCount: 1,
      },
    }, [], now);

    expect(decisions.map((decision) => decision.dedupeKey)).toEqual(expect.arrayContaining([
      "customer_email_audit_incomplete",
      "preview_email_production_domain_link",
      "email_webhook_gap",
      "communication_outbox_failed",
    ]));
    expect(decisions.find((decision) => decision.dedupeKey === "customer_email_audit_incomplete")).toMatchObject({
      owner: "platform/communications",
      severity: "p2",
      paging: "never",
    });
    const webhookGap = decisions.find((decision) => decision.dedupeKey === "email_webhook_gap");
    expect(webhookGap).toMatchObject({ severity: "p1" });
    expect(webhookGap?.paging).toBeUndefined();
  });

  it("carries the failure count on the customer delivery alert so the page renders a number", () => {
    const decisions = evaluateObservability({
      ...snapshot(),
      emails: { ...snapshot().emails, customerTimelineFailedCount: 4 },
    }, [], now);

    const failed = decisions.find((decision) => decision.dedupeKey === "customer_email_delivery_failed");
    expect(failed).toMatchObject({ severity: "p1", owner: "platform/communications" });
    // webhookAlertSink's evidenceSummary only renders a payload key literally named `count`;
    // without this the ntfy page shows no number and cannot be triaged from a phone.
    expect(failed?.payload.count).toBe(4);
  });

  it("still pages on a single customer-facing delivery failure", () => {
    const decisions = evaluateObservability({
      ...snapshot(),
      emails: { ...snapshot().emails, customerTimelineFailedCount: 1 },
    }, [], now);

    // Deliberate: one terminal customer-facing failure is customer-impacting and pages
    // (OBSERVABILITY_RUNBOOK). The 2026-07-16 noise was a misclassification of intentionally
    // suppressed sends, fixed in the delivery-timeline mapper, not by weakening this gate.
    const failed = decisions.find((decision) => decision.dedupeKey === "customer_email_delivery_failed");
    expect(failed).toBeDefined();
    expect(failed?.payload.count).toBe(1);
  });

  it("flags a per-recipient email volume spike at/above threshold", () => {
    const decisions = evaluateObservability({
      ...snapshot(),
      emails: { ...snapshot().emails, maxSendsPerRecipient: 8 },
    }, [], now);

    expect(decisions.map((decision) => decision.dedupeKey)).toContain("per_recipient_email_volume");
    expect(decisions.find((decision) => decision.dedupeKey === "per_recipient_email_volume")).toMatchObject({
      owner: "platform/communications",
      severity: "p1",
    });
  });

  it("does not flag per-recipient volume below threshold", () => {
    const decisions = evaluateObservability({
      ...snapshot(),
      emails: { ...snapshot().emails, maxSendsPerRecipient: 7 },
    }, [], now);

    expect(decisions.map((decision) => decision.dedupeKey)).not.toContain("per_recipient_email_volume");
  });

  // On the ntfy path the payload never travels; the operator reads only evidenceSummary's
  // whitelist (webhookAlertSink.ts:243), whose sole magnitude key is `count`. These pin the
  // number each alert puts on the page — distinct fixture values per counter, so a `count`
  // wired to a neighbouring field fails instead of coincidentally matching.
  it("puts each email alert's own magnitude on the page", () => {
    const decisions = evaluateObservability({
      ...snapshot(),
      emails: {
        ...snapshot().emails,
        criticalFailedCount: 2,
        customerTimelineMissedCount: 3,
        customerTimelineOverdueCount: 4,
        auditIncompleteCount: 5,
        previewProductionDomainLinkCount: 6,
        webhookGapCount: 7,
        communicationOutboxFailedCount: 9,
      },
    }, [], now);

    const countFor = (dedupeKey: string) =>
      decisions.find((decision) => decision.dedupeKey === dedupeKey)?.payload.count;

    expect(countFor("critical_email_failed")).toBe(2);
    // Fires on either counter, so the page states the total that crossed the threshold.
    expect(countFor("customer_email_delivery_missed")).toBe(7);
    expect(countFor("customer_email_audit_incomplete")).toBe(5);
    expect(countFor("preview_email_production_domain_link")).toBe(6);
    expect(countFor("email_webhook_gap")).toBe(7);
    expect(countFor("communication_outbox_failed")).toBe(9);
  });

  // The invariant, not the enumeration: a per-alert assertion cannot fail for an alert
  // nobody has written yet. This one does.
  it("never emits an email alert an operator cannot size", () => {
    const decisions = evaluateObservability({
      ...snapshot(),
      emails: {
        ...snapshot().emails,
        criticalFailedCount: 1,
        customerTimelineFailedCount: 1,
        customerTimelineMissedCount: 1,
        customerTimelineOverdueCount: 1,
        auditIncompleteCount: 1,
        previewProductionDomainLinkCount: 1,
        webhookGapCount: 1,
        communicationOutboxFailedCount: 1,
        maxSendsPerRecipient: 8,
        failedBySource: { "outbox-dispatch": 3 },
      },
    }, [], now);

    const emailAlerts = decisions.filter((decision) => decision.owner === "platform/communications");
    expect(emailAlerts.length).toBeGreaterThanOrEqual(9);
    for (const decision of emailAlerts) {
      // Readable magnitude: either the rendered `count` key, or a digit the message spells out.
      const sizable = typeof decision.payload.count === "number" || /\d/.test(decision.message);
      expect(sizable, `${decision.dedupeKey} pages without a number an operator can read`).toBe(true);
    }
  });

  // The counter that would have caught the 2026-08-20 silence. Benign reasons
  // must stay quiet, or the alert becomes noise and gets ignored.
  it("alerts on customer notices skipped for a non-settled reason, and stays quiet on settled ones", () => {
    const suspect = evaluateObservability({
      ...snapshot(),
      emails: {
        ...snapshot().emails,
        customerNoticeSkippedCount: 3,
        skippedByReason: { payment_session_active: 1, order_already_paid: 2 },
      },
    }, [], now);

    const alert = suspect.find((decision) => decision.dedupeKey === "customer_notice_skipped");
    expect(alert).toMatchObject({ severity: "p2", owner: "platform/communications" });
    // `count` is the only magnitude key the ntfy path renders, and it must carry
    // the SUSPECT total, not the raw skip total.
    expect(alert?.payload).toMatchObject({ count: 1 });

    const benign = evaluateObservability({
      ...snapshot(),
      emails: {
        ...snapshot().emails,
        customerNoticeSkippedCount: 2,
        skippedByReason: { order_already_paid: 2 },
      },
    }, [], now);
    expect(benign.some((decision) => decision.dedupeKey === "customer_notice_skipped")).toBe(false);
  });

});

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
