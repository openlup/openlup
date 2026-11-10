import { expect, it, vi } from 'vitest';
import { createCheckoutRecoveryInspection, createCheckoutRecoveryValidationPolicy, type NativeCheckoutRecoveryOrder } from '../../src/commerce/server/checkoutRecoveryInspection.js';
import type { CheckoutRecoveryTokenInspection } from '../../src/commerce/server/checkoutRecoveryToken.js';
const now = new Date('2040-01-02T12:00:00Z');
function order(patch: Partial<NativeCheckoutRecoveryOrder> = {}): NativeCheckoutRecoveryOrder {
  return { orderId:'original',orderRef:'order_original',orderNumber:'original',clientId:'client',status:'expired',mode:'one_time_order',totalMinor:100,currency:'XXX',createdAt:'2040-01-01T12:00:00Z',cadenceDays:null,customerEmail:null,customerName:null,paymentIntentId:null,paymentIntentStatus:null,subscriptionId:null,subscriptionCycleId:null,shippingAddressId:'destination',quoteSnapshot:{frozen:true},technicallyExpired:true,initialDeclarationId:null,initialActivationState:null,...patch };
}
function fixture(patch: Partial<NativeCheckoutRecoveryOrder> = {}, tokenState='expired') {
  let snapshot: NativeCheckoutRecoveryOrder | null=order(patch);
  const inspection:CheckoutRecoveryTokenInspection={tokenId:'token',orderId:'original',clientId:'client',status:patch.status??'expired',mode:'one_time_order',subscriptionId:null,tokenState};
  const validate=vi.fn(async()=>true),latest=vi.fn(async()=>snapshot),original=vi.fn(async()=>snapshot);
  const tokenValidate=vi.fn(async()=>tokenState==='active'?{...inspection,mode:'one_time_order',status:'pending_payment'}:null);
  const paymentResolver={resolve:vi.fn(async()=>({kind:'awaiting_provider'} as const))};
  const deps={tokenPort:{validate:tokenValidate,inspect:vi.fn(async()=>inspection)},orderPort:{getRecoveryOrder:original,getLatestRecoveryOrder:latest},validation:{validate},clientHasLiveOrPendingSubscription:vi.fn(async()=>false),paymentResolver,now:()=>now};
  return{deps,validate,latest,original,inspection,paymentResolver,change:(value:NativeCheckoutRecoveryOrder|null)=>{snapshot=value;},inspect:(capabilities:readonly string[]=['recreate_expired_order'])=>createCheckoutRecoveryInspection(deps).inspect({token:'raw',capabilities})};
}
it('advertises expired recreation only after capable validation, without minting or paying',async()=>{
 const f=fixture();expect(await f.inspect()).toMatchObject({recoverable:true,recoveryKind:'recreate_expired',order:{paymentIntentId:null}});expect(f.validate).toHaveBeenCalledOnce();expect(f.paymentResolver.resolve).not.toHaveBeenCalled();
 expect(await f.inspect([])).toEqual({recoverable:false,fallback:'fresh_checkout'});
});
it.each(['revoked','used','unknown','order_not_found'])('refuses %s authority before order reads and validation',async state=>{
 const f=fixture({},state);expect(await f.inspect()).toEqual({recoverable:false,fallback:'fresh_checkout'});expect(f.latest).not.toHaveBeenCalled();expect(f.validate).not.toHaveBeenCalled();
});
it('follows a pending descendant only with continuation authority, never expired inspection authority',async()=>{
 const patch={orderId:'latest',paymentIntentId:'intent',status:'pending_payment',technicallyExpired:false};
 const f=fixture(patch,'order_not_recoverable');expect(await f.inspect()).toMatchObject({recoverable:true,recoveryKind:'retry_existing',order:{orderId:'latest'}});expect(f.validate).not.toHaveBeenCalled();
 const dead=fixture(patch);expect(await dead.inspect()).toEqual({recoverable:false,fallback:'fresh_checkout'});expect(dead.validate).not.toHaveBeenCalled();
});
it('binds original/latest ownership and refuses renewal orders',async()=>{
 for(const patch of[{clientId:'stranger'},{subscriptionCycleId:'renewal'}]){
  const f=fixture(patch);expect(await f.inspect()).toMatchObject({recoverable:false});expect(f.validate).not.toHaveBeenCalled();
  const active=fixture({...patch,status:'pending_payment',paymentIntentId:'intent',technicallyExpired:false},'active');expect(await active.inspect()).toMatchObject({recoverable:false});expect(active.paymentResolver.resolve).not.toHaveBeenCalled();
 }
});
it('shows paid and manual-cancelled terminal states without another payment',async()=>{
 const paid=fixture({status:'paid',technicallyExpired:false});expect(await paid.inspect()).toMatchObject({recoverable:false,terminalStatus:'paid',paidOrder:{orderId:'original',clientId:'client'}});expect(paid.validate).not.toHaveBeenCalled();
 expect(await fixture({status:'cancelled',technicallyExpired:false}).inspect()).toMatchObject({recoverable:false,terminalStatus:'cancelled'});
});
it('refuses noncanonical pending technical expiry and revocation racing active validation',async()=>{
 const f=fixture({status:'pending_payment',paymentIntentId:'intent'},'active');expect(await f.inspect()).toMatchObject({recoverable:false,terminalStatus:'order_changed'});expect(f.validate).not.toHaveBeenCalled();
 f.deps.tokenPort.inspect.mockResolvedValue({...f.inspection,tokenState:'revoked'});expect(await f.inspect()).toMatchObject({recoverable:false});expect(f.latest).toHaveBeenCalledOnce();
});
it('requires the latest native compensated initial declaration, with no inherited predecessor marker',async()=>{
 const initial={status:'cancelled',mode:'subscription_cycle',initialDeclarationId:'declaration',initialActivationState:'compensated'} as const;
 const f=fixture(initial);expect(await f.inspect()).toMatchObject({recoverable:true,recoveryKind:'recreate_expired',order:{mode:'subscription_cycle'}});
 for(const patch of[{initialDeclarationId:null},{initialActivationState:'provisional'},{quoteSnapshot:null},{shippingAddressId:null},{createdAt:'2039-01-01T00:00:00Z'}]){
  const denied=fixture({...initial,...patch});expect(await denied.inspect()).toMatchObject({recoverable:false});expect(denied.validate).not.toHaveBeenCalled();
 }
});
it('keeps account fallback for subscription context and a changed-content refusal',async()=>{
 const f=fixture();f.deps.clientHasLiveOrPendingSubscription.mockResolvedValue(true);f.validate.mockResolvedValue(false);
 expect(await f.inspect()).toEqual({recoverable:false,fallback:'customer_account',terminalStatus:'order_changed'});
});
it('gates payment resolution separately and suppresses controls when the resolver observes paid',async()=>{
 const f=fixture({status:'pending_payment',paymentIntentId:'intent',technicallyExpired:false},'active');expect(await f.inspect([])).not.toHaveProperty('paymentResolution');
 expect(await f.inspect(['resolve_active_payment'])).toMatchObject({paymentResolution:{kind:'awaiting_provider'}});
 const deps={...f.deps,paymentResolver:{resolve:vi.fn(async()=>({kind:'paid'} as const))}};
 expect(await createCheckoutRecoveryInspection(deps).inspect({token:'raw',capabilities:['resolve_active_payment']})).toEqual({recoverable:false,fallback:'fresh_checkout',terminalStatus:'paid'});
 expect(await createCheckoutRecoveryInspection({...f.deps,paymentResolver:undefined}).inspect({token:'raw',capabilities:['resolve_active_payment']})).toHaveProperty('paymentResolution.kind','awaiting_provider');
});
it('applies the adopter content-loss fence before quote/draft/provider validation and propagates ordinary validation',async()=>{
 const validate=vi.fn(async()=>true),policy=createCheckoutRecoveryValidationPolicy<NativeCheckoutRecoveryOrder>({supports:o=>(o.quoteSnapshot as {unsupported?:boolean})?.unsupported!==true,validation:{validate}});
 expect(await policy.validate(order({quoteSnapshot:{unsupported:true}}))).toBe(false);expect(validate).not.toHaveBeenCalled();
 expect(await policy.validate(order())).toBe(true);expect(validate).toHaveBeenCalledOnce();
});

it('binds the original client before a matching-client latest descendant can be considered',async()=>{
 const f=fixture();f.original.mockResolvedValue(order({clientId:'other'}));expect(await f.inspect()).toMatchObject({recoverable:false});expect(f.latest).not.toHaveBeenCalled();expect(f.validate).not.toHaveBeenCalled();
});

it.each(['one_time_order','subscription_cycle'] as const)('keeps the recovery-window refusal before manual cancellation (%s)',async mode=>{
 const f=fixture({mode,status:'cancelled',technicallyExpired:false,createdAt:'2039-01-01T12:00:00Z'});f.inspection.mode=mode;
 expect(await f.inspect()).toEqual({recoverable:false,fallback:mode==='one_time_order'?'fresh_checkout':'customer_account'});expect(f.validate).not.toHaveBeenCalled();
});
