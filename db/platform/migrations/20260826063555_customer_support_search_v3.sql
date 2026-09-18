-- Portable operator search v3.
--
-- CHANGE. This replaces the full customer_support_search body with accent-
-- insensitive full/reverse-name matching, phone normalization, order and
-- subscription references, bounded trigram typo tolerance, deterministic
-- ranking and true database-side count/pagination. The response remains the
-- existing provider-neutral clients.customer_360.v2 contract.
--
-- SAFETY. The routine remains invoker-rights, operator-gated and read-only with
-- a fixed search path. Exact/prefix/substring ranks are deterministic and always
-- precede fuzzy matches. No managed tester/waitlist shape enters this migration.

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;

CREATE FUNCTION public.customer_support_search_normalize(p_value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT btrim(regexp_replace(
    translate(lower(COALESCE(p_value, '')), 'ąćęłńóśźż', 'acelnoszz'),
    '[^a-z0-9@.+-]+', ' ', 'g'
  ));
$$;

CREATE FUNCTION public.customer_support_search_digits(p_value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT regexp_replace(COALESCE(p_value, ''), '[^0-9]+', '', 'g');
$$;

-- Transactional platform replay cannot use CONCURRENTLY; these are bounded
-- adopter-owned tables and the operator schedules the forward as maintenance.
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX customer_support_clients_document_trgm_idx
  ON public.clients USING gin (
    public.customer_support_search_normalize(
      COALESCE(email, '') || ' ' || COALESCE(first_name, '') || ' ' ||
      COALESCE(last_name, '') || ' ' || COALESCE(phone, '')
    ) public.gin_trgm_ops
  );

-- squawk-ignore require-concurrent-index-creation
CREATE INDEX customer_support_clients_name_trgm_idx
  ON public.clients USING gin (
    public.customer_support_search_normalize(
      COALESCE(first_name, '') || ' ' || COALESCE(last_name, '')
    ) public.gin_trgm_ops
  );

-- squawk-ignore require-concurrent-index-creation
CREATE INDEX customer_support_clients_reverse_name_trgm_idx
  ON public.clients USING gin (
    public.customer_support_search_normalize(
      COALESCE(last_name, '') || ' ' || COALESCE(first_name, '')
    ) public.gin_trgm_ops
  );

-- squawk-ignore require-concurrent-index-creation
CREATE INDEX customer_support_clients_phone_trgm_idx
  ON public.clients USING gin (
    public.customer_support_search_digits(phone) public.gin_trgm_ops
  );

-- The activity projection performs one latest/aggregate lookup per qualified
-- customer. These ownership indexes keep that enrichment proportional to the
-- candidate set instead of the complete order and dunning ledgers.
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX customer_support_orders_client_activity_idx
  ON public.commerce_orders (client_id, updated_at DESC)
  WHERE client_id IS NOT NULL;

-- squawk-ignore require-concurrent-index-creation
CREATE INDEX customer_support_dunning_client_activity_idx
  ON public.subscription_dunning_cases (client_id, updated_at DESC);

CREATE OR REPLACE FUNCTION public.customer_support_search(
  p_operator_id uuid,
  p_query text,
  p_page integer,
  p_page_size integer,
  p_lifecycle_stage text
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
SET pg_trgm.similarity_threshold = '0.28'
AS $$
DECLARE
  v_query text := btrim(COALESCE(p_query, ''));
  v_query_normalized text;
  v_query_digits text;
  v_query_is_email boolean := position('@' IN v_query) > 0;
  v_query_uuid uuid;
  v_page integer := COALESCE(p_page, 0);
  v_limit integer := LEAST(GREATEST(COALESCE(p_page_size, 10), 1), 50);
  v_result jsonb;
BEGIN
  PERFORM public.communications_require_active_operator(p_operator_id);
  IF v_query = '' OR char_length(v_query) > 200 THEN
    RAISE EXCEPTION 'customer_support_query_invalid' USING ERRCODE = '22023';
  END IF;
  IF v_page < 0 OR COALESCE(p_lifecycle_stage, 'all') NOT IN (
    'all', 'lead', 'waitlist', 'tester', 'customer', 'inactive'
  ) THEN
    RAISE EXCEPTION 'customer_support_search_page_invalid' USING ERRCODE = '22023';
  END IF;

  v_query_normalized := public.customer_support_search_normalize(v_query);
  v_query_digits := CASE WHEN v_query_is_email THEN ''
    ELSE public.customer_support_search_digits(v_query) END;
  IF v_query_normalized !~ '[a-z0-9]' THEN
    RAISE EXCEPTION 'customer_support_query_invalid' USING ERRCODE = '22023';
  END IF;
  BEGIN
    v_query_uuid := v_query::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    v_query_uuid := NULL;
  END;

  -- Candidate IDs are materialized before relationship/activity enrichment so
  -- trigram indexes qualify a bounded set instead of running lateral aggregates
  -- for every customer row.
  WITH candidate_ids AS MATERIALIZED (
    SELECT client_row.id AS client_id
    FROM public.clients AS client_row
    WHERE client_row.lifecycle_stage IN ('customer', 'inactive')
      AND (
        client_row.id = v_query_uuid
        OR public.customer_support_search_normalize(
          COALESCE(client_row.email, '') || ' ' || COALESCE(client_row.first_name, '') || ' ' ||
          COALESCE(client_row.last_name, '') || ' ' || COALESCE(client_row.phone, '')
        ) LIKE '%' || v_query_normalized || '%'
          AND (NOT v_query_is_email OR public.customer_support_search_normalize(client_row.email)
            LIKE '%' || v_query_normalized || '%')
        OR (NOT v_query_is_email AND public.customer_support_search_normalize(
          COALESCE(client_row.email, '') || ' ' || COALESCE(client_row.first_name, '') || ' ' ||
          COALESCE(client_row.last_name, '') || ' ' || COALESCE(client_row.phone, '')
        ) OPERATOR(public.%) v_query_normalized)
        OR (NOT v_query_is_email AND public.customer_support_search_normalize(
          COALESCE(client_row.first_name, '') || ' ' || COALESCE(client_row.last_name, '')
        ) OPERATOR(public.%) v_query_normalized)
        OR (NOT v_query_is_email AND public.customer_support_search_normalize(
          COALESCE(client_row.last_name, '') || ' ' || COALESCE(client_row.first_name, '')
        ) OPERATOR(public.%) v_query_normalized)
        OR (v_query_digits <> '' AND public.customer_support_search_digits(client_row.phone)
          LIKE '%' || v_query_digits || '%')
      )
    UNION
    SELECT subscription_row.client_id
    FROM public.subscriptions AS subscription_row
    WHERE subscription_row.id = v_query_uuid
    UNION
    SELECT COALESCE(order_row.client_id, legacy_subscription.client_id)
    FROM public.commerce_orders AS order_row
    LEFT JOIN public.subscription_cycles AS legacy_cycle
      ON legacy_cycle.id = order_row.subscription_cycle_id
    LEFT JOIN public.subscriptions AS legacy_subscription
      ON legacy_subscription.id = legacy_cycle.subscription_id
    WHERE order_row.id = v_query_uuid
      AND COALESCE(order_row.client_id, legacy_subscription.client_id) IS NOT NULL
  ), source_rows AS (
    SELECT client_row.*,
      public.customer_support_search_normalize(client_row.email) AS normalized_email,
      public.customer_support_search_digits(client_row.phone) AS normalized_phone,
      public.customer_support_search_normalize(
        COALESCE(client_row.first_name, '') || ' ' || COALESCE(client_row.last_name, '')
      ) AS normalized_name,
      public.customer_support_search_normalize(
        COALESCE(client_row.last_name, '') || ' ' || COALESCE(client_row.first_name, '')
      ) AS normalized_reverse_name,
      public.customer_support_search_normalize(
        COALESCE(client_row.email, '') || ' ' || COALESCE(client_row.first_name, '') || ' ' ||
        COALESCE(client_row.last_name, '') || ' ' || COALESCE(client_row.phone, '')
      ) AS search_document,
      COALESCE(subscription_match.exact_match, false) AS subscription_exact,
      COALESCE(order_match.exact_match, false) AS order_exact,
      GREATEST(client_row.updated_at, subscription_match.last_activity_at,
        order_match.last_activity_at, dunning_match.last_activity_at) AS last_activity_at
    FROM candidate_ids AS candidate_id
    JOIN public.clients AS client_row ON client_row.id = candidate_id.client_id
      AND client_row.lifecycle_stage IN ('customer', 'inactive')
    LEFT JOIN LATERAL (
      SELECT bool_or(subscription_row.id::text = v_query) AS exact_match,
        max(subscription_row.updated_at) AS last_activity_at
      FROM public.subscriptions AS subscription_row
      WHERE subscription_row.client_id = client_row.id
    ) AS subscription_match ON true
    LEFT JOIN LATERAL (
      SELECT bool_or(order_row.id::text = v_query) AS exact_match,
        max(order_row.updated_at) AS last_activity_at
      FROM public.commerce_orders AS order_row
      LEFT JOIN public.subscription_cycles AS cycle_row
        ON cycle_row.id = order_row.subscription_cycle_id
      LEFT JOIN public.subscriptions AS subscription_row
        ON subscription_row.id = cycle_row.subscription_id
      WHERE order_row.client_id = client_row.id
        OR (order_row.client_id IS NULL AND subscription_row.client_id = client_row.id)
    ) AS order_match ON true
    LEFT JOIN LATERAL (
      SELECT max(case_row.updated_at) AS last_activity_at
      FROM public.subscription_dunning_cases AS case_row
      WHERE case_row.client_id = client_row.id
    ) AS dunning_match ON true
  ), scored AS (
    SELECT source_row.*,
      similarity(source_row.search_document, v_query_normalized) AS text_similarity,
      GREATEST(
        similarity(source_row.normalized_name, v_query_normalized),
        similarity(source_row.normalized_reverse_name, v_query_normalized)
      ) AS name_similarity,
      CASE
        WHEN source_row.id::text = v_query OR source_row.normalized_email = v_query_normalized
          OR (v_query_digits <> '' AND source_row.normalized_phone = v_query_digits)
          OR source_row.order_exact OR source_row.subscription_exact THEN 0
        WHEN NOT v_query_is_email AND (source_row.normalized_name = v_query_normalized
          OR source_row.normalized_reverse_name = v_query_normalized) THEN 1
        WHEN source_row.normalized_email LIKE v_query_normalized || '%'
          OR (NOT v_query_is_email AND source_row.normalized_name LIKE v_query_normalized || '%')
          OR (NOT v_query_is_email AND source_row.normalized_reverse_name LIKE v_query_normalized || '%')
          OR (v_query_digits <> '' AND source_row.normalized_phone LIKE v_query_digits || '%') THEN 2
        WHEN NOT v_query_is_email AND (
          source_row.search_document LIKE '%' || v_query_normalized || '%'
          OR (v_query_digits <> '' AND source_row.normalized_phone LIKE '%' || v_query_digits || '%')
        ) THEN 3
        WHEN NOT v_query_is_email AND (
          similarity(source_row.search_document, v_query_normalized) >= 0.32
          OR similarity(source_row.normalized_name, v_query_normalized) >= 0.28
          OR similarity(source_row.normalized_reverse_name, v_query_normalized) >= 0.28) THEN 4
        ELSE NULL
      END AS match_rank,
      CASE
        WHEN source_row.id::text = v_query THEN 'subject_id'
        WHEN source_row.normalized_email LIKE '%' || v_query_normalized || '%' THEN 'email'
        WHEN v_query_digits <> '' AND source_row.normalized_phone LIKE '%' || v_query_digits || '%' THEN 'phone'
        WHEN source_row.order_exact THEN 'order'
        WHEN source_row.subscription_exact THEN 'subscription'
        WHEN NOT v_query_is_email AND (source_row.normalized_name LIKE '%' || v_query_normalized || '%'
          OR source_row.normalized_reverse_name LIKE '%' || v_query_normalized || '%'
          OR similarity(source_row.normalized_name, v_query_normalized) >= 0.28
          OR similarity(source_row.normalized_reverse_name, v_query_normalized) >= 0.28) THEN 'name'
        ELSE 'text'
      END AS matched_by
    FROM source_rows AS source_row
  ), eligible AS (
    SELECT * FROM scored
    WHERE match_rank IS NOT NULL
      AND (COALESCE(p_lifecycle_stage, 'all') = 'all' OR lifecycle_stage = p_lifecycle_stage)
  ), bounded AS (
    SELECT * FROM eligible
    ORDER BY match_rank, GREATEST(text_similarity, name_similarity) DESC,
      last_activity_at DESC NULLS LAST, id
    LIMIT v_limit OFFSET v_page::bigint * v_limit::bigint
  )
  SELECT jsonb_build_object(
    'contractVersion', 'clients.customer_360.v2',
    'candidates', COALESCE(jsonb_agg(jsonb_build_object(
      'subject', jsonb_build_object(
        'subjectId', bounded.id,
        'displayName', NULLIF(btrim(concat_ws(' ', bounded.first_name, bounded.last_name)), ''),
        'email', CASE WHEN bounded.email ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
          THEN lower(bounded.email) ELSE NULL END,
        'phone', NULLIF(btrim(bounded.phone), ''),
        'lifecycleStage', bounded.lifecycle_stage,
        'createdAt', bounded.created_at,
        'lastActivityAt', bounded.last_activity_at
      ),
      'matchedBy', bounded.matched_by,
      'confidence', CASE WHEN bounded.match_rank <= 1 THEN 'exact'
        WHEN bounded.match_rank <= 3 THEN 'high' ELSE 'medium' END,
      'journeyLookup', jsonb_build_object('subjectId', bounded.id)
    ) ORDER BY bounded.match_rank,
      GREATEST(bounded.text_similarity, bounded.name_similarity) DESC,
      bounded.last_activity_at DESC NULLS LAST, bounded.id), '[]'::jsonb),
    'totalCount', (SELECT count(*)::integer FROM eligible),
    'page', v_page,
    'pageSize', v_limit
  ) INTO v_result
  FROM bounded;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.customer_support_search(uuid, text, integer, integer, text)
  FROM PUBLIC;
