-- Close the browser-reported request reference to a named vocabulary, and make a committed
-- non-duplicate v2 reuse rotate the segment credential inside a lifetime the segment's own start
-- bounds. Both halves are ingress-identity repairs layered on the coverage v2 append: no read
-- contract, no column and no routine signature moves here.
-- Replace customer_diagnostic_events_reported_ref_check with the union of the only three shapes a
-- server can name for a browser-reported reference — the reporter's own v1-v5 UUID family, the Axiom
-- canary reference, and the hosted platform request id — so the table stops accepting 128 characters
-- of browser free text under the guise of a correlation id. The replacement is installed NOT VALID:
-- it binds every future write from this statement on, while the scan over rows already stored stays
-- with the human-reviewed activation wave that also validates the coverage-version constraint. The
-- v1 ingest deliberately keeps its loose inline regex and the table is now its backstop.
-- Replay customer_diagnostic_ingest_v2 in full to mirror that union in its inline argument check; to
-- fold credential rotation into the segment UPDATE that already follows a committed event insert, so
-- that a deduplicated beacon and a rate-limited beacon still leave a live tab's credential alone; to
-- report the resulting disposition as 'rotated' instead of 'reused'; and to clamp both the event and
-- the segment expiry with LEAST(started_at + retention, ...) so neither a segment nor its events can
-- be carried past the window the segment itself started. Every other statement of the body is
-- restated unchanged, as a full-body replace must.
-- Session-level SET/RESET repeat the SET LOCAL timeouts because the shadow replay lane applies each
-- migration file in autocommit while `supabase db push` wraps the same file in one transaction.
-- migration:allow-grant: the replayed routine is revoked from PUBLIC and both browser roles and granted only to the runtime role.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET lock_timeout = '5s';
SET statement_timeout = '30s';

ALTER TABLE public.customer_diagnostic_events
  DROP CONSTRAINT customer_diagnostic_events_reported_ref_check;
ALTER TABLE public.customer_diagnostic_events
  ADD CONSTRAINT customer_diagnostic_events_reported_ref_check
    CHECK (
      reported_request_id IS NULL
      OR reported_request_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      OR reported_request_id ~ '^bff-axiom-canary-[a-z0-9-]{1,96}$'
      OR reported_request_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,31}(?:::[A-Za-z0-9._-]{1,32}){1,3}$'
    ) NOT VALID;

