import { describe,expect,it,vi } from 'vitest';
import { createAdminCheckoutPaymentLinkHandler,hashCheckoutRecoveryToken,createExpiredCheckoutRecoveryPolicy,createPostgresOperatorCheckoutLinkStore,
  type OperatorCheckoutLinkOrder,type OperatorCheckoutLinkStore,type OperatorCheckoutLinkReceipt } from '../../src/commerce/server/index.js';
const NOW='2040-01-02T12:00:00.000Z',DAY=86400000;
const orderId='11111111-1111-4111-8111-111111111111',operatorId='22222222-2222-4222-8222-222222222222';
function order(change: Partial<OperatorCheckoutLinkOrder>={}):OperatorCheckoutLinkOrder {
 return {orderId,orderRef:'example-order',orderNumber:'1',clientId:'33333333-3333-4333-8333-333333333333',status:'pending_payment',mode:'one_time_order',totalMinor:100,currency:'XXX',cadenceDays:null,
  createdAt:NOW,customerEmail:null,customerName:null,paymentIntentId:null,paymentIntentStatus:null,subscriptionId:null,subscriptionCycleId:null,...change};
}
const expired=()=>order({status:'expired',technicallyExpired:true,quoteSnapshot:{},shippingAddressId:'address'});
async function run(options:{snapshot?:OperatorCheckoutLinkOrder|null;body?:unknown;auth?:boolean;actor?:string;machine?:boolean;fail?:string;method?:string;valid?:boolean;withoutValidation?:boolean}={}){
 const calls:string[]=[],receipts:OperatorCheckoutLinkReceipt[]=[];
 const step=async(name:string)=>{calls.push(name);if(options.fail===name)throw Error('storage failure');};
 const store:OperatorCheckoutLinkStore={recordReceipt:async r=>{receipts.push({...r});await step(`receipt:${r.outcome}`);},
  revokeActive:vi.fn(async()=>step('revoke')),insert:vi.fn(async()=>{await step('insert');return 'token-row';}),enqueueRecoveryEmail:vi.fn(async()=>step('enqueue'))};
 const read=vi.fn(async()=>options.snapshot===undefined?order():options.snapshot),validate=vi.fn(async()=>options.valid!==false);
 const result:{code?:string;data?:{token:string;expiresAt:string;orderRef:string;emailQueued:boolean};details?:unknown;allow?:readonly string[]}={};
 const handler=createAdminCheckoutPaymentLinkHandler({authorizeAdmin:async()=>options.auth===false?{ok:false as const,code:'FORBIDDEN' as const,message:'Denied'}:{ok:true as const,userId:options.actor??operatorId,isMachineActor:options.machine},
  respond:{sendMethodNotAllowed:(_,allow)=>{result.allow=allow;},sendBffError:(_,code,__,o)=>{result.code=code;result.details=o?.details;},sendBffSuccess:(_,data)=>{result.data=data as typeof result.data;}},
  orderPort:{getRecoveryOrder:read},tokenStore:store,policy:{operatorLifetimeMs:7*DAY,recoveryWindowMs:30*DAY},
  validateRecreate:options.withoutValidation?undefined:validate,now:()=>new Date(NOW),generateToken:()=> 'rcv_example'});
 await handler({method:options.method??'POST',body:options.body??{orderId}},null);
 return {result,calls,receipts,store,read,validate};
}
describe('operator checkout link command characterization',()=>{
 it('attributes admission and outcome to the session with one request identity and no bearer in receipts',async()=>{
  const {receipts,calls,result,store}=await run();expect(calls).toEqual(['receipt:admitted','revoke','insert','receipt:succeeded']);
  expect(receipts).toHaveLength(2);expect(receipts[0]).toMatchObject({operatorId,orderId,outcome:'admitted',completedStage:'none'});
  expect(receipts[1]).toMatchObject({requestId:receipts[0].requestId,outcome:'succeeded',completedStage:'minted',tokenId:'token-row'});
  expect(JSON.stringify(receipts)).not.toContain('rcv_example');expect(result.data).toMatchObject({token:'rcv_example',emailQueued:false});expect(store.enqueueRecoveryEmail).not.toHaveBeenCalled();
  expect(store.insert).toHaveBeenCalledWith(expect.objectContaining({tokenHash:hashCheckoutRecoveryToken('rcv_example'),expiresAt:new Date(Date.parse(NOW)+7*DAY).toISOString()}));
 });
 it.each(['operatorId','actorId','createdBy','issuedBy'])('rejects request identity %s',async key=>{
  const x=await run({body:{orderId,[key]:operatorId}});expect(x.result.code).toBe('BAD_REQUEST');expect(x.calls).toEqual([]);
 });
 it.each([{auth:false},{actor:''},{machine:true}])('refuses unauthenticated/nonhuman session %j before read',async o=>{
  const x=await run(o);expect(x.result.code).toBe('FORBIDDEN');expect(x.read).not.toHaveBeenCalled();
 });
 it('requires POST and a UUID',async()=>{
  expect((await run({method:'GET'})).result.allow).toEqual(['POST']);expect((await run({body:{orderId:'bad'}})).result.code).toBe('BAD_REQUEST');
 });
 it.each([
  [null,'order_not_found'],[order({status:'paid'}),'order_paid'],[order({status:'cancelled'}),'order_cancelled'],
  [order({subscriptionCycleId:'cycle'}),'order_not_recoverable'],[expired(),'order_changed'],
  [order({createdAt:new Date(Date.parse(NOW)-30*DAY-1).toISOString()}),'order_not_recoverable'],
  [order({createdAt:new Date(Date.parse(NOW)-30*DAY).toISOString()}),'order_not_recoverable'],
  [order({createdAt:'invalid'}),'order_not_recoverable'],[order({status:'expired'}),'order_not_recoverable'],
 ] as const)('returns bounded refusal for snapshot %j',async(snapshot,reason)=>{
  const x=await run({snapshot,valid:false});expect(x.result.details).toEqual({reason});expect(x.calls).toEqual([]);
 });
 it('accepts eligible expired facts and uses the earlier recovery deadline',async()=>{
  const snapshot={...expired(),createdAt:new Date(Date.parse(NOW)-27*DAY).toISOString()};const x=await run({snapshot});
  expect(x.result.data!.expiresAt).toBe(new Date(Date.parse(NOW)+3*DAY).toISOString());expect(x.validate).toHaveBeenCalledOnce();
 });
 it('does not reprice pending orders; optional validation remains optional',async()=>{
  const x=await run({valid:false});expect(x.result.data!.token).toBe('rcv_example');expect(x.validate).not.toHaveBeenCalled();
  expect((await run({snapshot:expired(),withoutValidation:true})).result.data!.token).toBe('rcv_example');
 });
 it.each([
  ['receipt:admitted',undefined],['revoke','none'],['insert','revoked'],['enqueue','minted'],['receipt:succeeded','email_queued'],
 ] as const)('retains the acknowledged stage after %s fails',async(fail,stage)=>{
  const x=await run({fail,body:{orderId,delivery:'email'}});expect(x.result.code).toBe('UPSTREAM_UNAVAILABLE');expect(x.result.data).toBeUndefined();
  if(stage)expect(x.receipts.at(-1)).toMatchObject({outcome:'failed',completedStage:stage});else expect(x.calls).toEqual(['receipt:admitted']);
 });
 it('queues after mint and reports an explicit queued result',async()=>{
  const x=await run({body:{orderId,delivery:'email'}});expect(x.calls).toEqual(['receipt:admitted','revoke','insert','enqueue','receipt:succeeded']);
  expect(x.result.data!.emailQueued).toBe(true);expect(x.store.enqueueRecoveryEmail).toHaveBeenCalledWith(expect.objectContaining({tokenId:'token-row',rawToken:'rcv_example',mode:'one_time'}));
 });
 it('records a minted failure when the response is unrepresentable',async()=>{
  const x=await run({snapshot:order({orderRef:''})});expect(x.result.code).toBe('INVALID_RESPONSE');expect(x.receipts.at(-1)).toMatchObject({outcome:'failed',completedStage:'minted'});
 });
});


