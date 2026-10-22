import type { Pool } from 'pg';
import { expect,it,vi } from 'vitest';
import { NATIVE_SUBSCRIPTION_CAPABILITIES,createPostgresRenewalStore,createPostgresRetryStore,createPostgresRetryLifecycleBinding,type NativeRenewalCodec } from '@openlup/platform/subscriptions';
import type { RenewalFrozenSnapshot,RenewalDue,RenewalReadback } from '@openlup/platform/subscriptions/contracts';
import { createPostgresRenewalSettlementPort } from '../../server/adapters/postgres/commerce/renewalSettlement.js';
import type { RenewalSettlementPort } from '@openlup/platform/subscriptions/contracts';
import { AT,call,failure,later,positive,prepareOriginal,renewal,request,unchangedIdentity } from './subscriptionNativeFixture.js';
export function registerAdapterCases(h:{pool:Pool}) {
 it('the P1 native store keeps the original snapshot, correlation, schedule and identity across mutable future-term edits and lease takeover',async()=>{
  const f=await renewal(h.pool),wire=f.snapshot;
  const snapshot:RenewalFrozenSnapshot={contractVersion:wire.contractVersion as 'platform.subscription.renewal.v1',subscriptionId:f.subscription,clientId:f.client,
   scheduledAt:wire.scheduledAt,scheduledInstant:Date.parse(wire.scheduledAt),frozenRevision:'original-revision',frozenFingerprint:f.fingerprint,
   cycle:{status:'correlated',logicalCycleNumber:8,nativeRenewalCounter:2,activationCycleId:null,evidenceRef:'explicit-host-correlation'},retryAttempt:0,externalAttemptSequence:0,
   templateSnapshot:{templateId:'original',version:1,cadenceDays:28,lines:wire.lines},pricingSnapshot:{currency:wire.currency,totalAmountMinor:wire.totalAmountMinor,shippingAmountMinor:0,agreementPolicy:'lock_until_edit',proration:'none'},
   orderSnapshot:{shippingAddressRef:null,shippingQuoteRef:null,acquisitionRef:null,lines:wire.lines},stockSourceKey:f.source,settlementChannelKey:'fixture',authorizationRef:'frozen-mandate',payerAccountRef:null,unattendedChargeAuthorizedAt:AT};
  const due:RenewalDue={...snapshot,cadenceDays:28,currency:wire.currency,deliveryAdmission:'allowed',deliveryBlockReason:null};
  const codec:NativeRenewalCodec={due:()=>due,freeze:vi.fn(()=>snapshot),encode:s=>{expect(s).toEqual(snapshot);return wire;},decode:s=>{expect(s).toEqual(wire);return snapshot;},identity:()=>f.identity,fingerprint:()=>f.fingerprint,
   readback:r=>({...r,cycle:snapshot.cycle,cycleSnapshot:snapshot,scheduledInstant:Date.parse(String(r.scheduledAt))}) as unknown as RenewalReadback};
  const store=createPostgresRenewalStore(h.pool,codec);
  const raced=await Promise.all([store.claimDue({snapshot,workerId:'one',now:later(1)}),store.claimDue({snapshot,workerId:'two',now:later(1)})]);
  expect(raced.filter(r=>r.acquired)).toHaveLength(1);
  await h.pool.query('UPDATE public.subscription_renewal_term_lines SET unit_amount_minor=999 WHERE subscription_id=$1',[f.subscription]);
  expect(await store.buildCycleSnapshots(due)).toEqual(snapshot);expect(codec.freeze).not.toHaveBeenCalled();
  expect(await store.claimDue({snapshot,workerId:'blocked',now:AT})).toMatchObject({acquired:false,reason:'lease_active'});
  expect((await store.listDue(500,later(2))).find(r=>r.subscriptionId===f.subscription)).toEqual(due);
  const claim=await store.claimDue({snapshot,workerId:'takeover',now:later(2)});
  expect(claim).toMatchObject({operationId:f.operation,identityKey:f.identity,claimGeneration:3,cycle:snapshot.cycle,cycleSnapshot:snapshot});
  expect(await store.readRenewal(f.identity)).toMatchObject({operationId:f.operation,cycleSnapshot:snapshot});
  await unchangedIdentity(h.pool,f);
 });
 it('selected retry adapter applies a subsequent receipt once and advances the case separately without another original terminal transition',async()=>{
  expect(NATIVE_SUBSCRIPTION_CAPABILITIES.retryRecovery).toBe('selected');
  const f=await renewal(h.pool),original=await prepareOriginal(h.pool,f),store=createPostgresRetryStore(h.pool);
  await store.applyFailure(f.operation,`initial-${f.operation}`,failure());await store.openCase(f.operation,'failed','/recover');
  const current=await store.read(f.operation);expect(current).toMatchObject({logicalCycleNumber:3,nativeRenewalCounter:2,retryAttempt:1,disposition:'retry_scheduled'});
  expect((await store.candidates(500,later(24))).some(r=>r.operationId===f.operation)).toBe(true);
  const key=`prepare-${f.operation}`,input=request({...f,original});
  const raced=await Promise.all([store.prepare(f.operation,key,input,later(24)),store.prepare(f.operation,key,input,later(24))]);
  expect(raced.filter(r=>r.execute)).toHaveLength(1);expect(raced[0].request).toEqual(input);
  const failureInput=failure(1,later(25));const failed=await store.applyFailure(f.operation,`retry-failed-${f.operation}`,failureInput);
  expect(failed).toMatchObject({retryAttempt:2});expect(new Date(failed.nextRetryAt!).toISOString()).toBe(later(97));
  expect(await store.applyFailure(f.operation,`retry-failed-${f.operation}`,failureInput)).toEqual(failed);
  await store.openCase(f.operation,'failed','/recover');
  expect((await h.pool.query('SELECT retry_attempt FROM public.subscription_dunning_cases WHERE id=$1',[failed.caseId])).rows).toEqual([{retry_attempt:2}]);
  expect((await h.pool.query('SELECT count(*)::int n FROM public.subscription_renewal_outcomes WHERE renewal_operation_id=$1',[f.operation])).rows).toEqual([{n:1}]);
  expect(await store.recordRecovery(f.operation,`late-${f.operation}`,positive(f))).toMatchObject({disposition:'paid'});
  await unchangedIdentity(h.pool,f);
 });
 it('initial case precedes terminal outcome; crash rollback and replay converge to one case and one rung',async()=>{
  expect(NATIVE_SUBSCRIPTION_CAPABILITIES.retryRecovery).toBe('selected');
  const f=await renewal(h.pool),original=await prepareOriginal(h.pool,f),store=createPostgresRetryStore(h.pool);
  await expect(store.openCase(f.operation,'failed','/recover')).rejects.toThrow('failure_required');
  expect(await store.read(f.operation)).toBeNull();
  let failBookkeeping=true;
  const binding=createPostgresRetryLifecycleBinding({executor:h.pool,
   async withTransaction(work) {
    const db=await h.pool.connect();try {await db.query('BEGIN');
     const executor={async query(sql:string,values?:unknown[]){
      if(failBookkeeping&&sql.includes('subscription_retry_apply_failure('))throw Error('synthetic bookkeeping loss');
      return db.query(sql,values);
     }};
     const result=await work(executor);await db.query('COMMIT');return result;
    }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
   },
   settlement:db=>createPostgresRenewalSettlementPort(db) as unknown as RenewalSettlementPort,
   correlate:()=>({status:'correlated',logicalCycleNumber:8,nativeRenewalCounter:2,activationCycleId:null,evidenceRef:'explicit-host-correlation'}),
   failureTemplate:'failed',recoveryPath:'/recover'});
  const handoff={idempotencyKey:`${f.identity}:failure-handoff`,subscriptionId:f.subscription,clientId:f.client,cycleId:original.cycleId,
   orderId:original.orderId,paymentIntentId:original.settlementIntentId,retryAttempt:1,failureClass:'temporary',failureReason:'declined',
   nextRetryAt:null,occurredAt:AT,amountMinor:f.snapshot.totalAmountMinor,currency:'XXX'};
  const first=await binding.failureHandoff.handoffFailure(handoff);
  expect(await binding.failureHandoff.handoffFailure(handoff)).toMatchObject({caseId:first.caseId,replayed:true});
  expect((await call(h.pool,'subscription_read_renewal',[f.identity])).state).toBe('attempt_prepared');
  const terminal={operationId:f.operation,eventKey:`${f.identity}:provider-refusal`,operationFingerprint:f.fingerprint,outcome:'refused' as const,externalRef:'original-ack',reason:'declined',occurredAt:AT};
  await expect(binding.settlement.recordTerminalOutcome(terminal)).rejects.toThrow('synthetic bookkeeping loss');
  expect((await call(h.pool,'subscription_read_renewal',[f.identity])).state).toBe('attempt_prepared');
  expect(await store.read(f.operation)).toBeNull();
  expect((await h.pool.query('SELECT * FROM public.subscription_renewal_outcomes WHERE renewal_operation_id=$1',[f.operation])).rows).toEqual([]);
  failBookkeeping=false;
  await binding.settlement.recordTerminalOutcome(terminal);await binding.settlement.recordTerminalOutcome(terminal);
  expect(await store.read(f.operation)).toMatchObject({caseId:first.caseId,retryAttempt:1,logicalCycleNumber:8,nextRetryAt:null});
  expect((await h.pool.query('SELECT count(*)::int n FROM public.subscription_dunning_cases WHERE cycle_id=$1',[original.cycleId])).rows).toEqual([{n:1}]);
  expect((await h.pool.query('SELECT count(*)::int n FROM public.subscription_renewal_outcomes WHERE renewal_operation_id=$1',[f.operation])).rows).toEqual([{n:1}]);
  expect((await store.candidates(500,later(24))).some(r=>r.operationId===f.operation)).toBe(false);
  await store.recordRecovery(f.operation,`recovered-${f.operation}`,positive(f));
  await binding.settlement.recordTerminalOutcome(terminal);
  expect(await store.read(f.operation)).toMatchObject({state:'recovered',caseId:first.caseId,retryAttempt:1});
  await unchangedIdentity(h.pool,f);
 });
 it.each([false,true])('initial terminal replay uses its immutable receipt after a changed failure (recovered=%s)',async recovered=>{
  const f=await renewal(h.pool),original=await prepareOriginal(h.pool,f),store=createPostgresRetryStore(h.pool);
  const binding=createPostgresRetryLifecycleBinding({executor:h.pool,
   async withTransaction(work) {
    const db=await h.pool.connect();try {await db.query('BEGIN');const result=await work(db);await db.query('COMMIT');return result;}
    catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
   },
   settlement:db=>createPostgresRenewalSettlementPort(db) as unknown as RenewalSettlementPort,
   correlate:()=>({status:'correlated',logicalCycleNumber:3,nativeRenewalCounter:2,activationCycleId:null,evidenceRef:'explicit-host-correlation'}),
   failureTemplate:'failed',recoveryPath:'/recover'});
  const first=await binding.failureHandoff.handoffFailure({idempotencyKey:`${f.identity}:failure-handoff`,subscriptionId:f.subscription,
   clientId:f.client,cycleId:original.cycleId,orderId:original.orderId,paymentIntentId:original.settlementIntentId,
   retryAttempt:1,failureClass:'temporary',failureReason:'declined',nextRetryAt:later(24),occurredAt:AT,
   amountMinor:f.snapshot.totalAmountMinor,currency:'XXX'});
  const terminal={operationId:f.operation,eventKey:`${f.identity}:provider-refusal`,operationFingerprint:f.fingerprint,
   outcome:'refused' as const,externalRef:'original-ack',reason:'declined',occurredAt:AT};
  await binding.settlement.recordTerminalOutcome(terminal);
  const receipt=async()=>(await h.pool.query('SELECT * FROM public.subscription_retry_receipts WHERE receipt_key=$1',[terminal.eventKey])).rows;
  const initial=await receipt();
  expect(initial).toHaveLength(1);expect(initial[0].input).toMatchObject({failureClass:'temporary',reason:'declined'});
  await store.prepare(f.operation,`prepare-${f.operation}`,request({...f,original}),later(24));
  await store.applyFailure(f.operation,`subsequent-${f.operation}`,{...failure(1,later(25),'hard_do_not_retry'),reason:'new-provider-reason'});
  await store.openCase(f.operation,'failed','/recover');
  expect((await h.pool.query('SELECT failure_class,failure_reason FROM public.subscription_dunning_cases WHERE id=$1',[first.caseId])).rows)
   .toEqual([{failure_class:'hard_do_not_retry',failure_reason:'new-provider-reason'}]);
  if(recovered)await store.recordRecovery(f.operation,`recovered-${f.operation}`,positive(f));
  const before=await store.read(f.operation);
  expect(before).toMatchObject({state:recovered?'recovered':'waiting',retryAttempt:2,failureClass:'hard_do_not_retry',nextRetryAt:null});
  expect(await binding.settlement.recordTerminalOutcome(terminal)).toMatchObject({replayed:true});
  for(const conflict of [{reason:'different-reason'},{occurredAt:later(1)},{externalRef:'different-ack'},{operationFingerprint:'0'.repeat(64)}]) {
   await expect(binding.settlement.recordTerminalOutcome({...terminal,...conflict})).rejects.toThrow(/conflict|mismatch/);
  }
  expect(await store.read(f.operation)).toEqual(before);expect(await receipt()).toEqual(initial);
  expect((await h.pool.query('SELECT count(*)::int n FROM public.subscription_renewal_outcomes WHERE renewal_operation_id=$1',[f.operation])).rows).toEqual([{n:1}]);
  await unchangedIdentity(h.pool,f);
 });

}
