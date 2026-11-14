import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const root=new URL('../../',import.meta.url);
const read=(path:string)=>readFileSync(fileURLToPath(new URL(path,root)),'utf8');
import {Pool, type PoolClient} from 'pg';
import {closePostgres,runPostgresContainer,waitForPostgresTcpReady} from '../helpers/postgresContainer.js';
export const ecommerceForward='db/platform/migrations/20261111120000_communication_ecommerce_sources.sql';
export const ecommerceAt='2026-11-11T12:00:00.000Z';
export async function ecommerceInstallation() {
 const container=await runPostgresContainer({name:`ecommerce-facts-${process.pid}-${randomUUID().slice(0,6)}`,password:'synthetic-conformance'});
 let db:Pool|undefined;
 try {
  if(!await waitForPostgresTcpReady(container.connectionString)) throw new Error('ecommerce_pg_unavailable');
  db=new Pool({connectionString:container.connectionString});
  const manifest=JSON.parse(read('config/platform-migration-manifest.json'));
  const targetIndex=manifest.forward.findIndex((row:{file:string})=>row.file===ecommerceForward);
  for(const entry of [manifest.baseline,...manifest.forward.slice(0,targetIndex)]) await db.query(read(entry.file));
  await db.query(read(ecommerceForward));
  for(const entry of manifest.forward.slice(targetIndex+1)) await db.query(read(entry.file));
  const pool=db;
  const withTransaction=async<T>(work:(db:PoolClient)=>Promise<T>)=>{
   const connection=await pool.connect();
   try{await connection.query('BEGIN');const result=await work(connection);await connection.query('COMMIT');return result;}
   catch(error){await connection.query('ROLLBACK');throw error;}finally{connection.release();}
  };
  return {db,withTransaction,close:()=>closePostgres(container,pool)};
 }catch(error){await closePostgres(container,db);throw error;}
}
/** Synthetic native owner write and the real settlement producer; no fabricated outbox. */
export async function ecommercePaid(db:Pool|PoolClient,options:{complete?:boolean;initial?:boolean;discount?:boolean;deferSettlement?:boolean;at?:string}={}) {
 const client=randomUUID(),order=randomUUID();
 const at=options.at??ecommerceAt,initial=options.initial??false;
 await db.query('INSERT INTO public.clients(id,email) VALUES($1,$2)',[client,`${client}@example.invalid`]);
 await db.query(`INSERT INTO public.commerce_orders(id,client_id,currency_code,total_amount_minor,metadata)
 VALUES($1,$2,'USD',1234,$3)`,[order,client,{orderDraftSnapshot:{currency:'USD',context:{mode:initial?'subscription':'one_time'},totals:{totalGross:{amountMinor:1234}},lines:[{sku:'frozen-sku'}]}}]);
 if(options.discount){
  await db.query(`INSERT INTO public.commerce_order_items(order_id,line_ordinal,source_line_ordinal,quantity,unit_amount_minor,line_amount_minor)
   VALUES($1,1,1,1,567,567),($1,2,1,1,568,568)`,[order]);
  await db.query(`INSERT INTO public.commerce_order_adjustments(order_id,kind,scope,amount_minor) VALUES($1,'shipping_charge','shipping',99)`,[order]);
 }else await db.query(`INSERT INTO public.commerce_order_items(order_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor) VALUES($1,1,1,1234,1234)`,[order]);
 if(initial) await db.query(`SELECT public.subscription_declare_provisional_activation($1,$2,28,$3::timestamptz)`,[randomUUID(),order,at]);
 let intent:string|null=null;
 if(options.complete!==false){
  const result=(await db.query(`SELECT public.commerce_open_settlement_intent($1,$2,'synthetic',1234,'USD','{}'::jsonb,$3::timestamptz) AS value`,[randomUUID(),order,at])).rows[0].value;
  intent=String(result.settlementIntent?.id??result.settlementIntentId??result.intentId);
  // Read the owner row by its order rather than depending on a response presentation shape.
  intent=String((await db.query('SELECT id FROM public.commerce_settlement_intents WHERE order_id=$1',[order])).rows[0].id);
  if(!options.deferSettlement) await db.query(`SELECT public.commerce_record_settlement($1,$2,'succeeded','synthetic-paid','{}'::jsonb,$3::timestamptz)`,[randomUUID(),intent,at]);
 }else await db.query(`UPDATE public.commerce_orders SET status='paid',paid_at=$2 WHERE id=$1`,[order,at]);
 return {client,order,intent};
}
