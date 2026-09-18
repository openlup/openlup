import { describe, expect, it, vi } from "vitest";
import type { AlertSeverity, ObservabilitySnapshot, OpenAlert } from "../../../src/domains/platform/observabilityContracts.js";
import type { AlertLedgerPort, AlertSinkPort, ObservabilityEvidencePort } from "../../../src/domains/platform/observabilityPorts.js";
import { runPlatformWatchdog } from "./platformWatchdogService.js";

const now = new Date("2026-06-06T10:00:00.000Z");

describe("platform watchdog service", () => {
  it("does not mutate ledger or send notifications in checkOnly mode", async () => {
    const ledger = ledgerPort();
    const sink = sinkPort();

    const result = await runPlatformWatchdog({
      evidencePort: evidencePort(snapshotWithMissedJob()),
      ledgerPort: ledger,
      sinkPort: sink,
      catalog: [job()],
      now,
      checkOnly: true,
    });

    expect(result.ok).toBe(true);
    expect(result.health).toBe("firing");
    expect(result.alertCount).toBe(1);
    expect(result.firingCount).toBe(1);
    expect(result.actionableCriticalCount).toBe(1);
    expect(result.suppressedCriticalCount).toBe(0);
    expect(ledger.listOpenAlerts).toHaveBeenCalledTimes(1);
    expect(sink.send).not.toHaveBeenCalled();
  });

  it("keeps checkOnly actionability aligned with an active durable snooze", async () => {
    const ledger = ledgerPort({
      openAlerts: [{
        id: "alert-1", dedupeKey: "job_missed:critical-job", status: "open", severity: "p0",
        lastNotifiedAt: null, snoozedUntil: "2026-06-06T12:00:00.000Z",
      }],
    });

    const result = await runPlatformWatchdog({
      evidencePort: evidencePort(snapshotWithMissedJob()), ledgerPort: ledger, sinkPort: sinkPort(),
      catalog: [job()], now, checkOnly: true,
    });

    expect(result).toMatchObject({
      actionableCriticalCount: 0,
      suppressedCriticalCount: 1,
      actionablePageableCount: 0,
      suppressed: 1,
    });
  });

  it("does not preserve a stale checkOnly snooze across severity escalation", async () => {
    const ledger = ledgerPort({
      openAlerts: [{
        id: "alert-1", dedupeKey: "job_missed:critical-job", status: "acknowledged", severity: "p2",
        lastNotifiedAt: "2026-06-06T09:00:00.000Z",
        snoozedUntil: "2026-06-06T12:00:00.000Z",
      }],
    });

    const result = await runPlatformWatchdog({
      evidencePort: evidencePort(snapshotWithMissedJob()), ledgerPort: ledger, sinkPort: sinkPort(),
      catalog: [job("p0")], now, checkOnly: true,
    });

    expect(result).toMatchObject({
      actionableCriticalCount: 1,
      suppressedCriticalCount: 0,
      actionablePageableCount: 1,
      suppressed: 0,
    });
  });

  it("upserts open alerts, sends once, and resolves stale alerts", async () => {
    const ledger = ledgerPort({
      openAlerts: [{ id: "old-alert", dedupeKey: "job_missed:old-job", status: "open", severity: "p2", lastNotifiedAt: null }],
    });
    const sink = sinkPort();

    const result = await runPlatformWatchdog({
      evidencePort: evidencePort(snapshotWithMissedJob()),
      ledgerPort: ledger,
      sinkPort: sink,
      catalog: [job()],
      now,
      checkOnly: false,
    });

    expect(result.notified).toBe(1);
    expect(result.resolved).toBe(1);
    expect(ledger.upsertOpenAlert).toHaveBeenCalledWith(expect.objectContaining({ dedupeKey: "job_missed:critical-job" }), now);
    expect(ledger.resolveAlert).toHaveBeenCalledWith("job_missed:old-job", now);
    expect(ledger.recordNotification).toHaveBeenCalledWith("alert-1", expect.objectContaining({ status: "sent" }), now, expect.objectContaining({ failureCount: 0 }));
  });

  it("reports canonical notification transport failures without hiding the firing alert", async () => {
    const ledger = ledgerPort();
    const sink = sinkPort({ status: "failed", error: "connection refused" });

    const result = await runPlatformWatchdog({
      evidencePort: evidencePort(snapshotWithMissedJob()),
      ledgerPort: ledger,
      sinkPort: sink,
      catalog: [job()],
      now,
      checkOnly: false,
    });

    expect(result).toMatchObject({
      ok: true,
      health: "firing",
      firingCount: 1,
      notificationFailures: 1,
      notified: 0,
    });
    expect(ledger.recordNotification).toHaveBeenCalledWith(
      "alert-1",
      expect.objectContaining({ status: "failed", error: "connection refused" }),
      now,
      expect.objectContaining({
        failureCount: 1,
        nextAttemptAt: new Date("2026-06-06T10:10:00.000Z"),
      }),
    );
  });

  it("throttles repeated notifications for already-notified alerts", async () => {
    const ledger = ledgerPort({
      upsertedAlert: { id: "alert-1", dedupeKey: "job_missed:critical-job", status: "open", severity: "p0", lastNotifiedAt: "2026-06-06T09:30:00.000Z" },
    });
    const sink = sinkPort();

    const result = await runPlatformWatchdog({
      evidencePort: evidencePort(snapshotWithMissedJob()),
      ledgerPort: ledger,
      sinkPort: sink,
      catalog: [job()],
      now,
      checkOnly: false,
    });

    expect(result.notified).toBe(0);
    expect(result.throttledNotifications).toBe(1);
    expect(result.suppressed).toBe(0);
    expect(result.belowThreshold).toBe(0);
    expect(sink.send).not.toHaveBeenCalled();
  });

  it("scales throttle by severity: p0 re-pages after 90m, p1 does not", async () => {
    const lastNotifiedAt = "2026-06-06T08:30:00.000Z"; // 90 minutes before `now`
    const run = (severity: AlertSeverity) =>
      runPlatformWatchdog({
        evidencePort: evidencePort(snapshotWithMissedJob()),
        ledgerPort: ledgerPort({
          upsertedAlert: { id: "alert-1", dedupeKey: "job_missed:critical-job", status: "open", severity, lastNotifiedAt },
        }),
        sinkPort: sinkPort(),
        catalog: [job(severity)],
        now,
        checkOnly: false,
      });

    expect((await run("p0")).notified).toBe(1); // p0 throttle 1h -> 90m elapsed -> re-pages
    const p1Result = await run("p1");
    expect(p1Result.notified).toBe(0); // p1 throttle 4h -> 90m elapsed -> still throttled
    expect(p1Result.throttledNotifications).toBe(1);
  });

  it("keeps below-threshold (p2) alerts ledger-only: records skipped, never pages", async () => {
    const ledger = ledgerPort({
      upsertedAlert: { id: "alert-1", dedupeKey: "job_missed:critical-job", status: "open", severity: "p2", lastNotifiedAt: null },
    });
    const sink = sinkPort();

    const result = await runPlatformWatchdog({
      evidencePort: evidencePort(snapshotWithMissedJob()),
      ledgerPort: ledger,
      sinkPort: sink,
      catalog: [job("p2")],
      now,
      checkOnly: false,
    });

    expect(result.notified).toBe(0);
    expect(result.belowThreshold).toBe(1);
    expect(result.skippedNotifications).toBe(1);
    expect(sink.send).not.toHaveBeenCalled();
    expect(ledger.upsertOpenAlert).toHaveBeenCalledWith(expect.objectContaining({ dedupeKey: "job_missed:critical-job" }), now);
    expect(ledger.recordNotification).toHaveBeenCalledWith(
      "alert-1",
      expect.objectContaining({ status: "skipped", error: "below_paging_severity" }),
      now,
      expect.objectContaining({
        failureCount: 0,
        nextAttemptAt: new Date("2026-06-06T22:00:00.000Z"),
      }),
    );
  });

  it("does not create a second ledger skip during the same p2 cadence window", async () => {
    const firstLedger = ledgerPort({
      upsertedAlert: { id: "alert-1", dedupeKey: "job_missed:critical-job", status: "open", severity: "p2", lastNotifiedAt: null },
    });
    await runPlatformWatchdog({
      evidencePort: evidencePort(snapshotWithMissedJob()), ledgerPort: firstLedger, sinkPort: sinkPort(),
      catalog: [job("p2")], now, checkOnly: false,
    });

    const secondLedger = ledgerPort({
      upsertedAlert: {
        id: "alert-1", dedupeKey: "job_missed:critical-job", status: "open", severity: "p2",
        lastNotifiedAt: null, lastNotificationStatus: "skipped",
        nextNotificationAttemptAt: "2026-06-06T22:00:00.000Z", notificationFailureCount: 0,
      },
    });
    const secondSink = sinkPort();
    const second = await runPlatformWatchdog({
      evidencePort: evidencePort(snapshotWithMissedJob()), ledgerPort: secondLedger, sinkPort: secondSink,
      catalog: [job("p2")], now: new Date("2026-06-06T10:10:00.000Z"), checkOnly: false,
    });

    expect(second.throttledNotifications).toBe(1);
    expect(second.skippedNotifications).toBe(0);
    expect(secondSink.send).not.toHaveBeenCalled();
    expect(secondLedger.recordNotification).not.toHaveBeenCalled();
  });

  it("backs off failed webhook retries and increases the next retry window", async () => {
    const firstLedger = ledgerPort();
    const failingSink = sinkPort({ status: "failed", error: "connection refused" });
    await runPlatformWatchdog({
      evidencePort: evidencePort(snapshotWithMissedJob()), ledgerPort: firstLedger, sinkPort: failingSink,
      catalog: [job()], now, checkOnly: false,
    });

    const deferredLedger = ledgerPort({
      upsertedAlert: {
        id: "alert-1", dedupeKey: "job_missed:critical-job", status: "open", severity: "p0",
        lastNotifiedAt: null, lastNotificationStatus: "failed",
        nextNotificationAttemptAt: "2026-06-06T10:10:00.000Z", notificationFailureCount: 1,
      },
    });
    const deferredSink = sinkPort({ status: "failed", error: "connection refused" });
    const deferred = await runPlatformWatchdog({
      evidencePort: evidencePort(snapshotWithMissedJob()), ledgerPort: deferredLedger, sinkPort: deferredSink,
      catalog: [job()], now: new Date("2026-06-06T10:05:00.000Z"), checkOnly: false,
    });
    expect(deferred.throttledNotifications).toBe(1);
    expect(deferred.deliveryBackoffCount).toBe(1);
    expect(deferredSink.send).not.toHaveBeenCalled();

    const retryLedger = ledgerPort({
      upsertedAlert: {
        id: "alert-1", dedupeKey: "job_missed:critical-job", status: "open", severity: "p0",
        lastNotifiedAt: null, lastNotificationStatus: "failed",
        nextNotificationAttemptAt: "2026-06-06T10:10:00.000Z", notificationFailureCount: 1,
      },
    });
    await runPlatformWatchdog({
      evidencePort: evidencePort(snapshotWithMissedJob()), ledgerPort: retryLedger, sinkPort: failingSink,
      catalog: [job()], now: new Date("2026-06-06T10:10:00.000Z"), checkOnly: false,
    });
    expect(retryLedger.recordNotification).toHaveBeenCalledWith(
      "alert-1", expect.objectContaining({ status: "failed" }), new Date("2026-06-06T10:10:00.000Z"),
      expect.objectContaining({ failureCount: 2, nextAttemptAt: new Date("2026-06-06T10:30:00.000Z") }),
    );
  });

  it("pages a p2 alert when the threshold is lowered to p2", async () => {
    const ledger = ledgerPort({
      upsertedAlert: { id: "alert-1", dedupeKey: "job_missed:critical-job", status: "open", severity: "p2", lastNotifiedAt: null },
    });
    const sink = sinkPort();

    const result = await runPlatformWatchdog({
      evidencePort: evidencePort(snapshotWithMissedJob()),
      ledgerPort: ledger,
      sinkPort: sink,
      catalog: [job("p2")],
      now,
      checkOnly: false,
      pagingMinSeverity: "p2",
    });

    expect(result.notified).toBe(1);
    expect(result.belowThreshold).toBe(0);
    expect(sink.send).toHaveBeenCalledTimes(1);
  });

  it("never pages diagnostics marked non-pageable even when the threshold is p3", async () => {
    const snapshot = snapshotWithMissedJob();
    snapshot.jobControls = [];
    snapshot.orderMoneyReconciliation = {
      checkedCount: 1,
      mismatchCount: 0,
      providerUnavailableCount: 1,
      providerUnsupportedCount: 1,
      providerPendingCount: 0,
      providerOverdueCount: 0,
      providerEventMoneyUnavailableCount: 0,
      byMode: {
        one_time: { checkedCount: 1, mismatchCount: 0, providerUnavailableCount: 1, providerUnsupportedCount: 1, providerPendingCount: 0, providerOverdueCount: 0, providerEventMoneyUnavailableCount: 0 },
        subscription_initial: { checkedCount: 0, mismatchCount: 0, providerUnavailableCount: 0, providerUnsupportedCount: 0, providerPendingCount: 0, providerOverdueCount: 0, providerEventMoneyUnavailableCount: 0 },
        subscription_renewal: { checkedCount: 0, mismatchCount: 0, providerUnavailableCount: 0, providerUnsupportedCount: 0, providerPendingCount: 0, providerOverdueCount: 0, providerEventMoneyUnavailableCount: 0 },
      },
      evidence: [{
        orderId: "order-1", orderRef: "OPENLUP-1", mode: "one_time", paymentProvider: "tpay", subscriptionCycleId: null,
        mismatchCodes: [], order: {
          id: "order-1", amountCents: 1000, currency: "PLN", subtotalCents: 1000,
          discountCents: 0, shippingCents: 0, shippingDiscountCents: 0,
          taxCents: 74, netCents: 926,
        },
        intent: null, attempt: null, providerEvent: null, invoice: null,
        localSettlement: { state: "not_applicable", reason: "local_settlement_absent" },
        providerSettlement: { state: "unsupported", reason: "provider_settlement_import_unsupported:tpay" },
        fulfillment: { fulfillmentOrderIds: [], statuses: [], handedOverAt: null },
        invoiceExpectation: { issueTrigger: "handoff", state: "not_due", anchorAt: null, dueAt: null },
        invoiceLineageIds: { rootInvoiceIds: [], invoiceIds: [], documentKeys: [], currentInvoiceId: null },
        disposition: "matched",
        relatedIds: { chargeIntentIds: [], succeededAttemptIds: [], trustedProviderEventIds: [], trustedProviderReconciliationIds: [], localSettlementIds: [], trustedProviderSettlementIds: [], baseInvoiceIds: [] },
        observedAt: now.toISOString(),
      }],
    };
    const ledger = ledgerPort();
    const sink = sinkPort();

    const result = await runPlatformWatchdog({
      evidencePort: evidencePort(snapshot), ledgerPort: ledger, sinkPort: sink,
      catalog: [], now, checkOnly: false, pagingMinSeverity: "p3",
    });

    expect(result.notified).toBe(0);
    expect(result.ok).toBe(true);
    expect(result.health).toBe("healthy");
    expect(result.firingCount).toBe(0);
    expect(sink.send).not.toHaveBeenCalled();
    expect(ledger.recordNotification).toHaveBeenCalledWith(
      "alert-1", expect.objectContaining({ error: "non_pageable_diagnostic" }), now, expect.anything(),
    );
  });

  it("acknowledges repeat paging without hiding an unresolved critical from actionability", async () => {
    const ledger = ledgerPort({
      upsertedAlert: {
        id: "alert-1", dedupeKey: "job_missed:critical-job", status: "acknowledged", severity: "p0",
        lastNotifiedAt: null, lastNotificationStatus: "failed",
        nextNotificationAttemptAt: "2026-06-06T10:10:00.000Z", notificationFailureCount: 1,
      },
    });
    const sink = sinkPort();

    const result = await runPlatformWatchdog({
      evidencePort: evidencePort(snapshotWithMissedJob()),
      ledgerPort: ledger,
      sinkPort: sink,
      catalog: [job()],
      now,
      checkOnly: false,
    });

    expect(result.suppressed).toBe(1);
    expect(result.actionableCriticalCount).toBe(1);
    expect(result.suppressedCriticalCount).toBe(0);
    expect(result.actionablePageableCount).toBe(0);
    expect(result.deliveryBackoffCount).toBe(0);
    expect(result.notified).toBe(0);
    expect(sink.send).not.toHaveBeenCalled();
    expect(ledger.upsertOpenAlert).toHaveBeenCalledTimes(1);
    expect(ledger.recordNotification).not.toHaveBeenCalled();
  });

  it("suppresses a future snooze but pages immediately once the snooze has passed", async () => {
    const run = (snoozedUntil: string | null, lastNotifiedAt: string | null = null) =>
      runPlatformWatchdog({
        evidencePort: evidencePort(snapshotWithMissedJob()),
        ledgerPort: ledgerPort({
          upsertedAlert: { id: "alert-1", dedupeKey: "job_missed:critical-job", status: "open", severity: "p0", lastNotifiedAt, snoozedUntil },
        }),
        sinkPort: sinkPort(),
        catalog: [job()],
        now,
        checkOnly: false,
      });

    const activeSnooze = await run("2026-06-06T12:00:00.000Z");
    expect(activeSnooze.suppressed).toBe(1); // 2h in the future -> suppression
    expect(activeSnooze.actionableCriticalCount).toBe(0);
    expect(activeSnooze.suppressedCriticalCount).toBe(1);
    const expired = await run(
      "2026-06-06T09:59:00.000Z",
      "2026-06-06T09:30:00.000Z",
    );
    expect(expired.notified).toBe(1);
    expect(expired.actionableCriticalCount).toBe(1);
  });

  it("mutes env-suppressed dedupe prefixes: not recorded, and open rows auto-resolve", async () => {
    const ledger = ledgerPort({
      openAlerts: [{ id: "old", dedupeKey: "job_missed:critical-job", status: "open", severity: "p0", lastNotifiedAt: null }],
    });
    const sink = sinkPort();

    const result = await runPlatformWatchdog({
      evidencePort: evidencePort(snapshotWithMissedJob()),
      ledgerPort: ledger,
      sinkPort: sink,
      catalog: [job()],
      now,
      checkOnly: false,
      mutedDedupePrefixes: ["job_missed"],
    });

    expect(result.muted).toBe(1);
    expect(result.alertCount).toBe(0);
    expect(result.ok).toBe(true);
    expect(result.health).toBe("healthy");
    expect(ledger.upsertOpenAlert).not.toHaveBeenCalled();
    expect(sink.send).not.toHaveBeenCalled();
    expect(ledger.resolveAlert).toHaveBeenCalledWith("job_missed:critical-job", now);
  });

  it("normalizes diagnostics before health, sink and ledger decisions are computed", async () => {
    const ledger = ledgerPort({
      openAlerts: [{
        id: "existing-alert",
        dedupeKey: "job_missed:critical-job",
        status: "open",
        severity: "p0",
        lastNotifiedAt: null,
      }],
    });
    const sink = sinkPort();

    const result = await runPlatformWatchdog({
      evidencePort: evidencePort(snapshotWithMissedJob()),
      ledgerPort: ledger,
      sinkPort: sink,
      catalog: [job()],
      now,
      checkOnly: false,
      normalizeDecision: (decision) => ({
        ...decision,
        severity: "p3",
        paging: "never",
        payload: { ...decision.payload, normalized: true },
      }),
    });

    expect(result).toMatchObject({
      health: "healthy",
      firingCount: 0,
      maxSeverity: null,
      notified: 0,
      skippedNotifications: 1,
      belowThreshold: 1,
    });
    expect(ledger.upsertOpenAlert).toHaveBeenCalledWith(expect.objectContaining({
      dedupeKey: "job_missed:critical-job",
      severity: "p3",
      paging: "never",
      payload: expect.objectContaining({ normalized: true }),
    }), now);
    expect(ledger.resolveAlert).not.toHaveBeenCalledWith("job_missed:critical-job", now);
    expect(sink.send).not.toHaveBeenCalled();
    expect(ledger.recordNotification).toHaveBeenCalledWith(
      "alert-1", expect.objectContaining({ error: "non_pageable_diagnostic" }), now, expect.anything(),
    );
  });
});

