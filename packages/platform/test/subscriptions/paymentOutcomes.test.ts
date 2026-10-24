import { expect,it } from 'vitest';
import { readAndApplyProviderOutcome } from '../../src/subscriptions/paymentOutcomes.js';
import { effectsFixture } from './renewalEffectsFixture.js';
it('an out-of-contract status with complete money and matching evidence never settles',async()=>{
 const f=effectsFixture();Object.assign(f.evidence,{status:'unrecognized_provider_status'});
 expect(f.evidence).toMatchObject({amountMinor:100,currency:'XXX',occurredAt:f.at});
 expect(await readAndApplyProviderOutcome(f.deps,f.op,{cycleId:'cycle',orderId:'order',settlementIntentId:'intent'},f.rail,'ack',f.at)).toMatchObject({status:'awaiting_provider'});
 expect(f.deps.settlement.recordTerminalOutcome).not.toHaveBeenCalled();expect(f.deps.failureHandoff.handoffFailure).not.toHaveBeenCalled();
 expect(f.rail.execute).not.toHaveBeenCalled();
});
it.each(['pending','unknown'] as const)('%s M07 truth remains awaiting provider',async status=>{
 const f=effectsFixture();f.evidence.status=status;
 expect(await readAndApplyProviderOutcome(f.deps,f.op,{cycleId:'cycle',orderId:'order',settlementIntentId:'intent'},f.rail,'ack',f.at)).toMatchObject({status:'awaiting_provider'});
 expect(f.deps.settlement.recordTerminalOutcome).not.toHaveBeenCalled();
});
it.each(['amountMinor','currency','occurredAt'] as const)('positive evidence missing %s never settles or authorizes a charge',async field=>{
 const f=effectsFixture();f.evidence[field]=null;
 expect(await readAndApplyProviderOutcome(f.deps,f.op,{cycleId:'cycle',orderId:'order',settlementIntentId:'intent'},f.rail,'ack',f.at)).toMatchObject({status:'awaiting_provider'});
 expect(f.deps.settlement.recordTerminalOutcome).not.toHaveBeenCalled();expect(f.rail.execute).not.toHaveBeenCalled();
});
it.each(['operationId','requestFingerprint','externalAttemptRef','verifiedEvidenceRef','eventKey','firstRecordedAt'] as const)('mismatched or missing %s refuses terminal truth',async field=>{
 const f=effectsFixture();f.evidence[field]='';
 await expect(readAndApplyProviderOutcome(f.deps,f.op,{cycleId:'cycle',orderId:'order',settlementIntentId:'intent'},f.rail,'ack',f.at)).rejects.toThrow('verified_evidence_required');
 expect(f.deps.settlement.recordTerminalOutcome).not.toHaveBeenCalled();
});
it('late positive retains original occurrence and the unchanged donor settlement key',async()=>{
 const f=effectsFixture();f.evidence.disposition='late_positive';f.evidence.occurredAt='2026-10-21T01:00:00Z';
 await readAndApplyProviderOutcome(f.deps,f.op,{cycleId:'cycle',orderId:'order',settlementIntentId:'intent'},f.rail,'ack',f.at);
 expect(f.deps.settlement.recordTerminalOutcome).toHaveBeenCalledWith(expect.objectContaining({eventKey:'original-key:provider-success:ack',occurredAt:'2026-10-21T01:00:00Z'}));
});

it('an ambiguous observation never becomes terminal even if its status says succeeded',async()=>{
 const f=effectsFixture();f.evidence.disposition='ambiguous';
 expect(await readAndApplyProviderOutcome(f.deps,f.op,{cycleId:'cycle',orderId:'order',settlementIntentId:'intent'},f.rail,'ack',f.at)).toMatchObject({status:'awaiting_provider',reason:'provider_ambiguous'});
 expect(f.deps.settlement.recordTerminalOutcome).not.toHaveBeenCalled();expect(f.rail.execute).not.toHaveBeenCalled();
});
