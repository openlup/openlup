import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Pool, type PoolClient } from 'pg';
import { createPostgresMigrationRunner } from '../../server/adapters/postgres/migrationRunner.js';
import { closePostgres, dockerAvailable,runPostgresContainer,waitForPostgresTcpReady,type PostgresContainer } from './postgresContainer.js';
export const manifest=JSON.parse(readFileSync('config/platform-migration-manifest.json','utf8'));
export const units: { file:string;sha256:string }[]=[manifest.baseline,...manifest.forward];
export const executor=(db: Pool | PoolClient) => ({query:(sql:string,values?:unknown[]) => db.query(sql,values)});
export function nativeHarness(label:string) {
 let container:PostgresContainer|undefined; let pool:Pool;
 return {
  get pool(){return pool;},
  runner(db=pool,root=process.cwd()){return createPostgresMigrationRunner({connectionString:container!.connectionString},{root,poolFactory:()=>db});},
  async start(){
   if (!await dockerAvailable()) throw new Error('P4 native proof requires Docker PostgreSQL');
   const at=Date.now();container=await runPostgresContainer({name:`m08-p4-${label}-${process.pid}`,password:'synthetic-conformance'});
   if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error('P4 PostgreSQL unavailable');
   console.log(`P4 ${label} Docker setup ms=${Date.now()-at}`);
   pool=new Pool({connectionString:container.connectionString});await this.runner().apply();
  },
  async stop(extraContainers:PostgresContainer[]=[],extraPools:Pool[]=[]){await closePostgres([container,...extraContainers], [pool,...extraPools]);},
 };
}
async function paidOrder(pool:Pool,order:string,client:string,cycle:string|null) {
 const db=await pool.connect();
 try {
 await db.query('BEGIN');
 await db.query("INSERT INTO public.commerce_orders(id,client_id,subscription_cycle_id,status,currency_code,total_amount_minor) VALUES($1,$2,$3,'paid','XXX',900)",[order,client,cycle]);
 await db.query("INSERT INTO public.commerce_order_items(order_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor) VALUES($1,1,1,900,900)",[order]);
 await db.query('COMMIT');
 } catch(error){await db.query('ROLLBACK');throw error;} finally{db.release();}
}
export async function fixture(pool:Pool,number: number | null=1,withActivation=false,activationOnly=false) {
 let subscription=randomUUID();
 let cycle=randomUUID(),order=randomUUID();
 const client=randomUUID(),shipment=randomUUID(),operation=randomUUID(),token=randomUUID();
 await pool.query("INSERT INTO public.clients(id,email) VALUES($1,$2)",[client,`${client}@example.invalid`]);
 if (withActivation) {
  const activationOrder=randomUUID();
  await paidOrder(pool,activationOrder,client,null);
  await pool.query("SELECT public.subscription_declare_provisional_activation($1,$2,28,'2026-07-04T12:00:00Z')",[`declare-${activationOrder}`,activationOrder]);
  // Exercise the activation spine's write half: paid cycle without renewal correlation.
  subscription=(await pool.query("SELECT (public.subscription_activation_commit(activation,$2,$3,'2026-07-04T12:00:00Z',false)).subscription_id FROM public.subscription_activations activation WHERE order_id=$1",[activationOrder,`activate-${activationOrder}`,'b'.repeat(64)])).rows[0].subscription_id;
  if (activationOnly) {
   order=activationOrder;
   cycle=(await pool.query('SELECT subscription_cycle_id FROM public.commerce_orders WHERE id=$1',[order])).rows[0].subscription_cycle_id;
  }
  await pool.query("UPDATE public.subscriptions SET next_cycle_at='2026-08-29T12:00:00Z' WHERE id=$1",[subscription]);
 } else {
  await pool.query("INSERT INTO public.subscriptions(id,client_id,cadence_days,next_cycle_at) VALUES($1,$2,28,'2026-08-29T12:00:00Z')",[subscription,client]);
 }
 if (!activationOnly) {
 if (number!==null) await pool.query(`INSERT INTO public.subscription_renewal_operations(id,subscription_id,scheduled_at,cycle_number,identity_key,operation_fingerprint,cycle_snapshot,state,claim_token,claimed_by,claimed_at,lease_expires_at,terminal_outcome,terminal_at)
 VALUES($1,$2,'2026-08-01T12:00:00Z',$3,$4,$5,'{}','succeeded',$6,'fixture',now(),now()+interval '1 hour','succeeded',now())`,[operation,subscription,number,`subscription:${subscription}:cycle:2026-08-01T12:00:00.000Z`,'a'.repeat(64),token]);
 await pool.query("INSERT INTO public.subscription_cycles(id,subscription_id,scheduled_at,status,renewal_operation_id,renewal_operation_fingerprint) VALUES($1,$2,'2026-08-01T12:00:00Z','paid',$3,$4)",[cycle,subscription,number!==null?operation:null,number!==null?'a'.repeat(64):null]);
 await paidOrder(pool,order,client,cycle);
 }
 await pool.query("INSERT INTO public.fulfillment_ports(port_key,provider_type,routable) VALUES('fixture-port','3pl',true) ON CONFLICT DO NOTHING");
 await pool.query("INSERT INTO public.fulfillment_shipments(id,order_id,port_key,provider_type,create_idempotency_key) VALUES($1,$2,'fixture-port','3pl',$3)",[shipment,order,`create-${shipment}`]);
 return {client,subscription,cycle,order,shipment,operation,token};
}
export async function openCase(pool:Pool,f:Awaited<ReturnType<typeof fixture>>,mode='auto_align') {
 await pool.query('SELECT public.subscription_delivery_alignment_set_mode($1)',[mode]);
 await pool.query("INSERT INTO public.commerce_order_holds(order_id,reason,status,idempotency_key) VALUES($1,'fulfillment_exception','active',$2)",[f.order,`exception-${f.order}`]);
 return (await pool.query('SELECT * FROM public.subscription_delivery_alignment_cases WHERE predecessor_order_id=$1 ORDER BY created_at,id',[f.order])).rows[0];
}
export async function schedule(pool:Pool,subscription:string){return (await pool.query('SELECT next_cycle_at,status FROM public.subscriptions WHERE id=$1',[subscription])).rows[0];}
export async function replacement(pool:Pool,f:Awaited<ReturnType<typeof fixture>>,previous=f.shipment,sequence=1){
 const id=randomUUID();
 await pool.query("INSERT INTO public.fulfillment_shipments(id,order_id,port_key,provider_type,create_idempotency_key,sequence_no,replaces_shipment_id,replacement_reason) VALUES($1,$2,'fixture-port','3pl',$3,$4,$5,'lost')",[id,f.order,`create-${id}`,sequence,previous]);
 return id;
}
