import { currencyExponent } from '@openlup/platform/market-packs';
import { PLATFORM_EVENT_VOCABULARY } from '@openlup/core/outbox';
import { randomUUID } from 'node:crypto';
import { afterAll,beforeAll,expect,it } from 'vitest';
import { ecommerceInstallation,ecommercePaid,ecommerceAt as at } from './communicationEcommerceFixture.js';
import { postgresSetupTimeoutMs,postgresTeardownTimeoutMs } from '../helpers/postgresContainer.js';
import {createPostgresEcommerceEventProjection,createPostgresEcommerceEventHandler} from '@openlup/platform/communications';
import {createEcommerceEventPrivacyContributor} from '@openlup/platform/communications';
import {createPostgresOutboxStore,createPostgresOutboxCompactor} from '@openlup/outbox/postgres';
import {ECOMMERCE_EXPORT_EVENT_TYPE} from '@openlup/platform/communications';
let env:Awaited<ReturnType<typeof ecommerceInstallation>>;
beforeAll(async()=>{env=await ecommerceInstallation();},postgresSetupTimeoutMs);
afterAll(async()=>env?.close(),postgresTeardownTimeoutMs);
const now=()=>new Date('2026-11-11T13:00:00Z');
const selectedBinding={account:'synthetic-account',environment:'test',namespace:'synthetic',mappingVersion:'ecommerce-v1'};
const binding=()=>({...selectedBinding});
const target=async()=>({subjectReference:'subject:synthetic',profileId:'profile_synthetic',generation:1,authorityReference:'authority:1'});
const projection=(b=binding())=>createPostgresEcommerceEventProjection({binding:b,liveSince:new Date('2026-11-11T11:00:00Z'),currency:{code:'USD',exponent:currencyExponent('USD'),provenance:'runtime-icu:currencyExponent.v1'},now,withTransaction:env.withTransaction,resolveTarget:target});
const source=async(order:string)=>(await env.db.query(`SELECT metadata->'commercePaidFactV1' AS fact FROM public.outbox_events WHERE event_type='commerce.order.paid' AND aggregate_id=$1`,[order])).rows[0]?.fact;
async function paid(options:Parameters<typeof ecommercePaid>[1]={}){return env.withTransaction(db=>ecommercePaid(db,options));}
it('real settlement snapshots allowed money and products while incomplete source preserves paid truth',async()=>{
 const f=await paid(),incomplete=await paid({complete:false});
 expect(await source(f.order)).toMatchObject({state:'complete',event:{sourceType:'order.paid',data:{settlementIntentId:f.intent,amountMinor:1234,currency:'USD',purchaseKind:'one_time',lines:[{sku:'frozen-sku',quantity:1,amountMinor:1234}]}}});
 expect(await source(incomplete.order)).toEqual({state:'incomplete',reason:'settlement_evidence'});
 expect((await env.db.query('SELECT status FROM public.commerce_orders WHERE id=$1',[incomplete.order])).rows[0].status).toBe('paid');
 const payload=(await env.db.query(`SELECT payload FROM public.outbox_events WHERE event_type='commerce.order.paid' AND aggregate_id=$1`,[f.order])).rows[0].payload;
 expect(Object.keys(payload).sort()).toEqual(['occurredAt','orderUuid']);expect(Date.parse(payload.occurredAt)).toBe(Date.parse(at));
});
it('rolls back paid source together with failed financial transaction',async()=>{
 let order='';
 await expect(env.withTransaction(async db=>{order=(await ecommercePaid(db)).order;throw new Error('rollback');})).rejects.toThrow('rollback');
 expect(await source(order)).toBeUndefined();
});
it('captures discount splits plus shipping without inventing duplicate product facts',async()=>{
 const f=await paid({discount:true});
 expect((await source(f.order)).event.data).toMatchObject({amountMinor:1234,lines:[{sku:'frozen-sku',quantity:1,amountMinor:567},{sku:'frozen-sku',quantity:1,amountMinor:568}]});
});
it('captures subscription acquisition before its first cycle is attached',async()=>{
 const f=await paid({initial:true});expect((await source(f.order)).event.data.purchaseKind).toBe('subscription_initial');
});
it('freezes source even if later order/product state changes and blocks source mutation',async()=>{
 const f=await paid();const original=await source(f.order);
 await env.db.query(`UPDATE public.commerce_orders SET metadata='{}'::jsonb WHERE id=$1`,[f.order]);
 expect(await source(f.order)).toEqual(original);
 await expect(env.db.query(`UPDATE public.outbox_events SET metadata=metadata-'commercePaidFactV1' WHERE event_type='commerce.order.paid' AND aggregate_id=$1`,[f.order])).rejects.toThrow('event_source_immutable');
});
it('atomically rolls back failed projection, recovers after reply loss, and keeps anti-join identity',async()=>{
 const p=projection();await p.initialize();await paid();
 const broken=createPostgresEcommerceEventProjection({binding:binding(),liveSince:new Date('2026-11-11T11:00:00Z'),currency:{code:'USD',exponent:currencyExponent('USD'),provenance:'runtime-icu:currencyExponent.v1'},now,resolveTarget:target,
  withTransaction:work=>env.withTransaction(async db=>{const result=await work(db);throw Object.assign(new Error('projection_rollback'),{result});})});
 await expect(broken.project()).rejects.toThrow('projection_rollback');
 const first=await p.project();expect(first.projected).toBeGreaterThan(0);expect(await p.project()).toEqual({projected:0,refused:0,deferred:0});
});
it('protects source DELETE and TRUNCATE before handoff while allowing ordinary compaction metadata',async()=>{
 const p=projection();await p.initialize();const f=await paid();
 await expect(env.db.query(`DELETE FROM public.outbox_events WHERE event_type='commerce.order.paid' AND aggregate_id=$1`,[f.order])).rejects.toThrow('event_source_handoff_required');
 await env.db.query('CREATE ROLE ecommerce_truncate_probe NOLOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS');
 await expect(env.withTransaction(async db=>{await db.query('SET LOCAL ROLE ecommerce_truncate_probe');await db.query('TRUNCATE public.outbox_events CASCADE');})).rejects.toMatchObject({code:'42501'});
 await env.db.query(`UPDATE public.outbox_events SET status='processed',processed_at='2000-01-01' WHERE event_type='commerce.order.paid' AND aggregate_id=$1`,[f.order]);
 await createPostgresOutboxCompactor(env.db).compact({processedDays:1,discardedDays:1,limit:100});
 expect((await source(f.order)).state).toBe('complete');
});
it('freezes event time cutoff and refuses historical/future facts without provider effects',async()=>{
 const p=projection();await p.initialize();await paid({at:'2026-11-10T12:00:00Z'});await paid({at:'2026-11-12T12:00:00Z'});
 const result=await p.project();expect(result.refused).toBeGreaterThanOrEqual(2);
});
it('unknown provider response fences replay and erased identity scrubs frozen projections',async()=>{
 const b=binding(),p=projection(b);await p.initialize();const f=await paid();await p.project();
 const outbox=createPostgresOutboxStore(env.db),rows=await outbox.claimBatch({eventTypes:[ECOMMERCE_EXPORT_EVENT_TYPE],batchSize:1000,visibilitySeconds:300,maxAttempts:8});
 const row=rows.find(r=>(r.payload.event as {sourceId:string})?.sourceId===`paid:${f.order}` && (r.payload.binding as {account:string})?.account===b.account)!;
 let calls=0;const handler=createPostgresEcommerceEventHandler({binding:b,now,withTransaction:env.withTransaction,authorize:async()=>true,provider:{async exportEvent(){calls++;return {kind:'unknown',reason:'acceptance_ambiguous'};}}});
 expect(await handler.handle(row,new AbortController().signal)).toMatchObject({kind:'snooze'});
 expect(await handler.handle(row,new AbortController().signal)).toMatchObject({kind:'snooze'});expect(calls).toBe(1);
 const privacy=createEcommerceEventPrivacyContributor(),subject={contactId:f.client,principalId:null,identity:{}};
 await env.withTransaction(async db=>{await privacy.prepareErasure(db);const assessment=await privacy.assessErasure(db,subject);await privacy.eraseOrRetain(db,subject,assessment,{principalId:randomUUID()});});
 expect((await env.db.query('SELECT payload FROM public.outbox_events WHERE id=$1',[row.id])).rows[0].payload).toEqual({});
 expect((await env.db.query('SELECT state,request_digest FROM public.communication_event_receipts WHERE outbox_event_id=$1',[row.id])).rows[0]).toMatchObject({state:'erased',request_digest:expect.any(String)});
});
it('projects manual and provider refunded status once without financial value',async()=>{
 const manual=await paid(),provider=await paid();
 const actor=randomUUID();await env.db.query(`INSERT INTO public.commerce_operators(id,label) VALUES($1,'Synthetic')`,[actor]);
 await env.db.query('SELECT public.oms_mark_refunded($1,$2,$3,$4)',[randomUUID(),manual.order,'external status',actor]);
 await env.db.query(`UPDATE public.commerce_orders SET status='refunded',refunded_at=$2 WHERE id=$1`,[provider.order,at]);
 const rows=(await env.db.query(`SELECT event FROM public.communication_event_sources WHERE source_key=ANY($1::text[])`,[[`refund-status:${manual.order}`,`refund-status:${provider.order}`]])).rows;
 expect(rows).toHaveLength(2);
 for(const row of rows)expect(row.event.data).toEqual({orderId:expect.any(String),status:'refunded'});
 expect((await env.db.query(`SELECT count(*)::integer AS count FROM public.outbox_events WHERE aggregate_id=$1 AND event_type='commerce.order.refunded'`,[manual.order])).rows[0].count).toBe(0);
});
it('qualifies checkout once without token and suppresses the paid checkout before export',async()=>{
 const client=randomUUID(),order=randomUUID();
 await env.withTransaction(async db=>{
  await db.query('INSERT INTO public.clients(id,email) VALUES($1,$2)',[client,`${client}@example.invalid`]);
  await db.query(`INSERT INTO public.commerce_orders(id,client_id,created_at,currency_code,total_amount_minor,metadata) VALUES($1,$2,'2026-11-11T10:00:00Z','USD',100,'{"orderDraftSnapshot":{"context":{"mode":"one_time"}}}')`,[order,client]);
  await db.query('INSERT INTO public.commerce_order_items(order_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor) VALUES($1,1,1,100,100)',[order]);
 });
 await env.db.query(`SELECT public.communication_checkout_qualify(100,'{}',$1)`,[at]);
 await env.db.query(`SELECT public.communication_checkout_qualify(100,'{}',$1)`,[at]);
 const row=(await env.db.query(`SELECT metadata,status FROM public.outbox_events WHERE aggregate_id=$1 AND event_type='commerce.checkout.recovery_qualified.v1'`,[order])).rows;
 expect(row).toHaveLength(1);expect(row[0].status).toBe('processed');expect(JSON.stringify(row[0].metadata)).not.toContain('recoveryToken');
 await env.db.query(`UPDATE public.commerce_orders SET status='paid',paid_at=$2 WHERE id=$1`,[order,at]);
 const p=projection();await p.initialize();await p.project();
 expect((await env.db.query(`SELECT state,reason FROM public.communication_event_receipts WHERE source_key=$1 ORDER BY updated_at DESC LIMIT 1`,[`checkout:${order}`])).rows[0]).toEqual({state:'refused',reason:'source_ineligible'});
});
it('drains eligible checkout qualifications across bounded runs without repeating the qualified prefix',async()=>{
 const orders=[randomUUID(),randomUUID()];
 await env.withTransaction(async db=>{
  for(const [index,order] of orders.entries()){
   const client=randomUUID();
   await db.query('INSERT INTO public.clients(id,email) VALUES($1,$2)',[client,`${client}@example.invalid`]);
   await db.query(`INSERT INTO public.commerce_orders(id,client_id,created_at,currency_code,total_amount_minor,metadata)
    VALUES($1,$2,$3::timestamptz,'USD',100,'{"orderDraftSnapshot":{"context":{"mode":"one_time"}}}')`,[order,client,`2026-11-11T10:0${index}:00Z`]);
   await db.query('INSERT INTO public.commerce_order_items(order_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor) VALUES($1,1,1,100,100)',[order]);
  }
 });
 const counts:number[]=[];
 for(let run=0;run<3;run++)counts.push((await env.db.query(`SELECT public.communication_checkout_qualify(1,'{}',$1) AS value`,[at])).rows[0].value);
 expect(counts).toEqual([1,1,0]);
 expect((await env.db.query(`SELECT aggregate_id,count(*)::integer AS count FROM public.outbox_events
  WHERE event_type='commerce.checkout.recovery_qualified.v1' AND aggregate_id=ANY($1::uuid[]) GROUP BY aggregate_id ORDER BY aggregate_id`,[orders])).rows)
  .toEqual([...orders].sort().map(aggregate_id=>({aggregate_id,count:1})));
 expect((await env.db.query('SELECT status FROM public.commerce_orders WHERE id=ANY($1::uuid[])',[orders])).rows.every(row=>row.status==='pending_payment')).toBe(true);
});
it('captures created, rapid pause/resume/cancel owner facts without rebuilding from final status',async()=>{
 const f=await paid({initial:true});
 const activated=(await env.db.query(`SELECT public.subscription_activate_from_captured_payment($1,$2,encode(sha256(convert_to('synthetic-paid','UTF8')),'hex')) AS value`,[randomUUID(),f.order])).rows[0].value;
 const subscription=String(activated.subscriptionId);
 await env.db.query(`UPDATE public.subscriptions SET next_cycle_at='2026-12-11T12:00:00Z',started_at='2026-01-01' WHERE id=$1`,[subscription]);
 for(const [index,action] of ['pause','resume','cancel'].entries()){
  await env.db.query(`SELECT public.subscription_apply_lifecycle_action($1,$2,$3,$4,$5,$6)`,[f.client,randomUUID(),subscription,action,action==='pause'?{pausePreset:'indefinite'}:{},new Date(Date.parse(at)+1000*(index+1)).toISOString()]);
 }
 const facts=(await env.db.query(`SELECT event FROM public.communication_event_sources WHERE aggregate_id=$1 ORDER BY event->>'occurredAt'`,[subscription])).rows.map(row=>row.event);
 expect(facts.map(fact=>fact.sourceType)).toEqual(['subscription.created','subscription.paused','subscription.resumed','subscription.cancelled']);
 expect(new Set(facts.map(fact=>fact.sourceId)).size).toBe(4);
 expect(facts.every(fact=>fact.subject.clientId===f.client)).toBe(true);
 await expect(env.db.query(`UPDATE public.subscription_events SET communication_subject_id=NULL WHERE subscription_id=$1`,[subscription])).rejects.toThrow('event_source_immutable');
 await expect(env.db.query(`DELETE FROM public.subscription_events WHERE subscription_id=$1`,[subscription])).rejects.toThrow('event_source_handoff_required');
});
it('missing target is recorded once and cannot starve the next source',async()=>{
 const b=binding();const f=await paid(),g=await paid();
 const p=createPostgresEcommerceEventProjection({binding:b,liveSince:new Date('2026-11-11T11:00Z'),currency:{code:'USD',exponent:currencyExponent('USD'),provenance:'runtime-icu:currencyExponent.v1'},now,withTransaction:env.withTransaction,
  resolveTarget:async event=>event.subject.clientId===f.client?null:target()});
 await p.initialize();for(let n=0;n<30;n++)await p.project(1);
 expect((await env.db.query(`SELECT state,reason FROM public.communication_event_receipts WHERE source_key=$1 AND binding_key=(SELECT binding_key FROM public.communication_event_bindings WHERE binding->>'account'=$2)`,[`paid:${f.order}`,b.account])).rows[0]).toEqual({state:'refused',reason:'target_unavailable'});
 expect((await env.db.query(`SELECT state FROM public.communication_event_receipts WHERE source_key=$1 AND binding_key=(SELECT binding_key FROM public.communication_event_bindings WHERE binding->>'account'=$2)`,[`paid:${g.order}`,b.account])).rows[0]).toEqual({state:'pending'});
});
it('keeps the only immutable account binding and refuses another account or cutoff',async()=>{
 const p=projection();await p.initialize();
 await expect(env.db.query(`SELECT public.communication_event_binding($1,$2)`,[{...binding(),account:'foreign-account'},'2026-11-11T11:00Z'])).rejects.toThrow('event_binding_changed');
 await expect(env.db.query(`SELECT public.communication_event_binding($1,$2)`,[binding(),'2026-11-11T10:00Z'])).rejects.toThrow('event_binding_changed');
 expect((await env.db.query('SELECT count(*)::integer AS count FROM public.communication_event_bindings')).rows[0].count).toBe(1);
});
it('compacts ordinary terminal payload while retaining unresolved export bytes',async()=>{
 const p=projection();await p.initialize();const f=await paid();await p.project();
 const work=(await env.db.query(`SELECT e.id,e.payload FROM public.outbox_events e JOIN public.communication_event_receipts r ON r.outbox_event_id=e.id WHERE r.source_key=$1`,[`paid:${f.order}`])).rows[0];
 await env.db.query("UPDATE public.communication_event_receipts SET state='unknown',reason='acceptance_ambiguous' WHERE outbox_event_id=$1",[work.id]);
 await env.db.query(`UPDATE public.outbox_events SET status='discarded',metadata=metadata||'{"discardedAt":"2000-01-01T00:00:00Z"}'::jsonb WHERE id=$1`,[work.id]);
 const ordinary=randomUUID();await env.db.query(`INSERT INTO public.outbox_events(id,aggregate_type,aggregate_id,event_type,idempotency_key,status,processed_at,payload) VALUES($1::uuid,'synthetic',$2::uuid,'synthetic.ordinary',$1::text,'processed','2000-01-01','{"allowed":"compact"}')`,[ordinary,randomUUID()]);
 await createPostgresOutboxCompactor(env.db).compact({processedDays:1,discardedDays:1,limit:1000});
 await env.db.query(`SELECT public.commerce_outbox_compact_terminal(1000,clock_timestamp())`);
 expect((await env.db.query('SELECT payload FROM public.outbox_events WHERE id=$1',[ordinary])).rows[0].payload).toEqual({});
 expect((await env.db.query('SELECT payload FROM public.outbox_events WHERE id=$1',[work.id])).rows[0].payload).toEqual(work.payload);
 await expect(env.db.query(`UPDATE public.outbox_events SET metadata=metadata-'retainPayload' WHERE id=$1`,[work.id])).rejects.toThrow('event_projection_immutable');
});
it('requires exact quiesced recovery evidence before retrying the original unknown tuple',async()=>{
 const {reconcilePostgresEcommerceEvent}=await import('@openlup/platform/communications');
 const p=projection();await p.initialize();const f=await paid();await p.project();
 const work=(await env.db.query(`SELECT e.id,e.payload,r.request_digest FROM public.outbox_events e JOIN public.communication_event_receipts r ON r.outbox_event_id=e.id WHERE r.source_key=$1`,[`paid:${f.order}`])).rows[0];
 await env.db.query(`UPDATE public.communication_event_receipts SET state='unknown' WHERE outbox_event_id=$1`,[work.id]);
 const options={binding:binding(),eventId:work.id,expectedRequestDigest:work.request_digest,evidenceReference:'qualified-identical-event:1',resolution:'retry' as const,quiesced:true,qualifiedIdenticalRetry:true,now,withTransaction:env.withTransaction,authorize:async()=>true};
 expect(await reconcilePostgresEcommerceEvent({...options,quiesced:false})).toBe('refused');
 expect(await reconcilePostgresEcommerceEvent({...options,expectedRequestDigest:'wrong'})).toBe('refused');
 expect(await reconcilePostgresEcommerceEvent(options)).toBe('resolved');
 expect((await env.db.query('SELECT payload FROM public.outbox_events WHERE id=$1',[work.id])).rows[0].payload).toEqual(work.payload);
 expect((await env.db.query('SELECT state,recovery_reference FROM public.communication_event_receipts WHERE outbox_event_id=$1',[work.id])).rows[0]).toEqual({state:'pending',recovery_reference:'qualified-identical-event:1'});
});
it('retries a terminal unknown duty with a fresh bounded worker budget and retained consumed counters',async()=>{
 const {reconcilePostgresEcommerceEvent}=await import('@openlup/platform/communications');
 const p=projection();await p.initialize();const f=await paid();await p.project();
 const work=(await env.db.query(`SELECT e.id,e.payload,r.request_digest FROM public.outbox_events e JOIN public.communication_event_receipts r ON r.outbox_event_id=e.id WHERE r.source_key=$1`,[`paid:${f.order}`])).rows[0];
 const outbox=createPostgresOutboxStore(env.db);
 const claim=async()=>(await outbox.claimBatch({eventTypes:[ECOMMERCE_EXPORT_EVENT_TYPE],knownEventTypes:PLATFORM_EVENT_VOCABULARY.map(row=>row.eventType),batchSize:1000,visibilitySeconds:300,maxAttempts:1})).find(row=>row.id===work.id);
 let accepted=false,calls=0;
 const handler=createPostgresEcommerceEventHandler({binding:binding(),now,withTransaction:env.withTransaction,authorize:async()=>true,provider:{async exportEvent(){calls++;return accepted?{kind:'accepted'}:{kind:'unknown',reason:'acceptance_ambiguous'};}}});
 const first=(await claim())!;
 expect(await handler.handle(first,new AbortController().signal)).toMatchObject({kind:'snooze'});
 expect(await outbox.markFailed({eventId:work.id,claimToken:String(first.metadata.claimToken),outcome:'snooze',error:'ecommerce_reconciliation_required',baseDelaySeconds:1,maxDelaySeconds:1,maxAttempts:1,snoozeSeconds:60})).toEqual({status:'snoozed'});
 await env.db.query(`UPDATE public.outbox_events SET available_at='2000-01-01' WHERE id=$1`,[work.id]);
 const second=(await claim())!;
 expect(await handler.handle(second,new AbortController().signal)).toMatchObject({kind:'snooze'});
 expect(calls).toBe(1);
 expect(await outbox.markFailed({eventId:work.id,claimToken:String(second.metadata.claimToken),outcome:'retry',error:'snooze_budget_exhausted:ecommerce_reconciliation_required',baseDelaySeconds:1,maxDelaySeconds:1,maxAttempts:1,snoozeSeconds:60})).toEqual({status:'discarded'});
 expect((await env.db.query('SELECT status,attempts,metadata FROM public.outbox_events WHERE id=$1',[work.id])).rows[0]).toMatchObject({status:'discarded',attempts:1,metadata:{snoozeCount:1,finalAttempts:1,retainPayload:true}});
 expect(await reconcilePostgresEcommerceEvent({binding:binding(),eventId:work.id,expectedRequestDigest:work.request_digest,evidenceReference:'qualified-terminal-retry:1',resolution:'retry',quiesced:true,qualifiedIdenticalRetry:true,now,withTransaction:env.withTransaction,authorize:async()=>true})).toBe('resolved');
 const retried=await claim();
 expect(retried).toBeDefined();
 expect(retried).toMatchObject({id:work.id,attempts:1,payload:work.payload,metadata:{snoozeCount:0,recoveryAttempts:1,recoverySnoozes:1,finalAttempts:1}});
 accepted=true;
 expect(await handler.handle(retried!,new AbortController().signal)).toEqual({kind:'processed'});
 expect(calls).toBe(2);
 expect(await outbox.markProcessed({eventId:work.id,claimToken:String(retried!.metadata.claimToken)})).toEqual({applied:true});
 expect((await env.db.query('SELECT state,request_digest,recovery_reference FROM public.communication_event_receipts WHERE outbox_event_id=$1',[work.id])).rows[0]).toEqual({state:'accepted',request_digest:work.request_digest,recovery_reference:'qualified-terminal-retry:1'});
});
it('native renewal uses its operation identity, not initial acquisition cycle presence',async()=>{
 const {renewal,prepareOriginal}=await import('./subscriptionNativeFixture.js');
 const f=await renewal(env.db),original=await prepareOriginal(env.db,f);
 await env.db.query(`SELECT public.commerce_record_settlement($1,$2,'succeeded','synthetic-renewal','{}',$3)`,[randomUUID(),original.settlementIntentId,at]);
 expect((await source(original.orderId)).event.data).toMatchObject({purchaseKind:'renewal',amountMinor:f.snapshot.totalAmountMinor,currency:'XXX'});
});
it('refuses direct source-helper calls and never upgrades a postcommit or incomplete source',async()=>{
 const incomplete=await paid({complete:false}),f=await paid();await projection().project();
 await expect(env.db.query('SELECT public.communication_event_paid_write($1)',[f.order])).rejects.toThrow('paid_source_trigger_required');
 const original=await source(incomplete.order);
 await env.db.query(`DELETE FROM public.outbox_events WHERE event_type='commerce.order.paid' AND aggregate_id=$1`,[f.order]);
 await env.withTransaction(async db=>{
  await db.query('CREATE TEMP TABLE ecommerce_source_probe(order_id uuid) ON COMMIT DROP');
  await db.query(`CREATE FUNCTION pg_temp.ecommerce_source_probe() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM public.communication_event_paid_write(NEW.order_id); RETURN NEW; END; $$`);
  await db.query('CREATE TRIGGER invoke_source BEFORE INSERT ON ecommerce_source_probe FOR EACH ROW EXECUTE FUNCTION pg_temp.ecommerce_source_probe()');
  await db.query('INSERT INTO ecommerce_source_probe VALUES($1),($2)',[incomplete.order,f.order]);
 });
 expect(await source(incomplete.order)).toEqual(original);
 expect(await source(f.order)).toEqual({state:'incomplete',reason:'paid_boundary_missing'});
});
it('a handed-off frozen paid request remains verifiable after permitted source removal',async()=>{
 const f=await paid();await projection().project();
 const request=(await env.db.query(`SELECT e.payload FROM public.outbox_events e JOIN public.communication_event_receipts r ON r.outbox_event_id=e.id WHERE r.source_key=$1`,[`paid:${f.order}`])).rows[0].payload;
 await env.db.query(`DELETE FROM public.outbox_events WHERE event_type='commerce.order.paid' AND aggregate_id=$1`,[f.order]);
 expect((await env.db.query('SELECT public.communication_event_source_current($1,$2) AS value',[request.event,now().toISOString()])).rows[0].value).toBe(true);
});
it('does not recreate a recipient projection when erasure commits during target resolution',async()=>{
 const f=await paid(),privacy=createEcommerceEventPrivacyContributor(),subject={contactId:f.client,principalId:null,identity:{}};
 let erased=false;
 const p=createPostgresEcommerceEventProjection({binding:binding(),liveSince:new Date('2026-11-11T11:00Z'),
  currency:{code:'USD',exponent:currencyExponent('USD'),provenance:'runtime-icu:currencyExponent.v1'},now,withTransaction:env.withTransaction,
  resolveTarget:async event=>{
   if(event.subject.clientId===f.client&&!erased){erased=true;await env.withTransaction(async db=>{
    const assessment=await privacy.assessErasure(db,subject);await privacy.eraseOrRetain(db,subject,assessment,{principalId:randomUUID()});
   });}
   return target();
  }});
 await p.project();
 expect((await env.db.query(`SELECT state,outbox_event_id FROM public.communication_event_receipts WHERE source_key=$1`,[`paid:${f.order}`])).rows[0]).toEqual({state:'erased',outbox_event_id:null});
 expect((await env.db.query(`SELECT count(*)::integer AS count FROM public.outbox_events WHERE event_type=$1 AND payload#>>'{event,subject,clientId}'=$2`,[ECOMMERCE_EXPORT_EVENT_TYPE,f.client])).rows[0].count).toBe(0);
});
it('records subjectless legacy and guest refusals without stalling a valid fact in the same batch',async()=>{
 const valid=await paid(),subscription=randomUUID(),legacy=randomUUID(),guest=randomUUID();
 await env.withTransaction(async db=>{
  await db.query(`INSERT INTO public.subscriptions(id,client_id,cadence_days,next_cycle_at) VALUES($1,$2,28,'2026-12-11')`,[subscription,valid.client]);
  // Retained pre-migration rows have no captured subject; the current subscription
  // owner must not be used to invent the missing historical association.
  await db.query("SELECT set_config('app.communication_retained_copy','on',true)");
  await db.query(`INSERT INTO public.subscription_events(id,subscription_id,event_type,idempotency_key,occurred_at,communication_subject_id)
   VALUES($1::uuid,$2::uuid,'subscription.activated',$1::text,$3,NULL)`,[legacy,subscription,at]);
  await db.query(`INSERT INTO public.commerce_orders(id,client_id,currency_code,total_amount_minor) VALUES($1,NULL,'USD',100)`,[guest]);
  await db.query(`INSERT INTO public.commerce_order_items(order_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor) VALUES($1,1,1,100,100)`,[guest]);
  await db.query(`SELECT public.commerce_open_settlement_intent($1,$2,'synthetic',100,'USD','{}',$3)`,[randomUUID(),guest,at]);
  const intent=(await db.query('SELECT id FROM public.commerce_settlement_intents WHERE order_id=$1',[guest])).rows[0].id;
  await db.query(`SELECT public.commerce_record_settlement($1,$2,'succeeded','guest-paid','{}',$3)`,[randomUUID(),intent,at]);
 });
 const resolved:string[]=[],p=createPostgresEcommerceEventProjection({binding:binding(),liveSince:new Date('2026-11-11T11:00Z'),
  currency:{code:'USD',exponent:currencyExponent('USD'),provenance:'runtime-icu:currencyExponent.v1'},now,withTransaction:env.withTransaction,
  resolveTarget:async event=>{resolved.push(event.sourceId);return target();}});
 expect((await env.db.query(`SELECT attnotnull FROM pg_attribute WHERE attrelid='public.communication_event_receipts'::regclass AND attname='client_id'`)).rows[0]).toEqual({attnotnull:false});
 expect(await p.project(1000)).toEqual({projected:1,refused:2,deferred:0});
 const rows=(await env.db.query(`SELECT source_key,client_id,state,reason,outbox_event_id FROM public.communication_event_receipts
  WHERE source_key=ANY($1::text[]) ORDER BY source_key`,[[`subscription:${legacy}`,`paid:${guest}`,`paid:${valid.order}`]])).rows;
 expect(rows.find(row=>row.source_key===`subscription:${legacy}`)).toEqual({source_key:`subscription:${legacy}`,client_id:null,state:'refused',reason:'source_snapshot_missing',outbox_event_id:null});
 expect(rows.find(row=>row.source_key===`paid:${guest}`)).toEqual({source_key:`paid:${guest}`,client_id:null,state:'refused',reason:'order_evidence',outbox_event_id:null});
 expect(resolved).toEqual([`paid:${valid.order}`]);
 const work=(await createPostgresOutboxStore(env.db).claimBatch({eventTypes:[ECOMMERCE_EXPORT_EVENT_TYPE],batchSize:1000,visibilitySeconds:300,maxAttempts:8}))
  .find(row=>row.id===rows.find(receipt=>receipt.source_key===`paid:${valid.order}`)!.outbox_event_id)!;
 const effects:string[]=[],handler=createPostgresEcommerceEventHandler({binding:binding(),now,withTransaction:env.withTransaction,authorize:async()=>true,
  provider:{async exportEvent(request){effects.push(request.event.sourceId);return {kind:'accepted'};}}});
 expect(await handler.handle(work,new AbortController().signal)).toEqual({kind:'processed'});
 expect(effects).toEqual([`paid:${valid.order}`]);
 expect(await p.project(1000)).toEqual({projected:0,refused:0,deferred:0});
});
