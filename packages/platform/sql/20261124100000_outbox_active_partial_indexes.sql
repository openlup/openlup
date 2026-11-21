-- Partial indexes scoped to active outbox rows so claim, per-aggregate
-- ordering, and pending event-type checks stay O(active rows) even when
-- terminal ('processed', 'discarded') rows are retained indefinitely.
CREATE INDEX IF NOT EXISTS idx_outbox_events_active_claim
  ON public.outbox_events (status, available_at, created_at, id)
  WHERE status IN ('pending', 'failed');

CREATE INDEX IF NOT EXISTS idx_outbox_events_active_aggregate_order
  ON public.outbox_events (aggregate_type, aggregate_id, created_at, id)
  WHERE status IN ('pending', 'processing', 'failed');

CREATE INDEX IF NOT EXISTS idx_outbox_events_active_event_type
  ON public.outbox_events (event_type)
  WHERE status IN ('pending', 'processing', 'failed');
