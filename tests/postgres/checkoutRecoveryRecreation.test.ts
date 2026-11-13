import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createExpiredCheckoutRecoveryService, createPostgresCheckoutRecoveryOrderPort, createPostgresExpiredCheckoutRecoveryPort,
 createPostgresExpiredCheckoutDraftPort, createPostgresExpiredCheckoutRuntime, createPostgresExpiredCheckoutCompensation, checkoutRecoveryExecutionFingerprint,
 type NativeCheckoutRecoveryOrder, type CheckoutRecoveryWriteExecutor } from '@openlup/platform/commerce/server';
import { createPostgresNativeCheckoutPersistence } from '@openlup/platform/commerce/server/native-checkout';
import { createPostgresSandboxExpiredCheckoutSafety, createPostgresSandboxPaymentSimulator } from '@openlup/platform/payments';
import { createPostgresPurchaseReservationPort } from '@openlup/platform/inventory';
import { createPostgresBillingInvoiceStore } from '@openlup/platform/invoicing';
import { lifecycleInstallation, lifecycleProfiles, call, lifecycleSubject, type LifecycleInstallation } from './subscriptionLifecycleClosureFixture.js';
import { postgresSetupTimeoutMs, postgresTeardownTimeoutMs } from '../helpers/postgresContainer.js';

const money=(amountMinor:number)=>({amountMinor,currency:'XXX'});
function quote(sku:string,mode:'subscription'|'one_time'='subscription',unit=100){return{contractVersion:'commerce.v0' as const,quote:{
 currency:'XXX',taxIncluded:true as const,lines:[{sku,productSlug:sku.toLowerCase(),quantity:1,unitPriceGross:money(unit),lineSubtotalGross:money(unit),
 tax:{included:true as const,country:'ZZ',category:'standard',vatRateBps:0,legalBasis:'Synthetic',netAmount:money(unit),vatAmount:money(0),grossAmount:money(unit)}}],
 discounts:[],context:{mode,cadenceDays:mode==='subscription'?28:null,promoCodes:[],pricingPolicy:{version:'frozen'},offerVersion:{version:1},offerEvidence:{binding:'frozen'},sizeConstraint:{minimum:1,maximum:10}},
 subtotalGross:money(unit),discountTotalGross:money(0),shippingGross:money(0),shippingDiscountGross:money(0),totalGross:money(unit),netTotal:money(unit),taxTotal:money(0)}};}

