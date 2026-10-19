import type { PostgresDataGatewayEnv } from "../data/index.js";
import type { NativeCommunicationsOptions, NativeDeliveryStore, NativeObservationKind } from "./nativeOperations.js";
import { nativeEmail, nativeFingerprint, nativeInteger, nativeStamp, nativeText, nativeTime, nativeTransactions } from "./postgresNativeOperations.js";
const kinds: NativeObservationKind[] = ["sent", "delayed", "delivered", "failed", "bounced", "complained"];
// Terminal/suppression precedence is monotonic; event chronology remains in the fact log.
const rank = (kind: NativeObservationKind | null) => kind === null ? -1 : kinds.indexOf(kind);
export function createPostgresDeliveryReconciliationPort(env: PostgresDataGatewayEnv, options: NativeCommunicationsOptions): NativeDeliveryStore {
  const binding = nativeText(options.binding);
  const lane = nativeTransactions(env, options, ["public.communication_native_sends", "public.communication_native_observations", "public.communication_recipient_consents"]);
  const store: NativeDeliveryStore = {
    close: lane.close,
    async registerNetworkTarget(input) {
      if (input.evidence !== "network_accepted" || input.messageId.startsWith("captured:")) throw new Error("native_network_acceptance_required");
      const values = [binding, nativeText(input.sourceKey), nativeText(input.messageId), nativeFingerprint(nativeEmail(input.recipientEmail)), nativeText(input.templateReference), nativeTime(input.acceptedAt)];
      return lane.run(async db => {
        await db.query(`INSERT INTO public.communication_native_sends (binding,source_key,message_id,recipient_fingerprint,template_reference,accepted_at)
          VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (binding,source_key) DO NOTHING`, values);
        const row = (await db.query(`SELECT * FROM public.communication_native_sends WHERE binding=$1 AND source_key=$2 FOR UPDATE`, values.slice(0,2))).rows[0];
        if (!row || row.message_id !== values[2] || row.recipient_fingerprint !== values[3] || row.template_reference !== values[4] || nativeStamp(row.accepted_at) !== values[5]) throw new Error("native_send_registration_conflict");
        return { id: nativeText(row.id) };
      });
    },
    findFrozenSends(input) {
      const now = nativeTime(input.now), limit = nativeInteger(input.limit,1,100), grace = nativeInteger(input.graceMinutes,0,10080);
      return lane.run(async db => (await db.query(`SELECT id,message_id FROM public.communication_native_sends
        WHERE binding=$1 AND abandoned_at IS NULL AND (observed_state IS NULL OR observed_state IN ('sent','delayed'))
        AND accepted_at <= $2::timestamptz - make_interval(mins => $3) ORDER BY last_poll_at NULLS FIRST, accepted_at,id LIMIT $4`, [binding,now,grace,limit])).rows.map(row => ({ id: nativeText(row.id), messageId: nativeText(row.message_id) })));
    },
    async applyObservation(input) {
      const kind = input.kind;
      if (!kinds.includes(kind) || !["poll","callback"].includes(input.source)) throw new Error("native_observation_invalid");
      const at = nativeTime(input.occurredAt), key = nativeText(input.observationKey), message = nativeText(input.messageId);
      const fingerprint = input.recipientEmail === null ? null : nativeFingerprint(nativeEmail(input.recipientEmail));
      await lane.run(async db => {
        const send = (await db.query("SELECT * FROM public.communication_native_sends WHERE id=$1 AND binding=$2 FOR UPDATE", [input.sendId,binding])).rows[0];
        if (!send || send.message_id !== message || (fingerprint !== null && send.recipient_fingerprint !== fingerprint)) throw new Error("native_observation_identity_conflict");
        const fact = nativeFingerprint(JSON.stringify([input.sendId,message,kind,at,send.recipient_fingerprint]));
        const inserted = await db.query(`INSERT INTO public.communication_native_observations (binding,observation_key,send_id,kind,occurred_at,source,fact_fingerprint)
          VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (binding,observation_key) DO NOTHING RETURNING observation_key`, [binding,key,input.sendId,kind,at,input.source,fact]);
        if (!inserted.rows.length) {
          const old = (await db.query("SELECT fact_fingerprint FROM public.communication_native_observations WHERE binding=$1 AND observation_key=$2", [binding,key])).rows[0];
          if (old?.fact_fingerprint !== fact) throw new Error("native_observation_replay_conflict");
          return;
        }
        if (rank(kind) > rank(send.observed_state as NativeObservationKind | null) || (kind === send.observed_state && at > nativeStamp(send.observed_at))) {
          await db.query("UPDATE public.communication_native_sends SET observed_state=$3,observed_at=$4 WHERE id=$1 AND binding=$2", [input.sendId,binding,kind,at]);
        }
        if (kind === "bounced" || kind === "complained") {
          for (const purpose of ["marketing_launch_offer","marketing_newsletter","tester_program"]) await db.query(`INSERT INTO public.communication_recipient_consents (recipient_fingerprint,purpose,state,captured_at,updated_at)
            VALUES ($1,$2,'suppressed',$3,$3) ON CONFLICT (recipient_fingerprint,purpose) DO UPDATE SET state='suppressed',updated_at=greatest(communication_recipient_consents.updated_at,excluded.updated_at)`, [send.recipient_fingerprint,purpose,at]);
        }
      });
    },
    applyPolledEvent(input) {
      return store.applyObservation({ sendId: input.sendId, messageId: input.messageId, observationKey: nativeFingerprint(JSON.stringify([input.sendId,input.eventType,nativeTime(input.eventAt)])), kind: input.eventType as NativeObservationKind, occurredAt: input.eventAt, recipientEmail: input.recipientEmail, source: "poll" });
    },
    async recordPollAttempt(input) {
      await lane.run(async db => {
        const result = await db.query("UPDATE public.communication_native_sends SET last_poll_at=greatest(last_poll_at,$3::timestamptz),not_found_count=0 WHERE id=$1 AND binding=$2 RETURNING id", [input.sendId,binding,nativeTime(input.attemptedAt)]);
        if (!result.rows.length) throw new Error("native_send_not_found");
      });
    },
    recordSendNotFound(input) {
      nativeInteger(input.threshold,1,100);
      return lane.run(async db => {
        const send = (await db.query("SELECT abandoned_at FROM public.communication_native_sends WHERE id=$1 AND binding=$2 FOR UPDATE", [input.sendId,binding])).rows[0];
        if (!send) throw new Error("native_send_not_found");
        const result = (await db.query(`UPDATE public.communication_native_sends SET not_found_count=least(not_found_count,2147483646)+1,last_poll_at=clock_timestamp(),
          abandoned_at=CASE WHEN not_found_count >= $3-1 THEN coalesce(abandoned_at,clock_timestamp()) ELSE abandoned_at END WHERE id=$1 AND binding=$2 RETURNING abandoned_at`, [input.sendId,binding,input.threshold])).rows[0]!;
        return { abandoned: send.abandoned_at === null && result.abandoned_at !== null };
      });
    },
    readEvidence(id) {
      return lane.run(async db => {
        const row = (await db.query("SELECT * FROM public.communication_native_sends WHERE id=$1 AND binding=$2", [id,binding])).rows[0];
        if (!row) return null;
        const observations = (await db.query("SELECT observation_key,kind,occurred_at,source FROM public.communication_native_observations WHERE send_id=$1 AND binding=$2 ORDER BY occurred_at,observation_key", [id,binding])).rows;
        return { id: nativeText(row.id), sourceKey: nativeText(row.source_key), messageId: nativeText(row.message_id), acceptedAt: nativeStamp(row.accepted_at),
          observedState: row.observed_state as NativeObservationKind | null, observedAt: row.observed_at === null ? null : nativeStamp(row.observed_at),
          lastPollAt: row.last_poll_at === null ? null : nativeStamp(row.last_poll_at), notFoundCount: nativeInteger(Number(row.not_found_count),0,2147483647), abandonedAt: row.abandoned_at === null ? null : nativeStamp(row.abandoned_at),
          observations: observations.map(fact => ({ key: nativeText(fact.observation_key), kind: fact.kind as NativeObservationKind, occurredAt: nativeStamp(fact.occurred_at), source: fact.source as "poll" | "callback" })) };
      });
    },
  };
  return store;
}
