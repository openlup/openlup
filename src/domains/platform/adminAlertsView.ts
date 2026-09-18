import type {
  AdminAlert,
  AdminAlertHealth,
  AdminAlertLane,
  AdminAlertSeverity,
  AdminAlertsHeartbeat,
  AdminAlertsOverviewResponse,
  AdminAlertsSummary,
} from "./adminAlertsContracts.js";
import { DEFAULT_PAGING_MIN_SEVERITY, shouldPage } from "./alertPagingPolicy.js";

/**
 * Pure projection of platform_alerts rows onto the admin shell's badges.
 *
 * All filtering lives here rather than in SQL so the `now` boundary is injectable
 * and every rule is unit-testable without a database.
 */

/** Raw ledger row as selected from public.platform_alerts. */
export type PlatformAlertLedgerRow = {
  id: string;
  dedupe_key: string;
  owner: string;
  severity: string;
  status: string;
  title: string;
  message: string | null;
  support_code: string | null;
  runbook_url: string | null;
  first_seen_at: string;
  last_seen_at: string;
  snoozed_until: string | null;
};

export type WatchdogHeartbeatRow = {
  last_success_at: string | null;
} | null;

/**
 * Generic scheduled-job alerts inherit `owner` from the job catalog entry, so a
 * commerce-owned job leaks engineer-only noise ("this cron failed") into what
 * should be an operator's queue. They still count toward platform health.
 */
export const GENERIC_JOB_DEDUPE_PREFIXES = [
  "job_failed:",
  "job_missed:",
  "job_never_succeeded:",
  "job_stuck_running:",
  "job_ledger_missing:",
] as const;

/**
 * How old a watchdog heartbeat may be before the health pill stops trusting it.
 *
 * The development-preview reference uses a conservative six-hour stale window
 * independent from any scheduler cadence. It is a policy default, not a
 * scheduling SLA; adopters must review it against their expected maximum
 * heartbeat delay and queue jitter.
 */
export const WATCHDOG_STALE_AFTER_SECONDS = 6 * 60 * 60;

const SEVERITY_RANK: Record<AdminAlertSeverity, number> = { p0: 0, p1: 1, p2: 2, p3: 3 };

/**
 * Derived from the paging policy's DEFAULT floor, not from the live threshold:
 * this is a pure projection with no access to PLATFORM_ALERT_PAGING_MIN_SEVERITY,
 * so an operator who overrides that variable makes panel and pager disagree
 * again. Threading the parsed floor through the admin BFF is wave-3 work.
 */
function isPageableSeverity(severity: AdminAlertSeverity): boolean {
  return shouldPage(severity, DEFAULT_PAGING_MIN_SEVERITY);
}

export function isGenericJobAlert(dedupeKey: string): boolean {
  return GENERIC_JOB_DEDUPE_PREFIXES.some((prefix) => dedupeKey.startsWith(prefix));
}

/**
 * Display bucket. `commerce` means "a business operator can act on this".
 *
 * `commerce/platform` is deliberately excluded: despite the prefix it owns
 * engineering-run plumbing (outbox-dispatch, outbox-prune, abandoned-cart,
 * review-request, reorder-reminder).
 */
export function classifyLane(owner: string, dedupeKey: string): AdminAlertLane {
  if (isGenericJobAlert(dedupeKey)) return "platform";
  if (!owner.startsWith("commerce/")) return "platform";
  if (owner === "commerce/platform") return "platform";
  return "commerce";
}

export function isSnoozed(snoozedUntil: string | null, now: Date): boolean {
  if (!snoozedUntil) return false;
  const until = Date.parse(snoozedUntil);
  return Number.isFinite(until) && until > now.getTime();
}

/**
 * Unknown severities are treated as p0 — mirrors alertPagingPolicy's fail-safe,
 * where an unrecognised severity always pages rather than silently disappearing.
 */
function normalizeSeverity(severity: string): AdminAlertSeverity {
  return severity in SEVERITY_RANK ? (severity as AdminAlertSeverity) : "p0";
}

function normalizeIso(value: string): string {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : value;
}

/** Unresolved ledger state, including a controlled snoozed exception. */
function isOpen(row: PlatformAlertLedgerRow): boolean {
  if (row.status !== "open" && row.status !== "acknowledged") return false;
  return true;
}

/** Live enough to affect the health badge and paging. */
function isLive(row: PlatformAlertLedgerRow, now: Date): boolean {
  return isOpen(row) && !isSnoozed(row.snoozed_until, now);
}

/**
 * Pageable means "this would wake someone up": live and above the paging floor.
 * Acknowledged rows stay pageable on purpose — acknowledged is not resolved, the
 * system is still broken.
 */
