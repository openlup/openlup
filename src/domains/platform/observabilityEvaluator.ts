import type { AlertDecision, DunningHealthSnapshot, JobCatalogEntry, ObservabilitySnapshot, QueueHealthSnapshot, RecipientHealthSnapshot } from "./observabilityContracts.js";
import { collectCardDeadEndPaymentAlerts, collectPaymentAlerts, collectReservationLeakAlerts, collectStrandedPaymentAlerts } from "./paymentObservabilityEvaluator.js";
import { collectOmniPackAlerts } from "./omnipackObservabilityEvaluator.js";
import { collectAccountingAlerts } from "./accountingObservabilityEvaluator.js";
import { collectEmailAlerts } from "./emailObservabilityEvaluator.js";
import { urgencyForSeverity } from "./alertHumanContext.js";
import { collectOrderMoneyReconciliationAlerts } from "./orderMoneyReconciliationEvaluator.js";
import { collectScheduledJobAlerts, jobAlert } from "./scheduledJobHealthEvaluator.js";
import { collectPromotionHealthAlerts } from "./promotionObservabilityEvaluator.js";

const MILLIS_PER_SECOND = 1000;
export function evaluateObservability(
  snapshot: ObservabilitySnapshot,
  catalog: readonly JobCatalogEntry[],
  now: Date,
): AlertDecision[] {
  const decisions: AlertDecision[] = [];
  const controls = new Map(snapshot.jobControls.map((control) => [control.jobName, control]));

  for (const job of catalog) {
    if (!isJobMonitorActive(job, snapshot)) continue;
    if (job.evidenceModel === "effect_only") continue;
    const control = controls.get(job.jobName);
    if (!control) {
      decisions.push(jobAlert(job, "job_ledger_missing", "Job ledger missing", {
        message: `${job.jobName} has no platform_job_controls evidence.`,
      }));
      continue;
    }
    if (!control.enabled) continue;
    collectScheduledJobAlerts(decisions, job, control, snapshot.recentJobRuns, now);
  }

  for (const queue of snapshot.queues) {
    const job = queue.jobName ? catalog.find((entry) => entry.jobName === queue.jobName) : undefined;
    if (job && !isJobMonitorActive(job, snapshot)) continue;
    collectQueueAlerts(decisions, queue, job, now);
  }

  collectRecipientAlerts(decisions, snapshot.recipients, snapshot);
  collectDunningAlerts(decisions, snapshot.dunning);
  collectSubscriptionAlerts(decisions, snapshot);
  collectEmailAlerts(decisions, snapshot);
  collectPaymentAlerts(decisions, snapshot);
  collectReservationLeakAlerts(decisions, snapshot);
  collectStrandedPaymentAlerts(decisions, snapshot); collectCardDeadEndPaymentAlerts(decisions, snapshot);
  collectAccountingAlerts(decisions, snapshot);
  collectOmniPackAlerts(decisions, snapshot);
  collectOrderMoneyReconciliationAlerts(decisions, snapshot.orderMoneyReconciliation);
  collectPromotionHealthAlerts(decisions, snapshot.promotionHealth);

  return sortDecisions(decisions);
}

function isJobMonitorActive(job: JobCatalogEntry, snapshot: ObservabilitySnapshot): boolean {
  if (job.monitoringState === "legacy_out_of_scope") return false;
  return !job.requiresFlag || snapshot.runtimeFlags[job.requiresFlag] === true;
}

