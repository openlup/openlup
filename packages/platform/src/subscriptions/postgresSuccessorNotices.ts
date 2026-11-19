import { z } from "zod";
import type { OutboxEventRow, OutboxHandlerOutcome } from "@openlup/core/outbox";
import type { NativeRenewalCodec, SubscriptionQueryExecutor } from "./postgresRenewalStore.js";
import { subscriptionRecord } from "./postgresRenewalStore.js";
import { nativeStockWaitDeficits } from "./postgresStockWaitStore.js";
import { createSubscriptionLifecycleMessages, subscriptionLifecycleTemplate } from "./lifecycleMessages.js";
import type { SubscriptionLifecycleMessagePort, SubscriptionLifecycleFact, SubscriptionLifecycleMessageDescriptor } from "./contracts/messages.js";
import { nativeWaitDeficitSchema, successorCaseReadSchema, successorScheduleKey } from "./postgresSuccessorStore.js";

const noticeObligations = z.array(z.object({
  family: z.enum(["template", "pending_activation", "frozen_renewal", "outstanding_order", "replacement", "stock_wait", "graduation"]),
  sourceId: z.guid(), caseKind: z.enum(["legacy", "successor"]).optional(),
}));
const messageField = z.string().refine(value => value.trim().length > 0);
const waitMessage = z.looseObject({ from: messageField, to: messageField, subject: messageField, html: messageField });
const waitEvent = z.looseObject({ caseId: z.guid(), clientId: z.guid(), subscriptionId: z.guid(),
  deficits: z.array(nativeWaitDeficitSchema).default([]) });
const successorWaitEvent = waitEvent.extend({ schemaVersion: z.literal(2), caseKind: z.literal("successor"), operationId: z.guid(),
  scheduledAt: z.iso.datetime({ offset: true }), deficits: z.array(nativeWaitDeficitSchema) });

/** Inert source registrations. A host binds these to its existing outbox worker.
 * @experimental
 */
export const successorNoticeSources = Object.freeze([
  "catalog.publication.committed", "subscription_stock_wait.opened.v1", "subscription_stock_wait.opened.v2",
  "subscription.successor.offered.v2", "subscription.predecessor_withdrawn.v2",
  "subscription_stock_wait.started", "subscription_stock_wait.resumed",
  "subscription_stock_wait.started.v2", "subscription_stock_wait.resumed.v2",
] as const);

/** Source claims must be committed before invocation. Commerce commits its handoff
 * before M04 enqueue; a crash between enqueue and source acknowledgement replays
 * the same message key. Construction registers no worker or capability.
 * @experimental
 */
