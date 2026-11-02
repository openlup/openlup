-- Durable customer-path diagnostics with atomic public admission and audited support reads.
-- migration:allow-rls: all four new server-only tables enable RLS with no browser policy.
-- migration:allow-grant: browser roles are revoked; the portable owner-only transaction lane needs no grant.
-- migration:allow-unique-index: both replay identities are constraints on new empty tables.

CREATE TABLE public.customer_diagnostic_segments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  credential_hash text NOT NULL UNIQUE,
  principal_id uuid,
  subject_id uuid,
  predecessor_segment_id uuid,
  predecessor_relation text,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  closed_at timestamptz,
  close_reason text,
  CONSTRAINT customer_diagnostic_segments_credential_check CHECK (credential_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT customer_diagnostic_segments_subject_check CHECK (subject_id IS NULL OR principal_id IS NOT NULL),
  CONSTRAINT customer_diagnostic_segments_predecessor_check CHECK (
    (predecessor_segment_id IS NULL AND predecessor_relation IS NULL) OR
    (predecessor_segment_id IS NOT NULL AND predecessor_relation = 'same_tab_pre_auth_context')
  ),
  CONSTRAINT customer_diagnostic_segments_close_check CHECK (
    (closed_at IS NULL AND close_reason IS NULL) OR
    (closed_at IS NOT NULL AND close_reason IN ('auth_changed','logout','expired'))
  )
);

CREATE TABLE public.customer_diagnostic_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  segment_id uuid NOT NULL REFERENCES public.customer_diagnostic_segments(id) ON DELETE CASCADE,
  action_id uuid,
  client_event_key uuid NOT NULL,
  client_action_key uuid,
  payload_fingerprint text NOT NULL,
  action text NOT NULL,
  phase text NOT NULL,
  code text,
  duration_ms integer,
  reported_request_id text,
  ingest_request_id text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  CONSTRAINT customer_diagnostic_events_replay_key UNIQUE (segment_id, client_event_key),
  CONSTRAINT customer_diagnostic_events_fingerprint_check CHECK (payload_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT customer_diagnostic_events_duration_check CHECK (duration_ms IS NULL OR duration_ms BETWEEN 0 AND 600000),
  CONSTRAINT customer_diagnostic_events_reported_ref_check CHECK (reported_request_id IS NULL OR reported_request_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT customer_diagnostic_events_ingest_ref_check CHECK (ingest_request_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')
);

CREATE TABLE public.customer_diagnostic_ingress_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  abuse_key_hash text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT customer_diagnostic_ingress_hash_check CHECK (abuse_key_hash ~ '^[0-9a-f]{64}$')
);

CREATE TABLE public.customer_diagnostic_access_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id uuid NOT NULL REFERENCES public.platform_communication_operators(principal_id),
  operation text NOT NULL CHECK (operation IN ('search','history')),
  segment_id uuid,
  subject_id uuid,
  filter_from timestamptz,
  filter_to timestamptz,
  action text,
  phase text,
  code text,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL
);

CREATE INDEX customer_diagnostic_events_segment_time_idx ON public.customer_diagnostic_events(segment_id, received_at DESC, id DESC);
CREATE INDEX customer_diagnostic_events_search_idx ON public.customer_diagnostic_events(received_at DESC, action, phase, code);
CREATE INDEX customer_diagnostic_segments_subject_time_idx ON public.customer_diagnostic_segments(subject_id, last_seen_at DESC);
CREATE INDEX customer_diagnostic_ingress_time_idx ON public.customer_diagnostic_ingress_attempts(occurred_at);
CREATE INDEX customer_diagnostic_ingress_bucket_idx ON public.customer_diagnostic_ingress_attempts(abuse_key_hash, occurred_at DESC);
CREATE INDEX customer_diagnostic_access_expiry_idx ON public.customer_diagnostic_access_events(expires_at);