function collectQueueAlerts(
  decisions: AlertDecision[],
  queue: QueueHealthSnapshot,
  job: JobCatalogEntry | undefined,
  now: Date,
) {
  const owner = job?.owner ?? "platform/ops";
  const severity = job?.severity ?? "p2";
  const runbookUrl = job?.runbookUrl ?? "/docs/platform/RUNTIME_AND_SELF_HOSTING.md";
  const channels = job?.alertChannels ?? ["webhook"];

  if (queue.oldestQueuedAt && job?.queueBacklogGraceSeconds) {
    const ageSeconds = secondsSince(queue.oldestQueuedAt, now);
    if (ageSeconds > job.queueBacklogGraceSeconds) {
      decisions.push({
        dedupeKey: `queue_backlog:${queue.queueName}`,
        severity,
        owner,
        runbookUrl,
        title: "Queue backlog",
        message: `${queue.queueName} has queued work older than ${Math.floor(ageSeconds / 60)} minutes.`,
        humanContext: {
          incidentClass: "queue_backlog",
          impact: `${queue.queueName} has work stuck past its SLA; customer-facing side effects may be delayed until the queue drains.`,
          firstAction: `Inspect the ${queue.queueName} rows, then check the owning job run ledger before replaying or clearing work.`,
          urgency: urgencyForSeverity(severity),
        },
        channels,
        payload: { queueName: queue.queueName, queuedCount: queue.queuedCount, oldestQueuedAt: queue.oldestQueuedAt },
      });
    }
  }

  if ((queue.criticalFailedCount ?? 0) + (queue.criticalSkippedCount ?? 0) > 0) {
    decisions.push({
      dedupeKey: `critical_queue_failure:${queue.queueName}`,
      severity: severity === "p3" ? "p2" : severity,
      owner,
      runbookUrl,
      title: "Critical queue delivery failed",
      message: `${queue.queueName} has failed or skipped critical notifications.`,
      humanContext: {
        incidentClass: "customer_communication_failure",
        impact: `${queue.queueName} has failed or skipped critical notifications, so a customer or operator may not have received required communication.`,
        firstAction: `Open recent failed/skipped ${queue.queueName} records and compare them with the owning job's latest platform_job_runs entry.`,
        urgency: urgencyForSeverity(severity === "p3" ? "p2" : severity),
      },
      channels,
      payload: { ...queue, count: (queue.criticalFailedCount ?? 0) + (queue.criticalSkippedCount ?? 0) }, // `count`: the only magnitude evidenceSummary renders on an ntfy page
    });
  }
}

function collectRecipientAlerts(
  decisions: AlertDecision[],
  recipients: RecipientHealthSnapshot[],
  snapshot: ObservabilitySnapshot,
) {
  for (const recipient of recipients) {
    if (recipient.requiredWhenFlag && snapshot.runtimeFlags[recipient.requiredWhenFlag] !== true) continue;
    if (recipient.activeCount > 0) continue;
    decisions.push({
      dedupeKey: `missing_recipient:${recipient.notificationType}`,
      severity: "p1",
      owner: "platform/communications",
      runbookUrl: "/docs/platform/RUNTIME_AND_SELF_HOSTING.md",
      title: "Critical notification recipient missing",
      message: `${recipient.notificationType} has no active recipients.`,
      humanContext: {
        incidentClass: "recipient_configuration_failure",
        impact: `${recipient.notificationType} cannot notify anyone while no active recipient is configured.`,
        firstAction: "Restore the recipient configuration before replaying the failed notification path.", urgency: urgencyForSeverity("p1"),
      },
      channels: ["webhook"],
      payload: recipient,
    });
  }
}

function collectDunningAlerts(decisions: AlertDecision[], dunning: DunningHealthSnapshot) {
  pushCountAlert(decisions, dunning.overdueRetryCount, "dunning_retry_overdue", "Overdue dunning retry", "p1");
  pushCountAlert(decisions, dunning.expiredWithoutCustomerNoticeCount, "dunning_expired_notice_missing", "Expired dunning notice missing", "p1");
  pushCountAlert(decisions, dunning.failureWithoutAdminAlertCount, "dunning_admin_alert_missing", "Payment failure admin alert missing", "p1");
  pushCountAlert(decisions, dunning.failedAdminNotificationCount, "dunning_admin_alert_failed", "Payment failure admin alert failed", "p1");
  pushCountAlert(decisions, dunning.skippedAdminNotificationCount, "dunning_admin_alert_skipped", "Payment failure admin alert skipped", "p1");

  if (dunning.expiredCount24h >= 3 && dunning.expiredCount24h > dunning.recoveredCount24h) {
    decisions.push(baseSubscriptionAlert("dunning_recovery_ratio_spike", "Dunning expired/recovered ratio spike", {
      expiredCount24h: dunning.expiredCount24h, recoveredCount24h: dunning.recoveredCount24h,
    }));
  }
}

