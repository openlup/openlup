import { randomUUID } from 'node:crypto';
import { afterAll,beforeAll,describe,expect,it } from 'vitest';
import { createAdminCheckoutPaymentLinkHandler,createPostgresOperatorCheckoutLinkStore,createPostgresCheckoutRecoveryWaves,
 createPostgresCheckoutRecoveryTokenPort,hashCheckoutRecoveryToken,type OperatorCheckoutLinkOrder,type OperatorCheckoutLinkStore,
 type OperatorCheckoutLinkReceipt } from '@openlup/platform/commerce/server';
import { lifecycleInstallation,lifecycleProfiles,lifecycleDeclined,call,type LifecycleInstallation } from './subscriptionLifecycleClosureFixture.js';
import { postgresSetupTimeoutMs,postgresTeardownTimeoutMs } from '../helpers/postgresContainer.js';
const NOW='2040-01-02T12:00:00.000Z',DAY=86400000,at=(days:number)=>new Date(Date.parse(NOW)+days*DAY).toISOString();
const policy={operatorLifetimeMs:7*DAY,recoveryWindowMs:30*DAY};
describe.each(lifecycleProfiles)('operator checkout links on %s',profile=>{
 let env:LifecycleInstallation,operator:string;
 beforeAll(async()=>{
  env=await lifecycleInstallation(profile);operator=randomUUID();
  if(profile==='legacy')await env.owner.query('CREATE ROLE service_role NOLOGIN NOINHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS');
  await env.owner.query('INSERT INTO public.platform_communication_operators(principal_id,active)VALUES($1,true)',[operator]);
 },postgresSetupTimeoutMs);
 afterAll(async()=>env?.close(),postgresTeardownTimeoutMs);
 const store=()=>createPostgresOperatorCheckoutLinkStore(env.runtime);
 const tokens=async(id:string)=>(await env.owner.query('SELECT * FROM public.commerce_checkout_recovery_tokens WHERE order_id=$1 ORDER BY created_at,id',[id])).rows;
 const receipts=async(id:string)=>(await env.owner.query('SELECT * FROM public.commerce_operator_link_receipts WHERE order_id=$1 ORDER BY occurred_at,id',[id])).rows;
 async function order(age=0,status='pending_payment'){
  const id=randomUUID(),client=randomUUID(),db=await env.owner.connect();
  try{await db.query('BEGIN');await db.query('INSERT INTO public.clients(id,email)VALUES($1,$2)',[client,`${client}@example.invalid`]);
   await db.query(`INSERT INTO public.commerce_orders(id,client_id,status,created_at,currency_code,total_amount_minor,metadata)
    VALUES($1,$2,$3,$4,'XXX',100,$5)`,[id,client,status,at(-age),{orderDraftSnapshot:{context:{mode:'one_time'}}}]);
   await db.query('INSERT INTO public.commerce_order_items(order_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor)VALUES($1,1,1,100,100)',[id]);await db.query('COMMIT');
  }catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
  return {id,client};
 }
 async function read(id:string):Promise<OperatorCheckoutLinkOrder|null>{
  const row=(await env.owner.query('SELECT o.*, a.cadence_days AS activation_cadence FROM public.commerce_orders o LEFT JOIN public.subscription_activations a ON a.order_id=o.id WHERE o.id=$1',[id])).rows[0];if(!row)return null;
  return {orderId:row.id,orderRef:`order_${row.id}`,orderNumber:row.id,clientId:row.client_id,status:row.status,mode:row.activation_cadence==null?'one_time_order':'subscription_cycle',totalMinor:100,currency:'XXX',cadenceDays:row.activation_cadence??null,
   createdAt:row.created_at.toISOString(),customerEmail:null,customerName:null,paymentIntentId:null,paymentIntentStatus:null,subscriptionId:null,subscriptionCycleId:row.subscription_cycle_id,
   technicallyExpired:row.metadata?.source==='checkout_reservation_expiry',quoteSnapshot:row.metadata?.quoteSnapshot,shippingAddressId:row.metadata?.shippingAddressId};
 }
 async function issue(id:string,options:{email?:boolean;operator?:string;store?:OperatorCheckoutLinkStore;valid?:boolean;auth?:boolean;machine?:boolean}={}){
  const result:{code?:string;details?:unknown;data?:{token:string;expiresAt:string;emailQueued:boolean}}={};
  const handler=createAdminCheckoutPaymentLinkHandler({authorizeAdmin:async()=>options.auth===false?{ok:false as const,code:'FORBIDDEN' as const,message:'Denied'}:{ok:true as const,userId:options.operator??operator,isMachineActor:options.machine??false},
   respond:{sendMethodNotAllowed:()=>{throw Error('unexpected method');},sendBffError:(_,code,__,o)=>{result.code=code;result.details=o?.details;},sendBffSuccess:(_,data)=>{result.data=data as typeof result.data;}},
   orderPort:{getRecoveryOrder:({orderId})=>read(orderId)},tokenStore:options.store??store(),policy,now:()=>new Date(NOW),validateRecreate:async()=>options.valid!==false});
  await handler({method:'POST',body:{orderId:id,...(options.email?{delivery:'email'}:{})}},null);return result;
 }
 const service=()=>createPostgresCheckoutRecoveryTokenPort({run:async work=>{const db=await env.runtime.connect();try{await db.query('BEGIN');const r=await work(db);await db.query('COMMIT');return r;}catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}}});
 const serviceIssue=(id:string,raw:string)=>service().issue({orderId:id,rawToken:raw,expiresAt:at(1)});
 function context(id:string,actor=operator,email=false):OperatorCheckoutLinkReceipt{return {operatorId:actor,requestId:randomUUID(),orderId:id,outcome:'admitted',completedStage:'none',emailRequested:email};}
 it('refuses nonadmin, inactive and machine operators with no link or receipt',async()=>{
  const f=await order(),inactive=randomUUID(),machine=randomUUID();
  await env.owner.query('INSERT INTO public.platform_communication_operators(principal_id,active)VALUES($1,false),($2,true)',[inactive,machine]);
  await env.owner.query('INSERT INTO public.platform_control_operators(principal_id)VALUES($1)',[machine]);
  expect((await issue(f.id,{auth:false})).code).toBe('FORBIDDEN');
  for(const actor of [inactive,machine,randomUUID()])await expect(store().recordReceipt(context(f.id,actor))).rejects.toMatchObject({code:'42501'});
  expect((await issue(f.id,{machine:true})).code).toBe('FORBIDDEN');expect(await tokens(f.id)).toEqual([]);expect(await receipts(f.id)).toEqual([]);
 });
 it('records admission before token writes and outcome after, returning copy without mail',async()=>{
  const f=await order(),underlying=store();
  const observed:OperatorCheckoutLinkStore={...underlying,revokeActive:async r=>{
   expect((await receipts(f.id)).map(x=>x.outcome)).toEqual(['admitted']);expect(await tokens(f.id)).toEqual([]);await underlying.revokeActive(r);
  },recordReceipt:async r=>{if(r.outcome==='succeeded')expect(await tokens(f.id)).toHaveLength(1);await underlying.recordReceipt(r);}};
  const result=await issue(f.id,{store:observed});expect(result.data).toMatchObject({emailQueued:false,expiresAt:at(7)});
  const rows=await tokens(f.id);expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({token_hash:hashCheckoutRecoveryToken(result.data!.token),revoked_at:null});
  expect((await receipts(f.id)).map(x=>[x.outcome,x.completed_stage])).toEqual([['admitted','none'],['succeeded','minted']]);
  expect((await env.owner.query('SELECT id FROM public.outbox_events WHERE aggregate_id=$1',[f.id])).rows).toEqual([]);
 });
 it('keeps a pending initial activation eligible and queues its persisted subscription copy',async()=>{
  const f=await order();
  await env.owner.query('UPDATE public.commerce_orders SET metadata=$2::jsonb WHERE id=$1',[f.id,{orderDraftSnapshot:{context:{mode:'subscription',cadenceDays:28}}}]);
  await call(env.runtime,'subscription_declare_provisional_activation',[`declare:${f.id}`,f.id,28,NOW]);
  const result=await issue(f.id,{email:true});expect(result.data?.emailQueued).toBe(true);
  expect((await env.owner.query("SELECT payload->>'mode' AS mode FROM public.outbox_events WHERE aggregate_id=$1 AND event_type='commerce.checkout_recovery'",[f.id])).rows).toEqual([{mode:'subscription_cycle'}]);
  expect(await service().validate(result.data!.token,new Date(NOW))).toMatchObject({orderId:f.id,mode:'subscription_cycle'});
 });
 it('uses eligible expiry facts, validates commercial terms and caps at the earlier deadline',async()=>{
  const f=await order(27,'expired');await env.owner.query("UPDATE public.commerce_orders SET metadata=metadata||$2::jsonb WHERE id=$1",[f.id,{source:'checkout_reservation_expiry',quoteSnapshot:{},shippingAddressId:randomUUID()}]);
  expect((await issue(f.id,{valid:false})).details).toEqual({reason:'order_changed'});expect(await tokens(f.id)).toEqual([]);
  expect((await issue(f.id)).data?.expiresAt).toBe(at(3));expect((await tokens(f.id))[0].expires_at.toISOString()).toBe(at(3));
  const manual=await order(1,'cancelled');expect((await issue(manual.id)).details).toEqual({reason:'order_cancelled'});
  const paid=await order(1,'paid');expect((await issue(paid.id)).details).toEqual({reason:'order_paid'});
 });
 it.each([30,30+1/DAY])('issues nothing for an elapsed deadline (%s days)',async age=>{
  const f=await order(age);expect((await issue(f.id)).details).toEqual({reason:'order_not_recoverable'});expect(await receipts(f.id)).toEqual([]);expect(await tokens(f.id)).toEqual([]);
 });
 it('revokes earlier wave and customer/service links; later service issuance preserves the operator link and the payment case',async()=>{
  const f=await order(2/24),oldRaw=randomUUID();await serviceIssue(f.id,oldRaw);
  await createPostgresCheckoutRecoveryWaves(env.runtime,{profile:'capture'}).enqueue(100,NOW);
  const before=await tokens(f.id);expect(before).toHaveLength(2);
  const caseOrder=await lifecycleDeclined(env.owner),caseBefore=await tokens(caseOrder.original.orderId);
  const result=await issue(f.id);const after=await tokens(f.id);
  expect(after.filter(t=>before.some(b=>b.id===t.id)).every(t=>t.revoked_at!==null)).toBe(true);
  expect(after.filter(t=>t.revoked_at===null)).toEqual([expect.objectContaining({token_hash:hashCheckoutRecoveryToken(result.data!.token)})]);
  const later=randomUUID();await serviceIssue(f.id,later);expect((await tokens(f.id)).filter(t=>t.revoked_at===null)).toHaveLength(2);
  expect(await service().validate(oldRaw,new Date(NOW))).toBeNull();expect(await service().validate(result.data!.token,new Date(NOW))).toMatchObject({orderId:f.id});
  expect(await service().validate(later,new Date(NOW))).toMatchObject({orderId:f.id});expect(await tokens(caseOrder.original.orderId)).toEqual(caseBefore);
  const renewalResult=await issue(caseOrder.original.orderId);expect(renewalResult.details).toEqual({reason:'order_not_recoverable'});expect(await tokens(caseOrder.original.orderId)).toEqual(caseBefore);
 });
 it('queues once per token with exact bearer binding and a scoped live-token delivery gate',async()=>{
  const f=await order(),result=await issue(f.id,{email:true});expect(result.data?.emailQueued).toBe(true);
  const rows=await tokens(f.id),r=(await receipts(f.id))[0],receipt=context(f.id);receipt.requestId=r.request_id;receipt.emailRequested=true;
  await store().enqueueRecoveryEmail({receipt,tokenId:rows[0].id,rawToken:result.data!.token,mode:'one_time'});
  const events=(await env.owner.query("SELECT * FROM public.outbox_events WHERE aggregate_id=$1 AND event_type='commerce.checkout_recovery'",[f.id])).rows;
  expect(events).toHaveLength(1);expect(events[0].payload).toMatchObject({operatorIssued:true,recoveryToken:result.data!.token});
  expect((await receipts(f.id)).at(-1)).toMatchObject({outcome:'succeeded',completed_stage:'email_queued'});
  const event=events[0];await env.owner.query("UPDATE public.outbox_events SET status='processing',metadata=metadata||'{\"claimToken\":\"claim\"}' WHERE id=$1",[event.id]);
  expect(await store().authorize(event.id,'wrong')).toMatchObject({authorized:false,reason:'claim_not_active'});
  expect(await store().authorize(event.id,'claim')).toMatchObject({authorized:true});
  await issue(f.id);expect(await store().authorize(event.id,'claim')).toMatchObject({authorized:false,reason:'operator_checkout_recovery_link_not_live'});
  await expect(store().enqueueRecoveryEmail({receipt,tokenId:rows[0].id,rawToken:'wrong',mode:'one_time'})).rejects.toMatchObject({code:'22023'});
 });
 it('preserves revoked evidence after insert failure and minted evidence after email failure',async()=>{
  for(const stage of ['insert','email'] as const){
   const f=await order();await serviceIssue(f.id,randomUUID());const real=store();
   const broken={...real,...(stage==='insert'?{insert:async()=>{throw Error('insert unavailable');}}:{enqueueRecoveryEmail:async()=>{throw Error('queue unavailable');}})};
   expect((await issue(f.id,{email:true,store:broken})).code).toBe('UPSTREAM_UNAVAILABLE');
   expect((await receipts(f.id)).at(-1)).toMatchObject({outcome:'failed',completed_stage:stage==='insert'?'revoked':'minted'});
   expect((await tokens(f.id)).filter(t=>t.revoked_at===null)).toHaveLength(stage==='insert'?0:1);
  }
 });
 it('retains admitted evidence when both outcome writes are unavailable',async()=>{
  const f=await order(),real=store();
  const unavailable:OperatorCheckoutLinkStore={...real,recordReceipt:async r=>{if(r.outcome!=='admitted')throw Error('outcome unavailable');await real.recordReceipt(r);}};
  const result=await issue(f.id,{email:true,store:unavailable});expect(result.code).toBe('UPSTREAM_UNAVAILABLE');expect(result.data).toBeUndefined();
  expect((await receipts(f.id)).map(r=>r.outcome)).toEqual(['admitted']);expect((await tokens(f.id)).filter(t=>t.revoked_at===null)).toHaveLength(1);
 });
 it('requires admission, retains its operator scope, and refuses raw receipt access',async()=>{
  const f=await order(),r=context(f.id);await expect(store().revokeActive(r)).rejects.toMatchObject({code:'42501'});
  await store().recordReceipt(r);await expect(store().revokeActive({...r,operatorId:randomUUID()})).rejects.toMatchObject({code:'42501'});
  await expect(store().recordReceipt({...context(f.id),outcome:'succeeded'})).rejects.toMatchObject({code:'42501'});
  const db=await env.owner.connect();try{await db.query('BEGIN');await db.query('SET LOCAL ROLE authenticated');
   await expect(db.query('SELECT * FROM public.commerce_operator_link_receipts')).rejects.toMatchObject({code:'42501'});
  }finally{await db.query('ROLLBACK');db.release();}
  if(profile!=='legacy')await expect(env.runtime.query('SELECT * FROM public.commerce_operator_link_receipts')).rejects.toMatchObject({code:'42501'});
 });
 it('preserves the reference interleaving of two operators: both revoke, then both insert',async()=>{
  const f=await order(),other=randomUUID();await env.owner.query('INSERT INTO public.platform_communication_operators(principal_id)VALUES($1)',[other]);
  await serviceIssue(f.id,randomUUID());let completed=0,release!:()=>void;const barrier=new Promise<void>(resolve=>{release=resolve;});
  const wrapped=():OperatorCheckoutLinkStore=>{const actual=store();return {...actual,revokeActive:async r=>{await actual.revokeActive(r);if(++completed===2)release();await barrier;}};};
  const results=await Promise.all([issue(f.id,{store:wrapped()}),issue(f.id,{operator:other,store:wrapped()})]);
  expect(results.every(x=>Boolean(x.data?.token))).toBe(true);const live=(await tokens(f.id)).filter(t=>t.revoked_at===null);
  expect(live.map(t=>t.token_hash).sort()).toEqual(results.map(x=>hashCheckoutRecoveryToken(x.data!.token)).sort());
  expect((await receipts(f.id)).filter(r=>r.outcome==='admitted')).toHaveLength(2);
  // A later ordinary operator command revokes both; it does not promise global one-link cardinality across interleaving commands.
  await issue(f.id);expect((await tokens(f.id)).filter(t=>t.revoked_at===null)).toHaveLength(1);
 });
});
