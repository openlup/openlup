import { randomUUID } from 'node:crypto';
import type { Pool,PoolClient } from 'pg';
import { expect,it } from 'vitest';
import { createPostgresStockWaitStore,type NativeRenewalCodec,type SubscriptionQueryExecutor } from '@openlup/platform/subscriptions';
import { createPostgresStockAvailability,createPostgresRenewalReservationPort } from '@openlup/platform/inventory';
import type { RenewalFrozenSnapshot,RenewalReadback,RenewalDue } from '@openlup/platform/subscriptions/contracts';
import { AT,call,later,renewal,unchangedIdentity,type Renewal } from './subscriptionNativeFixture.js';
function codec(f:Renewal):NativeRenewalCodec {
 const snapshot:RenewalFrozenSnapshot={contractVersion:'platform.subscription.renewal.v1',subscriptionId:f.subscription,clientId:f.client,
  scheduledAt:AT,scheduledInstant:Date.parse(AT),frozenRevision:'original',frozenFingerprint:f.fingerprint,
  cycle:{status:'correlated',logicalCycleNumber:3,nativeRenewalCounter:2,activationCycleId:null,evidenceRef:'fixture'},retryAttempt:0,externalAttemptSequence:0,
  templateSnapshot:{templateId:'frozen',version:1,cadenceDays:28,lines:f.snapshot.lines},pricingSnapshot:{currency:'XXX',totalAmountMinor:f.snapshot.totalAmountMinor,shippingAmountMinor:0,agreementPolicy:'lock_until_edit',proration:'none'},
  orderSnapshot:{shippingAddressRef:null,shippingQuoteRef:null,acquisitionRef:null,lines:f.snapshot.lines},stockSourceKey:f.source,settlementChannelKey:'fixture',authorizationRef:'frozen-mandate',payerAccountRef:null,unattendedChargeAuthorizedAt:AT};
 return {due:r=>({...r,subscriptionId:String(r.subscription_id)}) as unknown as RenewalDue,freeze:()=>{throw Error('must use frozen');},encode:()=>f.snapshot,
  decode:value=>{expect(value).toEqual(f.snapshot);return snapshot;},identity:()=>f.identity,fingerprint:()=>f.fingerprint,
  readback:r=>({...r,cycle:snapshot.cycle,cycleSnapshot:snapshot}) as unknown as RenewalReadback};
}
export function registerStockWaitCases(h:{pool:Pool}) {
 const stock=(f:Renewal)=>createPostgresStockAvailability(h.pool,{sourceKey:f.source,now:()=>AT});
 const store=(f:Renewal)=>createPostgresStockWaitStore({executor:h.pool,codec:codec(f),workerId:'stock-fixture',
  async withTransaction<T>(work:(db:SubscriptionQueryExecutor)=>Promise<T>) {
   const db=await h.pool.connect();try {await db.query('BEGIN');const result=await work(db);await db.query('COMMIT');return result;}
   catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
  }});
 const input=(f:Renewal)=>({operationId:f.operation,claimToken:f.token,snapshot:codec(f).decode(f.snapshot),now:AT});
 it.each(['inventory_unavailable','reservation_expired'])('F14 recovers a real %s without losing its original frozen graph or active service',async reason=>{
  const f=await renewal(h.pool,reason==='inventory_unavailable'?0:10,2),s=store(f);
  let caseId:string;
  if(reason==='inventory_unavailable') {
   const waiting=await s.admit(input(f));expect(waiting.waiting).toBe(true);caseId=waiting.caseId!;
   expect((await s.readFrozenCase({caseId,cycleId:null,orderId:null,paymentId:null,engineIdempotencyKey:f.identity}))?.deficits).toHaveLength(2);
  } else {
   await createPostgresRenewalReservationPort(h.pool).reserve({operationId:f.operation,claimToken:f.token,now:AT});
   expect(await createPostgresRenewalReservationPort(h.pool).expireReservations({now:later(1)})).toBeGreaterThan(0);
   expect((await call(h.pool,'subscription_read_renewal',[f.identity])).terminalReason).toBe(reason);
   // Discovery has no case yet; admit must use the original envelope, never current terms.
   const candidates=await call(h.pool,'subscription_stock_wait_candidates',[500,later(1)]);
   const candidate=candidates.find((r:{operationId:string})=>r.operationId===f.operation);expect(candidate.binding.caseId).toBeNull();
   const result=await s.admit({...input(f),now:later(1),recovery:candidate.binding});caseId=result.caseId!;
   expect(result.waiting).toBe(false);
  }
  await h.pool.query('UPDATE public.subscription_renewal_term_lines SET unit_amount_minor=999 WHERE subscription_id=$1',[f.subscription]);
  await h.pool.query('UPDATE public.fulfillment_stock_current SET for_sale_quantity=10 WHERE source_key=$1',[f.source]);
  if(reason==='inventory_unavailable') {
   expect(await s.recoverRefusedSchedule({operationId:f.operation,caseId,claimGeneration:1,frozenFingerprint:f.fingerprint,scheduledAt:AT,now:AT})).toEqual({outcome:'refused',reason:'lease_active'});
   const result=await s.recoverRefusedSchedule({operationId:f.operation,caseId,claimGeneration:1,frozenFingerprint:f.fingerprint,scheduledAt:AT,now:later(1)});
   expect(result).toMatchObject({outcome:'recovered',replayed:false});
   expect(await s.recoverRefusedSchedule({operationId:f.operation,caseId,claimGeneration:1,frozenFingerprint:f.fingerprint,scheduledAt:AT,now:later(1)})).toMatchObject({outcome:'recovered',replayed:true});
  }
  const op=await call(h.pool,'subscription_read_renewal',[f.identity]);expect(op).toMatchObject({claimGeneration:2,state:'reserved',operationFingerprint:f.fingerprint});
  await expect(createPostgresRenewalReservationPort(h.pool).reserve({operationId:f.operation,claimToken:f.token,now:later(1)})).rejects.toMatchObject({code:'40001'});
  const prepared=await call(h.pool,'commerce_prepare_subscription_renewal',[f.operation,op.claimToken,later(1)]);
  const unpaid=await allPublicRows(h.pool);
  expect(await s.markResumed(prepared.orderId)).toBeNull();
  expect(await allPublicRows(h.pool)).toEqual(unpaid);
  await call(h.pool,'commerce_acknowledge_subscription_renewal_attempt',[f.operation,f.fingerprint,'stock-ack',later(1)]);
  await call(h.pool,'commerce_record_subscription_renewal_outcome',[f.operation,`stock-paid-${f.operation}`,f.fingerprint,'succeeded','stock-ack',null,later(26)]);
  await h.pool.query("INSERT INTO public.fulfillment_ports(port_key,provider_type,routable) VALUES('stock-fixture','3pl',true) ON CONFLICT DO NOTHING");
  await h.pool.query("INSERT INTO public.fulfillment_shipments(order_id,port_key,provider_type,create_idempotency_key) VALUES($1,'stock-fixture','3pl',$2)",[prepared.orderId,`ship-${f.operation}`]);
  const resumed=await s.markResumed(prepared.orderId);expect(resumed).toMatchObject({state:'resumed',caseId});
  const before=await allPublicRows(h.pool);expect(await s.markResumed(prepared.orderId)).toEqual(resumed);expect(await allPublicRows(h.pool)).toEqual(before);
  // Settlement shifts by whole days late, preserving the scheduled time of day.
  // A 26-hour delay must extend this frozen cycle by one day, not two hours.
  expect((await h.pool.query('SELECT next_cycle_at FROM public.subscriptions WHERE id=$1',[f.subscription])).rows[0].next_cycle_at.toISOString()).toBe(later(29*24));
  expect((await h.pool.query("SELECT event_type FROM public.outbox_events WHERE aggregate_id=$1 AND event_type='subscription_stock_wait.resumed'",[caseId])).rows).toHaveLength(1);
  await unchangedIdentity(h.pool,f);
 });
 it.each(['missing','stale'])('technical %s stock cannot create a shortage case',async kind=>{
  const f=await renewal(h.pool),s=store(f);
  if(kind==='missing')await h.pool.query('DELETE FROM public.fulfillment_stock_current WHERE source_key=$1',[f.source]);
  else await h.pool.query('UPDATE public.fulfillment_stock_current SET last_synced_at=$2,stale_after=$3 WHERE source_key=$1',[f.source,later(-1),AT]);
  const before=await allPublicRows(h.pool);
  await expect(s.admit(input(f))).rejects.toThrow(`stock_wait_stock_${kind}`);
  expect(await allPublicRows(h.pool)).toEqual(before);await unchangedIdentity(h.pool,f);
 });
 it.each(['stale_snapshot','external_ownership'])('refuses %s recovery without any durable mutation',async reason=>{
  const f=await renewal(h.pool,0),s=store(f),wait=await s.admit(input(f));
  await h.pool.query('UPDATE public.fulfillment_stock_current SET for_sale_quantity=10 WHERE source_key=$1',[f.source]);
  let generation=1;
  if(reason==='external_ownership') {
   const secured=await s.reserveAndTransition({caseId:wait.caseId!,frozenFingerprint:f.fingerprint,now:later(1)});
   expect(secured.state).toBe('stock_secured');
   const op=await call(h.pool,'subscription_read_renewal',[f.identity]);generation=op.claimGeneration;
   await call(h.pool,'commerce_prepare_subscription_renewal',[f.operation,op.claimToken,later(1)]);
  }
  const before=await allPublicRows(h.pool);
  expect(await s.recoverRefusedSchedule({operationId:f.operation,caseId:wait.caseId!,claimGeneration:generation,
   frozenFingerprint:reason==='stale_snapshot'?'0'.repeat(64):f.fingerprint,scheduledAt:AT,now:later(2)})).toEqual({outcome:'refused',reason});
  expect(await allPublicRows(h.pool)).toEqual(before);await unchangedIdentity(h.pool,f);
 });
 it('rolls back a complete reacquisition subtransaction on shortage without erasing the durable wait or refusal',async()=>{
  const f=await renewal(h.pool,0,2),s=store(f),waiting=await s.admit(input(f));
  await h.pool.query('UPDATE public.fulfillment_stock_current SET for_sale_quantity=10 WHERE source_key=$1',[f.source]);
  // Fault after the allocator writes every frozen line, inside N3's subtransaction.
  const db=await h.pool.connect();try {
   await db.query('BEGIN');
   await db.query(`CREATE FUNCTION pg_temp.stock_operation_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF (SELECT count(*) FROM public.fulfillment_inventory_reservation_lines l JOIN public.fulfillment_inventory_reservations r ON r.id=l.reservation_id WHERE r.renewal_operation_id=NEW.id)<>2 THEN
     RAISE EXCEPTION 'fixture_lines_not_reached'; END IF;
    RAISE EXCEPTION 'stock_wait_atomic_shortage' USING ERRCODE='23514'; END; $$`);
   await db.query(`CREATE TRIGGER stock_operation_fault AFTER UPDATE ON public.subscription_renewal_operations FOR EACH ROW
    WHEN (NEW.id='${f.operation}'::uuid AND NEW.state='reserved') EXECUTE FUNCTION pg_temp.stock_operation_fault()`);
   const before=(await db.query('SELECT to_jsonb(op) r FROM public.subscription_renewal_operations op WHERE id=$1',[f.operation])).rows;
   expect(await call(db,'subscription_stock_wait_recover_refusal',[f.operation,f.fingerprint,'worker',later(1)])).toMatchObject({waiting:true,caseId:waiting.caseId});
   expect((await db.query('SELECT to_jsonb(op) r FROM public.subscription_renewal_operations op WHERE id=$1',[f.operation])).rows).toEqual(before);
   expect((await db.query('SELECT * FROM public.fulfillment_inventory_reservations WHERE renewal_operation_id=$1',[f.operation])).rows).toEqual([]);
   expect((await db.query('SELECT count(*)::int n FROM public.subscription_renewal_outcomes WHERE renewal_operation_id=$1',[f.operation])).rows[0].n).toBe(1);
   expect((await db.query('SELECT state FROM public.subscription_stock_wait_cases WHERE id=$1',[waiting.caseId])).rows[0].state).toBe('waiting');
  } finally {await db.query('ROLLBACK');db.release();}
  expect((await s.reserveAndTransition({caseId:waiting.caseId!,frozenFingerprint:f.fingerprint,now:later(1)})).state).toBe('stock_secured');
  await unchangedIdentity(h.pool,f);
 });
 it('rotates waiting cases and preserves normal throughput independently of shortage cohorts',async()=>{
  // Isolate candidate ordering from previous cases in this shared database.
  const db=await h.pool.connect();try {
   await db.query('BEGIN');await db.query("UPDATE public.subscriptions SET status='cancelled'");
   const fixtures:Renewal[]=[];
   for(let n=0;n<3;n++) {
    // Other connections cannot see the isolation update; insert through the pool,
    // then select only this cohort using its as-of before older selection stamps.
    const f=await renewal(h.pool,0);await store(f).admit(input(f));fixtures.push(f);
   }
   const selected:string[]=[];
   for(let n=0;n<3;n++)selected.push((await call(db,'subscription_stock_wait_candidates',[1,later(1+n)]))[0]?.operationId);
   expect(new Set(selected)).toEqual(new Set(fixtures.map(f=>f.operation)));
   const normal=await renewal(h.pool);
   expect((await call(db,'subscription_stock_wait_normal_due',[500,later(1)])).some((r:{subscription_id:string})=>r.subscription_id===normal.subscription)).toBe(true);
  } finally {await db.query('ROLLBACK');db.release();}
 });
 it.each(['missing','stale'])('uncaptured %s stock recovery cannot starve a replenished refusal; old stamping mutant fails',async kind=>{
  // Both operations are real allocator refusals, deliberately never admitted to N3.
  const fixtures=[await renewal(h.pool,0),await renewal(h.pool,0)];
  for(const f of fixtures) {
   expect(await createPostgresRenewalReservationPort(h.pool).reserve({operationId:f.operation,claimToken:f.token,now:AT})).toMatchObject({reserved:false});
   expect(await call(h.pool,'subscription_read_renewal',[f.identity])).toMatchObject({state:'refused',terminalReason:'inventory_unavailable'});
  }
  fixtures.sort((a,b)=>a.operation.localeCompare(b.operation));
  const [failing,replenished]=fixtures;
  if(kind==='missing')await h.pool.query('DELETE FROM public.fulfillment_stock_current WHERE source_key=$1',[failing.source]);
  else await h.pool.query('UPDATE public.fulfillment_stock_current SET last_synced_at=$2,stale_after=$3 WHERE source_key=$1',[failing.source,later(-1),AT]);
  await h.pool.query('UPDATE public.fulfillment_stock_current SET for_sale_quantity=10 WHERE source_key=$1',[replenished.source]);
  const db=await h.pool.connect();try {
   await db.query('BEGIN');
   await db.query("UPDATE public.subscriptions SET status='cancelled' WHERE NOT(id=ANY($1::uuid[]))",[fixtures.map(f=>f.subscription)]);
   expect((await db.query('SELECT id FROM public.subscription_stock_wait_cases WHERE renewal_operation_id=ANY($1::uuid[])',[fixtures.map(f=>f.operation)])).rows).toEqual([]);
   const definition=(await db.query("SELECT pg_get_functiondef('public.subscription_stock_wait_candidates(integer,timestamptz)'::regprocedure) body")).rows[0].body as string;
   const stamp=async(f:Renewal)=>(await db.query('SELECT updated_at FROM public.subscription_renewal_operations WHERE id=$1',[f.operation])).rows[0].updated_at.toISOString();
   const witness=async()=>{
    const originalStamp=await stamp(failing);
    for(const [index,f] of [failing,replenished,failing].entries()) {
     const now=later([1,2,2+1/60][index]),selected=await call(db,'subscription_stock_wait_candidates',[1,now]);
     expect(selected).toHaveLength(1);expect(selected[0]).toMatchObject({operationId:f.operation,binding:{caseId:null}});
     // Discovery stamps before recovery, even when recovery never creates a case.
     expect(await stamp(f)).toBe(now);
     await db.query('SAVEPOINT uncaptured_recovery');
     if(f===failing) {
      await expect(call(db,'subscription_stock_wait_recover_refusal',[f.operation,f.fingerprint,'rotation-fixture',now])).rejects.toThrow(`stock_wait_stock_${kind}`);
      await db.query('ROLLBACK TO uncaptured_recovery');
      expect((await db.query('SELECT id FROM public.subscription_stock_wait_cases WHERE renewal_operation_id=$1',[f.operation])).rows).toEqual([]);
     } else {
      expect(await call(db,'subscription_stock_wait_recover_refusal',[f.operation,f.fingerprint,'rotation-fixture',now])).toMatchObject({state:'reserved'});
      expect((await db.query('SELECT state FROM public.subscription_stock_wait_cases WHERE renewal_operation_id=$1',[f.operation])).rows[0].state).toBe('stock_secured');
     }
     await db.query('RELEASE SAVEPOINT uncaptured_recovery');
    }
    expect(await stamp(failing)).not.toBe(originalStamp);
   };
   await db.query('SAVEPOINT rotation_witness');
   await witness();
   await db.query('ROLLBACK TO rotation_witness');await db.query('RELEASE SAVEPOINT rotation_witness');
   const mutant=definition.replace('CASE WHEN c.id IS NULL THEN op.updated_at ELSE c.last_selected_at END','c.last_selected_at')
    .replace(/IF row\.case_id IS NOT NULL THEN[\s\S]*?UPDATE public\.subscription_renewal_operations SET updated_at=p_now WHERE id=row\.id;\s*END IF;/u,
     'UPDATE public.subscription_stock_wait_cases SET last_selected_at=p_now WHERE id=row.case_id;');
   expect(mutant).not.toBe(definition);
   expect(mutant).not.toContain('SET updated_at=p_now WHERE id=row.id');
   await db.query('SAVEPOINT case_only_mutant');try {
    await db.query(mutant);await expect(witness()).rejects.toThrow();
   }finally{await db.query('ROLLBACK TO case_only_mutant');await db.query('RELEASE SAVEPOINT case_only_mutant');}
   expect((await db.query("SELECT pg_get_functiondef('public.subscription_stock_wait_candidates(integer,timestamptz)'::regprocedure) body")).rows[0].body).toBe(definition);
  }finally{await db.query('ROLLBACK');db.release();}
  for(const f of fixtures)await unchangedIdentity(h.pool,f);
 });
 it('protects soft future demand and hard holds in the native new-purchase read while the allocator uses the same seam',async()=>{
  const f=await renewal(h.pool,5),sku=f.snapshot.lines[0].sku,s=stock(f);
  expect(await s.availableToPromise(sku,AT)).toMatchObject({availableQuantity:3,hardHoldQuantity:0,softSubscriptionDemandQuantity:2});
  expect((await s.readPort.read({skus:[sku],horizonDays:14,excludeOrderId:null})).get(sku)).toMatchObject({available:3,availableForNewPurchases:3});
  expect(await createPostgresRenewalReservationPort(h.pool).reserve({operationId:f.operation,claimToken:f.token,now:AT})).toMatchObject({reserved:true});
  expect(await s.availableToPromise(sku,AT)).toMatchObject({availableQuantity:3,hardHoldQuantity:2,softSubscriptionDemandQuantity:0});
  await unchangedIdentity(h.pool,f);
 });
}
/** Zero-delta replay witness across every public base table, including outbox,
 * unrelated rows, timestamps and receipts; no hand-maintained table allowlist. */
export async function allPublicRows(db:Pool|PoolClient) {
 const tables=(await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;
 const result:Record<string,unknown>={};
 for(const {tablename} of tables) result[tablename]=(await db.query(`SELECT COALESCE(jsonb_agg(r ORDER BY r::text),'[]'::jsonb) rows FROM (SELECT jsonb_build_object('columns',to_jsonb(t),'xmin',t.xmin::text,'ctid',t.ctid::text) r FROM public."${String(tablename).replaceAll('"','""')}" t) x`)).rows[0].rows;
 return result;
}
