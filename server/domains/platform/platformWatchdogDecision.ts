import type {
  AlertDecision,
  AlertNotificationOutcome,
  AlertSeverity,
} from "../../../src/domains/platform/observabilityContracts.js";
import type { AlertLedgerPort, AlertSinkPort } from "../../../src/domains/platform/observabilityPorts.js";
import { shouldPage } from "../../../src/domains/platform/alertPagingPolicy.js";
import { throttleSecondsForSeverity } from "../../../src/domains/platform/alertThrottlePolicy.js";
import {
  isActionabilitySuppressed,
  isDeliveryBackoff,
  isPagingSuppressed,
  notificationSchedule,
  shouldAttemptNotification,
} from "./platformWatchdogDeliveryPolicy.js";

const BELOW_PAGING_SEVERITY_OUTCOME: AlertNotificationOutcome = {
  channel: "webhook", status: "skipped", provider: "webhook", error: "below_paging_severity",
};
const NON_PAGEABLE_DIAGNOSTIC_OUTCOME: AlertNotificationOutcome = {
  channel: "webhook", status: "skipped", provider: "webhook", error: "non_pageable_diagnostic",
};

export function emptyWatchdogDecisionCounts() {
  return {
    notified: 0,
    notificationFailures: 0,
    deliveryBackoffCount: 0,
    throttledNotifications: 0,
    skippedNotifications: 0,
    belowThreshold: 0,
    suppressed: 0,
    actionableCriticalCount: 0,
    suppressedCriticalCount: 0,
    actionablePageableCount: 0,
  };
}

/** One complete ledger transition; callers must serialize the same dedupe key. */
export async function processWatchdogDecision(
  decision: AlertDecision,
  {
    ledgerPort, sinkPort, now, pagingMinSeverity, notificationThrottleSeconds,
  }: {
    ledgerPort: AlertLedgerPort;
    sinkPort: AlertSinkPort;
    now: Date;
    pagingMinSeverity: AlertSeverity;
    notificationThrottleSeconds?: number;
  },
) {
  const counts = emptyWatchdogDecisionCounts();
  const alert = await ledgerPort.upsertOpenAlert(decision, now);
  const critical = isCriticalDecision(decision);
  const actionableSuppressed = isActionabilitySuppressed(alert, now);
  const pagingSuppressed = isPagingSuppressed(alert, now);
  const pageable = decision.paging !== "never" && shouldPage(decision.severity, pagingMinSeverity);

  // Acknowledgement silences pages, but only a snooze suppresses actionability.
  if (critical) {
    if (actionableSuppressed) counts.suppressedCriticalCount += 1;
    else counts.actionableCriticalCount += 1;
  }
  if (pageable && !pagingSuppressed) counts.actionablePageableCount += 1;
  if (pageable && !pagingSuppressed && isDeliveryBackoff(alert, now)) counts.deliveryBackoffCount += 1;
  if (pagingSuppressed) {
    counts.suppressed += 1;
    return counts;
  }

  const throttleSeconds = notificationThrottleSeconds ?? throttleSecondsForSeverity(decision.severity);
  if (!shouldAttemptNotification(alert, now, throttleSeconds)) {
    counts.throttledNotifications += 1;
    return counts;
  }

  // Non-pageable and below-threshold alerts retain their skipped-attempt audit.
  const nonPageable = decision.paging === "never";
  const paging = !nonPageable && shouldPage(decision.severity, pagingMinSeverity);
  const outcome = paging
    ? await sinkPort.send(decision, alert)
    : nonPageable ? NON_PAGEABLE_DIAGNOSTIC_OUTCOME : BELOW_PAGING_SEVERITY_OUTCOME;
  if (outcome.status === "sent") counts.notified += 1;
  else if (outcome.status === "failed") counts.notificationFailures += 1;
  else counts.skippedNotifications += 1;
  if (!paging) counts.belowThreshold += 1;
  await ledgerPort.recordNotification(alert.id, outcome, now, notificationSchedule(alert, outcome, now, throttleSeconds));
  return counts;
}

export function isCriticalDecision(decision: AlertDecision): boolean {
  return decision.paging !== "never" && (decision.severity === "p0" || decision.severity === "p1");
}
