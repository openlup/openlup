/** B3: complete canonical fresh/69-upgrade, with real durable effects and refusal plants. */
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { CommunicationConflictError, createPostgresDeliveryReconciliationPort, createPostgresCommunicationSyncStore, createPostgresNotificationRecipientsPort, createPostgresConsentEvaluator, nativeSyncEventType } from "@openlup/platform/communications";
import { createPostgresOutboxStore } from "@openlup/outbox/postgres";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
import { createCommunicationsLifecycleBinding } from "../../server/runtime/communications/communicationsLifecycleBinding.js";
import { dockerAvailable, runPostgresContainer, waitForPostgresTcpReady, type PostgresContainer } from "../helpers/postgresContainer.js";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const A="b3000000-0000-4000-8000-000000000001", C="b3000000-0000-4000-8000-000000000002", S="b3000000-0000-4000-8000-000000000003";
const email="recipient@example.invalid", at="2026-10-19T10:00:00.000Z", now="2026-10-19T12:00:00.000Z";
const containers: PostgresContainer[]=[], pools: Pool[]=[], stores: { close(): Promise<void> }[]=[];
let fresh: Pool, upgrade: Pool, prefix: string;
const nativeFile="db/platform/migrations/20261019200000_communications_native_operations.sql";
const env=(index=0)=>({connectionString:containers[index].connectionString});
const runner=(pool: Pool,root=process.cwd())=>createPostgresMigrationRunner({connectionString:"injected"},{root,poolFactory:()=>pool});
const keep=<T extends {close():Promise<void>}>(store:T):T=>{stores.push(store);return store;};
const delivery=(binding="synthetic",index=0)=>keep(createPostgresDeliveryReconciliationPort(env(index),{binding}));
const sync=(binding="synthetic",index=0)=>keep(createPostgresCommunicationSyncStore(env(index),{binding,providerKind:"synthetic",rail:db=>createPostgresOutboxStore(db)}));
const directory=(operatorId=A,index=0)=>keep(createPostgresNotificationRecipientsPort(env(index),{operatorId}));
const consent=(index=0)=>keep(createPostgresConsentEvaluator(env(index)));
const target=(key:string)=>({sourceKey:key,messageId:`network:${key}`,recipientEmail:email,templateReference:"synthetic",acceptedAt:at,evidence:"network_accepted" as const});
const work=(key:string)=>({sourceKey:key,contactId:key,normalizedEmail:email,eventType:"subscribe" as const,purpose:"marketing_newsletter" as const});
const provider={providerKind:"synthetic",capabilities:{subscribe:true,unsubscribe:true,suppress:true,unsuppress:false,doubleOptIn:false,emailChange:false,listMembership:false,webhookIdempotency:false,retryAfter:false},sync:async()=>({status:"sent" as const})};
const snapshot=async(pool:Pool)=>{
 const result:Record<string,unknown>={};
 for(const table of ["clients","subscriptions","subscription_events","platform_human_principals","platform_human_memberships","transactional_delivery_receipts"])
   result[table]=(await pool.query(`SELECT to_jsonb(t) AS row FROM public.${table} t ORDER BY to_jsonb(t)::text`)).rows;
 return result;
};
let before:Record<string,unknown>;
beforeAll(async()=>{
 if(!await dockerAvailable())throw new Error("B3 requires real PostgreSQL");
 const current=JSON.parse(readFileSync("config/platform-migration-manifest.json","utf8"));
 expect(current.forward.at(-1).file).toBe(nativeFile);expect(current.forward).toHaveLength(70);
 prefix=mkdtempSync(join(tmpdir(),"b3-prefix-"));
 const previous={...current,forward:current.forward.slice(0,-1),objectInventorySha256:"f04ba91040e109ca7c79ddd73d6f31008dc735c93cedd1d536a2c006971bac65"};
 for(const entry of [previous.baseline,...previous.forward]){const file=join(prefix,entry.file);mkdirSync(dirname(file),{recursive:true});writeFileSync(file,readFileSync(entry.file));}
 mkdirSync(join(prefix,"config"));writeFileSync(join(prefix,"config/platform-migration-manifest.json"),JSON.stringify(previous));
 for(const name of ["fresh","upgrade"]){const container=await runPostgresContainer({name:`communications-native-${name}-${process.pid}`,password:"synthetic-conformance"});containers.push(container);if(!await waitForPostgresTcpReady(container.connectionString))throw new Error("B3 PG unavailable");pools.push(new Pool({connectionString:container.connectionString}));}
 [fresh,upgrade]=pools;
 await runner(upgrade,prefix).apply();
 await upgrade.query("INSERT INTO public.platform_human_principals (principal_id,email) VALUES ($1,'admin@example.invalid')",[A]);
 await upgrade.query("INSERT INTO public.clients(id,email,principal_id) VALUES ($1,$2,$3)",[C,email,A]);
 await upgrade.query("INSERT INTO public.subscriptions(id,client_id,cadence_days,next_cycle_at) VALUES ($1,$2,28,'2026-12-01T00:00:00Z')",[S,C]);
 await upgrade.query("SELECT public.transactional_delivery_record_accepted('synthetic:accepted',$1,'captured:1')",[hash("accepted")]);
 await upgrade.query("SELECT public.transactional_delivery_record_failed('synthetic:failed',$1,'synthetic_failure')",[hash("failed")]);
 await upgrade.query("INSERT INTO public.outbox_events(aggregate_type,aggregate_id,event_type,idempotency_key,payload) VALUES ('synthetic',$1,'synthetic.commerce','preserve','{}')",[C]);
 await upgrade.query("INSERT INTO public.communication_recipient_consents(recipient_fingerprint,purpose,state) VALUES ($1,'marketing_newsletter','denied')",[hash(email)]);
 before=await snapshot(upgrade);
 await runner(fresh).apply();
 await fresh.query("INSERT INTO public.platform_human_principals(principal_id,email) VALUES ($1,'admin@example.invalid')",[A]);
 await fresh.query("INSERT INTO public.platform_human_memberships(principal_id,role,membership_state,membership_provenance,membership_accepted_at) VALUES ($1,'admin','active','legacy',now())",[A]);
 await fresh.query("INSERT INTO public.platform_communication_operators(principal_id) VALUES ($1)",[A]);
 await fresh.query("INSERT INTO public.platform_human_principals(principal_id,email) VALUES ($1,'second-admin@example.invalid')",[C]);
 await fresh.query("INSERT INTO public.platform_human_memberships(principal_id,role,membership_state,membership_provenance,membership_accepted_at) VALUES ($1,'admin','active','legacy',now())",[C]);
},120000);
afterAll(async()=>{await Promise.all(stores.map(s=>s.close()));await Promise.all(pools.map(p=>p.end()));await Promise.all(containers.map(c=>c.remove()));if(prefix)rmSync(prefix,{recursive:true,force:true});});
it("upgrades the real position-69 prefix, preserves representative state and replays without effects",async()=>{
 const queued=(await upgrade.query("SELECT * FROM public.outbox_events")).rows,permissions=(await upgrade.query("SELECT * FROM public.communication_recipient_consents")).rows;
 expect((await runner(upgrade).apply()).applied).toEqual([nativeFile]);
 expect(await snapshot(upgrade)).toEqual(before);
 expect((await upgrade.query("SELECT * FROM public.outbox_events")).rows).toEqual(queued);
 expect((await upgrade.query("SELECT * FROM public.communication_recipient_consents")).rows).toEqual(permissions);
 // The preserved accepted capture receipt is not a registered network target.
 expect(await delivery("synthetic",1).findFrozenSends({now,graceMinutes:0,limit:100})).toEqual([]);
 for(const pool of pools)expect((await runner(pool).apply()).applied).toEqual([]);
 const ledger=(await fresh.query("SELECT catalog_path,sha256,position FROM public.platform_schema_migrations ORDER BY position")).rows;
 const manifest=JSON.parse(readFileSync("config/platform-migration-manifest.json","utf8"));
 expect(ledger).toEqual([manifest.baseline,...manifest.forward].map((entry:{file:string;sha256:string},position:number)=>({catalog_path:entry.file,sha256:entry.sha256,position})));
});
it("refuses ledger tamper and restores the original identity",async()=>{
 const row=(await fresh.query("SELECT * FROM public.platform_schema_migrations WHERE position=70")).rows[0];
 await fresh.query("UPDATE public.platform_schema_migrations SET sha256=$1 WHERE position=70",[hash("tampered")]);
 try{await expect(runner(fresh).apply()).rejects.toThrow();}finally{await fresh.query("UPDATE public.platform_schema_migrations SET sha256=$1 WHERE position=70",[row.sha256]);}
 expect((await runner(fresh).apply()).applied).toEqual([]);
});
it("registers exact network facts, refuses conflicts and capture, and selects bounded scoped candidates",async()=>{
 const port=delivery(),other=delivery("other");
 const one=await port.registerNetworkTarget(target("selection-a"));
 expect(await port.registerNetworkTarget(target("selection-a"))).toEqual(one);
 await expect(port.registerNetworkTarget({...target("selection-a"),messageId:"conflict"})).rejects.toThrow();
 await expect(port.registerNetworkTarget({...target("capture"),evidence:"capture"} as never)).rejects.toThrow();
 await other.registerNetworkTarget(target("selection-foreign"));
 const two=await port.registerNetworkTarget(target("selection-b"));
 const rows=await port.findFrozenSends({now,graceMinutes:10,limit:1});expect(rows).toHaveLength(1);
 await port.recordPollAttempt({sendId:rows[0].id,attemptedAt:now});
 expect((await port.findFrozenSends({now,graceMinutes:10,limit:1}))[0].id).not.toBe(rows[0].id);
 expect((await port.findFrozenSends({now:at,graceMinutes:1,limit:100}))).toEqual([]);
 expect((await port.readEvidence(two.id))?.observedState).toBeNull();
 expect((await other.findFrozenSends({now,graceMinutes:10,limit:100})).map(row=>row.messageId)).toEqual(["network:selection-foreign"]);
});
it("converges poll/callback races, records chronology, rejects conflicting replay and suppresses authoritative fingerprints",async()=>{
 const port=delivery("convergence"),{id}=await port.registerNetworkTarget(target("converge"));
 const observed={sendId:id,messageId:"network:converge",observationKey:"delivered",kind:"delivered" as const,occurredAt:now,recipientEmail:email,source:"callback" as const};
 await Promise.all([port.applyObservation(observed),port.applyObservation({...observed,source:"poll"})]);
 await expect(port.applyObservation({...observed,kind:"failed"})).rejects.toThrow("replay_conflict");
 await port.applyObservation({...observed,observationKey:"precise",occurredAt:"2026-10-19T12:00:00.000001Z"});
 await expect(port.applyObservation({...observed,observationKey:"precise",occurredAt:"2026-10-19T12:00:00.000002Z"})).rejects.toThrow("replay_conflict");
 await expect(port.applyObservation({...observed,observationKey:"wrong-recipient",recipientEmail:"other@example.invalid"})).rejects.toThrow("identity_conflict");
 await port.applyObservation({...observed,observationKey:"old-sent",kind:"sent",occurredAt:at});
 expect(await port.readEvidence(id)).toMatchObject({observedState:"delivered",observations:[{key:"old-sent"},{key:"delivered"},{key:"precise"}]});
 await port.applyObservation({...observed,observationKey:"complaint",kind:"complained"});
 expect((await fresh.query("SELECT state FROM public.communication_recipient_consents WHERE recipient_fingerprint=$1 ORDER BY purpose",[hash(email)])).rows).toEqual([{state:"suppressed"},{state:"suppressed"},{state:"suppressed"}]);
 expect(await port.findFrozenSends({now,graceMinutes:0,limit:10})).toEqual([]);
});
it("rolls all observation effects back if suppression cannot commit",async()=>{
 const port=delivery("rollback"),{id}=await port.registerNetworkTarget(target("rollback"));
 await fresh.query("ALTER TABLE public.communication_recipient_consents ADD CONSTRAINT synthetic_suppression_refusal CHECK (state <> 'suppressed') NOT VALID");
 try{await expect(port.applyObservation({sendId:id,messageId:"network:rollback",observationKey:"blocked",kind:"bounced",occurredAt:now,recipientEmail:email,source:"poll"})).rejects.toThrow();}
 finally{await fresh.query("ALTER TABLE public.communication_recipient_consents DROP CONSTRAINT synthetic_suppression_refusal");}
 expect(await port.readEvidence(id)).toMatchObject({observedState:null,observations:[]});
});
it("rotates attempts and abandons exactly once on three consecutive 404s without inventing delivery",async()=>{
 const port=delivery("missing"),{id}=await port.registerNetworkTarget(target("missing"));
 const missing=()=>port.recordSendNotFound({sendId:id,threshold:3});
 expect(await missing()).toEqual({abandoned:false});await port.recordPollAttempt({sendId:id,attemptedAt:now});
 expect(await missing()).toEqual({abandoned:false});expect(await missing()).toEqual({abandoned:false});
 const outcomes=await Promise.all([missing(),missing()]);expect(outcomes.filter(value=>value.abandoned)).toHaveLength(1);
 expect(await port.readEvidence(id)).toMatchObject({observedState:null,notFoundCount:4});
 expect(await port.findFrozenSends({now,graceMinutes:0,limit:10})).toEqual([]);
});
it("claims concurrently on the sole rail, skips locked work and refuses stale/cross-target tokens",async()=>{
 const store=sync("claims"),foreign=sync("claims-foreign");
 const first=await store.registerWork(work("claim-a"));await store.registerWork(work("claim-b"));await foreign.registerWork(work("claim-foreign"));
 const lock=await fresh.connect();await lock.query("BEGIN");await lock.query("SELECT id FROM public.outbox_events WHERE id=$1 FOR UPDATE",[first.id]);
 const params={providerKind:"synthetic",batchSize:1,visibilitySeconds:60,maxAttempts:3};
 let claimed;try{claimed=await store.claimBatch(params);expect(claimed).toHaveLength(1);expect(claimed[0].id).not.toBe(first.id);}finally{await lock.query("ROLLBACK");lock.release();}
 const [a,b]=await Promise.all([store.claimBatch(params),store.claimBatch(params)]);expect([...a,...b].map(row=>row.id)).toEqual([first.id]);
 const old=[...a,...b][0];
 expect(await store.markSent({eventId:old.id,claimToken:"wrong",providerKind:"synthetic"})).toBe(false);
 expect(await foreign.markSent({eventId:old.id,claimToken:old.claimToken,providerKind:"synthetic"})).toBe(false);
 await fresh.query("UPDATE public.outbox_events SET available_at=now()-interval '1 second' WHERE id=$1",[old.id]);
 const [current]=await store.claimBatch(params);expect(current.claimToken).not.toBe(old.claimToken);
 expect(await store.markSent({eventId:old.id,claimToken:old.claimToken,providerKind:"synthetic"})).toBe(false);
 expect(await store.markSent({eventId:current.id,claimToken:current.claimToken,providerKind:"synthetic",responseSummary:{status:"sent"}})).toBe(true);
 expect(await store.markSent({eventId:current.id,claimToken:current.claimToken,providerKind:"synthetic"})).toBe(false);
 expect((await fresh.query("SELECT status FROM public.outbox_events WHERE id=$1",[current.id])).rows[0].status).toBe("processed");
 expect((await fresh.query("SELECT response_summary FROM public.communication_native_sync_state WHERE work_id=$1",[current.id])).rows[0].response_summary).toEqual({status:"sent"});
 expect((await foreign.claimBatch(params)).map(row=>row.id)).toHaveLength(1);
});
it("retains the existing rail ordering barrier for successive preferences of the same contact",async()=>{
 const store=sync("ordered"),first=await store.registerWork({...work("ordered-a"),contactId:"one-contact"});
 const second=await store.registerWork({...work("ordered-b"),contactId:"one-contact",eventType:"unsubscribe"});
 const params={providerKind:"synthetic",batchSize:100,visibilitySeconds:60,maxAttempts:3};
 const batch=await store.claimBatch(params);expect(batch.map(row=>row.id)).toEqual([first.id]);
 expect(await store.claimBatch(params)).toEqual([]);
 await store.markSent({eventId:first.id,claimToken:batch[0].claimToken,providerKind:"synthetic"});
 expect((await store.claimBatch(params)).map(row=>row.id)).toEqual([second.id]);
});
it("atomically rolls back acknowledgements and enforces bounded retries",async()=>{
 const store=sync("retry"),registered=await store.registerWork(work("retry"));
 const params={providerKind:"synthetic",batchSize:1,visibilitySeconds:60,maxAttempts:2};
 const [first]=await store.claimBatch(params);
 await fresh.query("ALTER TABLE public.communication_native_sync_state ADD CONSTRAINT synthetic_settlement_refusal CHECK (response_summary='{}'::jsonb) NOT VALID");
 try{await expect(store.markSent({eventId:first.id,claimToken:first.claimToken,providerKind:"synthetic",responseSummary:{status:"sent"}})).rejects.toThrow();}
 finally{await fresh.query("ALTER TABLE public.communication_native_sync_state DROP CONSTRAINT synthetic_settlement_refusal");}
 expect((await fresh.query("SELECT status FROM public.outbox_events WHERE id=$1",[first.id])).rows[0].status).toBe("processing");
 expect(await store.markFailed({eventId:first.id,claimToken:first.claimToken,providerKind:"synthetic",error:"synthetic timeout",retry:true,backoffSeconds:5})).toBe(true);
 expect(await store.claimBatch(params)).toEqual([]);
 await fresh.query("UPDATE public.outbox_events SET available_at=now()-interval '1 second' WHERE id=$1",[registered.id]);
 const [second]=await store.claimBatch(params);
 expect(await store.markFailed({eventId:second.id,claimToken:second.claimToken,providerKind:"synthetic",error:"synthetic timeout",retry:true,backoffSeconds:5})).toBe(true);
 expect((await fresh.query("SELECT status,attempts FROM public.outbox_events WHERE id=$1",[registered.id])).rows[0]).toEqual({status:"discarded",attempts:2});
});
it("runs the actual reference engines to durable readback without a second executor or subscription effects",async()=>{
 const effects:string[]=[],binding=createCommunicationsLifecycleBinding({PLATFORM_BUNDLE:"node-postgres",DATABASE_URL:containers[0].connectionString},{binding:"reference",operatorId:A,provider:{...provider,sync:async event=>{effects.push(`membership:${event.id}`);if(event.contactId==="timeout")throw new Error("synthetic membership timeout");return {status:"sent"};}}});
 const state=await snapshot(fresh);
 const send=await binding.registerNetworkTarget(target("reference"));
 const registered=await binding.registerSyncWork(work("reference"));
 expect((await binding.dispatchSync()).sent).toBe(1);expect((await binding.dispatchSync()).checked).toBe(0);
 expect(effects).toEqual([`membership:${registered.id}`]);
 const timedOut=await binding.registerSyncWork(work("timeout"));
 expect(await binding.dispatchSync({maxAttempts:2,backoffSeconds:5})).toMatchObject({sent:0,failures:1});
 expect((await fresh.query("SELECT status FROM public.outbox_events WHERE id=$1",[timedOut.id])).rows[0].status).toBe("failed");
 expect((await binding.readDeliveryEvidence(send.id))?.observedState).toBeNull();
 expect((await binding.reconcileDelivery({readEmail:async()=>({ok:true,httpStatus:200,recipientEmail:email}),observationFor:()=>({eventType:"delivered",terminal:true}),now,graceMinutes:10,limit:10})).reconciled).toBe(1);
 expect((await binding.readDeliveryEvidence(send.id))?.observedState).toBe("delivered");
 expect(await snapshot(fresh)).toEqual(state);
 expect((await fresh.query("SELECT event_type FROM public.outbox_events WHERE id=$1",[registered.id])).rows[0].event_type).toBe(nativeSyncEventType("reference"));
});
it("persists the current directory shape, normalized conflicts, active-only patches and acknowledgement replay",async()=>{
 const port=directory();
 expect(await port.listNotificationRecipients({notification_type:"packaging_digest"})).toEqual({recipients:[]});
 const input={email:" DIRECTORY@example.invalid ",name:"Synthetic",notification_type:"packaging_digest" as const,active:true as const};
 await expect(port.createNotificationRecipient({...input,notification_type:"daily_report"} as never)).rejects.toThrow("type_invalid");
 await expect(port.createNotificationRecipient({...input,email:"invalid"})).rejects.toThrow("email_invalid");
 const results=await Promise.allSettled([port.createNotificationRecipient(input),port.createNotificationRecipient(input)]);
 expect(results.filter(value=>value.status==="fulfilled")).toHaveLength(1);
 expect((results.find(value=>value.status==="rejected") as PromiseRejectedResult).reason).toBeInstanceOf(CommunicationConflictError);
 const [row]=(await port.listNotificationRecipients({notification_type:"packaging_digest"})).recipients;
 expect(row).toMatchObject({email:"directory@example.invalid",active:true,name:"Synthetic"});
 await expect(port.updateNotificationRecipient({recipientId:row.id,active:false,email:"other@example.invalid"} as never)).rejects.toThrow();
 await port.updateNotificationRecipient({recipientId:row.id,active:false});
 expect((await port.listNotificationRecipients({notification_type:"packaging_digest"})).recipients[0].active).toBe(false);
 await port.deleteNotificationRecipient({recipientId:row.id});expect(await port.deleteNotificationRecipient({recipientId:row.id})).toEqual({deleted:true,recipientId:row.id});
});
it("refuses inactive, customer, machine and absent operator authority in the actual transaction",async()=>{
 const port=directory();await fresh.query("UPDATE public.platform_communication_operators SET active=false WHERE principal_id=$1",[A]);
 try{await expect(port.listNotificationRecipients({notification_type:"new_signup"})).rejects.toThrow("operator_required");}finally{await fresh.query("UPDATE public.platform_communication_operators SET active=true WHERE principal_id=$1",[A]);}
 await fresh.query("INSERT INTO public.platform_control_operators(principal_id) VALUES ($1)",[A]);
 try{await expect(port.createNotificationRecipient({email,name:null,notification_type:"new_signup",active:true})).rejects.toThrow("operator_required");}finally{await fresh.query("DELETE FROM public.platform_control_operators WHERE principal_id=$1",[A]);}
 await fresh.query("BEGIN; SELECT set_config('app.platform_human_membership_revoke','true',true); UPDATE public.platform_human_memberships SET membership_state='revoked',membership_revoked_at=now(),membership_revoked_by='b3000000-0000-4000-8000-000000000002',membership_revocation_reason='synthetic' WHERE principal_id='b3000000-0000-4000-8000-000000000001'; COMMIT");
 try{await expect(port.listNotificationRecipients({notification_type:"new_signup"})).rejects.toThrow("operator_required");}finally{await fresh.query("BEGIN; SELECT set_config('app.platform_human_membership_revoke','true',true); UPDATE public.platform_human_memberships SET membership_state='active',membership_revoked_at=NULL,membership_revoked_by=NULL,membership_revocation_reason=NULL WHERE principal_id='b3000000-0000-4000-8000-000000000001'; COMMIT");}
 await expect(directory(C).listNotificationRecipients({notification_type:"new_signup"})).rejects.toThrow("operator_required");
});
it("evaluates authoritative permission snapshots and persists every ordinary decision without managed-parity claims",async()=>{
 const port=consent();
 for(const [state,allowed] of [[null,false],["denied",false],["suppressed",false],["granted",true]] as const){
  await fresh.query("DELETE FROM public.communication_recipient_consents WHERE recipient_fingerprint=$1",[hash("consent@example.invalid")]);
  if(state)await fresh.query("INSERT INTO public.communication_recipient_consents(recipient_fingerprint,purpose,state) VALUES ($1,'marketing_newsletter',$2)",[hash("consent@example.invalid"),state]);
  const result=await port.evaluate({email:" CONSENT@example.invalid ",purpose:"marketing_newsletter"});expect(result.allowed).toBe(allowed);
  const record=(await fresh.query("SELECT allowed,permission_snapshot FROM public.communication_native_policy_decisions WHERE id=$1",[result.decisionId])).rows[0];
  expect(record.allowed).toBe(allowed);expect(record.permission_snapshot.permission?.state??null).toBe(state);
 }
 expect((await port.evaluate({email,purpose:"unregistered"})).reason).toBe("unsupported_purpose");
 expect((await port.evaluate({email,purpose:"transactional"})).allowed).toBe(true);
 expect((await port.evaluate({email,purpose:"subscription_dunning"})).allowed).toBe(true);
 const paused=keep(createPostgresConsentEvaluator(env(),{testerPaused:async()=>true}));
 expect((await paused.evaluate({email,purpose:"tester_program",recipientKind:"tester"})).reason).toBe("sequence_paused");
 expect(port.guarantees).toEqual({managedFrequencyCaps:false,legacyContactTouching:false,sendTimeFence:false});
});
it("requires an active source-bound admin recipient and refuses decision commit failures before an effect",async()=>{
 const dir=directory(),port=consent();await dir.createNotificationRecipient({email:"admin-recipient@example.invalid",name:null,notification_type:"new_signup",active:true});
 const [row]=(await dir.listNotificationRecipients({notification_type:"new_signup"})).recipients;
 const input={email:row.email,purpose:"admin_notification",sourceTable:"notification_recipients" as const,sourceId:row.id};
 expect((await port.evaluate(input)).allowed).toBe(true);await dir.updateNotificationRecipient({recipientId:row.id,active:false});
 expect((await port.evaluate(input)).allowed).toBe(false);
 await fresh.query("ALTER TABLE public.communication_native_policy_decisions ADD CONSTRAINT synthetic_decision_refusal CHECK (false) NOT VALID");let effects=0;
 try{await expect(port.evaluate({email,purpose:"transactional"}).then(value=>{if(value.allowed)effects++;})).rejects.toMatchObject({name:"ConsentEvaluationUnavailableError"});}
 finally{await fresh.query("ALTER TABLE public.communication_native_policy_decisions DROP CONSTRAINT synthetic_decision_refusal");}
 expect(effects).toBe(0);
});
it.each(["public","column","inherited"] as const)("refuses unsafe %s effective privileges across all four native capabilities",async mode=>{
 const tables=["communication_native_sends","communication_native_sync_state","notification_recipients","communication_native_policy_decisions"];
 if(mode==="inherited")await fresh.query("CREATE ROLE synthetic_browser_parent; GRANT synthetic_browser_parent TO authenticated WITH INHERIT TRUE");
 for(const table of tables){
  if(mode==="column")await fresh.query(`GRANT SELECT (${table==="communication_native_sync_state"?"work_id":"id"}) ON public.${table} TO authenticated`);
  else await fresh.query(`GRANT SELECT ON public.${table} TO ${mode==="public"?"PUBLIC":"synthetic_browser_parent"}`);
 }
 try{
  await expect(delivery().findFrozenSends({now,graceMinutes:0,limit:10})).rejects.toThrow("privileges_unsafe");
  await expect(sync().claimBatch({providerKind:"synthetic",batchSize:1,visibilitySeconds:60,maxAttempts:2})).rejects.toThrow("privileges_unsafe");
  await expect(directory().listNotificationRecipients({notification_type:"new_signup"})).rejects.toThrow("privileges_unsafe");
  await expect(consent().evaluate({email,purpose:"transactional"})).rejects.toMatchObject({name:"ConsentEvaluationUnavailableError"});
 }finally{
  for(const table of tables){if(mode==="column")await fresh.query(`REVOKE SELECT (${table==="communication_native_sync_state"?"work_id":"id"}) ON public.${table} FROM authenticated`);else await fresh.query(`REVOKE SELECT ON public.${table} FROM ${mode==="public"?"PUBLIC":"synthetic_browser_parent"}`);}
  if(mode==="inherited")await fresh.query("REVOKE synthetic_browser_parent FROM authenticated; DROP ROLE synthetic_browser_parent");
 }
 for(const role of ["anon","authenticated"]){const client=await fresh.connect();try{await client.query(`SET ROLE ${role}`);for(const table of tables)await expect(client.query(`SELECT * FROM public.${table}`)).rejects.toMatchObject({code:"42501"});}finally{await client.query("RESET ROLE");client.release();}}
});
it("refuses poisoned default ACLs on an adverse reinstall, then restores the exact clean catalogue",async()=>{
 const tables=["communication_native_observations","communication_native_sends","communication_native_sync_state","notification_recipients","communication_native_policy_decisions"];
 for(const table of tables)await upgrade.query(`DROP TABLE public.${table}`);
 await upgrade.query("ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO authenticated");
 try{
  await upgrade.query(readFileSync(nativeFile,"utf8"));
  await expect(delivery("poison",1).findFrozenSends({now,graceMinutes:0,limit:1})).rejects.toThrow("privileges_unsafe");
  await expect(sync("poison",1).claimBatch({providerKind:"synthetic",batchSize:1,visibilitySeconds:60,maxAttempts:2})).rejects.toThrow("privileges_unsafe");
  await expect(directory(A,1).listNotificationRecipients({notification_type:"new_signup"})).rejects.toThrow("privileges_unsafe");
  await expect(consent(1).evaluate({email,purpose:"transactional"})).rejects.toMatchObject({name:"ConsentEvaluationUnavailableError"});
 }finally{for(const table of tables)await upgrade.query(`REVOKE SELECT ON public.${table} FROM authenticated`);await upgrade.query("ALTER DEFAULT PRIVILEGES REVOKE SELECT ON TABLES FROM authenticated");}
 for(const table of tables)await upgrade.query(`DROP TABLE public.${table}`);
 await upgrade.query(readFileSync(nativeFile,"utf8"));
 expect((await runner(upgrade).apply()).applied).toEqual([]);expect(await snapshot(upgrade)).toEqual(before);
});
