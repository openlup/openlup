import { ALERT_SEVERITIES, type AlertSeverity } from "./observabilityContracts.js";

/**
 * Paging policy for platform watchdog alerts.
 *
 * The alert ledger records every severity, but only sufficiently severe alerts
 * should page an on-call channel (e.g. ntfy). Lower-severity alerts stay
 * ledger-only so real incidents are not buried under routine noise.
 *
 * The tiering is settled in
 * `.agents/intent/pager-says-money-path-down-everything-else-has-a-queue.md`
 * section 4: **p0 pages** (customers cannot buy, renewals cannot charge, the
 * platform or database is down); **p1 is panel-urgent** and turns the admin
 * health pill `degraded` without waking anyone; **p2/p3** are the panel list and
 * the ledger. An unknown severity still pages: the fail-open rule is unchanged,
 * because silence must never be the result of a classification error.
 *
 * Lower rank == more severe.
 */
const SEVERITY_RANK: Record<AlertSeverity, number> = { p0: 0, p1: 1, p2: 2, p3: 3 };

/** Alerts at or above this severity page by default; below it are ledger-only. */
export const DEFAULT_PAGING_MIN_SEVERITY: AlertSeverity = "p0";

/**
 * Whether an alert of `severity` should page given the `minSeverity` threshold.
 *
 * Fail-safe: an unknown/unparseable severity always pages (treated as most
 * urgent). Silence must never be the result of a classification error.
 */
export function shouldPage(
  severity: string,
  minSeverity: AlertSeverity = DEFAULT_PAGING_MIN_SEVERITY,
): boolean {
  const rank = SEVERITY_RANK[severity as AlertSeverity];
  if (rank === undefined) return true;
  return rank <= SEVERITY_RANK[minSeverity];
}

/**
 * Parse a paging threshold from configuration (e.g. an env var), falling back to
 * {@link DEFAULT_PAGING_MIN_SEVERITY} for any missing or invalid value.
 */
export function parsePagingMinSeverity(value: string | null | undefined): AlertSeverity {
  const normalized = value?.trim().toLowerCase();
  if (normalized && (ALERT_SEVERITIES as readonly string[]).includes(normalized)) {
    return normalized as AlertSeverity;
  }
  return DEFAULT_PAGING_MIN_SEVERITY;
}
