import { z } from 'zod';
import type { PaymentRecoveryEvidence, PaymentAttemptStatus } from '@openlup/core/payment';
import type { CheckoutRecoveryWriteExecutor } from './postgresExpiredCheckoutRecovery.js';
import type { PaymentRecoverySnapshot,PaymentRecoverySnapshotPort } from './paymentRecoveryGuidance.js';
const id=z.guid(),text=z.string().min(1).max(240).nullable(),at=z.string().datetime({offset:true});
const state=z.enum(['dispatched','indeterminate','refused','expired','captured']);
const shape=z.object({snapshot:z.object({orderId:id,clientId:id,orderStatus:z.string(),paymentIntentId:id,
 intentStatus:z.enum(['created','failed','settled']),paymentAttemptId:id.nullable(),attemptStatus:state.nullable(),
 provider:z.literal('sandbox'),providerPaymentId:z.null(),updatedAt:at,failureReason:text,orderMode:z.enum(['one_time','subscription_cycle']),
 activationState:z.enum(['provisional','active','compensated']).nullable(),subscriptionId:id.nullable(),subscriptionStatus:text,
 paidAt:at.nullable(),hasExactGap:z.boolean()}).strict(),eligible:z.boolean(),tokenAuthorized:z.boolean(),observedSuccess:z.boolean(),historyComplete:z.boolean(),
 attempts:z.array(z.object({id,status:state,provider:z.literal('sandbox'),providerPaymentId:z.null(),providerFlow:z.null(),createdAt:at,
  evidence:z.array(z.unknown()).max(32)}).strict()).max(100)}).strict();
const statuses:Record<z.infer<typeof state>,PaymentAttemptStatus>={dispatched:'sent_to_provider',indeterminate:'processing',refused:'failed',expired:'expired',captured:'succeeded'};
/** One closed SQL read. Operational/malformed results throw so optional status reads can fall back. */
export function createPostgresPaymentRecoveryGuidancePort(db:CheckoutRecoveryWriteExecutor,
 normalize:(input:{provider:string;evidence:unknown[]})=>PaymentRecoveryEvidence|null):PaymentRecoverySnapshotPort{
 return{async getGuidanceSnapshot(input){
  let data:unknown;
  try{data=(await db.query('SELECT public.commerce_checkout_payment_guidance_snapshot($1::uuid,$2::uuid,$3::uuid) AS result',
   [input.orderId,input.paymentIntentId,input.recoveryTokenId??null])).rows[0]?.result;}catch{throw new Error('payment_recovery_snapshot_unavailable');}
  if(data===null)return null;
  if(data&&typeof data==='object'&&'refusal'in data&&data.refusal==='native_prepared_attempt_store_unsupported')throw new Error('native_prepared_attempt_store_unsupported');
  const parsed=shape.safeParse(data);if(!parsed.success)throw new Error('payment_recovery_snapshot_invalid');
  const {snapshot:s,...rest}=parsed.data;
  if(s.orderId!==input.orderId.toLowerCase()||s.paymentIntentId!==input.paymentIntentId.toLowerCase())throw new Error('payment_recovery_snapshot_identity_mismatch');
  const purchaseContext=rest.eligible?s.orderMode==='one_time'?'one_time':'subscription_initial':null;
  // Preserve the legacy display: no subscription or mandate state is fabricated
  // from a provisional declaration. Raw activation/gap facts remain available.
  const activation=s.orderMode==='subscription_cycle'&&s.subscriptionStatus==='active'?'active':'not_applicable';
  return{...s,...rest,purchaseContext,intentStatus:s.intentStatus==='settled'?'succeeded':s.intentStatus,
   attemptStatus:s.attemptStatus?statuses[s.attemptStatus]:null,subscriptionActivationStatus:activation,
   attempts:rest.attempts.map(a=>({id:a.id,status:statuses[a.status],provider:a.provider,providerFlow:a.providerFlow,
    evidence:rest.observedSuccess?null:a.evidence.length?normalize({provider:a.provider,evidence:a.evidence}):null}))};
 }};
}
