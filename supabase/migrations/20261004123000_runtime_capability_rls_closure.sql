-- Managed runtime capabilities. Baseline and prior forwards remain immutable.
-- Exact security admission must precede this forward. Column grants are service-only.

CREATE OR REPLACE FUNCTION public.admin_clients_search_v3(p_query text, p_page integer DEFAULT 0, p_page_size integer DEFAULT 20, p_lifecycle_stage text DEFAULT 'all'::text) RETURNS jsonb
    LANGUAGE plpgsql STABLE
    SET search_path TO 'pg_catalog', 'public', 'extensions'
    SET "pg_trgm.similarity_threshold" TO '0.28'
    AS $$
DECLARE
  v_query text := btrim(COALESCE(p_query, ''));
  v_query_normalized text;
  v_query_digits text;
  v_query_is_email boolean := position('@' IN v_query) > 0;
  v_query_uuid uuid;
  v_page integer := COALESCE(p_page, 0);
  v_page_size integer := LEAST(GREATEST(COALESCE(p_page_size, 20), 1), 50);
  v_result jsonb;
BEGIN
  IF v_query = '' OR char_length(v_query) > 200 THEN
    RAISE EXCEPTION 'admin_clients_search_query_invalid' USING ERRCODE = '22023';
  END IF;
  IF v_page < 0 OR COALESCE(p_lifecycle_stage, 'all') NOT IN (
    'all', 'lead', 'waitlist', 'tester', 'customer', 'inactive'
  ) THEN
    RAISE EXCEPTION 'admin_clients_search_page_invalid' USING ERRCODE = '22023';
  END IF;

  v_query_normalized := public.admin_client_search_normalize(v_query);
  v_query_digits := CASE WHEN v_query_is_email THEN ''
    ELSE public.admin_client_search_digits(v_query) END;
  IF v_query_normalized !~ '[a-z0-9]' THEN
    RAISE EXCEPTION 'admin_clients_search_query_invalid' USING ERRCODE = '22023';
  END IF;
  BEGIN
    v_query_uuid := v_query::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    v_query_uuid := NULL;
  END;

  -- Qualify source identities before relationship/activity enrichment. The
  -- trigram predicates below match the expression indexes above, so fuzzy and
  -- leading-substring searches do not execute lateral aggregates for every
  -- customer in the registry.
  WITH physical_candidate_ids AS MATERIALIZED (
    SELECT client_row.id AS client_id
    FROM public.clients AS client_row
    WHERE client_row.identity_kind = 'customer'
      AND (
        client_row.id = v_query_uuid
        OR public.admin_client_search_normalize(
          COALESCE(client_row.email, '') || ' ' || COALESCE(client_row.first_name, '') || ' ' ||
          COALESCE(client_row.last_name, '') || ' ' || COALESCE(client_row.phone, '')
        ) LIKE '%' || v_query_normalized || '%'
          AND (NOT v_query_is_email OR public.admin_client_search_normalize(client_row.email)
            LIKE '%' || v_query_normalized || '%')
        OR (NOT v_query_is_email AND
          public.admin_client_search_normalize(
            COALESCE(client_row.email, '') || ' ' || COALESCE(client_row.first_name, '') || ' ' ||
            COALESCE(client_row.last_name, '') || ' ' || COALESCE(client_row.phone, '')
          ) OPERATOR(public.%) v_query_normalized
          AND similarity(public.admin_client_search_normalize(
            COALESCE(client_row.email, '') || ' ' || COALESCE(client_row.first_name, '') || ' ' ||
            COALESCE(client_row.last_name, '') || ' ' || COALESCE(client_row.phone, '')
          ), v_query_normalized) >= 0.32
        )
        OR (NOT v_query_is_email AND
          public.admin_client_search_normalize(
            COALESCE(client_row.first_name, '') || ' ' || COALESCE(client_row.last_name, '')
          ) OPERATOR(public.%) v_query_normalized
          AND similarity(public.admin_client_search_normalize(
            COALESCE(client_row.first_name, '') || ' ' || COALESCE(client_row.last_name, '')
          ), v_query_normalized) >= 0.28
        )
        OR (NOT v_query_is_email AND
          public.admin_client_search_normalize(
            COALESCE(client_row.last_name, '') || ' ' || COALESCE(client_row.first_name, '')
          ) OPERATOR(public.%) v_query_normalized
          AND similarity(public.admin_client_search_normalize(
            COALESCE(client_row.last_name, '') || ' ' || COALESCE(client_row.first_name, '')
          ), v_query_normalized) >= 0.28
        )
        OR (v_query_digits <> '' AND public.admin_client_search_digits(client_row.phone)
          LIKE '%' || v_query_digits || '%')
      )
    UNION
    SELECT order_row.client_id
    FROM public.commerce_orders AS order_row
    WHERE order_row.client_id IS NOT NULL AND (
      order_row.id = v_query_uuid
      OR (NOT v_query_is_email AND public.admin_client_search_normalize(order_row.order_number)
        LIKE '%' || v_query_normalized || '%'
      )
    )
    UNION
    SELECT subscription_row.client_id
    FROM public.subscriptions AS subscription_row
    WHERE subscription_row.id = v_query_uuid
  ), physical_base AS (
    SELECT
      'physical_client'::text AS source_kind,
      client_row.id::text AS source_id,
      client_row.id AS client_id,
      NULL::uuid AS tester_id,
      NULL::text AS tester_status,
      NULL::uuid AS waitlist_id,
      NULLIF(btrim(concat_ws(' ', client_row.first_name, client_row.last_name)), '') AS display_name,
      lower(client_row.email) AS email,
      NULLIF(btrim(client_row.phone), '') AS phone,
      client_row.lifecycle_stage,
      jsonb_build_array('physical_client') AS sources,
      latest_order.id AS latest_order_id,
      latest_order.order_number AS latest_order_number,
      latest_order.status AS latest_order_status,
      client_row.created_at,
      GREATEST(client_row.updated_at, latest_order.updated_at,
        subscription_match.last_activity_at) AS last_activity_at,
      public.admin_client_search_normalize(client_row.email) AS normalized_email,
      public.admin_client_search_digits(client_row.phone) AS normalized_phone,
      public.admin_client_search_normalize(
        COALESCE(client_row.first_name, '') || ' ' || COALESCE(client_row.last_name, '')
      ) AS normalized_name,
      public.admin_client_search_normalize(
        COALESCE(client_row.last_name, '') || ' ' || COALESCE(client_row.first_name, '')
      ) AS normalized_reverse_name,
      public.admin_client_search_normalize(
        COALESCE(client_row.email, '') || ' ' || COALESCE(client_row.first_name, '') || ' ' ||
        COALESCE(client_row.last_name, '') || ' ' || COALESCE(client_row.phone, '')
      ) AS search_document,
      (client_row.id::text = v_query) AS subject_exact,
      COALESCE(order_match.exact_match, false) AS order_exact,
      COALESCE(order_match.prefix_match, false) AS order_prefix,
      COALESCE(order_match.text_match, false) AS order_text,
      COALESCE(subscription_match.exact_match, false) AS subscription_exact
    FROM physical_candidate_ids AS candidate_id
    JOIN public.clients AS client_row ON client_row.id = candidate_id.client_id
    LEFT JOIN LATERAL (
      SELECT order_row.id, order_row.order_number, order_row.status, order_row.updated_at
        FROM public.commerce_orders AS order_row
       WHERE order_row.client_id = client_row.id
       ORDER BY order_row.created_at DESC, order_row.id
       LIMIT 1
    ) AS latest_order ON true
    LEFT JOIN LATERAL (
      SELECT
        bool_or(order_row.id::text = v_query OR
          public.admin_client_search_normalize(order_row.order_number) = v_query_normalized) AS exact_match,
        bool_or(public.admin_client_search_normalize(order_row.order_number)
          LIKE v_query_normalized || '%') AS prefix_match,
        bool_or(public.admin_client_search_normalize(order_row.order_number)
          LIKE '%' || v_query_normalized || '%') AS text_match
      FROM public.commerce_orders AS order_row
      WHERE order_row.client_id = client_row.id
    ) AS order_match ON true
    LEFT JOIN LATERAL (
      SELECT bool_or(subscription_row.id::text = v_query) AS exact_match,
        max(subscription_row.updated_at) AS last_activity_at
      FROM public.subscriptions AS subscription_row
      WHERE subscription_row.client_id = client_row.id
    ) AS subscription_match ON true
    WHERE client_row.identity_kind = 'customer'
  ), scored AS (
    SELECT source_row.*,
      similarity(source_row.search_document, v_query_normalized) AS text_similarity,
      GREATEST(
        similarity(source_row.normalized_name, v_query_normalized),
        similarity(source_row.normalized_reverse_name, v_query_normalized)
      ) AS name_similarity,
      CASE
        WHEN source_row.subject_exact OR source_row.normalized_email = v_query_normalized
          OR (v_query_digits <> '' AND source_row.normalized_phone = v_query_digits)
          OR source_row.order_exact OR source_row.subscription_exact THEN 0
        WHEN NOT v_query_is_email AND (source_row.normalized_name = v_query_normalized
          OR source_row.normalized_reverse_name = v_query_normalized) THEN 1
        WHEN source_row.normalized_email LIKE v_query_normalized || '%'
          OR (NOT v_query_is_email AND source_row.normalized_name LIKE v_query_normalized || '%')
          OR (NOT v_query_is_email AND source_row.normalized_reverse_name LIKE v_query_normalized || '%')
          OR (v_query_digits <> '' AND source_row.normalized_phone LIKE v_query_digits || '%')
          OR source_row.order_prefix THEN 2
        WHEN NOT v_query_is_email AND (
          source_row.search_document LIKE '%' || v_query_normalized || '%'
          OR (v_query_digits <> '' AND source_row.normalized_phone LIKE '%' || v_query_digits || '%')
          OR source_row.order_text) THEN 3
        WHEN NOT v_query_is_email AND (
          similarity(source_row.search_document, v_query_normalized) >= 0.32
          OR similarity(source_row.normalized_name, v_query_normalized) >= 0.28
          OR similarity(source_row.normalized_reverse_name, v_query_normalized) >= 0.28) THEN 4
        ELSE NULL
      END AS match_rank,
      CASE
        WHEN source_row.subject_exact THEN 'id'
        WHEN source_row.normalized_email = v_query_normalized
          OR source_row.normalized_email LIKE '%' || v_query_normalized || '%' THEN 'email'
        WHEN v_query_digits <> '' AND source_row.normalized_phone LIKE '%' || v_query_digits || '%' THEN 'phone'
        WHEN source_row.order_exact OR source_row.order_text THEN 'order'
        WHEN source_row.subscription_exact THEN 'subscription'
        WHEN NOT v_query_is_email AND (source_row.normalized_name LIKE '%' || v_query_normalized || '%'
          OR source_row.normalized_reverse_name LIKE '%' || v_query_normalized || '%'
          OR (NOT v_query_is_email AND similarity(source_row.normalized_name, v_query_normalized) >= 0.28)
          OR (NOT v_query_is_email AND similarity(source_row.normalized_reverse_name, v_query_normalized) >= 0.28)) THEN 'name'
        ELSE 'text'
      END AS match_reason
    FROM physical_base AS source_row
  ), eligible AS (
    SELECT * FROM scored
    WHERE match_rank IS NOT NULL
      AND (COALESCE(p_lifecycle_stage, 'all') = 'all' OR lifecycle_stage = p_lifecycle_stage)
  ), bounded AS (
    SELECT * FROM eligible
    ORDER BY match_rank, GREATEST(text_similarity, name_similarity) DESC,
      last_activity_at DESC NULLS LAST, source_kind, source_id
    LIMIT v_page_size OFFSET v_page::bigint * v_page_size::bigint
  )
  SELECT jsonb_build_object(
    'contractVersion', '2026-05-29.app-3a',
    'candidates', COALESCE(jsonb_agg(jsonb_build_object(
      'clientId', bounded.client_id,
      'displayName', bounded.display_name,
      'email', bounded.email,
      'phone', bounded.phone,
      'lifecycleStage', bounded.lifecycle_stage,
      'sources', bounded.sources,
      'testerId', bounded.tester_id,
      'testerStatus', bounded.tester_status,
      'waitlistId', bounded.waitlist_id,
      'latestOrderId', bounded.latest_order_id,
      'latestOrderNumber', bounded.latest_order_number,
      'latestOrderStatus', bounded.latest_order_status,
      'createdAt', bounded.created_at,
      'lastActivityAt', bounded.last_activity_at,
      'matchReason', bounded.match_reason,
      'confidence', CASE WHEN bounded.match_rank <= 1 THEN 'exact'
        WHEN bounded.match_rank <= 3 THEN 'high' ELSE 'medium' END
    ) ORDER BY bounded.match_rank,
      GREATEST(bounded.text_similarity, bounded.name_similarity) DESC,
      bounded.last_activity_at DESC NULLS LAST, bounded.source_kind, bounded.source_id), '[]'::jsonb),
    'totalCount', (SELECT count(*)::integer FROM eligible),
    'page', v_page,
    'pageSize', v_page_size
  ) INTO v_result
  FROM bounded;

  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.subscription_list_due_for_renewal(p_limit integer DEFAULT 50, p_as_of timestamp with time zone DEFAULT now()) RETURNS TABLE(subscription_id uuid, client_id uuid, next_cycle_at timestamp with time zone, cadence_days integer, template_version integer, currency text, region_code text, provider_kind text, provider_customer_ref text, provider_method_ref text, method_kind text, status text, payer_email text, payer_name text, method_status text, method_active boolean, method_expires_at timestamp with time zone, method_client_id uuid)
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
BEGIN
  IF p_limit IS NULL OR p_limit <= 0 OR p_limit > 500 THEN
    RAISE EXCEPTION 'subscription_list_due_for_renewal: p_limit must be between 1 and 500'
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
    WITH retry_due AS (
      SELECT
        s.id          AS subscription_id,
        s.client_id   AS client_id,
        c.scheduled_at AS next_cycle_at,
        s.cadence_days,
        s.template_version,
        s.currency,
        s.region_code,
        m.provider_kind,
        CASE
          WHEN m.client_id = s.client_id AND m.active = true AND m.status = 'active'
          THEN m.provider_customer_ref
          ELSE NULL
        END AS provider_customer_ref,
        CASE
          WHEN m.client_id = s.client_id AND m.active = true AND m.status = 'active'
          THEN m.provider_method_ref
          ELSE NULL
        END AS provider_method_ref,
        COALESCE(m.method_kind, s.payment_method_kind, '') AS method_kind,
        m.status,
        cl.email AS payer_email,
        NULLIF(btrim(concat_ws(' ', cl.first_name, cl.last_name)), '') AS payer_name,
        m.status AS method_status,
        m.active AS method_active,
        m.expires_at AS method_expires_at,
        m.client_id AS method_client_id
      FROM public.subscriptions s
      JOIN public.clients cl
        ON cl.id = s.client_id
      LEFT JOIN LATERAL (
        SELECT pm.provider_kind, pm.provider_customer_ref, pm.provider_method_ref,
               pm.method_kind, pm.status, pm.active, pm.expires_at, pm.client_id,
               pm.updated_at, pm.created_at
          FROM public.commerce_payment_method_refs pm
         WHERE pm.subscription_id = s.id
         ORDER BY
           (pm.active = true AND pm.status = 'active') DESC,
           pm.active DESC,
           pm.updated_at DESC,
           pm.created_at DESC
         LIMIT 1
      ) m ON true
      JOIN public.subscription_cycles c
        ON c.subscription_id = s.id
       AND c.status = 'retry_scheduled'
       AND c.next_retry_at IS NOT NULL
       AND c.next_retry_at <= p_as_of
       -- Quarantine skip (retry lane). A bare timestamp comparison, never a
       -- status: an elapsed value re-admits the row on the very next pass with
       -- no unquarantine write required, so a lost clear cannot strand anyone.
       AND (c.renewal_quarantined_until IS NULL OR c.renewal_quarantined_until <= p_as_of)
      WHERE s.status = 'active'
      ORDER BY c.next_retry_at ASC, s.id ASC
      LIMIT p_limit
      FOR UPDATE OF s SKIP LOCKED
    ),
    normal_due AS (
      SELECT
        s.id          AS subscription_id,
        s.client_id   AS client_id,
        s.next_cycle_at,
        s.cadence_days,
        s.template_version,
        s.currency,
        s.region_code,
        m.provider_kind,
        CASE
          WHEN m.client_id = s.client_id AND m.active = true AND m.status = 'active'
          THEN m.provider_customer_ref
          ELSE NULL
        END,
        CASE
          WHEN m.client_id = s.client_id AND m.active = true AND m.status = 'active'
          THEN m.provider_method_ref
          ELSE NULL
        END AS provider_method_ref,
        COALESCE(m.method_kind, s.payment_method_kind, '') AS method_kind,
        m.status,
        cl.email AS payer_email,
        NULLIF(btrim(concat_ws(' ', cl.first_name, cl.last_name)), '') AS payer_name,
        m.status AS method_status,
        m.active AS method_active,
        m.expires_at AS method_expires_at,
        m.client_id AS method_client_id
      FROM public.subscriptions s
      JOIN public.clients cl
        ON cl.id = s.client_id
      LEFT JOIN LATERAL (
        SELECT pm.provider_kind, pm.provider_customer_ref, pm.provider_method_ref,
               pm.method_kind, pm.status, pm.active, pm.expires_at, pm.client_id,
               pm.updated_at, pm.created_at
          FROM public.commerce_payment_method_refs pm
         WHERE pm.subscription_id = s.id
         ORDER BY
           (pm.active = true AND pm.status = 'active') DESC,
           pm.active DESC,
           pm.updated_at DESC,
           pm.created_at DESC
         LIMIT 1
      ) m ON true
      WHERE s.status = 'active'
        AND s.next_cycle_at IS NOT NULL
        AND s.next_cycle_at <= p_as_of
        AND NOT EXISTS (
          SELECT 1
            FROM public.subscription_cycles c
           WHERE c.subscription_id = s.id
             AND c.status IN ('payment_pending', 'retry_scheduled', 'payment_failed')
        )
        -- Quarantine skip (normal lane). The open-cycle guard above already
        -- hides the common case, so this covers the row whose cycle left those
        -- statuses while still quarantined; without it the same failing row
        -- would come straight back through the other lane.
        AND NOT EXISTS (
          SELECT 1
            FROM public.subscription_cycles c
           WHERE c.subscription_id = s.id
             AND c.renewal_quarantined_until > p_as_of
        )
      ORDER BY s.next_cycle_at ASC, s.id ASC
      LIMIT p_limit
      FOR UPDATE OF s SKIP LOCKED
    )
    SELECT *
      FROM (
        SELECT * FROM retry_due
        UNION ALL
        SELECT * FROM normal_due
      ) due
     ORDER BY due.next_cycle_at ASC, due.subscription_id ASC
     LIMIT p_limit;