CREATE OR REPLACE FUNCTION public.customer_diagnostic_ingest_v2(
  p_presented_credential_hash text,
  p_issued_credential_hash text,
  p_principal_id uuid,
  p_subject_id uuid,
  p_client_event_key uuid,
  p_client_action_key uuid,
  p_action text,
  p_phase text,
  p_code text,
  p_duration_ms integer,
  p_reported_request_id text,
  p_ingest_request_id text,
  p_abuse_key_hash text,
  p_payload_fingerprint text,
  p_retention_days integer,
  p_coverage_version text
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_segment public.customer_diagnostic_segments%ROWTYPE;
  v_existing public.customer_diagnostic_events%ROWTYPE;
  v_segment_id uuid;
  v_segment_started_at timestamptz;
  v_action_id uuid;
  v_disposition text := 'issued';
  v_global_count integer;
  v_bucket_count integer;
BEGIN
  IF p_issued_credential_hash IS NULL
     OR (p_principal_id IS NULL AND p_subject_id IS NOT NULL)
     OR p_client_event_key IS NULL
     OR p_action IS NULL OR p_phase IS NULL OR p_code IS NULL
     OR p_abuse_key_hash IS NULL OR p_payload_fingerprint IS NULL
     OR p_ingest_request_id IS NULL OR p_retention_days IS NULL
     OR p_coverage_version IS DISTINCT FROM 'purchase-auth-account.v2'
     OR p_issued_credential_hash !~ '^[0-9a-f]{64}$'
     OR (p_presented_credential_hash IS NOT NULL AND p_presented_credential_hash !~ '^[0-9a-f]{64}$')
     OR p_abuse_key_hash !~ '^[0-9a-f]{64}$'
     OR p_payload_fingerprint !~ '^[0-9a-f]{64}$'
     OR p_ingest_request_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
     OR (p_reported_request_id IS NOT NULL AND NOT (
          p_reported_request_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          OR p_reported_request_id ~ '^bff-axiom-canary-[a-z0-9-]{1,96}$'
          OR p_reported_request_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,31}(?:::[A-Za-z0-9._-]{1,32}){1,3}$'))
     OR p_retention_days NOT BETWEEN 1 AND 90
     OR (p_duration_ms IS NOT NULL AND p_duration_ms NOT BETWEEN 0 AND 600000)
  THEN RAISE EXCEPTION 'customer_diagnostic_ingest_invalid' USING ERRCODE = '22023'; END IF;

  IF p_action NOT IN ('entry_boot','entry_hydration','route_render','configurator_enter','checkout_submit','payment_confirm','payment_status','auth_bootstrap','auth_magic_link','auth_otp','auth_oauth','account_mutation','account_refresh','account_card_setup','configurator_gate','checkout_recovery_submit','checkout_recovery_readback','checkout_recovery_hatch','auth_callback','account_subscription_mutation','account_profile_mutation','account_companion_mutation','account_address_mutation','account_billing_mutation','account_delivery_mutation','account_payment_mutation','account_communication_mutation')
     OR p_phase NOT IN ('entered','attempted','settled','refresh_started','refresh_settled')
     OR p_code NOT IN ('observed','succeeded','rejected','failed','unknown','timeout','transport_uncertain','retryable','hydration_failed','render_failed','session_present','session_absent','profile_unavailable','refresh_failed','validation_blocked','quote_unavailable','callback_invalid','callback_expired')
  THEN RAISE EXCEPTION 'customer_diagnostic_ingest_invalid' USING ERRCODE = '22023'; END IF;

  IF NOT (
    (p_action = 'entry_boot' AND ((p_phase = 'entered' AND p_code = 'observed') OR (p_phase = 'settled' AND p_code = 'failed'))) OR
    (p_action = 'configurator_enter' AND p_phase = 'entered' AND p_code = 'observed') OR
    (p_action = 'entry_hydration' AND ((p_phase = 'entered' AND p_code = 'observed') OR (p_phase = 'settled' AND p_code = 'hydration_failed'))) OR
    (p_action = 'route_render' AND p_phase = 'settled' AND p_code = 'render_failed') OR
    (p_action = 'auth_bootstrap' AND p_phase = 'settled' AND p_code IN ('session_present','session_absent','profile_unavailable','unknown','failed','timeout')) OR
    (p_action = 'account_refresh' AND p_client_action_key IS NOT NULL AND ((p_phase = 'refresh_started' AND p_code = 'observed') OR (p_phase = 'refresh_settled' AND p_code IN ('succeeded','refresh_failed')))) OR
    (p_action = 'auth_callback' AND p_phase = 'settled' AND p_code IN ('succeeded','callback_invalid','callback_expired','failed','unknown','timeout','transport_uncertain')) OR
    (p_action NOT IN ('entry_boot','entry_hydration','route_render','configurator_enter','auth_bootstrap','account_refresh','auth_callback') AND p_client_action_key IS NOT NULL AND ((p_phase = 'attempted' AND p_code = 'observed') OR (p_phase = 'settled' AND p_code IN ('succeeded','rejected','failed','unknown','timeout','transport_uncertain','retryable','validation_blocked','quote_unavailable'))))
  ) THEN RAISE EXCEPTION 'customer_diagnostic_ingest_invalid' USING ERRCODE = '22023'; END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('customer-diagnostic-global', 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('customer-diagnostic-bucket:' || p_abuse_key_hash, 0));
  DELETE FROM public.customer_diagnostic_ingress_attempts
   WHERE id IN (SELECT id FROM public.customer_diagnostic_ingress_attempts WHERE occurred_at < v_now - interval '2 minutes' LIMIT 500);
  SELECT count(*) INTO v_global_count FROM public.customer_diagnostic_ingress_attempts WHERE occurred_at >= v_now - interval '1 minute';
  SELECT count(*) INTO v_bucket_count FROM public.customer_diagnostic_ingress_attempts WHERE abuse_key_hash = p_abuse_key_hash AND occurred_at >= v_now - interval '1 minute';
  IF v_global_count >= 3000 OR v_bucket_count >= 120 THEN RETURN jsonb_build_object('outcome','rate_limited'); END IF;
  INSERT INTO public.customer_diagnostic_ingress_attempts(abuse_key_hash, occurred_at) VALUES (p_abuse_key_hash, v_now);

  IF p_presented_credential_hash IS NOT NULL THEN
    SELECT * INTO v_segment FROM public.customer_diagnostic_segments WHERE credential_hash = p_presented_credential_hash FOR UPDATE;
  END IF;
  IF v_segment.id IS NOT NULL AND v_segment.closed_at IS NULL AND v_segment.expires_at > v_now
     AND v_segment.principal_id IS NOT DISTINCT FROM p_principal_id
     AND v_segment.subject_id IS NOT DISTINCT FROM p_subject_id THEN
    v_segment_id := v_segment.id;
    v_segment_started_at := v_segment.started_at;
    v_disposition := 'reused';
  ELSE
    IF v_segment.id IS NOT NULL AND v_segment.closed_at IS NULL THEN
      UPDATE public.customer_diagnostic_segments SET closed_at = v_now,
        close_reason = CASE WHEN v_segment.expires_at <= v_now THEN 'expired' WHEN p_principal_id IS NULL THEN 'logout' ELSE 'auth_changed' END
      WHERE id = v_segment.id;
    END IF;
    INSERT INTO public.customer_diagnostic_segments(
      credential_hash, principal_id, subject_id, predecessor_segment_id, predecessor_relation, started_at, last_seen_at, expires_at
    ) VALUES (
      p_issued_credential_hash, p_principal_id, p_subject_id,
      CASE WHEN v_segment.id IS NOT NULL AND v_segment.closed_at IS NULL AND v_segment.expires_at > v_now AND v_segment.principal_id IS NULL AND p_principal_id IS NOT NULL THEN v_segment.id END,
      CASE WHEN v_segment.id IS NOT NULL AND v_segment.closed_at IS NULL AND v_segment.expires_at > v_now AND v_segment.principal_id IS NULL AND p_principal_id IS NOT NULL THEN 'same_tab_pre_auth_context' END,
      v_now, v_now, v_now + make_interval(days => p_retention_days)
    ) RETURNING id, started_at INTO v_segment_id, v_segment_started_at;
  END IF;

  SELECT * INTO v_existing FROM public.customer_diagnostic_events
   WHERE segment_id = v_segment_id AND client_event_key = p_client_event_key FOR UPDATE;
  IF v_existing.id IS NOT NULL THEN
    IF v_existing.payload_fingerprint <> p_payload_fingerprint OR v_existing.coverage_version <> p_coverage_version THEN RAISE EXCEPTION 'customer_diagnostic_event_conflict' USING ERRCODE = '23505'; END IF;
    RETURN jsonb_build_object('outcome','committed','credentialDisposition',v_disposition,
      'deduplicated',true,'segmentId',v_segment_id,'actionId',v_existing.action_id);
  END IF;
  IF (SELECT count(*) FROM public.customer_diagnostic_events WHERE segment_id = v_segment_id AND received_at >= v_now - interval '1 minute') >= 20 THEN
    RETURN jsonb_build_object('outcome','rate_limited');
  END IF;
  IF p_client_action_key IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('customer-diagnostic-action:' || v_segment_id::text || ':' || p_client_action_key::text, 0));
    SELECT action_id INTO v_action_id FROM public.customer_diagnostic_events
     WHERE segment_id = v_segment_id AND client_action_key = p_client_action_key AND action_id IS NOT NULL
     ORDER BY received_at, id LIMIT 1;
    v_action_id := COALESCE(v_action_id, gen_random_uuid());
  END IF;
  INSERT INTO public.customer_diagnostic_events(
    segment_id, action_id, client_event_key, client_action_key, payload_fingerprint, coverage_version,
    action, phase, code, duration_ms, reported_request_id, ingest_request_id, received_at, expires_at
  ) VALUES (
    v_segment_id, v_action_id, p_client_event_key, p_client_action_key, p_payload_fingerprint, p_coverage_version,
    p_action, p_phase, p_code, p_duration_ms, p_reported_request_id, p_ingest_request_id,
    v_now, LEAST(v_segment_started_at + make_interval(days => p_retention_days), v_now + make_interval(days => p_retention_days))
  );
  -- One committed, non-duplicate reuse retires the credential the browser presented.
  -- Both early returns above (replay, per-segment limit) leave the live tab's credential
  -- in place, because the reporter only stores a credential the server returned with a 2xx.
  UPDATE public.customer_diagnostic_segments SET last_seen_at = v_now,
    credential_hash = CASE WHEN v_disposition = 'reused' THEN p_issued_credential_hash ELSE credential_hash END,
    expires_at = LEAST(started_at + make_interval(days => p_retention_days),
      GREATEST(expires_at, v_now + make_interval(days => p_retention_days)))
  WHERE id = v_segment_id;
  IF v_disposition = 'reused' THEN v_disposition := 'rotated'; END IF;
  RETURN jsonb_build_object('outcome','committed','credentialDisposition',v_disposition,
    'deduplicated',false,'segmentId',v_segment_id,'actionId',v_action_id);
END;
$$;

REVOKE ALL ON FUNCTION public.customer_diagnostic_ingest_v2(text,text,uuid,uuid,uuid,uuid,text,text,text,integer,text,text,text,text,integer,text) FROM PUBLIC, anon, authenticated;

RESET lock_timeout;
RESET statement_timeout;
