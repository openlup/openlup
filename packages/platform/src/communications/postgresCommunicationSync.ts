import type { SqlExecutor } from "@openlup/core/readiness";
import type { PostgresDataGatewayEnv } from "../data/index.js";
import type { CommunicationSyncStore } from "./communicationSyncWorker.js";
import type { NewsletterSyncEvent, NewsletterSyncEventType, NewsletterMarketingPurpose } from "./contracts/newsletter.js";
import type { NativeCommunicationsOptions } from "./nativeOperations.js";
import { nativeEmail, nativeFingerprint, nativeInteger, nativeJson, nativeStamp, nativeText, nativeTransactions } from "./postgresNativeOperations.js";

/** Structural seam for the existing outbox store, scoped to this operation's transaction. */
export interface NativeSyncRail {
  claimBatch(input: { eventTypes: string[]; knownEventTypes: string[]; batchSize: number; visibilitySeconds: number; maxAttempts: number }): Promise<{ id: string; attempts: number; metadata: Record<string, unknown> }[]>;
  markProcessed(input: { eventId: string; claimToken: string; metadata?: Record<string, unknown> }): Promise<{ applied: boolean }>;
  markFailed(input: { eventId: string; claimToken: string; error: string; outcome: "retry" | "discard"; baseDelaySeconds: number; maxDelaySeconds: number; maxAttempts: number; snoozeSeconds: number }): Promise<{ status: string }>;
}
export interface NativeSyncRegistration {
  sourceKey: string; contactId: string; normalizedEmail: string; eventType: NewsletterSyncEventType;
  purpose: NewsletterMarketingPurpose; payload?: Record<string, unknown>;
  originProviderKind?: string | null; originProviderEventId?: string | null;
  remoteProfileId?: string | null; remoteListId?: string | null;
}
export interface NativeSyncOptions extends NativeCommunicationsOptions {
  providerKind: string;
  rail: (db: SqlExecutor) => NativeSyncRail;
}
export interface NativeCommunicationSyncStore extends CommunicationSyncStore {
  registerWork(input: NativeSyncRegistration): Promise<{ id: string }>;
  registerPreference(input: {email:string;purpose:"tester_program"|NewsletterMarketingPurpose;state:"denied"|"suppressed"}): Promise<{updated:true;email:string;purpose:"tester_program"|NewsletterMarketingPurpose;state:"denied"|"suppressed";workId:string|null;alreadySuppressed:boolean}>;
  close(): Promise<void>;
}
export const nativeSyncEventType = (binding: string): string => `communication.native.sync.${nativeFingerprint(nativeText(binding))}`;
function nativeSyncRegistration(options: Pick<NativeSyncOptions,"binding"|"providerKind">, input: NativeSyncRegistration): (db: SqlExecutor) => Promise<{id:string}> {
  const binding=nativeText(options.binding),provider=nativeText(options.providerKind),eventType=nativeSyncEventType(binding);
      const email = nativeEmail(input.normalizedEmail), source = nativeText(input.sourceKey), contact = nativeText(input.contactId);
      if (!["subscribe","update","unsubscribe","suppress"].includes(input.eventType) || !["marketing_launch_offer","marketing_newsletter"].includes(input.purpose)) throw new Error("native_sync_event_invalid");
      const payload = nativeJson(input.payload ?? {});
      const refs = [input.originProviderKind ?? null,input.originProviderEventId ?? null,input.remoteProfileId ?? null,input.remoteListId ?? null].map(value => value === null ? null : nativeText(value));
      const fact = nativeFingerprint(JSON.stringify([provider,contact,email,input.eventType,input.purpose,payload,...refs]));
      // Reuse the rail's ordering barrier for successive preferences of one contact/target.
      const aggregate = nativeFingerprint(JSON.stringify([binding,provider,contact])).slice(0,32);
  return async db => {
        // One rail identity for each source event and exact target binding.
        await db.query(`INSERT INTO public.outbox_events (aggregate_type,aggregate_id,event_type,idempotency_key,payload)
          VALUES ('communication_native_sync',$4::uuid,$1,$2,$3::jsonb) ON CONFLICT (event_type,idempotency_key) DO NOTHING`, [eventType,source,payload,aggregate]);
        const work = (await db.query("SELECT id FROM public.outbox_events WHERE event_type=$1 AND idempotency_key=$2 FOR UPDATE", [eventType,source])).rows[0]!;
        await db.query(`INSERT INTO public.communication_native_sync_state
          (work_id,binding,provider_kind,contact_id,normalized_email,purpose,event_kind,origin_provider_kind,origin_provider_event_id,remote_profile_id,remote_list_id,command_fingerprint)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (work_id) DO NOTHING`, [work.id,binding,provider,contact,email,input.purpose,input.eventType,...refs,fact]);
        const state = (await db.query("SELECT command_fingerprint FROM public.communication_native_sync_state WHERE work_id=$1", [work.id])).rows[0];
        if (state?.command_fingerprint !== fact) throw new Error("native_sync_registration_conflict");
        return { id: nativeText(work.id) };
  };
}
/** Trusted host transaction seam; registration validation remains shared with the standalone store. */
export async function registerNativeSyncWorkInTransaction(db: SqlExecutor, options: Pick<NativeSyncOptions,"binding"|"providerKind">, input: NativeSyncRegistration): Promise<{id:string}> {
  return nativeSyncRegistration(options,input)(db);
}

