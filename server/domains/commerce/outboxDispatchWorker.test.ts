import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runOutboxDispatchWorker } from "./outboxDispatchWorker.js";
import {
  EVENT_TYPE,
  makeClock,
  makeConfig,
  makeDiagnostics,
  makeHandler,
  makeRegistry,
  makeRow,
  makeStore,
} from "./outboxDispatchWorkerTestKit.js";

// Core semantics: outcome mapping, counters, ordering, defensive paths.
// Budget/outage/lease resilience lives in outboxDispatchWorkerResilience.test.ts.

describe("runOutboxDispatchWorker (core)", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    vi.useRealTimers();
  });

  it("skips without touching the store when the registry is empty", async () => {
    const store = makeStore();
    const diagnostics = makeDiagnostics();
    const result = await runOutboxDispatchWorker({
      store,
      registry: new Map(),
      config: makeConfig(),
      clock: makeClock(),
    });

    expect(result).toMatchObject({
      ok: true,
      skipped: true,
      reason: "outbox_registry_empty",
      checked: 0,
      updated: 0,
      failures: 0,
      claimed: 0,
      processed: 0,
      retried: 0,
      snoozed: 0,
      discarded: 0,
      released: 0,
      duplicateInRun: 0,
      leaseLost: 0,
      batches: 0,
      byEventType: {},
      discardedEventIds: [],
    });
    expect(result.queue).toBeUndefined();
    expect(store.claimBatch).not.toHaveBeenCalled();
    expect(diagnostics.queueStats).not.toHaveBeenCalled();
  });

  it("maps all four outcome kinds and reports exact counters + byEventType", async () => {
    const rows = [
      makeRow({ id: "a", event_type: "t.processed", created_at: "2026-06-12T10:00:01.000Z", metadata: { claimToken: "tok-a" } }),
      makeRow({ id: "b", event_type: "t.retry", created_at: "2026-06-12T10:00:02.000Z", metadata: { claimToken: "tok-b" } }),
      makeRow({ id: "c", event_type: "t.discard", created_at: "2026-06-12T10:00:03.000Z", metadata: { claimToken: "tok-c" } }),
      makeRow({ id: "d", event_type: "t.snooze", created_at: "2026-06-12T10:00:04.000Z", metadata: { claimToken: "tok-d" } }),
    ];
    const store = makeStore([rows]);
    const diagnostics = makeDiagnostics();
    const registry = makeRegistry(
      makeHandler("t.processed", { kind: "processed", detail: { resendId: "re_1" } }),
      makeHandler("t.retry", { kind: "retry", reason: "transient" }),
      makeHandler("t.discard", { kind: "discard", reason: "bad_payload" }),
      makeHandler("t.snooze", { kind: "snooze", reason: "provider_down" }),
    );
    const config = makeConfig();
    const result = await runOutboxDispatchWorker({ store, diagnostics, registry, config, clock: makeClock() });

    expect(store.markProcessed).toHaveBeenCalledWith({
      eventId: "a",
      claimToken: "tok-a",
      metadata: { resendId: "re_1" },
    });
    expect(store.markFailed).toHaveBeenCalledWith({
      eventId: "b",
      claimToken: "tok-b",
      error: "transient",
      outcome: "retry",
      baseDelaySeconds: config.backoffBaseSeconds,
      maxDelaySeconds: config.backoffCapSeconds,
      maxAttempts: config.maxAttempts,
      snoozeSeconds: config.snoozeSeconds,
    });
    expect(store.markFailed).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: "c", outcome: "discard", error: "bad_payload" }),
    );
    expect(store.markFailed).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: "d", outcome: "snooze", error: "provider_down" }),
    );

    expect(result).toMatchObject({
      ok: true,
      skipped: false,
      reason: "provider_outage",
      checked: 4,
      updated: 1,
      failures: 2,
      claimed: 4,
      processed: 1,
      retried: 1,
      snoozed: 1,
      discarded: 1,
      released: 0,
      duplicateInRun: 0,
      leaseLost: 0,
      batches: 1,
      discardedEventIds: ["c"],
      queue: { pending: 0 },
    });
    expect(result.byEventType).toEqual({
      "t.processed": { processed: 1 },
      "t.retry": { retried: 1 },
      "t.discard": { discarded: 1 },
      "t.snooze": { snoozed: 1 },
    });
    expect(errorSpy).toHaveBeenCalledWith(
      "[outbox-dispatch] event_discarded",
      JSON.stringify({
        eventId: "c",
        eventType: "t.discard",
        aggregateId: "agg-1",
        attempts: 1,
        reason: "bad_payload",
      }),
    );
  });

  it("logs a benign discard at warn with a benign flag, not error", async () => {
    const rows = [makeRow({ id: "c", event_type: "t.discard", metadata: { claimToken: "tok-c" } })];
    const store = makeStore([rows]);
    const registry = makeRegistry(
      makeHandler("t.discard", { kind: "discard", reason: "orphan_deleted", benign: true }),
    );
    const result = await runOutboxDispatchWorker({
      store,
      registry,
      config: makeConfig(),
      clock: makeClock(),
    });

    expect(result).toMatchObject({ discarded: 1, discardedEventIds: ["c"] });
    expect(warnSpy).toHaveBeenCalledWith(
      "[outbox-dispatch] event_discarded",
      JSON.stringify({
        eventId: "c",
        eventType: "t.discard",
        aggregateId: "agg-1",
        attempts: 1,
        reason: "orphan_deleted",
        benign: true,
      }),
    );
    expect(errorSpy).not.toHaveBeenCalledWith(
      "[outbox-dispatch] event_discarded",
      expect.anything(),
    );
  });

  it("caps discardedEventIds at 25 while counting every discard", async () => {
    const rows = Array.from({ length: 30 }, (_, i) =>
      makeRow({
        id: `evt-${String(i).padStart(2, "0")}`,
        metadata: { claimToken: `tok-${i}` },
      }),
    );
    const store = makeStore([rows]);
    const registry = makeRegistry(makeHandler(EVENT_TYPE, { kind: "discard", reason: "broken" }));
    const result = await runOutboxDispatchWorker({
      store,
      registry,
      config: makeConfig({ batchSize: 30 }),
      clock: makeClock(),
    });

    expect(result.discarded).toBe(30);
    expect(result.failures).toBe(30);
    expect(result.discardedEventIds).toHaveLength(25);
    expect(result.discardedEventIds[0]).toBe("evt-00");
    expect(result.discardedEventIds[24]).toBe("evt-24");
  });

  it("maps a thrown handler error to retry with a 300-char truncated message", async () => {
    const longMessage = "x".repeat(400);
    const store = makeStore([[makeRow()]]);
    const handler = makeHandler(EVENT_TYPE, () => Promise.reject(new Error(longMessage)));
    const result = await runOutboxDispatchWorker({
      store,
      registry: makeRegistry(handler),
      config: makeConfig(),
      clock: makeClock(),
    });

    const call = store.markFailed.mock.calls[0][0] as { outcome: string; error: string };
    expect(call.outcome).toBe("retry");
    expect(call.error).toBe("x".repeat(300));
    expect(result.retried).toBe(1);
  });

  it("sorts each claimed batch by (created_at, id) before executing", async () => {
    const rows = [
      makeRow({ id: "c", created_at: "2026-06-12T10:02:00.000Z", metadata: { claimToken: "tok-c" } }),
      makeRow({ id: "a", created_at: "2026-06-12T10:00:00.000Z", metadata: { claimToken: "tok-a" } }),
      makeRow({ id: "b", created_at: "2026-06-12T10:00:00.000Z", metadata: { claimToken: "tok-b" } }),
    ];
    const store = makeStore([rows]);
    const handler = makeHandler(EVENT_TYPE, { kind: "processed" });
    await runOutboxDispatchWorker({
      store,
      registry: makeRegistry(handler),
      config: makeConfig(),
      clock: makeClock(),
    });

    expect(handler.handledIds).toEqual(["a", "b", "c"]);
  });

  it("keeps the run ok and omits queue when queueStats throws", async () => {
    const store = makeStore([[makeRow()]]);
    const diagnostics = makeDiagnostics();
    diagnostics.queueStats.mockRejectedValue(new Error("stats_down"));
    const handler = makeHandler(EVENT_TYPE, { kind: "processed" });
    const result = await runOutboxDispatchWorker({
      store,
      diagnostics,
      registry: makeRegistry(handler),
      config: makeConfig(),
      clock: makeClock(),
    });

    expect(result.ok).toBe(true);
    expect(result.processed).toBe(1);
    expect(result.queue).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith("[outbox-dispatch] queue_stats_failed", "stats_down");
  });

  it("omits queue when queueStats hangs past the 3s deadline and leaves no timer behind", async () => {
    vi.useFakeTimers();
    const store = makeStore([[makeRow()]]);
    const diagnostics = makeDiagnostics();
    diagnostics.queueStats.mockImplementation(() => new Promise(() => {}));
    const handler = makeHandler(EVENT_TYPE, { kind: "processed" });
    const resultPromise = runOutboxDispatchWorker({
      store,
      diagnostics,
      registry: makeRegistry(handler),
      config: makeConfig(),
      clock: makeClock(),
    });

    // Flush microtasks so the run reaches the queueStats race, then fire the deadline.
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(3000);
    const result = await resultPromise;

    expect(result.ok).toBe(true);
    expect(result.processed).toBe(1);
    expect(result.queue).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith("[outbox-dispatch] queue_stats_failed", "deadline_exceeded");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("marks a registry miss as retry outbox_handler_missing through markFailed", async () => {
    const store = makeStore([[makeRow({ event_type: "t.unknown", metadata: { claimToken: "tok-x" } })]]);
    // Registry non-empty (so no skip) but missing the claimed row's type.
    const handler = makeHandler(EVENT_TYPE, { kind: "processed" });
    const result = await runOutboxDispatchWorker({
      store,
      registry: makeRegistry(handler),
      config: makeConfig(),
      clock: makeClock(),
    });

    expect(store.markFailed).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: "evt-1", outcome: "retry", error: "outbox_handler_missing" }),
    );
    expect(result.retried).toBe(1);
  });

  it("reports runMs from the injected clock", async () => {
    const clock = makeClock(5000);
    const store = makeStore([[makeRow()]]);
    const handler = makeHandler(EVENT_TYPE, () => {
      clock.advance(1234);
      return Promise.resolve({ kind: "processed" } as const);
    });
    const result = await runOutboxDispatchWorker({
      store,
      registry: makeRegistry(handler),
      config: makeConfig(),
      clock,
    });

    expect(result.runMs).toBe(1234);
  });
});
