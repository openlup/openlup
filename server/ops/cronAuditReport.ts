import {
  FEEDBACK_TEMPLATES,
  TRACKED_EMAIL_TEMPLATES,
  type EmailSendRow,
  type FeedbackAuditRow,
  type QueryBuilder,
  type RewardOutboxAuditRow,
  type RewardDeliveryAuditRow,
  type SupabaseClientLike,
  type TesterAuditRow,
} from "./cronAuditTypes.js";
import {
  RETIRED_REWARD_SKIP,
  summarizeDelayedFeedback,
  summarizeDhlRows,
  summarizeEmailSends,
  summarizeRetiredRewardEvidence,
} from "./cronAuditSummaries.js";

const RETIRED_REWARD_EVENT = "tester.feedback.reward_confirmation";

function isoHoursAgo(hours: number, now: Date): string {
  return new Date(now.getTime() - hours * 60 * 60 * 1000).toISOString();
}

async function selectRows<T>(
  query: PromiseLike<{ data: T[] | null; error: { message?: string } | null }>,
  label: string,
): Promise<T[]> {
  const { data, error } = await query;
  if (error) throw new Error(`${label}: ${error.message ?? "query failed"}`);
  return data ?? [];
}

async function countRows(
  query: PromiseLike<{ count?: number | null; error: { message?: string } | null }>,
  label: string,
): Promise<number> {
  const { count, error } = await query;
  if (error) throw new Error(`${label}: ${error.message ?? "count failed"}`);
  return count ?? 0;
}

function chunk<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < values.length; i += size) result.push(values.slice(i, i + size));
  return result;
}

async function selectInChunks<T>(
  ids: string[],
  fetchChunk: (ids: string[]) => Promise<T[]>,
): Promise<T[]> {
  const rows: T[] = [];
  for (const idChunk of chunk(ids, 200)) rows.push(...await fetchChunk(idChunk));
  return rows;
}

