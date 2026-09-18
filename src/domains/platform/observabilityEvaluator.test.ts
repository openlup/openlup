import { describe, expect, it, vi } from "vitest";
import { JOB_CATALOG } from "./jobCatalog";
import { evaluateObservability } from "./observabilityEvaluator";
import { ALERT_CHANNELS, ALERT_SEVERITIES } from "./observabilityContracts";
import type { ObservabilitySnapshot } from "./observabilityContracts";

const now = new Date("2026-06-06T10:00:00.000Z");

describe("platform observability evaluator", () => {
  it("keeps alert contract constants available at runtime", () => {
    expect(ALERT_SEVERITIES).toEqual(["p0", "p1", "p2", "p3"]);
    expect(ALERT_CHANNELS).toEqual(["webhook", "resend"]);
  });

  it("detects stuck leases without misclassifying a launched job as missed", () => {
    const decisions = evaluateObservability({
      ...baseSnapshot(),
      runtimeFlags: { COMMERCE_DUNNING_EMAILS_ENABLED: true },
      jobControls: [
        {
          jobName: "subscription-dunning-dispatch",
          enabled: true,
          lastSuccessAt: "2026-06-06T09:30:00.000Z",
          lastStartedAt: "2026-06-06T09:45:00.000Z",
          lastFinishedAt: null,
          lastStatus: "running",
          leaseUntil: "2026-06-06T09:55:00.000Z",
        },
      ],
      queues: [{
        queueName: "subscription_dunning_notifications",
        jobName: "subscription-dunning-dispatch",
        queuedCount: 3,
        oldestQueuedAt: "2026-06-06T09:30:00.000Z",
        failedCount: 1,
        skippedCount: 1,
        criticalFailedCount: 1,
        criticalSkippedCount: 1,
      }],
      recipients: [{ notificationType: "commerce_payment_critical", activeCount: 0, requiredWhenFlag: "COMMERCE_DUNNING_EMAILS_ENABLED" }],
      dunning: {
        overdueRetryCount: 2,
        expiredWithoutCustomerNoticeCount: 1,
        failureWithoutAdminAlertCount: 1,
        failedAdminNotificationCount: 1,
        skippedAdminNotificationCount: 1,
        expiredCount24h: 4,
        recoveredCount24h: 1,
      },
      emails: emailHealth({
        criticalFailedCount: 1,
        failedBySource: { "subscription-dunning-dispatch": 1 },
        customerTimelineFailedCount: 1,
        failedByPurpose: { transactional: 1 },
      }),
    }, JOB_CATALOG, now);

    expect(decisions.map((decision) => decision.dedupeKey)).toEqual(expect.arrayContaining([
      "job_stuck_running:subscription-dunning-dispatch",
      "queue_backlog:subscription_dunning_notifications",
      "critical_queue_failure:subscription_dunning_notifications",
      "missing_recipient:commerce_payment_critical",
      "dunning_retry_overdue",
      "dunning_expired_notice_missing",
      "dunning_admin_alert_missing",
      "dunning_admin_alert_failed",
      "dunning_admin_alert_skipped",
      "dunning_recovery_ratio_spike",
      "critical_email_failed",
      "customer_email_delivery_failed",
    ]));
    expect(decisions.find((decision) => decision.dedupeKey === "customer_email_delivery_failed")?.humanContext)
      .toMatchObject({ incidentClass: "customer_communication_failure" });
    expect(decisions.find((decision) => decision.dedupeKey === "queue_backlog:subscription_dunning_notifications")?.humanContext)
      .toMatchObject({ incidentClass: "queue_backlog" });
    expect(decisions.map((decision) => decision.dedupeKey)).not.toContain("job_missed:subscription-dunning-dispatch");
    // The ntfy page renders only evidenceSummary's whitelist, whose sole magnitude key is
    // `count` (webhookAlertSink.ts:243). The queue payload already supplies queueName and
    // jobName; without this the operator learns which queue broke but not how badly.
    const criticalQueue = decisions.find((decision) =>
      decision.dedupeKey === "critical_queue_failure:subscription_dunning_notifications"
    );
    expect(criticalQueue?.payload.count).toBe(2); // 1 critical failed + 1 critical skipped
    expect(criticalQueue?.payload).toMatchObject({
      queueName: "subscription_dunning_notifications",
      jobName: "subscription-dunning-dispatch",
    });
  });

  it("distinguishes a failed latest attempt from a genuinely missed schedule", () => {
    const job = JOB_CATALOG.find((entry) => entry.jobName === "omnipack-stock-sync")!;
    const failed = evaluateObservability({
      ...baseSnapshot(),
      runtimeFlags: { COMMERCE_OMNIPACK_OBSERVABILITY_ENABLED: true },
      jobControls: [{
        jobName: job.jobName,
        enabled: true,
        lastSuccessAt: "2026-06-06T08:00:00.000Z",
        lastStartedAt: "2026-06-06T09:45:00.000Z",
        lastFinishedAt: "2026-06-06T09:46:00.000Z",
        lastStatus: "failed",
        leaseUntil: null,
      }],
      recentJobRuns: [{
        jobName: job.jobName,
        status: "failed",
        startedAt: "2026-06-06T09:45:00.000Z",
        finishedAt: "2026-06-06T09:46:00.000Z",
        error: "provider body must not enter the alert",
        supportCode: "stock-sync-failed",
      }],
    }, [job], now);

    expect(failed.map((decision) => decision.dedupeKey)).toContain("job_failed:omnipack-stock-sync");
    expect(failed.map((decision) => decision.dedupeKey)).not.toContain("job_missed:omnipack-stock-sync");
    expect(failed.find((decision) => decision.dedupeKey === "job_failed:omnipack-stock-sync")?.humanContext)
      .toMatchObject({ incidentClass: "scheduled_job_failed" });
    // The title is what an ntfy push renders. A bare "Scheduled job failed" is
    // untriageable from a phone — it must name the job.
    expect(failed.find((decision) => decision.dedupeKey === "job_failed:omnipack-stock-sync")?.title)
      .toContain("omnipack-stock-sync");
    expect(JSON.stringify(failed)).not.toContain("provider body");

    const controlFallback = evaluateObservability({
      ...baseSnapshot(),
      runtimeFlags: { COMMERCE_OMNIPACK_OBSERVABILITY_ENABLED: true },
      jobControls: [{
        jobName: job.jobName,
        enabled: true,
        lastSuccessAt: "2026-06-06T08:00:00.000Z",
        lastStartedAt: "2026-06-06T09:45:00.000Z",
        lastFinishedAt: "2026-06-06T09:46:00.000Z",
        lastStatus: "failed",
        leaseUntil: null,
      }],
      recentJobRuns: [{
        jobName: job.jobName,
        status: "success",
        startedAt: "2026-06-06T08:00:00.000Z",
        finishedAt: "2026-06-06T08:01:00.000Z",
        error: null,
        supportCode: null,
      }],
    }, [job], now);

    expect(controlFallback.map((decision) => decision.dedupeKey)).toContain("job_failed:omnipack-stock-sync");
    expect(controlFallback.find((decision) => decision.dedupeKey === "job_failed:omnipack-stock-sync")?.payload)
      .toMatchObject({
        lastStartedAt: "2026-06-06T09:45:00.000Z",
        lastFinishedAt: "2026-06-06T09:46:00.000Z",
        supportCode: null,
      });

    const retrying = evaluateObservability({
      ...baseSnapshot(),
      runtimeFlags: { COMMERCE_OMNIPACK_OBSERVABILITY_ENABLED: true },
      jobControls: [{
        jobName: job.jobName,
        enabled: true,
        lastSuccessAt: "2026-06-06T08:00:00.000Z",
        lastStartedAt: "2026-06-06T09:55:00.000Z",
        lastFinishedAt: null,
        lastStatus: "running",
        leaseUntil: "2026-06-06T10:10:00.000Z",
      }],
      recentJobRuns: [{
        jobName: job.jobName,
        status: "failed",
        startedAt: "2026-06-06T09:45:00.000Z",
        finishedAt: "2026-06-06T09:46:00.000Z",
        error: null,
        supportCode: null,
      }],
    }, [job], now);

    expect(retrying.map((decision) => decision.dedupeKey)).toContain("job_failed:omnipack-stock-sync");
    expect(retrying.map((decision) => decision.dedupeKey)).not.toContain("job_missed:omnipack-stock-sync");

    const recovered = evaluateObservability({
      ...baseSnapshot(),
      runtimeFlags: { COMMERCE_OMNIPACK_OBSERVABILITY_ENABLED: true },
      jobControls: [{
        jobName: job.jobName,
        enabled: true,
        lastSuccessAt: "2026-06-06T09:50:00.000Z",
        lastStartedAt: "2026-06-06T09:50:00.000Z",
        lastFinishedAt: "2026-06-06T09:51:00.000Z",
        lastStatus: "success",
        leaseUntil: null,
      }],
      recentJobRuns: [{
        jobName: job.jobName,
        status: "failed",
        startedAt: "2026-06-06T09:45:00.000Z",
        finishedAt: "2026-06-06T09:46:00.000Z",
        error: null,
        supportCode: null,
      }],
    }, [job], now);

    expect(recovered).toEqual([]);

    const missed = evaluateObservability({
      ...baseSnapshot(),
      runtimeFlags: { COMMERCE_OMNIPACK_OBSERVABILITY_ENABLED: true },
      jobControls: [{
        jobName: job.jobName,
        enabled: true,
        lastSuccessAt: "2026-06-06T08:00:00.000Z",
        lastStartedAt: "2026-06-06T08:00:00.000Z",
        lastFinishedAt: "2026-06-06T08:01:00.000Z",
        lastStatus: "success",
        leaseUntil: null,
      }],
    }, [job], now);

    expect(missed.map((decision) => decision.dedupeKey)).toEqual(["job_missed:omnipack-stock-sync"]);
  });

  it("does not alert hidden subscription monitors while activation flags are false", () => {
    const decisions = evaluateObservability({
      ...baseSnapshot(),
      jobControls: [],
      queues: [{
        queueName: "subscription_dunning_notifications",
        jobName: "subscription-dunning-dispatch",
        queuedCount: 1,
        oldestQueuedAt: "2026-06-06T09:00:00.000Z",
        failedCount: 0,
        skippedCount: 0,
      }],
      recipients: [{ notificationType: "commerce_payment_critical", activeCount: 0, requiredWhenFlag: "COMMERCE_DUNNING_EMAILS_ENABLED" }],
      dunning: { ...baseSnapshot().dunning, overdueRetryCount: 1 },
    }, JOB_CATALOG, now);

    expect(decisions.map((decision) => decision.dedupeKey)).not.toContain("job_ledger_missing:subscription-dunning-dispatch");
    expect(decisions.map((decision) => decision.dedupeKey)).not.toContain("queue_backlog:subscription_dunning_notifications");
    expect(decisions.map((decision) => decision.dedupeKey)).not.toContain("missing_recipient:commerce_payment_critical");
    expect(decisions.map((decision) => decision.dedupeKey)).toContain("dunning_retry_overdue");
  });

  it("stays silent on retired legacy pg_cron email jobs and gates DHL on its fallback flag", () => {
    const staleControls = [
      "check-dhl-tracking",
    ].map((jobName) => ({
      jobName,
      enabled: true,
      lastSuccessAt: "2026-06-01T00:00:00.000Z",
      lastStartedAt: "2026-06-01T00:00:00.000Z",
      lastFinishedAt: "2026-06-01T00:01:00.000Z",
      lastStatus: "success",
      leaseUntil: null,
    }));

    const disabled = evaluateObservability({
      ...baseSnapshot(),
      jobControls: staleControls,
    }, JOB_CATALOG.filter((job) => staleControls.some((control) => control.jobName === job.jobName)), now);

    // The three legacy email jobs are fail-closed by 20260718130001 and carry
    // monitoringState=legacy_out_of_scope, so a frozen lastSuccessAt is the
    // expected steady state rather than an incident. Alerting on it produced
    // permanent p2 noise that masked genuinely missed jobs.
    expect(disabled.map((decision) => decision.dedupeKey)).toEqual([]);

    const decisions = evaluateObservability({
      ...baseSnapshot(),
      runtimeFlags: { COMMERCE_DHL_ONLY_DELIVERY: true },
      jobControls: staleControls,
    }, JOB_CATALOG.filter((job) => staleControls.some((control) => control.jobName === job.jobName)), now);

    expect(decisions.map((decision) => decision.dedupeKey)).toEqual([
      "job_missed:check-dhl-tracking",
    ]);
    const dhlDecision = decisions.find((decision) => decision.dedupeKey === "job_missed:check-dhl-tracking");
    expect(dhlDecision).toMatchObject({
      humanContext: {
        incidentClass: "fulfillment_tracking_stalled",
      },
    });
    expect(dhlDecision?.humanContext?.firstAction).toContain("/api/cron/dhl-tracking");
  });

  it("detects subscription renewal and delivery reminder gaps only when those monitors are enabled", () => {
    const decisions = evaluateObservability({
      ...baseSnapshot(),
      runtimeFlags: {
        COMMERCE_SUBSCRIPTION_RENEWAL_RUNTIME_ENABLED: true,
        COMMERCE_SUBSCRIPTION_DELIVERY_REMINDERS_ENABLED: true,
      },
      subscriptions: {
        dueCycleWithoutOrderCount: 2,
        upcomingDeliveryReminderMissingCount: 3,
      },
    }, JOB_CATALOG, now);

    expect(decisions.map((decision) => decision.dedupeKey)).toEqual(expect.arrayContaining([
      "subscription_cycle_due_without_order",
      "subscription_delivery_reminder_missing",
    ]));
  });

  it("names the due-without-order subjects in the payload and reports what the bound dropped", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const decisions = evaluateObservability({
      ...baseSnapshot(),
      runtimeFlags: { COMMERCE_SUBSCRIPTION_RENEWAL_RUNTIME_ENABLED: true },
      subscriptions: {
        dueCycleWithoutOrderCount: 12,
        upcomingDeliveryReminderMissingCount: 0,
        evidence: [
          // Collector order: oldest first. Twelve subjects against a bound of ten.
          ...Array.from({ length: 12 }, (_unused, idx) => dueCycleEvidence(`sub-${idx}`, 43_200 - idx * 60)),
          // A different exception kind must not leak into this alert.
          paidRenewalEvidence("sub-other"),
        ],
      },
    }, JOB_CATALOG, now);

    const alert = decisions.find((decision) => decision.dedupeKey === "subscription_cycle_due_without_order");
    // Alert identity is unchanged — only the payload grew.
    expect(alert?.severity).toBe("p1");
    expect(alert?.owner).toBe("commerce/subscription-support");
    expect(alert?.title).toBe("Subscription cycle due without order");
    expect(alert?.payload.count).toBe(12);
    expect(alert?.payload.evidence).toHaveLength(10);
    expect((alert?.payload.evidence as unknown[])[0]).toEqual({
      subscriptionId: "sub-0",
      nextCycleAt: "2026-06-06T00:00:00.000Z",
      ageSeconds: 43_200,
    });
    // No silent cap: the operator can see two subjects exist beyond the list.
    expect(alert?.payload.droppedEvidenceCount).toBe(2);
    expect(alert?.payload.evidenceLimit).toBe(10);
    expect(warn).toHaveBeenCalledWith(
      "[observability] due_cycle_without_order evidence truncated",
      expect.objectContaining({ total: 12, listed: 10, dropped: 2 }),
    );
    // The known-misleading JSONB-sourced triage summary must not ride along.
    expect(JSON.stringify(alert?.payload)).not.toContain("lineCount");
    warn.mockRestore();
  });

  it("still raises the due-without-order alert when the snapshot carries no evidence rows", () => {
    const decisions = evaluateObservability({
      ...baseSnapshot(),
      runtimeFlags: { COMMERCE_SUBSCRIPTION_RENEWAL_RUNTIME_ENABLED: true },
      subscriptions: { dueCycleWithoutOrderCount: 2, upcomingDeliveryReminderMissingCount: 0 },
    }, JOB_CATALOG, now);

    const alert = decisions.find((decision) => decision.dedupeKey === "subscription_cycle_due_without_order");
    expect(alert?.payload).toMatchObject({ count: 2, evidence: [], droppedEvidenceCount: 0 });
  });

  it("pages once when delivery protection remains unresolved past its grace window", () => {
    const decisions = evaluateObservability({
      ...baseSnapshot(),
      subscriptions: {
        dueCycleWithoutOrderCount: 0,
        upcomingDeliveryReminderMissingCount: 0,
        deliveryAlignmentOverdueCount: 2,
        deliveryAlignmentOverdueEvidence: [{
          subscriptionId: "sub-oldest",
          nextCycleAt: "2026-06-04T10:00:00.000Z",
          ageSeconds: 172800,
        }],
      },
    }, JOB_CATALOG, now);

    expect(decisions).toContainEqual(expect.objectContaining({
      dedupeKey: "subscription_delivery_alignment_overdue",
      severity: "p1",
      payload: {
        count: 2,
        evidence: [{
          subscriptionId: "sub-oldest",
          nextCycleAt: "2026-06-04T10:00:00.000Z",
          ageSeconds: 172800,
        }],
        evidenceLimit: 10,
        droppedEvidenceCount: 1,
      },
    }));
  });

  it("raises job_failed for the renewal scheduler from a failed run and clears it on the next success", () => {
    const job = JOB_CATALOG.find((entry) => entry.jobName === "subscription-renewal-runtime")!;
    const runtimeFlags = { COMMERCE_SUBSCRIPTION_RENEWAL_RUNTIME_ENABLED: true };
    // Pins the downstream half of the renewal-run status change: nothing in the
    // evaluator knows about row errors — the run status alone is the channel.
    const failed = evaluateObservability({
      ...baseSnapshot(),
      runtimeFlags,
      jobControls: [{
        jobName: job.jobName,
        enabled: true,
        lastSuccessAt: "2026-06-06T09:30:00.000Z",
        lastStartedAt: "2026-06-06T09:56:00.000Z",
        lastFinishedAt: "2026-06-06T09:57:00.000Z",
        lastStatus: "failed",
        leaseUntil: null,
      }],
      recentJobRuns: [{
        jobName: job.jobName,
        status: "failed",
        startedAt: "2026-06-06T09:56:00.000Z",
        finishedAt: "2026-06-06T09:57:00.000Z",
        error: "row_errors:subscription_template_snapshot_missing=1",
        supportCode: null,
      }],
    }, [job], now);
    expect(failed.map((decision) => decision.dedupeKey)).toContain("job_failed:subscription-renewal-runtime");

    const recovered = evaluateObservability({
      ...baseSnapshot(),
      runtimeFlags,
      jobControls: [{
        jobName: job.jobName,
        enabled: true,
        lastSuccessAt: "2026-06-06T09:58:00.000Z",
        lastStartedAt: "2026-06-06T09:58:00.000Z",
        lastFinishedAt: "2026-06-06T09:59:00.000Z",
        lastStatus: "success",
        leaseUntil: null,
      }],
      recentJobRuns: [{
        jobName: job.jobName,
        status: "failed",
        startedAt: "2026-06-06T09:56:00.000Z",
        finishedAt: "2026-06-06T09:57:00.000Z",
        error: "row_errors:subscription_template_snapshot_missing=1",
        supportCode: null,
      }, {
        jobName: job.jobName,
        status: "success",
        startedAt: "2026-06-06T09:58:00.000Z",
        finishedAt: "2026-06-06T09:59:00.000Z",
        error: null,
        supportCode: null,
      }],
    }, [job], now);
    expect(recovered.map((decision) => decision.dedupeKey)).not.toContain("job_failed:subscription-renewal-runtime");
  });

  it("raises a p2 early warning for active subscriptions without a chargeable payment method, gated on the renewal flag", () => {
    const withFlag = evaluateObservability({
      ...baseSnapshot(),
      runtimeFlags: { COMMERCE_SUBSCRIPTION_RENEWAL_RUNTIME_ENABLED: true },
      subscriptions: {
        dueCycleWithoutOrderCount: 0,
        upcomingDeliveryReminderMissingCount: 0,
        activeWithoutPaymentMethodCount: 4,
      },
    }, JOB_CATALOG, now);
    const alert = withFlag.find((decision) => decision.dedupeKey === "subscription_active_without_payment_method");
    expect(alert).toBeDefined();
    expect(alert?.severity).toBe("p2");

    // Flag off → no alert even with a non-zero count.
    const withoutFlag = evaluateObservability({
      ...baseSnapshot(),
      subscriptions: {
        dueCycleWithoutOrderCount: 0,
        upcomingDeliveryReminderMissingCount: 0,
        activeWithoutPaymentMethodCount: 4,
      },
    }, JOB_CATALOG, now);
    expect(withoutFlag.map((decision) => decision.dedupeKey)).not.toContain("subscription_active_without_payment_method");

    // Zero count → no alert.
    const zero = evaluateObservability({
      ...baseSnapshot(),
      runtimeFlags: { COMMERCE_SUBSCRIPTION_RENEWAL_RUNTIME_ENABLED: true },
      subscriptions: {
        dueCycleWithoutOrderCount: 0,
        upcomingDeliveryReminderMissingCount: 0,
        activeWithoutPaymentMethodCount: 0,
      },
    }, JOB_CATALOG, now);
    expect(zero.map((decision) => decision.dedupeKey)).not.toContain("subscription_active_without_payment_method");
  });

  it("alerts on stale due outbox_events only while outbox dispatch monitoring is enabled", () => {
    const snapshot = {
      ...baseSnapshot(),
      runtimeFlags: { COMMERCE_OUTBOX_DISPATCH_ENABLED: true },
      queues: [{
        queueName: "outbox_events",
        jobName: "outbox-dispatch",
        queuedCount: 4,
        oldestQueuedAt: "2026-06-06T08:00:00.000Z",
        failedCount: 1,
        skippedCount: 0,
      }],
    } satisfies ObservabilitySnapshot;

    const decisions = evaluateObservability(snapshot, JOB_CATALOG, now);
    expect(decisions.map((decision) => decision.dedupeKey)).toContain("queue_backlog:outbox_events");

    const disabled = evaluateObservability({
      ...snapshot,
      runtimeFlags: {},
    }, JOB_CATALOG, now);
    expect(disabled.map((decision) => decision.dedupeKey)).not.toContain("queue_backlog:outbox_events");
  });

  it("registers PSP reconciliation and stuck-processing monitors behind the PSP observability flag", () => {
    const pspJobs = JOB_CATALOG.filter((job) => job.requiresFlag === "COMMERCE_PSP_OBSERVABILITY_ENABLED");

    expect(pspJobs.map((job) => job.jobName)).toEqual([
      "payment-provider-reconciliation",
      "payment-stuck-processing-watchdog",
    ]);
    expect(pspJobs.every((job) => job.owner === "commerce/payment")).toBe(true);
    expect(pspJobs.every((job) => job.alertChannels.includes("webhook"))).toBe(true);
    expect(pspJobs.find((job) => job.jobName === "payment-stuck-processing-watchdog")?.evidenceModel)
      .toBe("effect_only");
  });

  it("does not require a synthetic ledger for effect-only payment evidence", () => {
    const decisions = evaluateObservability({
      ...baseSnapshot(),
      runtimeFlags: { COMMERCE_PSP_OBSERVABILITY_ENABLED: true },
      jobControls: [],
    }, JOB_CATALOG.filter((job) => job.jobName === "payment-stuck-processing-watchdog"), now);

    expect(decisions.map((decision) => decision.dedupeKey))
      .not.toContain("job_ledger_missing:payment-stuck-processing-watchdog");
  });

  it("does not infer an hourly cadence for manually invoked KSeF status checks", () => {
    const decisions = evaluateObservability({
      ...baseSnapshot(),
      runtimeFlags: { COMMERCE_ACCOUNTING_OBSERVABILITY_ENABLED: true },
      jobControls: [{
        jobName: "accounting-ksef-status",
        enabled: true,
        lastSuccessAt: null,
        lastStartedAt: null,
        lastFinishedAt: null,
        lastStatus: null,
        leaseUntil: null,
      }],
    }, JOB_CATALOG.filter((job) => job.jobName === "accounting-ksef-status"), now);

    expect(decisions.map((decision) => decision.dedupeKey))
      .not.toContain("job_never_succeeded:accounting-ksef-status");
  });

  it("detects PSP reconciliation mismatches only while PSP observability is enabled", () => {
    const decisions = evaluateObservability({
      ...baseSnapshot(),
      runtimeFlags: { COMMERCE_PSP_OBSERVABILITY_ENABLED: true },
      payments: {
        ...baseSnapshot().payments,
        providerPaidLocalUnpaidCount: 1,
        localPaidProviderUnpaidCount: 1,
        preparedWithoutProviderAckCount: 1,
        webhookMissingCount: 1,
        stuckProcessingCount: 1,
        amountCurrencyMismatchCount: 1,
        signatureFailureCount: 1,
        recoveryRequiredWithoutLinkCount: 1,
        evidence: [
          {
            kind: "provider_paid_local_unpaid",
            provider: "stripe",
            paymentIntentId: "payment-intent-1",
            providerPaymentId: "pi_1",
            reason: "provider_success_event_local_processing",
            observedAt: now.toISOString(),
          },
          {
            kind: "prepared_without_provider_ack",
            provider: "tpay",
            paymentIntentId: "payment-intent-2",
            paymentAttemptId: "payment-attempt-2",
            subscriptionId: "sub-1",
            subscriptionCycleId: "cycle-1",
            providerPaymentId: "payid_reusable_alias",
            reason: "prepared_subscription_attempt_without_provider_ack",
            observedAt: now.toISOString(),
          },
          {
            kind: "signature_failure",
            provider: "tpay",
            providerEventId: "unknown",
            reason: "signature_rejected",
            observedAt: now.toISOString(),
          },
        ],
      },
    }, JOB_CATALOG, now);

    expect(decisions.map((decision) => decision.dedupeKey)).toEqual(expect.arrayContaining([
      "payment_provider_paid_local_unpaid",
      "payment_local_paid_provider_unpaid",
      "payment_prepared_without_provider_ack",
      "payment_webhook_missing",
      "payment_stuck_processing",
      "payment_amount_currency_mismatch",
      "payment_signature_failure",
      "payment_recovery_missing",
    ]));
    expect(JSON.stringify(decisions)).not.toContain("client_secret");
    expect(JSON.stringify(decisions)).not.toContain("blik");
    expect(JSON.stringify(decisions)).not.toContain("payid_reusable_alias");
    expect(JSON.stringify(decisions)).not.toContain("pi_1");

    const disabled = evaluateObservability({
      ...baseSnapshot(),
      payments: { ...baseSnapshot().payments, stuckProcessingCount: 1 },
    }, JOB_CATALOG, now);
    expect(disabled.map((decision) => decision.dedupeKey)).not.toContain("payment_stuck_processing");
  });

  it("emits one stronger payment mismatch incident without derived stuck alerts", () => {
    const decisions = evaluateObservability({
      ...baseSnapshot(),
      runtimeFlags: { COMMERCE_PSP_OBSERVABILITY_ENABLED: true },
      payments: {
        ...baseSnapshot().payments,
        amountCurrencyMismatchCount: 1,
        evidence: [{
          kind: "amount_currency_mismatch",
          provider: "stripe",
          paymentIntentId: "payment-intent-1",
          paymentAttemptId: "payment-attempt-1",
          providerPaymentId: "redacted_provider_reference",
          owner: "commerce/payment",
          customerSafeStatus: "operator_review_required",
          operatorNextAction: "inspect_provider_before_retry",
          reason: "provider_amount_mismatch",
          observedAt: now.toISOString(),
        }],
      },
    }, JOB_CATALOG, now);

    const paymentDecisions = decisions.filter((decision) => decision.dedupeKey.startsWith("payment_"));
    expect(paymentDecisions).toHaveLength(1);
    expect(paymentDecisions[0]).toMatchObject({
      dedupeKey: "payment_amount_currency_mismatch",
      severity: "p0",
      payload: { count: 1 },
    });
  });

  it("alerts on leaked checkout reservation holds regardless of the PSP observability flag", () => {
    const leaked = evaluateObservability({
      ...baseSnapshot(),
      payments: { ...baseSnapshot().payments, leakedCheckoutReservationCount: 3 },
    }, JOB_CATALOG, now);
    const decision = leaked.find((d) => d.dedupeKey === "checkout_reservation_leak");
    expect(decision).toBeDefined();
    expect(decision?.severity).toBe("p1");
    expect(decision?.payload).toMatchObject({ leakedCheckoutReservationCount: 3 });

    const clean = evaluateObservability({
      ...baseSnapshot(),
      payments: { ...baseSnapshot().payments, leakedCheckoutReservationCount: 0 },
    }, JOB_CATALOG, now);
    expect(clean.map((d) => d.dedupeKey)).not.toContain("checkout_reservation_leak");
  });

  it("alerts on leaked subscription retry holds with release-only remediation guidance", () => {
    const decisions = evaluateObservability({
      ...baseSnapshot(),
      payments: { ...baseSnapshot().payments, leakedSubscriptionRetryReservationCount: 4 },
    }, JOB_CATALOG, now);
    const decision = decisions.find((d) => d.dedupeKey === "subscription_retry_reservation_leak");
    expect(decision).toBeDefined();
    expect(decision?.severity).toBe("p1");
    expect(decision?.message).toContain("release-only");
    expect(decision?.payload).toMatchObject({ leakedSubscriptionRetryReservationCount: 4 });
  });

  it("alerts on reserved balance drift with per-slot evidence samples", () => {
    const decisions = evaluateObservability({
      ...baseSnapshot(),
      payments: {
        ...baseSnapshot().payments,
        reservedBalanceDriftCount: 2,
        reservedBalanceDriftEvidence: [
          { skuId: "sku-1", locationId: "loc-1", lotKey: null, balanceReserved: 23, activeReserved: 0, drift: 23 },
          { skuId: "sku-2", locationId: "loc-1", lotKey: "lot-a", balanceReserved: 30, activeReserved: 5, drift: 25 },
        ],
      },
    }, JOB_CATALOG, now);
    const decision = decisions.find((d) => d.dedupeKey === "inventory_reserved_balance_drift");
    expect(decision).toBeDefined();
    expect(decision?.severity).toBe("p1");
    expect(decision?.payload).toMatchObject({ reservedBalanceDriftCount: 2 });
    expect((decision?.payload as { evidence: unknown[] }).evidence).toHaveLength(2);
  });

  it("surfaces stranded payment attempts only while PSP reconciliation is disabled", () => {
    const strandedPayments = {
      ...baseSnapshot().payments,
      preparedWithoutProviderAckCount: 1,
      webhookMissingCount: 2,
      stuckProcessingCount: 1,
    };

    const flagOff = evaluateObservability({
      ...baseSnapshot(),
      payments: strandedPayments,
    }, JOB_CATALOG, now);
    const decision = flagOff.find((d) => d.dedupeKey === "payment_attempt_stranded");
    expect(decision).toBeDefined();
    expect(decision?.severity).toBe("p1");
    expect(decision?.payload).toMatchObject({ strandedCount: 4 });

    const flagOn = evaluateObservability({
      ...baseSnapshot(),
      runtimeFlags: { COMMERCE_PSP_OBSERVABILITY_ENABLED: true },
      payments: strandedPayments,
    }, JOB_CATALOG, now);
    expect(flagOn.map((d) => d.dedupeKey)).not.toContain("payment_attempt_stranded");
    expect(flagOn.map((d) => d.dedupeKey)).toContain("payment_webhook_missing");
  });

  it("alerts on overdue pending-activation subscriptions regardless of runtime flags", () => {
    const decisions = evaluateObservability({
      ...baseSnapshot(),
      subscriptions: { ...baseSnapshot().subscriptions, pendingActivationOverdueCount: 684 },
    }, JOB_CATALOG, now);
    const decision = decisions.find((d) => d.dedupeKey === "subscription_pending_activation_overdue");
    expect(decision).toBeDefined();
    expect(decision?.severity).toBe("p1");
    expect(decision?.payload).toMatchObject({ count: 684 });
  });

  it("alerts on active zero-line subscriptions regardless of runtime flags", () => {
    const quiet = evaluateObservability({
      ...baseSnapshot(),
      subscriptions: { ...baseSnapshot().subscriptions, zeroLineActiveCount: 0 },
    }, JOB_CATALOG, now);
    expect(quiet.map((d) => d.dedupeKey)).not.toContain("subscription_active_zero_lines");

    // Renewal runtime explicitly disabled: the guard-bypass evidence must not
    // hide behind COMMERCE_SUBSCRIPTION_RENEWAL_RUNTIME_ENABLED.
    const decisions = evaluateObservability({
      ...baseSnapshot(),
      runtimeFlags: { COMMERCE_SUBSCRIPTION_RENEWAL_RUNTIME_ENABLED: false },
      subscriptions: { ...baseSnapshot().subscriptions, zeroLineActiveCount: 2 },
    }, JOB_CATALOG, now);
    const decision = decisions.find((d) => d.dedupeKey === "subscription_active_zero_lines");
    expect(decision).toBeDefined();
    expect(decision?.severity).toBe("p1");
    expect(decision?.payload).toMatchObject({ count: 2 });
  });

  it("pages p0 for a due renewal with no charge attempt, whatever the runtime flag says", () => {
    const zero = evaluateObservability({
      ...baseSnapshot(),
      subscriptions: { ...baseSnapshot().subscriptions, dueCycleUnattemptedCount: 0 },
    }, JOB_CATALOG, now);
    expect(zero.map((d) => d.dedupeKey)).not.toContain("subscription_cycle_unattempted");

    // Absent, false and true: "renewals cannot charge" is the same outage in all
    // three, and the flag being off is the state that produces it.
    for (const runtimeFlags of [{}, { COMMERCE_SUBSCRIPTION_RENEWAL_RUNTIME_ENABLED: false }, { COMMERCE_SUBSCRIPTION_RENEWAL_RUNTIME_ENABLED: true }]) {
      const decisions = evaluateObservability({
        ...baseSnapshot(),
        runtimeFlags,
        subscriptions: {
          ...baseSnapshot().subscriptions,
          dueCycleUnattemptedCount: 3,
          dueCycleUnattemptedEvidence: [{ subscriptionId: "sub-oldest", nextCycleAt: "2026-07-01T12:00:00.000Z", ageSeconds: 172800 }],
        },
      }, JOB_CATALOG, now);
      const decision = decisions.find((d) => d.dedupeKey === "subscription_cycle_unattempted");
      expect(decision, JSON.stringify(runtimeFlags)).toBeDefined();
      expect(decision?.severity).toBe("p0");
      expect(decision?.owner).toBe("commerce/subscription-support");
      expect(decision?.runbookUrl).toBe("/docs/platform/RUNTIME_AND_SELF_HOSTING.md#subscription_cycle_unattempted-p0");
      expect(decision?.payload).toMatchObject({
        count: 3,
        evidence: [{ subscriptionId: "sub-oldest", nextCycleAt: "2026-07-01T12:00:00.000Z", ageSeconds: 172800 }],
      });
    }
  });

  it("alerts on quarantined renewal rows regardless of runtime flags", () => {
    const quiet = evaluateObservability({
      ...baseSnapshot(),
      subscriptions: { ...baseSnapshot().subscriptions, renewalRowQuarantinedCount: 0 },
    }, JOB_CATALOG, now);
    expect(quiet.map((d) => d.dedupeKey)).not.toContain("renewal_row_quarantined");

    // A quarantine OUTLIVES the runtime that created it, and while its window is
    // open the row is silent by construction. Gating this on the renewal flag
    // would hide exactly the rows nobody is processing.
    const decisions = evaluateObservability({
      ...baseSnapshot(),
      runtimeFlags: { COMMERCE_SUBSCRIPTION_RENEWAL_RUNTIME_ENABLED: false },
      subscriptions: { ...baseSnapshot().subscriptions, renewalRowQuarantinedCount: 1 },
    }, JOB_CATALOG, now);
    const decision = decisions.find((d) => d.dedupeKey === "renewal_row_quarantined");
    expect(decision).toBeDefined();
    expect(decision?.severity).toBe("p1");
    expect(decision?.payload).toMatchObject({ count: 1 });
  });

  it("alerts on stored mandates that cannot back the next renewal, regardless of runtime flags", () => {
    const quiet = evaluateObservability({
      ...baseSnapshot(),
      subscriptions: { ...baseSnapshot().subscriptions, methodHealthUnchargeableCount: 0 },
    }, JOB_CATALOG, now);
    expect(quiet.map((d) => d.dedupeKey)).not.toContain("subscription_method_health_unchargeable");

    // These rows are certain future refusals, so they must not hide behind the
    // renewal runtime flag: turning the lane off is exactly when they pile up.
    const decisions = evaluateObservability({
      ...baseSnapshot(),
      runtimeFlags: { COMMERCE_SUBSCRIPTION_RENEWAL_RUNTIME_ENABLED: false },
      subscriptions: { ...baseSnapshot().subscriptions, methodHealthUnchargeableCount: 7 },
    }, JOB_CATALOG, now);
    const decision = decisions.find((d) => d.dedupeKey === "subscription_method_health_unchargeable");
    expect(decision).toBeDefined();
    // p2, not p1: the charge has not been refused yet, so there is repair time.
    expect(decision?.severity).toBe("p2");
    expect(decision?.payload).toMatchObject({ count: 7 });
  });

  it("raises the complementary activation-gap signal without duplicating the narrow p1", () => {
    const quiet = evaluateObservability({
      ...baseSnapshot(),
      subscriptions: { ...baseSnapshot().subscriptions, methodHealthActivationGapCount: 0 },
    }, JOB_CATALOG, now);
    expect(quiet.map((d) => d.dedupeKey)).not.toContain("subscription_method_health_activation_gap");

    // The load-bearing assertion of this pair: a fleet that is BOTH overdue on
    // the narrow detector and carrying broader gaps produces exactly two
    // decisions with two dedupe keys and two severities — never one root cause
    // paging twice under the same key.
    const decisions = evaluateObservability({
      ...baseSnapshot(),
      subscriptions: {
        ...baseSnapshot().subscriptions,
        pendingActivationOverdueCount: 3,
        methodHealthActivationGapCount: 5,
      },
    }, JOB_CATALOG, now);
    const narrow = decisions.find((d) => d.dedupeKey === "subscription_pending_activation_overdue");
    const complement = decisions.find((d) => d.dedupeKey === "subscription_method_health_activation_gap");
    expect(narrow?.severity).toBe("p1");
    expect(narrow?.payload).toMatchObject({ count: 3 });
    expect(complement?.severity).toBe("p2");
    expect(complement?.payload).toMatchObject({ count: 5 });
    expect(decisions.filter((d) => d.dedupeKey.includes("activation"))).toHaveLength(2);
  });

  // ⛔ ESCALATION, NOT PARTITION. The overdue p1 counts a SUBSET of the rows the
  // p2 counts, and both must fire on those rows. If a future change made them
  // exclusive, the live p2 would silently stop covering the worst cases — which
  // is the exact failure of a presence signal with no clock that let one
  // subscription wait 38 days without anyone hearing about it.
  it("escalates an aged activation gap to p1 while the presence p2 keeps firing", () => {
    const decisions = evaluateObservability({
      ...baseSnapshot(),
      subscriptions: {
        ...baseSnapshot().subscriptions,
        methodHealthActivationGapCount: 4,
        methodHealthActivationGapOverdueCount: 1,
      },
    }, JOB_CATALOG, now);
    const presence = decisions.find((d) => d.dedupeKey === "subscription_method_health_activation_gap");
    const overdue = decisions.find((d) => d.dedupeKey === "subscription_method_health_activation_gap_overdue");
    expect(presence?.severity).toBe("p2");
    expect(presence?.payload).toMatchObject({ count: 4 });
    expect(overdue?.severity).toBe("p1");
    expect(overdue?.payload).toMatchObject({ count: 1 });
  });

  it("stays quiet on the escalation when no gap is old enough", () => {
    const decisions = evaluateObservability({
      ...baseSnapshot(),
      subscriptions: { ...baseSnapshot().subscriptions, methodHealthActivationGapCount: 4 },
    }, JOB_CATALOG, now);
    expect(decisions.map((d) => d.dedupeKey))
      .not.toContain("subscription_method_health_activation_gap_overdue");
  });

  // ⛔ THE ONE PROPERTY THIS WAVE EXISTS FOR.
  //
  // The card dead-end incident happened with COMMERCE_PSP_OBSERVABILITY_ENABLED
  // switched ON and produced no signal at all. Both replacements therefore have
  // to fire in EVERY flag state — absent, false and true. A future refactor that
  // folds them into the gated payment collector would rebuild the single point
  // of silence, and this is the test that has to fail when it does.
  it("raises the card dead-end signals in every state of the PSP observability flag", () => {
    const evidence = [
      {
        kind: "abandoned_before_confirmation" as const,
        reason: "reconciler_settled_payment_never_confirmed_by_buyer",
        observedAt: now.toISOString(),
      },
      {
        kind: "pending_payment_past_recovery_window" as const,
        reason: "pending_payment_order_outlived_recovery_reminders",
        observedAt: now.toISOString(),
      },
    ];
    for (const flags of [{}, { COMMERCE_PSP_OBSERVABILITY_ENABLED: false }, { COMMERCE_PSP_OBSERVABILITY_ENABLED: true }]) {
      const decisions = evaluateObservability({
        ...baseSnapshot(),
        runtimeFlags: flags,
        payments: { ...baseSnapshot().payments, evidence },
      }, JOB_CATALOG, now);
      const acked = decisions.find((d) => d.dedupeKey === "payment_abandoned_before_confirmation");
      const pending = decisions.find((d) => d.dedupeKey === "order_pending_payment_past_recovery_window");
      expect(acked?.severity, JSON.stringify(flags)).toBe("p1");
      expect(acked?.payload, JSON.stringify(flags)).toMatchObject({ count: 1 });
      expect(pending?.severity, JSON.stringify(flags)).toBe("p1");
      expect(pending?.payload, JSON.stringify(flags)).toMatchObject({ count: 1 });
    }
  });

  it("stays silent on the card dead-end signals when no evidence carries their kinds", () => {
    const decisions = evaluateObservability(baseSnapshot(), JOB_CATALOG, now).map((d) => d.dedupeKey);
    expect(decisions).not.toContain("payment_abandoned_before_confirmation");
    expect(decisions).not.toContain("order_pending_payment_past_recovery_window");
  });

  it("alerts on paid renewal orders without fulfillment progress", () => {
    const decisions = evaluateObservability({
      ...baseSnapshot(),
      subscriptions: {
        ...baseSnapshot().subscriptions,
        paidRenewalWithoutFulfillmentCount: 1,
        evidence: [{
          kind: "paid_renewal_without_fulfillment",
          subscriptionId: "sub-1",
          subscriptionCycleId: "cycle-1",
          orderId: "order-1",
          reason: "paid_subscription_cycle_order_without_fulfillment_order",
          ageSeconds: 2400,
          owner: "commerce/fulfillment",
          customerSafeStatus: "paid_fulfillment_pending",
          operatorNextAction: "inspect_fulfillment_dispatch",
          observedAt: now.toISOString(),
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
        }],
      },
    }, JOB_CATALOG, now);

    const decision = decisions.find((d) => d.dedupeKey === "subscription_paid_renewal_without_fulfillment");
    expect(decision).toBeDefined();
    expect(decision?.severity).toBe("p1");
    expect(decision?.owner).toBe("commerce/fulfillment");
    expect(decision?.payload).toMatchObject({ count: 1 });
  });

  it("alerts on a transactional email failure spike (outbox-dispatch) above threshold, p2", () => {
    const spike = evaluateObservability({
      ...baseSnapshot(),
      emails: emailHealth({ failedBySource: { "outbox-dispatch": 4 } }),
    }, JOB_CATALOG, now);
    const decision = spike.find((d) => d.dedupeKey === "transactional_email_failures");
    expect(decision).toBeDefined();
    expect(decision?.severity).toBe("p2");
    expect(decision?.payload).toMatchObject({ transactionalFailed: 4 });

    // Below threshold (single bad address) → silent.
    const belowThreshold = evaluateObservability({
      ...baseSnapshot(),
      emails: emailHealth({ failedBySource: { "outbox-dispatch": 2 } }),
    }, JOB_CATALOG, now);
    expect(belowThreshold.map((d) => d.dedupeKey)).not.toContain("transactional_email_failures");

    // Dunning failures use the dedicated critical path, not this one.
    const dunningOnly = evaluateObservability({
      ...baseSnapshot(),
      emails: emailHealth({ criticalFailedCount: 5, failedBySource: { "subscription-dunning-dispatch": 5 } }),
    }, JOB_CATALOG, now);
    expect(dunningOnly.map((d) => d.dedupeKey)).not.toContain("transactional_email_failures");
    expect(dunningOnly.map((d) => d.dedupeKey)).toContain("critical_email_failed");
  });

  it("does not alert on fresh successful job evidence", () => {
    const decisions = evaluateObservability({
      ...baseSnapshot(),
      jobControls: [{
        jobName: "check-dhl-tracking",
        enabled: true,
        lastSuccessAt: "2026-06-06T09:40:00.000Z",
        lastStartedAt: "2026-06-06T09:40:00.000Z",
        lastFinishedAt: "2026-06-06T09:41:00.000Z",
        lastStatus: "success",
        leaseUntil: null,
      }],
    }, [JOB_CATALOG[0]], now);

    expect(decisions).toEqual([]);
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
    emails: emailHealth(),
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

function dueCycleEvidence(subscriptionId: string, ageSeconds: number) {
  return {
    kind: "due_cycle_without_order" as const,
    subscriptionId,
    nextCycleAt: "2026-06-06T00:00:00.000Z",
    reason: "active_subscription_due_without_order_evidence" as const,
    ageSeconds,
    owner: "commerce/subscription-support" as const,
    customerSafeStatus: "operator_review_required" as const,
    operatorNextAction: "inspect_subscription_scheduler" as const,
    observedAt: now.toISOString(),
    triageContext: triageContext(),
  };
}

function paidRenewalEvidence(subscriptionId: string) {
  return {
    kind: "paid_renewal_without_fulfillment" as const,
    subscriptionId,
    subscriptionCycleId: "cycle-1",
    orderId: "order-1",
    reason: "paid_subscription_cycle_order_without_fulfillment_order",
    ageSeconds: 3_600,
    owner: "commerce/fulfillment" as const,
    customerSafeStatus: "paid_fulfillment_pending" as const,
    operatorNextAction: "inspect_fulfillment_dispatch" as const,
    observedAt: now.toISOString(),
    triageContext: triageContext(),
  };
}

function triageContext() {
  return {
    localPaymentStatus: null,
    subscriptionCycleStatus: null,
    orderStatus: null,
    outboxStatus: null,
    outboxAvailableAt: null,
    outboxAttempts: null,
    fulfillmentEligibilityReason: "cycle_order_missing" as const,
    fulfillmentRecoveryPosture: "manual_review" as const,
    lockedCycleSummary: null,
    futureTemplateSummary: null,
  };
}

function emailHealth(overrides: Partial<ObservabilitySnapshot["emails"]> = {}): ObservabilitySnapshot["emails"] {
  return {
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
    ...overrides,
  };
}
