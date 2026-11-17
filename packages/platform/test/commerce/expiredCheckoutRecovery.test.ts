import { z } from 'zod';
import { createCheckoutCommandSchemas } from '../../src/commerce/checkoutCommandSchemas.js';
import { createConfiguratorIntentSchemas } from '../../src/commerce/configuratorIntentSchemas.js';
import { createCheckoutResponseSchemas } from '../../src/commerce/checkoutSchemas.js';
import { createCheckoutResumeSchemas } from '../../src/commerce/checkoutResumeSchemas.js';
import { createCommerceQuoteSchemas } from '../../src/pricing/quoteSchemas.js';
import { expect,it,vi } from 'vitest';
import { createExpiredCheckoutRecoveryService,ExpiredCheckoutRecoveryError,parseRecoveryRecreationQuote } from '../../src/commerce/server/expiredCheckoutRecovery.js';
import { createPostgresNativeCheckoutPersistence } from '../../src/commerce/server/native-checkout/index.js';
import { createPostgresCheckoutRecoveryOrderPort } from '../../src/commerce/server/postgresCheckoutRecoveryOrderPort.js';
import { checkoutRecoveryExecutionFingerprint } from '../../src/commerce/server/nativeExpiredCheckoutRecovery.js';
import type { NativeCheckoutRecoveryOrder } from '../../src/commerce/server/checkoutRecoveryInspection.js';
const money=(amountMinor:number)=>({amountMinor,currency:'XXX'});
function quote(){return{contractVersion:'commerce.v0' as const,quote:{currency:'XXX',taxIncluded:true as const,
 lines:[{sku:'EXAMPLE',productSlug:'example',quantity:1,unitPriceGross:money(100),lineSubtotalGross:money(100),tax:{included:true as const,country:'ZZ',category:'standard',vatRateBps:0,legalBasis:'Synthetic',netAmount:money(100),vatAmount:money(0),grossAmount:money(100)}}],discounts:[],
 context:{mode:'subscription' as const,cadenceDays:28,promoCodes:[],pricingPolicy:{version:1},offerVersion:{id:'frozen'},offerEvidence:{id:'frozen'}},
 subtotalGross:money(100),discountTotalGross:money(0),shippingGross:money(0),shippingDiscountGross:money(0),totalGross:money(100),netTotal:money(100),taxTotal:money(0)}};}