/** No sidecar claim/lease/drainer. Only runCommunicationSyncDispatch executes membership effects. */
export function createPostgresCommunicationSyncStore(env: PostgresDataGatewayEnv, options: NativeSyncOptions): NativeCommunicationSyncStore {
  const binding = nativeText(options.binding), provider = nativeText(options.providerKind), eventType = nativeSyncEventType(binding);
  const lane = nativeTransactions(env, options, ["public.communication_native_sync_state","public.outbox_events","public.communication_recipient_consents"]);
  const checkProvider = (value: string) => { if (value !== provider) throw new Error("native_sync_binding_conflict"); };
  return {
    close: lane.close,
    async registerWork(input) {
      const register=nativeSyncRegistration(options,input);
      return lane.run(db => register(db as SqlExecutor));
    },
    registerPreference(input) {
      const email=nativeEmail(input.email),fingerprint=nativeFingerprint(email),purpose=nativeText(input.purpose);
      if (!["tester_program","marketing_launch_offer","marketing_newsletter"].includes(purpose) || !["denied","suppressed"].includes(input.state)) throw new Error("native_preference_invalid");
      return lane.run(async db=>{
        await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[JSON.stringify([fingerprint,purpose])]);
        const old=(await db.query("SELECT state,updated_at FROM public.communication_recipient_consents WHERE recipient_fingerprint=$1 AND purpose=$2 FOR UPDATE",[fingerprint,purpose])).rows[0];
        const row=old?.state===input.state?old:(await db.query(`INSERT INTO public.communication_recipient_consents (recipient_fingerprint,purpose,state)
          VALUES ($1,$2,$3) ON CONFLICT (recipient_fingerprint,purpose) DO UPDATE SET state=excluded.state,updated_at=clock_timestamp() RETURNING state,updated_at`,[fingerprint,purpose,input.state])).rows[0]!;
        let workId:string|null=null;
        if(purpose!=="tester_program"){
          const sourceKey=nativeFingerprint(JSON.stringify([fingerprint,purpose,input.state,nativeStamp(row.updated_at)]));
          workId=(await registerNativeSyncWorkInTransaction(db as SqlExecutor,options,{sourceKey,contactId:fingerprint,normalizedEmail:email,eventType:input.state==="suppressed"?"suppress":"unsubscribe",purpose:purpose as NewsletterMarketingPurpose})).id;
        }
        return {updated:true as const,email,purpose:purpose as "tester_program"|NewsletterMarketingPurpose,state:input.state,workId,alreadySuppressed:old?.state===input.state};
      });
    },
    claimBatch(input) {
      checkProvider(input.providerKind);
      nativeInteger(input.batchSize,1,100); nativeInteger(input.visibilitySeconds,60,3600); nativeInteger(input.maxAttempts,1,20);
      return lane.run(async db => {
        const work = await options.rail(db as SqlExecutor).claimBatch({ eventTypes: [eventType], knownEventTypes: [eventType], batchSize: input.batchSize,visibilitySeconds: input.visibilitySeconds,maxAttempts: input.maxAttempts });
        const events: NewsletterSyncEvent[] = [];
        for (const row of work) {
          const state = (await db.query("UPDATE public.communication_native_sync_state SET max_attempts=$4 WHERE work_id=$1 AND binding=$2 AND provider_kind=$3 RETURNING *", [row.id,binding,provider,input.maxAttempts])).rows[0];
          if (!state) throw new Error("native_sync_sidecar_missing");
          const payload = (await db.query("SELECT payload FROM public.outbox_events WHERE id=$1", [row.id])).rows[0]!.payload;
          nativeJson(payload);
          events.push({ id: nativeText(row.id), claimToken: nativeText(row.metadata.claimToken), contactId: nativeText(state.contact_id), normalizedEmail: nativeEmail(state.normalized_email), eventType: state.event_kind as NewsletterSyncEventType,
            purpose: state.purpose as NewsletterMarketingPurpose,payload: payload as Record<string,unknown>, attemptCount: nativeInteger(row.attempts-1,0,19),
            originProviderKind: state.origin_provider_kind as string | null,originProviderEventId: state.origin_provider_event_id as string | null,remoteProfileId: state.remote_profile_id as string | null,remoteListId: state.remote_list_id as string | null });
        }
        return events;
      });
    },
    markSent(input) {
      checkProvider(input.providerKind);
      const summary = nativeJson(input.responseSummary ?? {}), remote = input.remoteProfileId == null ? null : nativeText(input.remoteProfileId);
      return lane.run(async db => {
        const row = (await db.query(`SELECT e.id FROM public.outbox_events e JOIN public.communication_native_sync_state s ON s.work_id=e.id
          WHERE e.id=$1 AND s.binding=$2 AND s.provider_kind=$3 AND e.event_type=$4 AND e.status='processing' AND e.metadata->>'claimToken'=$5 FOR UPDATE OF e,s`, [input.eventId,binding,provider,eventType,input.claimToken])).rows[0];
        if (!row) return false;
        if (!(await options.rail(db as SqlExecutor).markProcessed({ eventId: input.eventId,claimToken: input.claimToken })).applied) throw new Error("native_sync_ack_lost");
        await db.query("UPDATE public.communication_native_sync_state SET remote_profile_id=$2,response_summary=$3::jsonb WHERE work_id=$1", [input.eventId,remote,summary]);
        return true;
      });
    },
    markFailed(input) {
      checkProvider(input.providerKind); nativeInteger(input.backoffSeconds,0,86400);
      return lane.run(async db => {
        const row = (await db.query(`SELECT s.max_attempts FROM public.outbox_events e JOIN public.communication_native_sync_state s ON s.work_id=e.id
          WHERE e.id=$1 AND s.binding=$2 AND s.provider_kind=$3 AND e.event_type=$4 AND e.status='processing' AND e.metadata->>'claimToken'=$5 FOR UPDATE OF e,s`, [input.eventId,binding,provider,eventType,input.claimToken])).rows[0];
        if (!row) return false;
        const result = await options.rail(db as SqlExecutor).markFailed({ eventId: input.eventId,claimToken: input.claimToken,error: nativeText(input.error,2000),outcome: input.retry ? "retry" : "discard",baseDelaySeconds: input.backoffSeconds,maxDelaySeconds: input.backoffSeconds,maxAttempts: nativeInteger(Number(row.max_attempts),1,20),snoozeSeconds: 300 });
        if (!["failed","discarded"].includes(result.status)) throw new Error("native_sync_ack_lost");
        await db.query("UPDATE public.communication_native_sync_state SET response_summary=$2::jsonb WHERE work_id=$1", [input.eventId,JSON.stringify({ status: result.status })]);
        return true;
      });
    },
  };
}
