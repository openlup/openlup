import { randomUUID } from 'node:crypto';
import { afterAll,beforeAll,describe,expect,it,vi } from 'vitest';
import { createPostgresPaymentRecoveryGuidancePort,readAuthorizedPaymentRecovery,createPostgresCheckoutRecoveryTokenPort,hashCheckoutRecoveryToken,createCheckoutPaymentContinuationCodec } from '@openlup/platform/commerce/server';
import { createPostgresNativeCheckoutPersistence } from '@openlup/platform/commerce/server/native-checkout';
import { createPostgresSandboxPaymentSimulator,normalizeSandboxPaymentRecoveryEvidence } from '@openlup/platform/payments';
import { lifecycleInstallation,lifecycleProfiles,call,lifecycleSubject,type LifecycleInstallation } from './subscriptionLifecycleClosureFixture.js';
import { createCommercePaymentStatusHandler } from '../../server/domains/commerce/commercePaymentStatusHandler.js';
import type { CheckoutPaymentContinuationClaims as HostClaims } from '../../server/domains/commerce/checkoutPaymentContinuationCredential.js';
import type { VercelRequest,VercelResponse } from '../../server/_lib/types/vercel.js';
import { paymentStatusResponseSchema } from '../../src/domains/commerce/checkoutContracts.js';
import { PAYMENT_RECOVERY_GUIDANCE_HEADER } from '../../src/domains/commerce/paymentRecoveryGuidanceContracts.js';
import { bffSuccessSchema } from '../../src/lib/bff/contracts.js';
import { postgresSetupTimeoutMs,postgresTeardownTimeoutMs } from '../helpers/postgresContainer.js';

