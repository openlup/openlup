import { expect, it, vi } from 'vitest';
import { createCheckoutRecoveryPayService, createCheckoutRecoveryTokenPay, type CheckoutRecoveryPayInput } from '../../src/commerce/server/checkoutRecoveryPay.js';
import { withCheckoutRecoveryPaymentHold } from '../../src/commerce/server/checkoutRecoveryPaymentHold.js';
import type { NativeCheckoutRecoveryOrder } from '../../src/commerce/server/checkoutRecoveryInspection.js';
const order:NativeCheckoutRecoveryOrder={orderId:'order',orderRef:'order_ref',orderNumber:'1',clientId:'client',status:'pending_payment',mode:'one_time_order',totalMinor:100,currency:'XXX',createdAt:'2040-01-02T00:00:00Z',cadenceDays:null,customerEmail:null,customerName:null,paymentIntentId:'intent',paymentIntentStatus:'pending',subscriptionId:null,subscriptionCycleId:null,initialDeclarationId:null,initialActivationState:null};
const input:CheckoutRecoveryPayInput<string>={order,clientId:'client',recoveryTokenId:'token',idempotencyKey:'request-key',method:'primary'};
const result={orderId:'order',paymentIntentId:'intent',clientId:'client',paymentAttemptId:'attempt',status:'processing' as const,replayed:false,failureReason:null};
function fixture(){const begin=vi.fn(async()=>result);return{begin,service:createCheckoutRecoveryPayService({begin})};}
it('uses only the same intent and returns a recoverable synchronous decline',async()=>{
 const f=fixture();f.begin.mockResolvedValue({...result,status:'failed',failureReason:'generic_decline'} as typeof result);
 expect(await f.service.pay(input)).toMatchObject({status:'failed',failureReason:'generic_decline'});
 expect(f.begin).toHaveBeenCalledExactlyOnceWith({...input,paymentIntentId:'intent'});
});
it.each(['processing','settled','unknown'])('keeps %s intents retry-later before dispatch',async status=>{
 const f=fixture();await expect(f.service.pay({...input,order:{...order,paymentIntentStatus:status}})).rejects.toMatchObject({code:'payment_intent_in_flight',kind:'upstream_unavailable'});expect(f.begin).not.toHaveBeenCalled();
});
it.each([{subscriptionCycleId:'cycle'},{status:'cancelled'},{technicallyExpired:true},{clientId:'foreign'}])('refuses dead checkout authority %j before dispatch',async patch=>{
 const f=fixture();await expect(f.service.pay({...input,order:{...order,...patch}})).rejects.toMatchObject({kind:'conflict'});expect(f.begin).not.toHaveBeenCalled();
});
it.each(['payment_simulator_attempt_unresolved','payment_simulator_truth_unresolved','checkout_recovery_attempt_in_flight','unexpected_driver_failure'])('maps %s to a structured retry-later',async code=>{
 const f=fixture();f.begin.mockRejectedValue(new Error(code));await expect(f.service.pay(input)).rejects.toMatchObject({kind:'upstream_unavailable'});
});
it('derives canonical order/client from the token when switching methods',async()=>{
 const f=fixture(),validate=vi.fn(async()=>({tokenId:'token',orderId:'order',clientId:'client',status:'pending_payment',mode:'one_time_order'}));
 const api=createCheckoutRecoveryTokenPay({tokenPort:{validate,inspect:async()=>null},orderPort:{getRecoveryOrder:async()=>order},payService:f.service});
 expect(await api.pay({token:'raw',method:'secondary',idempotencyKey:'click-key'})).toEqual(result);
 expect(f.begin).toHaveBeenCalledWith({...input,method:'secondary',idempotencyKey:'click-key',paymentIntentId:'intent'});
});
it('refuses dead tokens and foreign original/latest ownership before pay',async()=>{
 for(const tokenState of ['revoked','expired','unknown']){
  const f=fixture(),api=createCheckoutRecoveryTokenPay({tokenPort:{validate:async()=>null,inspect:async()=>({tokenId:'token',orderId:'order',clientId:'client',status:'pending_payment',mode:'one_time_order',subscriptionId:null,tokenState})},orderPort:{getRecoveryOrder:async()=>order},payService:f.service});
  await expect(api.pay({token:'raw',method:'primary',idempotencyKey:'click',followLatest:true})).rejects.toMatchObject({kind:'conflict'});expect(f.begin).not.toHaveBeenCalled();
 }
 for(const foreignOriginal of [true,false]){
  const f=fixture(),ctx={tokenId:'token',orderId:'order',clientId:'client',status:'pending_payment',mode:'one_time_order',subscriptionId:null,tokenState:'active'};
  const api=createCheckoutRecoveryTokenPay({tokenPort:{validate:async()=>ctx,inspect:async()=>ctx},orderPort:{getRecoveryOrder:async()=>({...order,clientId:foreignOriginal?'foreign':'client'}),getLatestRecoveryOrder:async()=>({...order,clientId:'foreign'})},payService:f.service});
  await expect(api.pay({token:'raw',method:'primary',idempotencyKey:'click',followLatest:true})).rejects.toMatchObject({kind:'conflict'});expect(f.begin).not.toHaveBeenCalled();
 }
});
function held(patch:Partial<NativeCheckoutRecoveryOrder>={},options:{first?:boolean|null;firstThrows?:boolean;readThrows?:boolean;offered?:string[];holdAt?:string;method?:string}={}){
 const pay=vi.fn(async()=>result),lookup=vi.fn(async()=>{if(options.firstThrows)throw new Error('lookup_failure');return options.first??null;});
 const service=withCheckoutRecoveryPaymentHold({pay},{readHolds:async()=>{if(options.readThrows)throw new Error('read_failure');return[{kind:'purchase',method:'primary',createdAt:options.holdAt??'2040-01-01T00:00:00Z'}];},classify:()=>({kind:'purchase',method:options.method??'primary'}),offeredMethods:()=>new Set(options.offered??['primary','secondary']),isFirstPurchase:lookup});
 return{pay,lookup,run:()=>service.pay({...input,order:{...order,...patch}})};
}
it('holds only first purchases created strictly after the hold and preserves never-empty methods',async()=>{
 await expect(held().run()).rejects.toMatchObject({code:'payment_method_withheld',kind:'conflict'});
 for(const holdAt of ['2040-01-02T00:00:00Z','2040-01-03T00:00:00Z'])expect(await held({}, {holdAt}).run()).toEqual(result);
 expect(await held({}, {offered:['primary']}).run()).toEqual(result);
 expect(await held({}, {method:'secondary'}).run()).toEqual(result);
});
it.each([{recreatedFromOrderId:'parent'},{recoveryRootOrderId:'other'},{subscriptionCycleId:'cycle'}])('bypasses holds for a recovery chain or renewal %j',async patch=>{
 const f=held(patch,{first:true});expect(await f.run()).toEqual(result);expect(f.lookup).not.toHaveBeenCalled();
});
it('allows unknown/read failures and previously live subscriptions, but holds a proven initial declaration',async()=>{
 const initial={mode:'subscription_cycle' as const,initialDeclarationId:'initial',initialActivationState:'provisional'};
 for(const options of [{first:null},{first:false},{firstThrows:true},{first:true,readThrows:true}])expect(await held(initial,options).run()).toEqual(result);
 expect(await held({subscriptionId:'live',mode:'subscription_cycle'},{first:false}).run()).toEqual(result);
 await expect(held(initial,{first:true}).run()).rejects.toMatchObject({code:'payment_method_withheld'});
});
