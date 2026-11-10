import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCheckoutRecoveryPayService, createCheckoutRecoveryTokenPay, createPostgresCheckoutRecoveryOrderPort, createPostgresCheckoutRecoveryTokenPort, hashCheckoutRecoveryToken, withCheckoutRecoveryPaymentHold } from '@openlup/platform/commerce/server';
import { createPostgresNativeCheckoutPersistence } from '@openlup/platform/commerce/server/native-checkout';
import { createPostgresSandboxCheckoutRecoveryAttemptPort, createPostgresSandboxPaymentSimulator } from '@openlup/platform/payments';
import type { SandboxMethodFacts } from '@openlup/platform/payments/contracts';
import { lifecycleInstallation, lifecycleProfiles, call, lifecycleSubject, type LifecycleInstallation } from './subscriptionLifecycleClosureFixture.js';
import { postgresSetupTimeoutMs, postgresTeardownTimeoutMs } from '../helpers/postgresContainer.js';

describe.each(lifecycleProfiles)('token pay on %s', profile => {
 let env: LifecycleInstallation;
 beforeAll(async()=>{env=await lifecycleInstallation(profile);if(profile==='legacy')await env.owner.query('CREATE ROLE service_role NOLOGIN NOINHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS');},postgresSetupTimeoutMs);
 afterAll(async()=>env?.close(),postgresTeardownTimeoutMs);
 const at=()=>new Date().toISOString();
 const options={dunningTemplateSlug:'dunning',recoveryUrlPath:'/recover',recoveryTemplateSlug:'recover'};
 const simulator=()=>createPostgresSandboxPaymentSimulator(env.runtime,options);
 async function fixture(initial=false){
  const client=randomUUID(),skuId=randomUUID(),sku=`GUIDANCE-${randomUUID()}`;
  await env.owner.query('INSERT INTO public.clients(id,email)VALUES($1,$2)',[client,`${client}@example.invalid`]);
  await env.owner.query("INSERT INTO public.catalog_products(id,slug,name)VALUES($1,$2,'Example')",[skuId,sku.toLowerCase()]);
  await env.owner.query("INSERT INTO public.catalog_skus(id,product_id,sku,title,sellable_in_subscription)VALUES($1,$1,$2,'Example',true)",[skuId,sku]);
  const list=(await env.owner.query("INSERT INTO public.price_lists(name,region_code,currency)VALUES('Example','ZZ','XXX')RETURNING id")).rows[0].id;
  await env.owner.query('INSERT INTO public.price_entries(price_list_id,variant_id,unit_price_minor)VALUES($1,$2,100)',[list,skuId]);
  const money=(amountMinor:number)=>({amountMinor,currency:'XXX'});
  const quote={contractVersion:'commerce.v0' as const,quote:{currency:'XXX',taxIncluded:true as const,lines:[{sku,productSlug:sku.toLowerCase(),quantity:1,
   unitPriceGross:money(100),lineSubtotalGross:money(100),tax:{included:true as const,country:'ZZ',category:'standard',vatRateBps:0,legalBasis:'Example',netAmount:money(100),vatAmount:money(0),grossAmount:money(100)}}],
   discounts:[],context:{mode:initial?'subscription' as const:'one_time' as const,cadenceDays:initial?28:null,promoCodes:[]},subtotalGross:money(100),discountTotalGross:money(0),shippingGross:money(0),shippingDiscountGross:money(0),totalGross:money(100),netTotal:money(100),taxTotal:money(0)}};
  const draft=await createPostgresNativeCheckoutPersistence(env.runtime).createOrderDraft({idempotencyKey:`guidance:${randomUUID()}`,quoteSnapshot:quote},{clientId:client});
  const orderId=draft.orderDraft.orderId.replace(/^order_/,'');
  if(initial)await call(env.runtime,'subscription_declare_provisional_activation',[`declare:${orderId}`,orderId,28,at()]);
  const i=await call(env.runtime,'commerce_open_settlement_intent',[`intent:${orderId}`,orderId,'sandbox',100,'XXX',{},at()]);
  const paymentIntentId=String((i.settlement as {id:string}).id);
  const attempt=await simulator().beginAttempt({idempotencyKey:`attempt:${orderId}`,settlementIntentId:paymentIntentId,requestFingerprint:'a'.repeat(64),at:at()});
  const observation=await simulator().recordObservation({attemptId:attempt.id,idempotencyKey:`observation:${orderId}`,outcome:'refused',occurredAt:at()});
  const raw=`rcv_${randomUUID()}`,tokenId=(await env.owner.query(`INSERT INTO public.commerce_checkout_recovery_tokens(order_id,client_id,token_hash,expires_at)
   VALUES($1,$2,$3,clock_timestamp()+interval '1 day')RETURNING id`,[orderId,client,hashCheckoutRecoveryToken(raw)])).rows[0].id;
  return{orderId,paymentIntentId,clientId:client,attemptId:attempt.id,observationId:observation.id,tokenId,raw};
 }
 type Fixture=Awaited<ReturnType<typeof fixture>>;
 const reader=()=>createPostgresCheckoutRecoveryOrderPort(env.runtime);
 const tokens=()=>createPostgresCheckoutRecoveryTokenPort({run:async work=>{const db=await env.runtime.connect();try{await db.query('BEGIN');const r=await work(db);await db.query('COMMIT');return r;}catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}}});
 const service=()=>createCheckoutRecoveryPayService(createPostgresSandboxCheckoutRecoveryAttemptPort(env.runtime,options));
 const tokenPay=()=>createCheckoutRecoveryTokenPay({tokenPort:tokens(),orderPort:reader(),payService:service()});
 const pay=(f:Fixture,key=`pay:${randomUUID()}`,method?:SandboxMethodFacts)=>tokenPay().pay({token:f.raw,idempotencyKey:key,method});
 const count=async(f:Fixture)=>(await env.owner.query(`SELECT
  (SELECT count(*)::int FROM public.commerce_settlement_intents WHERE order_id=$1) AS intents,
  (SELECT count(*)::int FROM public.payment_simulator_attempts WHERE settlement_intent_id=$2) AS attempts,
  (SELECT count(*)::int FROM public.commerce_orders WHERE id=$1 OR recreated_from_order_id=$1) AS orders,
  (SELECT count(*)::int FROM public.fulfillment_inventory_reservations WHERE purchase_order_id=$1) AS reservations`,[f.orderId,f.paymentIntentId])).rows[0];
 it.each([false,true])('replays one dispatch after restart and one financial effect (initial=%s)',async initial=>{
  const f=await fixture(initial),key=`pay:${randomUUID()}`,before=await count(f);
  const both=await Promise.all([pay(f,key),pay(f,key)]);
  expect(both[0].paymentAttemptId).toBe(both[1].paymentAttemptId);expect(both.filter(r=>!r.replayed)).toHaveLength(1);
  expect(await pay(f,key)).toMatchObject({paymentAttemptId:both[0].paymentAttemptId,replayed:true});
  const restarted=spawnSync(process.execPath,['--input-type=module','-e',`
import {readFileSync} from 'node:fs';
import {Pool} from 'pg';
import {createPostgresCheckoutRecoveryOrderPort,createCheckoutRecoveryPayService} from '@openlup/platform/commerce/server';
import {createPostgresSandboxCheckoutRecoveryAttemptPort} from '@openlup/platform/payments';
const input=JSON.parse(readFileSync(0,'utf8')),db=new Pool(input.database);
try{
 const order=await createPostgresCheckoutRecoveryOrderPort(db).getRecoveryOrder({orderId:input.orderId});
 const service=createCheckoutRecoveryPayService(createPostgresSandboxCheckoutRecoveryAttemptPort(db,input.options));
 const result=await service.pay({order,clientId:input.clientId,recoveryTokenId:input.tokenId,idempotencyKey:input.key,method:undefined});
 process.stdout.write(JSON.stringify(result));
}finally{await db.end();}
`],{input:JSON.stringify({...f,key,options,database:{connectionString:env.runtime.options.connectionString,options:env.runtime.options.options}}),encoding:'utf8',timeout:15000});
  expect(restarted.status).toBe(0);
  expect(JSON.parse(restarted.stdout)).toMatchObject({paymentAttemptId:both[0].paymentAttemptId,replayed:true});
  expect(await count(f)).toEqual({...before,attempts:before.attempts+1});
  const a=both[0].paymentAttemptId;
  const observation=await simulator().recordObservation({attemptId:a,idempotencyKey:`capture:${a}`,outcome:'captured',occurredAt:at()});
  const rawBody=new TextEncoder().encode(JSON.stringify({settlementIntentId:f.paymentIntentId,attemptId:a,observationId:observation.id}));
  for(let n=0;n<2;n++)expect(await simulator().ingress.receive({rawBody,headers:{},receivedAt:at()})).toMatchObject({status:200});
  expect((await env.owner.query('SELECT status FROM public.commerce_orders WHERE id=$1',[f.orderId])).rows).toEqual([{status:'paid'}]);
  expect((await env.owner.query("SELECT count(*)::int AS n FROM public.commerce_settlement_transitions WHERE intent_id=$1 AND outcome='succeeded'",[f.paymentIntentId])).rows[0].n).toBe(1);
 });
 it('keeps unresolved attempts retry-later and failed attempts recoverable on the same intent',async()=>{
  const f=await fixture(),first=await pay(f),key=`pay:${randomUUID()}`;
  await expect(pay(f,key)).rejects.toMatchObject({code:'provider_attempt_in_flight',kind:'upstream_unavailable'});
  await simulator().recordObservation({attemptId:first.paymentAttemptId,idempotencyKey:`decline:${first.paymentAttemptId}`,outcome:'refused',occurredAt:at()});
  // A repeated click reads a durable synchronous refusal as a failed result.
  const row=(await env.owner.query('SELECT request_key FROM public.payment_simulator_attempts WHERE id=$1',[first.paymentAttemptId])).rows[0];
  expect(await pay(f,String(row.request_key).replace(/:payment-execution$/,''))).toMatchObject({status:'failed',failureReason:'generic_decline',replayed:true});
  const next=await pay(f,key);expect(next.paymentAttemptId).not.toBe(first.paymentAttemptId);expect(next.paymentIntentId).toBe(f.paymentIntentId);
 });
 it('binds a changed method to its request key and the token canonical order',async()=>{
  const f=await fixture(),other=await fixture(),key=`pay:${randomUUID()}`;
  const method:SandboxMethodFacts={authorizationRef:'sandbox:authorization:alternate',methodRef:'sandbox:method:alternate',methodEvidenceRef:'sandbox:evidence:alternate',payerAccountRef:null,unattendedChargeAuthorizedAt:'2026-11-10T00:00:00.000Z'};
  const first=await pay(f,key,method);expect(first.orderId).toBe(f.orderId);expect(first.orderId).not.toBe(other.orderId);
  await expect(pay(f,key,{...method,methodRef:'sandbox:method:changed'})).rejects.toMatchObject({kind:'upstream_unavailable'});
  expect(await pay(f,key,method)).toMatchObject({paymentAttemptId:first.paymentAttemptId,replayed:true});
  expect(await simulator().readAttempt({settlementIntentId:f.paymentIntentId})).toMatchObject({methodFacts:{...method,unattendedChargeAuthorizedAt:'2026-11-10T00:00:00.000000Z'}});
 });
 it.each(['expired','revoked','foreign'] as const)('refuses %s token before a dispatch',async reason=>{
  const f=await fixture(),order=await reader().getRecoveryOrder({orderId:f.orderId}),before=await count(f);
  if(reason==='expired')await env.owner.query("UPDATE public.commerce_checkout_recovery_tokens SET expires_at=clock_timestamp()-interval '1 hour',created_at=clock_timestamp()-interval '1 day' WHERE id=$1",[f.tokenId]);
  if(reason==='revoked')await env.owner.query('UPDATE public.commerce_checkout_recovery_tokens SET revoked_at=clock_timestamp() WHERE id=$1',[f.tokenId]);
  const foreign=reason==='foreign'?await fixture():null;
  await expect(service().pay({order:order!,clientId:f.clientId,recoveryTokenId:foreign?.tokenId??f.tokenId,idempotencyKey:`pay:${randomUUID()}`,method:undefined})).rejects.toMatchObject({code:'token_expired_or_consumed',kind:'conflict'});
  expect(await count(f)).toEqual(before);
 });
 it('refuses a renewal while leaving initial declarations eligible',async()=>{
  const f=await fixture(true),renewal=await lifecycleSubject(env.owner);
  const cycle=(await env.owner.query("INSERT INTO public.subscription_cycles(subscription_id,scheduled_at,status)VALUES($1,clock_timestamp(),'planned')RETURNING id",[renewal.subscription])).rows[0].id;
  await env.owner.query('UPDATE public.commerce_orders SET subscription_cycle_id=$2 WHERE id=$1',[f.orderId,cycle]);
  await expect(pay(f)).rejects.toMatchObject({kind:'conflict'});
  await expect(env.runtime.query('SELECT public.commerce_checkout_recovery_attempt_begin($1,$2,$3,$4,$5,$6,$7)',[`renewal:${randomUUID()}`,f.orderId,f.clientId,f.paymentIntentId,'f'.repeat(64),{recoveryTokenId:f.tokenId,methodFacts:{}},at()])).rejects.toThrow('checkout_recovery_order_not_recoverable');
  expect((await count(f)).attempts).toBe(1);
 });
 it.each(['cancel','capture','revoke'] as const)('rechecks a %s race after the service read and before dispatch',async action=>{
  const f=await fixture(),order=(await reader().getRecoveryOrder({orderId:f.orderId}))!,before=await count(f);
  const blocker=await env.owner.connect(),started=await env.runtime.connect();
  try{
   await blocker.query('BEGIN');await blocker.query('SELECT id FROM public.commerce_orders WHERE id=$1 FOR UPDATE',[f.orderId]);
   const pid=Number((await started.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
   const pending=createCheckoutRecoveryPayService(createPostgresSandboxCheckoutRecoveryAttemptPort(started,options)).pay({order,clientId:f.clientId,recoveryTokenId:f.tokenId,idempotencyKey:`pay:${randomUUID()}`,method:undefined});
   const rejected=expect(pending).rejects.toMatchObject({kind:action==='capture'?'upstream_unavailable':'conflict'});
   let blocked=false;
   for(let n=0;n<100&&!blocked;n++)blocked=(await blocker.query('SELECT cardinality(pg_blocking_pids($1))>0 AS blocked',[pid])).rows[0].blocked;
   expect(blocked).toBe(true);
   if(action==='cancel')await blocker.query("UPDATE public.commerce_orders SET status='cancelled' WHERE id=$1",[f.orderId]);
   if(action==='revoke')await blocker.query('UPDATE public.commerce_checkout_recovery_tokens SET revoked_at=clock_timestamp() WHERE id=$1',[f.tokenId]);
   if(action==='capture')await createPostgresSandboxPaymentSimulator(blocker,options).recordObservation({attemptId:f.attemptId,idempotencyKey:`late:${f.attemptId}`,outcome:'captured',occurredAt:at()});
   await blocker.query('COMMIT');await rejected;expect(await count(f)).toEqual(before);
  }finally{await blocker.query('ROLLBACK');blocker.release();started.release();}
 });
 it('rolls back invalid pre-dispatch facts and permits a corrected retry without money application',async()=>{
  const f=await fixture(),key=`pay:${randomUUID()}`,before=await count(f);
  const bad:SandboxMethodFacts={authorizationRef:'invalid',methodRef:'invalid',methodEvidenceRef:'invalid',payerAccountRef:null,unattendedChargeAuthorizedAt:'2026-11-10T00:00:00.000Z'};
  await expect(pay(f,key,bad)).rejects.toMatchObject({code:'provider_execution_failed',kind:'upstream_unavailable'});
  expect(await count(f)).toEqual(before);expect(await pay(f,key)).toMatchObject({status:'processing'});
 });
 it('retains the real-channel named refusal',async()=>{
  const f=await fixture();await env.owner.query("UPDATE public.commerce_settlement_intents SET channel_key='other' WHERE id=$1",[f.paymentIntentId]);
  await expect(pay(f)).rejects.toMatchObject({code:'native_prepared_attempt_store_unsupported',kind:'upstream_unavailable'});
 });
 it('denies browser roles access to the new fixed-path definer',async()=>{
  const signature='public.commerce_checkout_recovery_attempt_begin(text,uuid,uuid,uuid,text,jsonb,timestamptz)';
  expect((await env.owner.query('SELECT prosecdef,proconfig FROM pg_proc WHERE oid=$1::regprocedure',[signature])).rows).toEqual([{prosecdef:true,proconfig:['search_path=pg_catalog, pg_temp']}]);
  for(const role of ['anon','authenticated']){const db=await env.owner.connect();try{await db.query('BEGIN');await db.query(`SET LOCAL ROLE ${role}`);await expect(db.query("SELECT public.commerce_checkout_recovery_attempt_begin('request-key',NULL,NULL,NULL,NULL,NULL,clock_timestamp())")).rejects.toMatchObject({code:'42501'});}finally{await db.query('ROLLBACK');db.release();}}
 });
 it.each(['before','equal','recreated','foreign_root','unknown_first','failed_first_read','previously_live','never_empty'] as const)('permits the hold bypass %s through actual native payment',async rule=>{
  const f=await fixture(true);
  if(rule==='recreated'||rule==='foreign_root'){
   const root=await fixture();await env.owner.query('UPDATE public.commerce_orders SET client_id=$2 WHERE id=$1',[root.orderId,f.clientId]);
   await env.owner.query(rule==='recreated'?'UPDATE public.commerce_orders SET recreated_from_order_id=$2 WHERE id=$1':'UPDATE public.commerce_orders SET recovery_root_order_id=$2 WHERE id=$1',[f.orderId,root.orderId]);
  }
  const order=(await reader().getRecoveryOrder({orderId:f.orderId}))!;
  const live=rule==='previously_live'?await lifecycleSubject(env.owner):null;
  const guarded=withCheckoutRecoveryPaymentHold(service(),{
   readHolds:async()=>[{kind:'initial',method:'primary',createdAt:rule==='before'?'2100-01-01T00:00:00Z':rule==='equal'?order.createdAt:'2000-01-01T00:00:00Z'}],
   classify:()=>({kind:'initial',method:'primary'}),offeredMethods:()=>new Set(rule==='never_empty'?['primary']:['primary','secondary']),
   isFirstPurchase:async()=>{
    if(rule==='unknown_first')return null;
    if(rule==='failed_first_read')throw new Error('first_purchase_read_failed');
    if(live)return !(await env.runtime.query('SELECT started_at IS NOT NULL AS live FROM public.subscriptions WHERE id=$1',[live.subscription])).rows[0].live;
    return true;
   },
  });
  const before=await count(f);
  expect(await guarded.pay({order,clientId:f.clientId,recoveryTokenId:f.tokenId,idempotencyKey:`hold:${randomUUID()}`,method:undefined})).toMatchObject({status:'processing'});
  expect(await count(f)).toEqual({...before,attempts:before.attempts+1});
 });
 it('gates a first purchase after a hold, then permits payment when its read fails',async()=>{
  const f=await fixture(true),order=(await reader().getRecoveryOrder({orderId:f.orderId}))!;
  const input={order,clientId:f.clientId,recoveryTokenId:f.tokenId,idempotencyKey:`pay:${randomUUID()}`,method:undefined};
  const deps={readHolds:async()=>[{kind:'initial',method:'primary',createdAt:'2000-01-01T00:00:00Z'}],classify:()=>({kind:'initial',method:'primary'}),offeredMethods:()=>new Set(['primary','secondary']),isFirstPurchase:async()=>true};
  await expect(withCheckoutRecoveryPaymentHold(service(),deps).pay(input)).rejects.toMatchObject({code:'payment_method_withheld',kind:'conflict'});
  expect((await count(f)).attempts).toBe(1);
  expect(await withCheckoutRecoveryPaymentHold(service(),{...deps,readHolds:async()=>{throw new Error('read_failed');}}).pay(input)).toMatchObject({status:'processing'});
 });
});
