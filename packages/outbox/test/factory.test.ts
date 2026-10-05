import { describe, expect, it, vi } from "vitest";
import { createOutbox, uniqueRegistry, withPayloadSchema, type OutboxFactoryOptions, type OutboxFactoryPorts } from "../src/index.js";
import { POSTGRES_OUTBOX_SCHEMA } from "../src/postgres.js";
import { syntheticOutboxRow } from "../src/testing.js";
function fixture() {
  const calls:string[]=[];
  const ports:OutboxFactoryPorts={store:{claimBatch:async()=>{calls.push("claim");return [];},markProcessed:async()=>({applied:true}),markFailed:async()=>({status:"failed"}),releaseUnprocessed:async()=>0},descriptors:[{eventType:"example.created",timeoutMs:100}],
    lease:{claimJobRun:async()=>{calls.push("lease");return {acquired:true,runId:"run-1",reason:"acquired"};},finishJobRun:async(_,run,inv,status,result,metadata)=>{calls.push("finish");expect(metadata?.runId).toBe(run);expect(metadata?.checked).toBe(result.checked);return true;}},
    beforeDispatch:async()=>{calls.push("before");return {ok:false,error:"nonfatal",runId:"wrong",checked:99};},
    buildHandlers:async()=>{calls.push("build");return {handlers:uniqueRegistry([{eventType:"example.created",timeoutMs:100,handle:async()=>({kind:"processed"})}]),close:()=>{calls.push("close");}};},logger:{warn:vi.fn(),error:vi.fn()}};
  const options:OutboxFactoryOptions & {prune?: {enabled:false;cadenceSeconds:number}}={config:{batchSize:25,maxAttempts:8,visibilitySeconds:300,backoffBaseSeconds:60,backoffCapSeconds:3600,snoozeSeconds:300,maxSnoozes:48,softBudgetMs:40000},knownEventTypes:["example.created"],hostLimitSeconds:60,leaseSeconds:60,cadenceSeconds:60,requiredSchema:POSTGRES_OUTBOX_SCHEMA};
  return {ports,options,calls};
}
const invocation={triggerKind:"scheduler" as const,invocationSource:"synthetic"};
const execute=(ports:OutboxFactoryPorts,options:ReturnType<typeof fixture>["options"])=>createOutbox(ports,options).schedules[0].run(invocation as never) as Promise<{outcome:string;finishApplied?:boolean}>;
describe("lease-bound rail",()=>{
  it("builds after lease, preserves nonfatal observations, finishes then closes",async()=>{const {ports,options,calls}=fixture();expect((await execute(ports,options)).outcome).toBe("success");expect(calls).toEqual(["lease","before","build","claim","finish","close"]);});
  it.each(["job_disabled","lease_held"])("does not build for %s",async(reason)=>{const {ports,options,calls}=fixture();ports.lease.claimJobRun=async()=>({acquired:false,runId:null,reason});expect((await execute(ports,options)).outcome).toBe(reason==="job_disabled"?"disabled":"skipped");expect(calls).toEqual([]);});
  it.each(["hook","builder","events","timeout","store"])("finishes once on %s failure and closes every returned scope",async(mode)=>{const {ports,options,calls}=fixture();
    if(mode==="hook")ports.beforeDispatch=async()=>{throw new Error("hook");};
    if(mode==="builder")ports.buildHandlers=async()=>{calls.push("partial-close");throw new Error("builder");};
    if(mode==="events"||mode==="timeout")ports.buildHandlers=()=>({handlers:uniqueRegistry([{eventType:mode==="events"?"different":"example.created",timeoutMs:mode==="timeout"?101:100,handle:async()=>({kind:"processed"})}]),close:()=>{calls.push("close");}});
    if(mode==="store")ports.store.claimBatch=async()=>{throw new Error("store");};
    expect((await execute(ports,options)).outcome).toBe("failed");expect(calls.filter(c=>c==="finish")).toHaveLength(1);
    expect(calls.filter(c=>c==="claim")).toHaveLength(0);if(["events","timeout","store"].includes(mode))expect(calls.at(-1)).toBe("close");
  });
  it("closes after a finish throw and does not attempt finish twice",async()=>{const {ports,options,calls}=fixture();ports.lease.finishJobRun=async()=>{calls.push("finish");throw new Error("finish");};await expect(execute(ports,options)).rejects.toThrow("finish");expect(calls.slice(-2)).toEqual(["finish","close"]);});
  it("exposes failed finish persistence and isolates cleanup errors",async()=>{const {ports,options}=fixture();ports.lease.finishJobRun=async()=>false;ports.buildHandlers=()=>({handlers:uniqueRegistry([{eventType:"example.created",timeoutMs:100,handle:async()=>({kind:"processed"})}]),close:()=>{throw new Error("close");}});expect(await execute(ports,options)).toMatchObject({outcome:"failed",finishApplied:false});expect(ports.logger!.error).toHaveBeenCalledWith("[outbox-dispatch] handler_scope_close_failed","close");});
  it("rejects impossible scheduled options without leasing or building",()=>{const {ports,options,calls}=fixture();expect(()=>createOutbox(ports,{...options,hostLimitSeconds:NaN})).toThrow("hostLimitSeconds");expect(()=>createOutbox({...ports,descriptors:[{eventType:"example.created",timeoutMs:39000}]},options)).toThrow("handler.timeoutMs");expect(()=>createOutbox(ports,{...options,config:{...options.config,visibilitySeconds:299}})).toThrow("visibilitySeconds");expect(calls).toEqual([]);});
  it("owns a selected prune schedule with explicit retention ports and defaults",async()=>{const {ports,options}=fixture(),compact=vi.fn(async()=>2);const contribution=createOutbox({...ports,compactor:{compact}},{...options,prune:{enabled:true,cadenceSeconds:86400}});expect(contribution.manifest.requiredPorts).toContain("compactor");await contribution.schedules[1].run(invocation as never);expect(compact).toHaveBeenCalledWith({processedDays:30,discardedDays:90,limit:500});});
  it("a throwing logger cannot skip the failed finish or returned-scope cleanup",async()=>{
    const {ports,options,calls}=fixture();ports.logger={warn:()=>{throw new Error("logger");},error:()=>{throw new Error("logger");}};
    ports.store.claimBatch=async()=>{throw new Error("store");};
    expect((await execute(ports,options)).outcome).toBe("failed");expect(calls.slice(-2)).toEqual(["finish","close"]);
  });

  it("refuses a lease that expires inside the host window, without a renewal mechanism",()=>{
    const {ports,options,calls}=fixture();
    expect(()=>createOutbox(ports,{...options,leaseSeconds:1,cadenceSeconds:1})).toThrow("leaseSeconds");
    expect(()=>createOutbox(ports,{...options,hostLimitSeconds:180,leaseSeconds:60,config:{...options.config,softBudgetMs:165000,visibilitySeconds:900}})).toThrow("leaseSeconds");
    expect(calls).toEqual([]);
  });

  it("retains structural getter descriptors through typed validation and scheduled composition",async()=>{
    const {ports,options,calls}=fixture();
    class Handler {
      #processed=0;
      get eventType(){return "example.created";}
      get timeoutMs(){return 100;}
      async handle(){this.#processed++;return {kind:"processed" as const};}
      get processed(){return this.#processed;}
    }
    const original=new Handler();
    const typed=withPayloadSchema(original,{"~standard":{version:1,vendor:"synthetic",validate:(value)=>({value:value as Record<string,unknown>})}});
    const registry=uniqueRegistry([typed]);
    expect([...registry.keys()]).toEqual([original.eventType]);expect(typed.timeoutMs).toBe(original.timeoutMs);
    let claimed=false;
    ports.descriptors=[original];ports.buildHandlers=()=>registry;
    ports.store.claimBatch=async({eventTypes})=>{calls.push("claim");expect(eventTypes).toEqual([original.eventType]);if(claimed)return [];claimed=true;return [syntheticOutboxRow({event_type:original.eventType})];};
    expect((await execute(ports,options)).outcome).toBe("success");
    expect(original.processed).toBe(1);expect(calls[0]).toBe("lease");expect(calls.at(-1)).toBe("finish");
  });

});
