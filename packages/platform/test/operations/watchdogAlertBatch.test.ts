import { expect, it, vi } from "vitest";
import type { AlertDecision, OpenAlert } from "../../src/operations/contracts/index.js";
import { runPlatformWatchdog } from "../../src/operations/server/platformWatchdogService.js";
import { createBatchedWatchdogAlertUpsert, type WatchdogAlertBatchOutcome } from "../../src/operations/server/watchdogAlertBatch.js";

const now = new Date("2030-10-26T12:00:00Z");
type Decision = AlertDecision<"test-pager">;

function decision(dedupeKey: string, label = dedupeKey): Decision {
  return { dedupeKey, severity: "p0", owner: "operations", runbookUrl: "/runbook", title: "Synthetic alert", message: "Diagnostic", channels: ["test-pager"], payload: { label } };
}

function prepare({ dedupeKey, severity, payload }: Decision, observedAt: Date) {
  return { dedupeKey, severity, label: String(payload.label), observedAt: observedAt.toISOString() };
}

type Input = ReturnType<typeof prepare>;
type Persist = (inputs: readonly Input[]) => Promise<readonly WatchdogAlertBatchOutcome[]>;

function persisted(input: Input, index: number, status: OpenAlert["status"] = "acknowledged"): WatchdogAlertBatchOutcome {
  return { index, kind: "persisted", alert: { id: `alert-${input.label}`, dedupeKey: input.dedupeKey, severity: input.severity, status, lastNotifiedAt: null } };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function watchdog(persist: Persist) {
  const capture = vi.fn(prepare);
  const upsertOpenAlert = createBatchedWatchdogAlertUpsert({ prepare: capture, persist });
  const recordNotification = vi.fn(async (_alertId: string) => {});
  const resolveAlert = vi.fn(async (_dedupeKey: string) => {});
  const listOpenAlerts = vi.fn(async (): Promise<OpenAlert[]> => [
    { id: "stale-alert", dedupeKey: "stale", severity: "p0", status: "open", lastNotifiedAt: null },
  ]);
  const send = vi.fn(async () => ({ channel: "test-pager", status: "sent" }) as const);
  return {
    capture, recordNotification, resolveAlert, listOpenAlerts, send,
    run: (decisions: Decision[], checkOnly = false) => runPlatformWatchdog({
      evidencePort: { collectSnapshot: async () => ({ checkedAt: now.toISOString() }) }, evaluate: () => decisions,
      ledgerPort: { upsertOpenAlert, listOpenAlerts, recordNotification, resolveAlert }, sinkPort: { send }, catalog: [], now, checkOnly,
    }),
  };
}

it("batches a submitted burst by fours and correlates shuffled replies to captured input", async () => {
  const persist = vi.fn<Persist>(async (inputs) => inputs.map((item, index) => persisted(item, index)).reverse());
  const upsert = createBatchedWatchdogAlertUpsert({ prepare, persist });
  const decisions = ["a", "b", "c", "d", "e"].map((key) => decision(key));
  const observedAt = new Date(now);
  const writes = decisions.map((item) => upsert(item, observedAt));
  decisions[0].dedupeKey = "mutated";
  decisions[0].payload.label = "mutated";
  observedAt.setUTCDate(1);

  expect((await Promise.all(writes)).map(({ id }) => id)).toEqual(["alert-a", "alert-b", "alert-c", "alert-d", "alert-e"]);
  expect(persist.mock.calls.map(([items]) => items.map(({ dedupeKey }) => dedupeKey))).toEqual([["a", "b", "c", "d"], ["e"]]);
  expect(persist.mock.calls[0][0][0].observedAt).toBe(now.toISOString());
});

it("keeps same-key observations behind the complete watchdog notification chain", async () => {
  const firstBatchStarted = deferred();
  const firstBatch = deferred();
  const recordingStarted = deferred();
  const firstReceipt = deferred();
  const persist = vi.fn<Persist>(async (inputs) => {
    if (inputs[0].label === "first") {
      firstBatchStarted.resolve();
      await firstBatch.promise;
    }
    return inputs.map((item, index) => persisted(item, index, item.label === "first" ? "open" : "acknowledged"));
  });
  const host = watchdog(persist);
  host.recordNotification.mockImplementation(async (alertId) => {
    if (alertId === "alert-first") {
      recordingStarted.resolve();
      await firstReceipt.promise;
    }
  });
  const execution = host.run([decision("a", "first"), decision("a", "second"), decision("b"), decision("c"), decision("d"), decision("e")]);
  try {
    await firstBatchStarted.promise;
    expect(host.capture.mock.calls.map(([item]) => item.payload.label)).toEqual(["first", "b", "c", "d"]);
    firstBatch.resolve();
    await recordingStarted.promise;
    expect(host.capture.mock.calls.some(([item]) => item.payload.label === "second")).toBe(false);
  } finally {
    firstBatch.resolve();
    firstReceipt.resolve();
  }
  expect(await execution).toMatchObject({ notified: 1, suppressed: 5, resolved: 1 });
  expect(host.capture.mock.calls.map(([item]) => item.payload.label)).toEqual(["first", "b", "c", "d", "e", "second"]);
  expect(host.recordNotification).toHaveBeenCalledOnce();
});

it("rejects a failed observation before suppressed peers can allow further admissions", async () => {
  const failure = new Error("synthetic write rejection");
  const persist = vi.fn<Persist>(async (inputs) => inputs.map((item, index) => item.dedupeKey === "b"
    ? { index, kind: "failed", error: failure }
    : persisted(item, index, item.dedupeKey === "c" ? "open" : "acknowledged")).reverse());
  const host = watchdog(persist);

  await expect(host.run(["a", "b", "c", "d", "e"].map((key) => decision(key)))).rejects.toBe(failure);
  expect(persist).toHaveBeenCalledOnce();
  expect(persist.mock.calls[0][0].map(({ dedupeKey }) => dedupeKey)).toEqual(["a", "b", "c", "d"]);
  expect(host.recordNotification).toHaveBeenCalledWith("alert-c", expect.objectContaining({ channel: "test-pager" }), now, expect.any(Object));
  expect(host.resolveAlert).not.toHaveBeenCalled();
});

it.each(["missing", "duplicate", "out of range", "wrong key", "wrong severity"] as const)("rejects the full reply when a result is %s", async (problem) => {
  const persist: Persist = async ([first, second]) => {
    const valid = persisted(first, 0);
    switch (problem) {
      case "missing": return [valid];
      case "duplicate": return [valid, persisted(second, 0)];
      case "out of range": return [valid, persisted(second, 2)];
      case "wrong key": return [valid, persisted(first, 1)];
      case "wrong severity": return [valid, persisted({ ...second, severity: "p1" }, 1)];
    }
  };
  const upsert = createBatchedWatchdogAlertUpsert({ prepare, persist });
  const outcomes = await Promise.allSettled([upsert(decision("a"), now), upsert(decision("b"), now)]);
  expect(outcomes).toEqual([
    { status: "rejected", reason: expect.objectContaining({ message: "watchdog_alert_batch_response_invalid" }) },
    { status: "rejected", reason: expect.objectContaining({ message: "watchdog_alert_batch_response_invalid" }) },
  ]);
});

it("rejects a transport failure without retry and leaves the next run independent", async () => {
  const failure = new Error("synthetic lost store response");
  const persist = vi.fn<Persist>(async (items) => items.map((item, index) => persisted(item, index))).mockRejectedValueOnce(failure);
  const upsert = createBatchedWatchdogAlertUpsert({ prepare, persist });
  expect(await Promise.allSettled([upsert(decision("a"), now), upsert(decision("b"), now)])).toEqual([
    { status: "rejected", reason: failure }, { status: "rejected", reason: failure },
  ]);
  expect(persist).toHaveBeenCalledOnce();

  expect(await watchdog(persist).run([decision("c")])).toMatchObject({ suppressed: 1 });
  expect(persist.mock.calls.map(([items]) => items.map(({ dedupeKey }) => dedupeKey))).toEqual([["a", "b"], ["c"]]);
});

it("keeps a watchdog check read-only with the batch adapter installed", async () => {
  const persist = vi.fn<Persist>(async () => []);
  const host = watchdog(persist);

  expect(await host.run([decision("a")], true)).toMatchObject({ checkOnly: true, actionableCriticalCount: 1, notified: 0, resolved: 0 });
  expect(host.listOpenAlerts).toHaveBeenCalledOnce();
  expect(host.capture).not.toHaveBeenCalled();
  expect(persist).not.toHaveBeenCalled();
  expect(host.recordNotification).not.toHaveBeenCalled();
  expect(host.resolveAlert).not.toHaveBeenCalled();
  expect(host.send).not.toHaveBeenCalled();
});
