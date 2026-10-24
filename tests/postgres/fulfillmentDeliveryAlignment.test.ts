import { postgresSetupTimeoutMs, postgresTeardownTimeoutMs } from '../helpers/postgresContainer.js';
import { randomUUID } from 'node:crypto';
import { readFileSync,readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll,beforeAll,expect,it } from 'vitest';
import { createPostgresDeliveryAlignmentPort,createPostgresFulfillmentDispatchStore,createPostgresFulfillmentShipmentSpinePort } from '@openlup/platform/fulfillment';
import { createPostgresRenewalSettlementPort } from '../../server/adapters/postgres/commerce/renewalSettlement.js';
import { executor,fixture,nativeHarness,openCase,replacement,schedule } from '../helpers/fulfillmentNative.js';
const h=nativeHarness('alignment');
beforeAll(()=>h.start(),postgresSetupTimeoutMs);afterAll(()=>h.stop(), postgresTeardownTimeoutMs);
const arrival=(shipment:string,at='2026-09-04T12:00:00.000Z',key=`arrival-${shipment}`) => createPostgresDeliveryAlignmentPort(executor(h.pool)).recordArrival({requestKey:key,parcelRef:shipment,deliveredAt:at,evidenceRef:`evidence:${shipment}`});
const cases=async(order:string)=>(await h.pool.query('SELECT * FROM public.subscription_delivery_alignment_cases WHERE predecessor_order_id=$1 ORDER BY created_at,id',[order])).rows;
const admit=async(subscription:string,at='2026-08-29T12:00:00.000Z')=>(await h.pool.query('SELECT public.subscription_delivery_alignment_admit_renewal($1,$2,$3) AS response',[subscription,at,'2026-10-21T12:00:00Z'])).rows[0].response;

