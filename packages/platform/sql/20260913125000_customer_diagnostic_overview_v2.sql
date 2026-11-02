-- Add customer_diagnostic_overview_v2: a bounded, cursor-paged aggregate over retained diagnostic
-- observations that reports per coverage-version/action groups without exposing any customer identity.
-- Widen the retained access-audit operation CHECK to accept 'overview' as NOT VALID, so the audited
-- read commits from its first call without scanning historical audit rows.
-- Add customer_diagnostic_events_overview_idx on the window, grouping and example keys this aggregate
-- reads; the build is non-concurrent and bounded by lock_timeout while the read path is still inactive.
-- Session-level SET/RESET repeat the SET LOCAL timeouts because the shadow replay lane applies each
-- migration file in autocommit while `supabase db push` wraps the same file in one transaction.
-- migration:allow-grant: the routine is revoked from PUBLIC and both browser roles, so no browser principal gains EXECUTE.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET lock_timeout = '5s';
SET statement_timeout = '30s';

ALTER TABLE public.customer_diagnostic_access_events
  DROP CONSTRAINT customer_diagnostic_access_events_operation_check;
ALTER TABLE public.customer_diagnostic_access_events
  ADD CONSTRAINT customer_diagnostic_access_events_operation_check
    CHECK (operation IN ('search','history','overview')) NOT VALID;

-- The migration runner owns one transaction, so CONCURRENTLY is unavailable;
-- lock_timeout bounds the only blocking index statement while the feature is off.
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX customer_diagnostic_events_overview_idx
  ON public.customer_diagnostic_events(
    received_at, coverage_version, action, phase, action_id, segment_id
  ) INCLUDE (code, expires_at);

