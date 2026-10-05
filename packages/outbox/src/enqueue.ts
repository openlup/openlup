/** @beta Caller executes this inside the same transaction as its domain write. */
export interface EnqueueEvent {
  aggregateType: string; aggregateId: string; eventType: string; idempotencyKey: string;
  payload: Record<string, unknown>; metadata?: Record<string, unknown>;
  availableAt?: string;
}
/** @beta Duplicate enqueue keeps the durable event identity; no independent commit. */
export function buildOutboxEnqueue(event: EnqueueEvent): { text: string; values: readonly unknown[] } {
  return {
    text: `insert into public.outbox_events (aggregate_type, aggregate_id, event_type, idempotency_key, payload, metadata, available_at)
values ($1, $2::uuid, $3, $4, $5::jsonb, $6::jsonb, coalesce($7::timestamptz, now()))
on conflict (event_type, idempotency_key) do nothing returning id::text`,
    values: [event.aggregateType, event.aggregateId, event.eventType, event.idempotencyKey, JSON.stringify(event.payload), JSON.stringify(event.metadata ?? {}), event.availableAt ?? null],
  };
}
