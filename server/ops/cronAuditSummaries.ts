import type {
  EmailSendRow,
  FeedbackAuditRow,
  RewardDeliveryAuditRow,
  RewardOutboxAuditRow,
  TesterAuditRow,
} from "./cronAuditTypes.js";
import { FEEDBACK_TEMPLATES } from "./cronAuditTypes.js";

export const RETIRED_REWARD_SKIP = "tester_program_retired_no_egress";

export function summarizeRetiredRewardEvidence(input: {
  completedFeedbackRows: FeedbackAuditRow[];
  recentOutboxRows: RewardOutboxAuditRow[];
  unresolvedOutboxRows: RewardOutboxAuditRow[];
  deliveryRows: RewardDeliveryAuditRow[];
}) {
  const retirementRows = input.recentOutboxRows.filter((row) => row.metadata?.skipped === RETIRED_REWARD_SKIP);
  const legacyTerminalRows = input.recentOutboxRows.filter((row) =>
    row.metadata?.skipped !== RETIRED_REWARD_SKIP && !["pending", "failed", "processing"].includes(row.status)
  );
  const legacyProviderSuccessCount = legacyTerminalRows.filter((row) =>
    ["resendId", "providerMessageId", "emailSendId"].some((key) => row.metadata?.[key] !== undefined)
  ).length;
  const legacyAmbiguousCount = legacyTerminalRows.filter((row) => row.metadata?.acceptedWithoutProviderId === true).length;
  const legacyDiscardedCount = legacyTerminalRows.filter((row) => row.status === "discarded").length;
  const backlogCount = input.unresolvedOutboxRows.length;
  const invalidOutboxCount = retirementRows.filter((row) => row.status !== "processed").length;
  const deliveryByOutbox = new Map(input.deliveryRows.map((row) => [row.outbox_event_id, row]));
  const missingDeliveryCount = retirementRows.filter((row) => !deliveryByOutbox.has(row.id)).length;
  const forbiddenProviderEvidenceCount = input.deliveryRows.filter((row) =>
    ["sent", "delivered", "delivery_delayed"].includes(row.status) ||
    [row.provider_kind, row.provider_message_id, row.email_send_id, row.sent_at, row.delivered_at].some(Boolean) ||
    ["resendId", "providerMessageId", "emailSendId", "acceptedWithoutProviderId"].some((key) => row.metadata?.[key] !== undefined)
  ).length;
  const invalidDeliveryCount = input.deliveryRows.filter((row) =>
    row.status !== "skipped" || row.last_error_code !== RETIRED_REWARD_SKIP
  ).length;
  const obligationIds = new Set(input.recentOutboxRows.flatMap((row) =>
    typeof row.payload?.feedbackId === "string" ? [row.payload.feedbackId] : []
  ));
  const missingRewardConfirmationCount = input.completedFeedbackRows.filter((row) => row.id && !obligationIds.has(row.id)).length;
  const ok = [backlogCount, invalidOutboxCount, missingDeliveryCount, forbiddenProviderEvidenceCount,
    invalidDeliveryCount, missingRewardConfirmationCount].every((count) => count === 0);
  return {
    mode: "retired_no_send",
    expectedOutboxStatus: "processed",
    expectedDeliveryStatus: "skipped",
    expectedSkipReason: RETIRED_REWARD_SKIP,
    completedFeedbackRows: input.completedFeedbackRows.length,
    outboxRows: input.recentOutboxRows.length,
    retirementRows: retirementRows.length,
    legacyTerminalRows: legacyTerminalRows.length,
    legacyProviderSuccessCount,
    legacyAmbiguousCount,
    legacyDiscardedCount,
    deliveryRows: input.deliveryRows.length,
    backlogCount,
    invalidOutboxCount,
    missingDeliveryCount,
    invalidDeliveryCount,
    forbiddenProviderEvidenceCount,
    missingRewardConfirmationCount,
    sentCount: forbiddenProviderEvidenceCount,
    ok,
  };
}

function dayKey(iso: string | null): string {
  if (!iso) return "unknown";
  return iso.slice(0, 10);
}

function daysSince(iso: string | null, now: Date): number | null {
  if (!iso) return null;
  const time = new Date(iso).getTime();
  if (!Number.isFinite(time)) return null;
  return Math.floor((now.getTime() - time) / (24 * 60 * 60 * 1000));
}

