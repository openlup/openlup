import { createHash } from "node:crypto";
import type { PgQueryExecutor, PostgresDataGatewayOptions } from "@openlup/platform/data";
import { createPostgresDeliveryReconciliationPort, type NativeDeliveryStore, type NativeObservationKind } from "@openlup/platform/communications";
import { createPostgresCommunicationsControlPlaneTransactionLane } from "../../adapters/postgres/dataGateway.js";
import type { ResendWebhookPort } from "../../domains/communications/resendWebhookHandler.js";
const eventKinds:Record<string,NativeObservationKind>={"email.sent":"sent","email.delivery_delayed":"delayed","email.delivered":"delivered","email.bounced":"bounced","email.complained":"complained","email.failed":"failed"};
/** Called only after the existing route's raw-body signature and environment admission. */
export function createNativeWebhookPort(store:Pick<NativeDeliveryStore,"findByMessageId"|"applyObservation">):ResendWebhookPort {
 return {findEmailSendByResendId:messageId=>store.findByMessageId(messageId),recordAttempt:async()=>{},async applyProviderEvent(event){
  const kind=eventKinds[event.resendEventType];if(!kind)return;
  const key=typeof event.metadata.providerEventId==="string"?event.metadata.providerEventId:createHash("sha256").update(JSON.stringify([event.resendId,event.resendEventType,event.eventAt])).digest("hex");
  await store.applyObservation({sendId:event.emailSendId,messageId:event.resendId,observationKey:key,kind,occurredAt:event.eventAt,recipientEmail:null,source:"callback"});
 }};
}
export function createRuntimeNativeWebhookPort(env:Record<string,string|undefined>):ResendWebhookPort {
 const binding=env.COMMUNICATIONS_BINDING?.trim(),connectionString=env.DATABASE_URL?.trim();
 if(env.PLATFORM_BUNDLE!=="node-postgres"||!binding||!connectionString)throw new Error("native_webhook_binding_required");
 const using=async<T>(work:(store:NativeDeliveryStore)=>Promise<T>)=>{const store=createPostgresDeliveryReconciliationPort({connectionString},{binding});try{return await work(store);}finally{await store.close();}};
 return {findEmailSendByResendId:id=>using(store=>store.findByMessageId(id)),applyProviderEvent:event=>using(store=>createNativeWebhookPort(store).applyProviderEvent(event)),recordAttempt:async()=>{}};
}
/** Admin-only installation diagnostics. Decision snapshots are installation scoped, not binding scoped. */
export function createNativeEvidenceBinding(env:Record<string,string|undefined>,options:PostgresDataGatewayOptions & {operatorId:string}) {
 const connectionString=env.DATABASE_URL?.trim(),binding=env.COMMUNICATIONS_BINDING?.trim();
 if(env.PLATFORM_BUNDLE!=="node-postgres"||!connectionString||!binding||!options.operatorId)throw new Error("native_evidence_binding_required");
 const lane=createPostgresCommunicationsControlPlaneTransactionLane({connectionString},options);
 const delivery=createPostgresDeliveryReconciliationPort({connectionString},{...options,binding});
 return {close:async()=>{await Promise.all([lane.close(),delivery.close()]);},async read(){
  return lane.run(async gateway=>{
   const db=gateway as PgQueryExecutor;
   const allowed=(await db.query(`SELECT o.principal_id FROM public.platform_communication_operators o JOIN public.platform_human_memberships m USING(principal_id)
    WHERE o.principal_id=$1 AND o.active AND m.role='admin' AND m.membership_state='active'
    AND NOT EXISTS(SELECT 1 FROM public.platform_control_operators c WHERE c.principal_id=o.principal_id) FOR SHARE OF o,m`,[options.operatorId])).rows;
   if(allowed.length!==1)throw new Error("communications_admin_required");
   const safe=(await db.query(`SELECT current_user NOT IN ('anon','authenticated','authenticator') AND NOT EXISTS (
    SELECT 1 FROM unnest($1::text[]) t(name), pg_roles r WHERE r.rolname IN ('anon','authenticated','authenticator')
    AND (has_table_privilege(r.oid,t.name,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege(r.oid,t.name,'SELECT,INSERT,UPDATE,REFERENCES')))
    AND NOT EXISTS (SELECT 1 FROM unnest($1::text[]) t(name),pg_class c,LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE c.oid=t.name::regclass AND a.grantee=0)
    AND NOT EXISTS (SELECT 1 FROM unnest($1::text[]) t(name),pg_attribute c,LATERAL aclexplode(c.attacl) a WHERE c.attrelid=t.name::regclass AND a.grantee=0) AS safe`,[["public.communication_native_sync_state","public.communication_native_policy_decisions","public.outbox_events"]])).rows[0];
   if(safe?.safe!==true)throw new Error("native_evidence_privileges_unsafe");
   const sends=await delivery.listEvidence({limit:50});
   const sync=(await db.query("SELECT e.id,e.status FROM public.outbox_events e JOIN public.communication_native_sync_state s ON s.work_id=e.id WHERE s.binding=$1 ORDER BY e.created_at DESC,e.id DESC LIMIT 50",[binding])).rows;
   const decisions=(await db.query("SELECT id,allowed,reason FROM public.communication_native_policy_decisions ORDER BY evaluated_at DESC,id DESC LIMIT 50")).rows;
   return {binding,candidate:env.APP_RELEASE_SHA??"unknown",schema:env.COMMUNICATIONS_SCHEMA_IDENTITY??"unknown",sends,sync,decisions};
  });
 }};
}
