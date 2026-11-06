import { describe,expect,it,vi } from 'vitest';
import { runOneAutomaticSubscriptionRenewal,runAutomaticSubscriptionRenewals,correlatedLogicalCycle } from '../../src/subscriptions/automaticRenewal.js';
import { effectsFixture } from './renewalEffectsFixture.js';
import { runRenewalBatchRows } from '../../src/subscriptions/automaticRenewalExecution.js';

// Characterizes the reference semantic busy rule through the public row result.
it.each(['inventory_admission_busy', 'inventory_lock_unavailable'])('omits recognized %s and continues the serial batch', async reason => {
 const f=effectsFixture(), healthy={...f.due,subscriptionId:'healthy'}, calls:string[]=[];
 const result=await runRenewalBatchRows([f.due,healthy],async row=>{
  calls.push(row.subscriptionId);
  if(row===f.due)throw {details:{code:'55P03',reason}};
  return {subscriptionId:row.subscriptionId,identityKey:'healthy-key',operationId:'healthy-op',status:'succeeded',replayed:false,reason:null};
 },f.deps.policy);
 expect(calls).toEqual([f.due.subscriptionId,'healthy']);
 expect(result).toEqual([{subscriptionId:'healthy',identityKey:'healthy-key',operationId:'healthy-op',status:'succeeded',replayed:false,reason:null}]);
});
it.each([
 null,
 undefined,
 {},
 {details:null},
 {details:{}},
 {details:{code:'55P03'}},
 {details:{reason:'inventory_admission_busy'}},
 {code:'55P03',message:'inventory_admission_busy'},
 {details:{code:'55P03',reason:'unrelated_lock'}},
 {details:{code:'XX000',reason:'inventory_admission_busy'}},
 new Error('inventory_lock_unavailable'),
])('keeps unrelated or unrecognized busy-looking errors visible',async error=>{
 const f=effectsFixture();
 expect(await runRenewalBatchRows([f.due],async()=>{throw error;},f.deps.policy)).toEqual([
  {subscriptionId:f.due.subscriptionId,identityKey:f.op.identityKey,operationId:'',status:'error',replayed:false,reason:'renewal_processing_failed'},
 ]);
});
describe('native renewal effect ordering through the P1 port',()=>{
 it('orders admission, stock, atomic prepare, M07 dispatch, ACK and terminal settlement',async()=>{
  const f=effectsFixture();expect(await runOneAutomaticSubscriptionRenewal(f.deps,f.due)).toMatchObject({status:'succeeded'});
  expect(f.trace).toEqual(['snapshot','claim','mandate','admit','reserve','prepare','validate','execute','ack','read','terminal']);
  expect(f.rail.execute.mock.calls[0]).toEqual([f.deps.policy.executionInput(f.due,f.op,{orderId:'order',settlementIntentId:'intent'})]);
 });
 it('revoked mandate evidence refuses before admission, stock or dispatch even with the same method reference',async()=>{
  const f=effectsFixture();f.deps.store.readMandateEvidence=async()=>({authorized:false,authorizationRef:'method',authorizedAt:f.at});
  expect(await runOneAutomaticSubscriptionRenewal(f.deps,f.due)).toMatchObject({status:'refused',reason:'authorization_evidence_mismatch'});
  expect(f.deps.store.admitDeliveryAlignment).not.toHaveBeenCalled();expect(f.deps.inventory.reserve).not.toHaveBeenCalled();expect(f.rail.execute).not.toHaveBeenCalled();
 });
 it('deferred captured cases never prepare or execute and preserve the durable reference',async()=>{
  const f=effectsFixture();f.deps.store.admitDeliveryAlignment=async()=>({allowed:false,state:'protected',reason:'delivery_alignment_protected',deferred:true,caseRef:'captured'});
  expect(await runOneAutomaticSubscriptionRenewal(f.deps,f.due)).toMatchObject({status:'deferred',caseRef:'captured'});
  expect(f.rail.execute).not.toHaveBeenCalled();expect(f.deps.settlement.prepareRenewal).not.toHaveBeenCalled();
 });
 it('prepared replay and ACK loss read back without executing again',async()=>{
  const f=effectsFixture();f.op.state='attempt_prepared';
  expect(await runOneAutomaticSubscriptionRenewal(f.deps,f.due)).toMatchObject({status:'succeeded'});
  expect(f.trace).toEqual(['snapshot','claim','find','ack','read','terminal']);expect(f.rail.execute).not.toHaveBeenCalled();
 });
 it('missing ACK and execution timeout remain ambiguous without a failure handoff or redispatch',async()=>{
  const f=effectsFixture();f.op.state='attempt_prepared';f.rail.findExternalAttempt=vi.fn(async()=>null);
  expect(await runOneAutomaticSubscriptionRenewal(f.deps,f.due)).toMatchObject({status:'awaiting_provider'});
  expect(f.rail.execute).not.toHaveBeenCalled();expect(f.deps.failureHandoff.handoffFailure).not.toHaveBeenCalled();
  const t=effectsFixture();t.rail.execute=vi.fn(async()=>{throw Error('timeout');});
  expect(await runOneAutomaticSubscriptionRenewal(t.deps,t.due)).toMatchObject({status:'awaiting_provider'});
  expect(t.deps.settlement.recordTerminalOutcome).not.toHaveBeenCalled();
 });
 it('initial refusal opens rung one before terminal outcome, independently of native counter',async()=>{
  const f=effectsFixture();f.rail.execute=vi.fn(async()=>({status:'requires_action',externalAttemptRef:'ack'}));
  expect(await runOneAutomaticSubscriptionRenewal(f.deps,f.due)).toMatchObject({status:'refused'});
  expect(f.trace.slice(-2)).toEqual(['case','terminal']);
  expect(f.deps.failureHandoff.handoffFailure).toHaveBeenCalledWith(expect.objectContaining({retryAttempt:1,nextRetryAt:'2026-10-23T12:00:00.000Z'}));
  expect(correlatedLogicalCycle(f.snapshot)).toBe(8);
  expect(()=>correlatedLogicalCycle({...f.snapshot,cycle:{status:'ambiguous',logicalCycleNumber:null,nativeRenewalCounter:4,activationCycleId:null,reason:'no evidence'}})).toThrow('correlation_required');
 });
 it('a failed case handoff never silently records a terminal refusal',async()=>{
  const f=effectsFixture();f.rail.execute=vi.fn(async()=>({status:'failed',externalAttemptRef:'ack',failure:{reason:'declined',failureClass:'temporary'}}));
  f.deps.failureHandoff.handoffFailure=async()=>{throw Error('case unavailable');};
  await expect(runOneAutomaticSubscriptionRenewal(f.deps,f.due)).rejects.toThrow('case unavailable');
  expect(f.deps.settlement.recordTerminalOutcome).not.toHaveBeenCalled();
 });
 it.each(['pending','unknown','succeeded','failed'] as const)('bare failed execution uses verified readback (%s)',async status=>{
  const f=effectsFixture();f.rail.execute=vi.fn(async()=>({status:'failed',externalAttemptRef:'ack'}));
  f.evidence.status=status;
  const result=await runOneAutomaticSubscriptionRenewal(f.deps,f.due);
  expect(f.rail.readOutcome).toHaveBeenCalledOnce();
  expect(result.status).toBe(status==='failed'?'refused':status==='succeeded'?'succeeded':'awaiting_provider');
  if(status==='pending'||status==='unknown') {
   expect(f.deps.failureHandoff.handoffFailure).not.toHaveBeenCalled();
   expect(f.deps.settlement.recordTerminalOutcome).not.toHaveBeenCalled();
  }
 });
 it('bare failed execution without an ACK stays ambiguous without a failure handoff',async()=>{
  const f=effectsFixture();f.rail.execute=vi.fn(async()=>({status:'failed',externalAttemptRef:null}));
  expect(await runOneAutomaticSubscriptionRenewal(f.deps,f.due)).toMatchObject({status:'awaiting_provider',reason:'provider_attempt_ack_missing'});
  expect(f.deps.failureHandoff.handoffFailure).not.toHaveBeenCalled();expect(f.rail.readOutcome).not.toHaveBeenCalled();
  expect(f.deps.settlement.recordTerminalOutcome).not.toHaveBeenCalled();
 });
 it('batch errors remain per-row and do not starve the next schedule',async()=>{
  const f=effectsFixture();f.deps.store.listDue=async()=>[f.due,f.due];let n=0;
  const snapshots=f.deps.store.buildCycleSnapshots;f.deps.store.buildCycleSnapshots=async input=>{if(n++===0)throw Error('fixture');return snapshots(input);};
  expect((await runAutomaticSubscriptionRenewals(f.deps)).map(r=>r.status)).toEqual(['error','succeeded']);
 });
});
