CREATE OR REPLACE FUNCTION public.platform_finish_job_run_v2(
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
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_now timestamptz := now();
  v_job_name text := btrim(COALESCE(p_job_name, ''));
  v_metadata jsonb := COALESCE(p_metadata, '{}'::jsonb);
  v_lease_token uuid;
BEGIN
  IF p_status IS NULL OR p_status NOT IN ('success', 'failed') THEN
    RAISE EXCEPTION 'platform_job_invalid_finish_status' USING ERRCODE = '22023';
  END IF;

  -- Claim and finish both lock the control row before touching run rows.
  SELECT lease_token INTO v_lease_token FROM public.platform_job_controls
   WHERE public.platform_job_controls.job_name = v_job_name
     FOR NO KEY UPDATE;

  IF v_lease_token IS NULL OR v_lease_token IS DISTINCT FROM p_run_id THEN
    UPDATE public.platform_job_runs
       SET status = 'skipped',
           finished_at = v_now,
           checked = NULL,
           updated = NULL,
           error = 'job_lease_lost',
           support_code = NULL,
           metadata = '{}'::jsonb
     WHERE id = p_run_id
       AND public.platform_job_runs.job_name = v_job_name
       AND status = 'running';
    RETURN false;
  END IF;

  UPDATE public.platform_job_runs
     SET status = p_status,
         finished_at = v_now,
         checked = p_checked,
         updated = p_updated,
         error = p_error,
         support_code = p_support_code,
         metadata = public.platform_job_runs.metadata || v_metadata
   WHERE id = p_run_id
     AND public.platform_job_runs.job_name = v_job_name;

  UPDATE public.platform_job_controls
     SET updated_at = v_now,
         lease_owner = NULL,
         lease_token = NULL,
         lease_until = NULL,
         last_finished_at = v_now,
         last_success_at = CASE WHEN p_status = 'success' THEN v_now ELSE last_success_at END,
         last_status = p_status,
         last_run_id = p_run_id
   WHERE public.platform_job_controls.job_name = v_job_name;

  RETURN true;
END;
$$;
