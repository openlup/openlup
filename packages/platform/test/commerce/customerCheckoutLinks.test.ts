import{describe,expect,it,vi}from'vitest';
import{createCheckoutRecoveryStartHandler,createCheckoutPaymentLinkHandler,createPostgresCustomerCheckoutRecoveryStartPort,createPostgresBuyerCheckoutLinkPort,
 CheckoutLinkNotRecoverableError,createCheckoutPaymentContinuationCodec}from'../../src/commerce/server/index.js';
import type{CustomerCheckoutRecoveryPendingOrder,CustomerCheckoutRecoveryStartPort}from'../../src/commerce/server/index.js';
import{checkoutRecoveryStartRequestSchema}from'../../src/commerce/schemas.js';
const id='11111111-1111-4111-8111-111111111111',sub='22222222-2222-4222-8222-222222222222',client='33333333-3333-4333-8333-333333333333';
const DAY=86400000,NOW='2040-01-02T12:00:00.000Z';
const pending:CustomerCheckoutRecoveryPendingOrder={orderId:id,mode:'one_time_order',createdAt:NOW,subscriptionId:null,clientHasLiveOrPendingSubscription:false};
function response(){const result:{code?:string;data?:unknown;details?:unknown;methods?:readonly string[]}={};return{result,respond:{sendMethodNotAllowed:(_:null,methods:readonly string[])=>{result.methods=methods;},sendBffError:(_:null,code:string,__:string,o?:{details:unknown})=>{result.code=code;result.details=o?.details;},sendBffSuccess:(_:null,data:unknown)=>{result.data=data;}}};}
function setup(options:{enabled?:boolean;auth?:boolean;order?:CustomerCheckoutRecoveryPendingOrder|null;context?:Partial<CustomerCheckoutRecoveryPendingOrder>;fail?:Error}={}){
 const r=response(),issue=vi.fn(async()=>{if(options.fail)throw options.fail;return'token-row';}),find=vi.fn(async()=>options.order===undefined?pending:options.order),context=vi.fn(async()=>({...pending,...options.context}));
 const port:CustomerCheckoutRecoveryStartPort={find,context,issue},bind=vi.fn(()=>port),auth=vi.fn(async()=>options.auth===false?{ok:false as const}:{ok:true as const,userId:'session-principal'});
 const handler=createCheckoutRecoveryStartHandler({recoveryEnabled:()=>options.enabled!==false,authenticateUser:auth,createPort:bind,respond:r.respond,lifetimeMs:DAY,now:()=>new Date(NOW),generateToken:()=> 'rcv_navigation'});
 return{...r,handler,issue,find,context,bind,auth};
}
describe('signed-in checkout start reference characterization',()=>{
 it.each(['method','disabled','invalid','unauthenticated'])('guards %s before constructing clients',async state=>{
  const x=setup({enabled:state!=='disabled',auth:state!=='unauthenticated'});await x.handler({method:state==='method'?'GET':'POST',body:state==='invalid'?{}:{orderId:id}},null);
  expect(x.bind).not.toHaveBeenCalled();expect(x.result).toMatchObject(state==='method'?{methods:['POST']}:{code:state==='disabled'?'UPSTREAM_UNAVAILABLE':state==='invalid'?'BAD_REQUEST':'UNAUTHORIZED'});
  if(state==='disabled')expect(x.auth).not.toHaveBeenCalled();
 });
 it.each([{orderId:id},{subscriptionId:sub}])('selects the requested owned context %j and returns the raw token without mail',async body=>{
  const x=setup();await x.handler({method:'POST',body},null);expect(x.bind).toHaveBeenCalledWith({userId:'session-principal'});
  expect(x.find).toHaveBeenCalledWith(body);expect(x.issue).toHaveBeenCalledWith({orderId:id,rawToken:'rcv_navigation',expiresAt:'2040-01-03T12:00:00.000Z'});
  expect(x.result.data).toEqual({contractVersion:'commerce.checkout-recovery.v1',recoverable:true,token:'rcv_navigation',mode:'one_time_order'});
 });
 it.each([{}, {orderId:id,subscriptionId:sub},{orderId:'bad'},{orderId:id,userId:sub}])('rejects ambiguous or identity-bearing requests %j',body=>expect(checkoutRecoveryStartRequestSchema.safeParse(body).success).toBe(false));
 it.each([
  [{orderId:id},{mode:'one_time_order' as const},'fresh_checkout'],
  [{orderId:id},{mode:'subscription_cycle' as const},'customer_account'],
  [{orderId:id},{clientHasLiveOrPendingSubscription:true},'customer_account'],
  [{subscriptionId:sub},{},'customer_account'],
 ] as const)('maps missing context %j to the existing fallback',async(body,context,fallback)=>{
  const x=setup({order:null,context});await x.handler({method:'POST',body},null);expect(x.result.data).toEqual({contractVersion:'commerce.checkout-recovery.v1',recoverable:false,fallback});expect(x.issue).not.toHaveBeenCalled();
 });
 it('maps terminal mint races to fallback but propagates unexpected start failures',async()=>{
  const x=setup({fail:new CheckoutLinkNotRecoverableError()});await x.handler({method:'POST',body:{orderId:id}},null);expect(x.result.data).toMatchObject({recoverable:false,fallback:'fresh_checkout'});
  const broken=setup({fail:new Error('storage unavailable')});await expect(broken.handler({method:'POST',body:{orderId:id}},null)).rejects.toThrow('storage unavailable');expect(broken.result.data).toBeUndefined();
 });
});
describe('buyer checkout link reference characterization',()=>{
 const codec=createCheckoutPaymentContinuationCodec('x'.repeat(40),{cookieName:'continuation',executionRails:['captured','redirect'],now:()=>new Date(NOW)})!;
 const cookie=()=>codec.issue({journeyId:`checkout:${id}`,orderId:id,clientId:client,paymentAttemptId:id,paymentIntentId:id,executionRail:'captured'}).setCookie.split(';')[0];
 it.each(['absent','invalid','no-codec','method'])('refuses %s before constructing persistence',async kind=>{
  const r=response(),bind=vi.fn();await createCheckoutPaymentLinkHandler({codec:kind==='no-codec'?null:codec,createPort:bind,respond:r.respond})({method:kind==='method'?'GET':'POST',headers:{cookie:kind==='absent'?undefined:kind==='invalid'?'continuation=bad':cookie()}},null);
  expect(bind).not.toHaveBeenCalled();expect(r.result).toMatchObject(kind==='method'?{methods:['POST']}:{code:'UNAUTHORIZED'});
 });
 it('uses only signed claims, ignores body authority and returns the existing sent acknowledgement',async()=>{
  const r=response(),issue=vi.fn(async()=>({sent:true as const,queued:false}));await createCheckoutPaymentLinkHandler({codec,createPort:()=>({issue}),respond:r.respond,now:()=>new Date(NOW),generateToken:()=> 'rcv_buyer'})({method:'POST',headers:{cookie:cookie()},body:{orderId:sub,clientId:sub,email:'ignore@example.invalid'}},null);
  expect(issue).toHaveBeenCalledExactlyOnceWith({orderId:id,clientId:client,rawToken:'rcv_buyer',requestedAt:NOW});expect(r.result.data).toEqual({sent:true});
 });
 it.each([true,false])('keeps bounded refusal distinct from storage errors (%s)',async terminal=>{
  const r=response();await createCheckoutPaymentLinkHandler({codec,createPort:()=>({issue:async()=>{throw terminal?new CheckoutLinkNotRecoverableError():new Error('private driver details');}}),respond:r.respond})({method:'POST',headers:{cookie:cookie()}},null);
  expect(r.result.code).toBe(terminal?'CONFLICT':'UPSTREAM_UNAVAILABLE');expect(r.result.data).toBeUndefined();expect(JSON.stringify(r.result)).not.toContain('private driver details');
 });
});
it('maps only SQL terminal refusals and discards driver diagnostics with raw bind values',async()=>{
 for(const message of ['customer_checkout_recovery_order_not_recoverable','buyer_checkout_recovery_order_not_recoverable']){
  const executor={query:async()=>{throw{code:'22023',message};}};
  await expect(createPostgresCustomerCheckoutRecoveryStartPort(executor).issue({orderId:id,rawToken:'secret',expiresAt:NOW})).rejects.toBeInstanceOf(CheckoutLinkNotRecoverableError);
 }
 const bad=createPostgresBuyerCheckoutLinkPort({query:async()=>{throw new Error('secret driver values');}},{lifetimeMs:DAY,sendBucketMs:600000});
 await expect(bad.issue({orderId:id,clientId:client,rawToken:'secret',requestedAt:NOW})).rejects.toThrow('checkout_link_storage_failed');
});
it.each([0,-1,NaN,DAY+1,1.5])('refuses unsupported configured lifetime %s',lifetimeMs=>{
 expect(()=>createPostgresBuyerCheckoutLinkPort({query:async()=>({rows:[]})},{lifetimeMs,sendBucketMs:600000})).toThrow('checkout_link_policy_invalid');
});


it.each(['one_time_order','subscription_cycle'] as const)('returns the existing %s fallback before requesting an already-dead token',async mode=>{
 const x=setup({order:{...pending,mode,createdAt:new Date(Date.parse(NOW)-DAY-1).toISOString()}});
 await x.handler({method:'POST',body:{orderId:id}},null);
 expect(x.result.data).toEqual({contractVersion:'commerce.checkout-recovery.v1',recoverable:false,fallback:mode==='subscription_cycle'?'customer_account':'fresh_checkout'});
 expect(x.issue).not.toHaveBeenCalled();
 const future=setup({order:{...pending,mode,createdAt:new Date(Date.parse(NOW)-DAY+1).toISOString()}});
 await future.handler({method:'POST',body:{orderId:id}},null);expect(future.result.data).toMatchObject({recoverable:true,token:'rcv_navigation'});expect(future.issue).toHaveBeenCalledOnce();
});
