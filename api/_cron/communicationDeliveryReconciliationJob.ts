import { createPostgresDeliveryReconciliationPort, type NativeObservationKind } from "@openlup/platform/communications";
import type { PgQueryExecutor } from "@openlup/platform/data";
import { createPostgresPlatformJobTransactionLane } from "../../server/adapters/postgres/dataGateway.js";
import { createPostgresPlatformJobRunLedger } from "../../server/adapters/postgres/platformJobRunLedger.js";
import { runResendDeliveryReconciliation, type ResendEmailStatusRead } from "../../server/domains/communications/resendDeliveryReconciliationWorker.js";
const kinds:Record<string,NativeObservationKind>={"email.sent":"sent","email.delivery_delayed":"delayed","email.delivered":"delivered","email.bounced":"bounced","email.complained":"complained","email.failed":"failed"};
/** Existing job ledger only. No timer, independent lock or new queue. */
export async function runNativeCommunicationJob(env:Record<string,string|undefined>,name:string,leaseSeconds:number,work:()=>Promise<{checked:number;updated?:number;reconciled?:number;failures:number;[key:string]:unknown}>) {
 const connectionString=env.DATABASE_URL?.trim();if(!connectionString||!env.COMMUNICATIONS_BINDING?.trim())return {status:503,body:{ok:false,error:"native_communications_binding_required"}};
 const lane=createPostgresPlatformJobTransactionLane({connectionString});
 const invocation={triggerKind:"scheduler" as const,invocationSource:"node-reference"};
 try{
  const lease=await lane.run(db=>createPostgresPlatformJobRunLedger(db as PgQueryExecutor,env).claimJobRun(name,invocation,leaseSeconds));
  if(!lease.acquired||!lease.runId)return {status:200,body:{ok:true,skipped:true,reason:lease.reason}};
  try{
   const result=await work();
   const finished=await lane.run(db=>createPostgresPlatformJobRunLedger(db as PgQueryExecutor,env).finishJobRun(name,lease.runId!,invocation,result.failures?"failed":"success",{checked:result.checked,updated:result.updated??result.reconciled??0,failures:result.failures,skipped:false}));
   if(!finished)throw new Error("native_job_lease_lost");
   return {status:result.failures?502:200,body:{ok:result.failures===0,...result}};
  }catch{
   await lane.run(db=>createPostgresPlatformJobRunLedger(db as PgQueryExecutor,env).finishJobRun(name,lease.runId!,invocation,"failed",{checked:0,updated:0,failures:1,skipped:false,reason:"native_communications_job_failed"}));
   return {status:500,body:{ok:false,error:"native_communications_job_failed"}};
  }
 }catch{return {status:503,body:{ok:false,error:"native_communications_job_unavailable"}};}finally{await lane.close();}
}
export function runNativeDeliveryReconciliationJob(env:Record<string,string|undefined>,jobName:string,readEmail:(id:string)=>Promise<ResendEmailStatusRead>) {
 return runNativeCommunicationJob(env,jobName,600,async()=>{
  const store=createPostgresDeliveryReconciliationPort({connectionString:env.DATABASE_URL!},{binding:env.COMMUNICATIONS_BINDING!});
  try{return {...await runResendDeliveryReconciliation({now:new Date().toISOString(),limit:50,graceMinutes:45,readEmail,port:{
   findFrozenSends:async input=>(await store.findFrozenSends(input)).map(row=>({id:row.id,resendId:row.messageId,status:null})),
   recordPollAttempt:input=>store.recordPollAttempt(input),recordSendNotFound:input=>store.recordSendNotFound(input),
   applyPolledEvent:input=>{const kind=kinds[input.webhookType];if(!kind)throw new Error("native_poll_observation_invalid");return store.applyPolledEvent({sendId:input.sendId,messageId:input.resendId,eventType:kind,eventAt:input.eventAt,recipientEmail:input.recipientEmail});},
  }}),graceMinutes:45};}finally{await store.close();}
 });
}
