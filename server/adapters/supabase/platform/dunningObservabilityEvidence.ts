import { selectRows, type ObservabilityEvidenceClient } from "./observabilityEvidenceQueries.js";

// Dunning evidence rows, the column/status constants the evidence reads are
// shaped from, and the two summarizers the watchdog snapshot folds them into.
//
// Read shape matters here. Both dunning tables only ever grow - terminal cases
// and `failed`/`skipped` notifications are never pruned - so a single blunt
// slice would eventually be filled by dead rows while the live sets it is meant
// to report on (open cases, queued notices) fell out of it entirely. The port
// therefore reads each set under its own status filter and its own ordering,
// and this module owns the vocabulary both sides agree on.

/** Notification columns every signal below reads; nothing else is selected. */
export const DUNNING_NOTIFICATION_COLUMNS = "id,case_id,status,recipient_kind,template_slug,scheduled_at,created_at";
/** Case columns every signal below reads, plus `opened_at` for the notice window bound. */
// `payment_intent_id` and `cycle_id` are read for the payment watchdog, not for
// dunning's own signals: a dunning case is the recovery path for a renewal
// refusal, so `recovery_missing` must be able to see one. Both are NOT NULL
// columns on a table this projection already reads, so carrying them costs no
// extra round-trip and no extra rows.
export const DUNNING_CASE_COLUMNS = "id,status,retry_attempt,next_retry_at,opened_at,expired_at,recovered_at,payment_intent_id,cycle_id";
/** Notifications that are neither queued nor delivered: the queue's attention set. */
export const DUNNING_ATTENTION_NOTIFICATION_STATUSES = ["failed", "skipped"] as const;
/**
 * Closed cases. They accumulate forever, so their read is recency-ordered.
 *
 * `cancelled` belongs here: migration 20260721200002 widened the status CHECK to
 * admit it, and both that migration and 20260721200003 close an open case as
 * `cancelled` when the customer cancels the subscription. Leaving it out would
 * drop those rows from `failureWithoutAdminAlertCount`, which filters on
 * `retry_attempt` and not on status, and which saw them under the old
 * all-status read.
 */
export const DUNNING_TERMINAL_CASE_STATUSES = ["recovered", "expired", "cancelled"] as const;
/** Row cap for the case-linked notice read: a case carries a handful of notices, and both case reads are capped at 2000. */
const DUNNING_CASE_NOTIFICATION_LIMIT = 4000;

export type DunningNotificationEvidenceRow = Record<string, unknown> & {
  id: string;
  case_id: string;
  status: string;
  recipient_kind: "customer" | "admin";
  template_slug?: string | null;
  scheduled_at?: string | null;
  created_at: string;
};

export type DunningCaseEvidenceRow = Record<string, unknown> & {
  id: string;
  status: string;
  retry_attempt: number;
  next_retry_at?: string | null;
  opened_at?: string | null;
  expired_at?: string | null;
  recovered_at?: string | null;
};

/**
 * Lower bound for the case-linked notification read.
 *
 * A notification cannot exist before the case it points at (its `case_id` is a
 * NOT NULL foreign key and both rows default their timestamps to insert time),
 * so every notification belonging to these cases was created at or after the
 * oldest `opened_at` among them. Filtering notifications on that instant is a
 * provable superset of what the case-linked signals need.
 *
 * Returns `null` when any retained case carries no `opened_at`, because a bound
 * derived from a partial set could exclude a real notice. A `null` bound means
 * the caller must not window the read at all.
 */
export function oldestCaseOpenedAt(cases: readonly DunningCaseEvidenceRow[]): string | null {
  if (cases.length === 0) return null;
  let oldestOpenedAt: string | null = null;
  for (const row of cases) {
    if (!row.opened_at) return null;
    if (oldestOpenedAt === null || row.opened_at < oldestOpenedAt) oldestOpenedAt = row.opened_at;
  }
  return oldestOpenedAt;
}

