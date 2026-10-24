import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { expect,it } from 'vitest';
import { createPostgresRetryStore } from '@openlup/platform/subscriptions';
import { createPostgresStockAvailability } from '@openlup/platform/inventory';
import { AT,call,failure,later,positive,prepareOriginal,renewal,unchangedIdentity } from './subscriptionNativeFixture.js';
import { allPublicRows } from './subscriptionStockWaitCases.js';
export function registerStockAccountingCases(h:{pool:Pool}) {
 async function declined(lines=1) {
  const f=await renewal(h.pool,10,lines),original=await prepareOriginal(h.pool,f);
  const row=await call(h.pool,'subscription_retry_apply_failure',[f.operation,`failure-${f.operation}`,failure()]);
  return {...f,original,row};
 }
 it.each([1,2])('X restores %i late-paid frozen lines to counted ATP exactly once with zero-delta replay',async lines=>{
  const f=await declined(lines),store=createPostgresRetryStore(h.pool);
  expect((await h.pool.query('SELECT status FROM public.fulfillment_inventory_reservations WHERE renewal_operation_id=$1',[f.operation])).rows).toEqual([{status:'released'}]);
  const input=positive(f),key=`late-positive-${f.operation}`;
  const paid=await store.recordRecovery(f.operation,key,input);
  expect(paid).toMatchObject({state:'recovered',disposition:'paid'});
  const r=(await h.pool.query('SELECT status,expires_at FROM public.fulfillment_inventory_reservations WHERE renewal_operation_id=$1',[f.operation])).rows;
  expect(r).toEqual([{status:'committed',expires_at:null}]);
  expect((await h.pool.query(`SELECT l.sku,l.quantity FROM public.fulfillment_inventory_reservation_lines l
   JOIN public.fulfillment_inventory_reservations r ON r.id=l.reservation_id WHERE r.renewal_operation_id=$1 ORDER BY l.sku`,[f.operation])).rows).toEqual(f.snapshot.lines.map(l=>({sku:l.sku,quantity:l.quantity})).sort((a,b)=>a.sku.localeCompare(b.sku)));
  const atp=createPostgresStockAvailability(h.pool,{sourceKey:f.source,now:()=>later(25)});
  for(const line of f.snapshot.lines)expect(await atp.availableToPromise(line.sku,later(25))).toMatchObject({hardHoldQuantity:2,availableQuantity:8});
  const before=await allPublicRows(h.pool);
  expect(await store.recordRecovery(f.operation,key,input)).toEqual(paid);
  expect(await allPublicRows(h.pool)).toEqual(before);
  await expect(store.recordRecovery(f.operation,key,{...input,externalRef:'changed'})).rejects.toMatchObject({code:'23505'});
  expect(await allPublicRows(h.pool)).toEqual(before);
  await unchangedIdentity(h.pool,f);
 });
 it.each(['paid_cycle','settled_intent'])('Y filters %s before LIMIT so stale waiting rows do not starve due work',async kind=>{
  await h.pool.query("UPDATE public.subscription_retry_obligations SET next_retry_at='2028-01-01' WHERE state='waiting' AND next_retry_at IS NOT NULL");
  const stale:Awaited<ReturnType<typeof declined>>[]=[];
  for(let n=0;n<2;n++) {
   const f=await declined();stale.push(f);
   if(kind==='paid_cycle')await h.pool.query("UPDATE public.subscription_cycles SET status='paid' WHERE id=$1",[f.original.cycleId]);
   else await h.pool.query("UPDATE public.commerce_settlement_intents SET status='settled',settled_at=$2 WHERE id=$1",[f.original.settlementIntentId,later(23)]);
   await h.pool.query("UPDATE public.subscription_retry_obligations SET next_retry_at=$2 WHERE renewal_operation_id=$1",[f.operation,later(23)]);
  }
  const due=await declined();
  // Other cases use this shared DB. Make the target the earliest eligible row,
  // while excluded stale rows precede it. LIMIT 1 must reach it.
  await h.pool.query('UPDATE public.subscription_retry_obligations SET next_retry_at=$2 WHERE renewal_operation_id=$1',[due.operation,later(23.5)]);
  const before=await allPublicRows(h.pool);
  expect(await createPostgresRetryStore(h.pool).candidates(1,later(24))).toMatchObject([{operationId:due.operation}]);
  expect(await allPublicRows(h.pool)).toEqual(before);
  for(const f of [...stale,due])await unchangedIdentity(h.pool,f);
 });
 it.each(['activation','renewal'].flatMap(kind=>['soft','hard'].map(phase=>({kind,phase}))))('a refund of $kind preserves $phase future stock commitments',async ({kind,phase})=>{
  const f=await renewal(h.pool,10),cycle=randomUUID(),order=randomUUID();
  // Historical initial cycle has no renewal operation; a historical renewal
  // carries its own completed native operation. Both refund through the real OMS rail.
  let priorOperation:string|null=null;
  if(kind==='renewal') {
   priorOperation=randomUUID();
   await h.pool.query(`INSERT INTO public.subscription_renewal_operations(id,subscription_id,scheduled_at,cycle_number,
    identity_key,operation_fingerprint,cycle_snapshot,state,claim_token,claimed_by,claimed_at,lease_expires_at,terminal_outcome,terminal_at)
    VALUES($1,$2,$3,1,public.subscription_renewal_identity($2,$3),$4,$5,'succeeded',$6,'fixture',$3,$3::timestamptz+interval '5 minutes','succeeded',$3)`,
    [priorOperation,f.subscription,later(-28*24),f.fingerprint,{...f.snapshot,scheduledAt:later(-28*24),cycleNumber:1},randomUUID()]);
  }
  await h.pool.query(`INSERT INTO public.subscription_cycles(id,subscription_id,scheduled_at,status,renewal_operation_id,renewal_operation_fingerprint)
   VALUES($1,$2,$3,'paid',$4,$5)`,[cycle,f.subscription,later(-28*24),priorOperation,priorOperation?f.fingerprint:null]);
  // The deferred line-sum constraint needs the priced order and its lines in one transaction.
  await h.pool.query(`WITH historical_order AS (
   INSERT INTO public.commerce_orders(id,client_id,subscription_cycle_id,status,currency_code,total_amount_minor,renewal_operation_id,renewal_operation_fingerprint)
   VALUES($1,$2,$3,'paid','XXX',200,$4,$5) RETURNING id
  ) INSERT INTO public.commerce_order_items(order_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor)
   SELECT id,1,2,100,200 FROM historical_order`,[order,f.client,cycle,priorOperation,priorOperation?f.fingerprint:null]);
  const atp=createPostgresStockAvailability(h.pool,{sourceKey:f.source,now:()=>AT}),sku=f.snapshot.lines[0].sku;
  const future=async()=>({
   subscription:(await h.pool.query('SELECT status,next_cycle_at FROM public.subscriptions WHERE id=$1',[f.subscription])).rows,
   terms:(await h.pool.query('SELECT * FROM public.subscription_renewal_terms WHERE subscription_id=$1',[f.subscription])).rows,
   lines:(await h.pool.query('SELECT * FROM public.subscription_renewal_term_lines WHERE subscription_id=$1',[f.subscription])).rows,
   reservations:(await h.pool.query('SELECT * FROM public.fulfillment_inventory_reservations WHERE renewal_operation_id=$1',[f.operation])).rows,
   promise:await atp.availableToPromise(sku,AT),
  });
  expect((await future()).promise).toMatchObject({softSubscriptionDemandQuantity:2,availableQuantity:8});
  if(phase==='hard')await call(h.pool,'fulfillment_reserve_subscription_renewal',[f.operation,f.token,900,AT]);
  const before=await future(),args=[`refund-${order}`,order,'customer-request',null,{},AT];
  expect(before.promise).toMatchObject({softSubscriptionDemandQuantity:phase==='soft'?2:0,hardHoldQuantity:phase==='hard'?2:0,availableQuantity:8});
  expect(await call(h.pool,'oms_mark_refunded',args)).toMatchObject({status:'refunded',replayed:false});
  expect(await future()).toEqual(before);
  expect(await call(h.pool,'oms_mark_refunded',args)).toMatchObject({replayed:true});
  expect(await future()).toEqual(before);await unchangedIdentity(h.pool,f);
 });
}
