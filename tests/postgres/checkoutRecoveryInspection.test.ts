import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createCheckoutRecoveryInspection, createCheckoutRecoveryValidationPolicy, createPostgresCheckoutRecoveryOrderPort,
  createPostgresCheckoutRecoveryTokenPort, hashCheckoutRecoveryToken } from '@openlup/platform/commerce/server';
import { lifecycleInstallation, lifecycleProfiles, lifecycleDeclined, call, type LifecycleInstallation } from './subscriptionLifecycleClosureFixture.js';
import { postgresSetupTimeoutMs, postgresTeardownTimeoutMs } from '../helpers/postgresContainer.js';

describe.each(lifecycleProfiles)('checkout recovery inspection on %s', profile => {
 let env: LifecycleInstallation;
 beforeAll(async()=>{env=await lifecycleInstallation(profile);if(profile==='legacy')await env.owner.query('CREATE ROLE service_role NOLOGIN NOINHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS');},postgresSetupTimeoutMs);
 afterAll(async()=>env?.close(),postgresTeardownTimeoutMs);
 async function order(client=randomUUID(),initial=false){
  const id=randomUUID(),db=await env.owner.connect();
  try{await db.query('BEGIN');await db.query('INSERT INTO public.clients(id,email) VALUES($1,$2) ON CONFLICT(id) DO NOTHING',[client,`${client}@example.invalid`]);
   await db.query(`INSERT INTO public.commerce_orders(id,client_id,created_at,total_amount_minor,currency_code,metadata) VALUES($1,$2,clock_timestamp()-interval '2 hours',100,'XXX',$3)`,[id,client,{orderDraftSnapshot:{context:{mode:initial?'subscription':'one_time'}},quoteSnapshot:{frozen:true}}]);
   await db.query('INSERT INTO public.commerce_order_items(order_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor)VALUES($1,1,1,100,100)',[id]);await db.query('COMMIT');
  }catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
  const destination=(await env.owner.query("INSERT INTO public.commerce_destinations(client_id,address)VALUES($1,'{\"line1\":\"Example 1\"}') RETURNING id",[client])).rows[0].id;
  await env.owner.query('INSERT INTO public.commerce_destination_bindings(order_id,destination_id)VALUES($1,$2)',[id,destination]);
  if(initial)await call(env.runtime,'subscription_declare_provisional_activation',[`declare:${id}`,id,28,new Date().toISOString()]);
  return{id,client,destination};
 }
 async function expire(id:string){await env.owner.query("UPDATE public.commerce_orders SET status='expired',metadata=metadata||'{\"paymentStatus\":\"expired\",\"source\":\"checkout_reservation_expiry\"}' WHERE id=$1",[id]);}
 async function token(f:{id:string;client:string},state='expired'){
  const raw=`rcv_${randomUUID()}`;await env.owner.query(`INSERT INTO public.commerce_checkout_recovery_tokens(order_id,client_id,token_hash,created_at,expires_at,revoked_at)
   VALUES($1,$2,$3,clock_timestamp()-interval '2 hours',clock_timestamp()+($4::integer*interval '1 hour'),CASE WHEN $5 THEN clock_timestamp() END)`,[f.id,f.client,hashCheckoutRecoveryToken(raw),state==='expired'?-1:1,state==='revoked']);return raw;
 }
 const orders=()=>createPostgresCheckoutRecoveryOrderPort(env.runtime);
 const tokens=()=>createPostgresCheckoutRecoveryTokenPort({run:async work=>{const db=await env.runtime.connect();try{await db.query('BEGIN');const value=await work(db);await db.query('COMMIT');return value;}catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}}});
 function inspection(validation=vi.fn(async()=>true)){
  return{validation,port:createCheckoutRecoveryInspection({tokenPort:tokens(),orderPort:orders(),validation:{validate:validation},clientHasLiveOrPendingSubscription:async()=>false})};
 }
 const inspect=(port:ReturnType<typeof inspection>['port'],raw:string,capable=true)=>port.inspect({token:raw,capabilities:capable?['recreate_expired_order']:[]});
 it('keeps unlinked history NULL, both self-FKs restrictive and unvalidated, and one immediate replacement',async()=>{
  const root=await order(),first=await order(root.client),second=await order(root.client);
  expect((await env.owner.query('SELECT recovery_root_order_id,recreated_from_order_id FROM public.commerce_orders WHERE id=$1',[root.id])).rows).toEqual([{recovery_root_order_id:null,recreated_from_order_id:null}]);
  const constraints=(await env.owner.query("SELECT conname,confdeltype,convalidated FROM pg_constraint WHERE conrelid='public.commerce_orders'::regclass AND conname IN ('commerce_orders_recovery_root_order_id_fkey','commerce_orders_recreated_from_order_id_fkey') ORDER BY conname")).rows;
  expect(constraints).toHaveLength(2);expect(constraints.every(c=>c.confdeltype==='r'&&c.convalidated===false)).toBe(true);
  await env.owner.query('UPDATE public.commerce_orders SET recovery_root_order_id=$2,recreated_from_order_id=$2 WHERE id=$1',[first.id,root.id]);
  await expect(env.owner.query('UPDATE public.commerce_orders SET recovery_root_order_id=$2,recreated_from_order_id=$2 WHERE id=$1',[second.id,root.id])).rejects.toMatchObject({code:'23505',constraint:'idx_commerce_orders_one_replacement_per_source'});
  await env.owner.query('DELETE FROM public.commerce_destination_bindings WHERE order_id=$1',[root.id]);
  await env.owner.query('UPDATE public.commerce_orders SET recreated_from_order_id=NULL WHERE id=$1',[first.id]);
  await expect(env.owner.query('DELETE FROM public.commerce_orders WHERE id=$1',[root.id])).rejects.toMatchObject({code:'23503',constraint:'commerce_orders_recovery_root_order_id_fkey'});
  await env.owner.query('UPDATE public.commerce_orders SET recovery_root_order_id=NULL,recreated_from_order_id=$2 WHERE id=$1',[first.id,root.id]);
  await expect(env.owner.query('DELETE FROM public.commerce_orders WHERE id=$1',[root.id])).rejects.toMatchObject({code:'23503',constraint:'commerce_orders_recreated_from_order_id_fkey'});
  await expect(env.owner.query('UPDATE public.commerce_orders SET recovery_root_order_id=$2 WHERE id=$1',[second.id,randomUUID()])).rejects.toMatchObject({code:'23503',constraint:'commerce_orders_recovery_root_order_id_fkey'});
  await expect(env.owner.query('UPDATE public.commerce_orders SET recreated_from_order_id=$2 WHERE id=$1',[second.id,randomUUID()])).rejects.toMatchObject({code:'23503',constraint:'commerce_orders_recreated_from_order_id_fkey'});
 });
 it('reads original facts and follows the root latest-created descendant from any generation without recursive traversal',async()=>{
  const root=await order(),first=await order(root.client),last=await order(root.client),side=await order(root.client);
  await env.owner.query("UPDATE public.commerce_orders SET created_at='2040-01-01T00:00:00Z',recovery_root_order_id=$2,recreated_from_order_id=$2 WHERE id=$1",[first.id,root.id]);
  await env.owner.query("UPDATE public.commerce_orders SET created_at='2040-01-02T00:00:00Z',recovery_root_order_id=$2,recreated_from_order_id=$3 WHERE id=$1",[last.id,root.id,first.id]);
  await env.owner.query("UPDATE public.commerce_orders SET created_at='2040-01-03T00:00:00Z',recovery_root_order_id=$2 WHERE id=$1",[side.id,root.id]);
  expect(await orders().getRecoveryOrder({orderId:first.id})).toMatchObject({orderId:first.id,recoveryRootOrderId:root.id,recreatedFromOrderId:root.id});
  expect(await orders().getLatestRecoveryOrder!({orderId:first.id})).toMatchObject({orderId:side.id});
  expect(await orders().getLatestRecoveryOrder!({orderId:root.id})).toMatchObject({orderId:side.id});
  expect(await orders().getLatestRecoveryOrder!({orderId:randomUUID()})).toBeNull();
  const alone=await order();expect(await orders().getLatestRecoveryOrder!({orderId:alone.id})).toMatchObject({orderId:alone.id});
 });
 it('lets capable clients inspect eligible expired context and refuses ordinary payment authority',async()=>{
  const f=await order();await expire(f.id);const raw=await token(f),s=inspection();
  expect(await inspect(s.port,raw)).toMatchObject({recoverable:true,recoveryKind:'recreate_expired',order:{orderId:f.id,paymentIntentId:null}});
  expect(await tokens().validate(raw)).toBeNull();expect(await inspect(s.port,raw,false)).toEqual({recoverable:false,fallback:'fresh_checkout'});
  expect(s.validation).toHaveBeenCalledOnce();
 });
 it('keeps revoked authority dead and binds both original and latest client ownership',async()=>{
  const f=await order();await expire(f.id);const raw=await token(f,'revoked'),s=inspection();expect(await inspect(s.port,raw)).toMatchObject({recoverable:false});expect(s.validation).not.toHaveBeenCalled();
  const good=await token(f);const stranger=await order();await expire(stranger.id);await env.owner.query('UPDATE public.commerce_orders SET recovery_root_order_id=$2,recreated_from_order_id=$2 WHERE id=$1',[stranger.id,f.id]);
  expect(await inspect(s.port,good)).toMatchObject({recoverable:false});expect(s.validation).not.toHaveBeenCalled();
  const wrong=await token({id:f.id,client:stranger.client});expect(await inspect(s.port,wrong)).toMatchObject({recoverable:false});
 });
 it('follows a pending replacement only for continuation states and never promotes an expired token',async()=>{
  const root=await order();await expire(root.id);const child=await order(root.client);await env.owner.query('UPDATE public.commerce_orders SET recovery_root_order_id=$2,recreated_from_order_id=$2 WHERE id=$1',[child.id,root.id]);
  const intent=await call(env.runtime,'commerce_open_settlement_intent',[`intent:${child.id}`,child.id,'sandbox',100,'XXX',{},new Date().toISOString()]);expect(intent).toBeTruthy();
  const s=inspection();expect(await inspect(s.port,await token(root,'active'))).toMatchObject({recoverable:true,recoveryKind:'retry_existing',order:{orderId:child.id}});
  expect(await inspect(s.port,await token(root))).toEqual({recoverable:false,fallback:'fresh_checkout'});expect(s.validation).not.toHaveBeenCalled();
 });
 it('presents paid/latest-paid and manual cancellation without payment controls',async()=>{
  const f=await order(),raw=await token(f,'active');await env.owner.query("UPDATE public.commerce_orders SET status='paid' WHERE id=$1",[f.id]);
  const s=inspection();expect(await inspect(s.port,raw)).toMatchObject({recoverable:false,terminalStatus:'paid',paidOrder:{orderId:f.id,clientId:f.client}});
  const root=await order(),latest=await order(root.client);await expire(root.id);await env.owner.query("UPDATE public.commerce_orders SET status='paid',recovery_root_order_id=$2,recreated_from_order_id=$2 WHERE id=$1",[latest.id,root.id]);
  expect(await inspect(s.port,await token(root))).toMatchObject({recoverable:false,terminalStatus:'paid',paidOrder:{orderId:latest.id}});
  const manual=await order();await env.owner.query("UPDATE public.commerce_orders SET status='cancelled' WHERE id=$1",[manual.id]);expect(await inspect(s.port,await token(manual,'active'))).toMatchObject({recoverable:false,terminalStatus:'cancelled'});expect(s.validation).not.toHaveBeenCalled();
 });
 it('admits only a compensated initial declaration, without reactivating it or inheriting old markers',async()=>{
  const f=await order(undefined,true);await env.owner.query("UPDATE public.subscription_activations SET state='compensated',compensated_at=clock_timestamp() WHERE order_id=$1",[f.id]);
  await env.owner.query("UPDATE public.commerce_orders SET status='cancelled',metadata=metadata||'{\"subscriptionActivation\":\"abandoned\",\"source\":\"initial_checkout_sweep\",\"paymentStatus\":\"cancelled\"}' WHERE id=$1",[f.id]);
  const s=inspection();expect(await inspect(s.port,await token(f,'active'))).toMatchObject({recoverable:true,recoveryKind:'recreate_expired',order:{mode:'subscription_cycle'}});
  expect((await env.owner.query('SELECT state,subscription_id FROM public.subscription_activations WHERE order_id=$1',[f.id])).rows).toEqual([{state:'compensated',subscription_id:null}]);
  const child=await order(f.client,true);await env.owner.query('UPDATE public.commerce_orders SET recovery_root_order_id=$2,recreated_from_order_id=$2 WHERE id=$1',[child.id,f.id]);await expire(child.id);
  expect(await inspect(s.port,await token(f))).toMatchObject({recoverable:false});expect(s.validation).toHaveBeenCalledOnce();
 });
 it('refuses renewal checkout inspection and leaves payment-case tokens unchanged',async()=>{
  const f=await lifecycleDeclined(env.owner),raw=`rcv_${randomUUID()}`;await env.owner.query('UPDATE public.commerce_checkout_recovery_tokens SET token_hash=$2 WHERE id=$1',[f.token,hashCheckoutRecoveryToken(raw)]);
  const before=(await env.owner.query('SELECT * FROM public.commerce_checkout_recovery_tokens WHERE id=$1',[f.token])).rows;
  const s=inspection();expect(await inspect(s.port,raw)).toMatchObject({recoverable:false});expect(s.validation).not.toHaveBeenCalled();
  expect((await env.owner.query('SELECT * FROM public.commerce_checkout_recovery_tokens WHERE id=$1',[f.token])).rows).toEqual(before);
 });
 it('refuses content loss before any validation work, with no writes across repeated polling',async()=>{
  const f=await order();await expire(f.id);const raw=await token(f),validate=vi.fn(async()=>true),policy=createCheckoutRecoveryValidationPolicy({supports:()=>false,validation:{validate}});
  const port=createCheckoutRecoveryInspection({tokenPort:tokens(),orderPort:orders(),validation:policy,clientHasLiveOrPendingSubscription:async()=>false});
  const rows=async()=>{const result: unknown[]=[];for(const name of ['commerce_orders','commerce_checkout_recovery_tokens','subscription_activations','commerce_settlement_intents','commerce_destination_bindings','outbox_events'])result.push((await env.owner.query(`SELECT to_jsonb(t) AS row,xmin::text AS version FROM public.${name} t ORDER BY to_jsonb(t)::text`)).rows);return result;};
  const before=await rows();for(let n=0;n<3;n++)expect(await inspect(port,raw)).toEqual({recoverable:false,fallback:'fresh_checkout',terminalStatus:'order_changed'});
  expect(validate).not.toHaveBeenCalled();expect(await rows()).toEqual(before);
 });
 it('denies both readers to anon/authenticated and exposes only stable definer execution to service',async()=>{
  for(const signature of ['public.commerce_checkout_recovery_order_snapshot(uuid)','public.commerce_checkout_recovery_latest_order_snapshot(uuid)']){
   expect((await env.owner.query('SELECT provolatile,prosecdef,proconfig FROM pg_proc WHERE oid=$1::regprocedure',[signature])).rows).toEqual([{provolatile:'s',prosecdef:true,proconfig:['search_path=pg_catalog, pg_temp']}]);
   // Legacy installs with no service role; creating that role later confers no grant.
   // The catalogue guard also installs this exact forward with service_role present.
   for(const role of ['anon','authenticated','service_role'])expect((await env.owner.query("SELECT has_function_privilege($1,$2,'EXECUTE') AS allowed",[role,signature])).rows[0].allowed).toBe(role==='service_role' && profile!=='legacy');
   for(const role of ['anon','authenticated']){const db=await env.owner.connect();try{await db.query('BEGIN');await db.query(`SET LOCAL ROLE ${role}`);await expect(db.query(`SELECT ${signature.replace('(uuid)','($1::uuid)')}`,[randomUUID()])).rejects.toMatchObject({code:'42501'});}finally{await db.query('ROLLBACK');db.release();}}
  }
 });
});
