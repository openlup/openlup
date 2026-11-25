-- Verify server quote claims at the native writer's transaction instant.
CREATE FUNCTION public.catalog_derive_subscription_unit_price(
  p_base integer, p_discount_bps integer, p_quantum integer
)
RETURNS integer
LANGUAGE sql IMMUTABLE STRICT SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE WHEN p_base > 0 AND p_discount_bps BETWEEN 0 AND 10000 AND p_quantum > 0
    THEN (p_base::bigint * (10000 - p_discount_bps) / 10000 / p_quantum * p_quantum)::integer
  END
$$;

CREATE FUNCTION public.catalog_admission_derived_subscription_prices(
  p_currency text, p_quote jsonb, p_draft jsonb, p_at timestamptz
)
RETURNS integer[]
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  WITH lines AS (
    SELECT draft.position, draft.line, (p_quote#>'{quote,lines}') -> (draft.position - 1)::integer AS quoted
    FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(p_draft->'lines') = 'array' THEN p_draft->'lines' ELSE '[]'::jsonb END
    ) WITH ORDINALITY AS draft(line, position)
  ), claims AS (
    SELECT *, line->'catalogFacts' AS facts, quoted->'catalogFacts' AS quoted_facts
    FROM lines
  ), paired AS (
    SELECT *,
      CASE WHEN pg_input_is_valid(facts->>'policyRevisionId', 'pg_catalog.uuid')
        THEN (facts->>'policyRevisionId')::uuid END AS policy_id,
      CASE WHEN pg_input_is_valid(facts->>'basePriceEntryId', 'pg_catalog.uuid')
        THEN (facts->>'basePriceEntryId')::uuid END AS base_id,
      CASE WHEN jsonb_typeof(line->'quantity') = 'number' AND pg_input_is_valid(line->>'quantity', 'pg_catalog.int4')
        THEN (line->>'quantity')::integer END AS quantity
    FROM claims
    WHERE facts->>'version' = 'catalog_facts_v2' AND quoted_facts->>'version' = 'catalog_facts_v2'
      AND quoted->'sku' = line->'sku' AND quoted->'quantity' = line->'quantity'
      AND p_quote#>>'{quote,currency}' = p_currency AND p_draft->>'currency' = p_currency
  ), policies AS MATERIALIZED (
    SELECT policy.*
    FROM (SELECT DISTINCT policy_id FROM paired) claimed
    JOIN public.subscription_price_policy_revisions policy ON policy.id = claimed.policy_id
    JOIN public.price_lists list ON list.id = policy.price_list_id
    WHERE isfinite(p_at)
      AND policy.channel = 'D2C' AND policy.currency = p_currency
      AND policy.effective_from <= p_at AND (policy.effective_to IS NULL OR policy.effective_to > p_at)
      AND list.region_code = policy.region_code AND list.currency = p_currency AND list.status = 'active'
      AND list.valid_from <= p_at AND (list.valid_to IS NULL OR list.valid_to > p_at)
      AND NOT EXISTS (
        SELECT 1 FROM public.price_lists other
        WHERE other.region_code = list.region_code AND other.currency = list.currency AND other.status = 'active'
          AND other.valid_from <= p_at AND (other.valid_to IS NULL OR other.valid_to > p_at)
          AND other.id <> list.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.subscription_price_policy_revisions other
        WHERE other.price_list_id = list.id AND other.region_code = policy.region_code
          AND other.currency = p_currency AND other.channel = 'D2C'
          AND other.effective_from <= p_at AND (other.effective_to IS NULL OR other.effective_to > p_at)
          AND other.id <> policy.id
      )
      AND policy.rounding_rule = 'FLOOR_TO_QUANTUM'
      AND policy.digest = public.catalog_price_setup_policy_digest(
        policy.id, policy.revision_no, policy.price_list_id, policy.region_code, policy.currency, policy.channel,
        policy.effective_from, CASE WHEN policy.closed_from_open THEN NULL ELSE policy.effective_to END,
        policy.discount_bps, policy.rounding_quantum_minor, policy.rounding_rule
      )
  ), verified AS (
    SELECT pair.position, price.unit
    FROM paired pair
    JOIN policies policy ON policy.id = pair.policy_id
    JOIN public.price_entries base ON base.id = pair.base_id AND base.price_list_id = policy.price_list_id
    JOIN public.catalog_skus sku ON sku.id = base.variant_id AND sku.sku = pair.line->>'sku'
    JOIN public.catalog_products product ON product.id = sku.product_id AND product.status = 'active'
    CROSS JOIN LATERAL (
      SELECT public.catalog_derive_subscription_unit_price(
        base.unit_price_minor, policy.discount_bps, policy.rounding_quantum_minor
      ) AS unit
    ) price
    CROSS JOIN LATERAL (
      SELECT jsonb_build_object(
        'baseUnitAmountMinor', base.unit_price_minor, 'policyDigest', policy.digest,
        'resolvedUnitAmountMinor', price.unit, 'resolvedLineAmountMinor', pair.quantity::bigint * price.unit,
        'currency', p_currency, 'mode', 'subscription'
      ) AS facts,
      jsonb_build_object('amountMinor', price.unit, 'currency', p_currency) AS unit_gross,
      jsonb_build_object('amountMinor', pair.quantity::bigint * price.unit, 'currency', p_currency) AS line_gross
    ) expected
    WHERE sku.status = 'active' AND sku.sellable_in_subscription AND pair.quantity >= greatest(1, sku.min_order_qty)
      AND base.active AND base.mode = 'one_time' AND base.min_qty = 1
      AND base.valid_from <= p_at AND (base.valid_to IS NULL OR base.valid_to > p_at)
      -- Count every effective base candidate before considering its amount kind.
      AND NOT EXISTS (
        SELECT 1 FROM public.price_entries other
        WHERE other.price_list_id = base.price_list_id AND other.variant_id = sku.id
          AND other.active AND other.mode = 'one_time' AND other.min_qty = 1
          AND other.valid_from <= p_at AND (other.valid_to IS NULL OR other.valid_to > p_at)
          AND other.id <> base.id
      )
      AND base.amount_kind = 'gross' AND price.unit > 0 AND pair.quantity::bigint * price.unit <= 2147483647
      AND lower(pair.facts->>'skuId') = sku.id::text AND lower(pair.quoted_facts->>'skuId') = sku.id::text
      AND lower(pair.quoted_facts->>'basePriceEntryId') = base.id::text
      AND lower(pair.quoted_facts->>'policyRevisionId') = policy.id::text
      AND pair.facts @> expected.facts AND pair.quoted_facts @> expected.facts
      AND pair.line->'unitPriceGross' = expected.unit_gross AND pair.quoted->'unitPriceGross' = expected.unit_gross
      AND pair.line->'lineSubtotalGross' = expected.line_gross AND pair.quoted->'lineSubtotalGross' = expected.line_gross
  )
  SELECT array_agg(verified.unit ORDER BY claims.position)
  FROM claims LEFT JOIN verified USING (position)
  HAVING bool_or(claims.facts->>'version' = 'catalog_facts_v2' OR claims.quoted_facts->>'version' = 'catalog_facts_v2')
