import { describe, expect, it, vi } from "vitest";
import { runOutboxDispatchWorker, uniqueRegistry, readOutboxDispatchConfig, withPayloadSchema, OutboxHandlerExecutionTrace, type OutboxHandler, type OutboxStore } from "../src/index.js";
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

});