function countBy<T extends string>(items: T[]): Record<T, number> {
  return items.reduce((acc, key) => {
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {} as Record<T, number>);
}

export function summarizeEmailSends(rows: EmailSendRow[]) {
  const byTemplateStatus: Record<string, Record<string, number>> = {};
  const byDayTemplate: Record<string, Record<string, number>> = {};

  for (const row of rows) {
    const template = row.template_slug ?? "unknown";
    const status = row.status ?? "unknown";
    byTemplateStatus[template] ??= {};
    byTemplateStatus[template][status] = (byTemplateStatus[template][status] ?? 0) + 1;

    const day = dayKey(row.sent_at);
    byDayTemplate[day] ??= {};
    byDayTemplate[day][template] = (byDayTemplate[day][template] ?? 0) + 1;
  }

  return {
    total: rows.length,
    byTemplateStatus,
    byDayTemplate,
    latestSentAt: rows[0]?.sent_at ?? null,
  };
}

export function summarizeDelayedFeedback({
  testers,
  feedbackRows,
  sends,
  now,
}: {
  testers: TesterAuditRow[];
  feedbackRows: FeedbackAuditRow[];
  sends: EmailSendRow[];
  now: Date;
}) {
  const feedbackByTester = new Map(feedbackRows.map((row) => [row.tester_id, row]));
  const sendsByTester = new Map<string, Set<string>>();

  for (const send of sends) {
    if (!send.tester_id || !send.template_slug) continue;
    if (!FEEDBACK_TEMPLATES.includes(send.template_slug)) continue;
    const set = sendsByTester.get(send.tester_id) ?? new Set<string>();
    set.add(send.template_slug);
    sendsByTester.set(send.tester_id, set);
  }

  const nextActions: string[] = [];
  const missingFeedbackHash: string[] = [];
  const alreadySubmitted: string[] = [];

  for (const tester of testers) {
    const elapsed = daysSince(tester.delivered_at, now);
    if (elapsed === null || elapsed < 2) continue;

    const feedback = feedbackByTester.get(tester.id);
    if (!feedback?.hash) {
      missingFeedbackHash.push(tester.id);
      continue;
    }
    if (feedback.submitted_at) {
      alreadySubmitted.push(tester.id);
      continue;
    }

    const sent = sendsByTester.get(tester.id) ?? new Set<string>();
    let action: string | null = null;

    if (elapsed >= 2 && !sent.has("feedback-mid")) {
      action = "feedback-mid";
    } else if (elapsed >= 5 && !sent.has("feedback-final")) {
      action = "feedback-final";
    } else if (elapsed >= 7 && !sent.has("feedback-reminder")) {
      action = "feedback-reminder";
    }

    if (!action) continue;
    nextActions.push(action);
  }

  return {
    eligibleDeliveredRows: testers.length,
    nextActionCounts: countBy(nextActions),
    missingFeedbackHashCount: missingFeedbackHash.length,
    alreadySubmittedCount: alreadySubmitted.length,
  };
}

export function summarizeDhlRows(rows: TesterAuditRow[], now: Date, staleHours: number) {
  const staleCutoff = now.getTime() - staleHours * 60 * 60 * 1000;
  const groups = new Map<string, {
    status: string | null;
    dhl_last_codes: string[] | null;
    count: number;
    oldest_check: string | null;
    newest_check: string | null;
  }>();
  let staleCount = 0;

  for (const row of rows) {
    const checkedAt = row.dhl_last_checked_at ? new Date(row.dhl_last_checked_at).getTime() : NaN;
    if (!Number.isFinite(checkedAt) || checkedAt <= staleCutoff) staleCount += 1;

    const key = JSON.stringify([row.status, row.dhl_last_codes ?? null]);
    const group = groups.get(key) ?? {
      status: row.status,
      dhl_last_codes: row.dhl_last_codes ?? null,
      count: 0,
      oldest_check: null,
      newest_check: null,
    };
    group.count += 1;
    if (row.dhl_last_checked_at) {
      if (!group.oldest_check || row.dhl_last_checked_at < group.oldest_check) {
        group.oldest_check = row.dhl_last_checked_at;
      }
      if (!group.newest_check || row.dhl_last_checked_at > group.newest_check) {
        group.newest_check = row.dhl_last_checked_at;
      }
    }
    groups.set(key, group);
  }

  return {
    trackedRows: rows.length,
    staleOlderThanHours: staleHours,
    staleCount,
    byStatusAndCodes: Array.from(groups.values()).sort((a, b) => b.count - a.count),
  };
}