END;
$$;

CREATE OR REPLACE FUNCTION public.customer_support_absorb_lead_v1(p_operator_id uuid, p_customer_id uuid, p_lead_id uuid, p_expected_lead_email text, p_idempotency_key text, p_now timestamp with time zone) RETURNS jsonb
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_catalog'
    AS $_$
DECLARE
  v_existing public.customer_support_subscription_commands%ROWTYPE;
  v_lead public.clients%ROWTYPE;
  v_customer public.clients%ROWTYPE;
  v_now timestamptz := COALESCE(p_now, now());
  v_expected text := lower(btrim(COALESCE(p_expected_lead_email, '')));
  v_fingerprint text;
  v_refusal_code text;
  v_outcome text;
  v_response jsonb;
  v_referencing record;
  v_blocking text[] := ARRAY[]::text[];
  v_unclassified text[] := ARRAY[]::text[];
  v_named text[] := ARRAY[]::text[];
  v_present bigint;
  v_moved bigint;
  v_carried jsonb := jsonb_build_object(
    'personalization', 0, 'consents', 0, 'sourceLinks', 0, 'deliveries', 0);
  v_carried_by_table jsonb := '{}'::jsonb;
  v_conflict record;
  v_lead_email text;
  v_tombstone text;
  v_subject_id uuid;