function fixture(){
 const events:string[]=[],order:NativeCheckoutRecoveryOrder={orderId:'source',orderRef:'order_source',orderNumber:'source',clientId:'client',status:'cancelled',mode:'subscription_cycle',totalMinor:100,currency:'XXX',createdAt:'2026-11-01T00:00:00Z',cadenceDays:28,customerEmail:null,customerName:null,paymentIntentId:'intent',paymentIntentStatus:'failed',subscriptionId:null,subscriptionCycleId:null,shippingAddressId:'destination',quoteSnapshot:quote(),technicallyExpired:false,initialDeclarationId:'declaration',initialActivationState:'compensated'};
 const deps={supports:vi.fn(()=>true),quoteRequest:vi.fn(()=>({opaque:'adopter'})),
 quotePort:{createQuote:vi.fn(async()=>{events.push('quote');return quote();})},
 orderDraftPort:{createOrderDraft:vi.fn(async()=>{events.push('draft');return{orderDraft:{orderId:'order_replacement'}};})},
 paymentSafetyPort:{verifyPriorPayment:vi.fn(async():Promise<'safe'|'paid'|'unavailable'>=>{events.push('safety');return'safe';})},
 recoveryPort:{prepareReplacement:vi.fn(async()=>{events.push('prepare');return{replacementOrderId:'replacement',replayed:false};})},
 runtimePort:{startRuntime:vi.fn(async()=>{events.push('runtime');return{status:'processing'};})},
 compensationPort:{cancelAbandonedOrder:vi.fn(async()=>{events.push('abandon');}),cancelUnstartedPromotionOrder:vi.fn(async()=>{events.push('unstarted');})}};
 const service=createExpiredCheckoutRecoveryService(deps);return{deps,order,events,service,recreate:()=>service.recreate({order,clientId:order.clientId})};
}
it('keeps the reference safety, frozen quote, draft, lineage and runtime order',async()=>{
 const f=fixture();expect(await f.recreate()).toEqual({status:'processing'});expect(f.events).toEqual(['safety','quote','draft','prepare','runtime']);
 expect(f.deps.quotePort.createQuote).toHaveBeenCalledWith({opaque:'adopter'},{clientId:'client',pricingPolicy:{version:1},offerVersion:{id:'frozen'}});
 expect(f.deps.orderDraftPort.createOrderDraft).toHaveBeenCalledWith({idempotencyKey:'checkout-recovery-recreate:source',quoteSnapshot:quote()},{clientId:'client'});
 expect(f.deps.runtimePort.startRuntime).toHaveBeenCalledWith(expect.objectContaining({source:f.order,clientId:'client',idempotencyKey:'checkout-recovery-recreate:source'}));
});
it('retains frozen offer evidence while excluding transient quote identity from the comparison',async()=>{
 const f=fixture(),fresh=quote();fresh.quote.context.offerVersion={id:'current'};fresh.quote.context.offerEvidence={id:'current'};
 Object.assign(fresh.quote,{quoteId:'new-transient-id',quotedAt:'2040-01-01'});f.deps.quotePort.createQuote.mockResolvedValue(fresh);
 await f.recreate();expect(f.deps.orderDraftPort.createOrderDraft.mock.calls[0][0].quoteSnapshot.quote.context).toMatchObject({offerVersion:{id:'frozen'},offerEvidence:{id:'frozen'}});
});
it.each(['paid','unavailable'] as const)('refuses %s provider evidence before quote or writes',async result=>{
 const f=fixture();f.deps.paymentSafetyPort.verifyPriorPayment.mockResolvedValue(result);await expect(f.recreate()).rejects.toMatchObject({reason:result});expect(f.deps.paymentSafetyPort.verifyPriorPayment).toHaveBeenCalledOnce();expect(f.deps.quotePort.createQuote).not.toHaveBeenCalled();
});
it.each([null,{broken:true}])('refuses missing or malformed frozen quote before provider reads',async snapshot=>{
 const f=fixture();f.order.quoteSnapshot=snapshot;await expect(f.recreate()).rejects.toMatchObject({reason:'unavailable'});expect(f.events).toEqual([]);
});
it('requires shipping ownership and rejects renewal even under one-time presentation',async()=>{
 for(const patch of[{shippingAddressId:null},{subscriptionCycleId:'cycle',mode:'one_time_order' as const},{clientId:'foreign'}]){
 const f=fixture();Object.assign(f.order,patch);await expect(f.service.recreate({order:f.order,clientId:'client'})).rejects.toMatchObject({reason:'unavailable'});expect(f.events).toEqual([]);}
});
it('applies the same adopter fence to validate=false and recreate=unavailable before any side effect',async()=>{
 const f=fixture();f.deps.supports.mockReturnValue(false);expect(await f.service.validate(f.order)).toBe(false);await expect(f.recreate()).rejects.toMatchObject({reason:'unavailable'});expect(f.events).toEqual([]);expect(f.deps.quoteRequest).not.toHaveBeenCalled();
});
it('validates commercial drift as false and recreates it as order_changed before drafts',async()=>{
 const f=fixture(),fresh=quote();fresh.quote.context.cadenceDays=29;f.deps.quotePort.createQuote.mockResolvedValue(fresh);
 expect(await f.service.validate(f.order)).toBe(false);await expect(f.recreate()).rejects.toMatchObject({reason:'order_changed'});expect(f.deps.orderDraftPort.createOrderDraft).not.toHaveBeenCalled();
});
it('cleans only an unstarted draft if preparation fails',async()=>{
 const f=fixture();f.deps.recoveryPort.prepareReplacement.mockRejectedValue(new ExpiredCheckoutRecoveryError('unavailable'));
 await expect(f.recreate()).rejects.toMatchObject({reason:'unavailable'});expect(f.events).toEqual(['safety','quote','draft','unstarted']);
});
it('runs both reference cleanup stages after runtime failure even if the first cleanup fails',async()=>{
 const f=fixture();f.deps.runtimePort.startRuntime.mockRejectedValue(new Error('failed'));
 f.deps.compensationPort.cancelAbandonedOrder.mockImplementation(async()=>{f.events.push('abandon');throw new Error('cleanup_failed');});
 await expect(f.recreate()).rejects.toMatchObject({reason:'execution_failed'});expect(f.events).toEqual(['safety','quote','draft','prepare','abandon','unstarted']);
});
it('keeps the existing real-provider persistence refusal named',async()=>{
 const f=fixture();f.deps.paymentSafetyPort.verifyPriorPayment.mockRejectedValue(new Error('native_prepared_attempt_store_unsupported'));
 await expect(f.recreate()).rejects.toMatchObject({reason:'unavailable',code:'native_prepared_attempt_store_unsupported'});expect(f.deps.orderDraftPort.createOrderDraft).not.toHaveBeenCalled();
});

it('compares nested commercial JSON values consistently across persisted object key ordering',async()=>{
 const f=fixture(),frozen=quote(),fresh=quote();
 Object.assign(frozen.quote.context,{sizeConstraint:{minimum:1,maximum:10}});
 Object.assign(fresh.quote.context,{sizeConstraint:{maximum:10,minimum:1}});
 f.order.quoteSnapshot=frozen;f.deps.quotePort.createQuote.mockResolvedValue(fresh);
 expect(await f.service.validate(f.order)).toBe(true);expect(await f.recreate()).toEqual({status:'processing'});
});

