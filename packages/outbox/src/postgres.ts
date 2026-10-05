import type { SqlExecutor, RequiredSchema } from "@openlup/core/readiness";
import type { OutboxStore, OutboxEventRow, OutboxMarkFailedStatus } from "./contracts.js";
import type { CompactionPort } from "./factory.js";
/** @beta These identities describe the shipped default adapter only. */
export const POSTGRES_OUTBOX_SCHEMA: RequiredSchema = {
  version: "outbox-1", migration: "sql/0001_outbox.sql", objects: [
    { kind: "table", name: "public.outbox_events" }, { kind: "table", name: "public.outbox_dormant_event_types" },
    ...["id", "created_at", "available_at", "processed_at", "aggregate_type", "aggregate_id", "event_type", "idempotency_key", "status", "attempts", "payload", "error", "metadata"].map((name) => ({ kind: "column" as const, name: `public.outbox_events.${name}` })),
    { kind: "function", name: "public.outbox_claim_batch", signature: "text[],text[],integer,integer,integer" },
    { kind: "function", name: "public.outbox_mark_processed", signature: "uuid,text,jsonb" },
    { kind: "function", name: "public.outbox_mark_failed", signature: "uuid,text,text,text,integer,integer,integer,integer" },
    { kind: "function", name: "public.outbox_release_unprocessed", signature: "uuid[],text[],integer" },
    { kind: "function", name: "pg_catalog.pg_input_is_valid", signature: "text,text" },
  ],
};
/** @beta Supply an autocommit executor or a per-operation transaction that commits before resolve.
 * Never pass a producer transaction or retain an operation transaction across handler I/O. */
export function createPostgresOutboxStore(executor: SqlExecutor): OutboxStore {
  const scalar = async (text: string, values: readonly unknown[]): Promise<unknown> => {
    const { rows } = await executor.query(text, values);
    if (rows.length !== 1 || !Object.hasOwn(rows[0], "value")) throw new Error("outbox_store_invalid_scalar");
    return rows[0].value;
  };
  return {
    async claimBatch(input) {
      const { rows } = await executor.query(`select id::text, to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at,
to_char(available_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as available_at,
to_char(processed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as processed_at,
aggregate_type, aggregate_id::text, event_type, idempotency_key, status, attempts, payload, error, metadata
from public.outbox_claim_batch($1::text[], $2::text[], $3::integer, $4::integer, $5::integer)`,
      [input.eventTypes, input.knownEventTypes ?? [], input.batchSize, input.visibilitySeconds, input.maxAttempts]);
      return rows as unknown as OutboxEventRow[];
    },
    async markProcessed(input) {
      const value = await scalar("select public.outbox_mark_processed($1::uuid, $2::text, $3::jsonb) as value", [input.eventId, input.claimToken, JSON.stringify(input.metadata ?? {})]);
      if (typeof value !== "boolean") throw new Error("outbox_mark_processed_invalid_response");
      return { applied: value };
    },
    async markFailed(input) {
      const value = await scalar("select public.outbox_mark_failed($1::uuid,$2::text,$3::text,$4::text,$5::integer,$6::integer,$7::integer,$8::integer) as value", [input.eventId,input.claimToken,input.error,input.outcome,input.baseDelaySeconds,input.maxDelaySeconds,input.maxAttempts,input.snoozeSeconds]);
      if (!["failed","discarded","snoozed","missed"].includes(String(value))) throw new Error("outbox_mark_failed_unexpected_status");
      return { status: value as OutboxMarkFailedStatus };
    },
    async releaseUnprocessed(items, delaySeconds) {
      if (!items.length) return 0;
      const value = await scalar("select public.outbox_release_unprocessed($1::uuid[],$2::text[],$3::integer) as value", [items.map((i) => i.eventId),items.map((i) => i.claimToken),delaySeconds]);
      if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new Error("outbox_release_invalid_response");
      return value;
    },
    async hasPendingEventType(eventType) {
      const value = await scalar("select exists (select 1 from public.outbox_events where event_type=$1 and status in ('pending','failed','processing')) as value", [eventType]);
      if (typeof value !== "boolean") throw new Error("outbox_pending_invalid_response");
      return value;
    },
  };
}
/** @beta Compacts terminal payload/error, retaining the event and its unique key. */
export function createPostgresOutboxCompactor(executor: SqlExecutor): CompactionPort {
  return { async compact(input) {
    const { rows } = await executor.query(`with targets as (
  select id from public.outbox_events
  where metadata->>'retentionCompactedAt' is null and (
    (status = 'processed' and coalesce(processed_at, created_at) < now() - make_interval(days => $1::integer))
    or (status = 'discarded' and case when pg_catalog.pg_input_is_valid(metadata->>'discardedAt', 'timestamp with time zone')
      then (metadata->>'discardedAt')::timestamptz else null end < now() - make_interval(days => $2::integer)))
  order by created_at, id limit $3::integer for update skip locked
), compacted as (
  update public.outbox_events e set payload = '{}'::jsonb, error = null,
    metadata = e.metadata || jsonb_build_object('retentionCompactedAt', now(), 'retentionCompactedBy', 'outbox_compact_terminal', 'retentionCompactedStatus', e.status)
  from targets t where e.id = t.id returning e.id
) select count(*)::integer as value from compacted`, [input.processedDays,input.discardedDays,input.limit]);
    const value = rows[0]?.value;
    if (rows.length !== 1 || typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new Error("outbox_compaction_invalid_response");
    return value;
  } };
}
