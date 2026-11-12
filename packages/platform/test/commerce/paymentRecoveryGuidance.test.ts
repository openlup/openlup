import { randomUUID } from 'node:crypto';
import { describe,expect,it,vi } from 'vitest';
import { createPostgresPaymentRecoveryGuidancePort,readAuthorizedPaymentRecovery,type PaymentRecoverySnapshot } from '../../src/commerce/server/index.js';
import { normalizeSandboxPaymentRecoveryEvidence } from '../../src/payments/index.js';
const orderId=randomUUID(),clientId=randomUUID(),paymentIntentId=randomUUID(),paymentAttemptId=randomUUID(),tokenId=randomUUID(),journeyId=`checkout:${randomUUID()}`;
const request={orderId,clientId,paymentIntentId,journeyId};
const proof={version:1,source:'observation',sourceId:randomUUID(),observationId:randomUUID(),paymentAttemptId,paymentIntentId,outcome:'refused',refusalVerified:true};
const normalized=normalizeSandboxPaymentRecoveryEvidence({provider:'sandbox',evidence:[proof]})!;
const snapshot=():PaymentRecoverySnapshot=>({orderId,clientId,orderStatus:'pending_payment',paymentIntentId,intentStatus:'failed',paymentAttemptId,attemptStatus:'failed',provider:'sandbox',providerPaymentId:null,
 updatedAt:'2040-01-01T00:00:00Z',failureReason:null,subscriptionId:null,subscriptionActivationStatus:'not_applicable',subscriptionStatus:null,
 eligible:true,purchaseContext:'one_time',tokenAuthorized:true,historyComplete:true,observedSuccess:false,attempts:[{id:paymentAttemptId,status:'failed',evidence:normalized}]});
const claims={...request,paymentAttemptId,executionRail:'sandbox',purpose:'commerce.checkout-payment-continuation.v1' as const,version:1 as const,expiresAt:4102444800};
function deps(s=snapshot()) {return{port:{getGuidanceSnapshot:vi.fn(async()=>s)},tokenPort:{validate:vi.fn(async()=>({tokenId,orderId,clientId,mode:'one_time_order' as const,status:'pending_payment'}))}};}
describe('optional payment guidance inspection',()=>{
 it('derives neutral actions through Core without inferring a method, operation or refusal class',async()=>{
  const d=deps(),r=await readAuthorizedPaymentRecovery({request,claims:null,authorization:'Bearer example',deps:d});
  expect(r?.guidance).toMatchObject({actions:['change_instrument','change_method'],methodKind:null,methodKey:null,operation:null,cause:'generic_decline',consecutiveRefusals:null});
  expect(d.port.getGuidanceSnapshot).toHaveBeenCalledWith({orderId,paymentIntentId,recoveryTokenId:tokenId});
 });
 it.each(['unavailable','mismatched','expired'] as const)('uses legacy fallback for %s continuation authority',async mode=>{
  const d=deps();if(mode==='unavailable')d.tokenPort.validate.mockResolvedValueOnce(null!);
  if(mode==='mismatched')d.tokenPort.validate.mockResolvedValueOnce({tokenId,orderId:randomUUID(),clientId,mode:'one_time_order',status:'pending_payment'});
  const c=mode==='expired'?{...claims,expiresAt:1}:null;
  expect(await readAuthorizedPaymentRecovery({request,claims:c,authorization:mode==='expired'?null:'Bearer example',deps:d})).toBeNull();expect(d.port.getGuidanceSnapshot).not.toHaveBeenCalled();
 });
 it('binds cookie authority to the exact current attempt and rail, without passing token authority',async()=>{
  const d=deps();expect((await readAuthorizedPaymentRecovery({request,claims,authorization:null,deps:d}))?.guidance).not.toBeNull();
  expect(d.port.getGuidanceSnapshot).toHaveBeenCalledWith({orderId,paymentIntentId});
  expect((await readAuthorizedPaymentRecovery({request,claims:{...claims,paymentAttemptId:randomUUID()},authorization:null,deps:d}))?.guidance).toBeNull();
 });
 it.each(['eligible','tokenAuthorized','purchaseContext','observedSuccess'] as const)('fences guidance using atomic %s facts',async field=>{
  const s=snapshot();Object.assign(s,{[field]:field==='observedSuccess'?true:field==='purchaseContext'?null:false});
  const d=deps(s);expect(await readAuthorizedPaymentRecovery({request,claims:null,authorization:'Bearer example',deps:d})).toMatchObject({snapshot:s,guidance:null});
 });
 it('retains legacy infrastructure fallback and exact identity checks',async()=>{
  const d=deps();d.port.getGuidanceSnapshot.mockRejectedValueOnce(new Error('unavailable'));
  expect(await readAuthorizedPaymentRecovery({request,claims:null,authorization:'Bearer example',deps:d})).toBeNull();
  d.port.getGuidanceSnapshot.mockResolvedValueOnce({...snapshot(),clientId:randomUUID()});expect(await readAuthorizedPaymentRecovery({request,claims:null,authorization:'Bearer example',deps:d})).toBeNull();
 });
 it('retains the host display projection but never invokes it through success suppression',async()=>{
  const d=deps(),projectGuidance=vi.fn(()=>null);await readAuthorizedPaymentRecovery({request,claims:null,authorization:'Bearer example',deps:{...d,projectGuidance}});expect(projectGuidance).toHaveBeenCalledOnce();
  d.port.getGuidanceSnapshot.mockResolvedValueOnce({...snapshot(),observedSuccess:true});await readAuthorizedPaymentRecovery({request,claims:null,authorization:'Bearer example',deps:{...d,projectGuidance}});expect(projectGuidance).toHaveBeenCalledOnce();
 });
 it('refuses malformed, foreign and oversized sets; real rails retain the named refusal',()=>{
  expect(normalizeSandboxPaymentRecoveryEvidence({provider:'sandbox',evidence:Array(33).fill(proof)})).toBeNull();
  expect(normalizeSandboxPaymentRecoveryEvidence({provider:'sandbox',evidence:[{...proof,method:'opaque'}]})).toBeNull();
  expect(normalizeSandboxPaymentRecoveryEvidence({provider:'sandbox',evidence:[proof,{...proof,paymentAttemptId:randomUUID()}]})).toBeNull();
  expect(()=>normalizeSandboxPaymentRecoveryEvidence({provider:'other',evidence:[proof]})).toThrow('native_prepared_attempt_store_unsupported');
 });
 it('uses one closed query, rejects malformed snapshots and preserves missing-data fallback',async()=>{
  const query=vi.fn(async()=>({rows:[{result:null}]}));const p=createPostgresPaymentRecoveryGuidancePort({query},normalizeSandboxPaymentRecoveryEvidence);
  expect(await p.getGuidanceSnapshot(request)).toBeNull();expect(query).toHaveBeenCalledOnce();
  query.mockResolvedValueOnce({rows:[{result:{refusal:'native_prepared_attempt_store_unsupported'} as never}]});await expect(p.getGuidanceSnapshot(request)).rejects.toThrow('native_prepared_attempt_store_unsupported');
  query.mockResolvedValueOnce({rows:[{result:{} as never}]});await expect(p.getGuidanceSnapshot(request)).rejects.toThrow('payment_recovery_snapshot_invalid');
  query.mockRejectedValueOnce(new Error('storage detail'));await expect(p.getGuidanceSnapshot(request)).rejects.toThrow('payment_recovery_snapshot_unavailable');
 });
});
