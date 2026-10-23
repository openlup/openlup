import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { expect,it } from 'vitest';
import { AT,alignmentInvariant,call,failure,later,positive,prepareOriginal,renewal,request,unchangedIdentity } from './subscriptionNativeFixture.js';
export function registerRetryCases(h:{pool:Pool}) {
async function declined(classification='temporary') {
 const f=await renewal(h.pool);const original=await prepareOriginal(h.pool,f);
 const input=failure(0,AT,classification),key=`failure-${f.operation}`;
 const row=await call(h.pool,'subscription_retry_apply_failure',[f.operation,key,input]);
 await call(h.pool,'subscription_retry_open_case',[f.operation,'failed','/recover']);
 return {...f,original,input,key,row};
}
it('F16 settles the original declined cycle, advances atomically, preserves keys and replays without another charge',async()=>{
 const f=await declined();
 expect((await h.pool.query('SELECT * FROM public.subscription_list_due_renewals($1,500)',[AT])).rows.some((r:{subscription_id:string})=>r.subscription_id===f.subscription)).toBe(false);
 const key=`prepare-${f.operation}`,input=request(f);
 await expect(call(h.pool,'subscription_retry_prepare',[f.operation,key,{...input,amountMinor:1},later(24)])).rejects.toThrow('not_due');
 const prepared=await call(h.pool,'subscription_retry_prepare',[f.operation,key,input,later(24)]);
 expect(prepared).toMatchObject({execute:true,cycleId:f.original.cycleId,orderId:f.original.orderId,settlementIntentId:f.original.settlementIntentId,identityKey:f.identity,snapshot:f.snapshot});
 expect(await call(h.pool,'subscription_retry_prepare',[f.operation,key,input,later(24)])).toMatchObject({execute:false,replayed:true,request:input});
 const observation=positive(f,key),paidKey=`paid-${f.operation}`;
 const paid=await call(h.pool,'subscription_retry_record_recovery',[f.operation,paidKey,observation]);
 expect(paid).toMatchObject({state:'recovered',next_retry_at:null});
 expect(await call(h.pool,'subscription_retry_record_recovery',[f.operation,paidKey,observation])).toEqual(paid);
 expect(await call(h.pool,'subscription_retry_apply_failure',[f.operation,f.key,f.input])).toEqual(f.row);
 expect((await h.pool.query('SELECT status FROM public.subscription_cycles WHERE id=$1',[f.original.cycleId])).rows[0].status).toBe('paid');
 expect((await h.pool.query('SELECT next_cycle_number FROM public.subscription_renewal_terms WHERE subscription_id=$1',[f.subscription])).rows[0].next_cycle_number).toBe(3);
 expect((await h.pool.query('SELECT next_cycle_at FROM public.subscriptions WHERE id=$1',[f.subscription])).rows[0].next_cycle_at.toISOString()).toBe(later(24+28*24));
 expect((await h.pool.query("SELECT count(*)::int n FROM public.commerce_settlement_transitions WHERE intent_id=$1 AND outcome='succeeded'",[f.original.settlementIntentId])).rows[0].n).toBe(1);
 expect((await h.pool.query('SELECT count(*)::int n FROM public.subscription_cycles WHERE subscription_id=$1',[f.subscription])).rows[0].n).toBe(1);
 const truth=(await h.pool.query('SELECT state,source_evidence FROM public.payment_truth_events WHERE source_event_id=$1',[observation.evidenceKey])).rows[0];
 expect(truth.state).toBe('settled');expect(truth.source_evidence.externalRef).toBe(observation.externalRef);
 expect((await h.pool.query('SELECT external_ref FROM public.commerce_settlement_intents WHERE id=$1',[f.original.settlementIntentId])).rows[0].external_ref).toBe('original-ack');
 await unchangedIdentity(h.pool,f);
});
it('serializes contending claims and fences ACK loss, new keys, changed requests and unknown observations',async()=>{
 const f=await declined(),key=`prepare-${f.operation}`,input=request(f);
 const raced=await Promise.all([call(h.pool,'subscription_retry_prepare',[f.operation,key,input,later(24)]),call(h.pool,'subscription_retry_prepare',[f.operation,key,input,later(24)])]);
 expect(raced.filter(r=>r.execute)).toHaveLength(1);
 await expect(call(h.pool,'subscription_retry_prepare',[f.operation,`other-${f.operation}`,request(f),later(25)])).rejects.toThrow('ambiguous');
 await expect(call(h.pool,'subscription_retry_prepare',[f.operation,key,{...input,paymentMethodRef:'different'},later(25)])).rejects.toMatchObject({code:'23505'});
 expect(await call(h.pool,'subscription_retry_note_row_outcome',[f.operation,'unknown',{outcome:'unknown'}])).toEqual({awaitingProvider:true,execute:false});
 await expect(call(h.pool,'subscription_retry_record_recovery',[f.operation,'late-original',positive(f,undefined)])).rejects.toThrow('positive_evidence');
 // A missing provider handle is ambiguous until an explicit verified refusal
 // arrives. That refusal can safely open the same-obligation ladder.
 const noAck=await renewal(h.pool);
 await call(h.pool,'fulfillment_reserve_subscription_renewal',[noAck.operation,noAck.token,900,AT]);
 await call(h.pool,'commerce_prepare_subscription_renewal',[noAck.operation,noAck.token,AT]);
 expect(await call(h.pool,'subscription_retry_note_row_outcome',[noAck.operation,'no-ack-unknown',{outcome:'unknown'}])).toEqual({awaitingProvider:true,execute:false});
 expect(await call(h.pool,'subscription_retry_read',[noAck.operation])).toBeNull();
 expect(await call(h.pool,'subscription_retry_apply_failure',[noAck.operation,`no-ack-refused-${noAck.operation}`,failure()])).toMatchObject({retry_attempt:1,state:'waiting'});
 await unchangedIdentity(h.pool,f);await unchangedIdentity(h.pool,noAck);
});
it('uses the 24/72/168-hour ladder from each failure, and exhaustion remains open with no retry or pause',async()=>{
 const f=await declined();let row=f.row;
 const intervals=[24,72,168];let now=0;
 for(let seq=1;seq<=3;seq++) {
  now+=intervals[seq-1];expect(new Date(row.next_retry_at).toISOString()).toBe(later(now));
  await call(h.pool,'subscription_retry_prepare',[f.operation,`prepare-${f.operation}-${seq}`,request(f,seq),later(now)]);
  now++;
  row=await call(h.pool,'subscription_retry_apply_failure',[f.operation,`fail-${f.operation}-${seq}`,failure(seq,later(now))]);
  await call(h.pool,'subscription_retry_open_case',[f.operation,'failed','/recover']);
 }
 expect(row).toMatchObject({retry_attempt:4,next_retry_at:null,state:'waiting'});
 const c=(await h.pool.query('SELECT status,next_retry_at,expired_at FROM public.subscription_dunning_cases WHERE cycle_id=$1',[f.original.cycleId])).rows[0];
 expect(c).toEqual({status:'open',next_retry_at:null,expired_at:null});
 await expect(call(h.pool,'subscription_retry_prepare',[f.operation,'exhausted',request(f),later(500)])).rejects.toThrow('not_due');
 const caseId=(await call(h.pool,'subscription_retry_read',[f.operation])).case_id;
 await call(h.pool,'dunning_lifecycle_issue_recovery_token',[caseId,'d'.repeat(64),'2027-01-01']);
 await h.pool.query("INSERT INTO public.subscription_method_states(subscription_id,health_state) VALUES($1,'healthy')",[f.subscription]);
 const token=(await h.pool.query('SELECT id FROM public.commerce_checkout_recovery_tokens WHERE token_hash=$1',['d'.repeat(64)])).rows[0].id;
 const auth=await call(h.pool,'subscription_retry_authorize_recovery',[f.operation,token,'method-1','usable-exhausted-evidence',later(now+1)]);
 await call(h.pool,'subscription_retry_schedule_recovery',[f.operation,`schedule-${f.operation}`,auth.id,later(now+1)]);
 const key=`authorized-${f.operation}`;
 await call(h.pool,'subscription_retry_prepare',[f.operation,key,request(f,4),later(now+1)]);
 await call(h.pool,'subscription_retry_record_recovery',[f.operation,`paid-${f.operation}`,positive(f,key,later(now+2))]);
 expect((await h.pool.query('SELECT next_cycle_number FROM public.subscription_renewal_terms WHERE subscription_id=$1',[f.subscription])).rows[0].next_cycle_number).toBe(3);
 await unchangedIdentity(h.pool,f);
});
it('a class stop needs a consumed same-case token and durable healthy method evidence before recovery',async()=>{
 const f=await declined('hard_do_not_retry');expect(f.row).toMatchObject({retry_attempt:1,next_retry_at:null});
 const tokenHash='b'.repeat(64);
 const caseId=(await call(h.pool,'subscription_retry_read',[f.operation])).case_id;
 await call(h.pool,'dunning_lifecycle_issue_recovery_token',[caseId,tokenHash,'2027-01-01']);
 const token=(await h.pool.query('SELECT id FROM public.commerce_checkout_recovery_tokens WHERE token_hash=$1',[tokenHash])).rows[0].id;
 await expect(call(h.pool,'subscription_retry_authorize_recovery',[f.operation,token,'method-1','usable-evidence',later(1)])).rejects.toThrow('not_authorized');
 await h.pool.query("INSERT INTO public.subscription_method_states(subscription_id,health_state) VALUES($1,'healthy')",[f.subscription]);
 const auth=await call(h.pool,'subscription_retry_authorize_recovery',[f.operation,token,'method-1','usable-evidence',later(1)]);
 expect(await call(h.pool,'subscription_retry_authorize_recovery',[f.operation,token,'method-1','usable-evidence',later(1)])).toEqual(auth);
 await expect(call(h.pool,'subscription_retry_schedule_recovery',[f.operation,'bad-authorization',randomUUID(),later(1)])).rejects.toThrow('not_authorized');
 await h.pool.query("UPDATE public.subscription_method_states SET health_state='method_missing' WHERE subscription_id=$1",[f.subscription]);
 await expect(call(h.pool,'subscription_retry_schedule_recovery',[f.operation,'stale-method',auth.id,later(1)])).rejects.toThrow('not_authorized');
 await h.pool.query("UPDATE public.subscription_method_states SET health_state='healthy' WHERE subscription_id=$1",[f.subscription]);
 const key=`schedule-${f.operation}`;
 const scheduled=await call(h.pool,'subscription_retry_schedule_recovery',[f.operation,key,auth.id,later(1)]);
 expect(await call(h.pool,'subscription_retry_schedule_recovery',[f.operation,key,auth.id,later(1)])).toEqual(scheduled);
 const prepareKey=`recover-${f.operation}`;
 await call(h.pool,'subscription_retry_prepare',[f.operation,prepareKey,request(f),later(1)]);
 await call(h.pool,'subscription_retry_record_recovery',[f.operation,`paid-${f.operation}`,positive(f,prepareKey,later(2))]);
 expect((await h.pool.query('SELECT consumed_at FROM public.subscription_retry_recovery_authorizations WHERE id=$1',[auth.id])).rows[0].consumed_at).not.toBeNull();
 await unchangedIdentity(h.pool,f);
});
it('a verified late positive settles without re-executing or moving an already later schedule earlier',async()=>{
 const f=await declined();await h.pool.query("UPDATE public.subscriptions SET next_cycle_at='2027-06-01' WHERE id=$1",[f.subscription]);
 await expect(call(h.pool,'subscription_retry_record_recovery',[f.operation,'bad-money',{...positive(f),amountMinor:null}])).rejects.toThrow('positive_evidence');
 await call(h.pool,'subscription_retry_record_recovery',[f.operation,`paid-${f.operation}`,positive(f)]);
 expect((await h.pool.query('SELECT next_cycle_at FROM public.subscriptions WHERE id=$1',[f.subscription])).rows[0].next_cycle_at.toISOString()).toBe('2027-06-01T00:00:00.000Z');
 expect((await h.pool.query("SELECT * FROM public.subscription_retry_receipts WHERE obligation_id=$1 AND kind='prepare'",[f.row.id])).rows).toEqual([]);
 await unchangedIdentity(h.pool,f);
});
it('refuses retry prepare admission without stock and permits a later complete prepare',async()=>{
 const f=await declined();await h.pool.query('UPDATE public.fulfillment_stock_current SET for_sale_quantity=0 WHERE source_key=$1',[f.source]);
 const key=`prepare-${f.operation}`,input=request(f);
 await expect(call(h.pool,'subscription_retry_prepare',[f.operation,key,input,later(24)])).rejects.toThrow('inventory_unavailable');
 expect((await call(h.pool,'subscription_retry_read',[f.operation])).state).toBe('waiting');
 expect((await h.pool.query('SELECT * FROM public.subscription_retry_receipts WHERE receipt_key=$1',[key])).rows).toEqual([]);
 await h.pool.query('UPDATE public.fulfillment_stock_current SET for_sale_quantity=10 WHERE source_key=$1',[f.source]);
 expect(await call(h.pool,'subscription_retry_prepare',[f.operation,key,input,later(24)])).toMatchObject({execute:true});
});
// Compare all durable graph and retry state, including empty sets before first prepare.
async function prepareState(operation:string) {
 const rows=await h.pool.query(`WITH op AS (SELECT * FROM public.subscription_renewal_operations WHERE id=$1),
  orders AS (SELECT * FROM public.commerce_orders WHERE renewal_operation_id=$1),
  obligations AS (SELECT * FROM public.subscription_retry_obligations WHERE renewal_operation_id=$1),
  reservations AS (SELECT * FROM public.fulfillment_inventory_reservations WHERE renewal_operation_id=$1)
  SELECT jsonb_build_object(
   'operation',(SELECT to_jsonb(op) FROM op),
   'subscription',(SELECT to_jsonb(s) FROM public.subscriptions s JOIN op ON s.id=op.subscription_id),
   'terms',(SELECT to_jsonb(t) FROM public.subscription_renewal_terms t JOIN op ON t.subscription_id=op.subscription_id),
   'cycles',(SELECT jsonb_agg(c ORDER BY id) FROM public.subscription_cycles c WHERE renewal_operation_id=$1),
   'orders',(SELECT jsonb_agg(o ORDER BY id) FROM orders o),
   'items',(SELECT jsonb_agg(i ORDER BY id) FROM public.commerce_order_items i WHERE order_id IN(SELECT id FROM orders)),
   'settlement',(SELECT jsonb_agg(i ORDER BY id) FROM public.commerce_settlement_intents i WHERE order_id IN(SELECT id FROM orders)),
   'transitions',(SELECT jsonb_agg(t ORDER BY id) FROM public.commerce_settlement_transitions t WHERE intent_id IN(SELECT id FROM public.commerce_settlement_intents WHERE order_id IN(SELECT id FROM orders))),
   'outcomes',(SELECT jsonb_agg(o ORDER BY id) FROM public.subscription_renewal_outcomes o WHERE renewal_operation_id=$1),
   'reservations',(SELECT jsonb_agg(r ORDER BY id) FROM reservations r),
   'reservationLines',(SELECT jsonb_agg(l ORDER BY sku) FROM public.fulfillment_inventory_reservation_lines l WHERE reservation_id IN(SELECT id FROM reservations)),
   'obligations',(SELECT jsonb_agg(o ORDER BY id) FROM obligations o),
   'authorizations',(SELECT jsonb_agg(a ORDER BY id) FROM public.subscription_retry_recovery_authorizations a WHERE obligation_id IN(SELECT id FROM obligations)),
   'receipts',(SELECT jsonb_agg(r ORDER BY id) FROM public.subscription_retry_receipts r WHERE obligation_id IN(SELECT id FROM obligations))
  ) AS state`,[operation]);
 return rows.rows[0].state;
}
it('rolls back the original graph after all commerce prepare writes and then prepares once',async()=>{
 const f=await renewal(h.pool,10,2);
 await call(h.pool,'fulfillment_reserve_subscription_renewal',[f.operation,f.token,900,AT]);
 const before=await prepareState(f.operation);
 expect(before).toMatchObject({cycles:null,orders:null,items:null,settlement:null,transitions:null,obligations:null,authorizations:null,receipts:null});
 await h.pool.query(`CREATE FUNCTION public.fixture_original_prepare_fault() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN
  IF (SELECT count(*) FROM public.subscription_cycles WHERE renewal_operation_id=NEW.id)<>1 OR
   (SELECT count(*) FROM public.commerce_orders WHERE renewal_operation_id=NEW.id)<>1 OR
   (SELECT count(*) FROM public.commerce_order_items WHERE order_id IN(SELECT id FROM public.commerce_orders WHERE renewal_operation_id=NEW.id))<>2 OR
   (SELECT count(*) FROM public.commerce_settlement_intents WHERE renewal_operation_id=NEW.id)<>1 OR
   NOT EXISTS(SELECT 1 FROM public.fulfillment_inventory_reservations WHERE renewal_operation_id=NEW.id AND status='committed')
  THEN RAISE EXCEPTION 'fixture_original_prepare_not_reached'; END IF;
  RAISE EXCEPTION 'synthetic_original_prepare_after_writes';
 END; $$`);
 try {
  await h.pool.query(`CREATE TRIGGER fixture_original_prepare_fault AFTER UPDATE ON public.subscription_renewal_operations
   FOR EACH ROW WHEN (NEW.id='${f.operation}'::uuid AND NEW.state='attempt_prepared') EXECUTE FUNCTION public.fixture_original_prepare_fault()`);
  await expect(call(h.pool,'commerce_prepare_subscription_renewal',[f.operation,f.token,AT])).rejects.toThrow('synthetic_original_prepare_after_writes');
  expect(await prepareState(f.operation)).toEqual(before);
 }finally{
  await h.pool.query('DROP TRIGGER IF EXISTS fixture_original_prepare_fault ON public.subscription_renewal_operations');
  await h.pool.query('DROP FUNCTION public.fixture_original_prepare_fault()');
 }
 const prepared=await call(h.pool,'commerce_prepare_subscription_renewal',[f.operation,f.token,AT]);
 expect(prepared).toMatchObject({replayed:false,state:'attempt_prepared'});
 expect(await call(h.pool,'commerce_prepare_subscription_renewal',[f.operation,f.token,AT])).toEqual({...prepared,replayed:true});
 const after=await prepareState(f.operation);
 expect(after.cycles).toHaveLength(1);expect(after.orders).toHaveLength(1);expect(after.items).toHaveLength(2);expect(after.settlement).toHaveLength(1);
 expect(after.transitions).toHaveLength(1);
 expect(after.reservations).toMatchObject([{status:'committed'}]);await unchangedIdentity(h.pool,f);
});
it('rolls back retry reservation, rung, authorization and receipt writes before a single successful prepare',async()=>{
 const f=await declined('hard_do_not_retry'),caseId=(await call(h.pool,'subscription_retry_read',[f.operation])).case_id;
 const tokenHash=randomUUID().replaceAll('-','').repeat(2);
 await call(h.pool,'dunning_lifecycle_issue_recovery_token',[caseId,tokenHash,'2027-01-01']);
 const token=(await h.pool.query('SELECT id FROM public.commerce_checkout_recovery_tokens WHERE token_hash=$1',[tokenHash])).rows[0].id;
 await h.pool.query("INSERT INTO public.subscription_method_states(subscription_id,health_state) VALUES($1,'healthy')",[f.subscription]);
 const auth=await call(h.pool,'subscription_retry_authorize_recovery',[f.operation,token,'method-1','usable-evidence',later(1)]);
 await call(h.pool,'subscription_retry_schedule_recovery',[f.operation,`schedule-${f.operation}`,auth.id,later(1)]);
 const before=await prepareState(f.operation),key=`prepare-${f.operation}`,input=request(f);
 expect(before.reservations).toMatchObject([{status:'released'}]);
 expect(before.obligations).toMatchObject([{state:'waiting',attempt_sequence:0}]);
 expect(before.authorizations).toMatchObject([{id:auth.id,consumed_at:null}]);
 await h.pool.query(`CREATE FUNCTION public.fixture_retry_prepare_fault() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.subscription_retry_obligations WHERE id=NEW.obligation_id AND state='prepared' AND attempt_sequence=1) OR
   NOT EXISTS(SELECT 1 FROM public.fulfillment_inventory_reservations r JOIN public.subscription_retry_obligations o
    ON o.renewal_operation_id=r.renewal_operation_id WHERE o.id=NEW.obligation_id AND r.status='committed') OR
   NOT EXISTS(SELECT 1 FROM public.subscription_retry_recovery_authorizations WHERE obligation_id=NEW.obligation_id AND consumed_at IS NOT NULL)
  THEN RAISE EXCEPTION 'fixture_retry_prepare_not_reached'; END IF;
  RAISE EXCEPTION 'synthetic_retry_prepare_after_writes';
 END; $$`);
 try {
  await h.pool.query(`CREATE TRIGGER fixture_retry_prepare_fault AFTER INSERT ON public.subscription_retry_receipts
   FOR EACH ROW WHEN (NEW.receipt_key='${key}') EXECUTE FUNCTION public.fixture_retry_prepare_fault()`);
  await expect(call(h.pool,'subscription_retry_prepare',[f.operation,key,input,later(1)])).rejects.toThrow('synthetic_retry_prepare_after_writes');
  expect(await prepareState(f.operation)).toEqual(before);
 }finally{
  await h.pool.query('DROP TRIGGER IF EXISTS fixture_retry_prepare_fault ON public.subscription_retry_receipts');
  await h.pool.query('DROP FUNCTION public.fixture_retry_prepare_fault()');
 }
 expect(await call(h.pool,'subscription_retry_prepare',[f.operation,key,input,later(1)])).toMatchObject({execute:true,replayed:false,attemptSequence:1});
 expect(await call(h.pool,'subscription_retry_prepare',[f.operation,key,input,later(1)])).toMatchObject({execute:false,replayed:true,attemptSequence:1});
 const after=await prepareState(f.operation);
 for(const field of ['cycles','orders','items','settlement','transitions','operation'])expect(after[field]).toEqual(before[field]);
 expect(after.reservations).toMatchObject([{status:'committed'}]);
 expect(after.authorizations).toHaveLength(1);expect(new Date(after.authorizations[0].consumed_at).toISOString()).toBe(later(1));
 expect(after.receipts.filter((r:{kind:string})=>r.kind==='prepare')).toHaveLength(1);
 await unchangedIdentity(h.pool,f);
});
it('keeps captured auto alignment through rollback to off, takes the maximum once and re-admits the deferred renewal',()=>alignmentInvariant(h.pool));

}
