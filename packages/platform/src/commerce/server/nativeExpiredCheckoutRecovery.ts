import { createHash } from 'node:crypto';
import type { CreateQuoteResponse } from '../../pricing/index.js';
import { CommerceOrderDraftConflictError } from '../errors.js';
import { quotesMatchForRecovery } from './checkoutExpiredRecoveryPolicy.js';
import { ExpiredCheckoutRecoveryError, parseRecoveryRecreationQuote, type ExpiredCheckoutRecoveryOrder } from './expiredCheckoutRecovery.js';
import type { CheckoutRecoveryWriteExecutor } from './postgresExpiredCheckoutRecovery.js';

/** Preserve native draft receipts when re-quotes differ only in transient identity.
 * Every replay still goes through the existing writer with its original accepted snapshot. */
export function createPostgresExpiredCheckoutDraftPort<Draft extends { orderId:string }>(db:CheckoutRecoveryWriteExecutor,
 persistence:{createOrderDraft(request:{idempotencyKey:string;quoteSnapshot:CreateQuoteResponse},options:{clientId:string}):Promise<{orderDraft:Draft}>}) {
 return{async createOrderDraft(request:{idempotencyKey:string;quoteSnapshot:CreateQuoteResponse},identity:{clientId:string}){
  try{return await persistence.createOrderDraft(request,identity);}catch(error){
   if(!(error instanceof CommerceOrderDraftConflictError)||error.details.code!=='23505')throw error;
   const row=(await db.query(`SELECT o.metadata->'quoteSnapshot' AS quote FROM public.commerce_order_draft_receipts r
    JOIN public.commerce_orders o ON o.id=r.order_id WHERE r.idempotency_key=$1 AND r.invalidated_at IS NULL AND o.client_id=$2::uuid`,[request.idempotencyKey,identity.clientId])).rows[0];
   const stored=parseRecoveryRecreationQuote(row?.quote),fresh=parseRecoveryRecreationQuote(request.quoteSnapshot);
   if(!stored||!fresh||!quotesMatchForRecovery(stored,fresh))throw error;
   return persistence.createOrderDraft({...request,quoteSnapshot:stored},identity);
  }
 }};
}
export interface ExpiredRecoveryRuntimeInput<Draft> {idempotencyKey:string;orderDraft:Draft;quoteSnapshot:CreateQuoteResponse;source:ExpiredCheckoutRecoveryOrder;clientId:string}
/** The host supplies a dedicated READ COMMITTED transaction. The replacement
 * order lock serializes runtime replay before native fail-fast inventory locks.
 * Bind both callbacks to the provided executor; no remote dispatch belongs here. */
