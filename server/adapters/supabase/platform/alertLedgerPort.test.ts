import { describe, expect, it } from "vitest";
import type { AlertDecision } from "../../../../src/domains/platform/observabilityContracts.js";
import {
  createSupabaseAlertLedgerPort,
  type SupabaseAlertLedgerClient,
} from "./alertLedgerPort.js";

type Result = { data: unknown; error: unknown };
type Call = { table: string; method: string; arg?: unknown };

// Minimal chainable Supabase stub: every builder method returns the same stub and
// records the call; `maybeSingle()` and awaiting the stub both pull the next queued
// result, so call order maps to the result queue.
function makeClient(results: Result[]) {
  const calls: Call[] = [];
  let i = 0;
  const next = (): Result => results[Math.min(i++, results.length - 1)] ?? { data: null, error: null };

  function table(name: string) {
    const stub: Record<string, unknown> = {};
    for (const method of ["select", "in", "eq", "order", "insert", "update", "upsert"]) {
      stub[method] = (arg?: unknown) => {
        calls.push({ table: name, method, arg });
        return stub;
      };
    }
    stub.maybeSingle = () => Promise.resolve(next());
    stub.then = (resolve: (value: Result) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(next()).then(resolve, reject);
    return stub;
  }

  const client = { from: (name: string) => table(name) } as unknown as SupabaseAlertLedgerClient;
  return { client, calls };
}

const now = new Date("2026-06-06T10:00:00.000Z");

function decision(): AlertDecision {
  return {
    dedupeKey: "job_missed:critical-job",
    severity: "p1",
    owner: "platform/test",
    runbookUrl: "/docs/platform/RUNTIME_AND_SELF_HOSTING.md",
    title: "Scheduled job missed",
    message: "critical-job last succeeded long ago.",
    channels: ["webhook"],
    payload: { jobName: "critical-job" },
  };
}

describe("supabase alert ledger port", () => {
  it("maps open alerts including delivery state and snoozed_until", async () => {
    const { client, calls } = makeClient([
      {
        data: [
          { id: "a1", dedupe_key: "k", status: "acknowledged", severity: "p1", last_notified_at: null, last_notification_attempt_at: "2026-06-06T10:00:00.000Z", last_notification_status: "failed", next_notification_attempt_at: "2026-06-06T10:10:00.000Z", notification_failure_count: 1, snoozed_until: "2026-06-06T12:00:00.000Z" },
        ],
        error: null,
      },
    ]);

    const open = await createSupabaseAlertLedgerPort(client).listOpenAlerts();

    expect(open[0]).toEqual({
      id: "a1",
      dedupeKey: "k",
      status: "acknowledged",
      severity: "p1",
      lastNotifiedAt: null,
      lastNotificationAttemptAt: "2026-06-06T10:00:00.000Z",
      lastNotificationStatus: "failed",
      nextNotificationAttemptAt: "2026-06-06T10:10:00.000Z",
      notificationFailureCount: 1,
      snoozedUntil: "2026-06-06T12:00:00.000Z",
    });
    expect(calls.some((c) => c.method === "select" && String(c.arg).includes("next_notification_attempt_at"))).toBe(true);
  });

  it("inserts a new alert and maps the returned row", async () => {
    const { client } = makeClient([
      { data: null, error: null }, // findAlert -> none
      { data: { id: "a2", dedupe_key: "job_missed:critical-job", status: "open", severity: "p1", last_notified_at: null, snoozed_until: null }, error: null },
    ]);

    const alert = await createSupabaseAlertLedgerPort(client).upsertOpenAlert(decision(), now);
    expect(alert).toMatchObject({ id: "a2", status: "open", snoozedUntil: null });
  });

  it("records skipped attempts without advancing confirmed delivery while deferring duplicates", async () => {
    const { client, calls } = makeClient([
      { data: null, error: null }, // notification insert
      { data: null, error: null }, // alert delivery-state update
    ]);

    await createSupabaseAlertLedgerPort(client).recordNotification(
      "a1",
      { channel: "webhook", status: "skipped", provider: "webhook", error: "below_paging_severity" },
      now,
      { nextAttemptAt: new Date("2026-06-06T22:00:00.000Z"), failureCount: 0 },
    );

    expect(calls).toContainEqual(expect.objectContaining({ table: "platform_alert_notifications", method: "insert" }));
    const update = calls.find((c) => c.table === "platform_alerts" && c.method === "update");
    expect(update?.arg).toMatchObject({
      last_notification_attempt_at: now.toISOString(),
      last_notification_status: "skipped",
      next_notification_attempt_at: "2026-06-06T22:00:00.000Z",
      notification_failure_count: 0,
    });
    expect(update?.arg).not.toHaveProperty("last_notified_at");
  });

  it("stamps last_notified_at only after a confirmed send", async () => {
    const { client, calls } = makeClient([
      { data: null, error: null }, // notification insert
      { data: null, error: null }, // platform_alerts update
    ]);

    await createSupabaseAlertLedgerPort(client).recordNotification(
      "a1",
      { channel: "webhook", status: "sent", provider: "webhook" },
      now,
      { nextAttemptAt: new Date("2026-06-06T14:00:00.000Z"), failureCount: 0 },
    );

    const update = calls.find((c) => c.table === "platform_alerts" && c.method === "update");
    expect(update?.arg).toMatchObject({
      last_notified_at: now.toISOString(),
      last_notification_status: "sent",
      next_notification_attempt_at: "2026-06-06T14:00:00.000Z",
      notification_failure_count: 0,
    });
  });

  it("persists failed delivery backoff without pretending it was sent", async () => {
    const { client, calls } = makeClient([
      { data: null, error: null }, // notification insert
      { data: null, error: null }, // alert delivery-state update
    ]);

    await createSupabaseAlertLedgerPort(client).recordNotification(
      "a1",
      { channel: "webhook", status: "failed", provider: "webhook", error: "timeout" },
      now,
      { nextAttemptAt: new Date("2026-06-06T10:20:00.000Z"), failureCount: 2 },
    );

    const update = calls.find((c) => c.table === "platform_alerts" && c.method === "update");
    expect(update?.arg).toMatchObject({
      last_notification_attempt_at: now.toISOString(),
      last_notification_status: "failed",
      next_notification_attempt_at: "2026-06-06T10:20:00.000Z",
      notification_failure_count: 2,
    });
    expect(update?.arg).not.toHaveProperty("last_notified_at");
  });

  it.each([
    ["resolved", "p1", "p1"],
    ["open", "p2", "p1"],
    ["acknowledged", "p2", "p1"],
    ["open", "p1", "p0"],
  ])("resets delivery throttle and stale suppression when %s %s becomes %s", async (status, previousSeverity, nextSeverity) => {
    const nextDecision = { ...decision(), severity: nextSeverity as AlertDecision["severity"] };
    const { client, calls } = makeClient([
      {
        data: {
          id: "a1",
          dedupe_key: nextDecision.dedupeKey,
          status,
          severity: previousSeverity,
          last_notified_at: "2026-06-06T09:00:00.000Z",
          last_notification_attempt_at: "2026-06-06T09:00:00.000Z",
          last_notification_status: "failed",
          next_notification_attempt_at: "2026-06-06T10:30:00.000Z",
          notification_failure_count: 3,
          snoozed_until: "2026-06-06T12:00:00.000Z",
        },
        error: null,
      },
      {
        data: {
          id: "a1",
          dedupe_key: nextDecision.dedupeKey,
          status: "open",
          severity: nextSeverity,
          last_notified_at: null,
          last_notification_attempt_at: null,
          last_notification_status: null,
          next_notification_attempt_at: null,
          notification_failure_count: 0,
          snoozed_until: null,
        },
        error: null,
      },
    ]);

    await createSupabaseAlertLedgerPort(client).upsertOpenAlert(nextDecision, now);

    const update = calls.find((c) => c.table === "platform_alerts" && c.method === "update");
    expect(update?.arg).toMatchObject({
      status: "open",
      last_notified_at: null,
      last_notification_attempt_at: null,
      last_notification_status: null,
      next_notification_attempt_at: null,
      notification_failure_count: 0,
      snoozed_until: null,
      acknowledged_at: null,
    });
  });

  it("preserves operator suppression while severity is unchanged", async () => {
    const { client, calls } = makeClient([
      {
        data: {
          id: "a1",
          dedupe_key: decision().dedupeKey,
          status: "acknowledged",
          severity: "p1",
          last_notified_at: "2026-06-06T09:00:00.000Z",
          last_notification_attempt_at: "2026-06-06T09:00:00.000Z",
          last_notification_status: "failed",
          next_notification_attempt_at: "2026-06-06T10:30:00.000Z",
          notification_failure_count: 3,
          snoozed_until: "2026-06-06T12:00:00.000Z",
        },
        error: null,
      },
      {
        data: {
          id: "a1",
          dedupe_key: decision().dedupeKey,
          status: "acknowledged",
          severity: "p1",
          last_notified_at: "2026-06-06T09:00:00.000Z",
          last_notification_attempt_at: "2026-06-06T09:00:00.000Z",
          last_notification_status: "failed",
          next_notification_attempt_at: "2026-06-06T10:30:00.000Z",
          notification_failure_count: 3,
          snoozed_until: "2026-06-06T12:00:00.000Z",
        },
        error: null,
      },
    ]);

    await createSupabaseAlertLedgerPort(client).upsertOpenAlert(decision(), now);

    const update = calls.find((c) => c.table === "platform_alerts" && c.method === "update");
    expect(update?.arg).toMatchObject({ status: "acknowledged" });
    expect(update?.arg).not.toHaveProperty("last_notified_at");
    expect(update?.arg).not.toHaveProperty("next_notification_attempt_at");
    expect(update?.arg).not.toHaveProperty("notification_failure_count");
    expect(update?.arg).not.toHaveProperty("snoozed_until");
    expect(update?.arg).not.toHaveProperty("acknowledged_at");
  });
});
