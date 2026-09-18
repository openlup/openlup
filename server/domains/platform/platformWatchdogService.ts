import type {
  AlertDecision,
  AlertSeverity,
  JobCatalogEntry,
} from "../../../src/domains/platform/observabilityContracts.js";
import {
  DEFAULT_PAGING_MIN_SEVERITY,
  shouldPage,
} from "../../../src/domains/platform/alertPagingPolicy.js";
import { evaluateObservability } from "../../../src/domains/platform/observabilityEvaluator.js";
import type {
  AlertLedgerPort,
  AlertSinkPort,
  ObservabilityEvidencePort,
} from "../../../src/domains/platform/observabilityPorts.js";
import {
  isActionabilitySuppressed,
  isDeliveryBackoff,
  isPagingSuppressed,
  isSeverityEscalation,
} from "./platformWatchdogDeliveryPolicy.js";

import {
  emptyWatchdogDecisionCounts,
  isCriticalDecision,
  processWatchdogDecision,
} from "./platformWatchdogDecision.js";
import { createSerialWatchdogSink, runWatchdogQueue } from "./platformWatchdogQueue.js";

export type PlatformWatchdogResult = {
  ok: boolean;
  health: "healthy" | "firing";
  checkOnly: boolean;
  checkedAt: string;
  alertCount: number;
  firingCount: number;
  /** P0/P1 incidents not covered by an active snooze and still requiring ownership. */
  actionableCriticalCount: number;
  /** P0/P1 incidents covered by an active snooze; acknowledged alerts stay actionable. */
  suppressedCriticalCount: number;
  /** Alerts that meet the current paging threshold and are not currently page-suppressed. */
  actionablePageableCount: number;
  maxSeverity: string | null;
  decisions: ReturnType<typeof evaluateObservability>;
  notified: number;
  notificationFailures: number;
  /** Failed deliveries held until their persisted bounded retry time. */
  deliveryBackoffCount: number;
  throttledNotifications: number;
  skippedNotifications: number;
  belowThreshold: number;
  suppressed: number;
  muted: number;
  resolved: number;
};