// Default p0: the paging floor is p0 (alertPagingPolicy.ts), so a fixture that
// exercises "this alert pages" must carry the severity that pages.
function job(severity: AlertSeverity = "p0") {
  return {
    jobName: "critical-job",
    owner: "platform/test",
    severity,
    expectedEverySeconds: 600,
    startGraceSeconds: 60,
    finishGraceSeconds: 60,
    runbookUrl: "/docs/platform/RUNTIME_AND_SELF_HOSTING.md",
    alertChannels: ["webhook" as const],
  };
}

function snapshotWithMissedJob(): ObservabilitySnapshot {
  return {
    checkedAt: now.toISOString(),
    runtimeFlags: {},
    jobControls: [{
      jobName: "critical-job",
      enabled: true,
      lastSuccessAt: "2026-06-06T09:00:00.000Z",
      lastStartedAt: "2026-06-06T09:00:00.000Z",
      lastFinishedAt: "2026-06-06T09:01:00.000Z",
      lastStatus: "success",
      leaseUntil: null,
    }],
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

function evidencePort(snapshot: ObservabilitySnapshot): ObservabilityEvidencePort {
  return { collectSnapshot: vi.fn().mockResolvedValue(snapshot) };
}

function ledgerPort({
  openAlerts = [],
  upsertedAlert = { id: "alert-1", dedupeKey: "job_missed:critical-job", status: "open", severity: "p0", lastNotifiedAt: null },
}: {
  openAlerts?: OpenAlert[];
  upsertedAlert?: OpenAlert;
} = {}): AlertLedgerPort {
  return {
    listOpenAlerts: vi.fn().mockResolvedValue(openAlerts),
    upsertOpenAlert: vi.fn().mockResolvedValue(upsertedAlert),
    resolveAlert: vi.fn().mockResolvedValue(undefined),
    recordNotification: vi.fn().mockResolvedValue(undefined),
  };
}

function sinkPort(outcome: Partial<Awaited<ReturnType<AlertSinkPort["send"]>>> = {}): AlertSinkPort {
  return {
    send: vi.fn().mockResolvedValue({
      channel: "webhook",
      status: "sent",
      provider: "webhook",
      ...outcome,
    }),
  };
}
