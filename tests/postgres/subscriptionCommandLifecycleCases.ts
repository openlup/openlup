import { randomUUID } from 'node:crypto';
import { expect,it } from 'vitest';
import type { Pool,PoolClient } from 'pg';
import { createPostgresSubscriptionCommands, createPostgresSubscriptionCommandStore, NATIVE_SUBSCRIPTION_CAPABILITIES, type SubscriptionQueryExecutor } from '@openlup/platform/subscriptions';
import type { SubscriptionCommand, SubscriptionCommandReceipt } from '@openlup/platform/subscriptions/contracts';
import { AT,call,failure,later,renewal,request } from './subscriptionNativeFixture.js';
export function registerCommandCases(h:{pool:Pool}) {
async function fixture() {
 const f=await renewal(h.pool);await h.pool.query('DELETE FROM public.subscription_renewal_operations WHERE id=$1',[f.operation]);
 await h.pool.query("UPDATE public.subscriptions SET next_cycle_at=$2,started_at='2026-01-01' WHERE id=$1",[f.subscription,later(200)]);
 const list=(await h.pool.query("INSERT INTO public.price_lists(name,region_code,currency) VALUES('Command fixture','ZZ','XXX') RETURNING id")).rows[0].id;
 const sku=(await h.pool.query('SELECT id FROM public.catalog_skus WHERE sku=$1',[f.snapshot.lines[0].sku])).rows[0].id;
 await h.pool.query("UPDATE public.subscriptions SET price_list_id=$2,currency_code='XXX' WHERE id=$1",[f.subscription,list]);
 await h.pool.query("UPDATE public.catalog_skus SET sellable_in_subscription=true,status='active' WHERE id=$1",[sku]);
 await h.pool.query("INSERT INTO public.price_entries(price_list_id,variant_id,unit_price_minor,valid_from) VALUES($1,$2,350,'2026-01-01')",[list,sku]);
 await h.pool.query("INSERT INTO public.subscription_lines(subscription_id,variant_id,quantity,sort_order,unit_price_minor,currency_code) VALUES($1,$2,2,0,100,'XXX')",[f.subscription,sku]);
 await h.pool.query("INSERT INTO public.subscription_method_states(subscription_id,health_state) VALUES($1,'healthy')",[f.subscription]);
 return {...f,actor:randomUUID(),sku,list};
}
type F=Awaited<ReturnType<typeof fixture>>;
const invoke=(f:F,key:string,action:string,payload:unknown={},preview=false,db:Pool|PoolClient=h.pool,at=AT)=>
 call(db,preview?'subscription_command_preview':'subscription_command_apply',[f.actor,f.client,key,f.subscription,action,payload,at]);
const bundle=(f:F)=>({coreLines:[{variantId:f.sku,qty:2}],compositionConstraint:{kind:'units',value:2},expectedTemplateVersion:1});
 async function effects() {
 const tables=(await h.pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;
 expect(tables.map(t=>t.tablename)).toEqual(expect.arrayContaining(['subscriptions','subscription_command_receipts',
  'subscription_edit_quotes','subscription_events','subscription_renewal_terms','subscription_renewal_term_lines']));
  const result:Record<string,unknown>={};
  for(const {tablename} of tables) {
   const name=String(tablename).replaceAll('"','""');
   result[name]=(await h.pool.query(`SELECT count(*)::int AS count,COALESCE(jsonb_agg(
    jsonb_build_object('row',to_jsonb(t),'xmin',t.xmin::text) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS rows
    FROM public."${name}" t`)).rows[0];
  }
  return result;
 }
it('maps PostgreSQL cast and overflow messages to a closed code on fresh and stored refusals',async()=>{
 const f=await fixture();
 const binding={async withTransaction<T>(work:(db:SubscriptionQueryExecutor)=>Promise<T>) {
  const db=await h.pool.connect();try{await db.query('BEGIN');const result=await work(db);await db.query('COMMIT');return result;}
  catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
 }};
 const store=createPostgresSubscriptionCommandStore(binding);
 for(const [suffix,extra] of [['integer',{expectedTemplateVersion:'bad'}],['overflow',{expectedTemplateVersion:'999999999999999999999'}],
  ['uuid',{variantId:'bad',qty:1}],['qty',{variantId:f.sku,qty:'bad'}]] as const) {
  const input={actorId:f.actor,clientId:f.client,subscriptionId:f.subscription,idempotencyKey:`diagnostic-${suffix}`,
   action:suffix==='uuid'||suffix==='qty'?'add_addon':'resize_bundle',payload:{...bundle(f),...extra},now:AT};
  expect(await store.preview(input)).toMatchObject({status:'refused',reason:'subscription_command_invalid_input'});
  const raw=(await h.pool.query('SELECT result FROM public.subscription_command_receipts WHERE actor_id=$1 AND idempotency_key=$2',
   [f.actor,input.idempotencyKey])).rows[0].result;
  expect(raw.reason).toMatch(/invalid input syntax|out of range/);
  expect(await store.preview(input)).toEqual({...raw,reason:'subscription_command_invalid_input'});
  expect(await store.apply(input)).toEqual({...raw,reason:'subscription_command_invalid_input'});
  expect(await store.apply({...input,idempotencyKey:`apply-${suffix}`,action:'slide_next_cycle',payload:{newNextCycleAt:AT}}))
   .toMatchObject({status:'refused',reason:'subscription_lifecycle_invalid_slide'});
 }
});
it('command preview and apply replay have zero public-table delta after a later command',async()=>{
 const f=await fixture();
 const calls:string[]=[];
 const store=createPostgresSubscriptionCommandStore({
  async withTransaction(work) {
   const db=await h.pool.connect();try{await db.query('BEGIN');
    const result=await work({async query(sql:string,values?:unknown[]){calls.push(sql);return db.query(sql,values);}});
    await db.query('COMMIT');return result;}
   catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
  },
 });
 const input={actorId:f.actor,clientId:f.client,subscriptionId:f.subscription,idempotencyKey:'zero-delta-command',
  action:'resize_bundle',payload:{...bundle(f),coreLines:[{variantId:f.sku,qty:3}],compositionConstraint:{kind:'units',value:3}},now:AT};
 const preview=await store.preview(input);expect(preview).toMatchObject({status:'previewed',canApply:true});
 const previewReplay=async()=>{
  const before=await effects();calls.length=0;
  for(let n=0;n<3;n++) {
   expect(await store.preview({...input,now:later(500)})).toEqual(preview);
   expect(await invoke(f,input.idempotencyKey,input.action,input.payload,true,h.pool,later(500))).toEqual(preview);
  }
  expect(await effects()).toEqual(before);
  expect(calls.filter(sql=>sql.includes('SELECT public.subscription_command_'))).toEqual([]);
 };
 await previewReplay();
 const accepted={...input,payload:{...input.payload,acceptedQuoteHash:preview.quoteHash}};
 const applied=await store.apply(accepted);expect(applied).toMatchObject({status:'applied',templateVersion:2});
 const applyReplay=async()=>{
  const before=await effects();calls.length=0;
  for(let n=0;n<3;n++)expect(await store.apply({...accepted,now:later(500)}))
   .toEqual({...applied,status:'replayed',originalStatus:'applied'});
  expect(await effects()).toEqual(before);
  expect(calls.filter(sql=>sql.includes('SELECT public.subscription_command_'))).toEqual([]);
 };
 await applyReplay();
 expect(await store.apply({...input,idempotencyKey:'later-slide-command',action:'slide_next_cycle',payload:{newNextCycleAt:later(300)}}))
  .toMatchObject({status:'applied'});
 expect(new Date((await state(f)).next_cycle_at).toISOString()).toBe(later(300));
 const stored=(await h.pool.query('SELECT result FROM public.subscription_command_receipts WHERE actor_id=$1 AND idempotency_key=$2',
  [f.actor,input.idempotencyKey])).rows[0].result;
 // Preview now returns the stored apply result, never a fresh quote.
 const before=await effects();calls.length=0;
 for(let n=0;n<3;n++) {
  expect(await store.preview({...input,now:later(500)})).toEqual(stored);
  expect(await invoke(f,input.idempotencyKey,input.action,input.payload,true,h.pool,later(500))).toEqual(stored);
 }
 expect(await store.preview({...input,action:'update_plan_length'}))
  .toMatchObject({status:'refused',reason:'subscription_command_idempotency_conflict'});
 expect(await effects()).toEqual(before);
 expect(calls.filter(sql=>sql.includes('SELECT public.subscription_command_'))).toEqual([]);
 await applyReplay();
});
async function quote(f:F,key:string,action='update_bundle',payload:Record<string,unknown>={...bundle(f),cadenceDays:21}) {
 const p=await invoke(f,key,action,payload,true);expect(p).toMatchObject({status:'previewed',canApply:true});
 return {...payload,acceptedQuoteHash:p.quoteHash};
}
async function state(f:F) {
 return (await h.pool.query('SELECT status,next_cycle_at,template_version FROM public.subscriptions WHERE id=$1',[f.subscription])).rows[0];
}
it('binds replay to the actor, key and actual command, including cross-subscription contention',async()=>{
 const f=await fixture(),key='pause-command';
 const results=await Promise.all([invoke(f,key,'pause'),invoke(f,key,'pause')]);
 expect(results.map(r=>r.status).sort()).toEqual(['applied','replayed']);
 expect(await invoke(f,key,'cancel')).toMatchObject({status:'refused',reason:'subscription_command_idempotency_conflict'});
 expect((await h.pool.query('SELECT * FROM public.subscription_pause_windows WHERE subscription_id=$1',[f.subscription])).rows).toHaveLength(1);
 const other=await fixture();other.actor=f.actor;
 expect(await invoke(other,key,'pause')).toMatchObject({status:'refused',reason:'subscription_command_idempotency_conflict'});
 expect((await state(other)).status).toBe('active');
 other.actor=randomUUID();expect(await invoke(other,key,'pause')).toMatchObject({status:'applied'});
 const a=await fixture(),b=await fixture();b.actor=a.actor;
 const race=await Promise.all([invoke(a,'cross-subscription','pause'),invoke(b,'cross-subscription','pause')]);
 expect(race.map(r=>r.status).sort()).toEqual(['applied','refused']);
 await expect(invoke({...f,client:randomUUID()},'foreign-command','pause')).rejects.toThrow('forbidden');
});
it('keeps explicit pause/resume and no-op truth, and translates confirmed order-now/reactivation date policy',async()=>{
 const f=await fixture();
 expect(await invoke(f,'same-day-slide','slide_next_cycle',{newNextCycleAt:later(201)})).toMatchObject({status:'noop'});
 expect(await invoke(f,'same-day-slide','slide_next_cycle',{newNextCycleAt:later(201)})).toMatchObject({status:'replayed',originalStatus:'noop'});
 expect(await invoke(f,'order-unconfirmed','order_now')).toMatchObject({status:'refused',reason:'subscription_command_charge_timing_not_confirmed'});
 const ordered=await invoke(f,'order-confirmed','order_now',{confirmedChargeTiming:true});
 expect(ordered.status).toBe('applied');expect(new Date(ordered.nextCycleAt).toISOString()).toBe(later(1/12));
 expect(await invoke(f,'explicit-pause','pause')).toMatchObject({status:'applied',subscriptionStatus:'paused'});
 expect(await invoke(f,'explicit-resume','resume')).toMatchObject({status:'applied',subscriptionStatus:'active'});
 expect(await invoke(f,'explicit-cancel','cancel')).toMatchObject({status:'applied',subscriptionStatus:'cancelled'});
 const reactivated=await invoke(f,'reactivate-confirmed','reactivate',{confirmedChargeTiming:true});
 expect(reactivated).toMatchObject({status:'applied',templateVersion:2});expect(new Date(reactivated.nextCycleAt).toISOString()).toBe(later(48));
 expect((await h.pool.query("SELECT count(*)::int n FROM public.subscription_events WHERE subscription_id=$1 AND event_type LIKE '%pause'",[f.subscription])).rows[0].n).toBe(1);
});
it('locks accepted prices until edit, updates future terms atomically, never prorates, and replays after quote expiry',async()=>{
 const f=await fixture(),key='bundle-price-edit',input=await quote(f,key);
 const independent=await quote(f,'independent-preview');expect(independent.acceptedQuoteHash).not.toBe(input.acceptedQuoteHash);
 await h.pool.query('UPDATE public.price_entries SET unit_price_minor=999 WHERE price_list_id=$1',[f.list]);
 const applied=await invoke(f,key,'update_bundle',input);expect(applied).toMatchObject({status:'applied',templateVersion:2});
 const receipt=(await h.pool.query(`SELECT command,command_fingerprint=encode(sha256(convert_to(command::text,'UTF8')),'hex') bound
  FROM public.subscription_command_receipts WHERE actor_id=$1 AND idempotency_key=$2`,[f.actor,key])).rows[0];
 expect(receipt.bound).toBe(true);expect(receipt.command.payload.acceptedQuoteHash).toBe(input.acceptedQuoteHash);
 expect((await h.pool.query('SELECT quantity,unit_amount_minor FROM public.subscription_renewal_term_lines WHERE subscription_id=$1',[f.subscription])).rows).toEqual([{quantity:2,unit_amount_minor:'350'}]);
 expect((await h.pool.query('SELECT unit_price_minor FROM public.subscription_lines WHERE subscription_id=$1',[f.subscription])).rows[0].unit_price_minor).toBe('350');
 expect((await h.pool.query('SELECT * FROM public.subscription_cycles WHERE subscription_id=$1',[f.subscription])).rows).toEqual([]);
 expect((await h.pool.query('SELECT * FROM public.commerce_orders WHERE client_id=$1',[f.client])).rows).toEqual([]);
 const replay=await invoke(f,key,'update_bundle',input,false,h.pool,later(500));expect(replay).toMatchObject({...applied,status:'replayed',originalStatus:'applied'});
 expect(await invoke(f,key,'update_bundle',{...input,acceptedQuoteHash:'b'.repeat(64)})).toMatchObject({status:'refused',reason:'subscription_command_idempotency_conflict'});
 expect((await state(f)).status).toBe('active');
});
it('serializes a future edit with claim freeze, preserves the deferred snapshot and refuses its rebuilt stale identity',async()=>{
 const f=await fixture(),input=await quote(f,'concurrent-edit');
 const snapshot={...f.snapshot,scheduledAt:later(200)};
 const identity=await call(h.pool,'subscription_renewal_identity',[f.subscription,later(200)]);
 const client=await h.pool.connect();
 try {
  await client.query('BEGIN');
  const op=await call(client,'subscription_claim_due_renewal',[identity,f.fingerprint,snapshot,'claim-worker',300,later(200)]);
  let finished=false;const pending=invoke(f,'concurrent-edit','update_bundle',input).then(r=>{finished=true;return r;});
  // pg_blocking_pids proves real lock contention rather than a timer guess.
  let blocked=false;
  for(let i=0;i<50&&!blocked;i++) blocked=(await h.pool.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE cardinality(pg_blocking_pids(pid))>0 AND query LIKE '%subscription_command_apply%') blocked")).rows[0].blocked;
  expect(blocked).toBe(true);expect(finished).toBe(false);
  await client.query('COMMIT');expect(await pending).toMatchObject({status:'applied'});
  expect((await h.pool.query('SELECT cycle_snapshot FROM public.subscription_renewal_operations WHERE id=$1',[op.operationId])).rows[0].cycle_snapshot).toEqual(snapshot);
  expect(await call(h.pool,'subscription_claim_due_renewal',[identity,f.fingerprint,snapshot,'claim-worker',300,later(201)])).toMatchObject({operationId:op.operationId});
  await expect(call(h.pool,'subscription_claim_due_renewal',[identity,'b'.repeat(64),{...snapshot,totalAmountMinor:700},'claim-worker',300,later(202)])).rejects.toThrow('idempotency_conflict');
  await call(h.pool,'fulfillment_reserve_subscription_renewal',[op.operationId,(await h.pool.query('SELECT claim_token FROM public.subscription_renewal_operations WHERE id=$1',[op.operationId])).rows[0].claim_token,900,later(201)]);
  const token=(await h.pool.query('SELECT claim_token FROM public.subscription_renewal_operations WHERE id=$1',[op.operationId])).rows[0].claim_token;
  const prepared=await call(h.pool,'commerce_prepare_subscription_renewal',[op.operationId,token,later(201)]);
  expect((await h.pool.query('SELECT total_amount_minor FROM public.commerce_orders WHERE id=$1',[prepared.orderId])).rows[0].total_amount_minor).toBe('200');
  expect((await state(f)).status).toBe('active');
 }finally{await client.query('ROLLBACK');client.release();}
});
it('persists locked-cycle, dunning, expired-quote and stale-version refusals without changing business state',async()=>{
 for(const mode of ['locked','dunning','expired','stale'] as const) {
  const f=await fixture(),key=`refusal-${mode}`,input=await quote(f,key),before=await state(f);
  if(mode==='locked') await h.pool.query("INSERT INTO public.subscription_cycles(subscription_id,scheduled_at,status) VALUES($1,$2,'payment_pending')",[f.subscription,later(200)]);
  if(mode==='dunning') await h.pool.query("INSERT INTO public.subscription_dunning_cases(subscription_id,client_id,idempotency_key) VALUES($1,$2,$3)",[f.subscription,f.client,randomUUID()]);
  if(mode==='expired') await h.pool.query("UPDATE public.subscription_edit_quotes SET expires_at='2026-01-01' WHERE subscription_id=$1",[f.subscription]);
  if(mode==='stale') await h.pool.query('UPDATE public.subscriptions SET template_version=2 WHERE id=$1',[f.subscription]);
  const result=await invoke(f,key,'update_bundle',input);expect(result.status).toBe('refused');
  expect(await invoke(f,key,'update_bundle',input)).toEqual(result);
  expect(await state(f)).toEqual({...before,template_version:mode==='stale'?2:1});
  expect((await h.pool.query('SELECT unit_amount_minor FROM public.subscription_renewal_term_lines WHERE subscription_id=$1',[f.subscription])).rows[0].unit_amount_minor).toBe('100');
  expect((await h.pool.query('SELECT * FROM public.subscription_events WHERE subscription_id=$1',[f.subscription])).rows).toEqual([]);
 }
});
it('supports generic resize/cadence and addon commands, while repeated equal bundles produce no event or version',async()=>{
 const f=await fixture();
 for(const [action,extra] of [
  ['resize_bundle',{coreLines:[{variantId:f.sku,qty:3}],compositionConstraint:{kind:'units',value:3}}],
  ['update_plan_length',{planDays:21}],
 ] as const) {
  const version=(await state(f)).template_version,key=`generic-${action}`;
  const input=await quote(f,key,action,{...extra,expectedTemplateVersion:version});
  expect(await invoke(f,key,action,input)).toMatchObject({status:'applied',templateVersion:version+1});
 }
 const product=randomUUID(),addon=randomUUID();
 await h.pool.query("INSERT INTO public.catalog_products(id,slug,name) VALUES($1::uuid,$1::text,'Addon')",[product]);
 await h.pool.query("INSERT INTO public.catalog_skus(id,product_id,sku,title,status,sellable_in_subscription) VALUES($1::uuid,$2,$1::text,'Addon','active',true)",[addon,product]);
 await h.pool.query("INSERT INTO public.price_entries(price_list_id,variant_id,unit_price_minor,valid_from) VALUES($1,$2,70,'2026-01-01')",[f.list,addon]);
 for(const [action,qty] of [['add_addon',1],['update_addon_quantity',2],['remove_addon',2]] as const) {
  const version=(await state(f)).template_version,key=`generic-${action}`;
  const input=await quote(f,key,action,{variantId:addon,qty,expectedTemplateVersion:version});
  expect(await invoke(f,key,action,input)).toMatchObject({status:'applied'});
 }
 const version=(await state(f)).template_version,payload={
  ...bundle(f),coreLines:[{variantId:f.sku,qty:3}],expectedTemplateVersion:version};
 expect(await invoke(f,'equal-bundle','update_bundle',payload,true)).toMatchObject({status:'noop',templateVersion:version});
 const before=(await h.pool.query('SELECT * FROM public.subscription_events WHERE subscription_id=$1',[f.subscription])).rows;
 expect(await invoke(f,'equal-bundle','update_bundle',payload)).toMatchObject({status:'replayed',originalStatus:'noop',templateVersion:version});
 expect((await h.pool.query('SELECT * FROM public.subscription_events WHERE subscription_id=$1',[f.subscription])).rows).toEqual(before);
});
it.each(['update_bundle','add_addon','update_addon_quantity','update_plan_length',
 'resize_bundle','update_package_template','slide_next_cycle'] as const)(
 'returns %s noop through the TS store after price drift with only a receipt written',async action=>{
 const f=await fixture(),product=randomUUID(),addon=randomUUID();
 await h.pool.query("INSERT INTO public.catalog_products(id,slug,name) VALUES($1::uuid,$1::text,'Addon')",[product]);
 await h.pool.query("INSERT INTO public.catalog_skus(id,product_id,sku,title,status,sellable_in_subscription) VALUES($1::uuid,$2,$1::text,'Addon','active',true)",[addon,product]);
 await h.pool.query("INSERT INTO public.price_entries(price_list_id,variant_id,unit_price_minor,valid_from) VALUES($1,$2,70,'2026-01-01')",[f.list,addon]);
 await h.pool.query(`INSERT INTO public.subscription_lines(subscription_id,variant_id,quantity,sort_order,is_addon,unit_price_minor,currency_code)
  VALUES($1,$2,2,1,true,70,'XXX')`,[f.subscription,addon]);
 await h.pool.query('UPDATE public.price_entries SET unit_price_minor=999 WHERE price_list_id=$1',[f.list]);
 const store=createPostgresSubscriptionCommandStore({
  async withTransaction<T>(work:(db:SubscriptionQueryExecutor)=>Promise<T>) {
   const db=await h.pool.connect();try{await db.query('BEGIN');const result=await work(db);await db.query('COMMIT');return result;}
   catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
  },
 });
 const payload:Record<string,unknown>=action==='slide_next_cycle'?{newNextCycleAt:later(201)}
  :action==='add_addon'||action==='update_addon_quantity'?{variantId:addon,qty:2,expectedTemplateVersion:1}
  :{...bundle(f),planDays:28,addonLines:[{variantId:addon,qty:2}]};
 const input={actorId:f.actor,clientId:f.client,subscriptionId:f.subscription,idempotencyKey:`store-noop-${action}`,
  action,payload,now:AT};
 const before=await effects(),preview=await store.preview(input);
 expect(preview).toMatchObject({status:'noop',subscriptionId:f.subscription,action,templateVersion:1,eventId:null});
 expect(preview).not.toHaveProperty('quoteHash');
 async function onlyReceipt(previous:Record<string,unknown>,key:string,result:Record<string,unknown>) {
  const after=await effects();
  for(const name of Object.keys(previous).filter(name=>name!=='subscription_command_receipts'))
   expect(after[name],`${action}: ${name} columns/xmin`).toEqual(previous[name]);
  type Receipts={count:number;rows:{row:Record<string,unknown>;xmin:string}[]};
  const old=previous.subscription_command_receipts as Receipts,current=after.subscription_command_receipts as Receipts;
  const added=current.rows.filter(r=>r.row.actor_id===f.actor&&r.row.idempotency_key===key);
  expect(current.count).toBe(old.count+1);expect(added).toHaveLength(1);
  expect(added[0].row).toMatchObject({status:'noop',quote_hash:null,result});
  expect(current.rows.filter(r=>r!==added[0])).toEqual(old.rows);
  return after;
 }
 const previewStored=await onlyReceipt(before,input.idempotencyKey,preview);
 const replay=await store.apply(input);
 expect(replay).toMatchObject({...preview,status:'replayed',originalStatus:'noop'});
 expect(replay.commandFingerprint).toMatch(/^[a-f0-9]{64}$/);
 for(let n=0;n<3;n++) {
  expect(await store.preview({...input,now:later(500)})).toEqual(preview);
  expect(await store.apply({...input,now:later(500)})).toEqual(replay);
 }
 expect(await effects()).toEqual(previewStored);
 const direct={...input,idempotencyKey:`store-direct-noop-${action}`},applied=await store.apply(direct);
 expect(applied).toMatchObject(preview);expect(applied.commandFingerprint).toMatch(/^[a-f0-9]{64}$/);
 const directStored=await onlyReceipt(previewStored,direct.idempotencyKey,preview);
 for(let n=0;n<3;n++) {
  expect(await store.preview({...direct,now:later(500)})).toEqual(preview);
  expect(await store.apply({...direct,now:later(500)})).toEqual({...applied,status:'replayed',originalStatus:'noop'});
 }
 expect(await effects()).toEqual(directStored);
 const delta=action==='slide_next_cycle'?{newNextCycleAt:later(224)}
  :action==='add_addon'||action==='update_addon_quantity'?{qty:3}
  :action==='resize_bundle'?{coreLines:[{variantId:f.sku,qty:3}],compositionConstraint:{kind:'units',value:3}}
  :action==='update_package_template'?{addonLines:[{variantId:addon,qty:3}]}:{planDays:21};
 const changed={...input,idempotencyKey:`store-changed-preview-${action}`,payload:{...payload,...delta}};
 const quoted=await store.preview(changed);
 expect(quoted).toMatchObject(action==='slide_next_cycle'
  ?{status:'refused',reason:'subscription_command_preview_unsupported'}:action==='add_addon'
   ?{status:'refused',reason:'subscription_edit_invalid_lines'}:{status:'previewed',canApply:true});
 const directChanged=await store.apply({...changed,idempotencyKey:`store-changed-direct-${action}`});
 expect(directChanged).toMatchObject(action==='slide_next_cycle'?{status:'applied'}
  :{status:'refused',reason:'subscription_edit_quote_required'});
 if(quoted.status==='previewed') {
  expect(await store.apply({...changed,payload:{...changed.payload,acceptedQuoteHash:String(quoted.quoteHash)}}))
   .toMatchObject({status:'applied',templateVersion:2});
 }
});
it('returns the existing-addon noop through the TS store without quotes or replay writes',async()=>{
 const f=await fixture(),product=randomUUID(),addon=randomUUID();
 await h.pool.query("INSERT INTO public.catalog_products(id,slug,name) VALUES($1::uuid,$1::text,'Addon')",[product]);
 await h.pool.query("INSERT INTO public.catalog_skus(id,product_id,sku,title,status,sellable_in_subscription) VALUES($1::uuid,$2,$1::text,'Addon','active',true)",[addon,product]);
 await h.pool.query("INSERT INTO public.price_entries(price_list_id,variant_id,unit_price_minor,valid_from) VALUES($1,$2,70,'2026-01-01')",[f.list,addon]);
 const store=createPostgresSubscriptionCommandStore({
  async withTransaction<T>(work:(db:SubscriptionQueryExecutor)=>Promise<T>) {
   const db=await h.pool.connect();try{await db.query('BEGIN');const result=await work(db);await db.query('COMMIT');return result;}
   catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
  },
 });
 const first={actorId:f.actor,clientId:f.client,subscriptionId:f.subscription,idempotencyKey:'store-addon-first',
  action:'add_addon',payload:{variantId:addon,qty:2,expectedTemplateVersion:1},now:AT};
 const quoted=await store.preview(first);expect(quoted).toMatchObject({status:'previewed'});
 expect(await store.apply({...first,payload:{...first.payload,acceptedQuoteHash:String(quoted.quoteHash)}}))
  .toMatchObject({status:'applied',templateVersion:2});
 // Catalogue drift cannot reprice an already present add-on or its core lines.
 await h.pool.query('UPDATE public.price_entries SET unit_price_minor=999 WHERE price_list_id=$1',[f.list]);
 const input={...first,idempotencyKey:'store-addon-noop',payload:{...first.payload,expectedTemplateVersion:2}};
 const before=await effects(),preview=await store.preview(input);
 expect(preview).toMatchObject({status:'noop',subscriptionId:f.subscription,templateVersion:2,eventId:null});
 expect(preview).not.toHaveProperty('quoteHash');
 const stored=await effects();
 for(const name of Object.keys(before).filter(name=>name!=='subscription_command_receipts'))
  expect(stored[name],name).toEqual(before[name]);
 expect((await h.pool.query('SELECT status,quote_hash,result FROM public.subscription_command_receipts WHERE actor_id=$1 AND idempotency_key=$2',
  [f.actor,input.idempotencyKey])).rows).toEqual([{status:'noop',quote_hash:null,result:preview}]);
 const applied=await store.apply(input);
 expect(applied).toMatchObject({...preview,status:'replayed',originalStatus:'noop'});
 expect(applied.commandFingerprint).toMatch(/^[a-f0-9]{64}$/);
 for(let n=0;n<3;n++) {
  expect(await store.preview({...input,now:later(500)})).toEqual(preview);
  expect(await store.apply({...input,now:later(500)})).toEqual(applied);
 }
 expect(await effects()).toEqual(stored);
 const direct={...input,idempotencyKey:'store-addon-direct-noop'};
 const directResult=await store.apply(direct);
 expect(directResult).toMatchObject({...preview,status:'noop'});
 expect(directResult.commandFingerprint).toMatch(/^[a-f0-9]{64}$/);
 const directStored=await effects();
 for(const name of Object.keys(stored).filter(name=>name!=='subscription_command_receipts'))
  expect(directStored[name],name).toEqual(stored[name]);
 for(let n=0;n<3;n++) {
  expect(await store.apply({...direct,now:later(500)})).toEqual({...directResult,status:'replayed',originalStatus:'noop'});
 }
 expect(await effects()).toEqual(directStored);
 const invalid={...direct,idempotencyKey:'store-addon-direct-different',payload:{...direct.payload,qty:3}};
 expect(await store.apply(invalid)).toMatchObject({status:'refused',reason:'subscription_edit_quote_required'});
 const refusedStored=await effects();
 for(const name of Object.keys(directStored).filter(name=>name!=='subscription_command_receipts'))
  expect(refusedStored[name],name).toEqual(directStored[name]);
 const freshAddon=randomUUID();
 await h.pool.query("INSERT INTO public.catalog_skus(id,product_id,sku,title,status,sellable_in_subscription) VALUES($1::uuid,$2,$1::text,'New addon','active',true)",[freshAddon,product]);
 await h.pool.query("INSERT INTO public.price_entries(price_list_id,variant_id,unit_price_minor,valid_from) VALUES($1,$2,70,'2026-01-01')",[f.list,freshAddon]);
 const beforeFresh=await effects();
 expect(await store.apply({...direct,idempotencyKey:'store-addon-direct-new',payload:{...direct.payload,variantId:freshAddon}}))
  .toMatchObject({status:'refused',reason:'subscription_edit_quote_required'});
 const afterFresh=await effects();
 for(const name of Object.keys(beforeFresh).filter(name=>name!=='subscription_command_receipts'))
  expect(afterFresh[name],name).toEqual(beforeFresh[name]);
});
it('keeps native lifecycle callers unchanged, permits customer cancellation of open dunning, and refuses in-flight cancellation',async()=>{
 const f=await fixture();
 const old=await call(h.pool,'subscription_apply_lifecycle_action',[f.client,'old-native-key',f.subscription,'pause',{},AT]);
 expect(old.subscriptionAction).toMatchObject({status:'applied',subscriptionStatus:'paused'});
 expect((await call(h.pool,'subscription_apply_lifecycle_action',[f.client,'old-native-key',f.subscription,'resume',{},AT])).subscriptionAction.status).toBe('replayed');
 await h.pool.query("INSERT INTO public.subscription_dunning_cases(subscription_id,client_id,idempotency_key) VALUES($1,$2,$3)",[f.subscription,f.client,randomUUID()]);
 expect(await invoke(f,'blocked-resume','resume')).toMatchObject({status:'refused',reason:'subscription_command_payment_blocked'});
 expect(await invoke(f,'cancel-dunning','cancel')).toMatchObject({status:'applied',subscriptionStatus:'cancelled'});
 expect((await h.pool.query('SELECT status,next_retry_at FROM public.subscription_dunning_cases WHERE subscription_id=$1',[f.subscription])).rows).toEqual([{status:'cancelled',next_retry_at:null}]);
 const g=await renewal(h.pool),actor=randomUUID();
 const locked=await h.pool.connect();
 try {
  await locked.query('BEGIN');await locked.query('SELECT id FROM public.subscription_renewal_operations WHERE id=$1 FOR UPDATE',[g.operation]);
  expect(await invoke({...g,actor} as F,'cancel-busy-operation','cancel'))
   .toMatchObject({status:'refused',reason:'subscription_command_operation_busy'});
 }finally{await locked.query('ROLLBACK');locked.release();}
 expect(await invoke({...g,actor} as F,'cancel-live-lease','cancel'))
  .toMatchObject({status:'refused',reason:'subscription_command_payment_blocked'});
 const prepared=await call(h.pool,'fulfillment_reserve_subscription_renewal',[g.operation,g.token,900,AT]);expect(prepared.reserved).toBe(true);
 const original=await call(h.pool,'commerce_prepare_subscription_renewal',[g.operation,g.token,AT]);
 expect(await invoke({...g,actor:randomUUID()} as F,'cancel-in-flight','cancel')).toMatchObject({status:'refused',reason:'subscription_command_payment_blocked'});
 expect((await h.pool.query('SELECT status FROM public.subscriptions WHERE id=$1',[g.subscription])).rows[0].status).toBe('active');
 await call(h.pool,'commerce_acknowledge_subscription_renewal_attempt',[g.operation,g.fingerprint,'cancel-retry-ack',AT]);
 await call(h.pool,'subscription_retry_apply_failure',[g.operation,`failure-${g.operation}`,failure()]);
 await call(h.pool,'subscription_retry_open_case',[g.operation,'failed','/recover']);
 await call(h.pool,'subscription_retry_prepare',[g.operation,`prepare-${g.operation}`,request({...g,original}),later(24)]);
 expect(await invoke({...g,actor:randomUUID()} as F,'cancel-retry-in-flight','cancel',{},false,h.pool,later(24)))
  .toMatchObject({status:'refused',reason:'subscription_command_payment_blocked'});
 expect((await h.pool.query('SELECT status FROM public.subscription_dunning_cases WHERE subscription_id=$1',[g.subscription])).rows[0].status).toBe('open');
});

it('binds the supported descriptor to real native command success, replay, rollback and unsupported refusal',async()=>{
 const f=await fixture();
 let hostCalls=0,hostAddress='host-verified-address';
 const binding={
  async withTransaction<T>(work:(db:SubscriptionQueryExecutor)=>Promise<T>) {
   const db=await h.pool.connect();try{await db.query('BEGIN');const result=await work(db);await db.query('COMMIT');return result;}
   catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
  },
  async futureTerms(command:Extract<SubscriptionCommand,{action:'edit_future_terms'}>) {
   hostCalls++;
   if(command.shippingAddressId!==hostAddress) return {outcome:'refused' as const,reason:'subscription_command_invalid_input' as const};
   return {coreLines:command.coreLines.map(line=>({variantId:f.sku,qty:line.quantity})),addonLines:[],compositionConstraint:{kind:'units',value:3}};
  },
 };
 const commands=createPostgresSubscriptionCommands(binding);
 expect(commands.capabilities).toBe(NATIVE_SUBSCRIPTION_CAPABILITIES);
 expect(commands.capabilities).toMatchObject({genericBundleCommands:{supported:true},commandBoundReceipts:{supported:true},multiCyclePrepaid:{supported:false}});
 const context={actor:{kind:'operator' as const,actorId:f.actor,clientId:f.client},subscriptionId:f.subscription,now:AT};
 let command:Extract<SubscriptionCommand,{action:'edit_future_terms'}>={...context,idempotencyKey:'adapter-future',action:'edit_future_terms',
  shippingAddressId:'host-verified-address',planDays:21,cadenceDays:21,expectedTemplateVersion:1,acceptedQuoteHash:'',confirmedChargeTiming:true,
  coreLines:[{sku:f.snapshot.lines[0].sku,quantity:3}],addonLines:[],compositionConstraint:'host-units-three'};
 const preview=await commands.preview(command);expect(preview).toMatchObject({status:'previewed'});
 command={...command,acceptedQuoteHash:String('quoteHash' in preview?preview.quoteHash:'')};
 const applied=await commands.apply(command) as SubscriptionCommandReceipt;
 expect(applied).toMatchObject({outcome:'applied',actorId:f.actor,idempotencyKey:command.idempotencyKey,originalState:'active',revision:'2'});
 expect(applied.commandFingerprint).toMatch(/^[a-f0-9]{64}$/);
 hostAddress='later-host-address';
 const beforeReplay=await effects(),callsBeforeReplay=hostCalls;
 for(let n=0;n<3;n++) {
  expect(await commands.apply({...command,now:later(500)})).toEqual({...applied,outcome:'replayed'});
  expect(await commands.preview({...command,now:later(500)})).toMatchObject({status:'applied',templateVersion:2});
 }
 expect(hostCalls).toBe(callsBeforeReplay);
 expect(await effects()).toEqual(beforeReplay);
 expect(await commands.apply({...command,cadenceDays:28})).toEqual({outcome:'refused',reason:'subscription_command_idempotency_conflict'});
 expect(await commands.preview({...command,shippingAddressId:hostAddress}))
  .toMatchObject({status:'refused',reason:'subscription_command_idempotency_conflict'});
 expect(await commands.apply({...command,actor:{...command.actor,clientId:randomUUID()}}))
  .toEqual({outcome:'refused',reason:'subscription_command_invalid_input'});
 expect(hostCalls).toBe(callsBeforeReplay+1);
 expect((await h.pool.query('SELECT cadence_days FROM public.subscriptions WHERE id=$1',[f.subscription])).rows[0].cadence_days).toBe(21);
 expect(await commands.apply({...context,idempotencyKey:'adapter-pause',action:'pause',pausePreset:'host',reason:null,survey:null,saveOffer:null}))
  .toEqual({outcome:'refused',reason:'subscription_command_pause_forbidden'});
 const store=createPostgresSubscriptionCommandStore(binding);
 expect(await store.apply({actorId:f.actor,clientId:f.client,subscriptionId:f.subscription,idempotencyKey:'unsupported-prepaid',action:'multi_cycle_prepaid',payload:{},now:AT}))
  .toMatchObject({status:'refused',reason:NATIVE_SUBSCRIPTION_CAPABILITIES.multiCyclePrepaid.refusalCode});
 const before=await state(f);
 const broken=createPostgresSubscriptionCommandStore({withTransaction:work=>binding.withTransaction(async db=>{await work(db);throw Error('host-rollback');})});
 await expect(broken.apply({actorId:f.actor,clientId:f.client,subscriptionId:f.subscription,idempotencyKey:'rollback-cancel',action:'cancel',payload:{},now:AT})).rejects.toThrow('host-rollback');
 expect(await state(f)).toEqual(before);
 expect((await h.pool.query("SELECT * FROM public.subscription_command_receipts WHERE actor_id=$1 AND idempotency_key='rollback-cancel'",[f.actor])).rows).toEqual([]);
 expect((await h.pool.query('SELECT * FROM public.subscription_pause_windows WHERE subscription_id=$1',[f.subscription])).rows).toEqual([]);
});

}
