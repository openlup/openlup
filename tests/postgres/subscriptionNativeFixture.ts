import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { expect } from 'vitest';
import { fixture as deliveryFixture, openCase, schedule } from '../helpers/fulfillmentNative.js';

export const AT='2026-09-01T12:00:00.000Z';
export const later=(hours:number)=>new Date(Date.parse(AT)+hours*3_600_000).toISOString();
export type Db=Pool|PoolClient;
export async function call(db:Db,name:string,args:unknown[]) {
 return (await db.query(`SELECT public.${name}(${args.map((_,i)=>`$${i+1}`).join(',')}) AS result`,args)).rows[0].result;
}
export async function renewal(pool:Pool,availability=10,lines=1,subscription=randomUUID()) {
 await call(pool,'subscription_delivery_alignment_set_mode',['off']);
 const client=randomUUID(),source=randomUUID();
 await pool.query("INSERT INTO public.clients(id,email) VALUES($1,$2)",[client,`${client}@example.invalid`]);
 await pool.query("INSERT INTO public.subscriptions(id,client_id,cadence_days,next_cycle_at) VALUES($1,$2,28,$3)",[subscription,client,AT]);
 await pool.query(`INSERT INTO public.subscription_renewal_terms(subscription_id,next_cycle_number,currency_code,stock_source_key,
 settlement_channel_key,unattended_charge_authorized_at,authorization_ref) VALUES($1,2,'XXX',$2,'fixture',$3,'frozen-mandate')`,[subscription,source,AT]);
 const basket:{lineOrdinal:number;sku:string;quantity:number;unitAmountMinor:number}[]=[];
 for(let n=1;n<=lines;n++) {
  const id=randomUUID(),sku=`SKU-${id}`;
  await pool.query("INSERT INTO public.catalog_products(id,slug,name) VALUES($1,$2,'Fixture')",[id,sku]);
  await pool.query("INSERT INTO public.catalog_skus(id,product_id,sku,title) VALUES($1,$1,$2,'Fixture')",[id,sku]);
  await pool.query('INSERT INTO public.subscription_renewal_term_lines(subscription_id,line_ordinal,sku,quantity,unit_amount_minor) VALUES($1,$2,$3,2,100)',[subscription,n,sku]);
  await pool.query(`INSERT INTO public.fulfillment_stock_current(source_key,sku,total_quantity,for_sale_quantity,reserved_unavailable_quantity,
  inventory_class,last_synced_at,stale_after,sync_run_id,idempotency_key,operation_fingerprint) VALUES($1,$2,$3,$3,0,'sellable',$4,'2027-12-01','fixture',$2,$5)`,[source,sku,availability,AT,'a'.repeat(64)]);
  basket.push({lineOrdinal:n,sku,quantity:2,unitAmountMinor:100});
 }
 const snapshot={contractVersion:'platform.subscription.renewal.v1',subscriptionId:subscription,clientId:client,scheduledAt:AT,cycleNumber:2,
  currency:'XXX',stockSourceKey:source,settlementChannelKey:'fixture',authorizationRef:'frozen-mandate',payerAccountRef:null,totalAmountMinor:200*lines,lines:basket};
 const fingerprint=createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
 const identity=await call(pool,'subscription_renewal_identity',[subscription,AT]);
 const op=await call(pool,'subscription_claim_due_renewal',[identity,fingerprint,snapshot,'fixture',300,AT]);
 return {client,subscription,source,snapshot,fingerprint,identity,operation:op.operationId as string,token:op.claimToken as string};
}
export type Renewal=Awaited<ReturnType<typeof renewal>>;
export async function prepareOriginal(pool:Pool,f:Renewal) {
 await call(pool,'fulfillment_reserve_subscription_renewal',[f.operation,f.token,900,AT]);
 const prepared=await call(pool,'commerce_prepare_subscription_renewal',[f.operation,f.token,AT]);
 await call(pool,'commerce_acknowledge_subscription_renewal_attempt',[f.operation,f.fingerprint,'original-ack',AT]);
 return prepared;
}
export function failure(sequence=0,at=AT,classification='temporary') {
 return {attemptSequence:sequence,logicalCycleNumber:3,occurredAt:at,failureClass:classification,reason:'declined',externalRef:`attempt-${sequence}`,evidenceKey:`failure-evidence-${sequence}`,firstRecordedAt:at};
}
export const request=(f:Renewal & {original:{settlementIntentId:string;orderId:string}},_sequence=1)=>({paymentIntentId:f.original.settlementIntentId,orderRef:f.original.orderId,amountMinor:f.snapshot.totalAmountMinor,currency:f.snapshot.currency,idempotencyKey:`execution-${randomUUID()}`,providerIdempotencyKey:`provider-${randomUUID()}`,providerRequestFingerprint:'f'.repeat(64),paymentMethodRef:'method-1'});
export function positive(f:Renewal,prepareKey?:string,at=later(25)) {
 return {prepareKey,evidenceKey:`evidence-${f.operation}`,occurredAt:at,firstRecordedAt:at,externalRef:`paid-${f.operation}`,
  amountMinor:f.snapshot.totalAmountMinor,currency:'XXX',template:'recovered'};
}
export async function unchangedIdentity(pool:Pool,f:Renewal) {
 const op=(await pool.query('SELECT identity_key,operation_fingerprint,cycle_snapshot FROM public.subscription_renewal_operations WHERE id=$1',[f.operation])).rows[0];
 expect(op).toEqual({identity_key:f.identity,operation_fingerprint:f.fingerprint,cycle_snapshot:f.snapshot});
 const s=(await pool.query('SELECT status,next_cycle_at FROM public.subscriptions WHERE id=$1',[f.subscription])).rows[0];
 expect(s.status).toBe('active');expect(s.next_cycle_at.getTime()).toBeGreaterThanOrEqual(Date.parse(AT));
 expect((await pool.query('SELECT * FROM public.subscription_pause_windows WHERE subscription_id=$1',[f.subscription])).rows).toEqual([]);
}
export async function alignmentInvariant(pool:Pool) {
 const f=await deliveryFixture(pool);await openCase(pool,f,'auto_align');
 const admission=()=>call(pool,'subscription_delivery_alignment_admit_renewal',[f.subscription,'2026-08-29T12:00:00Z',AT]);
 expect(await admission()).toMatchObject({allowed:false});
 await call(pool,'subscription_delivery_alignment_set_mode',['off']);
 const input=[`arrival-${f.shipment}`,f.shipment,'2026-09-08T12:00:00Z',`evidence:${f.shipment}`];
 await call(pool,'fulfillment_record_alignment_arrival',input);
 const before=await schedule(pool,f.subscription);
 expect(before).toMatchObject({status:'active',next_cycle_at:new Date('2026-10-06T12:00:00Z')});
 await call(pool,'fulfillment_record_alignment_arrival',input);
 expect(await schedule(pool,f.subscription)).toEqual(before);
 expect(await call(pool,'subscription_delivery_alignment_admit_renewal',[f.subscription,before.next_cycle_at.toISOString(),AT])).toMatchObject({allowed:true});
}
