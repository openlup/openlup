-- Keep the portable subscription active when the canonical retry cadence ends.
-- The same open case and pending order remain repairable through the existing
-- checkout token and captured settlement rail. Preserve the terminal automatic
-- retry verdict and final notice; do not create a pause window or a second PSP.
-- migration:allow-function: forward replacement of the existing invoker routine;
-- its fixed search path and revoked browser/PUBLIC privileges remain unchanged.

CREATE OR REPLACE FUNCTION public.dunning_lifecycle_handle_failure(
  p_case_id uuid,
  p_occurred_at timestamptz,
  p_failure_class text,
  p_failure_reason text,
  p_retry_attempt integer,
  p_next_retry_at timestamptz,
  p_template_slug text,
  p_recovery_url_path text
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_case public.subscription_dunning_cases;
  v_notification_id uuid;
  v_event_id uuid;
  v_at timestamptz := COALESCE(p_occurred_at, now());
BEGIN
  SELECT * INTO v_case FROM public.subscription_dunning_cases WHERE id = p_case_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'subscription_dunning_case_not_found';
  END IF;
  IF v_case.status <> 'open' THEN
    RETURN jsonb_build_object(
      'caseId', v_case.id, 'caseStatus', v_case.status, 'paused', false, 'terminal', true
    );
  END IF;

  IF p_next_retry_at IS NOT NULL THEN
    UPDATE public.subscription_dunning_cases
    SET retry_attempt = GREATEST(COALESCE(p_retry_attempt, v_case.retry_attempt + 1), 1),
        next_retry_at = p_next_retry_at,
        failure_class = COALESCE(p_failure_class, failure_class),
        failure_reason = COALESCE(p_failure_reason, failure_reason),
        updated_at = v_at
    WHERE id = v_case.id
    RETURNING * INTO v_case;

    v_notification_id := public.dunning_lifecycle_queue_notice(
      v_case.id, 'payment_failed', p_template_slug, v_case.retry_attempt, p_recovery_url_path
    );
    RETURN jsonb_build_object(
      'caseId', v_case.id, 'caseStatus', v_case.status, 'notificationId', v_notification_id,
      'retryAttempt', v_case.retry_attempt, 'paused', false, 'terminal', false
    );
  END IF;

  UPDATE public.subscription_dunning_cases
  SET retry_attempt = GREATEST(COALESCE(p_retry_attempt, v_case.retry_attempt), v_case.retry_attempt),
      next_retry_at = NULL,
      failure_class = COALESCE(p_failure_class, failure_class),
      failure_reason = COALESCE(p_failure_reason, failure_reason),
      updated_at = v_at
  WHERE id = v_case.id
  RETURNING * INTO v_case;

  v_notification_id := public.dunning_lifecycle_queue_notice(
    v_case.id, 'payment_expired', p_template_slug, 0, p_recovery_url_path
  );

  INSERT INTO public.subscription_events (
    subscription_id, event_type, idempotency_key, payload, occurred_at
  ) VALUES (
    v_case.subscription_id, 'dunning_ladder_exhausted',
    'dunning-exhausted:' || v_case.id::text,
    jsonb_build_object('caseId', v_case.id, 'retryAttempt', v_case.retry_attempt),
    v_at
  )
  ON CONFLICT ON CONSTRAINT subscription_events_subscription_id_idempotency_key_key DO NOTHING
  RETURNING id INTO v_event_id;

  RETURN jsonb_build_object(
    'caseId', v_case.id, 'caseStatus', v_case.status, 'notificationId', v_notification_id,
    'retryAttempt', v_case.retry_attempt, 'paused', false,
    'pauseWindowId', NULL, 'terminal', true
  );
END;
$$;