BEGIN
  -- The gate answers first, before a single row of customer state is read.
  PERFORM public.communications_require_active_operator(p_operator_id);

  -- And the operator is a person. Re-derived from the administrator roster for the
  -- principal this call was handed, never taken from a claim the caller supplied. A
  -- principal with no administrator row answers NULL here and is unaffected.
  IF COALESCE((
    SELECT admin_row.is_machine_actor
      FROM public.admin_users AS admin_row
     WHERE admin_row.id = p_operator_id
  ), false) THEN
    RAISE EXCEPTION 'customer_support_command_requires_human' USING ERRCODE = '42501';
  END IF;

  IF p_customer_id IS NULL
     OR p_lead_id IS NULL
     OR p_customer_id = p_lead_id
     OR char_length(btrim(COALESCE(p_idempotency_key, ''))) NOT BETWEEN 8 AND 200
     OR char_length(v_expected) NOT BETWEEN 3 AND 320
  THEN
    RAISE EXCEPTION 'customer_support_absorb_lead_invalid' USING ERRCODE = '22023';
  END IF;

  v_fingerprint := encode(
    pg_catalog.sha256(pg_catalog.convert_to(
      'lead_absorption|' || p_customer_id::text || '|' || p_lead_id::text || '|' || v_expected, 'utf8')),
    'hex');

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('customer-support-subscription:' || p_idempotency_key, 0)
  );
  -- Both subjects, in a fixed id order, so two absorptions naming the same pair
  -- from opposite directions serialize instead of deadlocking. Proving the lead
  -- is empty and then emptying it has to be one indivisible act: a concurrent
  -- insert between the two is the only way this routine could destroy data.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('customer-support-subject:'
      || LEAST(p_customer_id, p_lead_id)::text, 0));
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('customer-support-subject:'
      || GREATEST(p_customer_id, p_lead_id)::text, 0));

  SELECT * INTO v_existing
    FROM public.customer_support_subscription_commands AS command_row
   WHERE command_row.idempotency_key = p_idempotency_key;

  IF FOUND THEN
    IF v_existing.payload_fingerprint <> v_fingerprint
       OR v_existing.operator_id <> p_operator_id
       OR v_existing.target_id <> p_lead_id
       OR v_existing.command_kind <> 'lead_absorption'
    THEN
      RAISE EXCEPTION 'customer_support_idempotency_conflict' USING ERRCODE = '23505';
    END IF;
    IF v_existing.response->>'outcome' IN ('refused', 'conflict') THEN
      RETURN v_existing.response;
    END IF;
    RETURN jsonb_set(v_existing.response, '{outcome}', '"replayed"'::jsonb, true);
  END IF;

  SELECT lead_row.auth_user_id, lead_row.email, lead_row.metadata
    INTO v_lead.auth_user_id, v_lead.email, v_lead.metadata
    FROM public.clients AS lead_row
   WHERE lead_row.id = p_lead_id
   FOR UPDATE;
  IF NOT FOUND THEN
    v_refusal_code := 'lead_not_found';
  END IF;

  IF v_refusal_code IS NULL THEN
    SELECT customer_row.id INTO v_customer.id
      FROM public.clients AS customer_row
     WHERE customer_row.id = p_customer_id
     FOR UPDATE;
    IF NOT FOUND THEN
      v_refusal_code := 'customer_not_found';
    ELSE
      v_subject_id := p_customer_id;
    END IF;
  END IF;

  v_lead_email := v_lead.email;

  -- An already-absorbed pair is a settled fact, not a stale expectation: the
  -- address it is asked about is precisely the one this routine moved away.
  IF v_refusal_code IS NULL
     AND v_lead.metadata #>> '{absorption,absorbedIntoClientId}' = p_customer_id::text
  THEN
    v_outcome := 'noop';
  ELSIF v_refusal_code IS NULL
        AND lower(btrim(COALESCE(v_lead.email, ''))) IS DISTINCT FROM v_expected
  THEN
    -- The operator acted on a snapshot of the holder; a changed address means
    -- the console must be re-read before anything is moved.
    v_refusal_code := 'lead_email_expectation_conflict';
  END IF;

  IF v_refusal_code IS NULL AND v_outcome IS NULL AND v_lead.auth_user_id IS NOT NULL THEN
    v_refusal_code := 'lead_has_identity';
  END IF;

  IF v_refusal_code IS NULL AND v_outcome IS NULL THEN
    -- The live foreign-key set, not a compiled-in list. `conkey`/`confkey` are
    -- walked together so the column is the one that actually points at
    -- clients.id whatever it is called locally.
    FOR v_referencing IN
      SELECT referencing.relname::text AS table_name,
             local_column.attname::text AS column_name,
             policy_row.disposition AS disposition
        FROM pg_catalog.pg_constraint AS fk
        JOIN pg_catalog.pg_class AS referencing ON referencing.oid = fk.conrelid
        JOIN pg_catalog.pg_namespace AS referencing_schema
          ON referencing_schema.oid = referencing.relnamespace
        CROSS JOIN LATERAL unnest(fk.conkey, fk.confkey) AS key_pair(local_attnum, remote_attnum)
        JOIN pg_catalog.pg_attribute AS local_column
          ON local_column.attrelid = fk.conrelid AND local_column.attnum = key_pair.local_attnum
        JOIN pg_catalog.pg_attribute AS remote_column
          ON remote_column.attrelid = fk.confrelid AND remote_column.attnum = key_pair.remote_attnum
        LEFT JOIN public.client_absorption_policy AS policy_row
          ON policy_row.table_name = referencing.relname
       WHERE fk.contype = 'f'
         AND fk.confrelid = 'public.clients'::regclass
         AND referencing_schema.nspname = 'public'
         AND remote_column.attname = 'id'
       ORDER BY 1, 2
    LOOP
      IF v_referencing.disposition IS NULL THEN
        IF NOT (v_referencing.table_name = ANY (v_unclassified)) THEN
          v_unclassified := v_unclassified || v_referencing.table_name;
        END IF;
      ELSIF v_referencing.disposition = 'block' THEN
        EXECUTE format(
          'SELECT count(*) FROM public.%I AS blocking_row WHERE blocking_row.%I = $1',
          v_referencing.table_name, v_referencing.column_name)
          INTO v_present USING p_lead_id;
        IF v_present > 0 AND NOT (v_referencing.table_name = ANY (v_blocking)) THEN
          v_blocking := v_blocking || v_referencing.table_name;
        END IF;
      END IF;
    END LOOP;

    IF array_length(v_unclassified, 1) IS NOT NULL THEN
      -- Fail closed, and say where the answer goes.
      v_refusal_code := 'unclassified_referencing_table';
      v_named := v_unclassified;
    ELSIF array_length(v_blocking, 1) IS NOT NULL THEN
      v_refusal_code := 'lead_has_commercial_footprint';
      v_named := v_blocking;
    END IF;
  END IF;

  IF v_refusal_code IS NULL AND v_outcome IS NULL THEN
    FOR v_referencing IN
      SELECT referencing.relname::text AS table_name,
             local_column.attname::text AS column_name
        FROM pg_catalog.pg_constraint AS fk
        JOIN pg_catalog.pg_class AS referencing ON referencing.oid = fk.conrelid
        JOIN pg_catalog.pg_namespace AS referencing_schema
          ON referencing_schema.oid = referencing.relnamespace
        CROSS JOIN LATERAL unnest(fk.conkey, fk.confkey) AS key_pair(local_attnum, remote_attnum)
        JOIN pg_catalog.pg_attribute AS local_column
          ON local_column.attrelid = fk.conrelid AND local_column.attnum = key_pair.local_attnum
        JOIN pg_catalog.pg_attribute AS remote_column
          ON remote_column.attrelid = fk.confrelid AND remote_column.attnum = key_pair.remote_attnum
        JOIN public.client_absorption_policy AS policy_row
          ON policy_row.table_name = referencing.relname
       WHERE fk.contype = 'f'
         AND fk.confrelid = 'public.clients'::regclass
         AND referencing_schema.nspname = 'public'
         AND remote_column.attname = 'id'
         AND policy_row.disposition = 'carry'
       ORDER BY 1, 2
    LOOP
      BEGIN
        IF v_referencing.table_name = 'client_consents' THEN
          -- The one arbitration the schema cannot express: client_consents has
          -- no uniqueness, so a same-kind collision would otherwise leave the
          -- customer holding two answers to one legal question. The lead's grant
          -- travels only when it is the earlier evidence of its kind; the rest
          -- stay on the archived record and are audited below.
          UPDATE public.client_consents AS lead_consent
             SET client_id = p_customer_id
           WHERE lead_consent.client_id = p_lead_id
             AND NOT EXISTS (
               SELECT 1
                 FROM public.client_consents AS held_consent
                WHERE held_consent.client_id = p_customer_id
                  AND held_consent.consent_type = lead_consent.consent_type
                  AND held_consent.captured_at <= lead_consent.captured_at);
          GET DIAGNOSTICS v_moved = ROW_COUNT;
        ELSE
          EXECUTE format(
            'UPDATE public.%I AS carried_row SET %I = $1 WHERE carried_row.%I = $2',
            v_referencing.table_name, v_referencing.column_name, v_referencing.column_name)
            USING p_customer_id, p_lead_id;
          GET DIAGNOSTICS v_moved = ROW_COUNT;
        END IF;
      EXCEPTION WHEN unique_violation THEN
        -- The customer already occupies this table's own key. Theirs is kept
        -- untouched and the lead's stays on the archived record; overwriting
        -- would be the one destructive act this routine must never perform.
        v_moved := 0;
        INSERT INTO public.customer_support_subscription_audit_events (
          operator_id, subject_id, target_id, command_kind, requested_action,
          idempotency_key, outcome, refusal_code, value_before, value_after, occurred_at
        ) VALUES (
          p_operator_id, v_subject_id, p_lead_id, 'lead_absorption',
          'absorb_lead_carry_conflict', p_idempotency_key, 'noop', NULL,
          v_referencing.table_name, 'retained_by_customer', v_now
        );
      END;
      v_carried_by_table := v_carried_by_table
        || jsonb_build_object(v_referencing.table_name, v_moved);
    END LOOP;

    FOR v_conflict IN
      SELECT lead_consent.consent_type,
             lead_consent.captured_at AS lead_captured_at,
             (SELECT min(held_consent.captured_at)
                FROM public.client_consents AS held_consent
               WHERE held_consent.client_id = p_customer_id
                 AND held_consent.consent_type = lead_consent.consent_type) AS retained_captured_at
        FROM public.client_consents AS lead_consent
       WHERE lead_consent.client_id = p_lead_id
       ORDER BY lead_consent.consent_type, lead_consent.captured_at
    LOOP
      INSERT INTO public.customer_support_subscription_audit_events (
        operator_id, subject_id, target_id, command_kind, requested_action,
        idempotency_key, outcome, refusal_code, value_before, value_after, occurred_at
      ) VALUES (
        p_operator_id, v_subject_id, p_lead_id, 'lead_absorption',
        'absorb_lead_consent_conflict', p_idempotency_key, 'noop', NULL,
        v_conflict.consent_type || '@' || v_conflict.lead_captured_at::text,
        v_conflict.consent_type || '@' || v_conflict.retained_captured_at::text,
        v_now
      );
    END LOOP;

    v_carried := jsonb_build_object(
      'personalization', COALESCE((v_carried_by_table->>'customer_personalization')::int, 0),
      'consents', COALESCE((v_carried_by_table->>'client_consents')::int, 0),
      'sourceLinks', COALESCE((v_carried_by_table->>'client_source_links')::int, 0),
      'deliveries', COALESCE((v_carried_by_table->>'communication_email_deliveries')::int, 0));

    -- The reserved .invalid namespace can never resolve, so the archived row
    -- can hold an address forever without anyone ever mailing it -- and the
    -- real one is now free for the correction that was refused.
    v_tombstone := 'absorbed+' || replace(p_lead_id::text, '-', '') || '@absorbed.invalid';
    UPDATE public.clients AS lead_row
       SET email = v_tombstone,
           metadata = lead_row.metadata || jsonb_build_object(
             'absorption', jsonb_build_object(
               'absorbedIntoClientId', p_customer_id,
               'absorbedAt', v_now,
               'originalEmail', v_lead_email,
               'idempotencyKey', p_idempotency_key,
               'carried', v_carried_by_table)),
           updated_at = v_now
     WHERE lead_row.id = p_lead_id;
  END IF;

  IF v_refusal_code IS NOT NULL THEN
    v_outcome := CASE
      WHEN v_refusal_code = 'lead_email_expectation_conflict' THEN 'conflict'
      ELSE 'refused' END;
    v_response := jsonb_build_object(
      'outcome', v_outcome,
      'action', 'absorb_lead',
      'leadId', p_lead_id,
      'refusalCode', v_refusal_code
    );
    IF v_refusal_code IN ('lead_has_commercial_footprint', 'unclassified_referencing_table') THEN
      v_response := v_response || jsonb_build_object('blockingTables', to_jsonb(v_named));
    END IF;
  ELSE
    v_response := jsonb_build_object(
      'outcome', COALESCE(v_outcome, 'applied'),
      'action', 'absorb_lead',
      'leadId', p_lead_id,
      'customerId', p_customer_id,
      'carried', v_carried
    );
  END IF;

  INSERT INTO public.customer_support_subscription_commands (
    idempotency_key, payload_fingerprint, operator_id, subject_id, target_id,
    command_kind, response, created_at
  ) VALUES (
    p_idempotency_key, v_fingerprint, p_operator_id, v_subject_id, p_lead_id,
    'lead_absorption', v_response, v_now
  );

  INSERT INTO public.customer_support_subscription_audit_events (
    operator_id, subject_id, target_id, command_kind, requested_action,
    idempotency_key, outcome, refusal_code, value_before, value_after, occurred_at
  ) VALUES (
    p_operator_id, v_subject_id, p_lead_id, 'lead_absorption', 'absorb_lead',
    p_idempotency_key, v_response->>'outcome', v_refusal_code,
    v_lead_email,
    CASE WHEN v_refusal_code IS NULL AND v_outcome IS NULL THEN v_tombstone ELSE NULL END,
    v_now
  );

  RETURN v_response;
