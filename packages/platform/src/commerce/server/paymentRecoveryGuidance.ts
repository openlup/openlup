import { derivePaymentRecoveryGuidance, type PaymentRecoveryAttempt, type PaymentRecoveryGuidance, type PaymentIntentStatus, type PaymentAttemptStatus } from '@openlup/core/payment';
import type { CheckoutPaymentContinuationClaims } from './checkoutPaymentContinuationCredential.js';
import type { CheckoutRecoveryTokenPort } from './checkoutRecoveryToken.js';

export interface PaymentRecoveryStatusSnapshot {
 orderId:string;clientId:string;orderStatus:string;paymentIntentId:string;intentStatus:PaymentIntentStatus;
 paymentAttemptId:string|null;attemptStatus:PaymentAttemptStatus|null;provider:string|null;providerPaymentId:string|null;
 updatedAt:string;failureReason:string|null;subscriptionId:string|null;
 subscriptionActivationStatus:'not_applicable'|'waiting_for_mandate'|'active'|'action_required';
}
export interface PaymentRecoverySnapshot extends PaymentRecoveryStatusSnapshot {
 eligible:boolean;purchaseContext:'one_time'|'subscription_initial'|null;subscriptionStatus:string|null;
 tokenAuthorized:boolean;historyComplete:boolean;observedSuccess:boolean;
 /** Native lifecycle facts do not imply a mandate or change the legacy presentation. */
 activationState?:string|null;hasExactGap?:boolean;paidAt?:string|null;
 attempts:(PaymentRecoveryAttempt&{provider?:string;providerFlow?:string|null})[];
}
export interface PaymentRecoverySnapshotPort {
 getGuidanceSnapshot(input:{orderId:string;paymentIntentId:string;recoveryTokenId?:string}):Promise<PaymentRecoverySnapshot|null>;
}
export interface CheckoutPaymentRecoveryGuidance {
 version:1;paymentAttemptId:string;purchaseContext:'one_time'|'subscription_initial';
 cause:PaymentRecoveryGuidance['cause'];methodKind:string|null;methodKey:string|null;operation:PaymentRecoveryGuidance['operation'];
 restriction:'method'|'instrument'|'operation'|null;actions:PaymentRecoveryGuidance['actions'][number][];
 consecutiveRefusals:PaymentRecoveryGuidance['consecutiveRefusals'];emphasis:PaymentRecoveryGuidance['emphasis'];
}
export type PaymentRecoveryReadStatus='paid'|'failed'|'expired'|'pending';
export interface PaymentRecoveryReadDeps {
 port:PaymentRecoverySnapshotPort;tokenPort?:Pick<CheckoutRecoveryTokenPort,'validate'>;
 /** The host retains its existing display policy, without inferring new evidence. */
 projectGuidance?(snapshot:PaymentRecoverySnapshot,status:PaymentRecoveryReadStatus,projected:PaymentRecoveryGuidance|null):CheckoutPaymentRecoveryGuidance|null;
}
/** Optional inspection only. Read errors invoke the host's unchanged legacy reader. */
export async function readAuthorizedPaymentRecovery(input:{
 request:{orderId:string;clientId:string;paymentIntentId:string;journeyId?:string};
 claims:CheckoutPaymentContinuationClaims|null;authorization:unknown;deps:PaymentRecoveryReadDeps;now?:number;
}):Promise<{snapshot:PaymentRecoverySnapshot;guidance:CheckoutPaymentRecoveryGuidance|null}|null>{
 const {request,claims,deps}=input;
 const cookieBound=Boolean(claims&&claims.expiresAt>(input.now??Date.now())/1000&&claims.orderId===request.orderId
  &&claims.clientId===request.clientId&&claims.paymentIntentId===request.paymentIntentId&&claims.journeyId===request.journeyId);
 try{
  const raw=typeof input.authorization==='string'&&input.authorization.length<=2048?/^Bearer (\S+)$/i.exec(input.authorization)?.[1]:undefined;
  const token=raw&&deps.tokenPort?await deps.tokenPort.validate(raw):null;
  const tokenBound=token?.orderId===request.orderId&&token?.clientId===request.clientId;
  if(!cookieBound&&!tokenBound)return null;
  const snapshot=await deps.port.getGuidanceSnapshot({orderId:request.orderId,paymentIntentId:request.paymentIntentId,
   ...(tokenBound&&token?{recoveryTokenId:token.tokenId}:{})});
  if(!snapshot||snapshot.orderId!==request.orderId||snapshot.paymentIntentId!==request.paymentIntentId||snapshot.clientId!==request.clientId)return null;
  const authorized=(cookieBound&&snapshot.paymentAttemptId===claims?.paymentAttemptId&&snapshot.provider===claims?.executionRail)
   ||(tokenBound&&snapshot.tokenAuthorized);
  if(!authorized||!snapshot.eligible||!snapshot.purchaseContext||snapshot.observedSuccess)return{snapshot,guidance:null};
  const status:PaymentRecoveryReadStatus=snapshot.intentStatus==='succeeded'||snapshot.orderStatus==='paid'?'paid'
   :snapshot.intentStatus==='expired'||snapshot.attemptStatus==='expired'?'expired'
   :snapshot.intentStatus==='failed'||snapshot.intentStatus==='cancelled'||['blocked_preflight','failed','cancelled'].includes(snapshot.attemptStatus??'')?'failed':'pending';
  const projected=derivePaymentRecoveryGuidance({paymentState:status,activeAttemptId:snapshot.paymentAttemptId,
   attempts:snapshot.attempts,historyComplete:snapshot.historyComplete});
  if(deps.projectGuidance)return{snapshot,guidance:deps.projectGuidance(snapshot,status,projected)};
  if(!projected)return{snapshot,guidance:null};
  return{snapshot,guidance:{version:1,paymentAttemptId:projected.paymentAttemptId,purchaseContext:snapshot.purchaseContext,
   cause:projected.cause,methodKind:projected.method?.kind??null,methodKey:projected.method?.recoveryMethodKey??null,
   operation:projected.operation,restriction:projected.advice?.code==='do_not_try_again'&&projected.advice.scope!=='unknown'?projected.advice.scope:null,
   actions:[...projected.actions],consecutiveRefusals:projected.consecutiveRefusals,emphasis:projected.emphasis}};
 }catch{return null;}
}