export async function runPlatformWatchdog({
  evidencePort,
  ledgerPort,
  sinkPort,
  catalog,
  now = new Date(),
  checkOnly,
  notificationThrottleSeconds,
  pagingMinSeverity = DEFAULT_PAGING_MIN_SEVERITY,
  mutedDedupePrefixes = [],
  normalizeDecision,
}: {
  evidencePort: ObservabilityEvidencePort;
  ledgerPort: AlertLedgerPort;
  sinkPort: AlertSinkPort;
  catalog: readonly JobCatalogEntry[];
  now?: Date;
  checkOnly: boolean;
  /** Flat override; when omitted, the throttle is scaled per alert severity. */
  notificationThrottleSeconds?: number;
  pagingMinSeverity?: AlertSeverity;
  /**
   * Dedupe-key prefixes fully muted for this environment (e.g. `job_missed` on a
   * staging host with no real crons). Muted signals are not recorded, not paged,
   * and existing open rows for them auto-resolve — keeping the ledger clean.
   */
  mutedDedupePrefixes?: readonly string[];
  normalizeDecision?: (decision: AlertDecision) => AlertDecision;
}): Promise<PlatformWatchdogResult> {
  const snapshot = await evidencePort.collectSnapshot(now);
  const allDecisions = evaluateObservability(snapshot, catalog, now);
  const decisions = allDecisions
    .filter((decision) => !isMuted(decision.dedupeKey, mutedDedupePrefixes))
    .map((decision) => normalizeDecision ? normalizeDecision(decision) : decision);
  const muted = allDecisions.length - decisions.length;
  const firingDecisions = decisions.filter((decision) => decision.paging !== "never");
  const firingCount = firingDecisions.length;
  const maxSeverity = maxSeverityOf(firingDecisions);
  const openAlerts = await ledgerPort.listOpenAlerts();

  if (checkOnly) {
    const alertsByDedupeKey = new Map(openAlerts.map((alert) => [alert.dedupeKey, alert]));
    let actionableCriticalCount = 0;
    let suppressedCriticalCount = 0;
    let actionablePageableCount = 0;
    let deliveryBackoffCount = 0;
    let suppressed = 0;
    for (const decision of decisions) {
      const alert = alertsByDedupeKey.get(decision.dedupeKey);
      // The mutating path clears acknowledgement, snooze and delivery cadence on
      // escalation. Mirror that transition here so a read-only probe cannot
      // report a stale suppression that the next real tick will remove.
      const suppressionSurvives = alert ? !isSeverityEscalation(decision, alert) : false;
      const actionableSuppressed = alert && suppressionSurvives
        ? isActionabilitySuppressed(alert, now)
        : false;
      const pagingSuppressed = alert && suppressionSurvives
        ? isPagingSuppressed(alert, now)
        : false;
      const critical = isCriticalDecision(decision);
      const pageable = decision.paging !== "never" && shouldPage(decision.severity, pagingMinSeverity);
      if (critical) {
        if (actionableSuppressed) suppressedCriticalCount += 1;
        else actionableCriticalCount += 1;
      }
      if (pageable && !pagingSuppressed) actionablePageableCount += 1;
      if (alert && pageable && !pagingSuppressed && isDeliveryBackoff(alert, now)) {
        deliveryBackoffCount += 1;
      }
      if (pagingSuppressed) suppressed += 1;
    }
    return result({ checkOnly, checkedAt: snapshot.checkedAt, decisions, firingCount, actionableCriticalCount, suppressedCriticalCount, actionablePageableCount, notified: 0, notificationFailures: 0, deliveryBackoffCount, throttledNotifications: 0, skippedNotifications: 0, belowThreshold: 0, suppressed, muted, resolved: 0, maxSeverity });
  }

  const firingKeys = new Set(decisions.map((decision) => decision.dedupeKey));
  const counts = emptyWatchdogDecisionCounts();
  const serialSink = createSerialWatchdogSink(sinkPort);
  await runWatchdogQueue(decisions, async (index) => {
    const contribution = await processWatchdogDecision(decisions[index], {
      ledgerPort, sinkPort: serialSink, now, pagingMinSeverity, notificationThrottleSeconds,
    });
    for (const key of Object.keys(contribution) as (keyof typeof counts)[]) {
      counts[key] += contribution[key];
    }
  });

  // A rejected decision queue drains before throwing, so it never enters resolution.
  const staleAlerts = openAlerts.filter((alert) => !firingKeys.has(alert.dedupeKey));
  await runWatchdogQueue(staleAlerts, async (index) => {
    await ledgerPort.resolveAlert(staleAlerts[index].dedupeKey, now);
  });

  return result({ checkOnly, checkedAt: snapshot.checkedAt, decisions, firingCount, ...counts, muted, resolved: staleAlerts.length, maxSeverity });
}

function isMuted(dedupeKey: string, mutedPrefixes: readonly string[]): boolean {
  return mutedPrefixes.some((prefix) => prefix.length > 0 && dedupeKey.startsWith(prefix));
}

function severityRank(severity: AlertSeverity): number {
  return { p0: 0, p1: 1, p2: 2, p3: 3 }[severity];
}

function maxSeverityOf(decisions: readonly AlertDecision[]): AlertSeverity | null {
  return decisions.reduce<AlertSeverity | null>((current, decision) =>
    current == null || severityRank(decision.severity) < severityRank(current) ? decision.severity : current
  , null);
}

function result({
  checkOnly,
  checkedAt,
  decisions,
  firingCount,
  actionableCriticalCount,
  suppressedCriticalCount,
  actionablePageableCount,
  notified,
  notificationFailures,
  deliveryBackoffCount,
  throttledNotifications,
  skippedNotifications,
  belowThreshold,
  suppressed,
  muted,
  resolved,
  maxSeverity,
}: Omit<PlatformWatchdogResult, "ok" | "health" | "alertCount">): PlatformWatchdogResult {
  return {
    // Evaluation success is separate from the incident state. HTTP binding may
    // still fail the request for evidence, notification transport, or config.
    ok: true,
    health: firingCount === 0 ? "healthy" : "firing",
    checkOnly,
    checkedAt,
    alertCount: decisions.length,
    firingCount,
    actionableCriticalCount,
    suppressedCriticalCount,
    actionablePageableCount,
    maxSeverity,
    decisions,
    notified,
    notificationFailures,
    deliveryBackoffCount,
    throttledNotifications,
    skippedNotifications,
    belowThreshold,
    suppressed,
    muted,
    resolved,
  };
}
