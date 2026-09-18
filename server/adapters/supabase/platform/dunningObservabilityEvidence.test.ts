import { describe, expect, it } from "vitest";
import {
  DUNNING_ATTENTION_NOTIFICATION_STATUSES,
  DUNNING_TERMINAL_CASE_STATUSES,
  oldestCaseOpenedAt,
  selectDunningCaseNotifications,
  summarizeDunning,
  summarizeDunningQueue,
  type DunningCaseEvidenceRow,
  type DunningNotificationEvidenceRow,
} from "./dunningObservabilityEvidence.js";

const NOW = new Date("2026-06-06T10:00:00.000Z");

describe("dunning evidence read scopes", () => {
  it("keeps the read vocabulary disjoint so no row is counted twice or dropped", () => {
    // The queued read, the attention read and the terminal case read partition
    // the rows the old single slice returned; nothing may appear in two of them.
    expect([...DUNNING_ATTENTION_NOTIFICATION_STATUSES]).toEqual(["failed", "skipped"]);
    expect([...DUNNING_ATTENTION_NOTIFICATION_STATUSES]).not.toContain("queued");
    expect([...DUNNING_TERMINAL_CASE_STATUSES]).toEqual(["recovered", "expired", "cancelled"]);
    expect([...DUNNING_TERMINAL_CASE_STATUSES]).not.toContain("open");
  });

  it("bounds the case-linked notice window at the oldest retained case", () => {
    expect(oldestCaseOpenedAt([
      caseRow({ id: "case-new", opened_at: "2026-06-05T00:00:00.000Z" }),
      caseRow({ id: "case-old", opened_at: "2026-04-01T00:00:00.000Z" }),
    ])).toBe("2026-04-01T00:00:00.000Z");
  });

  it("drops the window rather than narrowing it when a retained case has no opened_at", () => {
    expect(oldestCaseOpenedAt([
      caseRow({ id: "case-dated", opened_at: "2026-06-05T00:00:00.000Z" }),
      caseRow({ id: "case-undated", opened_at: null }),
    ])).toBeNull();
    expect(oldestCaseOpenedAt([])).toBeNull();
  });

  it("windows, orders and caps the case-linked notice read", async () => {
    const calls: Array<[string, unknown[]]> = [];
    await selectDunningCaseNotifications(fakeClient(calls, []), [
      caseRow({ id: "case-1", opened_at: "2026-04-01T00:00:00.000Z" }),
    ]);
    expect(calls).toEqual([
      ["from", ["subscription_dunning_notifications"]],
      ["select", ["id,case_id,status,recipient_kind,template_slug,scheduled_at,created_at"]],
      ["gte", ["created_at", "2026-04-01T00:00:00.000Z"]],
      ["order", ["created_at", { ascending: false }]],
      ["limit", [4000]],
    ]);
  });

  it("reads unwindowed when the bound cannot be computed, and not at all with no cases", async () => {
    const undatedCalls: Array<[string, unknown[]]> = [];
    await selectDunningCaseNotifications(fakeClient(undatedCalls, []), [caseRow({ id: "case-1", opened_at: null })]);
    expect(undatedCalls.map(([method]) => method)).toEqual(["from", "select", "order", "limit"]);

    const emptyCalls: Array<[string, unknown[]]> = [];
    expect(await selectDunningCaseNotifications(fakeClient(emptyCalls, []), [])).toEqual([]);
    expect(emptyCalls).toEqual([]);
  });
});

