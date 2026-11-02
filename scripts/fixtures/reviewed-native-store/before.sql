-- Synthetic preimages for the test-only registry. Never an installation unit.
CREATE FUNCTION public.fixture_existing(p_id uuid) RETURNS text LANGUAGE sql SECURITY INVOKER SET search_path = pg_catalog AS $$ SELECT 'before'; $$;
CREATE TABLE public.communication_native_sync_state (
  purpose text NOT NULL CHECK (purpose IN ('marketing_launch_offer','marketing_newsletter'))
);
CREATE TABLE public.fixture_row (id uuid);
CREATE FUNCTION public.fixture_composite_existing(p_row PUBLIC.fixture_row, p_at timestamp with time zone) RETURNS text LANGUAGE sql SET search_path = pg_catalog AS $$ SELECT 'before'; $$;
CREATE FUNCTION public.fixture_grant(p_values text[]) RETURNS text LANGUAGE sql SET search_path = pg_catalog AS $$ SELECT 'grant-only'; $$;
-- Existing synthetic relation for the additive G6 DDL and destructive refusals.
CREATE TABLE public.payment_truth_events (
  id uuid PRIMARY KEY,
  state text NOT NULL,
  outcome text,
  settlement_transition_id uuid,
  settled_at timestamptz,
  dunning_case_id uuid,
  accounting_document_id uuid,
  CONSTRAINT payment_truth_events_fixture_state_check CHECK (state IN ('open','settled'))
);
