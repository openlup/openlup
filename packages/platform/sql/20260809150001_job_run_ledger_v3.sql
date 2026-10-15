-- Job-run ledger v3 entry points: invocation-aware claim and finish.
--
-- Applies after 20260809150000_job_run_ledger.sql, whose v2 claim and finish these delegate to.
-- The trigger kind and invocation source are evidence folded into the run metadata, never an
-- authorization control. CREATE OR REPLACE lets a database whose own migration chain already
-- defines these functions with the same bodies apply this file without change.

CREATE OR REPLACE FUNCTION public.platform_claim_job_run_v3(
  p_job_name text,
  p_trigger_kind text,
  p_invocation_source text,
  p_lease_seconds integer DEFAULT 900,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS TABLE (
  acquired boolean,
  run_id uuid,
  reason text,
  lease_until timestamptz
)
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_trigger_kind text := COALESCE(NULLIF(btrim(p_trigger_kind), ''), '');
  v_invocation_source text := COALESCE(NULLIF(btrim(p_invocation_source), ''), '');
BEGIN
  IF p_job_name IS NULL OR btrim(p_job_name) = '' THEN
    RAISE EXCEPTION 'platform_job_name_required' USING ERRCODE = '22023';
  END IF;

  IF v_trigger_kind NOT IN ('worker', 'scheduler', 'operator') THEN
    RAISE EXCEPTION 'platform_job_invalid_trigger_kind' USING ERRCODE = '22023';
  END IF;

  IF v_invocation_source = '' OR length(v_invocation_source) > 128 THEN
    RAISE EXCEPTION 'platform_job_invocation_source_required' USING ERRCODE = '22023';
  END IF;

  -- The invocation source is evidence, never an authorization control, so it is folded into
  -- the metadata this ledger stores and never interprets.
  RETURN QUERY
  SELECT claimed.acquired, claimed.run_id, claimed.reason, claimed.lease_until
    FROM public.platform_claim_job_run(
      p_job_name,
      v_trigger_kind,
      p_lease_seconds,
      COALESCE(p_metadata, '{}'::jsonb) || jsonb_build_object(
        'triggerKind', v_trigger_kind, 'invocationSource', v_invocation_source)
    ) AS claimed;
END;
$$;

CREATE OR REPLACE FUNCTION public.platform_finish_job_run_v3(
  p_job_name text,
  p_run_id uuid,
  p_status text,
  p_checked integer DEFAULT NULL,
  p_updated integer DEFAULT NULL,
  p_error text DEFAULT NULL,
  p_support_code text DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS boolean
LANGUAGE sql
SET search_path = public, pg_catalog
AS $$
  SELECT public.platform_finish_job_run_v2(
    p_job_name, p_run_id, p_status, p_checked, p_updated, p_error, p_support_code, p_metadata);
$$;