function collectSubscriptionAlerts(decisions: AlertDecision[], snapshot: ObservabilitySnapshot) {
  if (snapshot.runtimeFlags.COMMERCE_SUBSCRIPTION_RENEWAL_RUNTIME_ENABLED === true) {
    // Same dedupe key, severity, and >0 threshold as the count-only form it
    // replaces — only the payload grows. `{count}` alone forced the operator to
    // rediscover the subjects by hand; the collector already ranks the rows by
    // age, so naming them costs nothing and turns the page into triage.
    if (snapshot.subscriptions.dueCycleWithoutOrderCount > 0) {
      decisions.push(baseSubscriptionAlert(
        "subscription_cycle_due_without_order",
        "Subscription cycle due without order",
        buildDueCycleWithoutOrderPayload(snapshot.subscriptions),
      ));
    }
    // Early-warning (p2) form of the p1 above: the sub is not due yet, but its
    // next renewal will preflight-block for lack of a chargeable mandate. Kept
    // p2 so one root cause does not double-page — it escalates through the p1
    // once the subscription is actually due.
    pushCountAlert(decisions, snapshot.subscriptions.activeWithoutPaymentMethodCount ?? 0, "subscription_active_without_payment_method", "Active subscription without active payment method", "p2");
  }
  if (snapshot.runtimeFlags.COMMERCE_SUBSCRIPTION_DELIVERY_REMINDERS_ENABLED === true) {
    pushCountAlert(decisions, snapshot.subscriptions.upcomingDeliveryReminderMissingCount, "subscription_delivery_reminder_missing", "Subscription delivery reminder missing", "p2");
  }
  // Flag-independent on purpose, and the only renewal signal that must survive
  // the runtime flag being off: "due for renewal, never charged" is the same
  // outage whether the lane is disabled, stuck or never ran, so gating it would
  // hide it in exactly the state that produces it. Fixtures and the first 6h are
  // excluded upstream, so any count here is money that was never taken.
  // `count` leads the payload because it is the only magnitude an ntfy page renders.
  pushCountAlert(decisions, snapshot.subscriptions.dueCycleUnattemptedCount ?? 0, "subscription_cycle_unattempted", "Subscription due for renewal with no charge attempt", "p0", { evidence: (snapshot.subscriptions.dueCycleUnattemptedEvidence ?? []).slice(0, 10) }, "/docs/platform/RUNTIME_AND_SELF_HOSTING.md#subscription_cycle_unattempted-p0");
  // Flag-independent: pending_activation ghosts accumulate exactly when the
  // activation sweep (or its flag) is off, so this must not hide behind a gate.
  pushCountAlert(decisions, snapshot.subscriptions.pendingActivationOverdueCount ?? 0, "subscription_pending_activation_overdue", "Subscription stuck in pending activation", "p1");
  // Flag-independent like the two around it; p2 like activeWithoutPaymentMethod
  // because these renewals are certain to be refused but not yet due, so there
  // is repair time. Invisible on every other axis until the charge is tried.
  pushCountAlert(decisions, snapshot.subscriptions.methodHealthUnchargeableCount ?? 0, "subscription_method_health_unchargeable", "Stored mandate cannot back the next renewal", "p2");
  // COMPLEMENT of the p1 above, never an overlap: the evidence read subtracts
  // every row the narrow paid-activation detector matches before counting.
  pushCountAlert(decisions, snapshot.subscriptions.methodHealthActivationGapCount ?? 0, "subscription_method_health_activation_gap", "Activation gap outside the paid-activation detector", "p2");
  // ESCALATION of the p2 above, on the same rows, deliberately overlapping: past
  // 72h the gap is not a checkout in progress, it is an abandoned subscription
  // nobody will ever collect. The observed worst case had waited 38 days while
  // the p2 counted it in silence. Flag-independent like its parent.
  pushCountAlert(decisions, snapshot.subscriptions.methodHealthActivationGapOverdueCount ?? 0, "subscription_method_health_activation_gap_overdue", "Activation gap unresolved for more than 72 hours", "p1");
  // Flag-independent for a second reason: this is a guard-bypass signal, not a
  // renewal-pipeline signal. A store-level guard rejects every update into this
  // state, so a hit means some writer reached it another way — evidence that
  // must not depend on whether the renewal runtime happens to be enabled.
  pushCountAlert(decisions, snapshot.subscriptions.zeroLineActiveCount ?? 0, "subscription_active_zero_lines", "Active subscription has no subscription lines", "p1");
  // Flag-independent for the same reason as the two above: a quarantine is
  // durable state that OUTLIVES the runtime that created it. Gating this on the
  // renewal flag would hide exactly the rows nobody is processing at the moment
  // the flag goes off. It is also the only signal a quarantined cycle produces —
  // while its window is open the row raises no run-ledger error and sends the
  // customer nothing — so the quiet must page rather than pass for health.
  pushCountAlert(decisions, snapshot.subscriptions.renewalRowQuarantinedCount ?? 0, "renewal_row_quarantined", "Renewal row quarantined after repeated identical failures", "p1");
  const deliveryAlignmentOverdueCount = snapshot.subscriptions.deliveryAlignmentOverdueCount ?? 0;
  const deliveryAlignmentEvidence = (snapshot.subscriptions.deliveryAlignmentOverdueEvidence ?? []).slice(0, 10);
  pushCountAlert(decisions, deliveryAlignmentOverdueCount, "subscription_delivery_alignment_overdue", "Delivery protection remains unresolved after renewal date", "p1", {
    evidence: deliveryAlignmentEvidence, evidenceLimit: 10,
    droppedEvidenceCount: Math.max(0, deliveryAlignmentOverdueCount - deliveryAlignmentEvidence.length),
  });
  const paidRenewalWithoutFulfillment = snapshot.subscriptions.paidRenewalWithoutFulfillmentCount ?? 0;
  if (paidRenewalWithoutFulfillment > 0) {
    decisions.push({
      dedupeKey: "subscription_paid_renewal_without_fulfillment",
      severity: "p1",
      owner: "commerce/fulfillment",
      runbookUrl: "/docs/platform/RUNTIME_AND_SELF_HOSTING.md",
      title: "Paid renewal has no fulfillment progress",
      message: `${paidRenewalWithoutFulfillment} paid renewal order(s) need fulfillment operator review.`,
      channels: ["webhook"],
      payload: {
        count: paidRenewalWithoutFulfillment,
        evidence: (snapshot.subscriptions.evidence ?? []).filter((row) => row.kind === "paid_renewal_without_fulfillment").slice(0, 10),
      },
    });
  }
}

