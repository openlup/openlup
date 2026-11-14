export const PORTABILITY_CONSUMER_PROOF = `
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import pg from "pg";
import {captureCompatiblePostgresRows,restoreCompatiblePostgresRows} from "@openlup/platform/portability";
const client=new pg.Client({connectionString:process.argv[2]});await client.connect();
const id=randomUUID(),parent=randomUUID(),owner=randomUUID(),key="installed-transfer:"+id,catalogueId="owned-canonical-install";
async function transaction(readOnly,work){await client.query(readOnly?"BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY":"BEGIN");try{const result=await work(client);await client.query("COMMIT");return result;}catch(error){await client.query("ROLLBACK");throw error;}}
async function capture(table){return captureCompatiblePostgresRows({source:{withSnapshot:work=>transaction(true,work)},sourceId:"owned-installed-source",catalogueId,tables:[table],maximumRows:1000,maximumBytes:4194304});}
function input(packet){return {target:{withTransaction:work=>transaction(false,work)},catalogueId,packet};}
try{
 const ledger=await client.query("SELECT to_jsonb(t)::text AS value FROM public.platform_schema_migrations t ORDER BY position");
 const acl=await client.query("SELECT relname,relacl::text FROM pg_class WHERE relnamespace='public'::regnamespace ORDER BY relname");
 const payload='{"large":9007199254740993,"state":"processing","attempts":3}';
 // Parents are authored through their normal owner path, not generic restore.
 // Their append-only lifecycle history is disposed with the owned database.
 await client.query("INSERT INTO public.clients(id,email) VALUES($1,$2)",[owner,owner+"@example.invalid"]);
 await client.query("INSERT INTO public.subscriptions(id,client_id,cadence_days) VALUES($1,$2,28)",[parent,owner]);
 await client.query("INSERT INTO public.subscription_events(id,subscription_id,event_type,idempotency_key,payload,occurred_at) VALUES($1,$2,'synthetic.transfer',$3,$4::jsonb,'2026-10-31T01:02:03.123456Z')",[id,parent,key,payload]);
 const before=(await client.query("SELECT to_jsonb(t)::text AS value FROM public.subscription_events t WHERE id=$1",[id])).rows;
 assert.match(before[0].value,/9007199254740993/);assert.match(before[0].value,/01:02:03.123456/);
 const sized=(await client.query("SELECT to_regprocedure('public.subscriptions_bind_sized_opt_in_from_edit()') IS NOT NULL AS installed")).rows[0].installed;
 if(sized){
   for(const [table,trigger] of [["subscriptions","subscriptions_configured_offer_guard"],["subscription_events","subscription_events_bind_sized_opt_in"]]){
     assert.equal((await client.query("SELECT count(*)::int AS count FROM pg_trigger WHERE tgrelid=to_regclass($1) AND tgname=$2 AND NOT tgisinternal AND tgenabled<>'D' AND (tgtype & 4)<>0",["public."+table,trigger])).rows[0].count,1);
     const guardedBefore=(await client.query("SELECT to_jsonb(t)::text AS value,xmin::text AS version FROM public."+table+" t ORDER BY id")).rows;
     await assert.rejects(restoreCompatiblePostgresRows(input(await capture(table))),{code:"insert_trigger_requires_owner",table});
     assert.deepEqual((await client.query("SELECT to_jsonb(t)::text AS value,xmin::text AS version FROM public."+table+" t ORDER BY id")).rows,guardedBefore);
   }
 }else{assert.equal((await restoreCompatiblePostgresRows(input(await capture("subscription_events")))).inserted,0);}
 // Renewal lines remain compatible: recover exact integer JSON and microseconds
 // without bypassing the subscriptions or event owner guards.
 await client.query("INSERT INTO public.subscription_renewal_terms(subscription_id,currency_code,stock_source_key,settlement_channel_key,unattended_charge_authorized_at,authorization_ref) VALUES($1,'XXX','synthetic-stock','synthetic-channel','2026-10-31T01:02:03.123456Z',$2)",[parent,key]);
 await client.query("INSERT INTO public.subscription_renewal_term_lines(subscription_id,line_ordinal,sku,quantity,unit_amount_minor,created_at) VALUES($1,1,$2,3,9007199254740993,'2026-10-31T01:02:03.123456Z')",[parent,key]);
 const linesBefore=(await client.query("SELECT to_jsonb(t)::text AS value FROM public.subscription_renewal_term_lines t WHERE subscription_id=$1",[parent])).rows;
 assert.match(linesBefore[0].value,/9007199254740993/);assert.match(linesBefore[0].value,/01:02:03.123456/);
 const packet=await capture("subscription_renewal_term_lines");
 assert.equal((await restoreCompatiblePostgresRows(input(packet))).inserted,0);
 await client.query("DELETE FROM public.subscription_renewal_term_lines WHERE subscription_id=$1",[parent]);
 assert.equal((await restoreCompatiblePostgresRows(input(packet))).inserted,1);
 assert.deepEqual((await client.query("SELECT to_jsonb(t)::text AS value FROM public.subscription_renewal_term_lines t WHERE subscription_id=$1",[parent])).rows,linesBefore);
 const retained=(await client.query("SELECT xmin::text AS version FROM public.subscription_renewal_term_lines WHERE subscription_id=$1",[parent])).rows;
 assert.equal((await restoreCompatiblePostgresRows(input(packet))).inserted,0);
 assert.deepEqual((await client.query("SELECT xmin::text AS version FROM public.subscription_renewal_term_lines WHERE subscription_id=$1",[parent])).rows,retained);
 await client.query("UPDATE public.subscription_renewal_term_lines SET quantity=4 WHERE subscription_id=$1",[parent]);
 await assert.rejects(restoreCompatiblePostgresRows(input(packet)),{code:"target_conflict"});
 // The complete channel catalogue adds an INSERT guard to outbox. Generic
 // transfer must refuse even an ordinary row; only reference owner paths admit it.
 await client.query("INSERT INTO public.outbox_events(id,aggregate_type,aggregate_id,event_type,idempotency_key,payload,status,attempts) VALUES($1,'synthetic',$1,'synthetic.transfer',$2,$3::jsonb,'processing',3)",[id,key,payload]);
 const outboxBefore=(await client.query("SELECT to_jsonb(t)::text AS value,xmin::text AS version FROM public.outbox_events t ORDER BY id")).rows;
 const outbox=await capture("outbox_events");
 const channels=(await client.query("SELECT to_regclass('public.sales_channel_control_operations') IS NOT NULL AS installed")).rows[0].installed;
 if(channels){
   assert.equal((await client.query("SELECT count(*)::int AS count FROM pg_trigger WHERE tgrelid='public.outbox_events'::regclass AND tgname='channel_purchase_outbox_guard' AND NOT tgisinternal AND tgenabled<>'D' AND (tgtype & 4)<>0")).rows[0].count,1);
   await assert.rejects(restoreCompatiblePostgresRows(input(outbox)),{code:"insert_trigger_requires_owner",table:"outbox_events"});
 }else{assert.equal((await restoreCompatiblePostgresRows(input(outbox))).inserted,0);}
 assert.deepEqual((await client.query("SELECT to_jsonb(t)::text AS value,xmin::text AS version FROM public.outbox_events t ORDER BY id")).rows,outboxBefore);
 assert.deepEqual((await client.query("SELECT to_jsonb(t)::text AS value FROM public.platform_schema_migrations t ORDER BY position")).rows,ledger.rows);
 assert.deepEqual((await client.query("SELECT relname,relacl::text FROM pg_class WHERE relnamespace='public'::regnamespace ORDER BY relname")).rows,acl.rows);
 console.log("Portability installed canonical selected-row recovery PASS (trigger-free renewal line, exact replay/conflict/precision, guarded subscription/event/outbox refusal when installed)");
}finally{await client.query("DELETE FROM public.outbox_events WHERE id=$1",[id]);await client.query("DELETE FROM public.subscription_renewal_terms WHERE subscription_id=$1",[parent]);await client.query("DELETE FROM public.subscription_events WHERE subscription_id=$1",[parent]);await client.end();}
`;