END;
$_$;

CREATE OR REPLACE FUNCTION public.marketing_rehome_client_lead_v1(p_client_id uuid, p_now timestamp with time zone DEFAULT NULL::timestamp with time zone) RETURNS jsonb
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_catalog'
    AS $_$
DECLARE
  v_client public.clients%ROWTYPE;
  v_now timestamptz := COALESCE(p_now, now());
  v_email text;
  v_contact_id uuid;
  v_placeholder text;
  v_existing_marketing_client_id uuid;
  v_reference record;
  v_present boolean;
  v_blocking text[] := ARRAY[]::text[];
  v_unclassified text[] := ARRAY[]::text[];
BEGIN
  IF p_client_id IS NULL THEN
    RAISE EXCEPTION 'marketing_rehome_client_lead_invalid'
      USING ERRCODE = '22023';
  END IF;

  SELECT client_row.acquisition_source, client_row.auth_user_id, client_row.email,
         client_row.first_name, client_row.identity_kind, client_row.last_name,
         client_row.marketing_contact_id
    INTO v_client.acquisition_source, v_client.auth_user_id, v_client.email,
         v_client.first_name, v_client.identity_kind, v_client.last_name,
         v_client.marketing_contact_id
    FROM public.clients AS client_row
   WHERE client_row.id = p_client_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'outcome', 'refused',
      'refusalCode', 'client_not_found',
      'clientId', p_client_id
    );
  END IF;

  IF v_client.identity_kind = 'marketing_lead' THEN
    RETURN jsonb_build_object(
      'outcome', 'noop',
      'clientId', p_client_id,
      'contactId', v_client.marketing_contact_id
    );
  END IF;

  IF v_client.acquisition_source IS DISTINCT FROM 'hidden_configurator' THEN
    RETURN jsonb_build_object(
      'outcome', 'refused',
      'refusalCode', 'not_hidden_configurator',
      'clientId', p_client_id
    );
  END IF;

  IF v_client.auth_user_id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'outcome', 'refused',
      'refusalCode', 'client_has_identity',
      'clientId', p_client_id
    );
  END IF;

  FOR v_reference IN
    SELECT referencing.relname::text AS table_name,
           local_column.attname::text AS column_name,
           policy_row.disposition
      FROM pg_catalog.pg_constraint AS fk
      JOIN pg_catalog.pg_class AS referencing ON referencing.oid = fk.conrelid
      JOIN pg_catalog.pg_namespace AS referencing_schema
        ON referencing_schema.oid = referencing.relnamespace
      CROSS JOIN LATERAL unnest(fk.conkey, fk.confkey)
        AS key_pair(local_attnum, remote_attnum)
      JOIN pg_catalog.pg_attribute AS local_column
        ON local_column.attrelid = fk.conrelid
       AND local_column.attnum = key_pair.local_attnum
      JOIN pg_catalog.pg_attribute AS remote_column
        ON remote_column.attrelid = fk.confrelid
       AND remote_column.attnum = key_pair.remote_attnum
      LEFT JOIN public.client_absorption_policy AS policy_row
        ON policy_row.table_name = referencing.relname
     WHERE fk.contype = 'f'
       AND fk.confrelid = 'public.clients'::regclass
       AND referencing_schema.nspname = 'public'
       AND remote_column.attname = 'id'
     ORDER BY 1, 2
  LOOP
    IF v_reference.disposition IS NULL THEN
      IF NOT (v_reference.table_name = ANY (v_unclassified)) THEN
        v_unclassified := v_unclassified || v_reference.table_name;
      END IF;
    ELSIF v_reference.disposition = 'block' THEN
      EXECUTE format(
        'SELECT EXISTS (SELECT 1 FROM public.%I AS referenced_row WHERE referenced_row.%I = $1)',
        v_reference.table_name,
        v_reference.column_name
      ) INTO v_present USING p_client_id;
      IF v_present AND NOT (v_reference.table_name = ANY (v_blocking)) THEN
        v_blocking := v_blocking || v_reference.table_name;
      END IF;
    END IF;
  END LOOP;

  IF array_length(v_unclassified, 1) IS NOT NULL THEN
    RETURN jsonb_build_object(
      'outcome', 'refused',
      'refusalCode', 'unclassified_referencing_table',
      'clientId', p_client_id,
      'blockingTables', to_jsonb(v_unclassified)
    );
  END IF;

  IF array_length(v_blocking, 1) IS NOT NULL THEN
    RETURN jsonb_build_object(
      'outcome', 'refused',
      'refusalCode', 'client_has_customer_footprint',
      'clientId', p_client_id,
      'blockingTables', to_jsonb(v_blocking)
    );
  END IF;

  v_email := lower(btrim(COALESCE(v_client.email, '')));
  IF char_length(v_email) NOT BETWEEN 3 AND 320
     OR v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  THEN
    RETURN jsonb_build_object(
      'outcome', 'refused',
      'refusalCode', 'client_email_invalid',
      'clientId', p_client_id
    );
  END IF;

  INSERT INTO public.communication_contacts (
    normalized_email, display_email, first_name, last_name, metadata, updated_at
  ) VALUES (
    v_email,
    btrim(v_client.email),
    v_client.first_name,
    v_client.last_name,
    jsonb_build_object(
      'source', 'personalization_lead_namespace_backfill',
      'legacyClientId', p_client_id
    ),
    v_now
  )
  ON CONFLICT (normalized_email) DO UPDATE
    SET updated_at = EXCLUDED.updated_at,
        first_name = COALESCE(public.communication_contacts.first_name, EXCLUDED.first_name),
        last_name = COALESCE(public.communication_contacts.last_name, EXCLUDED.last_name),
        metadata = public.communication_contacts.metadata || EXCLUDED.metadata
  RETURNING id INTO v_contact_id;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'personalization-marketing-contact:' || v_contact_id::text,
      0
    )
  );

  SELECT client_row.id
    INTO v_existing_marketing_client_id
    FROM public.clients AS client_row
   WHERE client_row.identity_kind = 'marketing_lead'
     AND client_row.marketing_contact_id = v_contact_id
     AND client_row.id <> p_client_id
   LIMIT 1;

  IF v_existing_marketing_client_id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'outcome', 'refused',
      'refusalCode', 'marketing_contact_already_linked',
      'clientId', p_client_id,
      'existingClientId', v_existing_marketing_client_id
    );
  END IF;

  INSERT INTO public.communication_contact_links (
    contact_id, source_system, source_table, source_id, metadata
  ) VALUES (
    v_contact_id,
    'platform',
    'clients',
    p_client_id,
    jsonb_build_object('identityKind', 'marketing_lead')
  )
  ON CONFLICT (source_system, source_table, source_id)
    WHERE source_id IS NOT NULL
  DO UPDATE
    SET contact_id = EXCLUDED.contact_id,
        metadata = public.communication_contact_links.metadata || EXCLUDED.metadata;

  v_placeholder := 'lead+' || replace(p_client_id::text, '-', '') || '@marketing.invalid';

  UPDATE public.clients AS client_row
     SET email = v_placeholder,
         identity_kind = 'marketing_lead',
         marketing_contact_id = v_contact_id,
         updated_at = v_now,
         metadata = client_row.metadata || jsonb_build_object(
           'marketingLeadNamespace', jsonb_build_object(
             'contactId', v_contact_id,
             'rehomedAt', to_char(v_now AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
             'source', 'personalization_lead'
           )
         )
   WHERE client_row.id = p_client_id;

  RETURN jsonb_build_object(
    'outcome', 'applied',
    'clientId', p_client_id,
    'contactId', v_contact_id
  );
END;
$_$;

CREATE OR REPLACE FUNCTION public.customer_support_correct_subject_email_v1(p_operator_id uuid, p_subject_id uuid, p_expected_email text, p_new_email text, p_idempotency_key text, p_now timestamp with time zone) RETURNS jsonb
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_catalog'
    AS $_$
DECLARE
  v_existing public.customer_support_subscription_commands%ROWTYPE;
  v_subject public.clients%ROWTYPE;
  v_now timestamptz := COALESCE(p_now, now());
  v_new_email text := lower(btrim(COALESCE(p_new_email, '')));
  v_fingerprint text;
  v_refusal_code text;
  v_outcome text;
  v_response jsonb;
  v_before text;
  v_linked boolean := false;
  v_audit_id uuid := gen_random_uuid();
BEGIN
  PERFORM public.communications_require_active_operator(p_operator_id);

  -- And the operator is a person. Re-derived from the administrator roster for the
  -- principal this call was handed, never taken from a claim the caller supplied. A
  -- principal with no administrator row answers NULL here and is unaffected.
  IF COALESCE((
    SELECT admin_row.is_machine_actor
      FROM public.admin_users AS admin_row
     WHERE admin_row.id = p_operator_id
  ), false) THEN
    RAISE EXCEPTION 'customer_support_command_requires_human' USING ERRCODE = '42501';
  END IF;

  IF p_subject_id IS NULL
     OR char_length(btrim(COALESCE(p_idempotency_key, ''))) NOT BETWEEN 8 AND 200
     OR char_length(v_new_email) NOT BETWEEN 3 AND 320
     OR v_new_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  THEN
    RAISE EXCEPTION 'customer_support_email_correction_invalid' USING ERRCODE = '22023';
  END IF;

  v_fingerprint := encode(
    pg_catalog.sha256(pg_catalog.convert_to(
      'email_correction|' || p_subject_id::text || '|' || lower(btrim(COALESCE(p_expected_email, '')))
      || '|' || v_new_email, 'utf8')),
    'hex');

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('customer-support-subscription:' || p_idempotency_key, 0)
  );

  SELECT * INTO v_existing
    FROM public.customer_support_subscription_commands AS command_row
   WHERE command_row.idempotency_key = p_idempotency_key;

  IF FOUND THEN
    IF v_existing.payload_fingerprint <> v_fingerprint
       OR v_existing.operator_id <> p_operator_id
       OR v_existing.target_id <> p_subject_id
       OR v_existing.command_kind <> 'email_correction'
    THEN
      RAISE EXCEPTION 'customer_support_idempotency_conflict' USING ERRCODE = '23505';
    END IF;
    IF v_existing.response->>'outcome' IN ('refused', 'conflict') THEN
      RETURN v_existing.response;
    END IF;
    RETURN jsonb_set(v_existing.response, '{outcome}', '"replayed"'::jsonb, true);
  END IF;

  SELECT subject_row.auth_user_id, subject_row.email
    INTO v_subject.auth_user_id, v_subject.email
    FROM public.clients AS subject_row
   WHERE subject_row.id = p_subject_id
   FOR UPDATE;
  IF NOT FOUND THEN
    v_refusal_code := 'subject_not_found';
  ELSIF lower(btrim(COALESCE(v_subject.email, ''))) IS DISTINCT FROM lower(btrim(COALESCE(p_expected_email, ''))) THEN
    -- The operator acted on a snapshot; a changed address means someone else moved
    -- first and the correction must be re-read rather than replayed blind.
    v_refusal_code := 'email_expectation_conflict';
  END IF;

  v_before := v_subject.email;
  v_linked := v_subject.auth_user_id IS NOT NULL;

  IF v_refusal_code IS NULL AND lower(btrim(COALESCE(v_subject.email, ''))) = v_new_email THEN
    v_outcome := 'noop';
  END IF;

  IF v_refusal_code IS NULL AND v_outcome IS NULL THEN
    BEGIN
      UPDATE public.clients AS subject_row
         SET email = v_new_email,
             updated_at = v_now
       WHERE subject_row.id = p_subject_id;
    EXCEPTION WHEN unique_violation THEN
      -- lower(email) is unique. A readable refusal, not a raised 23505 the BFF would
      -- have to guess at.
      v_refusal_code := 'email_already_in_use';
    END;
  END IF;

  IF v_refusal_code IS NOT NULL THEN
    v_outcome := CASE
      WHEN v_refusal_code IN ('email_expectation_conflict', 'email_already_in_use') THEN 'conflict'
      ELSE 'refused' END;
    v_response := jsonb_build_object(
      'outcome', v_outcome,
      'action', 'correct_email',
      'subjectId', p_subject_id,
      'refusalCode', v_refusal_code
    );
  ELSE
    v_response := jsonb_build_object(
      'outcome', COALESCE(v_outcome, 'applied'),
      'action', 'correct_email',
      'subjectId', p_subject_id,
      'authUserLinked', v_linked
    );
  END IF;

  INSERT INTO public.customer_support_subscription_commands (
    idempotency_key, payload_fingerprint, operator_id, subject_id, target_id,
    command_kind, response, created_at
  ) VALUES (
    p_idempotency_key, v_fingerprint, p_operator_id, p_subject_id, p_subject_id,
    'email_correction', v_response, v_now
  );

  INSERT INTO public.customer_support_subscription_audit_events (
    id, operator_id, subject_id, target_id, command_kind, requested_action,
    idempotency_key, outcome, refusal_code, value_before, value_after, occurred_at
  ) VALUES (
    v_audit_id, p_operator_id, p_subject_id, p_subject_id,
    'email_correction', 'correct_email', p_idempotency_key,
    v_response->>'outcome', v_refusal_code,
    v_before,
    CASE WHEN v_refusal_code IS NULL THEN v_new_email ELSE NULL END,
    v_now
  );

  RETURN v_response;
