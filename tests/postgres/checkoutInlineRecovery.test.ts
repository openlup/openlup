import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createCheckoutInlineRecovery, checkoutInlineRecoveryTransitionKey, createCheckoutPaymentContinuationCodec,
 createPostgresPaymentRecoveryGuidancePort, createPostgresCheckoutRecoveryOrderPort, hashCheckoutRecoveryToken,
 type CheckoutPaymentRecoveryGuidance, type CheckoutInlineRecoveryRequest } from '@openlup/platform/commerce/server';
import { createPostgresNativeCheckoutPersistence } from '@openlup/platform/commerce/server/native-checkout';
import { createPostgresSandboxInlineRecoveryAttemptPort, createPostgresSandboxPaymentSimulator, normalizeSandboxPaymentRecoveryEvidence } from '@openlup/platform/payments';
import type { SandboxMethodFacts } from '@openlup/platform/payments/contracts';
import { lifecycleInstallation, lifecycleProfiles, lifecycleSubject, call, type LifecycleInstallation } from './subscriptionLifecycleClosureFixture.js';
import { postgresSetupTimeoutMs, postgresTeardownTimeoutMs } from '../helpers/postgresContainer.js';
function facts(key:string):SandboxMethodFacts{return{authorizationRef:'sandbox:registered:authorization',payerAccountRef:null,methodRef:`sandbox:registered:${key}`,methodEvidenceRef:`sandbox:registered:evidence:${key}`,unattendedChargeAuthorizedAt:'2026-11-10T00:00:00.000000Z'};}
function methodKeyFor(f:SandboxMethodFacts){for(const key of ['primary','secondary'])if(f.methodRef===facts(key).methodRef&&f.methodEvidenceRef===facts(key).methodEvidenceRef)return key;return null;}
const options={dunningTemplateSlug:'dunning',recoveryUrlPath:'/recover',recoveryTemplateSlug:'recover',methodKeyFor};
describe.each(lifecycleProfiles)('exact inline retry on %s',profile=>{
 let env:LifecycleInstallation;
 beforeAll(async()=>{env=await lifecycleInstallation(profile);},postgresSetupTimeoutMs);
 afterAll(async()=>env?.close(),postgresTeardownTimeoutMs);
 const at=()=>new Date().toISOString();
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
  const attempt=await simulator().beginAttempt({idempotencyKey:`attempt:${orderId}`,settlementIntentId:paymentIntentId,requestFingerprint:'a'.repeat(64),methodFacts:facts('primary'),at:at()});
  const observation=await simulator().recordObservation({attemptId:attempt.id,idempotencyKey:`observation:${orderId}`,outcome:'refused',occurredAt:at()});
  expect(await simulator().ingress.receive({rawBody:new TextEncoder().encode(JSON.stringify({settlementIntentId:paymentIntentId,attemptId:attempt.id,observationId:observation.id})),headers:{},receivedAt:at()})).toMatchObject({status:200});
  const raw=`rcv_${randomUUID()}`,tokenId=(await env.owner.query(`INSERT INTO public.commerce_checkout_recovery_tokens(order_id,client_id,token_hash,expires_at)
   VALUES($1,$2,$3,clock_timestamp()+interval '1 day')RETURNING id`,[orderId,client,hashCheckoutRecoveryToken(raw)])).rows[0].id;
  return{orderId,paymentIntentId,clientId:client,attemptId:attempt.id,observationId:observation.id,tokenId,raw};
 }
 type Fixture=Awaited<ReturnType<typeof fixture>>;
 const reader=()=>createPostgresCheckoutRecoveryOrderPort(env.runtime);
 function setup(f:Fixture,config:{actions?:CheckoutPaymentRecoveryGuidance['actions'];restriction?:'method'|null;known?:boolean;allow?:boolean;action?:{kind:string;provider?:string;url?:string};hold?:boolean;beforeBegin?:()=>Promise<void>}={}){
  const secret=randomUUID()+randomUUID(),codec=createCheckoutPaymentContinuationCodec(secret,{cookieName:'__Host-exact-inline',executionRails:['sandbox','external']})!;
  const journeyId=`checkout:${randomUUID()}`,authority={journeyId,orderId:f.orderId,clientId:f.clientId,paymentIntentId:f.paymentIntentId,paymentAttemptId:f.attemptId,executionRail:'sandbox' as const};
  const cookie=codec.issue(authority).setCookie.split(';')[0];
  const request:CheckoutInlineRecoveryRequest<SandboxMethodFacts>={headers:{cookie,authorization:`Bearer ${f.raw}`},orderId:f.orderId,clientId:f.clientId,paymentIntentId:f.paymentIntentId,journeyId,expectedPaymentAttemptId:f.attemptId,retryRequestId:randomUUID(),executionRail:'sandbox',methodKey:'secondary',method:facts('secondary')};
  const raw=createPostgresPaymentRecoveryGuidancePort(env.runtime,normalizeSandboxPaymentRecoveryEvidence);
  const getGuidanceSnapshot=vi.fn(raw.getGuidanceSnapshot),getRecoveryOrder=vi.fn(reader().getRecoveryOrder);
  const native=createPostgresSandboxInlineRecoveryAttemptPort(env.runtime,{...options,methodKeyFor:config.known===false?()=>null:methodKeyFor});
  const begin=vi.fn(async(input:Parameters<typeof native.begin>[0])=>{await config.beforeBegin?.();return native.begin(input);});
  const readPreviousMethod=vi.fn(native.readPreviousMethod),readActiveAction=vi.fn(async()=>config.action??null);
  const make=()=>createCheckoutInlineRecovery({codec,guidance:{port:{getGuidanceSnapshot},
   ...(config.actions?{projectGuidance:(snapshot,status,projected)=>projected&&snapshot.purchaseContext?{version:1 as const,paymentAttemptId:projected.paymentAttemptId,purchaseContext:snapshot.purchaseContext,cause:projected.cause,methodKind:null,methodKey:null,operation:projected.operation,restriction:config.restriction??null,actions:config.actions!,consecutiveRefusals:projected.consecutiveRefusals,emphasis:projected.emphasis}:null}:{}),
  },orderPort:{getRecoveryOrder},attemptPort:{...native,begin,readPreviousMethod},executionAllowed:()=>config.allow!==false,activeActionResolver:{readActiveAction},
   hold:{readHolds:async()=>config.hold?[{kind:'initial',method:'secondary',createdAt:'2000-01-01T00:00:00Z'}]:[],classify:()=>({kind:'initial',method:'secondary'}),offeredMethods:()=>new Set(['primary','secondary']),isFirstPurchase:async()=>true}});
  return{secret,codec,request,make,getGuidanceSnapshot,getRecoveryOrder,begin,readPreviousMethod,readActiveAction};
 }
 async function attempts(f:Fixture){return(await env.owner.query('SELECT id,request_key,request_fingerprint,is_active,state FROM public.payment_simulator_attempts WHERE settlement_intent_id=$1 ORDER BY dispatched_at,id',[f.paymentIntentId])).rows;}
 it.each([false,true])('starts one exact transition for initial=%s and replays after response loss with a replacement cookie',async initial=>{
  const f=await fixture(initial),d=setup(f),before=await attempts(f);
  const both=await Promise.all([d.make().retry(d.request),d.make().retry(d.request)]);
  expect(both.filter(v=>!v.result.replayed)).toHaveLength(1);expect(both[0].result.paymentAttemptId).toBe(both[1].result.paymentAttemptId);
  const replacement=both[0].result.paymentAttemptId;
  expect(d.codec.verifyCookieHeader(both[0].setCookie.split(';')[0])).toMatchObject({paymentAttemptId:replacement,orderId:f.orderId,paymentIntentId:f.paymentIntentId,clientId:f.clientId,journeyId:d.request.journeyId,executionRail:'sandbox'});
  const replay=await d.make().retry({...d.request,methodKey:'unmapped-after-response-loss',method:{...facts('unknown'),authorizationRef:'transient-changed'}});
  expect(replay.result).toMatchObject({paymentAttemptId:replacement,status:'processing',replayed:true,clientAction:{kind:'none'}});
  expect((await attempts(f)).length).toBe(before.length+1);
  expect((await attempts(f)).at(-1)).toMatchObject({request_key:`${checkoutInlineRecoveryTransitionKey(f.attemptId)}:payment-execution:prepare-attempt`});
  // A new process has neither service nor module state from either tab.
  const child=spawnSync(process.execPath,['--input-type=module','-e',`
import {readFileSync}from'node:fs';import{Pool}from'pg';
import{createCheckoutInlineRecovery,createCheckoutPaymentContinuationCodec,createPostgresPaymentRecoveryGuidancePort,createPostgresCheckoutRecoveryOrderPort}from'@openlup/platform/commerce/server';
import{createPostgresSandboxInlineRecoveryAttemptPort,normalizeSandboxPaymentRecoveryEvidence}from'@openlup/platform/payments';
const input=JSON.parse(readFileSync(0,'utf8')),db=new Pool(input.database);
try{const codec=createCheckoutPaymentContinuationCodec(input.secret,{cookieName:'__Host-exact-inline',executionRails:['sandbox','external']});
const service=createCheckoutInlineRecovery({codec,guidance:{port:createPostgresPaymentRecoveryGuidancePort(db,normalizeSandboxPaymentRecoveryEvidence)},orderPort:createPostgresCheckoutRecoveryOrderPort(db),attemptPort:createPostgresSandboxInlineRecoveryAttemptPort(db,{...input.options,methodKeyFor:()=>{throw Error('replay_must_not_resolve_method');}}),executionAllowed:()=>{throw Error('replay_must_not_check_new_execution');}});
process.stdout.write(JSON.stringify(await service.retry(input.request)));}finally{await db.end();}
`],{input:JSON.stringify({request:d.request,secret:d.secret,options:{dunningTemplateSlug:'dunning',recoveryUrlPath:'/recover',recoveryTemplateSlug:'recover'},database:{connectionString:env.runtime.options.connectionString,options:env.runtime.options.options}}),encoding:'utf8',timeout:15000});
  expect(child.status).toBe(0);expect(JSON.parse(child.stdout).result).toMatchObject({paymentAttemptId:replacement,replayed:true});
  expect((await attempts(f)).length).toBe(before.length+1);
  const observed=await simulator().recordObservation({attemptId:replacement,idempotencyKey:`capture:${replacement}`,outcome:'captured',occurredAt:at()});
  const envelope={rawBody:new TextEncoder().encode(JSON.stringify({settlementIntentId:f.paymentIntentId,attemptId:replacement,observationId:observed.id})),headers:{},receivedAt:at()};
  for(let n=0;n<2;n++)expect(await simulator().ingress.receive(envelope)).toMatchObject({status:200});
  expect((await env.owner.query("SELECT count(*)::int AS n FROM public.commerce_settlement_transitions WHERE intent_id=$1 AND outcome='succeeded'",[f.paymentIntentId])).rows[0].n).toBe(1);
  await expect(d.make().retry(d.request)).rejects.toMatchObject({kind:'conflict'});expect(await attempts(f)).toHaveLength(2);
 });
 it('admits one competing nonce and refuses the losing tab and stale predecessor',async()=>{
  const f=await fixture(),d=setup(f),other={...d.request,retryRequestId:randomUUID()};
  const outcomes=await Promise.allSettled([d.make().retry(d.request),d.make().retry(other)]);
  expect(outcomes.filter(v=>v.status==='fulfilled')).toHaveLength(1);expect(outcomes.filter(v=>v.status==='rejected')).toHaveLength(1);expect(await attempts(f)).toHaveLength(2);
  const loser=outcomes[0].status==='rejected'?d.request:other;
  await expect(d.make().retry(loser)).rejects.toMatchObject({kind:'conflict'});
  const stale={...d.request,expectedPaymentAttemptId:randomUUID()};stale.headers={cookie:d.codec.issue({journeyId:stale.journeyId,orderId:f.orderId,clientId:f.clientId,paymentIntentId:f.paymentIntentId,paymentAttemptId:stale.expectedPaymentAttemptId,executionRail:'sandbox'}).setCookie};
  await expect(d.make().retry(stale)).rejects.toMatchObject({kind:'conflict'});expect(await attempts(f)).toHaveLength(2);
 });
 it.each(['missing','order','client','intent','journey','attempt','wrong_name'] as const)('rejects %s cookie authority before every durable read, ignoring the bearer',async mismatch=>{
  const f=await fixture(),d=setup(f),request={...d.request,headers:{...d.request.headers}};
  if(mismatch==='missing')request.headers.cookie=undefined;
  else if(mismatch==='wrong_name')request.headers.cookie=String(request.headers.cookie).replace('__Host-exact-inline=','unconfigured=');
  else{const field={order:'orderId',client:'clientId',intent:'paymentIntentId',journey:'journeyId',attempt:'expectedPaymentAttemptId'}[mismatch];Object.assign(request,{[field]:mismatch==='journey'?`checkout:${randomUUID()}`:randomUUID()});}
  await expect(d.make().retry(request)).rejects.toMatchObject({kind:'unauthorized'});
  expect(d.getGuidanceSnapshot).not.toHaveBeenCalled();expect(d.getRecoveryOrder).not.toHaveBeenCalled();expect(d.readPreviousMethod).not.toHaveBeenCalled();expect(d.begin).not.toHaveBeenCalled();expect(d.readActiveAction).not.toHaveBeenCalled();
 });
 it.each([
  ['same instrument','primary',['change_instrument'],null,true],['same data','primary',['correct_data'],null,true],
  ['same method-wide','primary',['change_instrument','change_method'],'method',false],['same authenticate','primary',['authenticate'],null,false],
  ['same change-only','primary',['change_method'],null,false],['different method','secondary',['change_method'],null,true],
  ['different instrument-only','secondary',['change_instrument'],null,false],['different authenticate-only','secondary',['authenticate'],null,false],
 ] as const)('enforces the server method-action rule: %s',async(_name,key,actions,restriction,allowed)=>{
  const f=await fixture(),d=setup(f,{actions:[...actions],restriction}),request={...d.request,methodKey:key,method:facts(key)};
  if(allowed)expect((await d.make().retry(request)).result).toMatchObject({status:'processing',replayed:false});
  else{await expect(d.make().retry(request)).rejects.toMatchObject({kind:'conflict',code:'recovery_action_not_allowed'});expect(d.begin).not.toHaveBeenCalled();}
  expect(await attempts(f)).toHaveLength(allowed?2:1);
 });
 it('refuses unknown method identity, inadmissible execution and a spoofed selected method',async()=>{
  for(const config of [{known:false},{allow:false}]){const f=await fixture(),d=setup(f,config);await expect(d.make().retry(d.request)).rejects.toMatchObject({kind:'conflict'});expect(await attempts(f)).toHaveLength(1);}
  const f=await fixture(),d=setup(f);await expect(d.make().retry({...d.request,method:facts('primary')})).rejects.toMatchObject({kind:'conflict'});expect(await attempts(f)).toHaveLength(1);
 });
 it.each(['cancel','capture','predecessor'] as const)('refuses a %s winner between the snapshot and locked dispatch',async race=>{
  const f=await fixture(),blocker=await env.owner.connect(),starter=await env.runtime.connect();
  try{
   await blocker.query('BEGIN');await blocker.query('SELECT id FROM public.commerce_orders WHERE id=$1 FOR UPDATE',[f.orderId]);
   const pid=Number((await starter.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
   const port=createPostgresSandboxInlineRecoveryAttemptPort(starter,options);
   const guarded=setup(f,{beforeBegin:async()=>{}});
   // Keep real snapshot/authority checks, then dispatch on the dedicated blocked lane.
   const service=createCheckoutInlineRecovery({codec:guarded.codec,guidance:{port:createPostgresPaymentRecoveryGuidancePort(env.runtime,normalizeSandboxPaymentRecoveryEvidence)},orderPort:reader(),attemptPort:port,executionAllowed:()=>true});
   const pending=service.retry(guarded.request),rejected=expect(pending).rejects.toMatchObject({kind:'conflict'});
   let blocked=false;for(let n=0;n<300&&!blocked;n++)blocked=(await blocker.query('SELECT cardinality(pg_blocking_pids($1))>0 AS blocked',[pid])).rows[0].blocked;
   expect(blocked).toBe(true);
   if(race==='cancel')await blocker.query("UPDATE public.commerce_orders SET status='cancelled' WHERE id=$1",[f.orderId]);
   if(race==='capture')await createPostgresSandboxPaymentSimulator(blocker,options).recordObservation({attemptId:f.attemptId,idempotencyKey:`late:${f.attemptId}`,outcome:'captured',occurredAt:at()});
   if(race==='predecessor')await createPostgresSandboxPaymentSimulator(blocker,options).beginAttempt({settlementIntentId:f.paymentIntentId,idempotencyKey:`competing:${randomUUID()}`,requestFingerprint:'b'.repeat(64),methodFacts:facts('primary'),at:at()});
   await blocker.query('COMMIT');await rejected;expect(await attempts(f)).toHaveLength(race==='predecessor'?2:1);
  }finally{await blocker.query('ROLLBACK');blocker.release();starter.release();}
 });
 it('replays a failed replacement without another dispatch and preserves its action or safe polling',async()=>{
  const f=await fixture(),d=setup(f,{action:{kind:'redirect',url:'/synthetic-handoff'}}),first=await d.make().retry(d.request);
  const live=await d.make().retry(d.request);expect(live.result.clientAction).toEqual({kind:'redirect',url:'/synthetic-handoff'});
  const observation=await simulator().recordObservation({attemptId:first.result.paymentAttemptId,idempotencyKey:`refuse:${randomUUID()}`,outcome:'refused',occurredAt:at()});
  expect(await simulator().ingress.receive({rawBody:new TextEncoder().encode(JSON.stringify({settlementIntentId:f.paymentIntentId,attemptId:first.result.paymentAttemptId,observationId:observation.id})),headers:{},receivedAt:at()})).toMatchObject({status:200});
  const replay=await d.make().retry(d.request);expect(replay.result).toMatchObject({status:'failed',replayed:true,paymentAttemptId:first.result.paymentAttemptId,clientAction:{kind:'none'}});expect(await attempts(f)).toHaveLength(2);
  await expect(d.make().retry({...d.request,headers:{cookie:replay.setCookie.split(';')[0]}})).rejects.toMatchObject({kind:'unauthorized'});
  const next=await d.make().retry({...d.request,headers:{cookie:replay.setCookie.split(';')[0]},expectedPaymentAttemptId:first.result.paymentAttemptId,retryRequestId:randomUUID()});
  expect(next.result).toMatchObject({replayed:false,status:'processing'});expect(next.result.paymentAttemptId).not.toBe(first.result.paymentAttemptId);
  await env.owner.query("UPDATE public.commerce_orders SET status='cancelled' WHERE id=$1",[f.orderId]);await expect(d.make().retry(d.request)).rejects.toMatchObject({kind:'conflict'});expect(await attempts(f)).toHaveLength(3);
 });
 it('refuses renewal, retains the named real-channel refusal and applies the shared hold wrapper',async()=>{
  const f=await fixture(true),live=await lifecycleSubject(env.owner),cycle=(await env.owner.query("INSERT INTO public.subscription_cycles(subscription_id,scheduled_at,status)VALUES($1,clock_timestamp(),'planned')RETURNING id",[live.subscription])).rows[0].id;
  await env.owner.query('UPDATE public.commerce_orders SET subscription_cycle_id=$2 WHERE id=$1',[f.orderId,cycle]);
  const d=setup(f);await expect(d.make().retry(d.request)).rejects.toMatchObject({kind:'conflict'});expect(await attempts(f)).toHaveLength(1);
  await expect(createPostgresSandboxInlineRecoveryAttemptPort(env.runtime,options).begin({order:(await reader().getRecoveryOrder({orderId:f.orderId}))!,request:d.request,method:d.request.method,admission:{replayOnly:false,purchaseContext:'subscription_initial',previousMethodKey:'primary',actions:['change_method'],restriction:null}})).rejects.toThrow('checkout_inline_retry_refused');
  const held=await fixture(true),h=setup(held,{hold:true});await expect(h.make().retry(h.request)).rejects.toMatchObject({kind:'conflict'});expect(await attempts(held)).toHaveLength(1);
  const real=await fixture(),r=setup(real);await expect(r.make().retry({...r.request,executionRail:'external'})).rejects.toMatchObject({code:'native_prepared_attempt_store_unsupported'});
  await env.owner.query("UPDATE public.commerce_settlement_intents SET channel_key='external' WHERE id=$1",[real.paymentIntentId]);await expect(r.make().retry(r.request)).rejects.toMatchObject({code:'native_prepared_attempt_store_unsupported'});
 });
});
