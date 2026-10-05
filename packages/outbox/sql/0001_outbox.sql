-- Public platform communications outbox rail: the queue table, the dormant-event-type
-- allowlist, and the claim/ack protocol that drains them.
--
-- WHAT THIS FORWARD SHIPS, AND WHY IT IS THE FIRST ONE CARRYING FUNCTIONS.
-- The baseline and the read-parity forward both hold `grep -c 'CREATE FUNCTION'` = 0 on
-- purpose. This migration breaks that property deliberately, because the dispatch rail
-- has no non-RPC surface: claim is an atomic `UPDATE ... FOR UPDATE SKIP LOCKED` that
-- hands back a claim token and evaluates a per-aggregate ordering barrier inside the same
-- statement. Expressing it through the gateway's query builder would mean reimplementing
-- pessimistic locking in the application, i.e. a second and divergent rail. Four functions
-- is the whole crossing: no privilege model, no `private` schema, no queue statistics, no
-- pruning, no preview-matrix claim scope, and above all no enqueue -- rows are written by
-- capabilities that own their own business logic, and none of them is authored here.
--
-- AUTHORED, NOT COPIED. The protocol below was written for this migration against the
-- observable contract the platform outbox store port issues (five named RPC arguments sets,
-- a boolean/text/integer/SETOF return shape). It is not a cut of any historical migration:
-- the provider-specific idempotency window and the hardcoded product event-type vocabulary
-- that the managed implementation calls into are absent, the preview-matrix claim scope is
-- absent, row-level security and role grants are absent because this kernel creates no
-- roles to grant to, `SECURITY DEFINER` is absent for the same reason, every constraint is
-- named rather than left to a generated identifier, and `CREATE` is unconditional because a
-- manifest-ordered forward runs exactly once against a known prefix -- `IF NOT EXISTS` there
-- would hide the drift the migration ledger exists to catch. `SET search_path` is kept: it
-- is a real injection-hardening property that does not depend on a role model.

CREATE TABLE public.outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  available_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  event_type text NOT NULL,
  idempotency_key text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  payload jsonb NOT NULL,
  error text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT outbox_events_aggregate_type_nonempty_check CHECK (btrim(aggregate_type) <> ''),
  CONSTRAINT outbox_events_event_type_nonempty_check CHECK (btrim(event_type) <> ''),
  CONSTRAINT outbox_events_idempotency_key_nonempty_check CHECK (btrim(idempotency_key) <> ''),
  CONSTRAINT outbox_events_attempts_check CHECK (attempts >= 0),
  CONSTRAINT outbox_events_status_check
    CHECK (status IN ('pending', 'processing', 'processed', 'failed', 'discarded')),
  CONSTRAINT outbox_events_event_type_idempotency_key_key UNIQUE (event_type, idempotency_key)
);

CREATE INDEX idx_outbox_events_status_available
  ON public.outbox_events (status, available_at);

CREATE INDEX idx_outbox_events_aggregate
  ON public.outbox_events (aggregate_type, aggregate_id);

-- The claim barrier below refuses to skip an older unprocessed row for the same aggregate,
-- INCLUDING one whose event type the caller does not know about. Without a way to declare a
-- type intentionally unconsumed, a single retired producer would stall its aggregate
-- forever. This table is that declaration, and it ships empty: which types are dormant is
-- operator data, not platform content.
CREATE TABLE public.outbox_dormant_event_types (
  event_type text PRIMARY KEY,
  owner text NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT outbox_dormant_event_types_event_type_nonempty_check CHECK (btrim(event_type) <> ''),
  CONSTRAINT outbox_dormant_event_types_owner_nonempty_check CHECK (btrim(owner) <> ''),
  CONSTRAINT outbox_dormant_event_types_reason_nonempty_check CHECK (btrim(reason) <> '')
);

-- Claim a batch for one allowlist of event types.
--
-- Three properties make this more than a SELECT, and each is load-bearing:
--   1. an empty allowlist is refused, never widened -- a caller that forgot its filter must
--      not drain every event type on the instance;
--   2. rows whose attempts already reached the ceiling are discarded before the scan, so an
--      exhausted row cannot be re-selected on every tick;
--   3. per aggregate, an older unprocessed row blocks the newer one. A prior of an event
--      type the caller neither claims nor knows also blocks, unless it has been declared
--      dormant -- ordering within an aggregate is the guarantee producers rely on.
-- The claim token written into metadata is the authorization for every later acknowledgement:
-- knowing the row id is not enough, which is what makes a stale ack detectable rather than
-- destructive.
CREATE FUNCTION public.outbox_claim_batch(
  p_event_types text[],
  p_known_event_types text[] DEFAULT ARRAY[]::text[],
  p_batch_size integer DEFAULT 25,
  p_visibility_seconds integer DEFAULT 300,
  p_max_attempts integer DEFAULT 8
)
RETURNS SETOF public.outbox_events
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_batch integer := LEAST(GREATEST(COALESCE(p_batch_size, 25), 1), 100);
  v_visibility integer := LEAST(GREATEST(COALESCE(p_visibility_seconds, 300), 300), 3600);
  v_max integer := LEAST(GREATEST(COALESCE(p_max_attempts, 8), 1), 20);
  v_known text[];