it('binds execution identity to its four stable fields independently of object key order or extra quote identity',()=>{
 const input={idempotencyKey:'key',settlementIntentId:'intent',orderId:'order',clientId:'client'};
 expect(checkoutRecoveryExecutionFingerprint(input)).toBe(checkoutRecoveryExecutionFingerprint({clientId:'client',orderId:'order',settlementIntentId:'intent',idempotencyKey:'key',quoteId:'transient'} as typeof input));
 expect(checkoutRecoveryExecutionFingerprint({...input,clientId:'other'})).not.toBe(checkoutRecoveryExecutionFingerprint(input));
});

it('bounds checkout DTO cadences to executable whole-day dates',()=>{
 const text=z.string();
 const {checkoutCommandV1Schema}=createCheckoutCommandSchemas({sku:text,paymentIntentStatus:text,paymentAttemptStatus:text});
 const {configuratorIntentCoreSchema}=createConfiguratorIntentSchemas(text);
 const {createQuoteRequestSchema}=createCommerceQuoteSchemas({currencySchema:text,productSlugSchema:text,contextSchema:z.unknown()});
 const {checkoutResumeDraftStateSchema}=createCheckoutResumeSchemas({sectionSchema:text,redactedFieldSchema:text,completionSchema:z.object({}),productSlugSchema:text,skuSchema:text});
 const {checkoutResponseSchema}=createCheckoutResponseSchemas({quoteSchema:z.unknown(),quoteExpectationSchema:z.unknown(),clientActionSchema:z.unknown(),paymentIntentStatusSchema:text,paymentAttemptStatusSchema:text,failureDisplaySchema:z.unknown()});
 const cadenceSchemas=[checkoutCommandV1Schema.shape.cadenceDays,configuratorIntentCoreSchema.shape.cadenceDays,
  createQuoteRequestSchema.shape.cadenceDays,checkoutResumeDraftStateSchema.shape.cadenceDays,
  checkoutResponseSchema.options[0].shape.subscription.unwrap().shape.cadenceDays];
 for(const schema of cadenceSchemas){
  for(const days of [1,121,180,365,3660])expect(schema.parse(days)).toBe(days);
  for(const days of [0,-1,1.5,NaN,Infinity,3661,2_147_483_647])expect(schema.safeParse(days).success).toBe(false);
 }
});
it('recreates a checkout with an adopter cadence above 120 without changing its retained terms',async()=>{
 const f=fixture(),frozen=quote();frozen.quote.context.cadenceDays=180;f.order.cadenceDays=180;f.order.quoteSnapshot=frozen;
 f.deps.quotePort.createQuote.mockResolvedValue(structuredClone(frozen));
 expect(await f.service.validate(f.order)).toBe(true);expect(await f.recreate()).toEqual({status:'processing'});
 expect(f.deps.orderDraftPort.createOrderDraft.mock.calls[0][0].quoteSnapshot.quote.context.cadenceDays).toBe(180);
});

it.each([0,1,3660,3661])('bounds native checkout and recovery quote contexts at %i days',async days=>{
 const snapshot=quote();snapshot.quote.context.cadenceDays=days;
 const accepted=days>=1&&days<=3660;
 expect(parseRecoveryRecreationQuote(snapshot)!==null).toBe(accepted);
 const response={contractVersion:'commerce.v0',orderDraft:{orderId:'order_11111111-1111-4111-8111-111111111111',
  status:'draft',paymentStatus:'not_started',idempotencyKey:'cadence-boundary',quoteSnapshot:snapshot,replayed:false}};
 const query=vi.fn(async()=>({rows:[{response}]})),port=createPostgresNativeCheckoutPersistence({query});
 const result=port.createOrderDraft({idempotencyKey:'cadence-boundary',quoteSnapshot:snapshot});
 if(accepted){await expect(result).resolves.toEqual(response);expect(query).toHaveBeenCalledOnce();}
 else{await expect(result).rejects.toThrow();expect(query).not.toHaveBeenCalled();}
 // Response parsing independently refuses a stored context above the bound.
 const valid=quote();valid.quote.context.cadenceDays=1;
 const readback=port.createOrderDraft({idempotencyKey:'cadence-boundary',quoteSnapshot:valid});
 if(accepted)await expect(readback).resolves.toEqual(response);
 else await expect(readback).rejects.toThrow('Commerce order draft returned invalid response');
});

it.each([0,1,3660,3661])('bounds recovery order snapshots at %i days',async cadenceDays=>{
 const id='11111111-1111-4111-8111-111111111111';
 const snapshot={...fixture().order,orderId:id,orderRef:`order_${id}`,clientId:id,paymentIntentId:id,shippingAddressId:id,
  initialDeclarationId:id,cadenceDays,runtimeMetadata:{},invoiceBuyerSnapshot:{},recoveryRootOrderId:id,recreatedFromOrderId:null};
 const port=createPostgresCheckoutRecoveryOrderPort({query:async()=>({rows:[{result:snapshot}]})});
 for(const read of [port.getRecoveryOrder,port.getLatestRecoveryOrder!]){
  const result=read({orderId:id});
  if(cadenceDays>=1&&cadenceDays<=3660)await expect(result).resolves.toMatchObject({cadenceDays});
  else await expect(result).rejects.toThrow('checkout_recovery_snapshot_invalid');
 }
});