export function isPageable(row: PlatformAlertLedgerRow, now: Date): boolean {
  return isLive(row, now) && isPageableSeverity(normalizeSeverity(row.severity));
}

export function toAdminAlert(row: PlatformAlertLedgerRow, now: Date): AdminAlert {
  return {
    id: row.id,
    dedupeKey: row.dedupe_key,
    lane: classifyLane(row.owner, row.dedupe_key),
    owner: row.owner,
    severity: normalizeSeverity(row.severity),
    status: row.status === "acknowledged" ? "acknowledged" : "open",
    pageable: isPageable(row, now),
    title: row.title,
    message: row.message ?? "",
    supportCode: row.support_code,
    runbookUrl: row.runbook_url,
    firstSeenAt: normalizeIso(row.first_seen_at),
    lastSeenAt: normalizeIso(row.last_seen_at),
    snoozedUntil: row.snoozed_until ? normalizeIso(row.snoozed_until) : null,
  };
}

export function worstSeverity(alerts: readonly AdminAlert[]): AdminAlertSeverity | null {
  let worst: AdminAlertSeverity | null = null;
  for (const alert of alerts) {
    if (!worst || SEVERITY_RANK[alert.severity] < SEVERITY_RANK[worst]) worst = alert.severity;
  }
  return worst;
}

/**
 * `commercePageableCount` and `platformPageableCount` partition the pageable set,
 * so no alert that would page is ever invisible in the popover.
 */
export function summarizeAlerts(alerts: readonly AdminAlert[]): AdminAlertsSummary {
  const pageable = alerts.filter((alert) => alert.pageable);
  return {
    commercePageableCount: pageable.filter((alert) => alert.lane === "commerce").length,
    commerceTotalCount: alerts.filter((alert) => alert.lane === "commerce").length,
    platformPageableCount: pageable.filter((alert) => alert.lane === "platform").length,
    snoozedCount: 0,
    maxOpenSeverity: worstSeverity(alerts),
  };
}

export function buildHeartbeat(row: WatchdogHeartbeatRow, now: Date): AdminAlertsHeartbeat {
  const lastSuccessAt = row?.last_success_at ?? null;
  const parsed = lastSuccessAt ? Date.parse(lastSuccessAt) : Number.NaN;
  const stale =
    !Number.isFinite(parsed) || now.getTime() - parsed > WATCHDOG_STALE_AFTER_SECONDS * 1000;
  return {
    lastSuccessAt: Number.isFinite(parsed) ? new Date(parsed).toISOString() : null,
    staleAfterSeconds: WATCHDOG_STALE_AFTER_SECONDS,
    stale,
  };
}

/**
 * Staleness beats severity: if the watchdog has not reported recently we do not
 * know the current state, and "unknown" is the only honest answer. There is no
 * path here that renders a green "systems ok" from missing data.
 */
export function deriveHealth(
  summary: AdminAlertsSummary,
  heartbeat: AdminAlertsHeartbeat,
): AdminAlertHealth {
  if (heartbeat.stale) return "unknown";
  if (summary.maxOpenSeverity === "p0") return "down";
  if (summary.maxOpenSeverity === "p1") return "degraded";
  return "ok";
}

/** Alerts returned to the client; counts above stay accurate even when this is truncated. */
export const ADMIN_ALERTS_LIST_LIMIT = 50;

function compareForDisplay(a: AdminAlert, b: AdminAlert): number {
  const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
  if (bySeverity !== 0) return bySeverity;
  return Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt);
}

export function buildAlertsOverview(
  rows: readonly PlatformAlertLedgerRow[],
  heartbeatRow: WatchdogHeartbeatRow,
  now: Date,
): AdminAlertsOverviewResponse {
  const openRows = rows.filter(isOpen);
  const alerts = openRows
    .filter((row) => isLive(row, now))
    .map((row) => toAdminAlert(row, now))
    .sort(compareForDisplay);
  const snoozedAlerts = openRows
    .filter((row) => isSnoozed(row.snoozed_until, now))
    .map((row) => toAdminAlert(row, now))
    .sort(compareForDisplay);
  const summary = {
    ...summarizeAlerts(alerts),
    snoozedCount: snoozedAlerts.length,
  };
  const heartbeat = buildHeartbeat(heartbeatRow, now);
  return {
    health: deriveHealth(summary, heartbeat),
    summary,
    heartbeat,
    alerts: alerts.slice(0, ADMIN_ALERTS_LIST_LIMIT),
    // Deliberately separate from the active list's limit: controlled exceptions
    // are relevant audit context, but must not turn the health pill red.
    snoozedAlerts,
    generatedAt: now.toISOString(),
  };
}
