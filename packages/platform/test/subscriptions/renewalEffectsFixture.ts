import { vi } from 'vitest';
import type { RenewalDue,RenewalFrozenSnapshot,RenewalReadback,RenewalPaymentEvidence } from '../../src/subscriptions/contracts/renewal.js';
import type { AutomaticRenewalRunDeps } from '../../src/subscriptions/automaticRenewal.js';
export function effectsFixture() {
 const at='2026-10-22T12:00:00Z',trace:string[]=[];
 const due:RenewalDue={subscriptionId:'sub',clientId:'client',scheduledAt:at,scheduledInstant:Date.parse(at),cadenceDays:28,
  cycle:{status:'correlated',logicalCycleNumber:8,nativeRenewalCounter:4,activationCycleId:'activation',evidenceRef:'predecessor'},currency:'XXX',
  stockSourceKey:'stock',settlementChannelKey:'rail',authorizationRef:'method',payerAccountRef:null,unattendedChargeAuthorizedAt:at,deliveryAdmission:'allowed',deliveryBlockReason:null};
 const snapshot:RenewalFrozenSnapshot={...due,contractVersion:'platform.subscription.renewal.v1',frozenRevision:'revision',frozenFingerprint:'f'.repeat(64),retryAttempt:0,externalAttemptSequence:0,
  templateSnapshot:{templateId:'template',version:1,cadenceDays:28,lines:[{lineOrdinal:1,sku:'sku',quantity:1,unitAmountMinor:100}]},
  pricingSnapshot:{currency:'XXX',totalAmountMinor:100,shippingAmountMinor:0,agreementPolicy:'lock_until_edit',proration:'none'},
  orderSnapshot:{shippingAddressRef:null,shippingQuoteRef:null,acquisitionRef:null,lines:[{lineOrdinal:1,sku:'sku',quantity:1,unitAmountMinor:100}]}};
 const op:RenewalReadback={...due,contractVersion:'platform.subscription.renewal.v1',acquired:true,replayed:false,reason:'claimed',operationId:'op',identityKey:'original-key',operationFingerprint:'f'.repeat(64),state:'claimed',claimToken:'token',claimGeneration:1,leaseExpiresAt:at,cycleSnapshot:snapshot,externalAttemptRef:null,externalAttemptAcknowledgedAt:null,terminalOutcome:null,terminalReason:null,terminalAt:null,reservationId:null,cycleId:'cycle',orderId:'order',settlementIntentId:'intent'};
 const evidence:RenewalPaymentEvidence={status:'succeeded',disposition:'observed',operationId:'op',eventKey:'verified-event',requestFingerprint:'f'.repeat(64),verifiedEvidenceRef:'m07-evidence',externalAttemptRef:'ack',occurredAt:at,observedAt:at,firstRecordedAt:at,amountMinor:100,currency:'XXX',reason:null};
 const rail={execute:vi.fn(async()=>{trace.push('execute');return {status:'pending' as const,externalAttemptRef:'ack'};}),findExternalAttempt:vi.fn(async()=>{trace.push('find');return 'ack';}),readOutcome:vi.fn(async()=>{trace.push('read');return evidence;})};
 const deps:AutomaticRenewalRunDeps={
  store:{transactions:{graph:'native',prepare:'cycle_order_items_settlement_reservation_attempt',outcome:'settlement_outcome_schedule_counter_reservation',recovery:'settlement_cycle_receipt_case_counter'},
   listDue:vi.fn(async()=>[due]),buildCycleSnapshots:vi.fn(async()=>{trace.push('snapshot');return snapshot;}),readMandateEvidence:vi.fn(async()=>{trace.push('mandate');return {authorized:true,authorizationRef:'method',authorizedAt:at};}),
   admitDeliveryAlignment:vi.fn(async()=>{trace.push('admit');return {allowed:true as const,state:'off',reason:'off'};}),claimDue:vi.fn(async()=>{trace.push('claim');return op;}),readRenewal:vi.fn(async()=>op),refuseBeforePayment:vi.fn(async()=>{trace.push('refuse');return op;})},
  inventory:{expireReservations:vi.fn(async()=>0),reserve:vi.fn(async()=>{trace.push('reserve');return {reserved:true,replayed:false,reservationId:'res',status:'held',reason:null};})},
  settlement:{prepareRenewal:vi.fn(async()=>{trace.push('prepare');return {contractVersion:'platform.subscription.renewal.v1',replayed:false,operationId:'op',operationFingerprint:op.operationFingerprint,cycleId:'cycle',orderId:'order',settlementIntentId:'intent',state:'attempt_prepared'};}),
   acknowledgeExternalAttempt:vi.fn(async()=>{trace.push('ack');return op;}),recordTerminalOutcome:vi.fn(async()=>{trace.push('terminal');return op;})},
  paymentRails:{resolve:()=>rail},failureHandoff:{handoffFailure:vi.fn(async()=>{trace.push('case');return {caseId:'case',replayed:false};})},
  policy:{executionInput:()=>({cycleIdempotencyKey:'original-key',executionIdempotencyKey:'original-key:provider-attempt',externalIdempotencyKey:'unchanged-host-key',requestFingerprint:op.operationFingerprint,paymentIntentId:'intent',amountMinor:100,currency:'XXX',mode:'subscription_cycle',orderRef:'order',orderId:'order',flow:'off_session_payment',customerRef:null,paymentMethodRef:'method',recurringModel:null,clientId:'client',payer:null}),
   validateInput:()=>{trace.push('validate');},classifyFailure:()=> 'temporary',identityKey:()=>op.identityKey},workerId:'worker',now:()=>at};
 return {due,snapshot,op,evidence,rail,deps,trace,at};
}
