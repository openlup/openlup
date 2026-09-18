-- Provider-neutral platform operations control plane.
--
-- WHAT THIS FORWARD SHIPS. A capability-local operator allowlist, opaque
-- boolean operational controls, an idempotent operation ledger, the portable
-- watchdog alert ledger and fixed invoker-rights routines for control mutation,
-- heartbeat persistence and bounded readback.
--
-- WHAT IT DELIBERATELY DOES NOT SHIP. No private tester, email, auth, provider,
-- payment, fulfilment or rich observability snapshot tables; no message or
-- template content; no raw provider payload; no browser grant; no scheduler;
-- and no platform-specific seed value.

CREATE TABLE public.platform_control_operators (
  principal_id uuid PRIMARY KEY,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT platform_control_operators_timestamp_check CHECK (updated_at >= created_at)
);

CREATE TABLE public.platform_operational_controls (
  control_key text PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT false,
  revision integer NOT NULL DEFAULT 1,
  updated_by uuid NOT NULL REFERENCES public.platform_control_operators(principal_id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT platform_operational_controls_key_check
    CHECK (control_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'),
  CONSTRAINT platform_operational_controls_revision_check CHECK (revision >= 1)
);

CREATE TABLE public.platform_control_operations (
  idempotency_key text PRIMARY KEY,
  command_fingerprint text NOT NULL,
  action text NOT NULL CHECK (action IN ('set-control', 'record-heartbeat')),
  operator_id uuid NOT NULL REFERENCES public.platform_control_operators(principal_id),
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT platform_control_operations_key_check
    CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$'),
  CONSTRAINT platform_control_operations_fingerprint_check
    CHECK (command_fingerprint ~ '^[a-f0-9]{64}$')
);

CREATE TABLE IF NOT EXISTS public.platform_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dedupe_key text NOT NULL UNIQUE,
  severity text NOT NULL CHECK (severity IN ('p0', 'p1', 'p2', 'p3')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved')),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  last_notified_at timestamptz,
  last_notification_attempt_at timestamptz,
  last_notification_status text CHECK (last_notification_status IS NULL OR last_notification_status IN ('sent', 'failed', 'skipped')),
  next_notification_attempt_at timestamptz,
  notification_failure_count integer NOT NULL DEFAULT 0 CHECK (notification_failure_count >= 0),
  snoozed_until timestamptz,
  acknowledged_at timestamptz,
  resolved_at timestamptz,
  support_code text NOT NULL,
  owner text NOT NULL,
  runbook_url text NOT NULL,
  title text NOT NULL,
  message text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.platform_alert_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_id uuid NOT NULL REFERENCES public.platform_alerts(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('webhook', 'resend')),
  status text NOT NULL CHECK (status IN ('sent', 'failed', 'skipped')),
  provider text,
  provider_response jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text,
  notified_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX platform_control_operations_created_idx
  ON public.platform_control_operations(created_at DESC, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_platform_alerts_status_seen
  ON public.platform_alerts(status, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_platform_alert_notifications_alert
  ON public.platform_alert_notifications(alert_id, notified_at DESC);

REVOKE ALL ON TABLE
  public.platform_control_operators,
  public.platform_operational_controls,
  public.platform_control_operations,
  public.platform_alerts,
  public.platform_alert_notifications
FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.platform_control_operator_is_active(p_principal_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.platform_control_operators AS operator_row
    WHERE operator_row.principal_id = p_principal_id AND operator_row.active IS TRUE
  );
$$;

CREATE FUNCTION public.platform_control_require_operator(p_operator_id uuid)
RETURNS void
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog
AS $$
BEGIN
  IF p_operator_id IS NULL OR NOT public.platform_control_operator_is_active(p_operator_id) THEN
    RAISE EXCEPTION 'platform_control_operator_inactive' USING ERRCODE = '42501';
  END IF;
END;
$$;

CREATE FUNCTION public.platform_control_set_control(
  p_operator_id uuid,
  p_idempotency_key text,
  p_command_fingerprint text,
  p_control_key text,
  p_enabled boolean
)
RETURNS TABLE(action text, replayed boolean, revision integer, recorded_at timestamptz)
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  v_existing public.platform_control_operations%ROWTYPE;
  v_revision integer;
  v_recorded_at timestamptz := clock_timestamp();
BEGIN
  PERFORM public.platform_control_require_operator(p_operator_id);
  SELECT * INTO v_existing
    FROM public.platform_control_operations
   WHERE idempotency_key = p_idempotency_key
   FOR UPDATE;
  IF FOUND THEN
    IF v_existing.command_fingerprint <> p_command_fingerprint OR v_existing.action <> 'set-control' THEN
      RAISE EXCEPTION 'platform_control_idempotency_conflict' USING ERRCODE = '23505';
    END IF;
    RETURN QUERY SELECT 'set-control'::text, true,
      (v_existing.response->>'revision')::integer, v_existing.created_at;
    RETURN;
  END IF;

  INSERT INTO public.platform_operational_controls AS control_row
    (control_key, enabled, revision, updated_by, updated_at)
  VALUES (p_control_key, p_enabled, 1, p_operator_id, v_recorded_at)
  ON CONFLICT (control_key) DO UPDATE
    SET enabled = EXCLUDED.enabled,
        revision = control_row.revision + 1,
        updated_by = EXCLUDED.updated_by,
        updated_at = EXCLUDED.updated_at
  RETURNING control_row.revision INTO v_revision;

  INSERT INTO public.platform_control_operations
    (idempotency_key, command_fingerprint, action, operator_id, response, created_at)
  VALUES (
    p_idempotency_key, p_command_fingerprint, 'set-control', p_operator_id,
    jsonb_build_object('revision', v_revision, 'recordedAt', v_recorded_at), v_recorded_at
  );
  RETURN QUERY SELECT 'set-control'::text, false, v_revision, v_recorded_at;
END;
$$;

CREATE FUNCTION public.platform_control_record_heartbeat(
  p_operator_id uuid,
  p_idempotency_key text,
  p_command_fingerprint text,
  p_health text,
  p_firing_count integer,
  p_max_severity text,
  p_promotion_ready boolean
)
RETURNS TABLE(action text, replayed boolean, revision integer, recorded_at timestamptz)
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  v_existing public.platform_control_operations%ROWTYPE;
  v_recorded_at timestamptz := clock_timestamp();
BEGIN
  PERFORM public.platform_control_require_operator(p_operator_id);
  IF p_health NOT IN ('healthy', 'degraded', 'failed')
    OR p_firing_count < 0
    OR (p_max_severity IS NOT NULL AND p_max_severity NOT IN ('p0', 'p1', 'p2', 'p3')) THEN
    RAISE EXCEPTION 'platform_control_heartbeat_invalid' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_existing
    FROM public.platform_control_operations
   WHERE idempotency_key = p_idempotency_key
   FOR UPDATE;
  IF FOUND THEN
    IF v_existing.command_fingerprint <> p_command_fingerprint OR v_existing.action <> 'record-heartbeat' THEN
      RAISE EXCEPTION 'platform_control_idempotency_conflict' USING ERRCODE = '23505';
    END IF;
    RETURN QUERY SELECT 'record-heartbeat'::text, true, NULL::integer, v_existing.created_at;
    RETURN;
  END IF;

  INSERT INTO public.platform_job_controls AS job_row
    (job_name, enabled, active_driver, last_started_at, last_finished_at,
     last_success_at, last_status, metadata, updated_at)
  VALUES (
    'platform-watchdog', true, 'operator', v_recorded_at, v_recorded_at,
    v_recorded_at, 'success',
    jsonb_build_object('health', p_health, 'firingCount', p_firing_count,
      'maxSeverity', p_max_severity, 'promotionReady', p_promotion_ready),
    v_recorded_at
  )
  ON CONFLICT (job_name) DO UPDATE
    SET last_started_at = EXCLUDED.last_started_at,
        last_finished_at = EXCLUDED.last_finished_at,
        last_success_at = EXCLUDED.last_success_at,
        last_status = EXCLUDED.last_status,
        metadata = EXCLUDED.metadata,
        updated_at = EXCLUDED.updated_at;

  INSERT INTO public.platform_control_operations
    (idempotency_key, command_fingerprint, action, operator_id, response, created_at)
  VALUES (
    p_idempotency_key, p_command_fingerprint, 'record-heartbeat', p_operator_id,
    jsonb_build_object('recordedAt', v_recorded_at), v_recorded_at
  );
  RETURN QUERY SELECT 'record-heartbeat'::text, false, NULL::integer, v_recorded_at;
END;
$$;

CREATE FUNCTION public.platform_control_list_controls(p_operator_id uuid)
RETURNS TABLE(control_key text, enabled boolean, revision integer, updated_at timestamptz)
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog
AS $$
BEGIN
  PERFORM public.platform_control_require_operator(p_operator_id);
  RETURN QUERY SELECT row.control_key, row.enabled, row.revision, row.updated_at
    FROM public.platform_operational_controls AS row ORDER BY row.control_key;
END;
$$;

CREATE FUNCTION public.platform_control_list_jobs(p_operator_id uuid)
RETURNS TABLE(job_name text, enabled boolean, active_driver text, last_status text,
  last_started_at timestamptz, last_finished_at timestamptz, last_success_at timestamptz)
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog
AS $$
BEGIN
  PERFORM public.platform_control_require_operator(p_operator_id);
  RETURN QUERY SELECT row.job_name, row.enabled, row.active_driver, row.last_status,
    row.last_started_at, row.last_finished_at, row.last_success_at
    FROM public.platform_job_controls AS row ORDER BY row.job_name;
END;
$$;

CREATE FUNCTION public.platform_control_list_alerts(p_operator_id uuid)
RETURNS TABLE(dedupe_key text, severity text, status text, owner text, title text,
  first_seen_at timestamptz, last_seen_at timestamptz, resolved_at timestamptz)
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog
AS $$
BEGIN
  PERFORM public.platform_control_require_operator(p_operator_id);
  RETURN QUERY SELECT row.dedupe_key, row.severity, row.status, row.owner, row.title,
    row.first_seen_at, row.last_seen_at, row.resolved_at
    FROM public.platform_alerts AS row
   ORDER BY row.last_seen_at DESC, row.dedupe_key
   LIMIT 200;
END;
$$;

REVOKE ALL ON FUNCTION public.platform_control_operator_is_active(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.platform_control_require_operator(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.platform_control_set_control(uuid, text, text, text, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.platform_control_record_heartbeat(uuid, text, text, text, integer, text, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.platform_control_list_controls(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.platform_control_list_jobs(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.platform_control_list_alerts(uuid) FROM PUBLIC, anon, authenticated;