BEGIN
  IF p_event_types IS NULL OR cardinality(p_event_types) = 0 THEN
    RAISE EXCEPTION 'outbox_claim_allowlist_required' USING ERRCODE = '22023';
  END IF;

  -- Everything the caller can recognise: what it claims now, plus what it declares it knows
  -- about. A prior outside this set is treated as foreign, and only the dormant table can
  -- release it.
  SELECT array_agg(DISTINCT event_type)
    INTO v_known
    FROM unnest(COALESCE(p_known_event_types, ARRAY[]::text[]) || p_event_types) AS known(event_type)
   WHERE event_type IS NOT NULL AND btrim(event_type) <> '';

  WITH exhausted AS (
    SELECT event.id
      FROM public.outbox_events event
     WHERE event.event_type = ANY (p_event_types)
       AND event.status IN ('pending', 'failed', 'processing')
       AND event.available_at <= now()
       AND event.attempts >= v_max
     ORDER BY event.created_at, event.id
     LIMIT 100
     FOR UPDATE SKIP LOCKED
  )
  UPDATE public.outbox_events event
     SET status = 'discarded',
         error = left(COALESCE(event.error, '') || ' | max_attempts_exhausted_at_claim', 2000),
         metadata = event.metadata || jsonb_build_object(
           'discardReason', 'max_attempts',
           'discardedAt', now(),
           'finalAttempts', event.attempts)
    FROM exhausted
   WHERE event.id = exhausted.id;

  RETURN QUERY
  WITH candidates AS (
    SELECT event.id
      FROM public.outbox_events event
     WHERE event.event_type = ANY (p_event_types)
       AND event.available_at <= now()
       AND event.status IN ('pending', 'failed', 'processing')
       AND event.attempts < v_max
       AND NOT EXISTS (
             SELECT 1
               FROM public.outbox_events prior
              WHERE prior.aggregate_type = event.aggregate_type
                AND prior.aggregate_id = event.aggregate_id
                AND prior.status IN ('pending', 'failed', 'processing')
                AND (prior.created_at, prior.id) < (event.created_at, event.id)
                AND (
                  prior.event_type = ANY (p_event_types)
                  OR (
                    prior.event_type <> ALL (COALESCE(v_known, ARRAY[]::text[]))
                    AND NOT EXISTS (
                          SELECT 1
                            FROM public.outbox_dormant_event_types dormant
                           WHERE dormant.event_type = prior.event_type
                        )
                  )
                ))
     ORDER BY event.created_at, event.id
     LIMIT v_batch
     FOR UPDATE SKIP LOCKED
  )
  UPDATE public.outbox_events event
     SET status = 'processing',
         attempts = event.attempts + 1,
         available_at = now() + make_interval(secs => v_visibility),
         metadata = event.metadata || jsonb_build_object(
           'lastClaimedAt', now(),
           'claimToken', gen_random_uuid()::text)
    FROM candidates
   WHERE event.id = candidates.id
  RETURNING event.*;
END;
$$;