export function createPostgresExpiredCheckoutRuntime<Result>(lane:ExpiredRecoveryTransactionLane,ports:{
 stockSourceKey:string;reservationLifetimeMs:number;channelKey:string;now?:()=>Date;
 reserveOrderItems(input:{idempotencyKey:string;orderId:string;stockSourceKey:string;items:{orderItemId:string;skuId:string;quantity:number}[];paymentStatus:'created';expiresAt:string;now:string},db:CheckoutRecoveryWriteExecutor):Promise<unknown>;
 startPayment(input:{idempotencyKey:string;settlementIntentId:string;orderId:string;clientId:string},db:CheckoutRecoveryWriteExecutor):Promise<Result>;
}){
 if(!Number.isSafeInteger(ports.reservationLifetimeMs)||ports.reservationLifetimeMs<=0)throw new Error('checkout_recovery_policy_invalid');
 async function rpc(db:CheckoutRecoveryWriteExecutor,name:string,casts:string[],args:unknown[]){return(await db.query(`SELECT public.${name}(${casts.map((c,i)=>`$${i+1}::${c}`).join(',')}) AS result`,args)).rows[0]?.result as Record<string,unknown>|undefined;}
 return{async startRuntime(input:ExpiredRecoveryRuntimeInput<{orderId:string}>):Promise<Result>{return lane.run(async gateway=>{
  const db=gateway as CheckoutRecoveryWriteExecutor;
  const orderId=input.orderDraft.orderId.replace(/^order_/,''),key=input.idempotencyKey,now=(ports.now?.()??new Date()).toISOString();
  const current=(await db.query('SELECT client_id,status,subscription_cycle_id,created_at,total_amount_minor,currency_code FROM public.commerce_orders WHERE id=$1::uuid FOR UPDATE',[orderId])).rows[0];
  if(!current||String(current.client_id)!==input.clientId)throw new ExpiredCheckoutRecoveryError('unavailable');
  if(current.status!=='paid'){
   if(current.status!=='pending_payment'||current.subscription_cycle_id!==null)throw new ExpiredCheckoutRecoveryError('unavailable');
   const document=await rpc(db,'commerce_read_destination',['text','uuid'],['order',input.source.orderId]);
   if(!document||document.destinationId!==input.source.shippingAddressId||document.clientId!==input.clientId)throw new ExpiredCheckoutRecoveryError('unavailable');
   await rpc(db,'commerce_register_order_destination',['text','uuid','jsonb','timestamptz'],[`${key}:destination`,orderId,JSON.stringify(document.address),now]);
   const items=(await db.query('SELECT id,sku_id,quantity FROM public.commerce_order_items WHERE order_id=$1::uuid ORDER BY line_ordinal',[orderId])).rows;
   try{await ports.reserveOrderItems({idempotencyKey:`${key}:inventory`,orderId,stockSourceKey:ports.stockSourceKey,
    items:items.map(i=>({orderItemId:String(i.id),skuId:String(i.sku_id),quantity:Number(i.quantity)})),paymentStatus:'created',
    expiresAt:new Date(new Date(String(current.created_at)).getTime()+ports.reservationLifetimeMs).toISOString(),now},db);
   }catch(error){if(error instanceof Error&&error.message==='inventory_external_provider_insufficient_available_stock')throw new ExpiredCheckoutRecoveryError('order_changed');throw error;}
  }
  const intent=await rpc(db,'commerce_open_settlement_intent',['text','uuid','text','bigint','text','jsonb','timestamptz'],
   [`${key}:payment-intent`,orderId,ports.channelKey,current.total_amount_minor,current.currency_code,JSON.stringify({
    ...input.source.runtimeMetadata,invoiceBuyerSnapshot:input.source.invoiceBuyerSnapshot,recoveryRootOrderId:input.source.recoveryRootOrderId,
    recreatedFromOrderId:input.source.orderId,recoveryReason:'expired_checkout_recreate'}),now]);
  const intentId=(intent?.settlement as Record<string,unknown>|undefined)?.id;
  if(typeof intentId!=='string')throw new ExpiredCheckoutRecoveryError('execution_failed');
  return ports.startPayment({idempotencyKey:`${key}:payment-execution`,settlementIntentId:intentId,orderId,clientId:input.clientId},db);
 });}};
}
export interface ExpiredRecoveryTransactionLane {run<T>(work:(gateway:unknown)=>Promise<T>):Promise<T>}
/** Both cleanup stages retain the native payment-evidence guard. The unstarted
 * check and cancellation share the same order lock and transaction. */
export function createPostgresExpiredCheckoutCompensation(lane:ExpiredRecoveryTransactionLane,now:()=>Date=()=>new Date()){
 async function cancel(input:{idempotencyKey:string;orderId:string;reason:string},unstarted:boolean){return lane.run(async gateway=>{
  const db=gateway as CheckoutRecoveryWriteExecutor;
  if(unstarted){const order=(await db.query('SELECT status FROM public.commerce_orders WHERE id=$1::uuid FOR UPDATE',[input.orderId])).rows[0];
   if(!order||order.status!=='pending_payment'||(await db.query(`SELECT 1 FROM public.commerce_settlement_intents WHERE order_id=$1::uuid
     UNION ALL SELECT 1 FROM public.fulfillment_inventory_reservations WHERE purchase_order_id=$1::uuid LIMIT 1`,[input.orderId])).rows.length)return{cancelled:false};}
  const value=(await db.query('SELECT public.commerce_cancel_abandoned_purchase_checkout($1::text,$2::uuid,$3::text,$4::timestamptz) AS result',
   [`${input.idempotencyKey}:${unstarted?'unstarted':'abandon'}`,input.orderId,input.reason,now().toISOString()])).rows[0]?.result as {cancelled?:boolean}|undefined;
  return{cancelled:value?.cancelled===true};
 });}
 return{cancelAbandonedOrder:(i:{idempotencyKey:string;orderId:string;reason:string})=>cancel(i,false),
  cancelUnstartedPromotionOrder:(i:{idempotencyKey:string;orderId:string;reason:string})=>cancel(i,true)};
}
/** Stable execution identity excludes fresh quote IDs and request timestamps. */
export function checkoutRecoveryExecutionFingerprint(input:{idempotencyKey:string;settlementIntentId:string;orderId:string;clientId:string}):string{
 return createHash('sha256').update(JSON.stringify([input.idempotencyKey,input.settlementIntentId,input.orderId,input.clientId])).digest('hex');
}
