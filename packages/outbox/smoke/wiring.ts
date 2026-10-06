// Compiled npm-only proof example. The host injects its own committed-operation driver.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { buildOutboxEnqueue, runOutboxDispatchWorker, uniqueRegistry } from "@openlup/outbox";
import { createPostgresOutboxStore, createPostgresOutboxCompactor, POSTGRES_OUTBOX_SCHEMA } from "@openlup/outbox/postgres";
import { assertOutboxStoreFences } from "@openlup/outbox/testing";
import { createSchemaProbe, schemaObjectKey } from "@openlup/core/readiness";
import { createReferenceOutbox } from "./referenceContribution.js";
import { admitReferenceOutbox } from "./candidateAdmission.js";
import { proveSchemaReadiness } from "./schemaProof.mjs";
export async function prove(pool, observer) {
  await proveSchemaReadiness(); // Fake queued work is settled and real timers restored before SQL.
  const require = createRequire(import.meta.url);
  const outboxRoot = dirname(dirname(require.resolve("@openlup/outbox")));
  const sql=await readFile(join(outboxRoot,"sql/0001_outbox.sql"),"utf8");
  const sqlManifest=JSON.parse(await readFile(join(outboxRoot,"sql/manifest.json"),"utf8"));
  const sqlHash=createHash("sha256").update(sql).digest("hex");
  assert.equal(sqlHash,sqlManifest.migrations[0].sha256);
  await pool.query(sql);
  await pool.query("create table public.synthetic_migration_ledger (version text not null, hash text not null)");
  await pool.query("insert into public.synthetic_migration_ledger values ($1,$2)",[sqlManifest.version,sqlHash]);
  const applied=async()=>{const r=(await pool.query("select current_database() as database, version, hash from public.synthetic_migration_ledger")).rows[0];assert.equal(r.hash,sqlHash);return r;};
  await pool.query("create table public.synthetic_producer (id uuid primary key)");
  const aggregate="00000000-0000-4000-8000-000000000001";
  const enqueue=async(client,key,type="example.created",aggregateId=aggregate)=>{
    const q=buildOutboxEnqueue({aggregateType:"example",aggregateId,eventType:type,idempotencyKey:key,payload:{example:key}});
    return client.query(q.text,q.values);
  };
  // Producer writes and enqueue commit together; no independent event commit.
  const producer=await pool.connect();
  try {
    await producer.query("begin"); await producer.query("insert into public.synthetic_producer values ($1)",[aggregate]);
    await enqueue(producer,"committed");
    assert.equal((await observer.query("select count(*)::integer n from public.outbox_events")).rows[0].n,0);
    await producer.query("commit");
    await producer.query("begin"); await producer.query("insert into public.synthetic_producer values ($1)",["00000000-0000-4000-8000-000000000002"]); await enqueue(producer,"rolled-back"); await producer.query("rollback");
  } finally { producer.release(); }
  assert.equal((await observer.query("select count(*)::integer n from public.synthetic_producer")).rows[0].n,1);
  await enqueue(pool,"committed");
  assert.equal((await observer.query("select count(*)::integer n from public.outbox_events")).rows[0].n,1);
  const store=createPostgresOutboxStore(pool);
  const claim={eventTypes:["example.created"],knownEventTypes:["example.created","example.disabled"],batchSize:25,visibilitySeconds:300,maxAttempts:8};
  let rows=await store.claimBatch(claim); assert.equal(rows.length,1);
  const row=rows[0];assert.match(row.created_at,/\.\d{6}Z$/);
  // A second connection sees committed claim and attempt before effects; fences reject stale callers.
  assert.equal((await observer.query("select status,attempts from public.outbox_events where id=$1",[row.id])).rows[0].status,"processing");
  await assertOutboxStoreFences(store,row);
  assert.equal(await store.releaseUnprocessed([{eventId:row.id,claimToken:row.metadata.claimToken}],0),1);
  assert.equal((await observer.query("select attempts from public.outbox_events where id=$1",[row.id])).rows[0].attempts,0);
  // Competing claims are disjoint. Keep aggregates independent so ordering does not mask concurrency.
  await enqueue(pool,"other","example.created","00000000-0000-4000-8000-000000000003");
  const claims=await Promise.all([store.claimBatch({...claim,batchSize:1}),createPostgresOutboxStore(observer).claimBatch({...claim,batchSize:1})]);
  assert.equal(claims.flat().length,2);assert.equal(new Set(claims.flat().map(r=>r.id)).size,2);
  for(const r of claims.flat())await store.markProcessed({eventId:r.id,claimToken:r.metadata.claimToken});
  // Unknown predecessors block; known-disabled and exact dormant identities may be bypassed.
  for(const [index,type] of [[4,"example.unknown"],[5,"example.disabled"],[6,"example.dormant"]]){
    const id=`00000000-0000-4000-8000-${String(index).padStart(12,"0")}`;
    await enqueue(pool,`prior-${index}`,type,id);await enqueue(pool,`next-${index}`,"example.created",id);
  }
  await pool.query("insert into public.outbox_dormant_event_types (event_type,owner,reason) values ('example.dormant','example','synthetic retirement')");
  rows=await store.claimBatch(claim);assert.equal(rows.length,2);
  for(const r of rows)await store.markProcessed({eventId:r.id,claimToken:r.metadata.claimToken});
  const effects=[];
  const replay={eventId:null,token:null,attempts:[],ackLost:false};
  const handler={eventType:"example.effect",timeoutMs:100,async handle(r){
    const observed=(await observer.query("select status,attempts,metadata from public.outbox_events where id=$1",[r.id])).rows[0];
    assert.equal(observed.status,"processing");assert.equal(observed.metadata.claimToken,r.metadata.claimToken);assert.equal(observed.attempts,r.attempts);
    if(r.id===replay.eventId){
      replay.attempts.push(r.attempts);
      if(!replay.token)replay.token=r.metadata.claimToken;
      else {
        assert.notEqual(r.metadata.claimToken,replay.token);
        const current=async()=>(await observer.query("select * from public.outbox_events where id=$1",[r.id])).rows[0];
        const before=await current();
        assert.equal((await store.markProcessed({eventId:r.id,claimToken:replay.token,metadata:{stale:true}})).applied,false);
        assert.deepEqual(await current(),before);
        assert.equal((await store.markFailed({eventId:r.id,claimToken:replay.token,error:"stale",outcome:"retry",baseDelaySeconds:5,maxDelaySeconds:10,maxAttempts:8,snoozeSeconds:60})).status,"missed");
        assert.deepEqual(await current(),before);
        assert.equal(await store.releaseUnprocessed([{eventId:r.id,claimToken:replay.token}],0),0);
        assert.deepEqual(await current(),before);
      }
      await pool.query("insert into public.synthetic_dedupe_effect (event_id) values ($1) on conflict (event_id) do nothing",[r.id]);
    } else effects.push(r.id);
    return {kind:"processed",detail:{captured:true}};
  }};
  const config={batchSize:25,maxAttempts:8,visibilitySeconds:300,backoffBaseSeconds:60,backoffCapSeconds:3600,snoozeSeconds:300,maxSnoozes:48,softBudgetMs:40000};
  const lease={async claimJobRun(){return {acquired:true,runId:"synthetic-run",reason:"acquired"};},async finishJobRun(){return true;}};
  const executor={query:(text,values)=>{
    if(replay.eventId && values?.[0]===replay.eventId && text.startsWith("select public.outbox_mark_processed") && !replay.ackLost){
      replay.ackLost=true;throw new Error("synthetic_ack_lost_after_effect");
    }
    return pool.query(text,values);
  }};
  const runtime=createReferenceOutbox({executor,lease,handlers:[handler],knownEventTypes:["example.effect"],config});
  const migration=await applied();
  let coreRoot=dirname(require.resolve("@openlup/core/readiness"));while(!existsSync(join(coreRoot,"package.json")))coreRoot=dirname(coreRoot);
  const tree=(directory,base=directory)=>readdirSync(directory,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name)).flatMap(e=>e.isDirectory()?tree(join(directory,e.name),base): [{path:join(directory,e.name).slice(base.length+1),hash:createHash("sha256").update(readFileSync(join(directory,e.name))).digest("hex")}]);
  const artifact=()=>createHash("sha256").update(JSON.stringify({core:tree(coreRoot),outbox:tree(outboxRoot),reference:["referenceContribution.js","candidateAdmission.js"].map(p=>createHash("sha256").update(readFileSync(new URL(p,import.meta.url))).digest("hex"))})).digest("hex");
  const configuration=()=>createHash("sha256").update(JSON.stringify({config,knownEventTypes:["example.effect"],descriptors:[{eventType:handler.eventType,timeoutMs:handler.timeoutMs}],manifest:runtime.contribution.manifest})).digest("hex");
  const currentIdentity=()=>({artifact:artifact(),configuration:configuration(),environment:"disposable",database:migration.database,schema:migration.hash});
  const identity=currentIdentity();

  const schemaProbe=createSchemaProbe(pool,applied);
  const base={runtime,candidate:identity,currentIdentity,schemaProbe,vocabulary:[{eventType:"example.effect",owner:"application"}],exemptions:[]};
  await enqueue(pool,"packed-effect","example.effect","00000000-0000-4000-8000-000000000007");
  const admitted=await admitReferenceOutbox(base);assert.equal(admitted.admitted,true);
  const hostCalls=[];await admitted.start({listen:async()=>{hostCalls.push("listen");},bind:(id,cadence,run)=>hostCalls.push(id)});
  assert.deepEqual(hostCalls,["outbox-dispatch","outbox-prune","listen"]);
  await admitted.immediate();assert.equal(effects.length,1);
  const final=(await observer.query("select status,metadata from public.outbox_events where id=$1",[effects[0]])).rows[0];assert.equal(final.status,"processed");assert.equal(final.metadata.captured,true);
  await enqueue(pool,"scheduled-effect","example.effect","00000000-0000-4000-8000-000000000008");await admitted.run("outbox-dispatch",{triggerKind:"scheduler",invocationSource:"synthetic"});assert.equal(effects.length,2);
  // One accepted synthetic durable effect survives lost ack and immediate -> scheduled replay.
  await pool.query("create table public.synthetic_dedupe_effect (event_id uuid primary key)");
  replay.eventId=(await enqueue(pool,"accepted-ack-lost","example.effect","00000000-0000-4000-8000-000000000011")).rows[0].id;
  await assert.rejects(admitted.immediate(),/synthetic_ack_lost_after_effect/);
  const interrupted=(await observer.query("select status,attempts,metadata from public.outbox_events where id=$1",[replay.eventId])).rows[0];
  assert.equal(interrupted.status,"processing");assert.equal(interrupted.attempts,1);assert.equal(interrupted.metadata.claimToken,replay.token);
  assert.equal((await observer.query("select count(*)::integer n from public.synthetic_dedupe_effect where event_id=$1",[replay.eventId])).rows[0].n,1);
  await pool.query("update public.outbox_events set available_at=now()-interval '1 second' where id=$1",[replay.eventId]);
  await admitted.run("outbox-dispatch",{triggerKind:"scheduler",invocationSource:"synthetic-replay"});
  const settled=(await observer.query("select status,attempts,metadata from public.outbox_events where id=$1",[replay.eventId])).rows[0];
  assert.equal(settled.status,"processed");assert.equal(settled.attempts,2);assert.notEqual(settled.metadata.claimToken,replay.token);
  assert.deepEqual(replay.attempts,[1,2]);
  assert.equal((await observer.query("select count(*)::integer n from public.synthetic_dedupe_effect where event_id=$1",[replay.eventId])).rows[0].n,1);
  // Each missing selected binding refuses before listener, lease, immediate or effect work.
  for(const key of Object.keys(runtime.ports)){
    const ports={...runtime.ports};delete ports[key];assert.equal((await admitReferenceOutbox({...base,ports})).admitted,false);
  }
  for(const key of Object.keys(runtime.triggers)){
    const triggers={...runtime.triggers};delete triggers[key];assert.equal((await admitReferenceOutbox({...base,triggers})).admitted,false);
  }
  const completeObservation=await schemaProbe.observe(POSTGRES_OUTBOX_SCHEMA);
  assert.ok(completeObservation.objects.every(item=>item.present===true));
  for(const object of POSTGRES_OUTBOX_SCHEMA.objects){
    const observation={...completeObservation,objects:completeObservation.objects.map(v=>schemaObjectKey(v.object)===schemaObjectKey(object)?{...v,present:false}:v)};
    assert.equal((await admitReferenceOutbox({...base,schemaProbe:{observe:async()=>observation}})).admitted,false);
  }
  // Real negative catalog results use the same database, without deleting any Outbox object.
  for(const object of [{kind:"table",name:"public.synthetic_missing_table"},{kind:"column",name:"public.outbox_events.synthetic_missing_column"},{kind:"function",name:"public.outbox_mark_processed",signature:"uuid,text,jsonb,boolean"}]){
    const requiredSchema={...POSTGRES_OUTBOX_SCHEMA,objects:[object]};
    const negativeRuntime={...runtime,contribution:{...runtime.contribution,manifest:{...runtime.contribution.manifest,requiredSchema}}};
    const refused=await admitReferenceOutbox({...base,runtime:negativeRuntime});
    assert.equal(refused.admitted,false);assert.equal(refused.report.state,"unsatisfied");
    assert.ok(refused.report.issues.some(issue=>issue.subject===schemaObjectKey(object)&&issue.observation==="object_absent"));
  }
  assert.equal((await admitReferenceOutbox({...base,schemaProbe:{observe:async()=>{throw new Error("unavailable");}}})).admitted,false);
  config.softBudgetMs--;assert.throws(()=>admitted.immediate(),/stale/);config.softBudgetMs++;
  const enginePath=join(outboxRoot,"dist/worker.js"),engineBytes=readFileSync(enginePath);
  try {writeFileSync(enginePath,Buffer.concat([engineBytes,Buffer.from("\n// synthetic changed candidate bytes\n")]));assert.throws(()=>admitted.immediate(),/stale/);}
  finally {writeFileSync(enginePath,engineBytes);}
  // A refused next candidate does not revoke the serving instance.
  assert.equal((await admitReferenceOutbox({...base,loadedPackages:[],inventoryComplete:false})).admitted,false);await admitted.immediate();
  const retryRow=(await enqueue(pool,"retry","example.effect","00000000-0000-4000-8000-000000000009")).rows[0];
  rows=await store.claimBatch({...claim,eventTypes:["example.effect"]});const retry=rows.find(r=>r.id===retryRow.id);
  const failure={eventId:retry.id,claimToken:retry.metadata.claimToken,error:"synthetic",baseDelaySeconds:5,maxDelaySeconds:10,maxAttempts:8,snoozeSeconds:60};
  assert.equal((await store.markFailed({...failure,outcome:"retry"})).status,"failed");
  let failed=(await observer.query("select attempts,status from public.outbox_events where id=$1",[retry.id])).rows[0];assert.equal(failed.status,"failed");assert.equal(failed.attempts,1);
  await pool.query("update public.outbox_events set available_at=now() where id=$1",[retry.id]);rows=await store.claimBatch({...claim,eventTypes:["example.effect"]});const snooze=rows[0];
  assert.equal((await store.markFailed({...failure,claimToken:snooze.metadata.claimToken,outcome:"snooze"})).status,"snoozed");
  failed=(await observer.query("select attempts,metadata from public.outbox_events where id=$1",[retry.id])).rows[0];assert.equal(failed.attempts,1);assert.equal(failed.metadata.snoozeCount,1);
  // Crash/failed handler leaves committed attempts; no encompassing producer transaction can roll them back.
  await pool.query("update public.outbox_events set available_at=now() where id=$1",[retry.id]);
  await runOutboxDispatchWorker({store,registry:uniqueRegistry([{...handler,handle:async()=>{throw new Error("crash");}}]),config});
  assert.equal((await observer.query("select attempts from public.outbox_events where id=$1",[retry.id])).rows[0].attempts,2);
  // Terminal compaction preserves all row and dedupe identities; invalid discard ages are ineligible.
  await pool.query("update public.outbox_events set processed_at=now()-interval '31 days',payload='{\"synthetic\":true}',error='old' where status='processed'");
  await enqueue(pool,"bad-age","example.discarded","00000000-0000-4000-8000-000000000010");
  await pool.query("update public.outbox_events set status='discarded',metadata='{\"discardedAt\":\"not-a-timestamp\"}' where idempotency_key='bad-age'");
  const before=(await observer.query("select count(*)::integer n from public.outbox_events")).rows[0].n;
  const compacted=await createPostgresOutboxCompactor(pool).compact({processedDays:30,discardedDays:90,limit:500});assert.ok(compacted>=4);
  assert.equal((await observer.query("select count(*)::integer n from public.outbox_events")).rows[0].n,before);
  const retained=(await observer.query("select payload,error,metadata from public.outbox_events where idempotency_key='committed'")).rows[0];assert.deepEqual(retained.payload,{});assert.equal(retained.error,null);assert.equal(retained.metadata.retentionCompactedStatus,"processed");
  assert.notDeepEqual((await observer.query("select payload from public.outbox_events where idempotency_key='bad-age'")).rows[0].payload,{});
  await enqueue(pool,"committed");assert.equal((await observer.query("select count(*)::integer n from public.outbox_events")).rows[0].n,before);
  assert.equal(await createPostgresOutboxCompactor(pool).compact({processedDays:30,discardedDays:90,limit:500}),0);
  console.log("PASS producer/rollback/dedupe, committed claim/ack/failure/refund, concurrent claims, ordering exceptions, packed scheduled/immediate reference, binding/schema refusal, accepted-effect replay/new-token fencing, retained terminal identities");
}