-- Acknowledge success. Returns false rather than raising when the row is no longer the
-- caller's: a lease that expired and was re-claimed elsewhere is an ordinary race, and the
-- caller logs it instead of aborting a batch.
CREATE FUNCTION public.outbox_mark_processed(
  p_event_id uuid,
  p_claim_token text,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS boolean
LANGUAGE sql
SET search_path = public, pg_catalog
AS $$
  WITH updated AS (
    UPDATE public.outbox_events
       SET status = 'processed',
           processed_at = now(),
           error = NULL,
           metadata = metadata || COALESCE(p_metadata, '{}'::jsonb)
     WHERE id = p_event_id
       AND status = 'processing'
       AND metadata->>'claimToken' = p_claim_token
     RETURNING id
  )
  SELECT EXISTS (SELECT 1 FROM updated);
$$;

-- Acknowledge failure. The outcome the handler asks for is a request, not a verdict: a
-- 'retry' on a row that has already spent its attempts becomes a discard, so the ceiling is
-- enforced in one place instead of in every caller.
--
-- 'snooze' means the downstream is unavailable rather than the row being bad, so the attempt
-- taken at claim is refunded -- an outage must not consume the DLQ budget of the events it
-- happened to touch. Retry delay is exponential with equal jitter in [d/2, d]: without the
-- jitter every row that failed in the same tick returns in the same later tick, and the
-- convoy reforms on each retry instead of dispersing.
CREATE FUNCTION public.outbox_mark_failed(
  p_event_id uuid,
  p_claim_token text,
  p_error text,
  p_outcome text DEFAULT 'retry',
  p_base_delay_seconds integer DEFAULT 60,
  p_max_delay_seconds integer DEFAULT 3600,
  p_max_attempts integer DEFAULT 8,
  p_snooze_seconds integer DEFAULT 300
)
RETURNS text
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_row public.outbox_events%ROWTYPE;
  v_base integer := LEAST(GREATEST(COALESCE(p_base_delay_seconds, 60), 5), 3600);
  v_cap integer;
  v_max integer := LEAST(GREATEST(COALESCE(p_max_attempts, 8), 1), 20);
  v_snooze integer := LEAST(GREATEST(COALESCE(p_snooze_seconds, 300), 60), 3600);
  v_delay double precision;
BEGIN
  IF p_outcome IS NULL OR p_outcome NOT IN ('retry', 'discard', 'snooze') THEN
    RAISE EXCEPTION 'outbox_mark_failed_invalid_outcome' USING ERRCODE = '22023';
  END IF;

  v_cap := LEAST(GREATEST(v_base, COALESCE(p_max_delay_seconds, 3600)), 86400);

  SELECT *
    INTO v_row
    FROM public.outbox_events
   WHERE id = p_event_id
     AND status = 'processing'
     AND metadata->>'claimToken' = p_claim_token
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN 'missed';
  END IF;

  IF p_outcome = 'discard' OR (p_outcome = 'retry' AND v_row.attempts >= v_max) THEN
    UPDATE public.outbox_events
       SET status = 'discarded',
           error = left(p_error, 2000),
           metadata = metadata || jsonb_build_object(
             'discardReason',
             CASE WHEN p_outcome = 'discard' THEN 'permanent_error' ELSE 'max_attempts' END,
             'discardedAt', now(),
             'finalAttempts', v_row.attempts)
     WHERE id = v_row.id;
    RETURN 'discarded';
  END IF;

  IF p_outcome = 'snooze' THEN
    UPDATE public.outbox_events
       SET status = 'failed',
           attempts = GREATEST(v_row.attempts - 1, 0),
           available_at = now() + make_interval(secs => v_snooze),
           error = left(p_error, 2000),
           metadata = metadata || jsonb_build_object(
             'snoozeCount', COALESCE((metadata->>'snoozeCount')::integer, 0) + 1,
             'lastSnoozedAt', now())
     WHERE id = v_row.id;
    RETURN 'snoozed';
  END IF;

  v_delay := LEAST(
               v_cap::double precision,
               v_base::double precision * power(2, LEAST(GREATEST(v_row.attempts - 1, 0), 16))
             ) * (0.5 + random() * 0.5);

  UPDATE public.outbox_events
     SET status = 'failed',
         available_at = now() + make_interval(secs => v_delay),
         error = left(p_error, 2000)
   WHERE id = v_row.id;
  RETURN 'failed';
END;
$$;

-- Hand back rows the caller claimed but never ran -- a drain loop that aborts mid-batch, or
-- one handler reporting the downstream is out. The attempt taken at claim is refunded for
-- exactly the same reason as in 'snooze': nothing was tried, so nothing was spent. Ids and
-- tokens are supplied as parallel arrays and must agree in length, because a mismatch means
-- the caller lost track of which token belongs to which row and releasing the wrong pairing
-- would silently release nothing.
CREATE FUNCTION public.outbox_release_unprocessed(
  p_event_ids uuid[],
  p_claim_tokens text[],
  p_delay_seconds integer DEFAULT 0
)
RETURNS integer
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_delay integer := LEAST(GREATEST(COALESCE(p_delay_seconds, 0), 0), 3600);
  v_count integer;
BEGIN
  IF p_event_ids IS NULL OR p_claim_tokens IS NULL
     OR cardinality(p_event_ids) <> cardinality(p_claim_tokens) THEN
    RAISE EXCEPTION 'outbox_release_invalid_input' USING ERRCODE = '22023';
  END IF;

  UPDATE public.outbox_events event
     SET status = 'pending',
         available_at = now() + make_interval(secs => v_delay),
         attempts = GREATEST(event.attempts - 1, 0)
    FROM unnest(p_event_ids, p_claim_tokens) AS released(id, token)
   WHERE event.id = released.id
     AND event.status = 'processing'
     AND event.metadata->>'claimToken' = released.token;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;
