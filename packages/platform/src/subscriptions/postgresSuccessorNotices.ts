import { z } from "zod";
import type { OutboxEventRow, OutboxHandlerOutcome } from "@openlup/core/outbox";
import type { SubscriptionQueryExecutor } from "./postgresRenewalStore.js";
import { subscriptionRecord } from "./postgresRenewalStore.js";
import { createSubscriptionLifecycleMessages } from "./lifecycleMessages.js";
import type { SubscriptionLifecycleMessagePort, SubscriptionLifecycleFact } from "./contracts/messages.js";

/** Inert source registrations. A host binds these to its existing outbox worker.
 * @experimental
 */
export const successorNoticeSources = Object.freeze([
  "catalog.publication.committed", "subscription_stock_wait.opened.v1", "subscription_stock_wait.opened.v2",
  "subscription.successor.offered.v2", "subscription.predecessor_withdrawn.v2",
] as const);

/** Source claims must be committed before invocation. Commerce commits its handoff
 * before M04 enqueue; a crash between enqueue and source acknowledgement replays
 * the same message key. Construction registers no worker or capability.
 * @experimental
 */
export function createPostgresSuccessorNotices(options: {
  withTransaction<T>(work: (db: SubscriptionQueryExecutor) => Promise<T>): Promise<T>;
  /** Bind the catalogue owner's complete withdrawal-impact port. */
  impact: { report(skuId:string): Promise<
    { outcome:"complete"; obligations:readonly { family:string;sourceId:string;caseKind?:"legacy"|"successor" }[] }
    | { outcome:"unknown"|"unavailable";reason:string }> };
  delivery: SubscriptionLifecycleMessagePort;
  recipient(clientId: string): Promise<{ recipientRef: string; locale: string } | null>;
}) {
  const delivery=createSubscriptionLifecycleMessages(options.delivery),id=z.uuid();
  async function persisted(db:SubscriptionQueryExecutor,row:OutboxEventRow) {
    const saved=(await db.query(`SELECT payload=$3::jsonb AS matching FROM public.outbox_events
      WHERE id=$1::uuid AND event_type=$2 AND aggregate_type=$4 AND aggregate_id=$5::uuid AND idempotency_key=$6`,
    [id.parse(row.id),row.event_type,row.payload,row.aggregate_type,id.parse(row.aggregate_id),row.idempotency_key])).rows[0];
    if(saved?.matching!==true)throw new Error("subscription_lifecycle_source_binding_changed");
  }
  async function notice(db:SubscriptionQueryExecutor,caseId:string,caseKind:"legacy"|"successor",publicationId:string|null) {
    const result=(await db.query("SELECT public.subscription_successor_notice_v2($1::uuid,$2::text,$3::uuid) AS result",[id.parse(caseId),caseKind,publicationId])).rows[0]?.result;
    const record=subscriptionRecord(result);
    if(record.outcome!=="handed_off"&&record.outcome!=="obsolete")throw new Error("subscription_lifecycle_handoff_unavailable");
    return record;
  }
  async function complete(row:OutboxEventRow):Promise<OutboxHandlerOutcome> {
    if(row.event_type==="subscription_stock_wait.opened.v1"||row.event_type==="subscription_stock_wait.opened.v2") {
      const kind=row.event_type.endsWith(".v1")?"legacy":"successor";
      if(kind==="successor"&&(row.payload.schemaVersion!==2||row.payload.caseKind!==kind))throw new Error("stock_wait_binding_changed");
      await options.withTransaction(async db=>{
        await persisted(db,row);
        const table=kind==="legacy"?"subscription_stock_wait_cases":"subscription_successor_wait_cases_v2";
        const operation=kind==="legacy"?"renewal_operation_id":"operation_id";
        const bound=(await db.query(`SELECT id FROM public.${table} WHERE id=$1::uuid AND ${operation}=$2::uuid
          AND subscription_id=$3::uuid AND client_id=$4::uuid AND fingerprint=$5 AND identity_key=$6 AND scheduled_at=$7::timestamptz`,
        [row.payload.caseId,row.payload.operationId,row.payload.subscriptionId,row.payload.clientId,row.payload.frozenFingerprint,row.payload.identityKey,row.payload.scheduledAt])).rows;
        if(bound.length!==1||row.aggregate_id!==row.payload.caseId)throw new Error("stock_wait_binding_changed");
        await notice(db,String(row.payload.caseId),kind,null);
      });
      return { kind:"processed" };
    }
    if(row.event_type==="catalog.publication.committed") {
      const publicationId=id.parse(subscriptionRecord(row.payload.head).publicationId);
      const skus=await options.withTransaction(async db=>{
        await persisted(db,row);
        const publication=(await db.query("SELECT canonical_state FROM public.catalog_publications WHERE id=$1::uuid AND product_id=$2::uuid AND digest=$3",[publicationId,row.aggregate_id,row.payload.digest])).rows[0];
        if(!publication)throw new Error("catalog_obligation_evidence_unknown");
        const state=subscriptionRecord(JSON.parse(String(publication.canonical_state)));
        if(!Array.isArray(state.skus))throw new Error("catalog_obligation_evidence_unknown");
        return state.skus.map(value=>id.parse(subscriptionRecord(value).skuId));
      });
      const cases=new Map<string,{ id:string;kind:"legacy"|"successor" }>();
      for(const sku of skus) {
        const impact=await options.impact.report(sku);
        if(impact.outcome!=="complete")throw new Error(impact.reason);
        for(const obligation of impact.obligations)if(obligation.family==="stock_wait") {
          const kind=obligation.caseKind??"legacy";
          cases.set(`${kind}:${obligation.sourceId}`,{ id:obligation.sourceId,kind });
        }
      }
      for(const entry of cases.values())await options.withTransaction(db=>notice(db,entry.id,entry.kind,publicationId));
      return { kind:"processed" };
    }
    if(row.event_type==="subscription.predecessor_withdrawn.v2"||row.event_type==="subscription.successor.offered.v2") {
      const payload=row.payload;
      const applicable=await options.withTransaction(async db=>{
        await persisted(db,row);
        if(row.aggregate_id!==payload.subscriptionId)throw new Error("subscription_lifecycle_source_binding_changed");
        if(row.event_type==="subscription.successor.offered.v2") {
          const proposal=(await db.query("SELECT state,expires_at>clock_timestamp() AS fresh FROM public.subscription_successor_proposals WHERE id=$1::uuid AND subscription_id=$2::uuid AND client_id=$3::uuid AND quote_hash=$4",
            [id.parse(payload.proposalId),row.aggregate_id,id.parse(payload.clientId),payload.quoteHash])).rows[0];
          if(!proposal)throw new Error("successor_proposal_binding_changed");
          return proposal.state==="offered"&&proposal.fresh===true;
        }
        if(payload.caseKind!=="legacy"&&payload.caseKind!=="successor")throw new Error("stock_wait_case_kind_invalid");
        const current=await notice(db,String(payload.caseId),payload.caseKind,id.parse(payload.withdrawalPublicationId));
        if(current.outcome==="obsolete")return false;
        if(!Array.isArray(current.notices)||!current.notices.some(value=>subscriptionRecord(value).noticeId===row.id))throw new Error("subscription_lifecycle_message_identity_mismatch");
        return true;
      });
      if(!applicable)return { kind:"processed",detail:{ obsolete:true } };
      const recipient=await options.recipient(id.parse(payload.clientId));
      if(!recipient)throw new Error("subscription_notice_recipient_unresolved");
      const common={ factId:row.id,idempotencyKey:row.idempotency_key,subscriptionId:id.parse(payload.subscriptionId),clientId:id.parse(payload.clientId),
        cycleId:null,caseId:payload.caseId==null?null:id.parse(payload.caseId),orderId:null,occurredAt:row.created_at,firstRecordedAt:row.created_at };
      const fact:SubscriptionLifecycleFact=row.event_type==="subscription.predecessor_withdrawn.v2"
        ? { ...common,kind:"predecessor_withdrawn",frozenFingerprint:z.string().regex(/^[a-f0-9]{64}$/u).parse(payload.frozenFingerprint),withdrawalPublicationId:id.parse(payload.withdrawalPublicationId),predecessors:z.array(z.object({ skuId:id,skuCode:z.string().min(1) }).strict()).min(1).parse(payload.predecessors) }
        : { ...common,kind:"successor_offered",proposalId:id.parse(payload.proposalId),predecessorSkuId:id.parse(payload.predecessorSkuId),successorSkuId:id.parse(payload.successorSkuId),quoteHash:z.string().regex(/^[a-f0-9]{64}$/u).parse(payload.quoteHash),expiresAt:z.iso.datetime({ offset:true }).parse(payload.expiresAt) };
      await delivery.deliver({ fact,messageKey:row.idempotency_key,...recipient,recoveryUrlPath:null });
      return { kind:"processed" };
    }
    return { kind:"discard",reason:"subscription_lifecycle_source_unsupported" };
  }
  return { async handle(row:OutboxEventRow):Promise<OutboxHandlerOutcome> {
    try{return await complete(row);}catch(error){ return { kind:"retry",reason:error instanceof Error?error.message:"subscription_lifecycle_dependency_unavailable" }; }
  } };
}