export function createPostgresSuccessorNotices(options: {
  withTransaction<T>(work: (db: SubscriptionQueryExecutor) => Promise<T>): Promise<T>;
  /** Decode frozen content for notices of the versioned renewal dialect. */
  renewalCodec?: Pick<NativeRenewalCodec, "decode">;
  /** Optional presentation eviction after verifying the persisted commit event. */
  invalidateCatalogueProduct?(productId: string): void;
  /** Bind the catalogue owner's complete withdrawal-impact port. */
  impact: { report(skuId:string): Promise<
    { outcome:"complete"; obligations:readonly { family:string;sourceId:string;caseKind?:"legacy"|"successor" }[] }
    | { outcome:"unknown"|"unavailable";reason:string }> };
  /** Native M04 receipts share this store. */
  delivery: SubscriptionLifecycleMessagePort;
  /** The store freezes rendered stock-wait copy before invoking the transport.
   * @experimental
   */
  stockWaitDelivery?: {
    render(descriptor: SubscriptionLifecycleMessageDescriptor): Promise<z.input<typeof waitMessage>>;
    send(input: { messageKey: string; templateSlug: string; message: z.output<typeof waitMessage> }): Promise<void>;
  };
  recipient(clientId: string): Promise<{ recipientRef: string; locale: string } | null>;
}) {
  const delivery=createSubscriptionLifecycleMessages(options.delivery),id=z.uuid();
  async function persisted(db:SubscriptionQueryExecutor,row:OutboxEventRow) {
    const saved=(await db.query(`SELECT payload=$3::jsonb AS matching FROM public.outbox_events
      WHERE id=$1::uuid AND event_type=$2 AND aggregate_type=$4 AND aggregate_id=$5::uuid AND idempotency_key=$6`,
    [z.guid().parse(row.id),row.event_type,row.payload,row.aggregate_type,z.guid().parse(row.aggregate_id),row.idempotency_key])).rows[0];
    if(saved?.matching!==true)throw new Error("subscription_lifecycle_source_binding_changed");
  }
  async function acceptedReceipt(db:SubscriptionQueryExecutor,messageKey:string) {
    const receipt=(await db.query("SELECT state FROM public.transactional_delivery_read_receipt($1::text)",[messageKey])).rows[0];
    return receipt?.state==="accepted";
  }
  async function notice(db:SubscriptionQueryExecutor,caseId:string,caseKind:"legacy"|"successor",publicationId:string|null) {
    const result=(await db.query("SELECT public.subscription_successor_notice_v2($1::uuid,$2::text,$3::uuid) AS result",[id.parse(caseId),caseKind,publicationId])).rows[0]?.result;
    const record=subscriptionRecord(result);
    if(record.outcome!=="handed_off"&&record.outcome!=="obsolete")throw new Error("subscription_lifecycle_handoff_unavailable");
    return record;
  }
  async function complete(row:OutboxEventRow):Promise<OutboxHandlerOutcome> {
    if(["subscription_stock_wait.started","subscription_stock_wait.resumed",
      "subscription_stock_wait.started.v2","subscription_stock_wait.resumed.v2"].includes(row.event_type)) {
      const successor=row.event_type.endsWith(".v2"),kind=successor?"successor":"legacy";
      const table=successor?"subscription_successor_wait_cases_v2":"subscription_stock_wait_cases";
      const parsed=(successor?successorWaitEvent:waitEvent).safeParse(row.payload);
      if(!parsed.success||successor&&row.metadata.source!=="subscription_stock_wait")return {kind:"discard",reason:"stock_wait_notice_contract_invalid"};
      const payload=parsed.data,started=row.event_type.startsWith("subscription_stock_wait.started");
      const readCase=async(db:SubscriptionQueryExecutor)=>{
        const value=(await db.query("SELECT public.subscription_stock_wait_read_v2($1::uuid,$2::text) AS result",[payload.caseId,kind])).rows[0]?.result;
        const envelope=successorCaseReadSchema.safeParse(value);
        if(!envelope.success||envelope.data.caseKind!==kind)throw new Error("stock_wait_notice_case_mismatch");
        const current=envelope.data.case;
        if(row.aggregate_type!=="subscription_stock_wait"||row.aggregate_id!==payload.caseId||current.id!==payload.caseId
          ||current.client_id!==payload.clientId||current.subscription_id!==payload.subscriptionId
          ||successor&&(current.operation_id!==payload.operationId
            ||successorScheduleKey(current.subscription_id,current.scheduled_at)!==successorScheduleKey(payload.subscriptionId,String(payload.scheduledAt))))
          throw new Error("stock_wait_notice_case_mismatch");
        if(!started&&current.state!=="resumed")throw new Error("stock_wait_resume_milestone_missing");
        const relevant=successor?envelope.data.waitingNoticeRelevant:current.waitingNoticeRelevant;
        return { current,obsolete:started&&(current.state!=="waiting"||relevant!==true) };
      };
      const messageSchema=(value:unknown)=>{
        const message=waitMessage.safeParse(value);
        if(!message.success)throw new Error("stock_wait_notice_message_invalid");
        return message.data;
      };
      const checked=await options.withTransaction(async db=>{
        await persisted(db,row);
        if(await acceptedReceipt(db,row.idempotency_key))return {kind:"accepted"} as const;
        const {current,obsolete}=await readCase(db);
        if(obsolete)return {kind:"obsolete"} as const;
        const stored=(await db.query(`SELECT notice_messages->$2::text AS message FROM public.${table} WHERE id=$1::uuid`,
          [payload.caseId,row.id])).rows[0]?.message;
        if(stored!=null)return {kind:"frozen",message:messageSchema(stored)} as const;
        const codec=options.renewalCodec;
        const wire=!successor&&codec
          ? (await db.query("SELECT cycle_snapshot FROM public.subscription_stock_wait_cases WHERE id=$1::uuid",[payload.caseId])).rows[0]?.cycle_snapshot
          : null;
        const snapshot=codec&&wire&&subscriptionRecord(wire).frozenRevision==="native.purchase-renewal.v3"
          ? codec.decode(subscriptionRecord(wire)):undefined;
        const observed=await nativeStockWaitDeficits(db,started?current.deficits:payload.deficits,snapshot);
        if(observed.some(item=>!z.guid().safeParse(item.skuId).success||!item.displayName.trim()))throw new Error("stock_wait_notice_contract_invalid");
        const deficits=observed.filter(value=>value.missing>0);
        if(started&&deficits.length===0)return {kind:"empty"} as const;
        return {kind:"ready",current,deficits} as const;
      });
      if(checked.kind==="accepted")return {kind:"processed",detail:{dedupe:"email_already_sent"}};
      if(checked.kind==="obsolete")return {kind:"processed",detail:{skipped:"stock_wait_notice_obsolete"}};
      if(checked.kind==="empty")return {kind:"discard",reason:"stock_wait_notice_missing_deficits"};
      const factKind=started?"stock_wait_started":"stock_wait_resumed",templateSlug=subscriptionLifecycleTemplate(factKind);
      const waitDelivery=options.stockWaitDelivery;
      if(!templateSlug)throw new Error("subscription_lifecycle_message_unsupported");
      if(checked.kind==="frozen"){
        if(!waitDelivery)throw new Error("stock_wait_notice_binding_unavailable");
        await waitDelivery.send({messageKey:row.idempotency_key,templateSlug,message:checked.message});
        return {kind:"processed"};
      }
      const recipient=await options.recipient(payload.clientId);
      if(!recipient)return {kind:"retry",reason:"stock_wait_notice_recipient_unresolved"};
      if(!waitDelivery)throw new Error("stock_wait_notice_binding_unavailable");
      const current=checked.current;
      const fact:SubscriptionLifecycleFact={factId:row.id,idempotencyKey:row.idempotency_key,subscriptionId:payload.subscriptionId,clientId:payload.clientId,
        cycleId:current.cycle_id,caseId:payload.caseId,orderId:current.order_id,occurredAt:row.created_at,firstRecordedAt:row.created_at,
        kind:factKind,frozenFingerprint:current.fingerprint,deficits:checked.deficits};
      const rendered=messageSchema(await waitDelivery.render({fact,templateSlug,messageKey:row.idempotency_key,...recipient,recoveryUrlPath:null}));
      const bound=await options.withTransaction(async db=>{
        const {rows}=await db.query(`SELECT id FROM public.${table} WHERE id=$1::uuid FOR UPDATE NOWAIT`,[payload.caseId]);
        if(rows.length!==1)throw new Error("stock_wait_notice_case_mismatch");
        const {obsolete}=await readCase(db);
        if(obsolete)return null;
        const bound=successor?await db.query(`UPDATE public.subscription_successor_wait_cases_v2
          SET notice_messages=jsonb_set(notice_messages,ARRAY[$2::text],COALESCE(notice_messages->$2::text,$3::jsonb))
          WHERE id=$1::uuid RETURNING notice_messages->$2::text AS message`,[payload.caseId,row.id,rendered])
          :await db.query("SELECT public.subscription_stock_wait_bind_notice($1::uuid,$2::uuid,$3::jsonb) AS message",[payload.caseId,row.id,rendered]);
        if(bound.rows.length!==1)throw new Error("stock_wait_notice_binding_unavailable");
        return messageSchema(bound.rows[0]?.message);
      });
      if(!bound)return {kind:"processed",detail:{skipped:"stock_wait_notice_obsolete"}};
      await waitDelivery.send({messageKey:row.idempotency_key,templateSlug,message:bound});
      return {kind:"processed"};
    }
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
        const members=state.skus.map(value=>id.parse(subscriptionRecord(value).skuId));
        if(!members.length)throw new Error("catalog_obligation_evidence_unknown");
        const owned=await db.query("SELECT id FROM public.catalog_skus WHERE product_id=$1::uuid AND id=ANY($2::uuid[])",[row.aggregate_id,members]);
        if(owned.rows.length!==members.length)throw new Error("catalog_obligation_evidence_unknown");
        return members;
      });
      options.invalidateCatalogueProduct?.(row.aggregate_id);
      const cases=new Map<string,{ id:string;kind:"legacy"|"successor";implicitLegacy:boolean }>();
      for(const sku of skus) {
        const impact=await options.impact.report(sku);
        if(impact.outcome!=="complete")throw new Error(impact.reason);
        const parsed=noticeObligations.safeParse(impact.obligations);
        if(!parsed.success)throw new Error("catalog_obligation_evidence_unknown");
        const seen=new Set<string>();
        for(const obligation of parsed.data)if(obligation.family==="stock_wait") {
          const kind=obligation.caseKind??"legacy";
          const key=`${kind}:${obligation.sourceId}`;
          if(seen.has(key))throw new Error("catalog_obligation_evidence_unknown");
          seen.add(key);
          const prior=cases.get(key);
          cases.set(key,{ id:obligation.sourceId,kind,implicitLegacy:prior?.implicitLegacy===true||obligation.caseKind===undefined });
        }
      }
      if(cases.size>0)await options.withTransaction(async db=>{
        const ids=[...new Set([...cases.values()].map(entry=>entry.id))];
        const { rows }=await db.query(`SELECT source_id,
          EXISTS(SELECT 1 FROM public.subscription_stock_wait_cases WHERE id=source_id) AS legacy,
          EXISTS(SELECT 1 FROM public.subscription_successor_wait_cases_v2 WHERE id=source_id) AS successor
          FROM unnest($1::uuid[]) AS source(source_id)`,[ids]);
        const bound=new Map(rows.map(row=>[row.source_id,row]));
        if (rows.length!==ids.length || bound.size!==ids.length || [...cases.values()].some(entry=>{
          const row=bound.get(entry.id);
          return row?.[entry.kind]!==true || entry.implicitLegacy&&row.successor!==false;
        })) throw new Error("catalog_obligation_evidence_unknown");
      });
      for(const entry of cases.values())await options.withTransaction(db=>notice(db,entry.id,entry.kind,publicationId));
      return { kind:"processed" };
    }
    if(row.event_type==="subscription.predecessor_withdrawn.v2"||row.event_type==="subscription.successor.offered.v2") {
      const payload=row.payload;
      const applicable=await options.withTransaction(async db=>{
        await persisted(db,row);
        if(await acceptedReceipt(db,row.idempotency_key))return "accepted" as const;
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
      if(applicable==="accepted")return {kind:"processed",detail:{dedupe:"email_already_sent"}};
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
