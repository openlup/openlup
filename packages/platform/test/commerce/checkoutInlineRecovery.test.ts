import { expect, it, vi } from 'vitest';
import { createCheckoutInlineRecovery, checkoutInlineRecoveryTransitionKey } from '../../src/commerce/server/checkoutInlineRecovery.js';
import { createCheckoutPaymentContinuationCodec } from '../../src/commerce/server/checkoutPaymentContinuationCredential.js';
import type { NativeCheckoutRecoveryOrder } from '../../src/commerce/server/checkoutRecoveryInspection.js';
import type { PaymentRecoverySnapshot } from '../../src/commerce/server/paymentRecoveryGuidance.js';
const id={orderId:'11111111-1111-4111-8111-111111111111',clientId:'22222222-2222-4222-8222-222222222222',paymentIntentId:'33333333-3333-4333-8333-333333333333',paymentAttemptId:'44444444-4444-4444-8444-444444444444',retryRequestId:'55555555-5555-4555-8555-555555555555',next:'66666666-6666-4666-8666-666666666666'};
const journeyId='checkout:77777777-7777-4777-8777-777777777777';
function fixture(){
 const codec=createCheckoutPaymentContinuationCodec('synthetic-inline-cookie-signing-material',{cookieName:'configured-continuation',executionRails:['sandbox','external']})!;
 const order:NativeCheckoutRecoveryOrder={orderId:id.orderId,clientId:id.clientId,orderRef:'order_example',orderNumber:'1',status:'pending_payment',mode:'one_time_order',totalMinor:100,currency:'XXX',cadenceDays:null,createdAt:'2026-11-10T00:00:00Z',customerEmail:null,customerName:null,paymentIntentId:id.paymentIntentId,paymentIntentStatus:'failed',subscriptionId:null,subscriptionCycleId:null,initialDeclarationId:null,initialActivationState:null};
 const snapshot:PaymentRecoverySnapshot={orderId:id.orderId,clientId:id.clientId,paymentIntentId:id.paymentIntentId,paymentAttemptId:id.paymentAttemptId,orderStatus:'pending_payment',intentStatus:'failed',attemptStatus:'failed',provider:'sandbox',providerPaymentId:null,updatedAt:'2026-11-10T00:00:00Z',failureReason:'declined',subscriptionActivationStatus:'not_applicable',subscriptionId:null,subscriptionStatus:null,eligible:true,purchaseContext:'one_time',tokenAuthorized:false,historyComplete:true,observedSuccess:false,attempts:[{id:id.paymentAttemptId,status:'failed',evidence:{refusalVerified:true,cause:'generic_decline',certainty:'unknown',disclosure:'safe',advice:null,method:null,operation:null}}]};
 const request={headers:{cookie:codec.issue({orderId:id.orderId,clientId:id.clientId,paymentIntentId:id.paymentIntentId,paymentAttemptId:id.paymentAttemptId,journeyId,executionRail:'sandbox'}).setCookie,authorization:'Bearer ignored'},orderId:id.orderId,clientId:id.clientId,paymentIntentId:id.paymentIntentId,journeyId,expectedPaymentAttemptId:id.paymentAttemptId,retryRequestId:id.retryRequestId,executionRail:'sandbox',methodKey:'secondary',method:{transientCode:'example'}};
 const getGuidanceSnapshot=vi.fn(async()=>snapshot),getRecoveryOrder=vi.fn(async()=>order),readPreviousMethod=vi.fn(async()=>'primary');
 const begin=vi.fn(async()=>({orderId:id.orderId,clientId:id.clientId,paymentIntentId:id.paymentIntentId,paymentAttemptId:id.next,status:'processing' as const,replayed:false,failureReason:null,executionRail:'sandbox'}));
 const readActiveAction=vi.fn(async():Promise<{kind:string}|null>=>null),executionAllowed=vi.fn(()=>true);
 const deps={codec,guidance:{port:{getGuidanceSnapshot}},orderPort:{getRecoveryOrder},attemptPort:{assertExecutionRail:()=>{},readPreviousMethod,begin},executionAllowed,activeActionResolver:{readActiveAction}};
 return{codec,order,snapshot,request,getGuidanceSnapshot,getRecoveryOrder,readPreviousMethod,begin,readActiveAction,executionAllowed,deps,retry:()=>createCheckoutInlineRecovery(deps).retry(request)};
}
it('keeps the exact transition dialect and rotates the cookie to the returned attempt',async()=>{
 const f=fixture();expect(checkoutInlineRecoveryTransitionKey(id.paymentAttemptId)).toBe(`checkout-inline-recovery:${id.paymentAttemptId}`);
 const value=await f.retry();expect(value.result).toMatchObject({status:'processing',clientAction:{kind:'none'}});
 expect(f.codec.verifyCookieHeader(value.setCookie)).toMatchObject({paymentAttemptId:id.next,orderId:id.orderId,paymentIntentId:id.paymentIntentId,clientId:id.clientId,journeyId,executionRail:'sandbox'});
 expect(f.begin).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({request:expect.not.objectContaining({headers:expect.anything()}),admission:{replayOnly:false,purchaseContext:'one_time',previousMethodKey:'primary',actions:['change_instrument','change_method'],restriction:null}}));
});
it.each(['missing','mismatch'])('refuses %s authority before reads even with a bearer',async kind=>{
 const f=fixture();if(kind==='missing')f.request.headers.cookie='';else f.request.clientId=id.next;
 await expect(f.retry()).rejects.toMatchObject({kind:'unauthorized'});expect(f.getGuidanceSnapshot).not.toHaveBeenCalled();expect(f.getRecoveryOrder).not.toHaveBeenCalled();expect(f.begin).not.toHaveBeenCalled();
});
it.each(['paid','renewal','ineligible','observed_success','previously_live'])('refuses %s state without admission or cookie rotation',async kind=>{
 const f=fixture();if(kind==='paid')f.snapshot.orderStatus='paid';if(kind==='renewal')f.order.subscriptionCycleId=id.next;if(kind==='ineligible')f.snapshot.eligible=false;if(kind==='observed_success')f.snapshot.observedSuccess=true;if(kind==='previously_live')f.snapshot.subscriptionStatus='active';
 const issue=vi.spyOn(f.codec,'issue');await expect(f.retry()).rejects.toMatchObject({kind:'conflict'});expect(f.begin).not.toHaveBeenCalled();expect(issue).not.toHaveBeenCalled();
});
it('uses only durable replacement proof for replay, bypassing new execution and hold policy',async()=>{
 const f=fixture();f.snapshot.paymentAttemptId=id.next;f.snapshot.attemptStatus='processing';f.snapshot.intentStatus='processing';
 f.begin.mockResolvedValue({...await f.begin(),replayed:true});f.begin.mockClear();
 f.deps.executionAllowed=()=>{throw Error('must_not_check_new_execution');};
 const value=await createCheckoutInlineRecovery({...f.deps,hold:{classify:()=>{throw Error('must_not_check_new_hold');},readHolds:async()=>[],offeredMethods:()=>new Set()}}).retry(f.request);
 expect(value.result.replayed).toBe(true);expect(f.readPreviousMethod).not.toHaveBeenCalled();expect(f.begin).toHaveBeenCalledWith(expect.objectContaining({admission:expect.objectContaining({replayOnly:true})}));
});
it('preserves action readback and retains safe polling on a read failure',async()=>{
 const f=fixture();f.readActiveAction.mockResolvedValueOnce({kind:'redirect'});expect((await f.retry()).result.clientAction).toEqual({kind:'redirect'});
 f.readActiveAction.mockRejectedValueOnce(Error('lagging'));expect((await f.retry()).result.clientAction).toEqual({kind:'none'});
});
it('refuses forged fresh results and leaves admission failures without a replacement cookie',async()=>{
 const f=fixture(),issue=vi.spyOn(f.codec,'issue');f.begin.mockResolvedValue({...await f.begin(),orderId:id.next});
 await expect(f.retry()).rejects.toMatchObject({kind:'upstream_unavailable',code:'invalid_payment_result'});expect(issue).not.toHaveBeenCalled();
 f.begin.mockRejectedValue(Error('checkout_inline_retry_refused'));await expect(f.retry()).rejects.toMatchObject({kind:'conflict'});expect(issue).not.toHaveBeenCalled();
});