/**
 * Notifications for the cases the snapshot actually retained, in every status -
 * the two "notice missing" signals are only correct when a *delivered* notice
 * is visible to them, which the queued and attention reads deliberately
 * exclude.
 *
 * Bounded by `oldestCaseOpenedAt` rather than an id list: that window is a
 * provable superset of the notices those signals need, and it keeps thousands
 * of identifiers out of a request URL. A null bound means read unwindowed.
 */
export function selectDunningCaseNotifications(
  client: ObservabilityEvidenceClient,
  cases: readonly DunningCaseEvidenceRow[],
): Promise<DunningNotificationEvidenceRow[]> {
  if (cases.length === 0) return Promise.resolve([]);
  const openedAt = oldestCaseOpenedAt(cases);
  const base = client.from<DunningNotificationEvidenceRow>("subscription_dunning_notifications").select(DUNNING_NOTIFICATION_COLUMNS);
  const windowed = openedAt === null ? base : base.gte("created_at", openedAt);
  return selectRows<DunningNotificationEvidenceRow>(
    windowed.order("created_at", { ascending: false }).limit(DUNNING_CASE_NOTIFICATION_LIMIT),
    "subscription_dunning_notifications_by_case",
  );
}

export function summarizeDunningQueue(rows: readonly DunningNotificationEvidenceRow[]) {
  const queued = rows.filter((row) => row.status === "queued");
  const failed = rows.filter((row) => row.status === "failed");
  const skipped = rows.filter((row) => row.status === "skipped");
  const critical = (row: DunningNotificationEvidenceRow) => row.recipient_kind === "admin" || row.template_slug?.includes("-admin") === true;
  return {
    queueName: "subscription_dunning_notifications",
    jobName: "subscription-dunning-dispatch",
    queuedCount: queued.length,
    oldestQueuedAt: oldest(queued.map((row) => row.scheduled_at ?? row.created_at)),
    failedCount: failed.length,
    skippedCount: skipped.length,
    criticalFailedCount: failed.filter(critical).length,
    criticalSkippedCount: skipped.filter(critical).length,
  };
}

export function summarizeDunning(
  cases: readonly DunningCaseEvidenceRow[],
  notifications: readonly DunningNotificationEvidenceRow[],
  now: Date,
) {
  const noticesByCase = groupBy(notifications, (row) => row.case_id);
  const dayAgo = now.getTime() - 24 * 60 * 60 * 1000;
  return {
    overdueRetryCount: cases.filter((row) =>
      row.status === "open" && row.next_retry_at && new Date(row.next_retry_at).getTime() <= now.getTime(),
    ).length,
    expiredWithoutCustomerNoticeCount: cases.filter((row) =>
      row.status === "expired" && !(noticesByCase.get(row.id) ?? []).some((notice) => notice.template_slug === "subscription-payment-expired"),
    ).length,
    failureWithoutAdminAlertCount: cases.filter((row) =>
      row.retry_attempt > 0 && !(noticesByCase.get(row.id) ?? []).some((notice) => notice.recipient_kind === "admin"),
    ).length,
    failedAdminNotificationCount: notifications.filter((row) => row.recipient_kind === "admin" && row.status === "failed").length,
    skippedAdminNotificationCount: notifications.filter((row) => row.recipient_kind === "admin" && row.status === "skipped").length,
    expiredCount24h: cases.filter((row) => row.expired_at && new Date(row.expired_at).getTime() >= dayAgo).length,
    recoveredCount24h: cases.filter((row) => row.recovered_at && new Date(row.recovered_at).getTime() >= dayAgo).length,
  };
}

function oldest(values: Array<string | null | undefined>): string | null {
  return values.filter(Boolean).sort()[0] ?? null;
}

function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) groups.set(key(row), [...(groups.get(key(row)) ?? []), row]);
  return groups;
}
