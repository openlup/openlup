import { expect, it, vi } from "vitest";
import { runPlatformWatchdog } from "../../src/operations/server/platformWatchdogService.js";
import type { AlertDecision, AlertLedgerPort, AlertSinkPort, OpenAlert } from "../../src/operations/contracts/index.js";

const now = new Date("2026-10-26T12:00:00Z");
const decision: AlertDecision = {
  dedupeKey: "job_failed:example", severity: "p0", owner: "platform/ops",
  runbookUrl: "/example-runbook", title: "Example job failed", message: "Synthetic diagnostic",
  channels: ["webhook"], payload: {},
};
const alert: OpenAlert = { id: "alert-example", dedupeKey: decision.dedupeKey, status: "open", severity: "p0", lastNotifiedAt: null };
function ports(openAlerts: OpenAlert[] = []) {
  const ledger: AlertLedgerPort = {
    listOpenAlerts: vi.fn(async () => openAlerts),
    upsertOpenAlert: vi.fn(async () => alert), resolveAlert: vi.fn(async () => {}), recordNotification: vi.fn(async () => {}),
  };
  const sink: AlertSinkPort = { send: vi.fn(async () => ({ channel: "webhook", status: "sent" })) };
  return { ledger, sink };
}

it("passes typed evidence/catalog/time to evaluation and keeps checkOnly free of effects", async () => {
  const { ledger, sink } = ports();
  const snapshot = { checkedAt: now.toISOString(), decisions: [decision], sample: 7 };
  const catalog = [{ name: "example" }];
  const evaluate = vi.fn((evidence: typeof snapshot, _catalog: readonly { name: string }[], _at: Date) => evidence.decisions);
  const result = await runPlatformWatchdog({ evidencePort: { collectSnapshot: async () => snapshot }, evaluate, ledgerPort: ledger, sinkPort: sink, catalog, now, checkOnly: true });
  expect(evaluate).toHaveBeenCalledWith(snapshot, catalog, now);
  expect(result).toMatchObject({ ok: true, health: "firing", firingCount: 1, actionableCriticalCount: 1, notified: 0 });
  expect(ledger.upsertOpenAlert).not.toHaveBeenCalled();
  expect(ledger.resolveAlert).not.toHaveBeenCalled();
  expect(ledger.recordNotification).not.toHaveBeenCalled();
  expect(sink.send).not.toHaveBeenCalled();
});

it("uses the maintained ledger/delivery transitions and resolves only stale keys", async () => {
  const { ledger, sink } = ports([{ ...alert, dedupeKey: "old-alert" }]);
  const result = await runPlatformWatchdog({ evidencePort: { collectSnapshot: async () => ({ checkedAt: now.toISOString() }) }, evaluate: () => [decision], ledgerPort: ledger, sinkPort: sink, catalog: [], now, checkOnly: false });
  expect(result).toMatchObject({ notified: 1, resolved: 1, actionablePageableCount: 1 });
  expect(ledger.upsertOpenAlert).toHaveBeenCalledWith(decision, now);
  expect(sink.send).toHaveBeenCalledWith(decision, alert);
  expect(ledger.recordNotification).toHaveBeenCalledWith(alert.id, { channel: "webhook", status: "sent" }, now, { failureCount: 0, nextAttemptAt: new Date("2026-10-26T13:00:00Z") });
  expect(ledger.resolveAlert).toHaveBeenCalledWith("old-alert", now);
});

it("preserves a neutral host channel through evaluation, sink and persisted notification", async () => {
  const hostDecision: AlertDecision<"operator-pager"> = { ...decision, channels: ["operator-pager"] };
  const ledger: AlertLedgerPort<"operator-pager"> = {
    listOpenAlerts: async () => [], upsertOpenAlert: async () => alert,
    resolveAlert: async () => {}, recordNotification: vi.fn(async () => {}),
  };
  const sink: AlertSinkPort<"operator-pager"> = { send: vi.fn(async () => ({ channel: "operator-pager", status: "sent" })) };
  const result = await runPlatformWatchdog({ evidencePort: { collectSnapshot: async () => ({ checkedAt: now.toISOString() }) }, evaluate: () => [hostDecision], ledgerPort: ledger, sinkPort: sink, catalog: [], now, checkOnly: false });
  expect(result.decisions).toEqual([hostDecision]);
  expect(sink.send).toHaveBeenCalledWith(hostDecision, alert);
  expect(ledger.recordNotification).toHaveBeenCalledWith(alert.id, { channel: "operator-pager", status: "sent" }, now, { failureCount: 0, nextAttemptAt: new Date("2026-10-26T13:00:00Z") });
});
