import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AlertDecision, AlertNotificationOutcome, ObservabilitySnapshot, OpenAlert } from "../../src/domains/platform/observabilityContracts.js";
import { runPlatformWatchdog } from "../../server/domains/platform/platformWatchdogService.js";

// This suite isolates state/failure scheduling. watchdogWorkload uses the real evaluator.
const evaluation = vi.hoisted(() => ({ decisions: [] as AlertDecision[] }));
vi.mock("../../src/domains/platform/observabilityEvaluator.js", () => ({
  evaluateObservability: () => evaluation.decisions,
}));
const now = new Date("2026-09-07T12:00:00Z");
const sent: AlertNotificationOutcome = { channel: "webhook", provider: "webhook", status: "sent" };
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
function decision(key: string, severity: AlertDecision["severity"] = "p0"): AlertDecision {
  return { dedupeKey: key, severity, title: key, message: key, owner: "platform", runbookUrl: "/runbook", channels: ["webhook"], payload: {} };
}
function row(key: string): OpenAlert {
  return { id: key, dedupeKey: key, severity: "p0", status: "open", lastNotifiedAt: null };
}
function harness(decisions = Array.from({ length: 8 }, (_, i) => decision(`key-${i}`))) {
  evaluation.decisions = decisions;
  const rows = new Map<string, OpenAlert>();
  const events: string[] = [];
  const ledger = {
    listOpenAlerts: vi.fn(async () => [row("stale")]),
    upsertOpenAlert: vi.fn(async (d: AlertDecision) => {
      events.push(`upsert:${d.dedupeKey}`);
      await delay(10);
      const alert = rows.get(d.dedupeKey) ?? { ...row(d.dedupeKey), severity: d.severity };
      rows.set(d.dedupeKey, alert);
      return alert;
    }),
    recordNotification: vi.fn(async (id: string, outcome: AlertNotificationOutcome, _at: Date, schedule: { nextAttemptAt: Date; failureCount: number }) => {
      events.push(`record:${id}`);
      await delay(10);
      Object.assign(rows.get(id)!, {
        lastNotificationStatus: outcome.status,
        nextNotificationAttemptAt: schedule.nextAttemptAt.toISOString(),
        notificationFailureCount: schedule.failureCount,
      });
    }),
    resolveAlert: vi.fn(async (key: string) => { events.push(`resolve:${key}`); await delay(10); }),
  };
  const sink = { send: vi.fn(async (d: AlertDecision) => {
    events.push(`send:${d.dedupeKey}`); await delay(100); return sent;
  }) };
  const evidence = { collectSnapshot: vi.fn(async () => ({ checkedAt: now.toISOString() }) as ObservabilitySnapshot) };
  const run = (checkOnly = false) => runPlatformWatchdog({ evidencePort: evidence, ledgerPort: ledger, sinkPort: sink, catalog: [], now, checkOnly });
  return { rows, events, ledger, sink, evidence, run };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("watchdog execution boundaries", () => {
  it("serializes duplicate keys without dropping them and reads updated cadence", async () => {
    const h = harness([decision("same"), decision("other"), decision("same")]);
    const promise = h.run();
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(h.ledger.upsertOpenAlert.mock.calls.map(([d]) => d.dedupeKey)).toEqual(["other", "same", "same"]);
    expect(h.sink.send.mock.calls.filter(([d]) => d.dedupeKey === "same")).toHaveLength(1);
    expect(result).toMatchObject({ alertCount: 3, notified: 2, throttledNotifications: 1, resolved: 1 });
    expect(result.decisions).toEqual(evaluation.decisions);
    expect(h.events.lastIndexOf("upsert:same")).toBeGreaterThan(h.events.indexOf("record:same"));
  });

  it("honors same-key dependencies before the severity of a later duplicate", async () => {
    const first = { ...decision("same", "p3"), paging: "never" as const };
    const h = harness([first, decision("same"), decision("real", "p1")]);
    const promise = h.run();
    await vi.runAllTimersAsync();
    await promise;
    expect(h.ledger.upsertOpenAlert.mock.calls.map(([d]) => [d.dedupeKey, d.severity]))
      .toEqual([["real", "p1"], ["same", "p3"], ["same", "p0"]]);
  });

  it("schedules pageable work before a same-severity diagnostic without reordering the response", async () => {
    const diagnostic = { ...decision("a"), paging: "never" as const };
    const h = harness([diagnostic, decision("z")]);
    const promise = h.run();
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(h.ledger.upsertOpenAlert.mock.calls.map(([d]) => d.dedupeKey)).toEqual(["z", "a"]);
    expect(result.decisions).toEqual([diagnostic, decision("z")]);
  });

  it.each(["upsert", "record", "send"] as const)("drains admitted sink waiters after %s failure before rejecting", async (phase) => {
    const h = harness();
    const error = new Error(`${phase} failed`);
    if (phase === "upsert") h.ledger.upsertOpenAlert.mockImplementationOnce(async () => { await delay(15); throw error; });
    if (phase === "record") h.ledger.recordNotification.mockImplementationOnce(async () => { await delay(10); throw error; });
    if (phase === "send") h.sink.send.mockImplementationOnce(async () => { await delay(100); throw error; });
    let settled = false;
    const outcome = h.run().then(() => "unexpected success", (caught: unknown) => { settled = true; return caught; });
    await vi.advanceTimersByTimeAsync(125);
    expect(settled).toBe(false);
    expect(h.ledger.upsertOpenAlert).toHaveBeenCalledTimes(4);
    await vi.runAllTimersAsync();
    expect(await outcome).toBe(error);
    expect(h.ledger.upsertOpenAlert).toHaveBeenCalledTimes(4);
    expect(h.ledger.resolveAlert).not.toHaveBeenCalled();
    // All successful admitted sends are recorded, including those waiting at failure time.
    expect(h.ledger.recordNotification).toHaveBeenCalledTimes(phase === "record" ? 4 : 3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("treats an undefined rejection as failure, drains peers and admits no more work", async () => {
    const h = harness();
    h.ledger.upsertOpenAlert.mockImplementationOnce(async () => { await delay(15); throw undefined; });
    const outcome = h.run().then(() => ({ ok: true }), (error: unknown) => ({ ok: false, error }));
    await vi.runAllTimersAsync();
    expect(await outcome).toEqual({ ok: false, error: undefined });
    expect(h.ledger.upsertOpenAlert).toHaveBeenCalledTimes(4);
    expect(h.ledger.resolveAlert).not.toHaveBeenCalled();
  });

  it.each(["evidence", "list"] as const)("does not mutate anything after %s failure", async (phase) => {
    const h = harness();
    const error = new Error(phase);
    if (phase === "evidence") h.evidence.collectSnapshot.mockRejectedValueOnce(error);
    else h.ledger.listOpenAlerts.mockRejectedValueOnce(error);
    await expect(h.run()).rejects.toBe(error);
    expect(h.ledger.upsertOpenAlert).not.toHaveBeenCalled();
    expect(h.sink.send).not.toHaveBeenCalled();
    expect(h.ledger.resolveAlert).not.toHaveBeenCalled();
  });

  it("starts resolution only after decisions finish, then drains failed resolution peers", async () => {
    const h = harness([decision("current")]);
    h.ledger.listOpenAlerts.mockResolvedValue(Array.from({ length: 10 }, (_, i) => row(`stale-${i}`)));
    h.ledger.resolveAlert.mockImplementationOnce(async (key: string) => { h.events.push(`resolve:${key}`); await delay(5); throw new Error("resolve failed"); });
    const outcome = h.run().catch((error: Error) => error.message);
    await vi.runAllTimersAsync();
    expect(await outcome).toBe("resolve failed");
    expect(h.events.indexOf("resolve:stale-0")).toBeGreaterThan(h.events.indexOf("record:current"));
    expect(h.ledger.resolveAlert).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps returned delivery failure as a completed result and applies durable backoff", async () => {
    const h = harness([decision("current")]);
    h.sink.send.mockResolvedValue({ ...sent, status: "failed", error: "unavailable" });
    const first = h.run();
    await vi.runAllTimersAsync();
    expect(await first).toMatchObject({ notificationFailures: 1, resolved: 1 });
    const second = h.run();
    await vi.runAllTimersAsync();
    expect(await second).toMatchObject({ notificationFailures: 0, deliveryBackoffCount: 1, throttledNotifications: 1, resolved: 1 });
    expect(h.sink.send).toHaveBeenCalledTimes(1);
  });

  it("admits lower severity work while an earlier critical send is slow and sends serially", async () => {
    const h = harness([decision("p0"), decision("p1", "p1"), decision("another")]);
    const promise = h.run();
    await vi.advanceTimersByTimeAsync(25);
    expect(h.ledger.upsertOpenAlert).toHaveBeenCalledTimes(3);
    expect(h.sink.send).toHaveBeenCalledTimes(1);
    expect(h.ledger.recordNotification.mock.calls.map(([key]) => key)).toContain("p1");
    await vi.runAllTimersAsync();
    expect(await promise).toMatchObject({ notified: 2, belowThreshold: 1 });
  });

  it("keeps checkOnly free of writes despite duplicate and diagnostic inputs", async () => {
    const h = harness([decision("same"), decision("same"), { ...decision("diagnostic"), paging: "never" }]);
    const result = await h.run(true);
    expect(result).toMatchObject({ checkOnly: true, alertCount: 3, firingCount: 2, resolved: 0 });
    expect(h.ledger.upsertOpenAlert).not.toHaveBeenCalled();
    expect(h.ledger.recordNotification).not.toHaveBeenCalled();
    expect(h.sink.send).not.toHaveBeenCalled();
    expect(h.ledger.resolveAlert).not.toHaveBeenCalled();
  });
});
