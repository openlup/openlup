import { describe, expect, it, vi } from "vitest";
import { runOutboxDispatchWorker, uniqueRegistry, readOutboxDispatchConfig, validateScheduledConfig, withPayloadSchema, OutboxHandlerExecutionTrace, type OutboxHandler, type OutboxStore } from "../src/index.js";
import { syntheticOutboxRow } from "../src/testing.js";
const config = { batchSize: 3, maxAttempts: 8, visibilitySeconds: 300, backoffBaseSeconds: 60, backoffCapSeconds: 3600, snoozeSeconds: 300, maxSnoozes: 48, softBudgetMs: 40000 };
function store(batches = [[syntheticOutboxRow()]]) {
  return { claimBatch: vi.fn(async () => batches.shift() ?? []), markProcessed: vi.fn(async () => ({ applied: true })), markFailed: vi.fn(async () => ({ status: "failed" as const })), releaseUnprocessed: vi.fn(async (items) => items.length) } satisfies OutboxStore;
}
const processed = (type = "example.created", timeoutMs = 10): OutboxHandler => ({ eventType: type, timeoutMs, handle: vi.fn(async () => ({ kind: "processed", detail: { synthetic: true } })) });
describe("portable worker protocol", () => {
  it("derives only the claim allowlist, retains explicit known ordering and mark arguments", async () => {
    const db = store(), handler = processed(); const known = ["example.future", "example.created"];
    const result = await runOutboxDispatchWorker({ store: db, registry: uniqueRegistry([handler]), config, knownEventTypes: known });
    expect(db.claimBatch).toHaveBeenCalledWith({ eventTypes: [handler.eventType], knownEventTypes: known, batchSize: 3, visibilitySeconds: 300, maxAttempts: 8 });
    expect(db.markProcessed).toHaveBeenCalledWith({ eventId: syntheticOutboxRow().id, claimToken: "synthetic-token", metadata: { synthetic: true } });
    expect(result).toMatchObject({ ok: true, checked: 1, updated: 1, claimed: 1, processed: 1, failures: 0, batches: 1 });
  });
  it("sorts by full timestamp precision and id before effects", async () => {
    const effects: string[] = []; const a = syntheticOutboxRow({ id: "a", created_at: "2026-01-01T00:00:00.000002Z" }); const b = syntheticOutboxRow({ id: "b" });
    const db = store([[a,b]]); const handler = { ...processed(), handle: async (row) => { effects.push(row.id); return { kind: "processed" as const }; } };
    await runOutboxDispatchWorker({ store: db, registry: uniqueRegistry([handler]), config }); expect(effects).toEqual(["b","a"]);
  });
  it("retains storage exceptions and leaves the remaining claims unrefunded", async () => {
    const db = store([[syntheticOutboxRow(), syntheticOutboxRow({id:"second"})]]); db.markProcessed.mockRejectedValueOnce(new Error("ack failed"));
    const handler = processed(); await expect(runOutboxDispatchWorker({ store: db, registry: uniqueRegistry([handler]), config })).rejects.toThrow("ack failed");
    expect(handler.handle).toHaveBeenCalledTimes(1); expect(db.releaseUnprocessed).not.toHaveBeenCalled();
  });
  it("refunds the soft-budget tail and keeps the bare immediate configuration accepted", async () => {
    const db = store(); const handler = processed("example.created", 1000);
    const result = await runOutboxDispatchWorker({ store: db, registry: uniqueRegistry([handler]), config: {...config,softBudgetMs:2000} });
    expect(handler.handle).not.toHaveBeenCalled(); expect(result.released).toBe(1); expect(db.releaseUnprocessed).toHaveBeenCalledWith([{eventId:syntheticOutboxRow().id,claimToken:"synthetic-token"}],0);
  });
  it("globally circuit-breaks snooze and refunds all later claims", async () => {
    const db = store([[syntheticOutboxRow(), syntheticOutboxRow({id:"second",event_type:"example.other"})]]);
    const first = {...processed(),handle:async () => ({kind:"snooze" as const,reason:"provider_outage"})};
    const second=processed("example.other"); db.markFailed.mockResolvedValueOnce({status:"snoozed"} as never);
    const r=await runOutboxDispatchWorker({store:db,registry:uniqueRegistry([first,second]),config});
    expect(r).toMatchObject({snoozed:1,released:1,reason:"provider_outage"}); expect(second.handle).not.toHaveBeenCalled(); expect(db.markFailed.mock.calls[0][0]).toMatchObject({outcome:"snooze",snoozeSeconds:300});
  });
  it("consumes an attempt instead of breaking the circuit after snooze budget", async () => {
    const db=store([[syntheticOutboxRow({metadata:{claimToken:"token",snoozeCount:48}})]]);
    const h={...processed(),handle:async()=>({kind:"snooze" as const,reason:"unavailable"})};
    const r=await runOutboxDispatchWorker({store:db,registry:uniqueRegistry([h]),config}); expect(r.retried).toBe(1); expect(r.reason).toBeUndefined(); expect(db.markFailed.mock.calls[0][0]).toMatchObject({outcome:"retry",error:"snooze_budget_exhausted:unavailable"});
  });
  it("releases a duplicate in-run without a second effect",async()=>{
    const row=syntheticOutboxRow(),db=store([[row],[row]]),h=processed();
    const r=await runOutboxDispatchWorker({store:db,registry:uniqueRegistry([h]),config:{...config,batchSize:1}}); expect(h.handle).toHaveBeenCalledTimes(1);expect(r.duplicateInRun).toBe(1);expect(r.released).toBe(1);
  });
  it("keeps discard logging, counters and diagnostic hook isolation",async()=>{
    const db=store(),error=vi.fn(),warn=vi.fn();db.markFailed.mockResolvedValueOnce({status:"discarded"} as never);
    const h={...processed(),handle:async()=>({kind:"discard" as const,reason:"synthetic",benign:true})};
    const r=await runOutboxDispatchWorker({store:db,registry:uniqueRegistry([h]),config,logger:{error,warn},observe:()=>{throw new Error("ignored");}});
    expect(r).toMatchObject({discarded:1,failures:1});expect(error).not.toHaveBeenCalled();expect(warn.mock.calls[0][0]).toBe("[outbox-dispatch] event_discarded");expect(JSON.parse(warn.mock.calls[0][1])).toMatchObject({reason:"synthetic",benign:true});
  });
  it("reports lost fences and malformed tokens without accepting an effect",async()=>{
    const db=store([[syntheticOutboxRow({metadata:{}}),syntheticOutboxRow({id:"other"})]]),h=processed();db.markProcessed.mockResolvedValueOnce({applied:false});
    const r=await runOutboxDispatchWorker({store:db,registry:uniqueRegistry([h]),config,logger:{warn:vi.fn(),error:vi.fn()}});expect(r.leaseLost).toBe(2);expect(r.processed).toBe(0);
  });
  it("aborts the handler, qualifies the phase and clears timers",async()=>{
    const db=store();const h:OutboxHandler={eventType:"example.created",timeoutMs:5,handle:async(_,signal,ctx)=>{ctx?.setPhase("PROVIDER / WAIT");return new Promise(resolve=>signal.addEventListener("abort",()=>resolve({kind:"retry",reason:"outbox_handler_timeout"}),{once:true}));}};
    await runOutboxDispatchWorker({store:db,registry:uniqueRegistry([h]),config});expect(db.markFailed.mock.calls[0][0].error).toBe("outbox_handler_timeout:provider___wait");
    const trace=new OutboxHandlerExecutionTrace();trace.setPhase("x".repeat(100));expect(trace.timeoutReason().length).toBe("outbox_handler_timeout:".length+48);
  });
  it("backstops a non-abortable handler",async()=>{
    const db=store();const h:OutboxHandler={eventType:"example.created",timeoutMs:1,handle:async()=>new Promise(()=>{})};
    await runOutboxDispatchWorker({store:db,registry:uniqueRegistry([h]),config});expect(db.markFailed.mock.calls[0][0].error).toBe("outbox_handler_timeout");
  });
  it("composes in order, sums timeouts, replays first after second retry, and retains context behavior",async()=>{
    const calls:string[]=[],contexts:unknown[]=[];let retry=true;
    const first:OutboxHandler={...processed(),handle:async(_,__,ctx)=>{calls.push("first");contexts.push(ctx);return {kind:"processed",detail:{resendId:"first",x:1}};}};
    const second:OutboxHandler={...processed(),handle:async()=>{calls.push("second");if(retry){retry=false;return {kind:"retry",reason:"retry"};}return {kind:"processed",detail:{resendId:"second",dedupe:true}};}};
    const h=uniqueRegistry([first,second]).get(first.eventType)!;expect(h.timeoutMs).toBe(20);const signal=new AbortController().signal;
    expect((await h.handle(syntheticOutboxRow(),signal,{setPhase:()=>{}})).kind).toBe("retry");
    expect(await h.handle(syntheticOutboxRow(),signal)).toEqual({kind:"processed",detail:{resendId:"first",dedupe:true,first:{resendId:"first",x:1},second:{resendId:"second",dedupe:true}}});expect(calls).toEqual(["first","second","first","second"]);expect(contexts).toEqual([undefined,undefined]);
  });
  it("opt-in validation retries invalid payloads; config helper preserves parse/clamp",async()=>{
    const h=processed();const typed=withPayloadSchema(h,{"~standard":{version:1,vendor:"synthetic",validate:()=>({issues:[{message:"invalid"}]})}});
    expect(await typed.handle(syntheticOutboxRow(),new AbortController().signal)).toEqual({kind:"retry",reason:"outbox_payload_invalid"});expect(h.handle).not.toHaveBeenCalled();
    expect(readOutboxDispatchConfig({X_BATCH_SIZE:"2.5"},"X_").batchSize).toBe(2);
  });
  it.each(["throw", "receiver"])("a %s logger cannot interrupt acknowledged work or its claimed tail",async(mode)=>{
    const db=store([[syntheticOutboxRow(),syntheticOutboxRow({id:"second"})]]),h=processed();db.markProcessed.mockResolvedValueOnce({applied:false});
    const logger={calls:0,warn(){this.calls++;if(mode==="throw")throw new Error("logger");},error(){this.calls++;if(mode==="throw")throw new Error("logger");}};
    const result=await runOutboxDispatchWorker({store:db,registry:uniqueRegistry([h]),config,logger});
    expect(h.handle).toHaveBeenCalledTimes(2);expect(result).toMatchObject({leaseLost:1,processed:1});expect(logger.calls).toBe(1);
  });
  it("a throwing queue-stat logger still returns the worker result and finish observation",async()=>{
    const observe=vi.fn();const result=await runOutboxDispatchWorker({store:store([]),registry:uniqueRegistry([processed()]),config,diagnostics:{queueStats:async()=>{throw new Error("stats");}},logger:{warn(){throw new Error("log");},error(){throw new Error("log");}},observe});
    expect(result.ok).toBe(true);expect(observe).toHaveBeenCalledWith({event:"finished",count:0});
  });

  it("isolates snooze to the snoozed event type and affected aggregates when snoozeScope is event_type", async () => {
    const batch1 = [
      syntheticOutboxRow({ id: "e-1", aggregate_id: "agg-a", event_type: "example.slow", created_at: "1999-01-01T00:00:01Z" }),
      syntheticOutboxRow({ id: "e-2", aggregate_id: "agg-a", event_type: "example.fast", created_at: "1999-01-01T00:00:02Z" }),
      syntheticOutboxRow({ id: "e-3", aggregate_id: "agg-b", event_type: "example.fast", created_at: "1999-01-01T00:00:03Z" }),
      syntheticOutboxRow({ id: "e-4", aggregate_id: "agg-c", event_type: "example.slow", created_at: "1999-01-01T00:00:04Z" }),
      syntheticOutboxRow({ id: "e-5", aggregate_id: "agg-c", event_type: "example.fast", created_at: "1999-01-01T00:00:05Z" }),
    ];
    const batch2 = [
      syntheticOutboxRow({ id: "e-6", aggregate_id: "agg-d", event_type: "example.fast", created_at: "1999-01-01T00:00:06Z" }),
    ];
    const db = store([batch1, batch2]);
    db.markFailed.mockResolvedValueOnce({ status: "snoozed" } as never);
    const slow = { ...processed("example.slow"), handle: vi.fn(async () => ({ kind: "snooze" as const, reason: "provider_rate_limit" })) };
    const fast = processed("example.fast");

    const r = await runOutboxDispatchWorker({
      store: db,
      registry: uniqueRegistry([slow, fast]),
      knownEventTypes: ["example.slow", "example.fast", "example.external"],
      config: { ...config, batchSize: 5, snoozeScope: "event_type" },
    });

    // e-1 snoozes; e-2 (same agg-a), e-4 (same event_type), and e-5 (transitively same agg-c as e-4) are released;
    // e-3 (independent agg-b) and batch2's e-6 (independent agg-d) are processed cleanly!
    expect(r).toMatchObject({ ok: true, snoozed: 1, released: 3, processed: 2, batches: 2 });
    expect(r.reason).toBeUndefined();
    expect(slow.handle).toHaveBeenCalledTimes(1);
    expect(fast.handle).toHaveBeenCalledTimes(2);
    expect(db.releaseUnprocessed).toHaveBeenCalledWith(
      [
        { eventId: "e-2", claimToken: "synthetic-token" },
        { eventId: "e-4", claimToken: "synthetic-token" },
        { eventId: "e-5", claimToken: "synthetic-token" },
      ],
      300,
    );
    // Second claimBatch omits example.slow from BOTH eventTypes and knownEventTypes so aggregate ordering holds
    expect(db.claimBatch).toHaveBeenNthCalledWith(2, {
      eventTypes: ["example.fast"],
      knownEventTypes: ["example.fast", "example.external"],
      batchSize: 5,
      visibilitySeconds: 300,
      maxAttempts: 8,
    });
  });

  it("circuit-breaks with provider_outage under snoozeScope event_type once every registered type snoozes", async () => {
    const db = store([[
      syntheticOutboxRow({ id: "e-1", aggregate_id: "agg-a", event_type: "example.one", created_at: "1999-01-01T00:00:01Z" }),
      syntheticOutboxRow({ id: "e-2", aggregate_id: "agg-b", event_type: "example.two", created_at: "1999-01-01T00:00:02Z" }),
      syntheticOutboxRow({ id: "e-3", aggregate_id: "agg-c", event_type: "example.two", created_at: "1999-01-01T00:00:03Z" }),
    ]]);
    db.markFailed.mockResolvedValue({ status: "snoozed" } as never);
    const one = { ...processed("example.one"), handle: vi.fn(async () => ({ kind: "snooze" as const, reason: "down_1" })) };
    const two = { ...processed("example.two"), handle: vi.fn(async () => ({ kind: "snooze" as const, reason: "down_2" })) };

    const r = await runOutboxDispatchWorker({
      store: db,
      registry: uniqueRegistry([one, two]),
      config: { ...config, snoozeScope: "event_type" },
    });
    expect(r).toMatchObject({ ok: true, snoozed: 2, released: 1, processed: 0, reason: "provider_outage" });
    expect(db.releaseUnprocessed).toHaveBeenCalledWith([{ eventId: "e-3", claimToken: "synthetic-token" }], 300);
  });

  it("validates snoozeScope in validateScheduledConfig", () => {
    expect(() => validateScheduledConfig({ ...config, snoozeScope: "all" }, 60, [100])).not.toThrow();
    expect(() => validateScheduledConfig({ ...config, snoozeScope: "event_type" }, 60, [100])).not.toThrow();
    expect(() => validateScheduledConfig({ ...config, snoozeScope: "invalid" as never }, 60, [100])).toThrow(/snoozeScope/);
  });

  it("preserves aggregate ordering and soft-budget drain stop when tail-gated rows meet snoozeScope event_type", async () => {
    const batch1 = [
      syntheticOutboxRow({ id: "e-1", aggregate_id: "agg-x", event_type: "example.heavy", created_at: "1999-01-01T00:00:01Z" }),
      syntheticOutboxRow({ id: "e-2", aggregate_id: "agg-x", event_type: "example.light", created_at: "1999-01-01T00:00:02Z" }),
      syntheticOutboxRow({ id: "e-3", aggregate_id: "agg-y", event_type: "example.light", created_at: "1999-01-01T00:00:03Z" }),
    ];
    const db = store([batch1, [syntheticOutboxRow({ id: "e-4", aggregate_id: "agg-z", event_type: "example.heavy" })]]);
    db.markFailed.mockResolvedValue({ status: "snoozed" } as never);
    const heavy = processed("example.heavy", 15_000);
    const light = { ...processed("example.light", 500), handle: vi.fn(async () => ({ kind: "snooze" as const, reason: "down" })) };

    const r = await runOutboxDispatchWorker({
      store: db,
      registry: uniqueRegistry([heavy, light]),
      config: { ...config, batchSize: 3, softBudgetMs: 5_000, snoozeScope: "event_type" },
      clock: { now: () => 1_000 },
    });

    // e-1 (heavy) exceeds soft budget -> tail-gated; e-2 (same agg-x) must NOT overtake e-1;
    // e-3 (independent agg-y) runs and snoozes, releasing e-2 (same snoozed type) with snoozeSeconds,
    // while keeping earlier healthy e-1 for delay-0 release and stopping before a second claimBatch.
    expect(heavy.handle).not.toHaveBeenCalled();
    expect(light.handle).toHaveBeenCalledTimes(1);
    expect(db.claimBatch).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ ok: true, snoozed: 1, released: 2, processed: 0, batches: 1 });
    expect(db.releaseUnprocessed).toHaveBeenNthCalledWith(1, [{ eventId: "e-2", claimToken: "synthetic-token" }], 300);
    expect(db.releaseUnprocessed).toHaveBeenNthCalledWith(2, [{ eventId: "e-1", claimToken: "synthetic-token" }], 0);
  });

  it("keeps knownEventTypes undefined across batches when omitted under snoozeScope event_type", async () => {
    const db = store([
      [syntheticOutboxRow({ id: "e-1", aggregate_id: "agg-a", event_type: "example.one" })],
      [syntheticOutboxRow({ id: "e-2", aggregate_id: "agg-b", event_type: "example.two" })],
    ]);
    db.markFailed.mockResolvedValue({ status: "snoozed" } as never);
    const one = { ...processed("example.one"), handle: vi.fn(async () => ({ kind: "snooze" as const, reason: "down" })) };
    const two = processed("example.two");

    const r = await runOutboxDispatchWorker({
      store: db,
      registry: uniqueRegistry([one, two]),
      config: { ...config, batchSize: 1, snoozeScope: "event_type" },
    });
    expect(r).toMatchObject({ ok: true, snoozed: 1, processed: 1, batches: 2 });
    expect(db.claimBatch).toHaveBeenNthCalledWith(2, {
      eventTypes: ["example.two"],
      knownEventTypes: undefined,
      batchSize: 1,
      visibilitySeconds: 300,
      maxAttempts: 8,
    });
  });

});