ALTER TABLE public.customer_diagnostic_segments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_diagnostic_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_diagnostic_ingress_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_diagnostic_access_events ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION public.customer_diagnostic_ingest_v1(
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
  p_retention_days integer
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_segment public.customer_diagnostic_segments%ROWTYPE;
  v_existing public.customer_diagnostic_events%ROWTYPE;
  v_segment_id uuid;
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
     OR p_issued_credential_hash !~ '^[0-9a-f]{64}$'
     OR (p_presented_credential_hash IS NOT NULL AND p_presented_credential_hash !~ '^[0-9a-f]{64}$')
     OR p_abuse_key_hash !~ '^[0-9a-f]{64}$'
     OR p_payload_fingerprint !~ '^[0-9a-f]{64}$'
     OR p_ingest_request_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
     OR (p_reported_request_id IS NOT NULL AND p_reported_request_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')
     OR p_retention_days NOT BETWEEN 1 AND 90
     OR (p_duration_ms IS NOT NULL AND p_duration_ms NOT BETWEEN 0 AND 600000)
  THEN RAISE EXCEPTION 'customer_diagnostic_ingest_invalid' USING ERRCODE = '22023'; END IF;

  IF p_action NOT IN ('entry_boot','entry_hydration','route_render','configurator_enter','checkout_submit','payment_confirm','payment_status','auth_bootstrap','auth_magic_link','auth_otp','auth_oauth','account_mutation','account_refresh','account_card_setup')
     OR p_phase NOT IN ('entered','attempted','settled','refresh_started','refresh_settled')
     OR p_code NOT IN ('observed','succeeded','rejected','failed','unknown','timeout','transport_uncertain','retryable','hydration_failed','render_failed','session_present','session_absent','profile_unavailable','refresh_failed')
  THEN RAISE EXCEPTION 'customer_diagnostic_ingest_invalid' USING ERRCODE = '22023'; END IF;

  IF NOT (
    (p_action = 'entry_boot' AND ((p_phase = 'entered' AND p_code = 'observed') OR (p_phase = 'settled' AND p_code = 'failed'))) OR
    (p_action = 'configurator_enter' AND p_phase = 'entered' AND p_code = 'observed') OR
    (p_action = 'entry_hydration' AND ((p_phase = 'entered' AND p_code = 'observed') OR (p_phase = 'settled' AND p_code IN ('succeeded','hydration_failed')))) OR
    (p_action = 'route_render' AND p_phase = 'settled' AND p_code = 'render_failed') OR
    (p_action = 'auth_bootstrap' AND p_phase = 'settled' AND p_code IN ('session_present','session_absent','profile_unavailable','unknown','failed','timeout')) OR
    (p_action = 'account_refresh' AND p_client_action_key IS NOT NULL AND ((p_phase = 'refresh_started' AND p_code = 'observed') OR (p_phase = 'refresh_settled' AND p_code IN ('succeeded','refresh_failed')))) OR
    (p_action NOT IN ('entry_boot','entry_hydration','route_render','configurator_enter','auth_bootstrap','account_refresh') AND p_client_action_key IS NOT NULL AND ((p_phase = 'attempted' AND p_code = 'observed') OR (p_phase = 'settled' AND p_code IN ('succeeded','rejected','failed','unknown','timeout','transport_uncertain','retryable'))))
  ) THEN RAISE EXCEPTION 'customer_diagnostic_ingest_invalid' USING ERRCODE = '22023'; END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('customer-diagnostic-global', 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('customer-diagnostic-bucket:' || p_abuse_key_hash, 0));
  DELETE FROM public.customer_diagnostic_ingress_attempts
   WHERE id IN (SELECT id FROM public.customer_diagnostic_ingress_attempts WHERE occurred_at < v_now - interval '2 minutes' LIMIT 500);
  SELECT count(*) INTO v_global_count FROM public.customer_diagnostic_ingress_attempts WHERE occurred_at >= v_now - interval '1 minute';
  SELECT count(*) INTO v_bucket_count FROM public.customer_diagnostic_ingress_attempts WHERE abuse_key_hash = p_abuse_key_hash AND occurred_at >= v_now - interval '1 minute';
  IF v_global_count >= 3000 OR v_bucket_count >= 120 THEN
    RETURN jsonb_build_object('outcome','rate_limited');
  END IF;
  INSERT INTO public.customer_diagnostic_ingress_attempts(abuse_key_hash, occurred_at) VALUES (p_abuse_key_hash, v_now);

  IF p_presented_credential_hash IS NOT NULL THEN
    SELECT * INTO v_segment FROM public.customer_diagnostic_segments
     WHERE credential_hash = p_presented_credential_hash FOR UPDATE;
  END IF;

  IF v_segment.id IS NOT NULL AND v_segment.closed_at IS NULL AND v_segment.expires_at > v_now
     AND v_segment.principal_id IS NOT DISTINCT FROM p_principal_id
     AND v_segment.subject_id IS NOT DISTINCT FROM p_subject_id THEN
    v_segment_id := v_segment.id;
    v_disposition := 'reused';
  ELSE
    IF v_segment.id IS NOT NULL AND v_segment.closed_at IS NULL THEN
      UPDATE public.customer_diagnostic_segments SET
        closed_at = v_now,
        close_reason = CASE WHEN v_segment.expires_at <= v_now THEN 'expired' WHEN p_principal_id IS NULL THEN 'logout' ELSE 'auth_changed' END
      WHERE id = v_segment.id;
    END IF;
    INSERT INTO public.customer_diagnostic_segments(
      credential_hash, principal_id, subject_id, predecessor_segment_id, predecessor_relation, started_at, last_seen_at, expires_at
    ) VALUES (
      p_issued_credential_hash,
      p_principal_id,
      p_subject_id,
      CASE WHEN v_segment.id IS NOT NULL AND v_segment.closed_at IS NULL AND v_segment.expires_at > v_now AND v_segment.principal_id IS NULL AND p_principal_id IS NOT NULL THEN v_segment.id END,
      CASE WHEN v_segment.id IS NOT NULL AND v_segment.closed_at IS NULL AND v_segment.expires_at > v_now AND v_segment.principal_id IS NULL AND p_principal_id IS NOT NULL THEN 'same_tab_pre_auth_context' END,
      v_now, v_now, v_now + make_interval(days => p_retention_days)
    ) RETURNING id INTO v_segment_id;
  END IF;

  SELECT * INTO v_existing FROM public.customer_diagnostic_events
   WHERE segment_id = v_segment_id AND client_event_key = p_client_event_key FOR UPDATE;
  IF v_existing.id IS NOT NULL THEN
    IF v_existing.payload_fingerprint <> p_payload_fingerprint THEN
      RAISE EXCEPTION 'customer_diagnostic_event_conflict' USING ERRCODE = '23505';
    END IF;
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
    segment_id, action_id, client_event_key, client_action_key, payload_fingerprint,
    action, phase, code, duration_ms, reported_request_id, ingest_request_id, received_at, expires_at
  ) VALUES (
    v_segment_id, v_action_id, p_client_event_key, p_client_action_key, p_payload_fingerprint,
    p_action, p_phase, p_code, p_duration_ms, p_reported_request_id, p_ingest_request_id,
    v_now, v_now + make_interval(days => p_retention_days)
  );
  UPDATE public.customer_diagnostic_segments SET last_seen_at = v_now,
    expires_at = GREATEST(expires_at, v_now + make_interval(days => p_retention_days)) WHERE id = v_segment_id;
  RETURN jsonb_build_object('outcome','committed','credentialDisposition',v_disposition,
    'deduplicated',false,'segmentId',v_segment_id,'actionId',v_action_id);
END;
$$;

CREATE FUNCTION public.customer_diagnostic_search_v1(
  p_operator_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_subject_id uuid,
  p_action text,
  p_phase text,
  p_code text,
  p_page_size integer,
  p_cursor text,
  p_retention_days integer
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_offset integer := 0;
  v_total integer;
  v_group_total integer;
  v_groups jsonb;
  v_segments jsonb;
  v_retained_from timestamptz;
BEGIN
  PERFORM public.communications_require_active_operator(p_operator_id);
  IF p_from IS NULL OR p_to IS NULL OR p_to <= p_from OR p_to - p_from > interval '7 days'
     OR p_page_size IS NULL OR p_page_size NOT BETWEEN 1 AND 25
     OR p_retention_days IS NULL OR p_retention_days NOT BETWEEN 1 AND 90
     OR (p_action IS NOT NULL AND p_action NOT IN ('entry_boot','entry_hydration','route_render','configurator_enter','checkout_submit','payment_confirm','payment_status','auth_bootstrap','auth_magic_link','auth_otp','auth_oauth','account_mutation','account_refresh','account_card_setup'))
     OR (p_phase IS NOT NULL AND p_phase NOT IN ('entered','attempted','settled','refresh_started','refresh_settled'))
     OR (p_code IS NOT NULL AND p_code NOT IN ('observed','succeeded','rejected','failed','unknown','timeout','transport_uncertain','retryable','hydration_failed','render_failed','session_present','session_absent','profile_unavailable','refresh_failed'))
  THEN RAISE EXCEPTION 'customer_diagnostic_search_invalid' USING ERRCODE = '22023'; END IF;
  IF p_cursor IS NOT NULL THEN
    IF p_cursor !~ '^[0-9]{1,7}$' THEN RAISE EXCEPTION 'customer_diagnostic_cursor_invalid' USING ERRCODE = '22023'; END IF;
    v_offset := p_cursor::integer;
  END IF;

  WITH matching AS (
    SELECT e.* FROM public.customer_diagnostic_events e
    JOIN public.customer_diagnostic_segments s ON s.id = e.segment_id
    WHERE e.received_at >= p_from AND e.received_at < p_to AND e.expires_at > v_now
      AND s.expires_at > v_now
      AND (p_subject_id IS NULL OR s.subject_id = p_subject_id)
      AND (p_action IS NULL OR e.action = p_action)
      AND (p_phase IS NULL OR e.phase = p_phase)
      AND (p_code IS NULL OR e.code = p_code)
  ), grouped AS (
    SELECT action, phase, code, count(*)::integer event_count,
      count(DISTINCT action_id)::integer action_count,
      count(DISTINCT segment_id)::integer segment_count
    FROM matching GROUP BY action, phase, code
  ), top_groups AS (
    SELECT * FROM grouped ORDER BY event_count DESC, action, phase, code NULLS FIRST LIMIT 100
  )
  SELECT (SELECT count(*) FROM grouped), COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'action', action, 'phase', phase, 'code', code, 'eventCount', event_count,
      'actionCount', action_count, 'segmentCount', segment_count
    ) ORDER BY event_count DESC, action, phase, code NULLS FIRST) FROM top_groups), '[]'::jsonb)
  INTO v_group_total, v_groups;

  WITH matching AS (
    SELECT e.* FROM public.customer_diagnostic_events e
    JOIN public.customer_diagnostic_segments s ON s.id = e.segment_id
    WHERE e.received_at >= p_from AND e.received_at < p_to AND e.expires_at > v_now
      AND s.expires_at > v_now
      AND (p_subject_id IS NULL OR s.subject_id = p_subject_id)
      AND (p_action IS NULL OR e.action = p_action)
      AND (p_phase IS NULL OR e.phase = p_phase)
      AND (p_code IS NULL OR e.code = p_code)
  ), summaries AS (
    SELECT s.id segment_id, s.principal_id, s.subject_id, min(m.received_at) first_seen_at,
      max(m.received_at) last_seen_at, count(*)::integer event_count,
      count(DISTINCT m.action_id)::integer action_count
    FROM matching m JOIN public.customer_diagnostic_segments s ON s.id = m.segment_id
    GROUP BY s.id, s.principal_id, s.subject_id
  ), page AS (
    SELECT * FROM summaries ORDER BY last_seen_at DESC, segment_id DESC OFFSET v_offset LIMIT p_page_size
  )
  SELECT (SELECT count(*) FROM summaries), COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'segmentId', segment_id, 'attribution', CASE WHEN principal_id IS NULL THEN 'anonymous' ELSE 'account_verified' END,
      'subjectId', subject_id, 'firstSeenAt', first_seen_at, 'lastSeenAt', last_seen_at,
      'eventCount', event_count, 'actionCount', action_count
    ) ORDER BY last_seen_at DESC, segment_id DESC) FROM page), '[]'::jsonb)
  INTO v_total, v_segments;

  SELECT min(received_at) INTO v_retained_from FROM public.customer_diagnostic_events WHERE expires_at > v_now;
  INSERT INTO public.customer_diagnostic_access_events(
    operator_id, operation, subject_id, filter_from, filter_to, action, phase, code, occurred_at, expires_at
  ) VALUES (p_operator_id, 'search', p_subject_id, p_from, p_to, p_action, p_phase, p_code,
    v_now, v_now + make_interval(days => p_retention_days));
  RETURN jsonb_build_object(
    'contractVersion','customer-diagnostic-history.v1','coverageVersion','purchase-auth-account.v1',
    'sourceHealth',jsonb_build_object('read','available','delivery','unknown'),
    'loss',jsonb_build_object('status','unknown','reason','browser_delivery_not_measurable'),
    'retainedFrom',v_retained_from,'truncated',(v_total > v_offset + p_page_size OR v_group_total > 100),
    'nextCursor',CASE WHEN v_total > v_offset + p_page_size THEN (v_offset + p_page_size)::text END,
    'groups',v_groups,'segments',v_segments
  );