CREATE FUNCTION public.customer_diagnostic_overview_v2(
  p_operator_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_page_size integer,
  p_cursor text,
  p_retention_days integer
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_offset integer := 0;
  v_group_total integer;
  v_groups jsonb;
  v_retained_from timestamptz;
  v_retention_boundary timestamptz;
  -- The observation-only actions, declared once. An action belongs here when the
  -- coverage inventory records it as observed with no attempted or refresh-started
  -- lifecycle, so it can never carry an attempted-to-terminal rate.
  v_static_actions text[] := ARRAY[
    'entry_boot','entry_hydration','route_render','configurator_enter',
    'auth_bootstrap','auth_callback','payment_confirm','payment_status'
  ];
BEGIN
  PERFORM public.communications_require_active_operator(p_operator_id);

  IF p_from IS NULL OR p_to IS NULL OR p_to <= p_from
     OR p_to - p_from > interval '7 days'
     OR p_page_size IS NULL OR p_page_size NOT BETWEEN 1 AND 25
     OR p_retention_days IS NULL OR p_retention_days NOT BETWEEN 1 AND 90
  THEN
    RAISE EXCEPTION 'customer_diagnostic_overview_invalid' USING ERRCODE = '22023';
  END IF;

  IF p_cursor IS NOT NULL THEN
    IF p_cursor !~ '^[0-9]{1,7}$' THEN
      RAISE EXCEPTION 'customer_diagnostic_cursor_invalid' USING ERRCODE = '22023';
    END IF;
    v_offset := p_cursor::integer;
  END IF;

  v_retention_boundary := v_now - make_interval(days => p_retention_days);

  SELECT min(e.received_at)
    INTO v_retained_from
    FROM public.customer_diagnostic_events e
    JOIN public.customer_diagnostic_segments s ON s.id = e.segment_id
   WHERE e.expires_at > v_now
     AND s.expires_at > v_now;

  WITH matching AS MATERIALIZED (
    SELECT e.segment_id, e.action_id, e.coverage_version,
      e.action, e.phase, e.code, e.received_at
      FROM public.customer_diagnostic_events e
      JOIN public.customer_diagnostic_segments s ON s.id = e.segment_id
     WHERE e.received_at >= p_from
       AND e.received_at < p_to
       AND e.expires_at > v_now
       AND s.expires_at > v_now
  ), group_keys AS MATERIALIZED (
    SELECT DISTINCT coverage_version, action
      FROM matching
  ), group_page AS MATERIALIZED (
    SELECT coverage_version, action
      FROM group_keys
     ORDER BY coverage_version, action
     OFFSET v_offset
     LIMIT p_page_size
  ), action_states AS MATERIALIZED (
    SELECT p.coverage_version, p.action, e.action_id,
      (array_agg(e.segment_id::text ORDER BY e.received_at DESC, e.segment_id DESC))[1] AS segment_id,
      max(e.received_at) AS last_seen_at,
      bool_or(e.phase = CASE WHEN p.action = 'account_refresh'
        THEN 'refresh_started' ELSE 'attempted' END) AS has_start,
      count(DISTINCT COALESCE(e.code, 'unknown')) FILTER (
        WHERE e.phase = CASE WHEN p.action = 'account_refresh'
          THEN 'refresh_settled' ELSE 'settled' END
      ) AS terminal_code_count,
      min(COALESCE(e.code, 'unknown')) FILTER (
        WHERE e.phase = CASE WHEN p.action = 'account_refresh'
          THEN 'refresh_settled' ELSE 'settled' END
      ) AS terminal_code
      FROM group_page p
      JOIN matching e
        ON e.coverage_version = p.coverage_version
       AND e.action = p.action
     WHERE p.action <> ALL (v_static_actions)
       AND e.action_id IS NOT NULL
     GROUP BY p.coverage_version, p.action, e.action_id
  ), classified_actions AS MATERIALIZED (
    SELECT coverage_version, action, action_id, segment_id, last_seen_at,
      has_start,
      CASE
        WHEN NOT has_start AND terminal_code_count > 0 THEN 'terminalWithoutStart'
        WHEN has_start AND terminal_code_count = 0 THEN 'observation_gap'
        WHEN has_start AND terminal_code_count > 1 THEN 'conflicting_terminal'
        WHEN has_start AND terminal_code_count = 1 THEN terminal_code
      END AS classification
      FROM action_states
     WHERE has_start OR terminal_code_count > 0
  ), bucket_counts AS MATERIALIZED (
    SELECT coverage_version, action, classification,
      count(*)::integer AS action_count
      FROM classified_actions
     WHERE classification IS NOT NULL
     GROUP BY coverage_version, action, classification
  ), bucket_examples AS MATERIALIZED (
    SELECT coverage_version, action, classification, segment_id,
      max(last_seen_at) AS last_seen_at
      FROM classified_actions
     WHERE classification IS NOT NULL
     GROUP BY coverage_version, action, classification, segment_id
  ), bucket_rows AS MATERIALIZED (
    SELECT b.coverage_version, b.action, b.classification, b.action_count,
      to_jsonb(
        (array_agg(x.segment_id ORDER BY x.last_seen_at DESC, x.segment_id DESC))[1:3]
      ) AS example_segment_ids
      FROM bucket_counts b
      JOIN bucket_examples x
        ON x.coverage_version = b.coverage_version
       AND x.action = b.action
       AND x.classification = b.classification
     GROUP BY b.coverage_version, b.action, b.classification, b.action_count
  ), static_counts AS MATERIALIZED (
    SELECT p.coverage_version, p.action, e.phase, COALESCE(e.code, 'unknown') AS code,
      count(*)::integer AS event_count,
      NULLIF(count(DISTINCT e.action_id), 0)::integer AS action_count
      FROM group_page p
      JOIN matching e
        ON e.coverage_version = p.coverage_version
       AND e.action = p.action
     WHERE p.action = ANY (v_static_actions)
     GROUP BY p.coverage_version, p.action, e.phase, COALESCE(e.code, 'unknown')
  ), static_examples AS MATERIALIZED (
    SELECT p.coverage_version, p.action, e.phase, COALESCE(e.code, 'unknown') AS code,
      e.segment_id::text AS segment_id, max(e.received_at) AS last_seen_at
      FROM group_page p
      JOIN matching e
        ON e.coverage_version = p.coverage_version
       AND e.action = p.action
     WHERE p.action = ANY (v_static_actions)
     GROUP BY p.coverage_version, p.action, e.phase, COALESCE(e.code, 'unknown'), e.segment_id
  ), static_rows AS MATERIALIZED (
    SELECT s.coverage_version, s.action, s.phase, s.code, s.event_count, s.action_count,
      to_jsonb(
        (array_agg(x.segment_id ORDER BY x.last_seen_at DESC, x.segment_id DESC))[1:3]
      ) AS example_segment_ids
      FROM static_counts s
      JOIN static_examples x
        ON x.coverage_version = s.coverage_version
       AND x.action = s.action
       AND x.phase = s.phase
       AND x.code = s.code
     GROUP BY s.coverage_version, s.action, s.phase, s.code, s.event_count, s.action_count
  ), group_rows AS (
    SELECT p.coverage_version, p.action,
      jsonb_build_object(
        'coverageVersion', p.coverage_version,
        'action', p.action,
        'rateApplicability', CASE WHEN p.action = ANY (v_static_actions)
          THEN 'not_applicable' ELSE 'applicable' END,
        'attemptedActionCount', CASE WHEN p.action = ANY (v_static_actions)
          THEN NULL ELSE (
          SELECT count(*)::integer
            FROM action_states a
           WHERE a.coverage_version = p.coverage_version
             AND a.action = p.action
             AND a.has_start
        ) END,
        'terminalOutcomes', CASE WHEN p.action = ANY (v_static_actions)
          THEN '[]'::jsonb ELSE COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'classification', b.classification,
            'actionCount', b.action_count,
            'exampleSegmentIds', b.example_segment_ids
          ) ORDER BY
            CASE b.classification
              WHEN 'observation_gap' THEN 0
              WHEN 'conflicting_terminal' THEN 1
              WHEN 'terminalWithoutStart' THEN 2
              ELSE 3
            END,
            b.classification
          )
            FROM bucket_rows b
           WHERE b.coverage_version = p.coverage_version
             AND b.action = p.action
        ), '[]'::jsonb) END,
        'staticLifecycle', CASE WHEN p.action = ANY (v_static_actions)
          THEN COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'phase', s.phase,
            'code', s.code,
            'eventCount', s.event_count,
            'actionCount', s.action_count,
            'exampleSegmentIds', s.example_segment_ids
          ) ORDER BY s.phase, s.code)
            FROM static_rows s
           WHERE s.coverage_version = p.coverage_version
             AND s.action = p.action
        ), '[]'::jsonb) ELSE '[]'::jsonb END
      ) AS payload
      FROM group_page p
  )
  SELECT
    (SELECT count(*)::integer FROM group_keys),
    COALESCE((SELECT jsonb_agg(payload ORDER BY coverage_version, action) FROM group_rows), '[]'::jsonb)
    INTO v_group_total, v_groups;

  INSERT INTO public.customer_diagnostic_access_events(
    operator_id, operation, filter_from, filter_to, occurred_at, expires_at
  ) VALUES (
    p_operator_id, 'overview', p_from, p_to, v_now,
    v_now + make_interval(days => p_retention_days)
  );

  RETURN jsonb_build_object(
    'contractVersion','customer-diagnostic-history.v2',
    'sourceHealth',jsonb_build_object('read','available','delivery','unknown'),
    'loss',jsonb_build_object('status','unknown','reason','browser_delivery_not_measurable'),
    'windowCoverage',CASE
      WHEN p_to <= v_retention_boundary THEN 'expired'
      WHEN p_from < v_retention_boundary THEN 'partial'
      ELSE 'full'
    END,
    'evidencePresence',CASE WHEN v_group_total = 0 THEN 'empty' ELSE 'observed' END,
    'retainedFrom',v_retained_from,
    'truncated',v_group_total > v_offset + p_page_size,
    'nextCursor',CASE WHEN v_group_total > v_offset + p_page_size
      THEN (v_offset + p_page_size)::text END,
    'groups',v_groups
  );
END;
$$;

REVOKE ALL ON FUNCTION public.customer_diagnostic_overview_v2(uuid,timestamptz,timestamptz,integer,text,integer) FROM PUBLIC, anon, authenticated;

RESET lock_timeout;
RESET statement_timeout;