$$;

REVOKE ALL ON FUNCTION public.catalog_derive_subscription_unit_price(integer,integer,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.catalog_admission_derived_subscription_prices(text,jsonb,jsonb,timestamptz) FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
  EXECUTE 'REVOKE ALL ON FUNCTION public.catalog_derive_subscription_unit_price(integer,integer,integer), public.catalog_admission_derived_subscription_prices(text,jsonb,jsonb,timestamptz) FROM anon;';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
  EXECUTE 'REVOKE ALL ON FUNCTION public.catalog_derive_subscription_unit_price(integer,integer,integer), public.catalog_admission_derived_subscription_prices(text,jsonb,jsonb,timestamptz) FROM authenticated;';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
  EXECUTE 'REVOKE ALL ON FUNCTION public.catalog_derive_subscription_unit_price(integer,integer,integer) FROM service_role;';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.catalog_admission_derived_subscription_prices(text,jsonb,jsonb,timestamptz) TO service_role;';
END IF; END; $$;

CREATE OR REPLACE FUNCTION public.commerce_create_order_draft_with_outbox(
  p_idempotency_key text,
  p_quote_snapshot jsonb,
  p_order_draft_snapshot jsonb,
  p_client_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_fingerprint text;
  v_order_id uuid;
  v_response jsonb;
  v_line jsonb;
  v_line_ordinal integer := 0;
  v_sku_id uuid;
  v_expected_price integer;
  v_quantity integer;
  v_unit_price integer;
  v_line_amount integer;
  v_mode text;
  v_currency text;
  v_total bigint;
  v_pricing_at timestamptz;
  v_derived_prices integer[];
BEGIN
  IF p_idempotency_key IS NULL
     OR char_length(btrim(p_idempotency_key)) NOT BETWEEN 8 AND 120 THEN
    RAISE EXCEPTION 'commerce_order_draft_invalid_idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF p_quote_snapshot IS NULL OR jsonb_typeof(p_quote_snapshot) <> 'object'
     OR p_order_draft_snapshot IS NULL OR jsonb_typeof(p_order_draft_snapshot) <> 'object'
     OR p_order_draft_snapshot->>'contractVersion' <> 'commerce.v0'
     OR p_order_draft_snapshot->>'source' <> 'commerce.order_draft.bff.v0'
     OR p_order_draft_snapshot->>'status' <> 'draft'
     OR p_order_draft_snapshot->>'paymentStatus' <> 'not_started'
     OR jsonb_typeof(p_order_draft_snapshot->'lines') <> 'array'
     OR jsonb_array_length(p_order_draft_snapshot->'lines') = 0 THEN
    RAISE EXCEPTION 'commerce_order_draft_invalid_snapshot' USING ERRCODE = '22023';
  END IF;
  IF p_client_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.clients WHERE id = p_client_id) THEN
    RAISE EXCEPTION 'commerce_order_draft_unknown_client' USING ERRCODE = '22023';
  END IF;

  v_mode := COALESCE(p_order_draft_snapshot#>>'{context,mode}', 'one_time');
  IF v_mode NOT IN ('one_time', 'subscription') THEN
    RAISE EXCEPTION 'commerce_order_draft_invalid_mode' USING ERRCODE = '22023';
  END IF;
  v_currency := p_order_draft_snapshot->>'currency';
  v_fingerprint := md5(
    p_quote_snapshot::text || '|' || p_order_draft_snapshot::text || '|'
    || COALESCE(p_client_id::text, '')
  );

  v_response := public.catalog_admission_replay_order_draft(p_idempotency_key, p_client_id, 'native-draft', v_fingerprint);
  IF v_response IS NOT NULL THEN RETURN v_response; END IF;
  PERFORM public.catalog_admission_check_legacy_draft(p_idempotency_key,p_order_draft_snapshot,p_client_id,true);

  v_pricing_at := now();
  v_total := (p_order_draft_snapshot#>>'{totals,totalGross,amountMinor}')::bigint;
  FOR v_line IN
    SELECT value FROM jsonb_array_elements(p_order_draft_snapshot->'lines')
  LOOP
    v_line_ordinal := v_line_ordinal + 1;
    v_quantity := (v_line->>'quantity')::integer;
    v_unit_price := (v_line#>>'{unitPriceGross,amountMinor}')::integer;
    v_line_amount := (v_line#>>'{lineSubtotalGross,amountMinor}')::integer;
    IF v_quantity <= 0 OR v_unit_price < 0 OR v_line_amount <> v_quantity * v_unit_price THEN
      RAISE EXCEPTION 'commerce_order_draft_invalid_line' USING ERRCODE = '22023';
    END IF;

    IF v_mode = 'subscription' THEN
      IF v_line_ordinal = 1 THEN
        v_derived_prices := public.catalog_admission_derived_subscription_prices(
          v_currency, p_quote_snapshot, p_order_draft_snapshot, v_pricing_at
        );
      END IF;
      IF v_derived_prices IS NOT NULL AND (
        v_line#>>'{catalogFacts,version}' = 'catalog_facts_v2'
        OR ((p_quote_snapshot#>'{quote,lines}') -> (v_line_ordinal - 1))#>>'{catalogFacts,version}' = 'catalog_facts_v2'
      ) THEN
        IF v_derived_prices[v_line_ordinal] IS NULL OR v_derived_prices[v_line_ordinal] IS DISTINCT FROM v_unit_price THEN
          RAISE EXCEPTION 'commerce_order_draft_catalog_price_changed' USING ERRCODE = '22023';
        END IF;
        CONTINUE;
      END IF;
    END IF;

    SELECT sku.id, price.unit_price_minor
      INTO v_sku_id, v_expected_price
      FROM public.catalog_skus AS sku
      JOIN public.catalog_products AS product
        ON product.id = sku.product_id AND product.status = 'active'
      JOIN public.price_entries AS price
        ON price.variant_id = sku.id
       AND price.active
       AND price.amount_kind = 'gross'
       AND price.mode IN (v_mode, 'any')
       AND price.min_qty <= v_quantity
       AND price.valid_from <= now()
       AND (price.valid_to IS NULL OR price.valid_to > now())
      JOIN public.price_lists AS price_list
        ON price_list.id = price.price_list_id
       AND price_list.status = 'active'
       AND price_list.currency = v_currency
       AND price_list.valid_from <= now()
       AND (price_list.valid_to IS NULL OR price_list.valid_to > now())
     WHERE sku.sku = v_line->>'sku'
       AND sku.status = 'active'
       AND v_quantity >= sku.min_order_qty
       AND (v_mode <> 'subscription' OR sku.sellable_in_subscription)
       AND (v_mode <> 'one_time' OR sku.sellable_standalone)
     ORDER BY (price.mode = v_mode) DESC, price.min_qty DESC, price.id
     LIMIT 1;
    IF NOT FOUND OR v_expected_price <> v_unit_price THEN
      RAISE EXCEPTION 'commerce_order_draft_catalog_price_changed' USING ERRCODE = '22023';
    END IF;
  END LOOP;

  INSERT INTO public.commerce_orders (
    client_id, status, currency_code, total_amount_minor, metadata
  ) VALUES (
    p_client_id, 'pending_payment', v_currency, v_total,
    jsonb_build_object(
      'paymentStatus', 'not_started',
      'quoteSnapshot', p_quote_snapshot,
      'orderDraftSnapshot', p_order_draft_snapshot
    )
  ) RETURNING id INTO v_order_id;

  v_line_ordinal := 0;
  FOR v_line IN
    SELECT value FROM jsonb_array_elements(p_order_draft_snapshot->'lines')
  LOOP
    v_line_ordinal := v_line_ordinal + 1;
    SELECT id INTO v_sku_id FROM public.catalog_skus WHERE sku = v_line->>'sku';
    v_quantity := (v_line->>'quantity')::integer;
    v_unit_price := (v_line#>>'{unitPriceGross,amountMinor}')::integer;
    v_line_amount := (v_line#>>'{lineSubtotalGross,amountMinor}')::integer;
    INSERT INTO public.commerce_order_items (
      order_id, sku_id, line_ordinal, quantity, unit_amount_minor, line_amount_minor
    ) VALUES (
      v_order_id, v_sku_id, v_line_ordinal, v_quantity, v_unit_price, v_line_amount
    );
  END LOOP;

  v_response := jsonb_build_object(
    'contractVersion', 'commerce.v0',
    'orderDraft', jsonb_build_object(
      'orderId', 'order_' || v_order_id::text,
      'status', 'draft',
      'paymentStatus', 'not_started',
      'idempotencyKey', p_idempotency_key,
      'quoteSnapshot', p_quote_snapshot,
      'replayed', false
    )
  );

  INSERT INTO public.outbox_events (
    aggregate_type, aggregate_id, event_type, idempotency_key, payload, metadata
  ) VALUES (
    'commerce_order', v_order_id, 'commerce.order_draft.created', p_idempotency_key,
    jsonb_build_object(
      'orderId', 'order_' || v_order_id::text,
      'orderUuid', v_order_id,
      'quoteSnapshot', p_quote_snapshot,
      'orderDraftSnapshot', p_order_draft_snapshot
    ),
    jsonb_build_object('boundary', 'commerce_create_order_draft_with_outbox')
  );

  INSERT INTO public.commerce_order_draft_receipts (
    idempotency_key, request_fingerprint, order_id, response_payload
  ) VALUES (
    p_idempotency_key, v_fingerprint, v_order_id, v_response
  );
  RETURN v_response;
END;
$$;
