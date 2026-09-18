import type { EmailHealthMetrics } from "./emailHealthMetricsPort.js";

/**
 * Pure email-health assessment layer: env-derived thresholds plus the
 * healthy/unhealthy verdict over the delivery metrics. Extracted from
 * `api/_cron/emailHealthWatchdogJob.ts` (which sat at the 300-LOC source cap)
 * so the incident-driven `permanent_delivery_failure` breach could land here
 * with unit coverage and no database in the loop.
 */

type Env = Record<string, string | undefined>;

export interface EmailHealthThresholds {
  windowMinutes: number;
  stuckMinutes: number;
  minAttemptsForRatio: number;
  maxFailureRatio: number;
  maxStuck: number;
  /**
   * Absolute ceiling on in-window deliveries that ended `status='failed'`
   * (handler-final loss of a customer notification: outbox discard,
   * max-attempts exhaustion). Default 0 — a single lost email breaches.
   * Bounces/complaints are separate statuses and stay ratio-only.
   */
  maxPermanentFailures: number;
}

export interface EmailHealthBreach {
  code: string;
  detail: string;
}

export interface EmailHealthAssessment {
  healthy: boolean;
  failureRatio: number;
  breaches: EmailHealthBreach[];
}

export function readEmailHealthThresholds(env: Env): EmailHealthThresholds {
  return {
    windowMinutes: positiveInt(env.EMAIL_HEALTH_WINDOW_MINUTES, 60),
    stuckMinutes: positiveInt(env.EMAIL_HEALTH_STUCK_MINUTES, 30),
    minAttemptsForRatio: positiveInt(env.EMAIL_HEALTH_MIN_ATTEMPTS_FOR_RATIO, 5),
    maxFailureRatio: clampRatio(env.EMAIL_HEALTH_MAX_FAILURE_RATIO, 0.5),
    maxStuck: nonNegativeInt(env.EMAIL_HEALTH_MAX_STUCK, 0),
    maxPermanentFailures: nonNegativeInt(env.EMAIL_HEALTH_MAX_PERMANENT_FAILURES, 0),
  };
}

/**
 * Pure decision: turn raw counts into a healthy/unhealthy verdict. Kept side
 * effect-free so the thresholds logic is unit-tested without a database.
 */
export function evaluateEmailHealth(
  metrics: EmailHealthMetrics,
  thresholds: EmailHealthThresholds,
): EmailHealthAssessment {
  const failureRatio = metrics.attempted > 0 ? metrics.failed / metrics.attempted : 0;
  const breaches: EmailHealthBreach[] = [];

  if (metrics.attempted >= thresholds.minAttemptsForRatio && failureRatio > thresholds.maxFailureRatio) {
    breaches.push({
      code: "failure_ratio",
      detail: `${metrics.failed}/${metrics.attempted} (${(failureRatio * 100).toFixed(1)}%) > ${(thresholds.maxFailureRatio * 100).toFixed(1)}%`,
    });
  }
  // Absolute, ratio-independent: one terminally-failed delivery is one
  // customer notification we finally did not send. Incident 2026-07-24: a
  // single discarded payment-recovery email stayed invisible because the
  // ratio breach needs minAttemptsForRatio sends in the window.
  if (metrics.permanentFailures > thresholds.maxPermanentFailures) {
    breaches.push({
      code: "permanent_delivery_failure",
      detail: `${metrics.permanentFailures} delivery(ies) terminally failed > ${thresholds.maxPermanentFailures}`,
    });
  }
  if (metrics.stuckProcessing > thresholds.maxStuck) {
    breaches.push({
      code: "stuck_processing",
      detail: `${metrics.stuckProcessing} email(s) stuck in 'processing' > ${thresholds.stuckMinutes}m`,
    });
  }
  if (metrics.stuckScheduled > thresholds.maxStuck) {
    breaches.push({
      code: "stuck_scheduled",
      detail: `${metrics.stuckScheduled} scheduled email(s) overdue and undispatched`,
    });
  }

  return { healthy: breaches.length === 0, failureRatio, breaches };
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function nonNegativeInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

function clampRatio(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback;
}
