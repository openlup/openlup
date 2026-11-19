\set ON_ERROR_STOP on
\if :{?history_rows}
\else
  \set history_rows 100000
\endif
\if :{?variant}
\else
  \set variant baseline
\endif

SELECT :'variant' IN ('baseline', 'prior', 'pair') AS valid_variant,
  :'variant' IN ('prior', 'pair') AS prior_index, :'variant' = 'pair' AS due_index
\gset
\if :valid_variant
\else
  DO $$ BEGIN RAISE EXCEPTION 'Unknown variant. Use baseline, prior, or pair.'; END; $$;
\endif

BEGIN;
SET LOCAL jit = off;
SET LOCAL TIME ZONE 'UTC';
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '3min';

DO $$
BEGIN
  IF to_regclass('public.outbox_events') IS NOT NULL THEN
    RAISE EXCEPTION 'Run this benchmark against an empty disposable database';
  END IF;
END;
$$;

\ir ../../packages/outbox/sql/0001_outbox.sql

-- One target event per aggregate, old terminal rows for those aggregates, and
-- ready work for another known handler. Handler I/O is intentionally absent.
INSERT INTO public.outbox_events (
  created_at, available_at, processed_at, aggregate_type, aggregate_id, event_type,
  idempotency_key, status, payload, metadata
)
SELECT
  now() - interval '90 days' + n * interval '1 second',
  now() - interval '90 days',
  now() - interval '90 days' + (n + 60) * interval '1 second',
  'synthetic', md5((n % 1000)::text)::uuid, 'synthetic.target',
  'history-' || n, 'processed', '{}'::jsonb,
  jsonb_build_object('retentionCompactedAt', now() - interval '1 day')
FROM generate_series(1, :'history_rows'::integer) AS n;

INSERT INTO public.outbox_events (
  created_at, available_at, aggregate_type, aggregate_id, event_type, idempotency_key, payload
)
SELECT now() - n * interval '1 second', now() - n * interval '1 second',
  'synthetic', md5((n % 1000)::text)::uuid, 'synthetic.other',
  'other-' || n, jsonb_build_object('sequence', n)
FROM generate_series(1, 20000) AS n
UNION ALL
SELECT now() - n * interval '1 hour', now() - n * interval '1 hour',
  'synthetic', md5((n % 1000)::text)::uuid, 'synthetic.target',
  'target-' || n, jsonb_build_object('sequence', n)
FROM generate_series(1, 1000) AS n;

\if :prior_index
  CREATE INDEX claim_benchmark_prior
    ON public.outbox_events (aggregate_type, aggregate_id, created_at, id, event_type, status)
    WHERE status IN ('pending', 'failed', 'processing');
\endif
\if :due_index
  CREATE INDEX claim_benchmark_due
    ON public.outbox_events (event_type, status, available_at, created_at, id)
    WHERE status IN ('pending', 'failed', 'processing');
\endif
ANALYZE public.outbox_events;

SELECT current_setting('server_version') AS postgres, status, event_type, count(*) AS rows,
  round(avg(pg_column_size(e)), 1) AS avg_row_bytes,
  max(now() - available_at) FILTER (WHERE status = 'pending') AS oldest_ready_age
FROM public.outbox_events e
GROUP BY status, event_type ORDER BY status, event_type;

CREATE FUNCTION pg_temp.drain_outbox_sample(label text)
RETURNS TABLE (variant text, batches integer, processed integer, ms numeric, events_per_second numeric,
  table_bytes bigint, index_bytes bigint)
LANGUAGE plpgsql AS $$
DECLARE
  started timestamptz := clock_timestamp();
  elapsed_seconds numeric;
  event public.outbox_events;
  batch_rows integer;
BEGIN
  variant := label;
  batches := 0;
  processed := 0;
  LOOP
    batch_rows := 0;
    FOR event IN SELECT * FROM public.outbox_claim_batch(
      ARRAY['synthetic.target'], ARRAY['synthetic.other'], 25, 300, 8
    ) LOOP
      IF NOT public.outbox_mark_processed(event.id, event.metadata->>'claimToken') THEN
        RAISE EXCEPTION 'A new claim could not be acknowledged';
      END IF;
      batch_rows := batch_rows + 1;
    END LOOP;
    EXIT WHEN batch_rows = 0;
    batches := batches + 1;
    processed := processed + batch_rows;
  END LOOP;
  IF processed <> 1000 THEN
    RAISE EXCEPTION 'Unexpected drain count %', processed;
  END IF;
  elapsed_seconds := extract(epoch FROM clock_timestamp() - started);
  ms := round(elapsed_seconds * 1000, 3);
  events_per_second := round(processed / NULLIF(elapsed_seconds, 0));
  table_bytes := pg_table_size('public.outbox_events');
  index_bytes := pg_indexes_size('public.outbox_events');
  RETURN NEXT;
END;
$$;

-- Capture the actual nested exhausted-row and candidate plans on one
-- representative batch per variant, without logging the timed drain.
LOAD 'auto_explain';
SET LOCAL auto_explain.log_level = 'notice';
SET LOCAL auto_explain.log_analyze = on;
SET LOCAL auto_explain.log_buffers = on;
SET LOCAL auto_explain.log_nested_statements = on;
SET LOCAL auto_explain.log_timing = off;

\echo Claim plan for :variant
SAVEPOINT nested_plan;
SET LOCAL auto_explain.log_min_duration = 0;
SELECT count(*) FROM public.outbox_claim_batch(ARRAY['synthetic.target'], ARRAY['synthetic.other'], 25, 300, 8);
ROLLBACK TO nested_plan;

SELECT * FROM pg_temp.drain_outbox_sample(:'variant');
ROLLBACK;