it('A1 settles late split arrivals at max(arrivals)+cadence with the outer schedule maximum, once',async()=>{
 const f=await fixture(h.pool);const one=await replacement(h.pool,f);const two=await replacement(h.pool,f,f.shipment,2);await openCase(h.pool,f);
 await arrival(one,'2026-09-08T12:00:00Z');expect((await cases(f.order)).every(row=>row.state==='protected')).toBe(true);
 await h.pool.query("UPDATE public.subscriptions SET next_cycle_at='2026-10-10T12:00:00Z' WHERE id=$1",[f.subscription]);
 expect(await arrival(two,'2026-09-01T12:00:00Z')).toMatchObject({disposition:'aligned',nextCycleAt:'2026-10-10T12:00:00.000Z'});
 const before=await cases(f.order);expect(before.every(row=>row.state==='aligned')).toBe(true);
 await arrival(two,'2026-09-01T12:00:00Z');expect(await cases(f.order)).toEqual(before);
 expect((await schedule(h.pool,f.subscription)).next_cycle_at.toISOString()).toBe('2026-10-10T12:00:00.000Z');
});
it('A2 earlier evidence, duplicate receipts and changed non-null arrival cannot pull in or stack a settled case',async()=>{
 const f=await fixture(h.pool);await openCase(h.pool,f);
 expect(await arrival(f.shipment,'2026-07-01T12:00:00Z')).toMatchObject({disposition:'aligned',nextCycleAt:'2026-08-29T12:00:00.000Z',replayed:false});
 const before=await cases(f.order);expect(await arrival(f.shipment,'2026-07-01T12:00:00Z')).toMatchObject({replayed:true});
 await h.pool.query("UPDATE public.fulfillment_shipments SET delivered_at='2026-12-01T12:00:00Z' WHERE id=$1",[f.shipment]);
 expect(await cases(f.order)).toEqual(before);expect((await schedule(h.pool,f.subscription)).next_cycle_at.toISOString()).toBe('2026-08-29T12:00:00.000Z');
 await expect(arrival(f.shipment,'2026-07-02T12:00:00Z')).rejects.toMatchObject({code:'23505'});
});
it('A3 an arrived ancestor cannot settle its undelivered unsuperseded replacement',async()=>{
 const f=await fixture(h.pool);await openCase(h.pool,f);const next=await replacement(h.pool,f);
 expect(await arrival(f.shipment)).toMatchObject({disposition:'outstanding'});
 expect((await cases(f.order))[0].state).toBe('protected');expect((await schedule(h.pool,f.subscription)).status).toBe('active');
 expect((await h.pool.query('SELECT delivered_at FROM public.fulfillment_shipments WHERE id=$1',[next])).rows[0].delivered_at).toBeNull();
 expect(await admit(f.subscription)).toMatchObject({allowed:false,state:'protected'});
});
it('A4 actual arrival of a second replacement inherits the original case and settles exactly once',async()=>{
 const f=await fixture(h.pool);const original=await openCase(h.pool,f);const one=await replacement(h.pool,f);const two=await replacement(h.pool,f,one,2);
 expect(await arrival(two)).toMatchObject({disposition:'aligned',nextCycleAt:'2026-10-02T12:00:00.000Z'});
 expect((await cases(f.order)).map(row=>row.id)).toEqual([original.id]);
 expect((await h.pool.query('SELECT delivered_at FROM public.fulfillment_shipments WHERE id=ANY($1::uuid[])',[ [f.shipment,one] ])).rows.every(row=>row.delivered_at===null)).toBe(true);
 const before=await cases(f.order);await arrival(two);expect(await cases(f.order)).toEqual(before);
});
it('A5 sequential lost/returned/cancelled/unknown/in-transit exception observations never pause or admit new work',async()=>{
 const f=await fixture(h.pool);await h.pool.query("SELECT public.subscription_delivery_alignment_set_mode('auto_align')");
 const spine=createPostgresFulfillmentShipmentSpinePort(executor(h.pool),{portKey:'fixture-port'});
 for(const reason of ['lost','returned','cancelled','unknown','in_transit']) {
  await spine.raiseException({idempotencyKey:`exception-${reason}-${f.shipment}`,shipmentId:f.shipment,reason});
  expect(await admit(f.subscription)).toMatchObject({allowed:false,state:'protected'});
  expect(await schedule(h.pool,f.subscription)).toMatchObject({status:'active',next_cycle_at:new Date('2026-08-29T12:00:00Z')});
 }
 await h.pool.query("UPDATE public.fulfillment_shipments SET status='cancelled' WHERE id=$1",[f.shipment]);
 expect((await h.pool.query('SELECT delivered_at FROM public.fulfillment_shipments WHERE id=$1',[f.shipment])).rows[0].delivered_at).toBeNull();
 expect((await h.pool.query('SELECT * FROM public.subscription_pause_windows WHERE subscription_id=$1',[f.subscription])).rows).toEqual([]);
 expect((await cases(f.order))[0].state).toBe('protected');
});
it('A6 exact due admission issues one consumable receipt and preserves missing/inactive/dunning/artifact guards',async()=>{
 const f=await fixture(h.pool);await openCase(h.pool,f);await arrival(f.shipment);
 const at=(await schedule(h.pool,f.subscription)).next_cycle_at.toISOString();
 expect(await admit(f.subscription,at)).toMatchObject({allowed:true});
 await expect(h.pool.query("INSERT INTO public.subscription_cycles(subscription_id,scheduled_at,status) VALUES($1,$2,'payment_pending')",[f.subscription,'2026-10-03T12:00:00Z'])).rejects.toMatchObject({code:'40001'});
 await h.pool.query("INSERT INTO public.subscription_cycles(subscription_id,scheduled_at,status) VALUES($1,$2,'payment_pending')",[f.subscription,at]);
 await expect(h.pool.query("INSERT INTO public.subscription_cycles(subscription_id,scheduled_at,status) VALUES($1,$2,'payment_pending')",[f.subscription,at])).rejects.toThrow('admission_required');
 const receipts=(await h.pool.query('SELECT * FROM public.subscription_delivery_alignment_admission_receipts WHERE subscription_id=$1',[f.subscription])).rows;
 expect(receipts).toHaveLength(1);expect(receipts[0].consumed_at).not.toBeNull();
 const missing=await fixture(h.pool,null);await openCase(h.pool,missing);expect(await admit(missing.subscription)).toMatchObject({allowed:false,state:'manual_review'});
 const inactive=await fixture(h.pool);await openCase(h.pool,inactive);await h.pool.query("UPDATE public.subscriptions SET status='paused' WHERE id=$1",[inactive.subscription]);await arrival(inactive.shipment);expect((await cases(inactive.order))[0].state).toBe('released');expect(await admit(inactive.subscription)).toMatchObject({allowed:false,state:'not_active'});
 const dunning=await fixture(h.pool);await openCase(h.pool,dunning);await h.pool.query('INSERT INTO public.subscription_dunning_cases(subscription_id,cycle_id,client_id,idempotency_key) VALUES($1,$2,$3,$4)',[dunning.subscription,dunning.cycle,dunning.client,`dunning-${dunning.cycle}`]);await arrival(dunning.shipment);expect((await cases(dunning.order))[0]).toMatchObject({state:'manual_review',manual_review_reason:'open_dunning'});
 const artifact=await fixture(h.pool);await openCase(h.pool,artifact);await h.pool.query("INSERT INTO public.subscription_cycles(subscription_id,scheduled_at,status) VALUES($1,'2026-09-15','planned')",[artifact.subscription]);await arrival(artifact.shipment);expect((await cases(artifact.order))[0]).toMatchObject({state:'manual_review',manual_review_reason:'renewal_cycle_already_created'});
});
it('A7 preserves note-only operator attestation counterexample, refusals, replay and absence of automatic callers',async()=>{
 const f=await fixture(h.pool);const c=await openCase(h.pool,f);
 await expect(h.pool.query('SELECT public.subscription_delivery_alignment_confirm_replacement($1,$2)',[c.id,' '])).rejects.toMatchObject({code:'22023'});
 await h.pool.query("UPDATE public.subscriptions SET status='paused' WHERE id=$1",[f.subscription]);
 await expect(h.pool.query('SELECT public.subscription_delivery_alignment_confirm_replacement($1,$2)',[c.id,'fixture attestation'])).rejects.toThrow('requires_active');
 await h.pool.query("UPDATE public.subscriptions SET status='active' WHERE id=$1",[f.subscription]);
 // Deliberate counterexample: note-only SQL has no machine arrival predicate.
 const first=(await h.pool.query('SELECT public.subscription_delivery_alignment_confirm_replacement($1,$2) AS response',[c.id,'synthetic counterexample; never operational advice'])).rows[0].response;
 expect(first).toMatchObject({state:'aligned',confirmed:true});expect((await h.pool.query('SELECT delivered_at FROM public.fulfillment_shipments WHERE id=$1',[f.shipment])).rows[0].delivered_at).toBeNull();
 expect((await h.pool.query('SELECT public.subscription_delivery_alignment_confirm_replacement($1,$2) AS response',[c.id,'same attestation'])).rows[0].response).toEqual(first);
 const closed=await fixture(h.pool);const cc=await openCase(h.pool,closed);await h.pool.query("UPDATE public.subscription_delivery_alignment_cases SET state='released' WHERE id=$1",[cc.id]);await expect(h.pool.query('SELECT public.subscription_delivery_alignment_confirm_replacement($1,$2)',[cc.id,'closed'])).rejects.toThrow('not_open');
 const scan=(root:string):string[]=>readdirSync(root,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?scan(join(root,entry.name)):/\.(ts|tsx)$/.test(entry.name)&&!entry.name.includes('.test.')?[join(root,entry.name)]:[]);
 const callers=scan('packages/platform/src').filter(path=>/\.query\([\s\S]{0,160}subscription_delivery_alignment_confirm_replacement|nativeCall[^\n]*subscription_delivery_alignment_confirm_replacement/.test(readFileSync(path,'utf8')));
 expect(callers).toEqual([]);
});
it('A8 subscription locks serialize arrivals, rollback restores protection, and all new objects deny PUBLIC/browser access',async()=>{
 const f=await fixture(h.pool);await openCase(h.pool,f);const db=await h.pool.connect();let pending:ReturnType<typeof arrival>|undefined;
 try {
  await db.query('BEGIN');await db.query('SELECT id FROM public.subscriptions WHERE id=$1 FOR UPDATE',[f.subscription]);
  pending=arrival(f.shipment);
  await expect.poll(async()=>Number((await h.pool.query("SELECT count(*) FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'SELECT public.fulfillment_record_alignment_arrival(%'")).rows[0].count)).toBe(1);
  await db.query('ROLLBACK');expect(await pending).toMatchObject({disposition:'aligned'});
 } finally {await db.query('ROLLBACK');db.release();await pending;}
 const rollback=await fixture(h.pool);await openCase(h.pool,rollback);const tx=await h.pool.connect();
 try {await tx.query('BEGIN');await createPostgresDeliveryAlignmentPort(executor(tx)).recordArrival({requestKey:`rollback-${rollback.shipment}`,parcelRef:rollback.shipment,deliveredAt:'2026-09-04T12:00:00Z',evidenceRef:`evidence:${rollback.shipment}`});await tx.query('ROLLBACK');}finally{tx.release();}
 expect((await cases(rollback.order))[0].state).toBe('protected');expect((await schedule(h.pool,rollback.subscription)).next_cycle_at.toISOString()).toBe('2026-08-29T12:00:00.000Z');await arrival(rollback.shipment);
 const createdFunctions=(await h.pool.query(`SELECT p.oid,p.proname,p.prosecdef,p.proacl FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND (p.proname LIKE 'subscription_delivery_alignment_%' OR p.proname LIKE 'fulfillment_dispatch_%' OR p.proname LIKE 'commerce_fulfillment_%' OR p.proname IN ('fulfillment_record_alignment_arrival','fulfillment_record_provider_attempt','fulfillment_ensure_paid_handoff','fulfillment_ack_paid_handoff','fulfillment_record_observation','fulfillment_mark_observation_processed','fulfillment_record_stock_movement','fulfillment_record_status_evidence','fulfillment_supersede_no_effect_commands'))`)).rows;
 expect(createdFunctions.length).toBeGreaterThan(20);
 for(const fn of createdFunctions){expect(fn.prosecdef,fn.proname).toBe(false);expect(String(fn.proacl),fn.proname).not.toMatch(/(?:^|[,{])=/);for(const role of ['anon','authenticated'])expect((await h.pool.query('SELECT has_function_privilege($1,$2::oid,\'EXECUTE\') AS allowed',[role,fn.oid])).rows[0].allowed,`${role}:${fn.proname}`).toBe(false);}
 const newTables=[...readFileSync('db/platform/migrations/20261022080000_fulfillment_command_ledger.sql','utf8').matchAll(/CREATE TABLE public\.(\w+)/g),...readFileSync('db/platform/migrations/20261022090000_fulfillment_delivery_alignment.sql','utf8').matchAll(/CREATE TABLE(?: IF NOT EXISTS)? public\.(\w+)/g)].map(match=>match[1]);
 for(const role of ['anon','authenticated']){
  for(const table of newTables) for(const permission of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) expect((await h.pool.query('SELECT has_table_privilege($1,$2,$3) AS allowed',[role,`public.${table}`,permission])).rows[0].allowed,`${role}:${table}:${permission}`).toBe(false);
  const actor=await h.pool.connect();try{await actor.query(`SET ROLE ${role}`);await expect(actor.query('SELECT * FROM public.subscription_delivery_alignment_cases')).rejects.toMatchObject({code:'42501'});await expect(actor.query('SELECT public.subscription_delivery_alignment_confirm_replacement($1,$2)',[f.subscription,'denied'])).rejects.toMatchObject({code:'42501'});}finally{await actor.query('RESET ROLE');actor.release();}
 }
});
it('A9 existing-cycle renewal-operation replay and dunning retry proceed through real SQL without minting or consuming a receipt',async()=>{
 const f=await fixture(h.pool);
 await h.pool.query("INSERT INTO public.subscription_delivery_alignment_admission_receipts(subscription_id,scheduled_at,observed_next_cycle_at,source) VALUES($1,'2026-08-29T12:00:00Z','2026-08-29T12:00:00Z','renewal_admission')",[f.subscription]);
 await openCase(h.pool,f);
 const intent=randomUUID();await h.pool.query("INSERT INTO public.commerce_settlement_intents(id,order_id,channel_key,amount_minor,currency_code,open_idempotency_key) VALUES($1,$2,'fixture',900,'XXX',$3)",[intent,f.order,`open-${intent}`]);
 await h.pool.query("UPDATE public.subscription_renewal_operations SET state='attempt_prepared',terminal_outcome=NULL,terminal_at=NULL,attempt_prepared_at=now() WHERE id=$1",[f.operation]);
 const before=(await h.pool.query('SELECT * FROM public.subscription_delivery_alignment_admission_receipts WHERE subscription_id=$1',[f.subscription])).rows;
 const prepared=await createPostgresRenewalSettlementPort(executor(h.pool)).prepareRenewal({operationId:f.operation,claimToken:f.token,now:new Date().toISOString()});
 expect(prepared).toMatchObject({cycleId:f.cycle,orderId:f.order,settlementIntentId:intent,replayed:true});
 const dunning=randomUUID();await h.pool.query('INSERT INTO public.subscription_dunning_cases(id,subscription_id,cycle_id,client_id,idempotency_key) VALUES($1,$2,$3,$4,$5)',[dunning,f.subscription,f.cycle,f.client,`dunning-${dunning}`]);
 const retry=(await h.pool.query("SELECT public.dunning_lifecycle_handle_failure($1,now(),'temporary','retry',2,now()+interval '1 hour','fixture_notice','/recover') AS response",[dunning])).rows[0].response;
 expect(retry).toMatchObject({paused:false,terminal:false,retryAttempt:2});expect((await schedule(h.pool,f.subscription)).status).toBe('active');
 expect((await h.pool.query('SELECT * FROM public.subscription_delivery_alignment_admission_receipts WHERE subscription_id=$1',[f.subscription])).rows).toEqual(before);expect(before).toHaveLength(1);expect(before[0].consumed_at).toBeNull();expect((await cases(f.order))[0].state).toBe('protected');
});
it('A10 new overdue cycle inserts require admission exactly as the donor guard, and cannot bypass an outstanding parcel',async()=>{
 const f=await fixture(h.pool);await h.pool.query("SELECT public.subscription_delivery_alignment_set_mode('auto_align')");
 await expect(h.pool.query("INSERT INTO public.subscription_cycles(subscription_id,scheduled_at,status) VALUES($1,'2026-08-29T12:00:00Z','payment_pending')",[f.subscription])).rejects.toThrow('admission_required');
 expect(await cases(f.order)).toEqual([]);expect(await admit(f.subscription)).toMatchObject({allowed:false,state:'protected'});
 await expect(h.pool.query("INSERT INTO public.subscription_cycles(subscription_id,scheduled_at,status) VALUES($1,'2026-08-29T12:00:00Z','payment_pending')",[f.subscription])).rejects.toThrow('alignment_protected');
 expect((await h.pool.query('SELECT * FROM public.subscription_delivery_alignment_admission_receipts WHERE subscription_id=$1',[f.subscription])).rows).toEqual([]);expect((await schedule(h.pool,f.subscription)).status).toBe('active');
});

it('paid activation history cannot hide an undelivered paid renewal from overdue admission',async()=>{
 const f=await fixture(h.pool,1,true);
 const history=(await h.pool.query('SELECT cycle_number,status,scheduled_at,order_id FROM public.subscription_delivery_alignment_cycles WHERE subscription_id=$1 ORDER BY scheduled_at',[f.subscription])).rows;
 expect(history).toMatchObject([{cycle_number:0,status:'paid',scheduled_at:new Date('2026-07-04T12:00:00Z')},{cycle_number:1,status:'paid',scheduled_at:new Date('2026-08-01T12:00:00Z'),order_id:f.order}]);
 expect(history[0].order_id).not.toBeNull();
 await h.pool.query("SELECT public.subscription_delivery_alignment_set_mode('auto_align')");
 expect(await admit(f.subscription)).toMatchObject({allowed:false,state:'protected',reason:'delivery_alignment_protected'});
 expect(await cases(f.order)).toMatchObject([{predecessor_cycle_id:f.cycle,predecessor_cycle_number:1,state:'protected',evidence_kind:'overdue_renewal'}]);
 await expect(h.pool.query("INSERT INTO public.subscription_cycles(subscription_id,scheduled_at,status) VALUES($1,'2026-08-29T12:00:00Z','payment_pending')",[f.subscription])).rejects.toThrow('alignment_protected');
 expect((await h.pool.query('SELECT * FROM public.subscription_delivery_alignment_admission_receipts WHERE subscription_id=$1',[f.subscription])).rows).toEqual([]);
});
it.each(['2026-08-29T12:00:00.000Z','2026-10-10T12:00:00.000Z'])('paid activation is not a successor artifact: split renewal arrivals preserve GREATEST(%s,max(arrivals)+cadence)',async(nextCycleAt)=>{
 const f=await fixture(h.pool,1,true);const one=await replacement(h.pool,f);const two=await replacement(h.pool,f,f.shipment,2);
 await h.pool.query("SELECT public.subscription_delivery_alignment_set_mode('auto_align')");
 expect(await admit(f.subscription)).toMatchObject({allowed:false,state:'protected'});
 await h.pool.query('UPDATE public.subscriptions SET next_cycle_at=$2 WHERE id=$1',[f.subscription,nextCycleAt]);
 expect(await arrival(one,'2026-09-08T12:00:00Z')).toMatchObject({disposition:'outstanding'});
 const expected=nextCycleAt>'2026-10-06T12:00:00.000Z'?nextCycleAt:'2026-10-06T12:00:00.000Z';
 expect(await arrival(two,'2026-09-01T12:00:00Z')).toMatchObject({disposition:'aligned',nextCycleAt:expected});
 expect((await cases(f.order)).every(row=>row.state==='aligned'&&row.manual_review_reason===null)).toBe(true);
 expect((await schedule(h.pool,f.subscription)).next_cycle_at.toISOString()).toBe(expected);
 const before=await cases(f.order);await arrival(two,'2026-09-01T12:00:00Z');expect(await cases(f.order)).toEqual(before);
});

it.each(['2026-08-29T12:00:00.000Z','2026-10-10T12:00:00.000Z'])('activation alone protects first renewal and aligns once with outer maximum %s',async(nextCycleAt)=>{
 const f=await fixture(h.pool,null,true,true);
 expect((await h.pool.query('SELECT id,cycle_number FROM public.subscription_delivery_alignment_cycles WHERE subscription_id=$1',[f.subscription])).rows).toEqual([{id:f.cycle,cycle_number:0}]);
 await h.pool.query("SELECT public.subscription_delivery_alignment_set_mode('auto_align')");
 expect(await admit(f.subscription)).toMatchObject({allowed:false,state:'protected'});
 expect(await cases(f.order)).toMatchObject([{predecessor_cycle_id:f.cycle,predecessor_cycle_number:0,state:'protected',manual_review_reason:null}]);
 await expect(h.pool.query("INSERT INTO public.subscription_cycles(subscription_id,scheduled_at,status) VALUES($1,'2026-08-29T12:00:00Z','payment_pending')",[f.subscription])).rejects.toThrow('alignment_protected');
 expect((await h.pool.query('SELECT * FROM public.subscription_delivery_alignment_admission_receipts WHERE subscription_id=$1',[f.subscription])).rows).toEqual([]);
 const one=await replacement(h.pool,f);const two=await replacement(h.pool,f,f.shipment,2);
 await h.pool.query('UPDATE public.subscriptions SET next_cycle_at=$2 WHERE id=$1',[f.subscription,nextCycleAt]);
 expect(await arrival(one,'2026-09-08T12:00:00Z')).toMatchObject({disposition:'outstanding'});
 const expected=nextCycleAt>'2026-10-06T12:00:00.000Z'?nextCycleAt:'2026-10-06T12:00:00.000Z';
 expect(await arrival(two,'2026-09-01T12:00:00Z')).toMatchObject({disposition:'aligned',nextCycleAt:expected});
 expect((await cases(f.order)).every(row=>row.state==='aligned'&&row.manual_review_reason===null)).toBe(true);
 expect((await schedule(h.pool,f.subscription)).next_cycle_at.toISOString()).toBe(expected);
 const before=await cases(f.order);await arrival(two,'2026-09-01T12:00:00Z');expect(await cases(f.order)).toEqual(before);
});
it.each([false,true])('unlinked unnumbered paid history refuses admission without becoming activation (known activation: %s)',async(withActivation)=>{
 const f=await fixture(h.pool,null,withActivation);
 const history=(await h.pool.query('SELECT id,cycle_number FROM public.subscription_delivery_alignment_cycles WHERE subscription_id=$1',[f.subscription])).rows;
 expect(history.find(row=>row.id===f.cycle).cycle_number).toBeNull();
 if(withActivation) expect(history.find(row=>row.id!==f.cycle).cycle_number).toBe(0);
 await h.pool.query("SELECT public.subscription_delivery_alignment_set_mode('auto_align')");
 expect(await admit(f.subscription)).toMatchObject({allowed:false,state:'manual_review',reason:'missing_renewal_correlation'});
 expect((await h.pool.query('SELECT * FROM public.subscription_delivery_alignment_admission_receipts WHERE subscription_id=$1',[f.subscription])).rows).toEqual([]);
});
it.each(['paid','planned'])('unordered %s history cannot suppress numbered renewal protection by an earlier schedule',async(status)=>{
 const f=await fixture(h.pool,1,true);
 await h.pool.query("INSERT INTO public.subscription_cycles(subscription_id,scheduled_at,status) VALUES($1,'2026-06-01T12:00:00Z',$2)",[f.subscription,status]);
 await h.pool.query("SELECT public.subscription_delivery_alignment_set_mode('auto_align')");
 if(status==='paid') {
  expect(await admit(f.subscription)).toMatchObject({allowed:false,state:'manual_review',reason:'missing_renewal_correlation'});
 } else {
  expect(await admit(f.subscription)).toMatchObject({allowed:false,state:'protected'});
  expect(await cases(f.order)).toMatchObject([{predecessor_cycle_number:1,state:'protected'}]);
  await arrival(f.shipment);
  expect(await cases(f.order)).toMatchObject([{predecessor_cycle_number:1,state:'manual_review',manual_review_reason:'renewal_cycle_already_created'}]);
  expect((await schedule(h.pool,f.subscription)).next_cycle_at.toISOString()).toBe('2026-08-29T12:00:00.000Z');
 }
 expect((await h.pool.query('SELECT * FROM public.subscription_delivery_alignment_admission_receipts WHERE subscription_id=$1',[f.subscription])).rows).toEqual([]);
});

it('off is inert across local cancellation, arrival, provider exception, admission and one-time dispatch',async()=>{
 const spine=createPostgresFulfillmentShipmentSpinePort(executor(h.pool),{portKey:'fixture-port'});
 const native=createPostgresFulfillmentDispatchStore(executor(h.pool),{async prepare(){return {disposition:'ready',contactRevision:1};},async readCandidate(){return null;}});
 const evidence={commandFingerprint:'a'.repeat(64),contactRevision:{schemaVersion:1,source:'fixture',revision:1},providerRef:'warehouse-a',carrierRef:null,serviceRef:null};
 for(const [mode,oneTime] of [['off',false],['off',true],['auto_align',true]] as const){
  await h.pool.query("SELECT public.subscription_delivery_alignment_set_mode('off')");
  const f=await fixture(h.pool);
  if(oneTime){
   f.order=randomUUID();f.shipment=randomUUID();const db=await h.pool.connect();
   try{await db.query('BEGIN');await db.query("INSERT INTO public.commerce_orders(id,client_id,status,currency_code,total_amount_minor) VALUES($1,$2,'paid','XXX',900)",[f.order,f.client]);await db.query('INSERT INTO public.commerce_order_items(order_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor) VALUES($1,1,1,900,900)',[f.order]);await db.query('COMMIT');}catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
   await h.pool.query("INSERT INTO public.fulfillment_shipments(id,order_id,port_key,provider_type,create_idempotency_key) VALUES($1,$2,'fixture-port','3pl',$3)",[f.shipment,f.order,`create-${f.shipment}`]);
   expect((await h.pool.query('SELECT subscription_cycle_id FROM public.commerce_orders WHERE id=$1',[f.order])).rows[0].subscription_cycle_id).toBeNull();
  }
  await h.pool.query('SELECT public.subscription_delivery_alignment_set_mode($1)',[mode]);
  const sibling=await replacement(h.pool,f);
  const cancel={idempotencyKey:`cancel-${f.shipment}`,shipmentId:f.shipment,reason:'local correction'};
  await spine.cancel(cancel);await spine.cancel(cancel);
  expect((await h.pool.query('SELECT status,delivered_at FROM public.fulfillment_shipments WHERE id=$1',[f.shipment])).rows).toEqual([{status:'cancelled',delivered_at:null}]);
  expect((await h.pool.query('SELECT * FROM public.commerce_order_holds WHERE order_id=$1',[f.order])).rows).toEqual([]);
  expect((await h.pool.query("SELECT * FROM public.outbox_events WHERE aggregate_id=$1 AND event_type='commerce.shipment.exception'",[f.order])).rows).toEqual([]);
  await h.pool.query("INSERT INTO public.fulfillment_dispatch_contexts(shipment_id,contact_revision,provider_ref) VALUES($1,$2,'warehouse-a')",[sibling,evidence.contactRevision]);
  const claim=await native.claim({requestKey:`dispatch-${sibling}`,fulfillmentRef:sibling,orderRef:f.order,parcelRef:null,mode:'live',evidence});
  if(claim.kind!=='claimed')throw new Error('inert sweep claim refused');
  expect(await native.begin({dispatchRef:claim.record.dispatchRef,commandFingerprint:evidence.commandFingerprint})).toMatchObject({kind:'begun',begun:true});
  const arrived=await replacement(h.pool,f,f.shipment,2);
  await arrival(arrived);
  expect(await cases(f.order)).toEqual([]);
  if(mode==='off'){
   expect(await admit(f.subscription)).toMatchObject({allowed:true,state:'off'});
   await h.pool.query("INSERT INTO public.subscription_cycles(subscription_id,scheduled_at,status) VALUES($1,'2026-08-29T12:00:00Z','payment_pending')",[f.subscription]);
   expect((await h.pool.query('SELECT * FROM public.subscription_delivery_alignment_cases WHERE subscription_id=$1',[f.subscription])).rows).toEqual([]);
  }
  expect((await h.pool.query('SELECT * FROM public.subscription_delivery_alignment_admission_receipts WHERE subscription_id=$1',[f.subscription])).rows).toEqual([]);
  // Only the explicit provider exception may create the native hold and event.
  await spine.raiseException({idempotencyKey:`provider-${sibling}`,shipmentId:sibling,reason:'provider_rejected'});
  const holds=(await h.pool.query('SELECT * FROM public.commerce_order_holds WHERE order_id=$1',[f.order])).rows;
  expect(holds).toHaveLength(1);expect(holds[0]).toMatchObject({reason:'fulfillment_exception',status:'active',created_by:null});
  const events=(await h.pool.query("SELECT payload FROM public.outbox_events WHERE aggregate_id=$1 AND event_type='commerce.shipment.exception'",[f.order])).rows;
  expect(events).toHaveLength(1);expect(events[0].payload.holdUuid).toBe(holds[0].id);
  expect(await cases(f.order)).toEqual([]);
  expect((await h.pool.query('SELECT * FROM public.subscription_delivery_alignment_admission_receipts WHERE subscription_id=$1',[f.subscription])).rows).toEqual([]);
  expect(await schedule(h.pool,f.subscription)).toMatchObject({status:'active',next_cycle_at:new Date('2026-08-29T12:00:00Z')});
  expect((await h.pool.query('SELECT * FROM public.subscription_pause_windows WHERE subscription_id=$1',[f.subscription])).rows).toEqual([]);
 }
});
it.each(['protect','auto_align'])('local cancellation remains outstanding at %s admission without manufacturing an exception hold',async(mode)=>{
 await h.pool.query("SELECT public.subscription_delivery_alignment_set_mode('off')");const f=await fixture(h.pool);
 await h.pool.query('SELECT public.subscription_delivery_alignment_set_mode($1)',[mode]);
 await createPostgresFulfillmentShipmentSpinePort(executor(h.pool),{portKey:'fixture-port'}).cancel({idempotencyKey:`cancel-${f.shipment}`,shipmentId:f.shipment,reason:'local correction'});
 expect(await cases(f.order)).toEqual([]);
 expect((await h.pool.query('SELECT * FROM public.commerce_order_holds WHERE order_id=$1',[f.order])).rows).toEqual([]);
 expect((await h.pool.query("SELECT * FROM public.outbox_events WHERE aggregate_id=$1 AND event_type='commerce.shipment.exception'",[f.order])).rows).toEqual([]);
 expect(await admit(f.subscription)).toMatchObject({allowed:false,state:'protected'});
 expect(await cases(f.order)).toMatchObject([{shipment_id:f.shipment,captured_mode:mode,state:'protected',evidence_kind:'overdue_renewal'}]);
 await expect(h.pool.query("INSERT INTO public.subscription_cycles(subscription_id,scheduled_at,status) VALUES($1,'2026-08-29T12:00:00Z','payment_pending')",[f.subscription])).rejects.toThrow('alignment_protected');
 expect((await h.pool.query('SELECT * FROM public.subscription_delivery_alignment_admission_receipts WHERE subscription_id=$1',[f.subscription])).rows).toEqual([]);
 expect((await schedule(h.pool,f.subscription)).status).toBe('active');
});
it.each(['shadow','protect','auto_align'])('explicit provider exception hold opens a %s case without pausing',async(mode)=>{
 await h.pool.query("SELECT public.subscription_delivery_alignment_set_mode('off')");const f=await fixture(h.pool);
 await h.pool.query('SELECT public.subscription_delivery_alignment_set_mode($1)',[mode]);
 const spine=createPostgresFulfillmentShipmentSpinePort(executor(h.pool),{portKey:'fixture-port'});
 const exception={idempotencyKey:`provider-${f.shipment}`,shipmentId:f.shipment,reason:'provider_rejected'};
 await spine.raiseException(exception);await spine.raiseException(exception);
 expect(await cases(f.order)).toMatchObject([{shipment_id:f.shipment,captured_mode:mode,state:mode==='shadow'?'shadow':'protected',evidence_kind:'fulfillment_exception'}]);
 expect(await cases(f.order)).toHaveLength(1);
 expect((await h.pool.query('SELECT * FROM public.commerce_order_holds WHERE order_id=$1',[f.order])).rows).toHaveLength(1);
 expect((await h.pool.query("SELECT * FROM public.outbox_events WHERE aggregate_id=$1 AND event_type='commerce.shipment.exception'",[f.order])).rows).toHaveLength(1);
 expect(await schedule(h.pool,f.subscription)).toMatchObject({status:'active',next_cycle_at:new Date('2026-08-29T12:00:00Z')});
 expect((await h.pool.query('SELECT * FROM public.subscription_pause_windows WHERE subscription_id=$1',[f.subscription])).rows).toEqual([]);
});

it.each(['shadow','protect','auto_align'])('unordered paid exception history stays observation-only in shadow and requires manual review in %s',async(mode)=>{
 await h.pool.query("SELECT public.subscription_delivery_alignment_set_mode('off')");const f=await fixture(h.pool,null);
 expect((await h.pool.query('SELECT renewal_operation_id,cycle_number FROM public.subscription_delivery_alignment_cycles WHERE id=$1',[f.cycle])).rows).toEqual([{renewal_operation_id:null,cycle_number:null}]);
 expect((await h.pool.query("SELECT * FROM public.subscription_activations WHERE subscription_id=$1 AND state='active'",[f.subscription])).rows).toEqual([]);
 await openCase(h.pool,f,mode);
 expect(await cases(f.order)).toHaveLength(1);
 expect(await cases(f.order)).toMatchObject([{shipment_id:f.shipment,predecessor_cycle_number:null,captured_mode:mode,state:mode==='shadow'?'shadow':'manual_review',manual_review_reason:mode==='shadow'?null:'missing_renewal_correlation',evidence_kind:'fulfillment_exception'}]);
 if(mode==='shadow'){
  expect(await admit(f.subscription)).toMatchObject({allowed:true,state:'shadow',reason:'missing_renewal_correlation'});
  await h.pool.query("SELECT public.subscription_delivery_alignment_set_mode('off')");
  await h.pool.query("INSERT INTO public.subscription_cycles(subscription_id,scheduled_at,status) VALUES($1,'2026-08-29T12:00:00Z','payment_pending')",[f.subscription]);
  expect((await h.pool.query("SELECT * FROM public.subscription_delivery_alignment_cases WHERE subscription_id=$1 AND state IN ('protected','manual_review')",[f.subscription])).rows).toEqual([]);
 }else{
  expect(await admit(f.subscription)).toMatchObject({allowed:false,state:'manual_review'});
  await expect(h.pool.query("INSERT INTO public.subscription_cycles(subscription_id,scheduled_at,status) VALUES($1,'2026-08-29T12:00:00Z','payment_pending')",[f.subscription])).rejects.toThrow('subscription_delivery_alignment_protected');
 }
 expect((await h.pool.query('SELECT * FROM public.subscription_delivery_alignment_admission_receipts WHERE subscription_id=$1',[f.subscription])).rows).toEqual([]);
});

it('native renewal preparation under auto_align requires explicit admission and consumes its receipt only once',async()=>{
 await h.pool.query("SELECT public.subscription_delivery_alignment_set_mode('off')");const f=await fixture(h.pool);
 await arrival(f.shipment);
 const operation=randomUUID(),token=randomUUID(),skuId=randomUUID(),sku=`SKU-${skuId}`;
 const at='2026-08-29T12:00:00.000Z',now=new Date().toISOString(),fingerprint='b'.repeat(64);
 const snapshot={contractVersion:'platform.subscription.renewal.v1',subscriptionId:f.subscription,clientId:f.client,scheduledAt:at,cycleNumber:2,currency:'XXX',totalAmountMinor:900,stockSourceKey:'fixture',settlementChannelKey:'fixture',authorizationRef:'fixture-authorized',payerAccountRef:null,lines:[{lineOrdinal:1,sku,quantity:1,unitAmountMinor:900}]};
 await h.pool.query("INSERT INTO public.catalog_products(id,slug,name) VALUES($1,$2,'Fixture')",[skuId,sku]);
 await h.pool.query("INSERT INTO public.catalog_skus(id,product_id,sku,title) VALUES($1,$1,$2,'Fixture')",[skuId,sku]);
 // A reserved operation is the native settlement store's preparation input.
 await h.pool.query(`INSERT INTO public.subscription_renewal_operations(id,subscription_id,scheduled_at,cycle_number,identity_key,operation_fingerprint,cycle_snapshot,state,claim_token,claimed_by,claimed_at,lease_expires_at)
 VALUES($1,$2,$3,2,$4,$5,$6,'reserved',$7,'fixture',now(),now()+interval '1 hour')`,[operation,f.subscription,at,`subscription:${f.subscription}:cycle:${at}`,fingerprint,snapshot,token]);
 await h.pool.query("INSERT INTO public.fulfillment_inventory_reservations(renewal_operation_id,operation_fingerprint,source_key,expires_at) VALUES($1,$2,'fixture',now()+interval '1 hour')",[operation,fingerprint]);
 await h.pool.query("SELECT public.subscription_delivery_alignment_set_mode('auto_align')");
 const native=createPostgresRenewalSettlementPort(executor(h.pool));const input={operationId:operation,claimToken:token,now};
 await expect(native.prepareRenewal(input)).rejects.toThrow('subscription_delivery_alignment_admission_required');
 expect((await h.pool.query('SELECT * FROM public.subscription_cycles WHERE renewal_operation_id=$1',[operation])).rows).toEqual([]);
 expect((await h.pool.query('SELECT state FROM public.subscription_renewal_operations WHERE id=$1',[operation])).rows).toEqual([{state:'reserved'}]);
 expect((await h.pool.query('SELECT * FROM public.subscription_delivery_alignment_admission_receipts WHERE subscription_id=$1',[f.subscription])).rows).toEqual([]);
 expect(await admit(f.subscription,at)).toMatchObject({allowed:true,reason:'predecessor_delivered'});
 const admitted=(await h.pool.query('SELECT * FROM public.subscription_delivery_alignment_admission_receipts WHERE subscription_id=$1',[f.subscription])).rows;
 expect(admitted).toHaveLength(1);expect(admitted[0]).toMatchObject({scheduled_at:new Date(at),consumed_at:null});
 const prepared=await native.prepareRenewal(input);expect(prepared).toMatchObject({operationId:operation,state:'attempt_prepared',replayed:false});
 const consumed=(await h.pool.query('SELECT * FROM public.subscription_delivery_alignment_admission_receipts WHERE subscription_id=$1',[f.subscription])).rows;
 expect(consumed).toHaveLength(1);expect(consumed[0]).toMatchObject({id:admitted[0].id,scheduled_at:new Date(at)});expect(consumed[0].consumed_at).not.toBeNull();
 expect(await native.prepareRenewal(input)).toEqual({...prepared,replayed:true});
 expect((await h.pool.query('SELECT * FROM public.subscription_delivery_alignment_admission_receipts WHERE subscription_id=$1',[f.subscription])).rows).toEqual(consumed);
 expect((await h.pool.query('SELECT id FROM public.subscription_cycles WHERE renewal_operation_id=$1',[operation])).rows).toEqual([{id:prepared.cycleId}]);
 await expect(h.pool.query("INSERT INTO public.subscription_cycles(subscription_id,scheduled_at,status) VALUES($1,$2,'payment_pending')",[f.subscription,at])).rejects.toThrow('subscription_delivery_alignment_admission_required');
});
