import type {
  AlertDecision,
  AlertNotificationOutcome,
  OpenAlert,
} from "../../../src/domains/platform/observabilityContracts.js";

const FAILURE_RETRY_INITIAL_SECONDS = 10 * 60;
const FAILURE_RETRY_MAX_SECONDS = 60 * 60;

export function shouldAttemptNotification(
  alert: Pick<
    OpenAlert,
    "lastNotifiedAt" | "lastNotificationStatus" | "nextNotificationAttemptAt" | "snoozedUntil"
  >,
  now: Date,
  throttleSeconds: number,
): boolean {
  const snoozeExpiry = alert.snoozedUntil ? Date.parse(alert.snoozedUntil) : Number.NaN;
  const lastSentAt = alert.lastNotifiedAt ? Date.parse(alert.lastNotifiedAt) : Number.NaN;
  if (
    alert.lastNotificationStatus !== "failed"
    && Number.isFinite(snoozeExpiry)
    && snoozeExpiry <= now.getTime()
    && (!Number.isFinite(lastSentAt) || snoozeExpiry > lastSentAt)
  ) {
    return true;
  }
  const nextAttemptAt = alert.nextNotificationAttemptAt
    ? Date.parse(alert.nextNotificationAttemptAt)
    : Number.NaN;
  if (Number.isFinite(nextAttemptAt) && nextAttemptAt > now.getTime()) return false;
  if (!alert.lastNotifiedAt) return true;
  return now.getTime() - new Date(alert.lastNotifiedAt).getTime() >= throttleSeconds * 1000;
}

export function notificationSchedule(
  alert: Pick<OpenAlert, "notificationFailureCount">,
  outcome: AlertNotificationOutcome,
  now: Date,
  throttleSeconds: number,
): { nextAttemptAt: Date; failureCount: number } {
  if (outcome.status === "failed") {
    const failureCount = (alert.notificationFailureCount ?? 0) + 1;
    const exponent = Math.max(0, Math.min(failureCount - 1, 16));
    const retrySeconds = Math.min(
      FAILURE_RETRY_MAX_SECONDS,
      FAILURE_RETRY_INITIAL_SECONDS * 2 ** exponent,
    );
    return {
      nextAttemptAt: new Date(now.getTime() + retrySeconds * 1000),
      failureCount,
    };
  }

  return {
    // Sent uses the severity cadence. Skipped uses the same due field only to
    // avoid duplicate audit rows; last_notified_at still advances on sent only.
    nextAttemptAt: new Date(now.getTime() + throttleSeconds * 1000),
    failureCount: 0,
  };
}

export function isActionabilitySuppressed(
  alert: Pick<OpenAlert, "snoozedUntil">,
  now: Date,
): boolean {
  return alert.snoozedUntil != null && new Date(alert.snoozedUntil).getTime() > now.getTime();
}

export function isPagingSuppressed(
  alert: Pick<OpenAlert, "status" | "snoozedUntil">,
  now: Date,
): boolean {
  return alert.status === "acknowledged" || isActionabilitySuppressed(alert, now);
}

export function isDeliveryBackoff(
  alert: Pick<OpenAlert, "lastNotificationStatus" | "nextNotificationAttemptAt">,
  now: Date,
): boolean {
  if (alert.lastNotificationStatus !== "failed" || !alert.nextNotificationAttemptAt) return false;
  const nextAttemptAt = Date.parse(alert.nextNotificationAttemptAt);
  return Number.isFinite(nextAttemptAt) && nextAttemptAt > now.getTime();
}

export function isSeverityEscalation(
  decision: Pick<AlertDecision, "severity">,
  alert: Pick<OpenAlert, "severity">,
): boolean {
  const rank = { p0: 0, p1: 1, p2: 2, p3: 3 };
  return rank[decision.severity] < rank[alert.severity];
}