describe.each(lifecycleProfiles)('expired checkout recreation on %s',profile=>{
 let env:LifecycleInstallation;
 beforeAll(async()=>{env=await lifecycleInstallation(profile);},postgresSetupTimeoutMs);
 afterAll(async()=>env?.close(),postgresTeardownTimeoutMs);
 const at=()=>new Date().toISOString();
 const persistence=()=>createPostgresNativeCheckoutPersistence(env.runtime);
 const prepare=()=>createPostgresExpiredCheckoutRecoveryPort(env.runtime,{recoveryWindowMs:7*86400000});
 const read=async(id:string)=>(await createPostgresCheckoutRecoveryOrderPort(env.runtime).getRecoveryOrder({orderId:id}))!;
 const simulator=()=>createPostgresSandboxPaymentSimulator(env.runtime,{dunningTemplateSlug:"dunning",recoveryUrlPath:"/recover",recoveryTemplateSlug:"recover"});
 const lane={run:async<T>(work:(db:unknown)=>Promise<T>)=>{const db=await env.runtime.connect();try{await db.query('BEGIN');const result=await work(db);await db.query('COMMIT');return result;}catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}}};
 async function subject(mode:'subscription'|'one_time'='subscription',stock=10,shared?:{sku:string;skuId:string;client:string;stockSource:string}){
  const {sku,skuId,client,stockSource}=shared??{sku:`RECOVERY-${randomUUID()}`,skuId:randomUUID(),client:randomUUID(),stockSource:randomUUID()};
  if(!shared){
  await env.owner.query('INSERT INTO public.clients(id,email)VALUES($1,$2)',[client,`${client}@example.invalid`]);
  await env.owner.query("INSERT INTO public.catalog_products(id,slug,name)VALUES($1,$2,'Synthetic')",[skuId,sku.toLowerCase()]);
  await env.owner.query("INSERT INTO public.catalog_skus(id,product_id,sku,title,sellable_in_subscription)VALUES($1,$1,$2,'Synthetic',true)",[skuId,sku]);
  const list=(await env.owner.query("INSERT INTO public.price_lists(name,region_code,currency)VALUES('Synthetic','ZZ','XXX')RETURNING id")).rows[0].id;
  await env.owner.query('INSERT INTO public.price_entries(price_list_id,variant_id,unit_price_minor)VALUES($1,$2,100)',[list,skuId]);
  await env.owner.query(`INSERT INTO public.fulfillment_stock_current(source_key,sku,total_quantity,for_sale_quantity,reserved_unavailable_quantity,inventory_class,last_synced_at,stale_after,sync_run_id,idempotency_key,operation_fingerprint)
   VALUES($1,$2,$3,$3,0,'sellable',clock_timestamp(),clock_timestamp()+interval '30 days','recovery',$1,$4)`,[stockSource,sku,stock,'a'.repeat(64)]);
  }
  const frozen=quote(sku,mode),draft=await persistence().createOrderDraft({idempotencyKey:`source:${randomUUID()}`,quoteSnapshot:frozen},{clientId:client});
  const id=draft.orderDraft.orderId.replace(/^order_/,'');
  await call(env.runtime,'commerce_register_order_destination',[`destination:${id}`,id,{recipientName:'Example Buyer',line1:'Example 1',city:'Example',postalCode:'00000',country:'ZZ'},at()]);
  if(mode==='subscription')await call(env.runtime,'subscription_declare_provisional_activation',[`declare:${id}`,id,28,at()]);
  const intent=await call(env.runtime,'commerce_open_settlement_intent',[`intent:${id}`,id,'sandbox',100,'XXX',{},at()]);
  const intentId=String((intent.settlement as {id:string}).id);
  const attempt=await simulator().beginAttempt({idempotencyKey:`attempt:${id}`,settlementIntentId:intentId,requestFingerprint:'a'.repeat(64),at:at()});
  await simulator().recordObservation({attemptId:attempt.id,idempotencyKey:`refuse:${id}`,outcome:'refused',occurredAt:at()});
  // Terminal source facts are fixture setup. Native abandonment without a prior
  // provider object intentionally remains unavailable, separately proved below.
  if(mode==='subscription')await env.owner.query("UPDATE public.subscription_activations SET state='compensated',compensated_at=clock_timestamp() WHERE order_id=$1",[id]);
  await env.owner.query(`UPDATE public.commerce_orders SET created_at=clock_timestamp()-interval '2 hours',status=$2,metadata=metadata||$3::jsonb WHERE id=$1`,
   [id,mode==='subscription'?'cancelled':'expired',mode==='subscription'?{paymentStatus:'cancelled',subscriptionActivation:'abandoned',source:'initial_checkout_sweep'}:{paymentStatus:'expired',source:'checkout_reservation_expiry'}]);
  return{id,client,sku,skuId,stockSource,frozen,intentId,attemptId:attempt.id,order:await read(id)};
 }
 type Subject=Awaited<ReturnType<typeof subject>>;
 function service(f:Subject,options:{unit?:number;supports?:boolean;fail?:boolean;afterPrepare?:()=>Promise<void>;beforeReserve?:(db:CheckoutRecoveryWriteExecutor)=>Promise<void>}={}){
  const quotePort={createQuote:vi.fn(async()=>{const fresh=quote(f.sku,f.frozen.quote.context.mode,options.unit??100);Object.assign(fresh.quote.context,{requestTrace:randomUUID()});return fresh;})};
  const runtime=createPostgresExpiredCheckoutRuntime(lane,{stockSourceKey:f.stockSource,reservationLifetimeMs:1800000,channelKey:'sandbox',
   verifyPriorPayment:(input,db)=>createPostgresSandboxExpiredCheckoutSafety(db).verifyPriorPayment(input),
   reserveOrderItems:async(input,db)=>{await options.beforeReserve?.(db);return createPostgresPurchaseReservationPort(db).reserveOrderItems(input);},startPayment:async (input,db)=>{
    if(options.fail)throw new Error('downstream_failure');
    return createPostgresSandboxPaymentSimulator(db,{dunningTemplateSlug:"dunning",recoveryUrlPath:"/recover",recoveryTemplateSlug:"recover"}).beginAttempt({idempotencyKey:input.idempotencyKey,settlementIntentId:input.settlementIntentId,requestFingerprint:checkoutRecoveryExecutionFingerprint(input),at:at()});
   }});
  const deps={supports:()=>options.supports!==false,quoteRequest:()=>({}),quotePort,
   orderDraftPort:createPostgresExpiredCheckoutDraftPort(env.runtime,persistence()),recoveryPort:{async prepareReplacement(input:Parameters<ReturnType<typeof prepare>['prepareReplacement']>[0]){const result=await prepare().prepareReplacement(input);await options.afterPrepare?.();return result;}},
   paymentSafetyPort:createPostgresSandboxExpiredCheckoutSafety(env.runtime),runtimePort:runtime,compensationPort:createPostgresExpiredCheckoutCompensation(lane)};
  return{...createExpiredCheckoutRecoveryService(deps),quotePort};
 }
 const recreate=(f:Subject,s=service(f))=>s.recreate({order:f.order,clientId:f.client});
 async function sourceRows(f:Subject){return(await env.owner.query(`SELECT to_jsonb(o) AS row,xmin::text AS version,
  (SELECT jsonb_agg(to_jsonb(a)) FROM public.subscription_activations a WHERE a.order_id=o.id) AS activation FROM public.commerce_orders o WHERE o.id=$1`,[f.id])).rows;}
 async function children(id:string){return(await env.owner.query('SELECT id,status,subscription_cycle_id FROM public.commerce_orders WHERE recreated_from_order_id=$1',[id])).rows;}
 async function replacement(f:Subject,key=`checkout-recovery-recreate:${f.id}`,snapshot=f.frozen){const r=await persistence().createOrderDraft({idempotencyKey:key,quoteSnapshot:snapshot},{clientId:f.client});return r.orderDraft.orderId.replace(/^order_/,'');}
 it.each(['subscription','one_time'] as const)('starts one %s replacement under competition, replays through native owners and preserves the predecessor',async mode=>{
  const f=await subject(mode),before=await sourceRows(f),live=await lifecycleSubject(env.owner);
  const liveBefore=(await env.owner.query('SELECT to_jsonb(s) AS row FROM public.subscriptions s WHERE id=$1',[live.subscription])).rows;
  const outcomes=await Promise.all([recreate(f),recreate(f)]);
  expect(outcomes[0].id).toBe(outcomes[1].id);expect(outcomes.filter(o=>!o.replayed)).toHaveLength(1);
  const child=(await children(f.id))[0];expect(await children(f.id)).toHaveLength(1);expect(child).toMatchObject({status:'pending_payment',subscription_cycle_id:null});
  expect(await recreate(f)).toMatchObject({id:outcomes[0].id,replayed:true});
  expect(await sourceRows(f)).toEqual(before);expect((await env.owner.query('SELECT to_jsonb(s) AS row FROM public.subscriptions s WHERE id=$1',[live.subscription])).rows).toEqual(liveBefore);
  const activation=(await env.owner.query('SELECT state,subscription_id FROM public.subscription_activations WHERE order_id=$1',[child.id])).rows;
  expect(activation).toEqual(mode==='subscription'?[{state:'provisional',subscription_id:null}]:[]);
  expect((await env.owner.query('SELECT status FROM public.fulfillment_inventory_reservations WHERE purchase_order_id=$1',[child.id])).rows).toEqual([{status:'held'}]);
 });
 it.each(['profile','fallback'] as const)('keeps absent recreation buyer facts absent and freezes the %s selection',async source=>{
  const f=await subject('one_time'),profileId=randomUUID(),addressId=randomUUID();
  if(source==='profile'){
   await env.owner.query("INSERT INTO public.customer_orderer_profiles(id,client_id,full_name,email,is_default) VALUES($1,$2,'Saved Buyer','billing@example.invalid',true)",[profileId,f.client]);
   await env.owner.query("INSERT INTO public.customer_saved_addresses(id,client_id,kind,line1,line2,city,postal_code,country,is_default) VALUES($1,$2,'billing','Billing 1','Billing unit','Example','00000','ZZ',true)",[addressId,f.client]);
  }
  const predecessor=await sourceRows(f),attempt=await recreate(f),[child]=await children(f.id);
  const childRows=()=>env.owner.query('SELECT to_jsonb(o) AS row,o.xmin::text FROM public.commerce_orders o WHERE id=$1',[child.id]);
  const prepared=(await childRows()).rows;
  expect(prepared[0].row.metadata).not.toHaveProperty('invoiceBuyerSnapshot');
  expect(await recreate(f)).toMatchObject({id:attempt.id,replayed:true});
  expect((await childRows()).rows).toEqual(prepared);
  const intentId=(await env.owner.query('SELECT id FROM public.commerce_settlement_intents WHERE order_id=$1',[child.id])).rows[0].id;
  const observation=await simulator().recordObservation({attemptId:attempt.id,idempotencyKey:`capture:${child.id}`,outcome:'captured',occurredAt:at()});
  await simulator().ingress.receive({rawBody:new TextEncoder().encode(JSON.stringify({settlementIntentId:intentId,attemptId:attempt.id,observationId:observation.id})),headers:{},receivedAt:at()});
  const store=createPostgresBillingInvoiceStore(env.runtime),buyer=await store.readCapturedBuyer(child.id);
  expect(buyer).toMatchObject(source==='profile'
   ?{name:'Saved Buyer',source:'customer_orderer_profile',ordererProfileId:profileId,billingAddressId:addressId,legacyFallback:false,address:{line1:'Billing 1',line2:'Billing unit'}}
   :{name:'Example Buyer',source:'legacy_shipping_address_fallback',ordererProfileId:null,billingAddressId:null,legacyFallback:true,address:{line1:'Example 1'}});
  const capture={requestKey:`capture-replay:${child.id}`,sourceKind:'paid' as const,sourceId:randomUUID(),orderId:child.id,
   evidence:{settlementIntentId:intentId,amountMinor:100,currency:'XXX'},occurredAt:at()};
  const duty=await store.captureDuty(capture);
  if('kind' in duty)throw Error('replacement capture refused');
  const frozenRows=async()=>({
   duty:(await env.owner.query('SELECT to_jsonb(d) AS row,d.xmin::text FROM public.invoicing_duties d WHERE id=$1',[duty.dutyId])).rows,
   buyer:(await env.owner.query('SELECT to_jsonb(b) AS row,b.xmin::text FROM public.invoicing_buyer_snapshots b WHERE duty_id=$1',[duty.dutyId])).rows,
   receipts:(await env.owner.query('SELECT to_jsonb(r) AS row,r.xmin::text FROM public.invoicing_effect_receipts r WHERE duty_id=$1 ORDER BY receipt_key',[duty.dutyId])).rows,
  });
  const frozen=await frozenRows();
  await env.owner.query("UPDATE public.clients SET first_name='Changed',last_name='Buyer' WHERE id=$1",[f.client]);
  if(source==='profile'){
   await env.owner.query("UPDATE public.customer_orderer_profiles SET full_name='Changed Buyer' WHERE id=$1",[profileId]);
   await env.owner.query("UPDATE public.customer_saved_addresses SET line2='Changed unit' WHERE id=$1",[addressId]);
  }
  expect(await store.captureDuty(capture)).toEqual(duty);
  expect(await store.readCapturedBuyer(child.id)).toEqual(buyer);
  expect(await frozenRows()).toEqual(frozen);
  expect((await childRows()).rows[0].row.metadata).not.toHaveProperty('invoiceBuyerSnapshot');
  expect(await sourceRows(f)).toEqual(predecessor);
 });
 it.each(['top-level','runtime','empty','runtime-empty'] as const)('preserves a recorded %s buyer snapshot exactly without rewriting replay',async location=>{
  const f=await subject('one_time'),snapshot=location==='empty'||location==='runtime-empty'?{}:{name:'Recorded Buyer',email:'recorded@example.invalid',source:'recorded_order',
   address:{line1:'Recorded 1',line2:null,country:'ZZ'},opaque:{values:[null,false,7,'value']}};
  const metadata=location==='runtime'?{runtimeFinalize:{invoiceBuyerSnapshot:snapshot,other:'unchanged'},invoiceBuyerSnapshot:{name:'Older Buyer'}}
   :location==='runtime-empty'?{runtimeFinalize:{invoiceBuyerSnapshot:snapshot}}:{invoiceBuyerSnapshot:snapshot};
  await env.owner.query('UPDATE public.commerce_orders SET metadata=metadata||$2::jsonb WHERE id=$1',[f.id,metadata]);
  f.order=await read(f.id);
  const predecessor=await sourceRows(f),attempt=await recreate(f),[child]=await children(f.id);
  const rows=()=>env.owner.query('SELECT to_jsonb(o) AS row,o.xmin::text FROM public.commerce_orders o WHERE id=$1',[child.id]);
  const before=(await rows()).rows;
  expect(before[0].row.metadata.invoiceBuyerSnapshot).toEqual(snapshot);
  expect(before[0].row).toMatchObject({recovery_root_order_id:f.id,recreated_from_order_id:f.id});
  expect(await recreate(f)).toMatchObject({id:attempt.id,replayed:true});
  expect((await rows()).rows).toEqual(before);
  expect(await sourceRows(f)).toEqual(predecessor);
 });
 it('retains linked replay before fresh checks and never admits a sibling after compensation',async()=>{
  const f=await subject(),id=await replacement(f),key=`checkout-recovery-recreate:${f.id}`;
  expect(await prepare().prepareReplacement({idempotencyKey:key,sourceOrderId:f.id,replacementOrderId:id})).toMatchObject({replayed:false});
  await createPostgresExpiredCheckoutCompensation(lane).cancelUnstartedPromotionOrder({idempotencyKey:key,orderId:id,reason:'synthetic'});
  await env.owner.query("UPDATE public.commerce_orders SET created_at=clock_timestamp()-interval '10 days' WHERE id=$1",[f.id]);
  expect(await prepare().prepareReplacement({idempotencyKey:key,sourceOrderId:f.id,replacementOrderId:id})).toMatchObject({replayed:true});
  const sibling=await replacement(f,`sibling:${f.id}`);
  await expect(prepare().prepareReplacement({idempotencyKey:`sibling:${f.id}`,sourceOrderId:f.id,replacementOrderId:sibling})).rejects.toMatchObject({reason:'unavailable'});
  expect(await children(f.id)).toEqual([{id,status:'cancelled',subscription_cycle_id:null}]);
 });
 it('never reparents an unstarted linked replacement to another identical source',async()=>{
  const a=await subject('one_time'),b=await subject('one_time',10,a),id=await replacement(a),key=`checkout-recovery-recreate:${a.id}`;
  await prepare().prepareReplacement({idempotencyKey:key,sourceOrderId:a.id,replacementOrderId:id});
  const rows=()=>env.owner.query('SELECT to_jsonb(o) AS row,xmin::text AS version FROM public.commerce_orders o WHERE id=ANY($1::uuid[]) ORDER BY id',[[a.id,b.id,id]]);
  const before=(await rows()).rows;
  await expect(prepare().prepareReplacement({idempotencyKey:key,sourceOrderId:b.id,replacementOrderId:id})).rejects.toMatchObject({reason:'unavailable'});
  expect((await rows()).rows).toEqual(before);expect(await children(a.id)).toEqual([{id,status:'pending_payment',subscription_cycle_id:null}]);
  expect(await children(b.id)).toEqual([]);
  expect((await env.owner.query('SELECT recovery_root_order_id,recreated_from_order_id FROM public.commerce_orders WHERE id=$1',[id])).rows)
   .toEqual([{recovery_root_order_id:a.id,recreated_from_order_id:a.id}]);
 });
 it('refuses commercial drift before draft writes and rejects mismatched persisted replacement atomically',async()=>{
  const f=await subject(),before=await sourceRows(f),s=service(f,{unit:101});
  await expect(recreate(f,s)).rejects.toMatchObject({reason:'order_changed'});expect(await children(f.id)).toEqual([]);
  // Preserve total/header money but change an existing fingerprint field.
  const changed=structuredClone(f.frozen);changed.quote.lines[0].tax.legalBasis='Other';changed.quote.context.cadenceDays=29;
  const id=await replacement(f,`drift:${f.id}`,changed);
  await expect(prepare().prepareReplacement({idempotencyKey:`drift:${f.id}`,sourceOrderId:f.id,replacementOrderId:id})).rejects.toMatchObject({reason:'order_changed'});
  expect(await children(f.id)).toEqual([]);expect(await sourceRows(f)).toEqual(before);
 });
 it('reads actual sandbox success before recreation and leaves a paid original paid',async()=>{
  const f=await subject('one_time');
  await env.owner.query("UPDATE public.commerce_orders SET status='pending_payment' WHERE id=$1",[f.id]);
  const observation=await simulator().recordObservation({attemptId:f.attemptId,idempotencyKey:`late:${f.id}`,outcome:'captured',occurredAt:at()});
  await simulator().ingress.receive({rawBody:new TextEncoder().encode(JSON.stringify({settlementIntentId:f.intentId,attemptId:f.attemptId,observationId:observation.id})),headers:{},receivedAt:at()});
  const before=await sourceRows(f),s=service(f);await expect(recreate(f,s)).rejects.toMatchObject({reason:'paid'});
  expect(s.quotePort.createQuote).not.toHaveBeenCalled();expect(await children(f.id)).toEqual([]);expect(await sourceRows(f)).toEqual(before);
  expect((await read(f.id)).status).toBe('paid');
 });
 it.each([false,true])('rechecks source success after committed preparation, with open replacement intent: %s',async openIntent=>{
  const f=await subject('one_time');let paidRows:Awaited<ReturnType<typeof sourceRows>>|undefined;
  const s=service(f,{afterPrepare:async()=>{
   const [child]=await children(f.id);expect(child).toBeDefined();
   if(openIntent)await call(env.runtime,'commerce_open_settlement_intent',[`checkout-recovery-recreate:${f.id}:payment-intent`,child.id,'sandbox',100,'XXX',{},at()]);
   // Model the payable source state in which native late settlement can converge.
   await env.owner.query("UPDATE public.commerce_orders SET status='pending_payment' WHERE id=$1",[f.id]);
   const observation=await simulator().recordObservation({attemptId:f.attemptId,idempotencyKey:`between:${f.id}`,outcome:'captured',occurredAt:at()});
   await simulator().ingress.receive({rawBody:new TextEncoder().encode(JSON.stringify({settlementIntentId:f.intentId,attemptId:f.attemptId,observationId:observation.id})),headers:{},receivedAt:at()});
   paidRows=await sourceRows(f);
  }});
  await expect(recreate(f,s)).rejects.toMatchObject({reason:'paid'});
  const [child]=await children(f.id);expect(child.status).toBe('cancelled');expect((await read(f.id)).status).toBe('paid');
  expect(await sourceRows(f)).toEqual(paidRows);
  expect((await env.owner.query('SELECT status FROM public.commerce_settlement_intents WHERE order_id=$1',[child.id])).rows).toEqual(openIntent?[{status:'failed'}]:[]);
  expect((await env.owner.query('SELECT a.id FROM public.payment_simulator_attempts a JOIN public.commerce_settlement_intents i ON i.id=a.settlement_intent_id WHERE i.order_id=$1',[child.id])).rows).toEqual([]);
  expect((await env.owner.query('SELECT id FROM public.fulfillment_inventory_reservations WHERE purchase_order_id=$1',[child.id])).rows).toEqual([]);
  expect((await env.owner.query('SELECT recreated_from_order_id FROM public.commerce_orders WHERE id=$1',[child.id])).rows).toEqual([{recreated_from_order_id:f.id}]);
 });
 it('compensates a prepared declaration on captured source evidence without changing its terminal predecessor',async()=>{
  const f=await subject(),s=service(f,{afterPrepare:async()=>{
   await simulator().recordObservation({attemptId:f.attemptId,idempotencyKey:`between-terminal:${f.id}`,outcome:'captured',occurredAt:at()});
  }}),before=await sourceRows(f);
  await expect(recreate(f,s)).rejects.toMatchObject({reason:'paid'});
  const [child]=await children(f.id);expect(child.status).toBe('cancelled');expect(await sourceRows(f)).toEqual(before);
  expect((await env.owner.query('SELECT state FROM public.subscription_activations WHERE order_id=$1',[child.id])).rows).toEqual([{state:'compensated'}]);
  expect((await env.owner.query('SELECT id FROM public.commerce_settlement_intents WHERE order_id=$1',[child.id])).rows).toEqual([]);
  expect((await env.owner.query('SELECT id FROM public.fulfillment_inventory_reservations WHERE purchase_order_id=$1',[child.id])).rows).toEqual([]);
 });
 it('serializes source observations behind first replacement payment admission',async()=>{
  const f=await subject('one_time'),observer=await env.runtime.connect();
  let release!:()=>void,entered!:()=>void,runtimePid=0;
  const gate=new Promise<void>(resolve=>{release=resolve;}),reached=new Promise<void>(resolve=>{entered=resolve;});
  const s=service(f,{beforeReserve:async db=>{runtimePid=Number((await db.query('SELECT pg_backend_pid() AS id')).rows[0].id);entered();await gate;}});
  const starting=recreate(f,s);let observation:Promise<unknown>|undefined;
  try{
   await Promise.race([reached,starting]);const observerPid=(await observer.query('SELECT pg_backend_pid() AS id')).rows[0].id;
   observation=createPostgresSandboxPaymentSimulator(observer,{dunningTemplateSlug:'dunning',recoveryUrlPath:'/recover',recoveryTemplateSlug:'recover'})
    .recordObservation({attemptId:f.attemptId,idempotencyKey:`after-runtime:${f.id}`,outcome:'captured',occurredAt:at()});
   let waiting=false;
   for(let n=0;n<100&&!waiting;n++){
    waiting=(await env.owner.query('SELECT $2::integer=ANY(pg_blocking_pids($1)) AS waiting',[observerPid,runtimePid])).rows[0].waiting;
    if(!waiting)await new Promise(resolve=>setTimeout(resolve,10));
   }
   expect(waiting).toBe(true);release();const started=await starting;await observation;
   const [child]=await children(f.id);
   expect((await simulator().readAttempt({settlementIntentId:f.intentId}))?.state).toBe('captured');
   expect((await env.owner.query(`SELECT a.id FROM public.payment_simulator_attempts a JOIN public.commerce_settlement_intents i ON i.id=a.settlement_intent_id WHERE i.order_id=$1`,[child.id])).rows).toEqual([{id:started.id}]);
   expect((await env.owner.query('SELECT status FROM public.fulfillment_inventory_reservations WHERE purchase_order_id=$1',[child.id])).rows).toEqual([{status:'held'}]);
  }finally{release();await starting.catch(()=>undefined);await observation?.catch(()=>undefined);observer.release();}
 });
 it('refuses unknown, missing and mismatched provider evidence, retaining named real-provider refusal',async()=>{
  const f=await subject(),safety=createPostgresSandboxExpiredCheckoutSafety(env.runtime);
  expect(await safety.verifyPriorPayment(f.order)).toBe('safe');
  expect(await safety.verifyPriorPayment({...f.order,totalMinor:101})).toBe('unavailable');
  // Prepared/dispatched is not non-settlement. Fixture resets only for this probe.
  await env.owner.query("UPDATE public.payment_simulator_attempts SET state='dispatched',last_observation_id=NULL WHERE id=$1",[f.attemptId]);
  await expect(recreate(f)).rejects.toMatchObject({reason:'unavailable'});
  await env.owner.query('UPDATE public.payment_simulator_attempts SET last_observation_id=NULL WHERE id=$1',[f.attemptId]);
  await expect(recreate(f)).rejects.toMatchObject({reason:'unavailable'});
  const absent={...f.order,orderId:randomUUID()};expect(await safety.verifyPriorPayment(absent)).toBe('unavailable');
  await env.owner.query("UPDATE public.commerce_settlement_intents SET channel_key='other' WHERE id=$1",[f.intentId]);
  await expect(recreate(f)).rejects.toMatchObject({reason:'unavailable',code:'native_prepared_attempt_store_unsupported'});
  expect(await children(f.id)).toEqual([]);
 });
 it('fences unsupported snapshots and renewal cycles before provider/quote/draft work',async()=>{
  const f=await subject(),s=service(f,{supports:false});expect(await s.validate(f.order)).toBe(false);
  await expect(recreate(f,s)).rejects.toMatchObject({reason:'unavailable'});expect(s.quotePort.createQuote).not.toHaveBeenCalled();
  const renewal=await lifecycleSubject(env.owner);const cycle=(await env.owner.query("INSERT INTO public.subscription_cycles(subscription_id,scheduled_at,status)VALUES($1,clock_timestamp(),'planned')RETURNING id",[renewal.subscription])).rows[0].id;const order={...f.order,subscriptionCycleId:cycle} as NativeCheckoutRecoveryOrder;
  await expect(s.recreate({order,clientId:f.client})).rejects.toMatchObject({reason:'unavailable'});
  const id=await replacement(f);await env.owner.query('UPDATE public.commerce_orders SET subscription_cycle_id=$2 WHERE id=$1',[f.id,cycle]);
  await expect(prepare().prepareReplacement({idempotencyKey:`checkout-recovery-recreate:${f.id}`,sourceOrderId:f.id,replacementOrderId:id})).rejects.toMatchObject({reason:'unavailable'});
  expect(await children(f.id)).toEqual([]);
 });
 it('maps stock refusal to order_changed and compensates the retained single replacement',async()=>{
  const f=await subject('subscription',0),before=await sourceRows(f);
  await expect(recreate(f)).rejects.toMatchObject({reason:'order_changed'});
  const [child]=await children(f.id);expect(child).toMatchObject({status:'cancelled',subscription_cycle_id:null});
  expect((await env.owner.query('SELECT state FROM public.subscription_activations WHERE order_id=$1',[child.id])).rows).toEqual([{state:'compensated'}]);
  expect(await sourceRows(f)).toEqual(before);
 });
 it('runs downstream compensation in native owners and keeps lineage after runtime failure',async()=>{
  const f=await subject(),s=service(f,{fail:true});await expect(recreate(f,s)).rejects.toMatchObject({reason:'execution_failed'});
  const [child]=await children(f.id);expect(child.status).toBe('cancelled');
  expect((await env.owner.query('SELECT status FROM public.fulfillment_inventory_reservations WHERE purchase_order_id=$1',[child.id])).rows).toEqual([]);
  await expect(recreate(f)).rejects.toMatchObject({reason:'unavailable'});expect(await children(f.id)).toHaveLength(1);
 });
 it('refuses money observed after the safety read, under the writer locks',async()=>{
  const f=await subject(),id=await replacement(f);
  await simulator().recordObservation({attemptId:f.attemptId,idempotencyKey:`late-write:${f.id}`,outcome:'captured',occurredAt:at()});
  await expect(prepare().prepareReplacement({idempotencyKey:`checkout-recovery-recreate:${f.id}`,sourceOrderId:f.id,replacementOrderId:id})).rejects.toMatchObject({reason:'unavailable'});
  expect(await children(f.id)).toEqual([]);
 });
 it('admits one of two distinct replacement drafts under competing writer calls',async()=>{
  const f=await subject(),ids=await Promise.all(['first','second'].map(tag=>replacement(f,`${tag}:${f.id}`)));
  const results=await Promise.allSettled(ids.map((id,n)=>prepare().prepareReplacement({idempotencyKey:`${n===0?'first':'second'}:${f.id}`,sourceOrderId:f.id,replacementOrderId:id})));
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(results.filter(r=>r.status==='rejected')).toHaveLength(1);
  expect(await children(f.id)).toHaveLength(1);
 });
 it('checks the recovery window against the clock after a blocking order lock',async()=>{
  const f=await subject(),id=await replacement(f),blocker=await env.owner.connect(),issuer=await env.runtime.connect();
  try{
   await env.owner.query("UPDATE public.commerce_orders SET created_at=clock_timestamp()-interval '10 seconds'+interval '400 milliseconds' WHERE id=$1",[f.id]);
   await blocker.query('BEGIN');await blocker.query('SELECT id FROM public.commerce_orders WHERE id=$1 FOR UPDATE',[f.id]);
   const pid=(await issuer.query('SELECT pg_backend_pid() AS id')).rows[0].id;
   const issue=createPostgresExpiredCheckoutRecoveryPort(issuer,{recoveryWindowMs:10000}).prepareReplacement({idempotencyKey:`checkout-recovery-recreate:${f.id}`,sourceOrderId:f.id,replacementOrderId:id});
   const refusal=expect(issue).rejects.toMatchObject({reason:'unavailable'});
   let waiting=false;
   for(let n=0;n<30&&!waiting;n++){
    waiting=(await env.owner.query("SELECT cardinality(pg_blocking_pids($1))>0 AS waiting",[pid])).rows[0].waiting;
    if(!waiting)await new Promise(resolve=>setTimeout(resolve,10));
   }
   expect(waiting).toBe(true);await blocker.query('SELECT pg_sleep(0.6)');await blocker.query('COMMIT');await refusal;
   expect(await children(f.id)).toEqual([]);
  }finally{await blocker.query('ROLLBACK');blocker.release();issuer.release();}
 });
 it('never compensates a dispatched or uncertain replacement payment',async()=>{
  const f=await subject(),started=await recreate(f),[child]=await children(f.id);
  const cleanup=createPostgresExpiredCheckoutCompensation(lane),input={idempotencyKey:`cleanup:${f.id}`,orderId:child.id,reason:'synthetic'};
  await expect(cleanup.cancelAbandonedOrder(input)).resolves.toEqual({cancelled:false});
  expect(await cleanup.cancelUnstartedPromotionOrder(input)).toEqual({cancelled:false});
  await simulator().recordObservation({attemptId:started.id,idempotencyKey:`uncertain:${f.id}`,outcome:'indeterminate',occurredAt:at()});
  await expect(cleanup.cancelAbandonedOrder(input)).resolves.toEqual({cancelled:false});
  expect((await children(f.id))[0].status).toBe('pending_payment');
  expect((await env.owner.query('SELECT status FROM public.fulfillment_inventory_reservations WHERE purchase_order_id=$1',[child.id])).rows).toEqual([{status:'held'}]);
 });
 it('denies the created fixed-path writer to untrusted roles',async()=>{
  const signature='public.commerce_prepare_expired_checkout_recovery(text,uuid,uuid,bigint,timestamptz)';
  expect((await env.owner.query('SELECT prosecdef,proconfig FROM pg_proc WHERE oid=$1::regprocedure',[signature])).rows).toEqual([{prosecdef:true,proconfig:['search_path=pg_catalog, pg_temp']}]);
  for(const role of ['anon','authenticated']){const db=await env.owner.connect();try{await db.query('BEGIN');await db.query(`SET LOCAL ROLE ${role}`);
   await expect(db.query('SELECT public.commerce_prepare_expired_checkout_recovery($1,$2,$3,1000,clock_timestamp())',[randomUUID(),randomUUID(),randomUUID()])).rejects.toMatchObject({code:'42501'});
  }finally{await db.query('ROLLBACK');db.release();}}
 });
});