async function safeSection<T>(
  errors: Array<{ section: string; error: string }>,
  section: string,
  fn: () => Promise<T>,
): Promise<T | null> {
  try {
    return await fn();
  } catch (error) {
    errors.push({ section, error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

function table<T>(client: SupabaseClientLike, name: string): QueryBuilder<T> {
  return client.from(name) as QueryBuilder<T>;
}

export async function buildCronAudit(client: SupabaseClientLike, lookbackHours: number, now: Date) {
  const since = isoHoursAgo(lookbackHours, now);
  const errors: Array<{ section: string; error: string }> = [];

  const emailRows = await safeSection(errors, "email_sends", () =>
    selectRows<EmailSendRow>(
      table<EmailSendRow>(client, "email_sends")
        .select("id,tester_id,template_slug,status,sent_at,resend_id")
        .gte("sent_at", since)
        .in("template_slug", TRACKED_EMAIL_TEMPLATES)
        .order("sent_at", { ascending: false })
        .limit(5000),
      "email_sends",
    ),
  ) ?? [];

  const deliveredRows = await safeSection(errors, "delayed_feedback_testers", () =>
    selectRows<TesterAuditRow>(
      table<TesterAuditRow>(client, "testers")
        .select("id,status,delivered_at,email_sequence_paused")
        .not("delivered_at", "is", null)
        .eq("email_sequence_paused", false)
        .in("status", ["delivered", "feedback_mid", "feedback_final"])
        .limit(5000),
      "delayed_feedback_testers",
    ),
  ) ?? [];
  const deliveredIds = deliveredRows.map((row) => row.id);

  const feedbackRows = deliveredIds.length > 0
    ? await safeSection(errors, "feedback_rows", () =>
      selectInChunks<FeedbackAuditRow>(deliveredIds, (ids) =>
        selectRows<FeedbackAuditRow>(
          table<FeedbackAuditRow>(client, "feedback")
            .select("tester_id,hash,submitted_at")
            .in("tester_id", ids),
          "feedback_rows",
        ),
      ),
    ) ?? []
    : [];

  const feedbackSendRows = deliveredIds.length > 0
    ? await safeSection(errors, "feedback_email_sends", () =>
      selectInChunks<EmailSendRow>(deliveredIds, (ids) =>
        selectRows<EmailSendRow>(
          table<EmailSendRow>(client, "email_sends")
            .select("id,tester_id,template_slug,status,sent_at,resend_id")
            .in("tester_id", ids)
            .in("template_slug", FEEDBACK_TEMPLATES)
            .limit(5000),
          "feedback_email_sends",
        ),
      ),
    ) ?? []
    : [];

  const dhlRows = await safeSection(errors, "dhl_stale_rows", () =>
    selectRows<TesterAuditRow>(
      table<TesterAuditRow>(client, "testers")
        .select("id,status,tracking_number,dhl_last_checked_at,dhl_last_codes")
        .in("status", ["shipped", "in_transit"])
        .not("tracking_number", "is", null)
        .limit(5000),
      "dhl_stale_rows",
    ),
  ) ?? [];

  const jobControls = await safeSection(errors, "platform_job_controls", () =>
    selectRows<Record<string, unknown>>(
      table<Record<string, unknown>>(client, "platform_job_controls")
        .select("job_name,enabled,active_driver,lease_until,last_success_at,last_status,last_run_id,updated_at")
        .eq("job_name", "check-dhl-tracking")
        .limit(5),
      "platform_job_controls",
    ),
  );

  const jobRuns = await safeSection(errors, "platform_job_runs", () =>
    selectRows<Record<string, unknown>>(
      table<Record<string, unknown>>(client, "platform_job_runs")
        .select("started_at,finished_at,trigger_source,driver,status,checked,updated,error,support_code,metadata")
        .eq("job_name", "check-dhl-tracking")
        .order("started_at", { ascending: false })
        .limit(20),
      "platform_job_runs",
    ),
  );

  const approvedWithoutTracking = await safeSection(errors, "approved_without_tracking", () =>
    countRows(
      table<Record<string, unknown>>(client, "testers")
        .select("id", { count: "exact", head: true })
        .eq("status", "approved")
        .is("tracking_number", null),
      "approved_without_tracking",
    ),
  );

  const packagingRecipients = await safeSection(errors, "packaging_digest_recipients", () =>
    countRows(
      table<Record<string, unknown>>(client, "notification_recipients")
        .select("id", { count: "exact", head: true })
        .eq("notification_type", "packaging_digest")
        .eq("active", true),
      "packaging_digest_recipients",
    ),
  );

  const dailyReportRecipients = await safeSection(errors, "daily_report_recipients", () =>
    countRows(
      table<Record<string, unknown>>(client, "notification_recipients")
        .select("id", { count: "exact", head: true })
        .eq("notification_type", "daily_report")
        .eq("active", true),
      "daily_report_recipients",
    ),
  );

  const completedFeedbackRows = await safeSection(errors, "reward_confirmation_feedback", () =>
    selectRows<FeedbackAuditRow>(
      table<FeedbackAuditRow>(client, "feedback")
        .select("id,tester_id,hash,submitted_at,section_c_submitted_at")
        .not("section_c_submitted_at", "is", null)
        .gte("section_c_submitted_at", since)
        .limit(5000),
      "reward_confirmation_feedback",
    ),
  ) ?? [];
  const unresolvedRewardOutboxRows = await safeSection(errors, "reward_confirmation_unresolved_outbox", () =>
    selectRows<RewardOutboxAuditRow>(
      table<RewardOutboxAuditRow>(client, "outbox_events")
        .select("id,aggregate_id,status,processed_at,metadata,payload")
        .eq("event_type", RETIRED_REWARD_EVENT)
        .in("status", ["pending", "failed", "processing"])
        .limit(5000),
      "reward_confirmation_unresolved_outbox",
    ),
  ) ?? [];
  const recentRewardOutboxRows = await safeSection(errors, "reward_confirmation_recent_outbox", () =>
    selectRows<RewardOutboxAuditRow>(
      table<RewardOutboxAuditRow>(client, "outbox_events")
        .select("id,aggregate_id,status,processed_at,metadata,payload")
        .eq("event_type", RETIRED_REWARD_EVENT)
        .gte("created_at", since)
        .limit(5000),
      "reward_confirmation_recent_outbox",
    ),
  ) ?? [];
  const retiredRewardEventIds = recentRewardOutboxRows
    .filter((row) => row.metadata?.skipped === RETIRED_REWARD_SKIP)
    .map((row) => row.id);
  const rewardDeliveryRows = await safeSection(errors, "reward_confirmation_deliveries", () =>
    selectInChunks<RewardDeliveryAuditRow>(retiredRewardEventIds, (ids) =>
      selectRows<RewardDeliveryAuditRow>(
        table<RewardDeliveryAuditRow>(client, "communication_email_deliveries")
          .select("outbox_event_id,status,last_error_code,provider_kind,provider_message_id,email_send_id,sent_at,delivered_at,metadata")
          .in("outbox_event_id", ids),
        "reward_confirmation_deliveries",
      ),
    ),
  ) ?? [];
  const rewardConfirmation = summarizeRetiredRewardEvidence({
    completedFeedbackRows,
    recentOutboxRows: recentRewardOutboxRows,
    unresolvedOutboxRows: unresolvedRewardOutboxRows,
    deliveryRows: rewardDeliveryRows,
  });
  return {
    ok: errors.length === 0 && rewardConfirmation.ok,
    checkedAt: now.toISOString(),
    lookbackHours,
    since,
    errors,
    dhlTracking: {
      controls: jobControls ?? [],
      recentRuns: jobRuns ?? [],
      stale: summarizeDhlRows(dhlRows, now, 6),
    },
    emailSends: summarizeEmailSends(emailRows),
    delayedFeedback: summarizeDelayedFeedback({
      testers: deliveredRows,
      feedbackRows,
      sends: feedbackSendRows,
      now,
    }),
    packagingDigest: {
      approvedWithoutTracking,
      activeRecipients: packagingRecipients,
    },
    dailyReport: {
      activeRecipients: dailyReportRecipients,
    },
    rewardConfirmation,
  };
}