// Bounded so one systemic scheduler stall cannot turn a page into an unbounded
// payload. The cap is explicit, not silent: `droppedEvidenceCount` states how
// many aged-but-unlisted subjects exist, and `count` stays the full population.
const DUE_CYCLE_EVIDENCE_LIMIT = 10;

function buildDueCycleWithoutOrderPayload(
  subscriptions: ObservabilitySnapshot["subscriptions"],
): Record<string, unknown> {
  // Collector order is already `ageSeconds` descending, so the slice keeps the
  // oldest — the subjects most likely to be the root cause rather than a row
  // that happens to be one tick late.
  const rows = (subscriptions.evidence ?? []).filter((row) => row.kind === "due_cycle_without_order");
  const listed = rows.slice(0, DUE_CYCLE_EVIDENCE_LIMIT);
  const droppedEvidenceCount = rows.length - listed.length;
  if (droppedEvidenceCount > 0) {
    console.warn("[observability] due_cycle_without_order evidence truncated", {
      total: rows.length,
      listed: listed.length,
      dropped: droppedEvidenceCount,
    });
  }
  return {
    count: subscriptions.dueCycleWithoutOrderCount,
    // Deliberately projected rather than passed whole: `triageContext` carries
    // a JSONB-sourced `lineCount` that is known-misleading (own follow-up), and
    // an alert payload is the wrong place to ship a number an operator would
    // trust. Ids + due-since are what triage actually needs.
    evidence: listed.map((row) => ({
      subscriptionId: row.subscriptionId,
      nextCycleAt: row.nextCycleAt,
      ageSeconds: row.ageSeconds,
    })),
    evidenceLimit: DUE_CYCLE_EVIDENCE_LIMIT,
    droppedEvidenceCount,
  };
}

function pushCountAlert(
  decisions: AlertDecision[],
  count: number,
  dedupeKey: string,
  title: string,
  severity: "p0" | "p1" | "p2",
  details: Record<string, unknown> = {},
  runbookUrl?: string,
) {
  if (count <= 0) return;
  decisions.push(baseSubscriptionAlert(dedupeKey, title, { count, ...details }, severity, runbookUrl));
}

function baseSubscriptionAlert(
  dedupeKey: string,
  title: string,
  payload: Record<string, unknown>,
  severity: "p0" | "p1" | "p2" = "p1",
  runbookUrl = "/docs/platform/RUNTIME_AND_SELF_HOSTING.md",
): AlertDecision {
  return {
    dedupeKey,
    severity,
    owner: "commerce/subscription-support",
    runbookUrl,
    title,
    message: `${title}: support action required.`,
    channels: ["webhook"],
    payload,
  };
}

function secondsSince(timestamp: string, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - new Date(timestamp).getTime()) / MILLIS_PER_SECOND));
}

function sortDecisions(decisions: AlertDecision[]): AlertDecision[] {
  const rank = { p0: 0, p1: 1, p2: 2, p3: 3 };
  return [...decisions].sort((a, b) => rank[a.severity] - rank[b.severity] || a.dedupeKey.localeCompare(b.dedupeKey));
}
