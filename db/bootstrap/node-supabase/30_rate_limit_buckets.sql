-- node-supabase docker-stack bootstrap — rate_limit_buckets (Platform Portability, W6).
--
-- The W4.5 pg-backed rate-limiter adapter targets a `public.rate_limit_buckets` table. On the
-- managed Supabase project that table is created by a normal supabase/migration; for the
-- SELF-HOSTED node-supabase docker stack this bootstrap step provisions it WITHOUT adding a new
-- supabase/migrations file (which would be an escalation + would run against managed prod too).
-- IDEMPOTENT. Applied by the node-supabase bootstrap orchestrator AFTER supabase/migrations/* and
-- BEFORE seed, so the rate-limiter has its table the moment the self-host stack boots.
--
-- NOTE: deliberately mirrors the column shape the W4.5 adapter reads/writes (fixed-window counters
-- keyed by bucket + window start). Kept minimal + provider-neutral; the managed migration that lands
-- the same table on Supabase is tracked as the canonical source for prod.

CREATE TABLE IF NOT EXISTS public.rate_limit_buckets (
  bucket_key    text        NOT NULL,
  window_start  timestamptz NOT NULL,
  hit_count     integer     NOT NULL DEFAULT 0,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (bucket_key, window_start)
);

-- Sweep index for expiring old windows (the limiter prunes by window_start).
CREATE INDEX IF NOT EXISTS rate_limit_buckets_window_start_idx
  ON public.rate_limit_buckets (window_start);

-- service_role drives the limiter (elevated path); grant explicit table privileges (BYPASSRLS still
-- needs the GRANT, mirroring how migrations grant to service_role).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.rate_limit_buckets TO service_role;
  END IF;
END
$$;