it('keeps initial-subscription mail mode without admitting renewal cycles',async()=>{
 const x=await run({snapshot:order({mode:'subscription_cycle',cadenceDays:28}),body:{orderId,delivery:'email'}});
 expect(x.result.data?.emailQueued).toBe(true);expect(x.store.enqueueRecoveryEmail).toHaveBeenCalledWith(expect.objectContaining({mode:'subscription_cycle'}));
 expect(x.validate).not.toHaveBeenCalled();
});
it('uses the configured recovery window in the shared order predicate',()=>{
 const snapshot={...expired(),createdAt:new Date(Date.parse(NOW)-2*DAY).toISOString()};
 for(const [window,kind] of [[DAY,'unavailable'],[3*DAY,'eligible']] as const){
  const p=createExpiredCheckoutRecoveryPolicy<OperatorCheckoutLinkOrder>({admitsSubscriptionSubject:()=>false,recoveryWindowMs:window});
  expect(p.classifyOrderRecoveryEligibility(snapshot,new Date(NOW))).toEqual({kind});
 }
});


it.each([null,''])('refuses a token write that returns no row identity (%s)',async result=>{
 const tokenStore=createPostgresOperatorCheckoutLinkStore({query:async()=>({rows:[{result}]})});
 await expect(tokenStore.insert({receipt:{operatorId,requestId:orderId,orderId,outcome:'admitted',completedStage:'revoked',emailRequested:false},
 clientId:orderId,tokenHash:'a'.repeat(64),expiresAt:NOW,issuedAt:NOW})).rejects.toThrow('checkout_payment_link_insert_failed');
});
