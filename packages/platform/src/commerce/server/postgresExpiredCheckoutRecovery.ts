import type { ExpiredCheckoutRecoveryWritePort } from './expiredCheckoutRecovery.js';
import { ExpiredCheckoutRecoveryError } from './expiredCheckoutRecovery.js';
export interface CheckoutRecoveryWriteExecutor { query(sql: string,values?: unknown[]): Promise<{rows:Record<string,unknown>[]}> }
/** Service executor only. No raw mutation or authority-bearing result is exposed. */
export function createPostgresExpiredCheckoutRecoveryPort(db: CheckoutRecoveryWriteExecutor,policy:{recoveryWindowMs:number;now?:()=>Date}): ExpiredCheckoutRecoveryWritePort {
 if(!Number.isSafeInteger(policy.recoveryWindowMs)||policy.recoveryWindowMs<=0)throw new Error('checkout_recovery_policy_invalid');
 return {async prepareReplacement(i){
  try{
   const value=(await db.query('SELECT public.commerce_prepare_expired_checkout_recovery($1::text,$2::uuid,$3::uuid,$4::bigint,$5::timestamptz) AS result',
    [i.idempotencyKey,i.sourceOrderId,i.replacementOrderId,policy.recoveryWindowMs,(policy.now?.()??new Date()).toISOString()])).rows[0]?.result;
   if(typeof value!=='object'||value===null||!('replacementOrderId'in value)||typeof value.replacementOrderId!=='string'||!('replayed'in value)||typeof value.replayed!=='boolean')throw new Error('invalid');
   return{replacementOrderId:value.replacementOrderId,replayed:value.replayed};
  }catch(error){const message=error instanceof Error?error.message:'';
   if(message==='native_prepared_attempt_store_unsupported')throw new ExpiredCheckoutRecoveryError('unavailable','native_prepared_attempt_store_unsupported');
   if(message==='commerce_expired_recovery_order_changed')throw new ExpiredCheckoutRecoveryError('order_changed');
   throw new ExpiredCheckoutRecoveryError('unavailable');
  }
 }};
}