END;
$_$;

-- Proposal only: remove legacy cross-customer browser access activated by membership reads.
-- Retain customer-own policies and active distributor own membership read.
DROP POLICY admin_all_address_canon_localities ON public.address_canon_localities;
DROP POLICY admin_all_address_canon_postal_localities ON public.address_canon_postal_localities;
DROP POLICY admin_all_address_canon_streets ON public.address_canon_streets;
DROP POLICY admin_all_addresses ON public.addresses;
DROP POLICY admin_all_clients ON public.clients;
DROP POLICY admin_all_customer_account_events ON public.customer_account_events;
DROP POLICY admin_all_customer_orderer_profiles ON public.customer_orderer_profiles;
DROP POLICY admin_all_pets ON public.pets;

GRANT EXECUTE ON FUNCTION public.record_admin_audit_event(uuid,text,text,text,text,jsonb,jsonb,text,text,uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.subscription_current_template_snapshot(uuid) TO service_role;
GRANT SELECT (id, membership_state, role, is_machine_actor) ON public.admin_users TO service_role;
GRANT SELECT (principal_id, active) ON public.platform_communication_operators TO service_role;
GRANT SELECT (status, template_slug) ON public.email_sends TO service_role;
GRANT SELECT (event_type) ON public.email_events TO service_role;
GRANT SELECT (id, email, first_name, last_name, phone, identity_kind, lifecycle_stage, created_at, updated_at, acquisition_source, auth_user_id, metadata, marketing_contact_id) ON public.clients TO service_role;
GRANT SELECT (id, client_id, order_number, status, created_at, updated_at) ON public.commerce_orders TO service_role;
GRANT SELECT (id, client_id, updated_at, cadence_days, template_version, currency, region_code, payment_method_kind, status, next_cycle_at) ON public.subscriptions TO service_role;
GRANT SELECT (subscription_id, status, next_retry_at, scheduled_at, renewal_quarantined_until) ON public.subscription_cycles TO service_role;
GRANT SELECT (subscription_id, provider_kind, provider_customer_ref, provider_method_ref, method_kind, status, active, expires_at, client_id, updated_at, created_at) ON public.commerce_payment_method_refs TO service_role;
GRANT SELECT (id, slug, status, name, description, ingredients, allergens, marketing_content, primary_sku_id) ON public.catalog_products TO service_role;
GRANT SELECT (id, product_id, sku, title, pet_type, status, net_weight_g, format_code, unit_form_code, is_addon, sellable_standalone, sellable_in_subscription, requires_pet_profile, min_order_qty) ON public.catalog_skus TO service_role;
GRANT SELECT (subscription_id, event_type, occurred_at) ON public.subscription_events TO service_role;
GRANT UPDATE (email, identity_kind, marketing_contact_id, metadata, updated_at) ON public.clients TO service_role;
GRANT SELECT (client_id) ON public.commerce_carts TO service_role;
GRANT SELECT (client_id) ON public.commerce_checkout_sessions TO service_role;
GRANT SELECT (client_id) ON public.customer_delivery_preferences TO service_role;
GRANT SELECT (client_id) ON public.customer_external_refs TO service_role;
GRANT SELECT (client_id) ON public.customer_orderer_profiles TO service_role;
GRANT SELECT (client_id) ON public.customer_payment_preferences TO service_role;
GRANT SELECT (client_id) ON public.pets TO service_role;
GRANT SELECT (client_id) ON public.promotion_code_claims TO service_role;
GRANT SELECT (client_id) ON public.promotion_redemptions TO service_role;
GRANT SELECT (client_id, consent_type, captured_at) ON public.client_consents TO service_role;
GRANT SELECT (client_id) ON public.client_source_links TO service_role;
GRANT SELECT (client_id) ON public.customer_personalization TO service_role;
GRANT UPDATE (client_id) ON public.client_consents TO service_role;
GRANT UPDATE (client_id) ON public.client_source_links TO service_role;
GRANT UPDATE (client_id) ON public.customer_personalization TO service_role;
GRANT UPDATE (updated_at) ON public.subscriptions TO service_role;

-- Existing expression indexes execute these pure normalization helpers on client writes.
GRANT EXECUTE ON FUNCTION public.commerce_oms_normalize_search_text(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.commerce_oms_normalize_search_digits(text) TO service_role;

-- Existing authenticated profile and membership readers remain constrained by unchanged RLS.
GRANT SELECT (id, auth_user_id, email, first_name, last_name, phone, lifecycle_stage) ON public.clients TO authenticated;
GRANT SELECT (id, role, membership_state, email, is_machine_actor, created_at) ON public.admin_users TO authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_oms_normalize_search_text(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_oms_normalize_search_digits(text) TO authenticated;
