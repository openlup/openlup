import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { expect,it } from 'vitest';
import { fixture,openCase,schedule } from '../helpers/fulfillmentNative.js';
import { call } from './subscriptionNativeFixture.js';
const at='2026-10-22T12:00:00.000Z';
export function registerAlignmentRollbackCases(h:{pool:Pool}) {
 const admit=(subscription:string,scheduled='2026-08-29T12:00:00Z',now=at)=>call(h.pool,'subscription_delivery_alignment_admit_renewal',[subscription,scheduled,now]);
 const arrival=(shipment:string)=>call(h.pool,'fulfillment_record_alignment_arrival',[`rollback-arrival-${shipment}`,shipment,'2026-09-08T12:00:00Z',`evidence:${shipment}`]);
 const cases=(subscription:string)=>h.pool.query('SELECT * FROM public.subscription_delivery_alignment_cases WHERE subscription_id=$1',[subscription]);
 it('a captured shadow case admits under off without moving the schedule',async()=>{
  await call(h.pool,'subscription_delivery_alignment_set_mode',['off']);const f=await fixture(h.pool);
  await openCase(h.pool,f,'shadow');await call(h.pool,'subscription_delivery_alignment_set_mode',['off']);
  const before=await schedule(h.pool,f.subscription);
  expect(await admit(f.subscription)).toMatchObject({allowed:true,state:'off'});
  expect((await cases(f.subscription)).rows).toMatchObject([{state:'shadow',captured_mode:'shadow'}]);
  expect(await schedule(h.pool,f.subscription)).toEqual(before);
 });
 it('protect releases on actual arrival and re-offers the identical claimed schedule after lease expiry',async()=>{
  await call(h.pool,'subscription_delivery_alignment_set_mode',['off']);const f=await fixture(h.pool);
  await h.pool.query(`INSERT INTO public.subscription_renewal_terms(subscription_id,next_cycle_number,currency_code,stock_source_key,
   settlement_channel_key,unattended_charge_authorized_at,authorization_ref) VALUES($1,2,'XXX','fixture','fixture',$2,'fixture')`,[f.subscription,at]);
  const sku=randomUUID();
  await h.pool.query("INSERT INTO public.catalog_products(id,slug,name) VALUES($1,$2,'Fixture')",[sku,sku]);
  await h.pool.query("INSERT INTO public.catalog_skus(id,product_id,sku,title) VALUES($1,$1,$2,'Fixture')",[sku,sku]);
  await h.pool.query('INSERT INTO public.subscription_renewal_term_lines(subscription_id,line_ordinal,sku,quantity,unit_amount_minor) VALUES($1,1,$2,1,900)',[f.subscription,sku]);
  const snapshot={contractVersion:'platform.subscription.renewal.v1',subscriptionId:f.subscription,clientId:f.client,scheduledAt:'2026-08-29T12:00:00.000Z',cycleNumber:2,currency:'XXX',totalAmountMinor:900,lines:[{lineOrdinal:1,sku,quantity:1,unitAmountMinor:900}]};
  const identity=await call(h.pool,'subscription_renewal_identity',[f.subscription,snapshot.scheduledAt]);
  const claim=await call(h.pool,'subscription_claim_due_renewal',[identity,'c'.repeat(64),snapshot,'rollback',300,at]);
  await openCase(h.pool,f,'protect');expect(await admit(f.subscription)).toMatchObject({allowed:false,state:'protected'});
  await call(h.pool,'subscription_delivery_alignment_set_mode',['off']);expect(await admit(f.subscription)).toMatchObject({allowed:false,state:'protected'});
  await arrival(f.shipment);expect((await cases(f.subscription)).rows).toMatchObject([{state:'released'}]);
  const before=await schedule(h.pool,f.subscription);
  expect(before.next_cycle_at.toISOString()).toBe(snapshot.scheduledAt);
  const offered=(await h.pool.query('SELECT * FROM public.subscription_list_due_renewals($1,500)',[at])).rows;
  expect(offered.some(r=>r.subscription_id===f.subscription)).toBe(false);
  const after='2026-10-22T12:06:00.000Z';
  const next=(await h.pool.query('SELECT *,scheduled_at::text AS original_text FROM public.subscription_list_due_renewals($1,500)',[after])).rows.find(r=>r.subscription_id===f.subscription);
  expect(next).toBeDefined();expect(next.scheduled_at.toISOString()).toBe(snapshot.scheduledAt);
  const replay=await call(h.pool,'subscription_claim_due_renewal',[identity,'c'.repeat(64),snapshot,'rollback-next',300,after]);
  expect(replay).toMatchObject({operationId:claim.operationId,identityKey:identity,cycleSnapshot:snapshot,state:'claimed',claimGeneration:2});
  expect(await admit(f.subscription,snapshot.scheduledAt,after)).toMatchObject({allowed:true});
  expect(await schedule(h.pool,f.subscription)).toEqual(before);
 });
 it('manual review still defers after actual arrival under off until resolve_case',async()=>{
  await call(h.pool,'subscription_delivery_alignment_set_mode',['off']);const f=await fixture(h.pool,null);
  const c=await openCase(h.pool,f,'auto_align');expect(c.state).toBe('manual_review');
  await call(h.pool,'subscription_delivery_alignment_set_mode',['off']);const before=await schedule(h.pool,f.subscription);
  await expect(call(h.pool,'subscription_delivery_alignment_resolve_case',[c.id,'operator_confirmed','undelivered'])).rejects.toThrow('release_would_strand');
  await arrival(f.shipment);expect(await admit(f.subscription)).toMatchObject({allowed:false,state:'manual_review'});
  expect(await schedule(h.pool,f.subscription)).toEqual(before);
  expect(await call(h.pool,'subscription_delivery_alignment_resolve_case',[c.id,'operator_confirmed','arrival checked'])).toMatchObject({state:'released'});
  expect(await admit(f.subscription)).toMatchObject({allowed:true});
 });
 it.each(['open','expired'])('protected arrival meeting %s dunning becomes manual review and preserves the date',async status=>{
  await call(h.pool,'subscription_delivery_alignment_set_mode',['off']);const f=await fixture(h.pool);
  await openCase(h.pool,f,'auto_align');await call(h.pool,'subscription_delivery_alignment_set_mode',['off']);
  await h.pool.query(`INSERT INTO public.subscription_dunning_cases(subscription_id,cycle_id,client_id,idempotency_key,status,expired_at) VALUES($1,$2,$3,$4,$5,CASE WHEN $5='expired' THEN $6::timestamptz ELSE NULL END)`,[f.subscription,f.cycle,f.client,`dunning-${f.cycle}`,status,at]);
  const before=await schedule(h.pool,f.subscription);await arrival(f.shipment);
  expect((await cases(f.subscription)).rows).toMatchObject([{state:'manual_review',manual_review_reason:'open_dunning'}]);
  expect(await admit(f.subscription)).toMatchObject({allowed:false,state:'manual_review'});
  expect(await schedule(h.pool,f.subscription)).toEqual(before);
 });
 it('a later paid correlated cycle releases a captured manual case by supersession under off',async()=>{
  await call(h.pool,'subscription_delivery_alignment_set_mode',['off']);const f=await fixture(h.pool);
  await openCase(h.pool,f,'auto_align');await call(h.pool,'subscription_delivery_alignment_set_mode',['off']);
  const laterOperation=randomUUID();
  await h.pool.query(`INSERT INTO public.subscription_renewal_operations(id,subscription_id,scheduled_at,cycle_number,identity_key,operation_fingerprint,cycle_snapshot,state,claim_token,claimed_by,claimed_at,lease_expires_at,terminal_outcome,terminal_at)
   VALUES($1,$2,'2026-08-29T12:00:00Z',2,$3,$4,'{}','succeeded',$5,'fixture',now(),now()+interval '1 hour','succeeded',now())`,[laterOperation,f.subscription,`subscription:${f.subscription}:cycle:2026-08-29T12:00:00.000Z`,'d'.repeat(64),randomUUID()]);
  // Existing retry cycles bypass new-cycle admission by their renewal correlation.
  await h.pool.query("INSERT INTO public.subscription_cycles(subscription_id,scheduled_at,status,renewal_operation_id,renewal_operation_fingerprint) VALUES($1,'2026-08-29T12:00:00Z','paid',$2,$3)",[f.subscription,laterOperation,'d'.repeat(64)]);
  await arrival(f.shipment);expect((await cases(f.subscription)).rows).toMatchObject([{state:'manual_review'}]);
  const before=await schedule(h.pool,f.subscription);expect(await admit(f.subscription)).toMatchObject({allowed:true,state:'off'});
  expect((await cases(f.subscription)).rows).toMatchObject([{state:'released'}]);expect(await schedule(h.pool,f.subscription)).toEqual(before);
 });
}
