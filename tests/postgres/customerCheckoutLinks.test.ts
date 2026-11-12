import {randomUUID}from'node:crypto';
import{afterAll,beforeAll,describe,expect,it}from'vitest';
import{createCheckoutRecoveryStartHandler,createCheckoutPaymentLinkHandler,createCheckoutPaymentContinuationCodec,
 createPostgresCustomerCheckoutRecoveryStartPort,createPostgresBuyerCheckoutLinkPort,createPostgresCheckoutRecoveryTokenPort,
 createPostgresCheckoutRecoveryWaves,createOutboxCheckoutRecoveryEmailHandler,hashCheckoutRecoveryToken,type CustomerCheckoutRecoveryStartPort}from'@openlup/platform/commerce/server';
import{lifecycleInstallation,lifecycleProfiles,lifecycleDeclined,call,type LifecycleInstallation}from'./subscriptionLifecycleClosureFixture.js';
import{postgresSetupTimeoutMs,postgresTeardownTimeoutMs}from'../helpers/postgresContainer.js';
const DAY=86400000,policy={lifetimeMs:DAY,sendBucketMs:600000};
describe.each(lifecycleProfiles)('customer checkout links on %s',profile=>{
 let env:LifecycleInstallation;
 beforeAll(async()=>{env=await lifecycleInstallation(profile);if(profile==='legacy')await env.owner.query('CREATE ROLE service_role NOLOGIN NOINHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS');},postgresSetupTimeoutMs);
 afterAll(async()=>env?.close(),postgresTeardownTimeoutMs);
 async function order(initial=false){
  const id=randomUUID(),client=randomUUID(),principal=randomUUID(),db=await env.owner.connect();
  try{await db.query('BEGIN');await db.query('INSERT INTO public.platform_human_principals(principal_id,email)VALUES($1,$2)',[principal,`${principal}@example.invalid`]);
   await db.query('INSERT INTO public.clients(id,principal_id,email)VALUES($1,$2,$3)',[client,principal,`${client}@example.invalid`]);
   await db.query(`INSERT INTO public.commerce_orders(id,client_id,created_at,currency_code,total_amount_minor,metadata)
    VALUES($1,$2,clock_timestamp()-interval '2 hours','XXX',100,$3)`,[id,client,{orderDraftSnapshot:{context:{mode:initial?'subscription':'one_time',...(initial?{cadenceDays:28}:{})}}}]);
   await db.query('INSERT INTO public.commerce_order_items(order_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor)VALUES($1,1,1,100,100)',[id]);await db.query('COMMIT');
  }catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
  const activation=initial?await call(env.runtime,'subscription_declare_provisional_activation',[`declare:${id}`,id,28,new Date().toISOString()]):null;
  return{id,client,principal,activation};
 }
 const port=(principal:string)=>createPostgresCustomerCheckoutRecoveryStartPort({query:(sql,values)=>env.actor(principal,db=>db.query(sql,values))});
 const buyer=(executor=env.runtime)=>createPostgresBuyerCheckoutLinkPort(executor,policy);
 const tokens=async(id:string)=>(await env.owner.query('SELECT * FROM public.commerce_checkout_recovery_tokens WHERE order_id=$1 ORDER BY created_at,id',[id])).rows;
 const events=async(id:string)=>(await env.owner.query("SELECT * FROM public.outbox_events WHERE aggregate_id=$1 AND event_type='commerce.checkout_recovery' ORDER BY created_at,id",[id])).rows;
 const service=()=>createPostgresCheckoutRecoveryTokenPort({run:async work=>{const db=await env.runtime.connect();try{await db.query('BEGIN');const r=await work(db);await db.query('COMMIT');return r;}catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}}});
 function response(){const result:{code?:string;data?:unknown;details?:unknown}={};return{result,respond:{sendMethodNotAllowed:()=>{result.code='METHOD';},sendBffError:(_:null,code:string,__:string,o?:{details:unknown})=>{result.code=code;result.details=o?.details;},sendBffSuccess:(_:null,data:unknown)=>{result.data=data;}}};}
 async function start(principal:string,body:unknown,custom?:CustomerCheckoutRecoveryStartPort,at?:Date){const r=response();await createCheckoutRecoveryStartHandler({recoveryEnabled:()=>true,authenticateUser:async()=>({ok:true,userId:principal}),createPort:()=>custom??port(principal),respond:r.respond,lifetimeMs:DAY,now:()=>at??new Date()})({method:'POST',body},null);return r.result;}
 it('returns fresh raw navigation tokens, no mail, and keeps earlier wave and service links live',async()=>{
  const f=await order(),first=randomUUID();await service().issue({orderId:f.id,rawToken:first,expiresAt:'ignored'});
  await createPostgresCheckoutRecoveryWaves(env.runtime,{profile:'capture'}).enqueue(100,new Date().toISOString());const before=(await events(f.id)).length;
  const a=await start(f.principal,{orderId:f.id}),b=await start(f.principal,{orderId:f.id});
  expect(a.data).toMatchObject({recoverable:true,mode:'one_time_order'});expect(b.data).toMatchObject({recoverable:true});
  const raw=(a.data as {token:string}).token,other=(b.data as {token:string}).token;expect(raw).not.toBe(other);
  expect((await tokens(f.id)).every(t=>t.revoked_at===null)).toBe(true);expect(await service().validate(raw)).toMatchObject({orderId:f.id});
  expect(await service().validate(first)).toMatchObject({orderId:f.id});expect(await events(f.id)).toHaveLength(before);
 });
 it('selects a declared initial checkout before a cycle/subscription exists and isolates the customer',async()=>{
  const f=await order(true),stranger=await order();const activation=String(f.activation!.activationId);
  expect(await port(f.principal).find({subscriptionId:activation})).toMatchObject({orderId:f.id,mode:'subscription_cycle',subscriptionId:activation,clientHasLiveOrPendingSubscription:true});
  expect((await start(f.principal,{subscriptionId:activation})).data).toMatchObject({recoverable:true,mode:'subscription_cycle'});
  expect(await port(stranger.principal).find({orderId:f.id})).toBeNull();expect(await port(stranger.principal).find({subscriptionId:activation})).toBeNull();
  const own=await start(stranger.principal,{orderId:f.id});expect(own.data).toMatchObject({recoverable:false,fallback:'fresh_checkout'});
  expect(await port(stranger.principal).context(f.id)).toMatchObject({orderId:null,mode:null,subscriptionId:null,clientHasLiveOrPendingSubscription:false});
  await expect(port(stranger.principal).issue({orderId:f.id,rawToken:randomUUID(),expiresAt:new Date(Date.now()+3600000).toISOString()})).rejects.toMatchObject({reason:'order_not_recoverable'});
 });
 it('selects the native initial declaration identity and the exact order when requested',async()=>{
  const f=await order(true);expect((await start(f.principal,{orderId:f.id})).data).toMatchObject({recoverable:true,mode:'subscription_cycle'});
  expect(await port(f.principal).find({subscriptionId:randomUUID()})).toBeNull();
  expect((await start(f.principal,{subscriptionId:randomUUID()})).data).toMatchObject({recoverable:false,fallback:'customer_account'});
 });
 it.each([false,true])('returns the existing fallback for a dead deadline and issues a future link (initial=%s)',async initial=>{
  const f=await order(initial);const clock=(await env.owner.query("UPDATE public.commerce_orders SET created_at=clock_timestamp()-interval '24 hours'-interval '1 millisecond' WHERE id=$1 RETURNING created_at+interval '24 hours' AS deadline,clock_timestamp() AS at",[f.id])).rows[0];
  expect(clock.deadline.getTime()).toBeLessThan(clock.at.getTime());
  expect((await start(f.principal,{orderId:f.id},undefined,clock.at)).data).toMatchObject({recoverable:false,fallback:initial?'customer_account':'fresh_checkout'});expect(await tokens(f.id)).toEqual([]);
  await env.owner.query("UPDATE public.commerce_orders SET created_at=clock_timestamp()-interval '23 hours' WHERE id=$1",[f.id]);
  expect((await start(f.principal,{orderId:f.id})).data).toMatchObject({recoverable:true});expect(await tokens(f.id)).toHaveLength(1);
 });
 it('uses owned terminal and subscriber context, and treats paid-between-read-and-mint as fallback',async()=>{
  const f=await order(true);await env.owner.query("UPDATE public.commerce_orders SET status='cancelled' WHERE id=$1",[f.id]);
  expect((await start(f.principal,{orderId:f.id})).data).toMatchObject({recoverable:false,fallback:'customer_account'});
  expect((await start(f.principal,{orderId:randomUUID()})).data).toMatchObject({recoverable:false,fallback:'customer_account'});
  const one=await order(),actual=port(one.principal),raced={...actual,issue:async(input:Parameters<typeof actual.issue>[0])=>{await env.owner.query("UPDATE public.commerce_orders SET status='paid' WHERE id=$1",[one.id]);return actual.issue(input);}};
  expect((await start(one.principal,{orderId:one.id},raced)).data).toMatchObject({recoverable:false,fallback:'fresh_checkout'});expect(await tokens(one.id)).toEqual([]);
 });
 it('refuses renewal orders on both issuers and leaves payment-case recovery untouched',async()=>{
  const f=await lifecycleDeclined(env.owner),id=f.original.orderId,principal=randomUUID();await env.owner.query('INSERT INTO public.platform_human_principals(principal_id,email)VALUES($1,$2)',[principal,`${principal}@example.invalid`]);
  await env.owner.query('UPDATE public.clients SET principal_id=$2 WHERE id=$1',[f.client,principal]);const before=await tokens(id);
  expect(await port(principal).find({orderId:id})).toBeNull();expect(await port(principal).find({subscriptionId:f.subscription})).toBeNull();
  await expect(port(principal).issue({orderId:id,rawToken:randomUUID(),expiresAt:new Date(Date.now()+3600000).toISOString()})).rejects.toMatchObject({reason:'order_not_recoverable'});
  await expect(buyer().issue({orderId:id,clientId:f.client,rawToken:randomUUID(),requestedAt:new Date().toISOString()})).rejects.toMatchObject({reason:'order_not_recoverable'});
  expect(await tokens(id)).toEqual(before);expect(await events(id)).toEqual([]);
 });
 it('arbitrates concurrent bucket taps atomically, preserving the first mailed bearer and allowing a later bucket',async()=>{
  const f=await order(),at=new Date().toISOString(),rows=await Promise.all(['rcv_first','rcv_second'].map(rawToken=>buyer().issue({orderId:f.id,clientId:f.client,rawToken,requestedAt:at})));
  expect(rows.map(r=>r.queued).sort()).toEqual([false,true]);const first=(await events(f.id))[0];expect(await events(f.id)).toHaveLength(1);expect(await tokens(f.id)).toHaveLength(1);
  expect(first.metadata).toEqual({source:'buyer_payment_link'});expect(first.payload).toMatchObject({buyerRequested:true,mode:'one_time',orderId:f.id});
  expect((await tokens(f.id))[0].token_hash).toBe(hashCheckoutRecoveryToken(first.payload.recoveryToken));
  await buyer().issue({orderId:f.id,clientId:f.client,rawToken:'rcv_next',requestedAt:new Date(Date.parse(at)+policy.sendBucketMs).toISOString()});
  expect(await tokens(f.id)).toHaveLength(2);expect(await events(f.id)).toHaveLength(2);expect(await service().validate(first.payload.recoveryToken)).toMatchObject({orderId:f.id});
 });
 it('uses only verified cookie order/client claims and never body-selected targets',async()=>{
  const f=await order(),codec=createCheckoutPaymentContinuationCodec('x'.repeat(40),{cookieName:'continuation',executionRails:['captured','redirect']})!;
  const cookie=(clientId=f.client)=>codec.issue({journeyId:`checkout:${randomUUID()}`,orderId:f.id,clientId,paymentAttemptId:randomUUID(),paymentIntentId:randomUUID(),executionRail:'captured'}).setCookie.split(';')[0];
  for(const header of [undefined,'continuation=invalid',cookie(randomUUID())]){
   const r=response();let constructed=false;await createCheckoutPaymentLinkHandler({codec,createPort:()=>{constructed=true;return buyer();},respond:r.respond})({method:'POST',headers:{cookie:header}},null);
   expect(r.result.code).toBe(header?.includes('invalid')||!header?'UNAUTHORIZED':'CONFLICT');if(!header||header.includes('invalid'))expect(constructed).toBe(false);
  }
  const r=response();await createCheckoutPaymentLinkHandler({codec,createPort:()=>buyer(),respond:r.respond})({method:'POST',headers:{cookie:cookie()},body:{orderId:randomUUID(),clientId:randomUUID(),email:'ignored@example.invalid'}},null);
  expect(r.result.data).toEqual({sent:true});expect(await tokens(f.id)).toHaveLength(1);expect((await events(f.id))[0].payload.orderId).toBe(f.id);
 });
 it('authorizes live buyer mail despite fresh activity and retains claim, hash, gone and paid refusals',async()=>{
  const f=await order(true);await buyer().issue({orderId:f.id,clientId:f.client,rawToken:'rcv_mail',requestedAt:new Date().toISOString()});const event=(await events(f.id))[0];
  expect(event.payload.mode).toBe('subscription_cycle');await env.owner.query("UPDATE public.outbox_events SET status='processing',metadata=metadata||'{\"claimToken\":\"claim\"}' WHERE id=$1",[event.id]);
  expect(await buyer().authorize(event.id,'wrong')).toMatchObject({authorized:false,reason:'claim_not_active'});
  // An unsettled, fresh intent does not invalidate a buyer-requested mail.
  await call(env.runtime,'commerce_open_settlement_intent',[`fresh:${f.id}`,f.id,'sandbox',100,'XXX',{},new Date().toISOString()]);
  expect(await buyer().authorize(event.id,'claim')).toMatchObject({authorized:true});
  const sends:string[]=[];
  const mail=createOutboxCheckoutRecoveryEmailHandler({
   emailPort:{findExistingSend:async()=>false,sendCheckoutRecovery:async(input:{recoveryToken:string})=>{sends.push(input.recoveryToken);return{ok:true,messageId:'capture:buyer',httpStatus:200,providerError:null,aborted:false};}} as unknown as import('@openlup/platform/commerce').TransactionalEmailPort,
   recipientPort:{resolve:async()=>({email:`${f.client}@example.invalid`,firstName:null,country:'EN'})},
   lifecyclePort:{read:async()=>({orderStatus:'pending_payment',paymentStatus:'processing',hasPayment:false,paymentUpdatedAt:new Date().toISOString()})},
   runtime:{resolveLocale:()=> 'en',parseOutboxPayload:(schema,payload)=>{const p=schema.safeParse(payload);return p.success?{ok:true,data:p.data}:{ok:false,outcome:{kind:'discard',reason:'invalid_payload'}};},mapSendOutcome:()=>({kind:'processed'})},
  });
  expect(await mail.handle(event,new AbortController().signal)).toMatchObject({kind:'processed'});expect(sends).toEqual(['rcv_mail']);
  expect(await mail.handle({...event,payload:{...event.payload,buyerRequested:false}},new AbortController().signal)).toMatchObject({kind:'retry',reason:'payment_session_active'});
  expect((await env.runtime.query('SELECT public.commerce_checkout_recovery_wave_delivery_authorize($1,$2) AS r',[event.id,'claim'])).rows[0].r.authorized).toBe(false);
  await env.owner.query("UPDATE public.outbox_events SET payload=jsonb_set(payload,'{recoveryToken}','\"wrong\"') WHERE id=$1",[event.id]);
  expect(await buyer().authorize(event.id,'claim')).toMatchObject({authorized:false,reason:'buyer_checkout_recovery_link_not_live'});
  await env.owner.query("UPDATE public.commerce_orders SET status='paid' WHERE id=$1",[f.id]);expect(await buyer().authorize(event.id,'claim')).toMatchObject({authorized:false,reason:'order_not_recoverable'});
  expect(await buyer().authorize(randomUUID(),'claim')).toMatchObject({authorized:false});
 });
 it.each([['actor','token'],['actor','order'],['buyer','token'],['buyer','outbox']] as const)('refuses %s issuance blocked at %s across the deadline without token/event writes',async(issuer,lock)=>{
  const f=await order(),a=await env.owner.connect(),b=await env.runtime.connect();let pending:Promise<unknown>|undefined;
  try{
   const row=(await a.query("UPDATE public.commerce_orders SET created_at=clock_timestamp()+interval '3 seconds'-interval '24 hours' WHERE id=$1 RETURNING created_at+interval '24 hours' AS deadline",[f.id])).rows[0];
   const apid=(await a.query('SELECT pg_backend_pid() AS pid')).rows[0].pid,bpid=(await b.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
   await a.query('BEGIN');if(lock==='order')await a.query('SELECT id FROM public.commerce_orders WHERE id=$1 FOR UPDATE',[f.id]);
   else await a.query(`LOCK TABLE public.${lock==='outbox'?'outbox_events':'commerce_checkout_recovery_tokens'} IN SHARE MODE`);
   if(issuer==='actor'){
    await b.query('BEGIN');await b.query('SET LOCAL ROLE authenticated');await b.query("SELECT set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:f.principal})]);
    pending=createPostgresCustomerCheckoutRecoveryStartPort(b).issue({orderId:f.id,rawToken:randomUUID(),expiresAt:row.deadline.toISOString()});
   }else pending=createPostgresBuyerCheckoutLinkPort(b,policy).issue({orderId:f.id,clientId:f.client,rawToken:randomUUID(),requestedAt:new Date().toISOString()});
   const settled=pending.then(value=>({value}),error=>({error}));let blocked=false;
   for(let n=0;n<100&&!blocked;n++){blocked=(await a.query('SELECT $1::integer=ANY(pg_blocking_pids($2::integer)) AS b',[apid,bpid])).rows[0].b;if(!blocked)await new Promise(r=>setTimeout(r,10));}
   expect(blocked).toBe(true);expect((await a.query('SELECT clock_timestamp()<$1 AS b',[row.deadline])).rows[0].b).toBe(true);
   await a.query('SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM ($1::timestamptz-clock_timestamp())))+0.025)',[row.deadline.toISOString()]);await a.query('COMMIT');
   expect(await settled).toMatchObject({error:{reason:'order_not_recoverable'}});await b.query('ROLLBACK');expect(await tokens(f.id)).toEqual([]);expect(await events(f.id)).toEqual([]);
  }finally{await a.query('ROLLBACK');await pending?.catch(()=>{});await b.query('ROLLBACK');a.release();b.release();}
 }, 15_000);
 it('keeps new grants bounded without raw token/outbox table access for actors',async()=>{
  const f=await order();await env.actor(f.principal,async db=>{
   expect((await db.query("SELECT has_function_privilege(current_user,'public.commerce_buyer_checkout_link_issue(uuid,uuid,text,bigint,bigint,timestamptz)','EXECUTE') AS allowed")).rows[0].allowed).toBe(false);
   expect((await db.query("SELECT has_table_privilege(current_user,'public.commerce_checkout_recovery_tokens','INSERT') AS allowed")).rows[0].allowed).toBe(false);
  });
 });
});
