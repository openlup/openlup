import type {
  AlertDecision,
  AlertNotificationOutcome,
  OpenAlert,
} from "../../../../src/domains/platform/observabilityContracts.js";
import type { AlertLedgerPort } from "../../../../src/domains/platform/observabilityPorts.js";

type QueryResult<T> = PromiseLike<{ data: T | null; error: { message?: string; code?: string } | null }>;
type SupabaseTable<T> = QueryResult<T> & {
  insert: (value: Record<string, unknown>) => SupabaseTable<T>;
  maybeSingle: () => QueryResult<T>;
  order: (...args: unknown[]) => SupabaseTable<T>;
  select: (...args: unknown[]) => SupabaseTable<T>;
  update: (value: Record<string, unknown>) => SupabaseTable<T>;
  upsert: (value: Record<string, unknown>, options?: Record<string, unknown>) => SupabaseTable<T>;
  eq: (...args: unknown[]) => SupabaseTable<T>;
  in: (...args: unknown[]) => SupabaseTable<T>;
};

export type SupabaseAlertLedgerClient = {
  from: <T = Record<string, unknown>>(table: string) => SupabaseTable<T>;
};

export function createSupabaseAlertLedgerPort(client: SupabaseAlertLedgerClient): AlertLedgerPort {
  return {
    async listOpenAlerts() {
      const { data, error } = await client
        .from<AlertRow[]>("platform_alerts")
        .select("id,dedupe_key,status,severity,last_notified_at,last_notification_attempt_at,last_notification_status,next_notification_attempt_at,notification_failure_count,snoozed_until")
        .in("status", ["open", "acknowledged"])
        .order("last_seen_at", { ascending: false });
      if (error) throw new Error(error.message ?? "platform_alerts list failed");
      return ((data ?? []) as unknown as AlertRow[]).map(mapAlert);
    },

    async upsertOpenAlert(decision, now) {
      const supportCode = supportCodeFor(decision.dedupeKey, now);
      const existing = await findAlert(decision.dedupeKey, client);
      const reopened = existing?.status === "resolved";
      const escalated = existing != null && severityRank(decision.severity) < severityRank(existing.severity);
      const resetSuppression = reopened || escalated;
      const payload = {
        dedupe_key: decision.dedupeKey,
        severity: decision.severity,
        status: existing?.status === "acknowledged" && !escalated ? "acknowledged" : "open",
        last_seen_at: now.toISOString(),
        resolved_at: null,
        owner: decision.owner,
        runbook_url: decision.runbookUrl,
        title: decision.title,
        message: decision.message,
        support_code: supportCode,
        payload: decision.payload,
      };

      const query = existing
        ? client.from<AlertRow>("platform_alerts").update({
          ...payload,
          ...(reopened ? {
            first_seen_at: now.toISOString(),
          } : {}),
          ...(resetSuppression ? {
            snoozed_until: null,
            acknowledged_at: null,
          } : {}),
          ...(resetSuppression ? {
            last_notified_at: null,
            last_notification_attempt_at: null,
            last_notification_status: null,
            next_notification_attempt_at: null,
            notification_failure_count: 0,
          } : {}),
        }).eq("dedupe_key", decision.dedupeKey)
        : client.from<AlertRow>("platform_alerts").insert({ ...payload, first_seen_at: now.toISOString() });

      const { data, error } = await query.select("id,dedupe_key,status,severity,last_notified_at,last_notification_attempt_at,last_notification_status,next_notification_attempt_at,notification_failure_count,snoozed_until").maybeSingle();
      if (error || !data) throw new Error(error?.message ?? "platform_alerts upsert failed");
      return mapAlert(data);
    },

    async resolveAlert(dedupeKey, now) {
      const { error } = await client
        .from("platform_alerts")
        .update({ status: "resolved", resolved_at: now.toISOString(), last_seen_at: now.toISOString() })
        .eq("dedupe_key", dedupeKey)
        .in("status", ["open", "acknowledged"]);
      if (error) throw new Error(error.message ?? "platform_alerts resolve failed");
    },

    async recordNotification(alertId, outcome, now, schedule) {
      const { error: insertError } = await client.from("platform_alert_notifications").insert({
        alert_id: alertId,
        channel: outcome.channel,
        status: outcome.status,
        provider: outcome.provider ?? null,
        provider_response: outcome.providerResponse ?? {},
        error: outcome.error ?? null,
        notified_at: now.toISOString(),
      });
      if (insertError) throw new Error(insertError.message ?? "platform_alert_notifications insert failed");

      const { error: updateError } = await client
        .from("platform_alerts")
        .update({
          ...(outcome.status === "sent" ? { last_notified_at: now.toISOString() } : {}),
          last_notification_attempt_at: now.toISOString(),
          last_notification_status: outcome.status,
          next_notification_attempt_at: schedule.nextAttemptAt.toISOString(),
          notification_failure_count: schedule.failureCount,
          updated_at: now.toISOString(),
        })
        .eq("id", alertId);
      if (updateError) throw new Error(updateError.message ?? "platform_alerts notification update failed");
    },
  };
}

async function findAlert(dedupeKey: string, client: SupabaseAlertLedgerClient): Promise<AlertRow | null> {
  const { data, error } = await client
    .from<AlertRow>("platform_alerts")
    .select("id,dedupe_key,status,severity,last_notified_at,last_notification_attempt_at,last_notification_status,next_notification_attempt_at,notification_failure_count,snoozed_until")
    .eq("dedupe_key", dedupeKey)
    .maybeSingle();
  if (error && error.code !== "PGRST116") throw new Error(error.message ?? "platform_alerts lookup failed");
  return data ?? null;
}

function mapAlert(row: AlertRow): OpenAlert {
  return {
    id: row.id,
    dedupeKey: row.dedupe_key,
    status: row.status === "acknowledged" ? "acknowledged" : "open",
    severity: row.severity,
    lastNotifiedAt: row.last_notified_at ?? null,
    lastNotificationAttemptAt: row.last_notification_attempt_at ?? null,
    lastNotificationStatus: notificationStatus(row.last_notification_status),
    nextNotificationAttemptAt: row.next_notification_attempt_at ?? null,
    notificationFailureCount: typeof row.notification_failure_count === "number"
      && Number.isInteger(row.notification_failure_count) && row.notification_failure_count >= 0
      ? row.notification_failure_count
      : 0,
    snoozedUntil: row.snoozed_until ?? null,
  };
}

function supportCodeFor(dedupeKey: string, now: Date): string {
  const compactDate = now.toISOString().slice(0, 10).replace(/-/g, "");
  const safeKey = dedupeKey.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").slice(0, 40).toUpperCase();
  return `OPS-${compactDate}-${safeKey || "WATCHDOG"}`;
}

function severityRank(severity: AlertRow["severity"]): number {
  return { p0: 0, p1: 1, p2: 2, p3: 3 }[severity];
}

function notificationStatus(value: unknown): AlertNotificationOutcome["status"] | null {
  return value === "sent" || value === "failed" || value === "skipped" ? value : null;
}

type AlertRow = {
  id: string;
  dedupe_key: string;
  status: string;
  severity: "p0" | "p1" | "p2" | "p3";
  last_notified_at?: string | null;
  last_notification_attempt_at?: string | null;
  last_notification_status?: string | null;
  next_notification_attempt_at?: string | null;
  notification_failure_count?: number | null;
  snoozed_until?: string | null;
};
