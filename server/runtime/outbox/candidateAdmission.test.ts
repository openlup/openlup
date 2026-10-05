import { expect, it, vi } from "vitest";
import type { OutboxHandler } from "@openlup/outbox";
import { syntheticOutboxRow } from "@openlup/outbox/testing";
import type { RequiredSchema } from "@openlup/core/readiness";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { admitReferenceOutbox, observeReferencePackages } from "./candidateAdmission.js";
import { createReferenceOutbox } from "./referenceContribution.js";
import { startPublicReferenceServer } from "../public-reference/serve.js";
function fixture(override?: OutboxHandler) {
  const query=vi.fn(async()=>({rows:[]}));const lease={claimJobRun:vi.fn(async()=>({acquired:true,runId:"run",reason:"acquired"})),finishJobRun:vi.fn(async()=>true)};
  const handler=override??{eventType:"example.created",timeoutMs:100,handle:vi.fn(async()=>({kind:"processed" as const}))};
  const runtime=createReferenceOutbox({executor:{query} as never,lease,handlers:[handler],knownEventTypes:["example.created"],config:{batchSize:25,maxAttempts:8,visibilitySeconds:300,backoffBaseSeconds:60,backoffCapSeconds:3600,snoozeSeconds:300,maxSnoozes:48,softBudgetMs:40000}});
  let candidate={artifact:"one",configuration:"one",environment:"test",database:"test-db",schema:"one"};
  const observed=observeReferencePackages();
  return {query,lease,handler,runtime,setIdentity:(key:string)=>{candidate={...candidate,configuration:key};},input:{runtime,candidate,currentIdentity:()=>candidate,...observed,vocabulary:[{eventType:"example.created",owner:"application"}],exemptions:[],schemaProbe:{observe:async(req: RequiredSchema)=>({database:"test-db",version:req.version,objects:req.objects.map(object=>({object,present:true}))})}}};
}
it("refuses each absent binding before listener, lease, builder or effects",async()=>{
  const f=fixture();for(const key of Object.keys(f.runtime.ports)){
    const ports: Record<string, unknown>={...f.runtime.ports};delete ports[key];const candidate=await admitReferenceOutbox({...f.input,ports});expect(candidate.admitted).toBe(false);
    await expect(startPublicReferenceServer({outbox:candidate})).rejects.toThrow("refused before listener");
  }
  for(const key of Object.keys(f.runtime.triggers)){const triggers={...f.runtime.triggers};delete triggers[key];expect((await admitReferenceOutbox({...f.input,triggers})).admitted).toBe(false);}
  for(const selected of f.input.loadedPackages){
    const loadedPackages=f.input.loadedPackages.map(pkg=>pkg===selected?{...pkg,version:"0.0.0"}:pkg);
    expect((await admitReferenceOutbox({...f.input,loadedPackages})).admitted).toBe(false);
  }
  expect(f.query).not.toHaveBeenCalled();expect(f.lease.claimJobRun).not.toHaveBeenCalled();expect(f.handler.handle).not.toHaveBeenCalled();
});
it("checks once at admission, binds selected schedules before listen and invalidates changed identity",async()=>{
  const f=fixture(),observe=vi.fn(f.input.schemaProbe.observe);const admitted=await admitReferenceOutbox({...f.input,schemaProbe:{observe}});expect(admitted.admitted).toBe(true);
  if(!admitted.admitted)throw new Error("expected admission");const order:string[]=[];
  await admitted.start({listen:async()=>{order.push("listen");},bind:(id)=>{order.push(id);}});
  await admitted.immediate();await admitted.immediate();expect(observe).toHaveBeenCalledTimes(1);expect(order).toEqual(["outbox-dispatch","outbox-prune","listen"]);
  f.setIdentity("changed");expect(()=>admitted.immediate()).toThrow("stale");expect(()=>admitted.run("outbox-dispatch",{triggerKind:"scheduler",invocationSource:"synthetic"})).toThrow("stale");
});
it("a refused next candidate leaves the admitted serving fixture working",async()=>{
  const f=fixture(),serving=await admitReferenceOutbox(f.input);expect(serving.admitted).toBe(true);
  expect((await admitReferenceOutbox({...f.input,inventoryComplete:false})).admitted).toBe(false);
  if(serving.admitted)await serving.immediate();expect(f.query).toHaveBeenCalledTimes(1);
});

it("starts the actual Node listener only after admitted schedules are bound",async()=>{
  const f=fixture(),outbox=await admitReferenceOutbox(f.input);const root=mkdtempSync(join(tmpdir(),"outbox-reference-start-"));
  mkdirSync(join(root,"config"));mkdirSync(join(root,"dist"));writeFileSync(join(root,"config/site-routes.json"),readFileSync("config/public-reference-site-routes.json"));
  const bindings:string[]=[];
  try {
    const server=await startPublicReferenceServer({root,outbox,port:0,host:"127.0.0.1",env:{},bindSchedule:(id)=>{bindings.push(id);}});
    try {expect(bindings).toEqual(["outbox-dispatch","outbox-prune"]);expect(server.listening).toBe(true);expect(f.query).not.toHaveBeenCalled();}
    finally {await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}
  } finally {rmSync(root,{recursive:true,force:true});}
});

it("present but disconnected trigger/port observations cannot admit another execution path",async()=>{
  const f=fixture(),wrong=vi.fn(async()=>"wrong");
  const triggers=Object.fromEntries(Object.keys(f.runtime.triggers).map(k=>[k,wrong]));
  const ports=Object.fromEntries(Object.keys(f.runtime.ports).map(k=>[k,{}]));
  expect((await admitReferenceOutbox({...f.input,triggers})).admitted).toBe(false);
  expect((await admitReferenceOutbox({...f.input,ports})).admitted).toBe(false);
  expect(f.lease.claimJobRun).not.toHaveBeenCalled();expect(wrong).not.toHaveBeenCalled();expect(f.query).not.toHaveBeenCalled();
});
it("reference composition preserves class prototype methods and private receivers",async()=>{
  class Handler {eventType="example.created";timeoutMs=100;#count=0;get count(){return this.#count;}async handle(){this.#count++;return {kind:"processed" as const};}}
  const handler=new Handler(),f=fixture(handler);f.query.mockResolvedValueOnce({rows:[syntheticOutboxRow()]} as never).mockResolvedValueOnce({rows:[{value:true}]} as never);
  const admitted=await admitReferenceOutbox(f.input);expect(admitted.admitted).toBe(true);if(!admitted.admitted)throw new Error("expected admission");
  expect(await admitted.immediate()).toMatchObject({processed:1,retried:0});expect(handler.count).toBe(1);
});