describe("dunning summarizers", () => {
  it("counts the queue from the queued and attention reads combined", () => {
    const queue = summarizeDunningQueue([
      notificationRow({ id: "n-1", status: "queued", scheduled_at: "2026-06-06T09:30:00.000Z" }),
      notificationRow({ id: "n-2", status: "queued", scheduled_at: "2026-06-06T08:00:00.000Z" }),
      notificationRow({ id: "n-3", status: "failed", recipient_kind: "admin" }),
      notificationRow({ id: "n-4", status: "skipped", template_slug: "subscription-payment-failed-admin" }),
    ]);
    expect(queue).toMatchObject({
      queuedCount: 2,
      oldestQueuedAt: "2026-06-06T08:00:00.000Z",
      failedCount: 1,
      skippedCount: 1,
      criticalFailedCount: 1,
      criticalSkippedCount: 1,
    });
  });

  it("lets a delivered notice suppress the missing-notice signals after the read split", () => {
    // The regression the split could have caused: the queued/attention reads
    // exclude `sent` rows, so a case whose notices were all delivered would look
    // silent unless the case-linked read carries every status.
    const dunning = summarizeDunning(
      [
        caseRow({ id: "case-expired", status: "expired", expired_at: "2026-06-06T09:00:00.000Z" }),
        caseRow({ id: "case-silent", status: "expired", expired_at: "2026-06-06T09:30:00.000Z" }),
      ],
      [
        notificationRow({ id: "n-1", case_id: "case-expired", status: "sent", template_slug: "subscription-payment-expired" }),
        notificationRow({ id: "n-2", case_id: "case-expired", status: "sent", recipient_kind: "admin" }),
      ],
      NOW,
    );
    expect(dunning.expiredWithoutCustomerNoticeCount).toBe(1);
    expect(dunning.failureWithoutAdminAlertCount).toBe(1);
    expect(dunning.expiredCount24h).toBe(2);
  });

  it("leaves every signal's meaning unchanged when cancelled cases flow through the terminal read", () => {
    // A cancelled case reaches the summarizer through the terminal read now,
    // where it used to arrive in the blunt all-status slice. Its treatment must
    // be identical either way: the cancel writers move a case out of `open`
    // without ever setting expired_at or recovered_at (migration
    // 20260721200002:163 and 20260721200003:807), so it can only be counted by
    // the one signal that filters on retry_attempt instead of status.
    const cancelledCase = caseRow({
      id: "case-cancelled",
      status: "cancelled",
      opened_at: "2026-05-01T00:00:00.000Z",
      next_retry_at: null,
      expired_at: null,
      recovered_at: null,
    });
    const cases = [
      caseRow({ id: "case-expired", status: "expired", opened_at: "2026-06-01T00:00:00.000Z", expired_at: "2026-06-06T09:00:00.000Z" }),
      caseRow({ id: "case-open", status: "open", opened_at: "2026-06-02T00:00:00.000Z", next_retry_at: "2026-06-06T09:45:00.000Z" }),
    ];
    const notices = [
      notificationRow({ id: "n-1", case_id: "case-expired", status: "sent", template_slug: "subscription-payment-expired" }),
      notificationRow({ id: "n-2", case_id: "case-expired", status: "sent", recipient_kind: "admin" }),
      notificationRow({ id: "n-3", case_id: "case-open", status: "sent", recipient_kind: "admin" }),
    ];

    const without = summarizeDunning(cases, notices, NOW);
    const with_ = summarizeDunning([...cases, cancelledCase], notices, NOW);

    // Status-filtered signals: byte-identical with the cancelled case present.
    expect(with_.expiredCount24h).toBe(without.expiredCount24h);
    expect(with_.recoveredCount24h).toBe(without.recoveredCount24h);
    expect(with_.overdueRetryCount).toBe(without.overdueRetryCount);
    expect(with_.expiredWithoutCustomerNoticeCount).toBe(without.expiredWithoutCustomerNoticeCount);
    expect(with_.failedAdminNotificationCount).toBe(without.failedAdminNotificationCount);
    expect(with_.skippedAdminNotificationCount).toBe(without.skippedAdminNotificationCount);
    // The one signal that never filtered on status still sees it, exactly as
    // the pre-split all-status read did. Dropping it here would have been a
    // silent undercount of unalerted payment failures.
    expect(without.failureWithoutAdminAlertCount).toBe(0);
    expect(with_.failureWithoutAdminAlertCount).toBe(1);
    // And the notice-window bound still widens to cover it.
    expect(oldestCaseOpenedAt([...cases, cancelledCase])).toBe("2026-05-01T00:00:00.000Z");
  });

  it("counts overdue retries and the 24h transitions off the merged case set", () => {
    const dunning = summarizeDunning(
      [
        caseRow({ id: "case-overdue", status: "open", next_retry_at: "2026-06-06T09:45:00.000Z" }),
        caseRow({ id: "case-scheduled", status: "open", next_retry_at: "2026-06-06T10:15:00.000Z" }),
        caseRow({ id: "case-recovered", status: "recovered", recovered_at: "2026-06-06T09:00:00.000Z" }),
        caseRow({ id: "case-stale", status: "recovered", recovered_at: "2026-06-01T09:00:00.000Z" }),
      ],
      [notificationRow({ id: "n-admin", case_id: "case-overdue", status: "sent", recipient_kind: "admin" })],
      NOW,
    );
    expect(dunning.overdueRetryCount).toBe(1);
    expect(dunning.recoveredCount24h).toBe(1);
    expect(dunning.expiredCount24h).toBe(0);
  });
});

function caseRow(overrides: Partial<DunningCaseEvidenceRow> & { id: string }): DunningCaseEvidenceRow {
  return { status: "open", retry_attempt: 1, ...overrides };
}

function notificationRow(
  overrides: Partial<DunningNotificationEvidenceRow> & { id: string },
): DunningNotificationEvidenceRow {
  return {
    case_id: "case-1",
    status: "queued",
    recipient_kind: "customer",
    created_at: "2026-06-06T09:00:00.000Z",
    ...overrides,
  };
}

function fakeClient(calls: Array<[string, unknown[]]>, rows: Array<Record<string, unknown>>) {
  const builder: Record<string, unknown> = {
    then(resolve: (value: { data: unknown[]; error: null }) => void) {
      resolve({ data: rows, error: null });
    },
  };
  for (const method of ["select", "eq", "gte", "in", "limit", "lte", "not", "order", "range"]) {
    builder[method] = (...args: unknown[]) => {
      calls.push([method, args]);
      return builder;
    };
  }
  return {
    from: (table: string) => {
      calls.push(["from", [table]]);
      return builder;
    },
  } as never;
}