END;
$$;

CREATE FUNCTION public.customer_diagnostic_segment_v1(
  p_operator_id uuid,
  p_segment_id uuid,
  p_page_size integer,
  p_cursor text,
  p_retention_days integer
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_offset integer := 0;
  v_total integer;
  v_events jsonb;
  v_segment public.customer_diagnostic_segments%ROWTYPE;
BEGIN
  PERFORM public.communications_require_active_operator(p_operator_id);
  IF p_segment_id IS NULL OR p_page_size IS NULL OR p_page_size NOT BETWEEN 1 AND 100
     OR p_retention_days IS NULL OR p_retention_days NOT BETWEEN 1 AND 90
  THEN RAISE EXCEPTION 'customer_diagnostic_history_invalid' USING ERRCODE = '22023'; END IF;
  IF p_cursor IS NOT NULL THEN
    IF p_cursor !~ '^[0-9]{1,7}$' THEN RAISE EXCEPTION 'customer_diagnostic_cursor_invalid' USING ERRCODE = '22023'; END IF;
    v_offset := p_cursor::integer;
  END IF;

  SELECT * INTO v_segment FROM public.customer_diagnostic_segments
   WHERE id = p_segment_id AND expires_at > v_now;
  INSERT INTO public.customer_diagnostic_access_events(
    operator_id, operation, segment_id, subject_id, occurred_at, expires_at
  ) VALUES (p_operator_id, 'history', p_segment_id, v_segment.subject_id, v_now,
    LEAST(v_now + make_interval(days => p_retention_days), COALESCE(v_segment.expires_at, v_now + make_interval(days => p_retention_days))));
  IF v_segment.id IS NULL THEN RETURN NULL; END IF;

  SELECT count(*) INTO v_total FROM public.customer_diagnostic_events
   WHERE segment_id = p_segment_id AND expires_at > v_now;
  WITH page AS (
    SELECT * FROM public.customer_diagnostic_events
     WHERE segment_id = p_segment_id AND expires_at > v_now
     ORDER BY received_at DESC, id DESC OFFSET v_offset LIMIT p_page_size
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'eventId',id,'actionId',action_id,'action',action,'phase',phase,'code',code,
    'durationMs',duration_ms,'relatedRequestId',reported_request_id,
    'relatedRequestTrust',CASE WHEN reported_request_id IS NULL THEN NULL ELSE 'browser_reported' END,
    'ingestRequestId',ingest_request_id,'receivedAt',received_at
  ) ORDER BY received_at DESC, id DESC), '[]'::jsonb) INTO v_events FROM page;

  RETURN jsonb_build_object(
    'contractVersion','customer-diagnostic-history.v1','coverageVersion','purchase-auth-account.v1',
    'sourceHealth',jsonb_build_object('read','available','delivery','unknown'),
    'loss',jsonb_build_object('status','unknown','reason','browser_delivery_not_measurable'),
    'segmentId',v_segment.id,
    'attribution',CASE WHEN v_segment.principal_id IS NULL THEN 'anonymous' ELSE 'account_verified' END,
    'subjectId',v_segment.subject_id,
    'predecessor',CASE WHEN v_segment.predecessor_relation = 'same_tab_pre_auth_context'
      AND EXISTS (SELECT 1 FROM public.customer_diagnostic_segments p WHERE p.id = v_segment.predecessor_segment_id AND p.expires_at > v_now)
      THEN jsonb_build_object('segmentId',v_segment.predecessor_segment_id,'relation',v_segment.predecessor_relation) ELSE NULL END,
    'events',v_events,'truncated',v_total > v_offset + p_page_size,
    'nextCursor',CASE WHEN v_total > v_offset + p_page_size THEN (v_offset + p_page_size)::text END
  );