describe.each(lifecycleProfiles)('atomic checkout guidance on %s',profile=>{
 let env:LifecycleInstallation;
 beforeAll(async()=>{env=await lifecycleInstallation(profile);if(profile==='legacy')await env.owner.query('CREATE ROLE service_role NOLOGIN NOINHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS');},postgresSetupTimeoutMs);
 afterAll(async()=>env?.close(),postgresTeardownTimeoutMs);
 const at=()=>new Date().toISOString();
 const simulator=()=>createPostgresSandboxPaymentSimulator(env.runtime,{dunningTemplateSlug:'dunning',recoveryUrlPath:'/recover',recoveryTemplateSlug:'recover'});
 const port=()=>createPostgresPaymentRecoveryGuidancePort(env.runtime,normalizeSandboxPaymentRecoveryEvidence);
 const tokens=()=>createPostgresCheckoutRecoveryTokenPort({run:async work=>{const db=await env.runtime.connect();try{await db.query('BEGIN');const result=await work(db);await db.query('COMMIT');return result;}catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}}});
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
 const snapshot=(f:Fixture)=>port().getGuidanceSnapshot({...f,recoveryTokenId:f.tokenId});
 const rawSnapshot=async(f:Fixture)=>(await env.runtime.query('SELECT public.commerce_checkout_payment_guidance_snapshot($1,$2,$3) AS result',[f.orderId,f.paymentIntentId,f.tokenId])).rows[0].result;
 const authorized=(f:Fixture,deps={port:port(),tokenPort:tokens()})=>readAuthorizedPaymentRecovery({request:f,claims:null,authorization:`Bearer ${f.raw}`,deps});
 // Both logical read ports use actual PostgreSQL data; no fabricated status
 // snapshot can hide a native-to-HTTP projection mismatch.
 async function httpStatus(f:Fixture,options:{header?:string;unavailable?:boolean;revokeDuringValidation?:boolean;cookie?:boolean;forbidFallback?:boolean}={}){
  const journeyId=`checkout:${randomUUID()}`;
  const codec=createCheckoutPaymentContinuationCodec(randomUUID()+randomUUID(),{cookieName:'__Host-guidance-test',executionRails:['sandbox','other']})!;
  const getPaymentStatus=vi.fn(async(input:{orderId:string;paymentIntentId:string})=>{
   if(options.forbidFallback)throw new Error('unexpected_legacy_fallback');
   return port().getGuidanceSnapshot(input);
  });
  const getGuidanceSnapshot=vi.fn(async(input:{orderId:string;paymentIntentId:string;recoveryTokenId?:string})=>{
   if(options.unavailable)throw new Error('payment_recovery_snapshot_unavailable');
   return port().getGuidanceSnapshot(input);
  });
  const validate=vi.fn(async(raw:string)=>{const result=await tokens().validate(raw);
   if(options.revokeDuringValidation)await env.owner.query('UPDATE public.commerce_checkout_recovery_tokens SET revoked_at=clock_timestamp() WHERE id=$1',[f.tokenId]);
   return result;
  });
  const handler=createCommercePaymentStatusHandler({mutationsEnabled:()=>true,resolveFailureDisplay:()=>null,
   statusPort:{getPaymentStatus},recoveryGuidance:{port:{getGuidanceSnapshot},tokenPort:{validate},resolveFailureDisplay:()=>null},
   // The host callback type names its configured live rails. Bind the portable
   // codec's real verified sandbox claims here without changing host rail config.
   readContinuationClaims:header=>codec.verifyCookieHeader(header) as unknown as HostClaims|null});
  const headers:Record<string,string>={authorization:`Bearer ${f.raw}`};
  if(options.header!==undefined)headers[PAYMENT_RECOVERY_GUIDANCE_HEADER.toLowerCase()]=options.header;
  if(options.cookie){delete headers.authorization;headers.cookie=codec.issue({journeyId,orderId:f.orderId,clientId:f.clientId,paymentIntentId:f.paymentIntentId,paymentAttemptId:f.attemptId,executionRail:'sandbox'}).setCookie.split(';')[0];}
  const response={getHeader:vi.fn(),setHeader:vi.fn(),status:vi.fn(),json:vi.fn<(body:{ok:boolean;data:Record<string,unknown>;meta:unknown})=>unknown>()};response.status.mockReturnValue(response);response.json.mockReturnValue(response);
  await handler({method:'GET',query:{orderId:f.orderId,clientId:f.clientId,paymentIntentId:f.paymentIntentId,journeyId},headers} as unknown as VercelRequest,response as unknown as VercelResponse);
  expect(response.status).toHaveBeenCalledWith(200);expect(response.setHeader).toHaveBeenCalledWith('Cache-Control','no-store');
  return{envelope:response.json.mock.calls[0][0],getPaymentStatus,getGuidanceSnapshot,validate};
 }
 const legacyStatusSchema=paymentStatusResponseSchema.pick({contractVersion:true,orderId:true,paymentIntentId:true,status:true,orderStatus:true,payment:true,failureReason:true,subscriptionActivation:true,nextAction:true}).strict();
 const legacyBody=(f:Fixture,updatedAt:string,subscriptionId:string|null=null)=>({contractVersion:'commerce.checkout.v2',orderId:f.orderId,paymentIntentId:f.paymentIntentId,
  orderStatus:subscriptionId?'paid':'pending_payment',status:subscriptionId?'paid':'failed',
  payment:{intentStatus:subscriptionId?'succeeded':'created',attemptStatus:subscriptionId?'succeeded':'failed',paymentAttemptId:f.attemptId,provider:'sandbox',providerPaymentId:null,updatedAt},
  failureReason:null,subscriptionActivation:{status:subscriptionId?'active':'not_applicable',subscriptionId},nextAction:null});
 const envelope=(data:unknown)=>({ok:true,data,meta:{contractVersion:'commerce.checkout.v2'}});
 it('keeps the exact legacy HTTP response and does not consult guidance without capability opt-in',async()=>{
  const f=await fixture(),raw=await rawSnapshot(f),body=legacyBody(f,raw.snapshot.updatedAt);
  for(const header of [undefined,'0']){const r=await httpStatus(f,{header});expect(r.envelope).toEqual(envelope(body));
   expect(bffSuccessSchema(legacyStatusSchema).parse(r.envelope).data).toEqual(body);
   expect(r.envelope.data).not.toHaveProperty('recoveryGuidance');expect(r.getPaymentStatus).toHaveBeenCalledOnce();expect(r.getGuidanceSnapshot).not.toHaveBeenCalled();expect(r.validate).not.toHaveBeenCalled();}
 });
 it('projects the real atomic native snapshot into the opted-in HTTP response without legacy fallback',async()=>{
  const f=await fixture(),raw=await rawSnapshot(f),r=await httpStatus(f,{header:'1',forbidFallback:true});
  expect(r.envelope).toEqual(envelope({...legacyBody(f,raw.snapshot.updatedAt),recoveryGuidance:{version:1,paymentAttemptId:f.attemptId,purchaseContext:'one_time',
   cause:'generic_decline',methodKind:null,methodKey:null,operation:null,restriction:null,actions:['change_instrument','change_method'],consecutiveRefusals:null,emphasis:'normal'}}));
  expect(r.getGuidanceSnapshot).toHaveBeenCalledWith({orderId:f.orderId,paymentIntentId:f.paymentIntentId,recoveryTokenId:f.tokenId});expect(r.getPaymentStatus).not.toHaveBeenCalled();
 });
 it('preserves the real native legacy HTTP fallback when optional guidance infrastructure fails',async()=>{
  const f=await fixture(),raw=await rawSnapshot(f),r=await httpStatus(f,{header:'1',unavailable:true});
  expect(r.envelope).toEqual(envelope({...legacyBody(f,raw.snapshot.updatedAt),recoveryGuidance:null}));
  expect(r.getGuidanceSnapshot).toHaveBeenCalledOnce();expect(r.getPaymentStatus).toHaveBeenCalledOnce();
 });
 it('withholds HTTP guidance when a token is revoked between validation and the native snapshot, and on subsequent polling',async()=>{
  const f=await fixture(),raw=await rawSnapshot(f),expected=envelope({...legacyBody(f,raw.snapshot.updatedAt),recoveryGuidance:null});
  const race=await httpStatus(f,{header:'1',revokeDuringValidation:true,forbidFallback:true});expect(race.envelope).toEqual(expected);
  expect(race.getGuidanceSnapshot).toHaveBeenCalledOnce();expect(race.getPaymentStatus).not.toHaveBeenCalled();
  const revoked=await httpStatus(f,{header:'1'});expect(revoked.envelope).toEqual(expected);expect(revoked.getGuidanceSnapshot).not.toHaveBeenCalled();expect(revoked.getPaymentStatus).toHaveBeenCalledOnce();
 });
 it('serves an owner-activated checkout through the atomic HTTP path with no schema rejection or fallback',async()=>{
  const f=await fixture(true),observation=await simulator().recordObservation({attemptId:f.attemptId,idempotencyKey:`activate-capture:${f.orderId}`,outcome:'captured',occurredAt:at()});
  await simulator().ingress.receive({rawBody:new TextEncoder().encode(JSON.stringify({settlementIntentId:f.paymentIntentId,attemptId:f.attemptId,observationId:observation.id})),headers:{},receivedAt:at()});
  const fingerprint=(await env.owner.query("SELECT encode(sha256(convert_to(COALESCE(external_ref,id::text),'UTF8')),'hex') AS value FROM public.commerce_settlement_intents WHERE id=$1",[f.paymentIntentId])).rows[0].value;
  // Fixture setup uses the native activation owner, including its verified
  // settlement identity; the HTTP read keeps actual runtime privileges.
  const activated=await call(env.owner,'subscription_activate_from_captured_payment',[`activate-guidance:${f.orderId}`,f.orderId,fingerprint]);
  expect(activated.state).toBe('active');
  const raw=await rawSnapshot(f);expect(raw.snapshot.activationState).toBe('active');expect(await snapshot(f)).toMatchObject({activationState:'active',subscriptionActivationStatus:'active',subscriptionId:activated.subscriptionId});
  const r=await httpStatus(f,{header:'1',cookie:true,forbidFallback:true});
  expect(r.envelope).toEqual(envelope({...legacyBody(f,raw.snapshot.updatedAt,String(activated.subscriptionId)),recoveryGuidance:null}));
  expect(r.getGuidanceSnapshot).toHaveBeenCalledOnce();expect(r.getPaymentStatus).not.toHaveBeenCalled();expect(r.validate).not.toHaveBeenCalled();
 });
 async function history(f:Fixture,count:number,captured=false){
  const ids=Array.from({length:count},()=>randomUUID()),obs=ids.map(()=>randomUUID());
  await env.owner.query(`INSERT INTO public.payment_simulator_attempts(id,settlement_intent_id,request_key,request_fingerprint,is_active,state,dispatched_at,updated_at,
   authorization_ref,unattended_charge_authorized_at,payer_account_ref,method_ref,method_evidence_ref)
   SELECT x.id,a.settlement_intent_id,x.id::text,a.request_fingerprint,false,'dispatched',a.dispatched_at-(x.n+CASE WHEN $3::boolean THEN 1000 ELSE 0 END)*interval '1 second',a.updated_at,
    a.authorization_ref,a.unattended_charge_authorized_at,a.payer_account_ref,a.method_ref,a.method_evidence_ref
   FROM unnest($1::uuid[]) WITH ORDINALITY x(id,n) CROSS JOIN public.payment_simulator_attempts a WHERE a.id=$2`,[ids,f.attemptId,captured]);
  await env.owner.query(`INSERT INTO public.payment_simulator_observations(id,attempt_id,event_key,event_fingerprint,outcome,occurred_at)
   SELECT o,id,o::text,repeat('b',64),$3,clock_timestamp() FROM unnest($1::uuid[],$2::uuid[])x(id,o)`,[ids,obs,captured?'captured':'refused']);
  await env.owner.query(`UPDATE public.payment_simulator_attempts a SET state=$3,last_observation_id=x.o FROM unnest($1::uuid[],$2::uuid[])x(id,o) WHERE a.id=x.id`,[ids,obs,captured?'captured':'refused']);
  return ids;
 }
 it('binds real draft, exact order/intent/current attempt and initial declaration without inventing method facts',async()=>{
  const f=await fixture(),s=await snapshot(f);expect(s).toMatchObject({eligible:true,tokenAuthorized:true,purchaseContext:'one_time',paymentAttemptId:f.attemptId,
   attempts:[{id:f.attemptId,status:'failed',evidence:{refusalVerified:true,cause:'generic_decline',method:null,operation:null,advice:null}}]});
  expect((await authorized(f))?.guidance).toMatchObject({methodKind:null,methodKey:null,operation:null,consecutiveRefusals:null,actions:['change_instrument','change_method']});
  const initial=await fixture(true);expect(await snapshot(initial)).toMatchObject({eligible:true,purchaseContext:'subscription_initial',activationState:'provisional',subscriptionId:null,hasExactGap:false});
  expect(await port().getGuidanceSnapshot({orderId:randomUUID(),paymentIntentId:f.paymentIntentId})).toBeNull();
  expect(await port().getGuidanceSnapshot({orderId:f.orderId,paymentIntentId:initial.paymentIntentId})).toBeNull();
  expect(await readAuthorizedPaymentRecovery({request:{...f,clientId:randomUUID()},claims:null,authorization:`Bearer ${f.raw}`,deps:{port:port(),tokenPort:tokens()}})).toBeNull();
 });
 it('atomically rechecks revocation between validation and the snapshot',async()=>{
  const f=await fixture(),tokenPort={...tokens(),validate:async(raw:string)=>{const result=await tokens().validate(raw);await env.owner.query('UPDATE public.commerce_checkout_recovery_tokens SET revoked_at=clock_timestamp() WHERE id=$1',[f.tokenId]);return result;}};
  expect(await authorized(f,{port:port(),tokenPort})).toMatchObject({snapshot:{tokenAuthorized:false},guidance:null});
  expect(await tokens().validate(f.raw)).toBeNull();
 });
 it('rejects foreign client/token, elapsed authority, missing provenance and renewal contexts',async()=>{
  const f=await fixture(),other=await fixture();
  expect(await port().getGuidanceSnapshot({...f,recoveryTokenId:other.tokenId})).toMatchObject({tokenAuthorized:false});
  await env.owner.query('UPDATE public.commerce_checkout_recovery_tokens SET client_id=$2 WHERE id=$1',[f.tokenId,other.clientId]);expect(await snapshot(f)).toMatchObject({tokenAuthorized:false});
  await env.owner.query("UPDATE public.commerce_checkout_recovery_tokens SET created_at=clock_timestamp()-interval '2 days',expires_at=clock_timestamp()-interval '1 day' WHERE id=$1",[f.tokenId]);expect(await snapshot(f)).toMatchObject({tokenAuthorized:false});
  await env.owner.query("UPDATE public.commerce_orders SET metadata=metadata-'quoteSnapshot' WHERE id=$1",[f.orderId]);expect(await snapshot(f)).toMatchObject({eligible:false});
  const live=await lifecycleSubject(env.owner),cycle=(await env.owner.query("INSERT INTO public.subscription_cycles(subscription_id,scheduled_at,status)VALUES($1,clock_timestamp(),'planned')RETURNING id",[live.subscription])).rows[0].id;
  await env.owner.query('UPDATE public.commerce_orders SET subscription_cycle_id=$2 WHERE id=$1',[other.orderId,cycle]);
  expect(await snapshot(other)).toMatchObject({eligible:false,tokenAuthorized:false,subscriptionId:null,subscriptionStatus:null});
  // The cycle initially belongs to another client. An owned renewal retains its
  // real legacy subscription display while remaining ineligible for guidance.
  await env.owner.query('UPDATE public.commerce_orders SET client_id=$2 WHERE id=$1',[other.orderId,live.client]);
  expect(await snapshot(other)).toMatchObject({eligible:false,tokenAuthorized:false,subscriptionId:live.subscription,subscriptionStatus:'active',subscriptionActivationStatus:'active'});
 });
 it('refuses an active attempt whose latest observation belongs to another attempt',async()=>{
  const f=await fixture(),other=await fixture();
  await env.owner.query('UPDATE public.payment_simulator_attempts SET last_observation_id=$2 WHERE id=$1',[f.attemptId,other.observationId]);
  expect(await snapshot(f)).toMatchObject({eligible:false,historyComplete:false});expect((await authorized(f))?.guidance).toBeNull();
 });
 it('suppresses observed capture before settlement converges without declaring the original paid',async()=>{
  const f=await fixture();await simulator().recordObservation({attemptId:f.attemptId,idempotencyKey:`capture:${f.orderId}`,outcome:'captured',occurredAt:at()});
  expect(await rawSnapshot(f)).toMatchObject({observedSuccess:true,snapshot:{orderStatus:'pending_payment',intentStatus:'created'},attempts:[{evidence:[]}]});
  expect(await authorized(f)).toMatchObject({guidance:null});
  const other=await fixture();expect(await snapshot(other)).toMatchObject({observedSuccess:false});
 });
 it('searches success outside the bounded history, including an older exactly linked attempt',async()=>{
  const f=await fixture();await history(f,101);expect(await rawSnapshot(f)).toMatchObject({historyComplete:false});expect((await rawSnapshot(f)).attempts).toHaveLength(100);
  const [old]=await history(f,1,true);expect((await rawSnapshot(f)).attempts.some((a:{id:string})=>a.id===old)).toBe(false);expect(await rawSnapshot(f)).toMatchObject({observedSuccess:true});expect((await rawSnapshot(f)).attempts.every((a:{evidence:unknown[]})=>!a.evidence.length)).toBe(true);
 });
 it('admits 100 attempts and 32 evidence members, but drops the whole proof set on a 33rd member',async()=>{
  const f=await fixture();await history(f,99);expect(await snapshot(f)).toMatchObject({historyComplete:true});expect((await rawSnapshot(f)).attempts).toHaveLength(100);
  await env.owner.query(`INSERT INTO public.payment_simulator_observations(attempt_id,event_key,event_fingerprint,outcome,occurred_at)
   SELECT $1,gen_random_uuid()::text,repeat('c',64),'refused',clock_timestamp() FROM generate_series(1,31)`,[f.attemptId]);
  expect((await rawSnapshot(f)).attempts[0].evidence).toHaveLength(32);expect((await rawSnapshot(f)).historyComplete).toBe(true);
  await env.owner.query(`INSERT INTO public.payment_simulator_observations(attempt_id,event_key,event_fingerprint,outcome,occurred_at)VALUES($1,$2,repeat('c',64),'refused',clock_timestamp())`,[f.attemptId,randomUUID()]);
  expect((await rawSnapshot(f)).attempts[0].evidence).toEqual([]);expect((await rawSnapshot(f)).historyComplete).toBe(false);
 });
 it('rejects an oversized native envelope and exposes only whitelisted evidence fields',async()=>{
  const f=await fixture();await env.owner.query("UPDATE public.payment_simulator_attempts SET method_ref='sandbox:private-diagnostic-field' WHERE id=$1",[f.attemptId]);
  let s=await rawSnapshot(f);expect(JSON.stringify(s)).not.toContain('private-diagnostic-field');expect(JSON.stringify(s)).not.toContain('token_hash');
  expect(Object.keys(s.attempts[0].evidence[0]).sort()).toEqual(['observationId','outcome','paymentAttemptId','paymentIntentId','refusalVerified','source','sourceId','version'].sort());
  await env.owner.query("UPDATE public.payment_simulator_observations SET event_key=repeat('x',9000) WHERE id=$1",[f.observationId]);
  s=await rawSnapshot(f);expect(s.historyComplete).toBe(false);expect(s.attempts[0].evidence).toEqual([]);
 });
 it('correlates native event/readback envelopes exactly, rejects contradictory or oversized proof and never exposes diagnostics',async()=>{
  const f=await fixture(),observed=(await env.owner.query('SELECT * FROM public.payment_simulator_observations WHERE id=$1',[f.observationId])).rows[0];
  const evidence={sourceKind:'accepted_event',sourceReference:f.observationId,attemptRef:f.attemptId,observedStatus:'refused',observedAt:observed.occurred_at.toISOString(),payloadFingerprint:observed.event_fingerprint,privateDiagnostic:'private-diagnostic-field'};
  const event=(await env.owner.query(`INSERT INTO public.payment_truth_events(source_event_id,event_fingerprint,ingest_idempotency_key,settlement_intent_id,outcome,amount_minor,currency_code,failure_class,source_evidence,occurred_at)
   VALUES($1,repeat('d',64),$1,$2,'refused',100,'XXX','unknown_refusal',$3,$4)RETURNING id`,[randomUUID(),f.paymentIntentId,evidence,observed.occurred_at])).rows[0].id;
  await env.owner.query(`INSERT INTO public.payment_truth_reconciliation_evidence(event_id,idempotency_key,evidence_fingerprint,evidence_status,outcome,failure_class,source_evidence,occurred_at)
   VALUES($1,$2,repeat('e',64),'observed','refused','unknown_refusal',$3,$4)`,[event,randomUUID(),{...evidence,sourceKind:'reconciliation_read'},observed.occurred_at]);
  let s=await rawSnapshot(f);expect(s.historyComplete).toBe(true);expect(s.attempts[0].evidence).toHaveLength(3);expect(JSON.stringify(s)).not.toContain('private-diagnostic-field');
  await env.owner.query("UPDATE public.payment_truth_events SET source_evidence=jsonb_set(source_evidence,'{payloadFingerprint}',to_jsonb(repeat('f',64))) WHERE id=$1",[event]);
  s=await rawSnapshot(f);expect(s.historyComplete).toBe(false);expect(s.attempts[0].evidence).toEqual([]);
  await env.owner.query('UPDATE public.payment_truth_events SET source_evidence=$2 WHERE id=$1',[event,{...evidence,observedAt:'not-a-date'}]);
  expect((await rawSnapshot(f)).historyComplete).toBe(false);
  await env.owner.query('UPDATE public.payment_truth_events SET source_evidence=$2 WHERE id=$1',[event,{...evidence,privateDiagnostic:'x'.repeat(9000)}]);
  expect((await rawSnapshot(f)).attempts[0].evidence).toEqual([]);
  await env.owner.query('UPDATE public.payment_truth_events SET source_evidence=$2 WHERE id=$1',[event,{...evidence,attemptRef:randomUUID()}]);
  s=await rawSnapshot(f);expect(s.historyComplete).toBe(true);expect(s.attempts[0].evidence).toHaveLength(2);
 });
 it('returns raw activation and exact gap facts without synthesizing a subscription or a mandate state',async()=>{
  const f=await fixture(true);
  await env.owner.query("UPDATE public.commerce_orders SET status='paid' WHERE id=$1",[f.orderId]);
  await env.owner.query("UPDATE public.commerce_settlement_intents SET status='settled',settled_at=clock_timestamp() WHERE id=$1",[f.paymentIntentId]);
  expect(await snapshot(f)).toMatchObject({activationState:'provisional',hasExactGap:true,subscriptionId:null,subscriptionStatus:null,subscriptionActivationStatus:'not_applicable',intentStatus:'succeeded',tokenAuthorized:false});
 });
 it('keeps polling read-only across orders, tokens, evidence, activation, destinations and outbox',async()=>{
  const f=await fixture(true),tables=['commerce_orders','commerce_order_items','commerce_order_draft_receipts','commerce_checkout_recovery_tokens','commerce_settlement_intents','subscription_activations','payment_simulator_attempts','payment_simulator_observations','payment_truth_events','payment_truth_reconciliation_evidence','commerce_destinations','commerce_destination_bindings','outbox_events'];
  const census=async()=>{const result:unknown[]=[];for(const table of tables)result.push((await env.owner.query(`SELECT to_jsonb(t) AS row,xmin::text AS version FROM public.${table} t ORDER BY to_jsonb(t)::text`)).rows);return result;};
  const before=await census();for(let n=0;n<5;n++)await authorized(f);expect(await census()).toEqual(before);
 });
 it('retains the named real-provider refusal and denies anonymous/account function execution',async()=>{
  const f=await fixture();await env.owner.query("UPDATE public.commerce_settlement_intents SET channel_key='other' WHERE id=$1",[f.paymentIntentId]);
  await expect(snapshot(f)).rejects.toThrow('native_prepared_attempt_store_unsupported');
  const signature='public.commerce_checkout_payment_guidance_snapshot(uuid,uuid,uuid)';
  expect((await env.owner.query('SELECT provolatile,prosecdef,proconfig FROM pg_proc WHERE oid=$1::regprocedure',[signature])).rows).toEqual([{provolatile:'s',prosecdef:true,proconfig:['search_path=pg_catalog, pg_temp']}]);
  for(const role of ['anon','authenticated']){const db=await env.owner.connect();try{await db.query('BEGIN');await db.query(`SET LOCAL ROLE ${role}`);await expect(db.query('SELECT public.commerce_checkout_payment_guidance_snapshot($1,$2)',[f.orderId,f.paymentIntentId])).rejects.toMatchObject({code:'42501'});}finally{await db.query('ROLLBACK');db.release();}}
 });
});
