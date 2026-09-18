import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OutboxHandler, OutboxHandlerOutcome } from "./outboxDispatchContracts.js";
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

// Resilience semantics: circuit-break, snooze budget, abort timeout, in-run
// duplicates, tail-reserving budget gate, lease-loss accounting.
// Core outcome mapping lives in outboxDispatchWorker.test.ts.

describe("runOutboxDispatchWorker (resilience)", () => {
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

  it("circuit-breaks on snooze below the budget: releases the remainder with snoozeSeconds and stops", async () => {
    const rows = [
      makeRow({ id: "a", created_at: "2026-06-12T10:00:01.000Z", metadata: { claimToken: "tok-a" } }),
      makeRow({ id: "b", created_at: "2026-06-12T10:00:02.000Z", metadata: { claimToken: "tok-b" } }),
      makeRow({ id: "c", created_at: "2026-06-12T10:00:03.000Z", metadata: { claimToken: "tok-c" } }),
    ];
    const store = makeStore([rows, [makeRow({ id: "never" })]]);
    const diagnostics = makeDiagnostics();
    const handler = makeHandler(EVENT_TYPE, { kind: "snooze", reason: "resend_503" });
    const config = makeConfig({ batchSize: 3 });
    const result = await runOutboxDispatchWorker({
      store,
      diagnostics,
      registry: makeRegistry(handler),
      config,
      clock: makeClock(),
    });

    expect(handler.handledIds).toEqual(["a"]);
    expect(store.markFailed).toHaveBeenCalledTimes(1);
    expect(store.releaseUnprocessed).toHaveBeenCalledTimes(1);
    expect(store.releaseUnprocessed).toHaveBeenCalledWith(
      [
        { eventId: "b", claimToken: "tok-b" },
        { eventId: "c", claimToken: "tok-c" },
      ],
      config.snoozeSeconds,
    );
    expect(store.claimBatch).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      ok: true,
      reason: "provider_outage",
      snoozed: 1,
      released: 2,
      claimed: 3,
    });
    expect(diagnostics.queueStats).toHaveBeenCalledTimes(1);
  });

  it("downgrades snooze to retry at the snooze budget without circuit-breaking", async () => {
    const rows = [
      makeRow({
        id: "a",
        created_at: "2026-06-12T10:00:01.000Z",
        metadata: { claimToken: "tok-a", snoozeCount: 48 },
      }),
      makeRow({ id: "b", created_at: "2026-06-12T10:00:02.000Z", metadata: { claimToken: "tok-b" } }),
    ];
    const store = makeStore([rows]);
    const handler = makeHandler(EVENT_TYPE, (row) =>
      Promise.resolve(
        row.id === "a"
          ? ({ kind: "snooze", reason: "still_down" } as const)
          : ({ kind: "processed" } as const),
      ),
    );
    const result = await runOutboxDispatchWorker({
      store,
      registry: makeRegistry(handler),
      config: makeConfig({ maxSnoozes: 48 }),
      clock: makeClock(),
    });

    expect(store.markFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: "a",
        outcome: "retry",
        error: "snooze_budget_exhausted:still_down",
      }),
    );
    expect(store.releaseUnprocessed).not.toHaveBeenCalled();
    expect(handler.handledIds).toEqual(["a", "b"]);
    expect(result).toMatchObject({ retried: 1, processed: 1, snoozed: 0 });
    expect(result.reason).toBeUndefined();
  });

  it.each(["lifecycle", "recipient", "dedupe", "email_send"])(
    "aborts a hung %s phase and reports the last local phase with no dangling timers",
    async (phase) => {
      vi.useFakeTimers();
      let observedAbort = false;
      const handler: OutboxHandler = {
        eventType: EVENT_TYPE,
        timeoutMs: 1000,
        handle: (_row, signal, execution) =>
          new Promise<OutboxHandlerOutcome>(() => {
            execution?.setPhase(phase);
            signal.addEventListener("abort", () => {
              observedAbort = true;
            });
          }),
      };
      const store = makeStore([[makeRow()]]);
      const runPromise = runOutboxDispatchWorker({
        store,
        registry: makeRegistry(handler),
        config: makeConfig(),
        clock: makeClock(),
      });

      await vi.advanceTimersByTimeAsync(1000);
      expect(observedAbort).toBe(true);
      await vi.advanceTimersByTimeAsync(500);
      const result = await runPromise;

      expect(store.markFailed).toHaveBeenCalledWith(
        expect.objectContaining({ eventId: "evt-1", outcome: "retry", error: `outbox_handler_timeout:${phase}` }),
      );
      expect(result.retried).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("adds the last phase when an abort-aware handler returns the legacy timeout reason", async () => {
    const handler: OutboxHandler = {
      eventType: EVENT_TYPE,
      timeoutMs: 1000,
      async handle(_row, _signal, execution) {
        execution?.setPhase("email_send");
        return { kind: "retry", reason: "outbox_handler_timeout" };
      },
    };
    const store = makeStore([[makeRow()]]);

    await runOutboxDispatchWorker({
      store,
      registry: makeRegistry(handler),
      config: makeConfig(),
      clock: makeClock(),
    });

    expect(store.markFailed).toHaveBeenCalledWith(
      expect.objectContaining({ error: "outbox_handler_timeout:email_send" }),
    );
  });

  it("preserves an accepted result that settles after abort but before the backstop", async () => {
    vi.useFakeTimers();
    const handler: OutboxHandler = {
      eventType: EVENT_TYPE,
      timeoutMs: 1000,
      handle: (_row, _signal, execution) => new Promise<OutboxHandlerOutcome>((resolve) => {
        execution?.setPhase("email_send");
        setTimeout(() => resolve({ kind: "processed", detail: { providerMessageId: "near_timeout" } }), 1400);
      }),
    };
    const store = makeStore([[makeRow()]]);
    const runPromise = runOutboxDispatchWorker({
      store,
      registry: makeRegistry(handler),
      config: makeConfig(),
      clock: makeClock(),
    });

    await vi.advanceTimersByTimeAsync(1400);
    const result = await runPromise;

    expect(store.markProcessed).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: "evt-1" }),
    );
    expect(store.markFailed).not.toHaveBeenCalled();
    expect(result.processed).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("releases a duplicate id from a later batch with backoffBaseSeconds and never re-executes it", async () => {
    const rowFirst = makeRow({ id: "dup", metadata: { claimToken: "tok-1" } });
    const rowAgain = makeRow({ id: "dup", metadata: { claimToken: "tok-2" } });
    const store = makeStore([[rowFirst], [rowAgain], []]);
    const handler = makeHandler(EVENT_TYPE, { kind: "processed" });
    const config = makeConfig({ batchSize: 1 });
    const result = await runOutboxDispatchWorker({
      store,
      registry: makeRegistry(handler),
      config,
      clock: makeClock(),
    });

    expect(handler.handledIds).toEqual(["dup"]);
    expect(store.releaseUnprocessed).toHaveBeenCalledWith(
      [{ eventId: "dup", claimToken: "tok-2" }],
      config.backoffBaseSeconds,
    );
    expect(result).toMatchObject({
      processed: 1,
      duplicateInRun: 1,
      released: 1,
      claimed: 2,
      batches: 2,
    });
    expect(result.byEventType[EVENT_TYPE]).toEqual({ processed: 1, duplicateInRun: 1 });
  });

  it("tail gate: releases a row whose timeout cannot fit the budget with delay 0 and ends the drain", async () => {
    const clock = makeClock();
    const rows = [
      makeRow({ id: "a", created_at: "2026-06-12T10:00:01.000Z", metadata: { claimToken: "tok-a" } }),
      makeRow({ id: "b", created_at: "2026-06-12T10:00:02.000Z", metadata: { claimToken: "tok-b" } }),
    ];
    const store = makeStore([rows, [makeRow({ id: "never" })]]);
    const handler = makeHandler(
      EVENT_TYPE,
      () => {
        clock.advance(4000);
        return Promise.resolve({ kind: "processed" } as const);
      },
      5000,
    );
    const result = await runOutboxDispatchWorker({
      store,
      registry: makeRegistry(handler),
      config: makeConfig({ batchSize: 2, softBudgetMs: 10_000 }),
      clock,
    });

    expect(handler.handledIds).toEqual(["a"]);
    expect(store.releaseUnprocessed).toHaveBeenCalledTimes(1);
    expect(store.releaseUnprocessed).toHaveBeenCalledWith([{ eventId: "b", claimToken: "tok-b" }], 0);
    expect(store.claimBatch).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ processed: 1, released: 1, claimed: 2 });
    expect(result.reason).toBeUndefined();
  });

  it("counts a missing claimToken as leaseLost without executing the handler", async () => {
    const store = makeStore([[makeRow({ metadata: {} })]]);
    const handler = makeHandler(EVENT_TYPE, { kind: "processed" });
    const result = await runOutboxDispatchWorker({
      store,
      registry: makeRegistry(handler),
      config: makeConfig(),
      clock: makeClock(),
    });

    expect(handler.handledIds).toEqual([]);
    expect(store.markProcessed).not.toHaveBeenCalled();
    expect(store.markFailed).not.toHaveBeenCalled();
    expect(result.leaseLost).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith("[outbox-dispatch] missing_claim_token", "evt-1");
  });

  it("counts markProcessed applied:false and markFailed 'missed' as leaseLost", async () => {
    const rows = [
      makeRow({ id: "a", created_at: "2026-06-12T10:00:01.000Z", metadata: { claimToken: "tok-a" } }),
      makeRow({ id: "b", created_at: "2026-06-12T10:00:02.000Z", metadata: { claimToken: "tok-b" } }),
    ];
    const store = makeStore([rows]);
    store.markProcessed.mockResolvedValue({ applied: false });
    store.markFailed.mockResolvedValue({ status: "missed" });
    const handler = makeHandler(EVENT_TYPE, (row) =>
      Promise.resolve(
        row.id === "a" ? ({ kind: "processed" } as const) : ({ kind: "retry", reason: "r" } as const),
      ),
    );
    const result = await runOutboxDispatchWorker({
      store,
      registry: makeRegistry(handler),
      config: makeConfig(),
      clock: makeClock(),
    });

    expect(result.leaseLost).toBe(2);
    expect(result.processed).toBe(0);
    expect(result.retried).toBe(0);
    expect(result.byEventType[EVENT_TYPE]).toEqual({ leaseLost: 2 });
    expect(warnSpy).toHaveBeenCalledWith("[outbox-dispatch] outbox_lease_lost", "a");
    expect(warnSpy).toHaveBeenCalledWith("[outbox-dispatch] outbox_lease_lost", "b");
  });
});
