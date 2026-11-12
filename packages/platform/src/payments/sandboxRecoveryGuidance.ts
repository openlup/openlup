import { z } from 'zod';
import type { PaymentRecoveryEvidence } from '@openlup/core/payment';
const evidence=z.object({version:z.literal(1),source:z.enum(['observation','event','reconciliation']),sourceId:z.guid(),
 paymentAttemptId:z.guid(),paymentIntentId:z.guid(),observationId:z.guid(),outcome:z.enum(['captured','refused','expired','indeterminate']),refusalVerified:z.boolean()}).strict();
/** Native observations prove only the outcome, never a method, operation or provider advice. */
export function normalizeSandboxPaymentRecoveryEvidence(input:{provider:string;evidence:unknown[]}):PaymentRecoveryEvidence|null{
 if(input.provider!=='sandbox')throw new Error('native_prepared_attempt_store_unsupported');
 if(!input.evidence.length||input.evidence.length>32)return null;
 const entries=input.evidence.map(value=>evidence.safeParse(value));
 if(entries.some(e=>!e.success))return null;
 const rows=entries.map(e=>e.data!);
 if(rows.some(e=>!e.refusalVerified||e.outcome!=='refused')||new Set(rows.map(e=>e.paymentAttemptId)).size!==1
  ||new Set(rows.map(e=>e.paymentIntentId)).size!==1)return null;
 return{refusalVerified:true,cause:'generic_decline',certainty:'unknown',disclosure:'safe',method:null,operation:null,advice:null};
}