END;
$$;

CREATE FUNCTION public.customer_diagnostic_prune_v1(p_batch_size integer)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  v_events integer := 0;
  v_segments integer := 0;
  v_limits integer := 0;
  v_access integer := 0;
BEGIN
  IF p_batch_size IS NULL OR p_batch_size NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'customer_diagnostic_prune_invalid' USING ERRCODE = '22023';
  END IF;
  WITH doomed AS (SELECT id FROM public.customer_diagnostic_events WHERE expires_at <= clock_timestamp() ORDER BY expires_at LIMIT p_batch_size),
  deleted AS (DELETE FROM public.customer_diagnostic_events e USING doomed d WHERE e.id = d.id RETURNING 1)
  SELECT count(*) INTO v_events FROM deleted;
  WITH doomed AS (SELECT id FROM public.customer_diagnostic_access_events WHERE expires_at <= clock_timestamp() ORDER BY expires_at LIMIT p_batch_size),
  deleted AS (DELETE FROM public.customer_diagnostic_access_events a USING doomed d WHERE a.id = d.id RETURNING 1)
  SELECT count(*) INTO v_access FROM deleted;
  WITH doomed AS (SELECT id FROM public.customer_diagnostic_ingress_attempts WHERE occurred_at < clock_timestamp() - interval '2 minutes' ORDER BY occurred_at LIMIT p_batch_size),
  deleted AS (DELETE FROM public.customer_diagnostic_ingress_attempts a USING doomed d WHERE a.id = d.id RETURNING 1)
  SELECT count(*) INTO v_limits FROM deleted;
  WITH doomed AS (
    SELECT s.id FROM public.customer_diagnostic_segments s WHERE s.expires_at <= clock_timestamp()
      AND NOT EXISTS (SELECT 1 FROM public.customer_diagnostic_events e WHERE e.segment_id = s.id)
    ORDER BY s.expires_at LIMIT p_batch_size
  ), deleted AS (DELETE FROM public.customer_diagnostic_segments s USING doomed d WHERE s.id = d.id RETURNING 1)
  SELECT count(*) INTO v_segments FROM deleted;
  RETURN jsonb_build_object('eventsDeleted',v_events,'segmentsDeleted',v_segments,
    'limitsDeleted',v_limits,'accessDeleted',v_access);
END;
$$;

REVOKE ALL ON TABLE public.customer_diagnostic_segments, public.customer_diagnostic_events,
  public.customer_diagnostic_ingress_attempts, public.customer_diagnostic_access_events FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.customer_diagnostic_ingest_v1(text,text,uuid,uuid,uuid,uuid,text,text,text,integer,text,text,text,text,integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.customer_diagnostic_search_v1(uuid,timestamptz,timestamptz,uuid,text,text,text,integer,text,integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.customer_diagnostic_segment_v1(uuid,uuid,integer,text,integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.customer_diagnostic_prune_v1(integer) FROM PUBLIC, anon, authenticated;
