CREATE FUNCTION public.catalog_admission_derived_subscription_prices(
  p_list_id uuid, p_currency text, p_variant_id uuid, p_quantity integer, p_at timestamptz
)
RETURNS TABLE (
  base_price_entry_id uuid, base_unit_minor integer, policy_revision_id uuid,
  policy_digest text, unit_price_minor integer
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  WITH policies AS (
    SELECT policy.*
    FROM public.subscription_price_policy_revisions policy
    JOIN public.price_lists list ON list.id = policy.price_list_id
    WHERE list.id = p_list_id AND isfinite(p_at)
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
  )
  SELECT base.id, base.unit_price_minor, policy.id, policy.digest, price.unit_price_minor
  FROM policies policy
  JOIN public.price_entries base ON base.price_list_id = policy.price_list_id AND base.variant_id = p_variant_id
  JOIN public.catalog_skus sku ON sku.id = base.variant_id
  JOIN public.catalog_products product ON product.id = sku.product_id AND product.status = 'active'
  CROSS JOIN LATERAL (
    SELECT public.catalog_derive_subscription_unit_price(
      base.unit_price_minor, policy.discount_bps, policy.rounding_quantum_minor
    ) AS unit_price_minor
  ) price
  WHERE sku.status = 'active' AND sku.sellable_in_subscription AND p_quantity >= greatest(1, sku.min_order_qty)
    AND (base.active OR (base.valid_to IS NOT NULL
      AND base.valid_to <= pg_catalog.date_trunc('milliseconds', pg_catalog.now())
      AND EXISTS (SELECT 1 FROM public.price_entries successor
        WHERE successor.price_list_id = base.price_list_id AND successor.variant_id = base.variant_id
          AND successor.mode = 'one_time' AND successor.min_qty = 1
          AND successor.valid_from = base.valid_to))) AND base.mode = 'one_time' AND base.min_qty = 1
    AND base.valid_from <= p_at AND (base.valid_to IS NULL OR base.valid_to > p_at)
    -- Count every effective base candidate before considering its amount kind.
    AND NOT EXISTS (
      SELECT 1 FROM public.price_entries other
      WHERE other.price_list_id = base.price_list_id AND other.variant_id = sku.id
        AND (other.active OR (other.valid_to IS NOT NULL
          AND other.valid_to <= pg_catalog.date_trunc('milliseconds', pg_catalog.now())
          AND EXISTS (SELECT 1 FROM public.price_entries successor
            WHERE successor.price_list_id = other.price_list_id AND successor.variant_id = other.variant_id
              AND successor.mode = 'one_time' AND successor.min_qty = 1
              AND successor.valid_from = other.valid_to))) AND other.mode = 'one_time' AND other.min_qty = 1
        AND other.valid_from <= p_at AND (other.valid_to IS NULL OR other.valid_to > p_at)
        AND other.id <> base.id
    )
    AND base.amount_kind = 'gross' AND price.unit_price_minor > 0 AND p_quantity::bigint * price.unit_price_minor <= 2147483647
$$;

REVOKE ALL ON FUNCTION public.catalog_admission_derived_subscription_prices(uuid,text,uuid,integer,timestamptz) FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
  EXECUTE 'REVOKE ALL ON FUNCTION public.catalog_admission_derived_subscription_prices(uuid,text,uuid,integer,timestamptz) FROM anon;';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
  EXECUTE 'REVOKE ALL ON FUNCTION public.catalog_admission_derived_subscription_prices(uuid,text,uuid,integer,timestamptz) FROM authenticated;';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.catalog_admission_derived_subscription_prices(uuid,text,uuid,integer,timestamptz) TO service_role;';
END IF; END; $$;

CREATE OR REPLACE FUNCTION public.catalog_admission_derived_subscription_prices(
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
  ), verified AS (
    SELECT pair.position, price.unit_price_minor
    FROM paired pair
    JOIN public.price_entries base ON base.id = pair.base_id
    JOIN public.catalog_skus sku ON sku.id = base.variant_id AND sku.sku = pair.line->>'sku'
    CROSS JOIN LATERAL public.catalog_admission_derived_subscription_prices(
      base.price_list_id, p_currency, base.variant_id, pair.quantity, p_at
    ) price
    CROSS JOIN LATERAL (
      SELECT jsonb_build_object(
        'baseUnitAmountMinor', price.base_unit_minor, 'policyDigest', price.policy_digest,
        'resolvedUnitAmountMinor', price.unit_price_minor, 'resolvedLineAmountMinor', pair.quantity::bigint * price.unit_price_minor,
        'currency', p_currency, 'mode', 'subscription'
      ) AS facts,
      jsonb_build_object('amountMinor', price.unit_price_minor, 'currency', p_currency) AS unit_gross,
      jsonb_build_object('amountMinor', pair.quantity::bigint * price.unit_price_minor, 'currency', p_currency) AS line_gross
    ) expected
    WHERE price.base_price_entry_id = pair.base_id AND price.policy_revision_id = pair.policy_id
      AND lower(pair.facts->>'skuId') = sku.id::text AND lower(pair.quoted_facts->>'skuId') = sku.id::text
      AND lower(pair.quoted_facts->>'basePriceEntryId') = base.id::text
      AND lower(pair.quoted_facts->>'policyRevisionId') = price.policy_revision_id::text
      AND pair.facts @> expected.facts AND pair.quoted_facts @> expected.facts
      AND pair.line->'unitPriceGross' = expected.unit_gross AND pair.quoted->'unitPriceGross' = expected.unit_gross
      AND pair.line->'lineSubtotalGross' = expected.line_gross AND pair.quoted->'lineSubtotalGross' = expected.line_gross
  )
  SELECT array_agg(verified.unit_price_minor ORDER BY claims.position)
  FROM claims LEFT JOIN verified USING (position)
  HAVING bool_or(claims.facts->>'version' = 'catalog_facts_v2' OR claims.quoted_facts->>'version' = 'catalog_facts_v2')
$$;

CREATE OR REPLACE FUNCTION public.customer_subscription_preview_bundle_as_actor(
  p_subscription_id uuid,
  p_idempotency_key text,
  p_core_lines jsonb,
  p_addon_lines jsonb DEFAULT '[]'::jsonb,
  p_composition_constraint jsonb DEFAULT '{}'::jsonb,
  p_cadence_days integer DEFAULT NULL,
  p_expected_template_version integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_principal_id uuid;
  v_client_id uuid;
  v_command_key text;
  v_key_identity jsonb;
  v_subscription public.subscriptions%ROWTYPE;
  v_quote public.subscription_edit_quotes%ROWTYPE;
  v_existing public.subscription_events%ROWTYPE;
  v_lines jsonb;
  v_fingerprint text;
  v_quote_hash text;
  v_current_total bigint;
  v_new_total bigint;
  v_cadence_days integer;
  v_expected_version integer;
  v_expires_at timestamptz;
  v_blocked_reason text;
  v_can_apply boolean := true;
  v_missing_sku boolean := false;
BEGIN
  IF p_idempotency_key IS NULL OR p_idempotency_key <> btrim(p_idempotency_key)
    OR char_length(p_idempotency_key) NOT BETWEEN 8 AND 180
  THEN
    RAISE EXCEPTION 'subscription_edit_invalid_idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF starts_with(p_idempotency_key, 'command:') THEN
    RAISE EXCEPTION 'subscription_command_reserved_idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p_core_lines) <> 'array'
    OR jsonb_array_length(p_core_lines) NOT BETWEEN 1 AND 6
    OR jsonb_typeof(COALESCE(p_addon_lines, '[]'::jsonb)) <> 'array'
    OR jsonb_array_length(COALESCE(p_addon_lines, '[]'::jsonb)) > 12
  THEN
    RAISE EXCEPTION 'subscription_edit_invalid_lines' USING ERRCODE = '22023';
  END IF;

  v_principal_id := auth.uid();
  IF v_principal_id IS NULL THEN
    RAISE EXCEPTION 'subscription_edit_not_found' USING ERRCODE = '22023';
  END IF;
  SELECT client.id INTO v_client_id FROM public.clients AS client
   WHERE client.principal_id = v_principal_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'subscription_edit_not_found' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_subscription FROM public.subscriptions
   WHERE id = p_subscription_id AND client_id = v_client_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'subscription_edit_forbidden' USING ERRCODE = '22023';
  END IF;

  v_command_key := 'command:' || encode(sha256(convert_to(
    v_principal_id::text || ':' || p_idempotency_key, 'UTF8')), 'hex');
  v_key_identity := jsonb_build_object('derivation', 'principal-sha256.v1', 'actorId', v_principal_id);

  SELECT * INTO v_existing FROM public.subscription_events
   WHERE subscription_id = v_subscription.id AND idempotency_key = v_command_key;
  IF FOUND THEN
    IF COALESCE(v_existing.payload->'commandKeyIdentity', v_existing.payload#>'{payload,commandKeyIdentity}') IS DISTINCT FROM v_key_identity THEN
      RAISE EXCEPTION 'subscription_command_ambiguous_idempotency_key' USING ERRCODE = '23505';
    END IF;
    IF v_existing.event_type <> 'subscription.customer_self_service.update_bundle'
      OR v_existing.payload->>'action' IS DISTINCT FROM 'update_bundle'
    THEN
      RAISE EXCEPTION 'subscription_edit_idempotency_conflict' USING ERRCODE = '23505';
    END IF;
  ELSE
    SELECT * INTO v_existing FROM public.subscription_events
     WHERE subscription_id = v_subscription.id AND idempotency_key = p_idempotency_key;
    IF FOUND THEN
      IF COALESCE(v_existing.payload->'commandKeyIdentity', v_existing.payload#>'{payload,commandKeyIdentity}') IS NOT NULL THEN
        RAISE EXCEPTION 'subscription_command_ambiguous_idempotency_key' USING ERRCODE = '23505';
      END IF;
      IF starts_with(v_existing.event_type, 'subscription.customer_self_service.') THEN
        IF v_existing.event_type <> 'subscription.customer_self_service.update_bundle'
          OR v_existing.payload->>'action' IS DISTINCT FROM 'update_bundle'
        THEN
          RAISE EXCEPTION 'subscription_edit_idempotency_conflict' USING ERRCODE = '23505';
        END IF;
      ELSE
        -- A system row at the raw key belongs to its producer, never this command.
        v_existing := NULL;
      END IF;
    END IF;
  END IF;

  v_cadence_days := COALESCE(p_cadence_days, v_subscription.cadence_days);
  v_expected_version := COALESCE(p_expected_template_version, v_subscription.template_version);
  IF v_cadence_days NOT BETWEEN 1 AND 3660 OR v_expected_version < 1 THEN
    RAISE EXCEPTION 'subscription_edit_invalid_request' USING ERRCODE = '22023';
  END IF;
  IF v_subscription.status <> 'active' THEN
    v_blocked_reason := 'not_active';
  ELSIF v_subscription.next_cycle_at IS NOT NULL
    AND statement_timestamp() >= v_subscription.next_cycle_at
      - make_interval(hours => v_subscription.edit_window_hours)
  THEN
    v_blocked_reason := 'edit_window_closed';
  ELSIF EXISTS (
    SELECT 1 FROM public.subscription_cycles AS cycle
    LEFT JOIN public.commerce_orders AS order_row ON order_row.subscription_cycle_id = cycle.id
    WHERE cycle.subscription_id = v_subscription.id
      AND cycle.scheduled_at = v_subscription.next_cycle_at
      AND (cycle.status IN ('payment_pending', 'paid')
        OR order_row.status IN ('paid', 'fulfillment_pending', 'fulfilled'))
  ) THEN
    v_blocked_reason := 'cycle_locked';
  END IF;
  IF v_blocked_reason IS NOT NULL THEN
    RETURN jsonb_build_object('preview', jsonb_build_object(
      'subscriptionId', v_subscription.id,
      'action', 'update_bundle',
      'canApply', false,
      'blockedReason', v_blocked_reason,
      'nextCycleAt', v_subscription.next_cycle_at,
      'editCutoffAt', CASE WHEN v_subscription.next_cycle_at IS NULL THEN NULL ELSE
        v_subscription.next_cycle_at - make_interval(hours => v_subscription.edit_window_hours) END,
      'templateVersion', v_subscription.template_version
    ));
  END IF;
  IF v_subscription.price_list_id IS NULL OR v_subscription.currency_code IS NULL THEN
    RAISE EXCEPTION 'subscription_edit_price_context_missing' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1 FROM (
      SELECT value FROM jsonb_array_elements(p_core_lines)
      UNION ALL
      SELECT value FROM jsonb_array_elements(COALESCE(p_addon_lines, '[]'::jsonb))
    ) AS requested
    WHERE jsonb_typeof(requested.value) <> 'object'
      OR COALESCE(requested.value->>'variantId', '')
        !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      OR COALESCE(requested.value->>'qty', '') !~ '^[0-9]+$'
      OR (requested.value->>'qty')::integer NOT BETWEEN 1 AND 99
  ) THEN
    RAISE EXCEPTION 'subscription_edit_invalid_lines' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM (
      SELECT value->>'variantId' AS variant_id FROM jsonb_array_elements(p_core_lines)
      UNION ALL
      SELECT value->>'variantId' FROM jsonb_array_elements(COALESCE(p_addon_lines, '[]'::jsonb))
    ) AS requested GROUP BY variant_id::uuid HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'subscription_edit_duplicate_variant' USING ERRCODE = '22023';
  END IF;

  v_fingerprint := public.subscription_bundle_edit_fingerprint(
    v_subscription.id, p_core_lines, COALESCE(p_addon_lines, '[]'::jsonb),
    COALESCE(p_composition_constraint, '{}'::jsonb), v_cadence_days, v_expected_version
  );

  SELECT * INTO v_quote FROM public.subscription_edit_quotes
   WHERE subscription_id = v_subscription.id AND idempotency_key = v_command_key FOR UPDATE;
  IF FOUND THEN
    IF v_quote.command_key_identity IS DISTINCT FROM v_key_identity THEN
      RAISE EXCEPTION 'subscription_command_ambiguous_idempotency_key' USING ERRCODE = '23505';
    END IF;
  ELSE
    SELECT * INTO v_quote FROM public.subscription_edit_quotes
     WHERE subscription_id = v_subscription.id AND idempotency_key = p_idempotency_key
       AND command_key_identity IS NULL FOR UPDATE;
  END IF;
  IF v_quote.id IS NOT NULL THEN
    IF v_quote.request_fingerprint <> v_fingerprint THEN
      RAISE EXCEPTION 'subscription_edit_idempotency_conflict' USING ERRCODE = '23505';
    END IF;
    IF v_existing.id IS NULL THEN
      v_missing_sku := EXISTS (
        SELECT 1 FROM jsonb_array_elements(v_quote.proposed_lines) AS line
        WHERE NOT EXISTS (SELECT 1 FROM public.catalog_skus AS sku WHERE sku.id = (line->>'variantId')::uuid)
      );
    END IF;
    -- First acceptance checks the saved terms and SKU identities.
    v_can_apply := CASE WHEN v_existing.id IS NOT NULL THEN v_quote.accepted_event_id IS NOT DISTINCT FROM v_existing.id
      ELSE v_quote.status = 'previewed' AND v_quote.expires_at > statement_timestamp()
        AND v_quote.expected_template_version = v_subscription.template_version
        AND v_quote.new_total_minor > 0 AND EXISTS (
          SELECT 1 FROM public.subscription_renewal_terms
          WHERE subscription_id = v_subscription.id AND currency_code = v_quote.currency_code
        ) AND NOT v_missing_sku END;
  ELSE
    IF NOT EXISTS (
      SELECT 1 FROM public.subscription_renewal_terms
      WHERE subscription_id = v_subscription.id AND currency_code = v_subscription.currency_code
    ) THEN
      RAISE EXCEPTION 'subscription_edit_price_context_missing' USING ERRCODE = '22023';
    END IF;

    WITH pricing_clock AS MATERIALIZED (
      SELECT GREATEST(clock_timestamp(), date_trunc('milliseconds', transaction_timestamp())) AS at
    )
    SELECT jsonb_agg(jsonb_build_object(
        'variantId', requested.variant_id,
        'quantity', requested.quantity,
        'isAddon', requested.is_addon,
        'sortOrder', requested.sort_order,
        'unitPriceMinor', requested.unit_price_minor,
        'currency', v_subscription.currency_code
      ) ORDER BY requested.sort_order),
      sum(requested.unit_price_minor * requested.quantity)
    INTO v_lines, v_new_total
    FROM (
      SELECT parsed.variant_id, parsed.quantity, parsed.is_addon, parsed.sort_order,
        COALESCE((SELECT price.unit_price_minor
           FROM public.price_entries AS price
          WHERE price.variant_id = parsed.variant_id
            AND price.price_list_id = v_subscription.price_list_id
            AND price.mode IN ('subscription', 'any')
            AND price.active = true
            AND price.min_qty <= parsed.quantity
            AND price.valid_from <= pricing_clock.at
            AND (price.valid_to IS NULL OR price.valid_to > pricing_clock.at)
          ORDER BY CASE price.mode WHEN 'subscription' THEN 0 ELSE 1 END,
            price.min_qty DESC, price.valid_from DESC, price.id
          LIMIT 1),
          (SELECT unit_price_minor FROM public.catalog_admission_derived_subscription_prices(
            v_subscription.price_list_id, v_subscription.currency_code, parsed.variant_id, parsed.quantity, pricing_clock.at
          ))) AS unit_price_minor
      FROM (
        SELECT (value->>'variantId')::uuid AS variant_id,
          (value->>'qty')::integer AS quantity, false AS is_addon,
          (ordinality - 1)::integer AS sort_order
        FROM jsonb_array_elements(p_core_lines) WITH ORDINALITY
        UNION ALL
        SELECT (value->>'variantId')::uuid, (value->>'qty')::integer, true,
          (jsonb_array_length(p_core_lines) + ordinality - 1)::integer
        FROM jsonb_array_elements(COALESCE(p_addon_lines, '[]'::jsonb)) WITH ORDINALITY
      ) AS parsed
      JOIN public.catalog_skus AS sku ON sku.id = parsed.variant_id
        AND sku.status = 'active' AND sku.sellable_in_subscription = true
      CROSS JOIN pricing_clock
    ) AS requested;

    IF v_new_total = 0 OR v_lines IS NULL OR jsonb_array_length(v_lines)
        <> jsonb_array_length(p_core_lines) + jsonb_array_length(COALESCE(p_addon_lines, '[]'::jsonb))
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_lines) AS line
        WHERE line->'unitPriceMinor' = 'null'::jsonb)
    THEN
      RAISE EXCEPTION 'subscription_edit_catalog_unavailable' USING ERRCODE = '22023';
    END IF;

    SELECT COALESCE(sum(line.unit_price_minor * line.quantity), 0)
      INTO v_current_total FROM public.subscription_lines AS line
     WHERE line.subscription_id = v_subscription.id;

    v_expires_at := statement_timestamp() + make_interval(mins => public.subscription_edit_quote_ttl_minutes_read());
    v_quote_hash := encode(sha256(convert_to(
      v_subscription.id::text || ':' || v_fingerprint || ':' || v_expected_version::text
      || ':' || v_new_total::text || ':' || v_expires_at::text, 'UTF8')), 'hex');
    INSERT INTO public.subscription_edit_quotes (
      subscription_id, idempotency_key, request_fingerprint, quote_hash, command_key_identity,
      expected_template_version, proposed_lines, proposed_cadence_days,
      current_total_minor, new_total_minor, currency_code, expires_at
    ) VALUES (
      v_subscription.id, v_command_key, v_fingerprint, v_quote_hash, v_key_identity,
      v_expected_version, v_lines, v_cadence_days, v_current_total, v_new_total,
      v_subscription.currency_code, v_expires_at
    ) RETURNING * INTO v_quote;
  END IF;

  RETURN jsonb_build_object('preview', jsonb_build_object(
    'subscriptionId', v_subscription.id,
    'action', 'update_bundle',
    'canApply', v_can_apply,
    'blockedReason', NULL,
    'nextCycleAt', v_subscription.next_cycle_at,
    'editCutoffAt', CASE WHEN v_subscription.next_cycle_at IS NULL THEN NULL ELSE
      v_subscription.next_cycle_at - make_interval(hours => v_subscription.edit_window_hours) END,
    'templateVersion', v_subscription.template_version,
    'quoteHash', v_quote.quote_hash,
    'quoteExpiresAt', v_quote.expires_at,
    'currentTotal', jsonb_build_object('amountMinor', v_quote.current_total_minor, 'currency', v_quote.currency_code),
    'newTotal', jsonb_build_object('amountMinor', v_quote.new_total_minor, 'currency', v_quote.currency_code),
    'delta', jsonb_build_object('amountMinor', v_quote.new_total_minor - v_quote.current_total_minor, 'currency', v_quote.currency_code),
    'catalogAvailability', jsonb_build_object(
      'status', CASE WHEN v_missing_sku THEN 'blocked' ELSE 'available' END,
      'blockedReason', NULL
    )
  ));
END;
$$;

CREATE OR REPLACE FUNCTION public.subscription_command_preview(
 p_actor_id uuid,p_client_id uuid,p_key text,p_subscription_id uuid,p_action text,
 p_payload jsonb,p_now timestamptz DEFAULT now()
) RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
 s public.subscriptions%ROWTYPE; r public.subscription_command_receipts%ROWTYPE;
 q public.subscription_edit_quotes%ROWTYPE; command jsonb; fingerprint text;
 core jsonb; addons jsonb; requested jsonb; lines jsonb; cadence integer; version integer;
 total bigint; current_total bigint; quote_key text; quote_hash text; answer jsonb; reason text;
 v_noop boolean:=false; core_matches boolean; addon_matches boolean;
 v_expires_at timestamptz;
BEGIN
 IF p_actor_id IS NULL OR p_client_id IS NULL OR p_now IS NULL OR NOT isfinite(p_now)
  OR p_key IS NULL OR p_key<>btrim(p_key) OR char_length(p_key) NOT BETWEEN 8 AND 180
  OR p_payload IS NULL OR jsonb_typeof(p_payload)<>'object' OR p_payload ? 'acceptedQuoteHash' OR p_action IS NULL THEN
  RAISE EXCEPTION 'subscription_command_invalid_input' USING ERRCODE='22023';
 END IF;
 command:=jsonb_build_object('clientId',p_client_id,'subscriptionId',p_subscription_id,'action',p_action,'payload',p_payload-'acceptedQuoteHash');
 fingerprint:=encode(sha256(convert_to(command::text,'UTF8')),'hex');
 -- Serialize the actor/key even when competing commands target different rows.
 PERFORM pg_advisory_xact_lock(hashtextextended(p_actor_id::text||':'||p_key,0));
 SELECT * INTO s FROM public.subscriptions WHERE id=p_subscription_id AND client_id=p_client_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'subscription_command_forbidden' USING ERRCODE='22023'; END IF;
 SELECT * INTO r FROM public.subscription_command_receipts WHERE actor_id=p_actor_id AND idempotency_key=p_key;
 IF FOUND THEN
  IF jsonb_set(r.command,'{payload}',(r.command->'payload')-'acceptedQuoteHash')<>command THEN
   RETURN jsonb_build_object('status','refused','reason','subscription_command_idempotency_conflict');
  END IF;
  RETURN r.result;
 END IF;
 <<preview_command>>
 BEGIN
  IF p_action='slide_next_cycle' THEN
   BEGIN
    v_noop:=s.status='active' AND s.next_cycle_at IS NOT NULL
     AND floor(extract(epoch FROM NULLIF(p_payload->>'newNextCycleAt','')::timestamptz)/86400)
      =floor(extract(epoch FROM s.next_cycle_at)/86400);
   EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
    RAISE EXCEPTION 'subscription_command_preview_unsupported' USING ERRCODE='22023';
   END;
   IF v_noop IS NOT TRUE THEN
    RAISE EXCEPTION 'subscription_command_preview_unsupported' USING ERRCODE='22023';
   END IF;
  ELSE
  IF p_action NOT IN ('update_bundle','resize_bundle','update_package_template','update_plan_length',
    'add_addon','remove_addon','update_addon_quantity') THEN
   RAISE EXCEPTION 'subscription_command_preview_unsupported' USING ERRCODE='22023';
  END IF;
  IF s.status<>'active' THEN RAISE EXCEPTION 'subscription_command_not_active' USING ERRCODE='22023'; END IF;
  IF p_action<>'cancel' AND EXISTS(SELECT 1 FROM public.subscription_dunning_cases WHERE subscription_id=s.id AND status='open') THEN
   RAISE EXCEPTION 'subscription_command_payment_blocked' USING ERRCODE='22023';
  END IF;
  IF s.next_cycle_at IS NULL OR p_now>=s.next_cycle_at-make_interval(hours=>s.edit_window_hours) THEN
   RAISE EXCEPTION 'subscription_edit_window_closed' USING ERRCODE='22023';
  END IF;
  PERFORM public.subscription_lifecycle_assert_unlocked_cycle(s.id,s.next_cycle_at);
  IF NOT (CASE WHEN public.subscription_method_uses_recorded_refs(s.id) THEN public.subscription_method_chargeable_unattended(s.id,now()) ELSE EXISTS(SELECT 1 FROM public.subscription_method_states ms WHERE ms.subscription_id=s.id AND ms.health_state='healthy') END) THEN
   RAISE EXCEPTION 'subscription_command_payment_blocked' USING ERRCODE='22023';
  END IF;
  version:=(p_payload->>'expectedTemplateVersion')::integer;
  IF version IS NULL OR version<>s.template_version THEN
   RAISE EXCEPTION 'subscription_edit_stale_template' USING ERRCODE='22023';
  END IF;
  cadence:=CASE WHEN p_action IN ('update_bundle','resize_bundle','update_package_template','update_plan_length')
   THEN COALESCE((p_payload->>'cadenceDays')::integer,(p_payload->>'planDays')::integer,s.cadence_days) ELSE s.cadence_days END;
  IF cadence NOT BETWEEN 1 AND 3660 OR s.price_list_id IS NULL OR s.currency_code IS NULL THEN
   RAISE EXCEPTION 'subscription_edit_invalid_request' USING ERRCODE='22023';
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('variantId',variant_id,'qty',quantity) ORDER BY sort_order,id)
   FILTER(WHERE NOT is_addon),'[]'),COALESCE(jsonb_agg(jsonb_build_object('variantId',variant_id,'qty',quantity)
   ORDER BY sort_order,id) FILTER(WHERE is_addon),'[]'),COALESCE(sum(quantity*unit_price_minor),0)
   INTO core,addons,current_total FROM public.subscription_lines WHERE subscription_id=s.id;
  IF p_action IN ('update_bundle','resize_bundle','update_package_template') THEN
   IF p_payload->'compositionConstraint' IS NULL OR jsonb_typeof(p_payload->'compositionConstraint')<>'object'
    OR (p_payload->'compositionConstraint') ?| ARRAY['version','data'] THEN
    RAISE EXCEPTION 'subscription_command_invalid_composition_constraint' USING ERRCODE='22023';
   END IF;
  END IF;
  -- Compare donor line sets by UUID and summed quantity, independently of order/prices.
  SELECT bool_and(matches) FILTER(WHERE NOT is_addon),bool_and(matches) FILTER(WHERE is_addon)
   INTO core_matches,addon_matches FROM (
    SELECT is_addon,jsonb_typeof(wanted)='array' AND
     (SELECT COALESCE(jsonb_object_agg(variant,qty),'{}') FROM (
       SELECT (v->>'variantId')::uuid variant,sum((v->>'qty')::integer) qty
       FROM jsonb_array_elements(CASE WHEN jsonb_typeof(wanted)='array' THEN wanted ELSE '[]' END) v
       WHERE COALESCE(v->>'variantId','') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        AND COALESCE(v->>'qty','') ~ '^[1-9][0-9]{0,5}$'
       GROUP BY (v->>'variantId')::uuid) desired)
     =(SELECT COALESCE(jsonb_object_agg(variant_id,qty),'{}') FROM (
       SELECT variant_id,sum(quantity) qty FROM public.subscription_lines
       WHERE subscription_id=s.id AND is_addon=inputs.is_addon GROUP BY variant_id) stored)
     AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(
       CASE WHEN jsonb_typeof(wanted)='array' THEN wanted ELSE '[]' END) v
       WHERE COALESCE(v->>'variantId','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        OR COALESCE(v->>'qty','') !~ '^[1-9][0-9]{0,5}$') matches
    FROM (VALUES(false,p_payload->'coreLines'),(true,COALESCE(p_payload->'addonLines','[]'))) inputs(is_addon,wanted)
   ) line_sets;
  IF p_action IN ('add_addon','update_addon_quantity') THEN
   v_noop:=EXISTS(SELECT 1 FROM public.subscription_lines WHERE subscription_id=s.id
    AND variant_id=NULLIF(p_payload->>'variantId','')::uuid AND is_addon
    AND quantity=CASE WHEN p_action='add_addon' THEN GREATEST(1,COALESCE((p_payload->>'qty')::integer,1))
     ELSE (p_payload->>'qty')::integer END);
  ELSIF p_action='update_bundle' THEN
   v_noop:=core_matches AND cadence=s.cadence_days AND (NOT p_payload ? 'addonLines' OR addon_matches);
  ELSIF p_action='resize_bundle' THEN
   v_noop:=core_matches AND cadence=s.cadence_days;
  ELSIF p_action='update_plan_length' THEN
   v_noop:=cadence=s.cadence_days AND core_matches;
  ELSIF p_action='update_package_template' THEN
   v_noop:=cadence=s.cadence_days AND core_matches AND addon_matches;
  END IF;
  END IF;
  IF v_noop THEN
   answer:=jsonb_build_object('status','noop','subscriptionId',s.id,'action',p_action,'subscriptionStatus',s.status,
    'nextCycleAt',s.next_cycle_at,'templateVersion',s.template_version,'eventId',NULL);
   EXIT preview_command;
  END IF;
  IF p_action IN ('update_bundle','resize_bundle','update_package_template') THEN
   core:=p_payload->'coreLines';
   IF p_action='update_package_template' OR (p_action='update_bundle' AND p_payload ? 'addonLines') THEN
    addons:=COALESCE(p_payload->'addonLines','[]');
   END IF;
   IF p_action='update_bundle' AND cadence=s.cadence_days AND
    (SELECT COALESCE(sum((v->>'qty')::integer),0) FROM jsonb_array_elements(core) v)<>
    (SELECT COALESCE(sum(quantity),0) FROM public.subscription_lines WHERE subscription_id=s.id AND NOT is_addon) THEN
    RAISE EXCEPTION 'subscription_command_bundle_total_mismatch' USING ERRCODE='22023';
   END IF;
  ELSIF p_action='update_plan_length' THEN
   core:=COALESCE(p_payload->'coreLines',core);
  ELSIF p_action='add_addon' THEN
   addons:=addons||jsonb_build_array(jsonb_build_object('variantId',p_payload->>'variantId','qty',GREATEST(1,COALESCE((p_payload->>'qty')::integer,1))));
  ELSIF p_action IN ('remove_addon','update_addon_quantity') THEN
   IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(addons) v WHERE v->>'variantId'=lower(p_payload->>'variantId')) THEN
    RAISE EXCEPTION 'subscription_command_addon_not_found' USING ERRCODE='22023';
   END IF;
   SELECT COALESCE(jsonb_agg(CASE WHEN v->>'variantId'=lower(p_payload->>'variantId') THEN
    jsonb_set(v,'{qty}',p_payload->'qty') ELSE v END),'[]') INTO addons
    FROM jsonb_array_elements(addons) v WHERE p_action<>'remove_addon' OR v->>'variantId'<>lower(p_payload->>'variantId');
  END IF;
  IF core IS NULL OR jsonb_typeof(core)<>'array' OR jsonb_array_length(core) NOT BETWEEN 1 AND 6
   OR addons IS NULL OR jsonb_typeof(addons)<>'array' OR jsonb_array_length(addons)>12 THEN
   RAISE EXCEPTION 'subscription_edit_invalid_lines' USING ERRCODE='22023';
  END IF;
  requested:=core||addons;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(requested) v WHERE jsonb_typeof(v)<>'object'
    OR COALESCE(v->>'variantId','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR COALESCE(v->>'qty','') !~ '^[0-9]{1,2}$' OR (v->>'qty')::integer NOT BETWEEN 1 AND 99)
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(requested) v GROUP BY lower(v->>'variantId') HAVING count(*)>1) THEN
   RAISE EXCEPTION 'subscription_edit_invalid_lines' USING ERRCODE='22023';
  END IF;
  WITH pricing_clock AS MATERIALIZED (
   SELECT GREATEST(clock_timestamp(), date_trunc('milliseconds', transaction_timestamp())) AS at
  )
  SELECT jsonb_agg(jsonb_build_object('variantId',sku.id,'quantity',(v->>'qty')::integer,
    'isAddon',ord>jsonb_array_length(core),'sortOrder',ord-1,'unitPriceMinor',price.unit_price_minor,'currency',s.currency_code)
    ORDER BY ord),sum(price.unit_price_minor*(v->>'qty')::integer)
   INTO lines,total FROM jsonb_array_elements(requested) WITH ORDINALITY x(v,ord)
   JOIN public.catalog_skus sku ON sku.id=(v->>'variantId')::uuid AND sku.status='active' AND sku.sellable_in_subscription
   CROSS JOIN pricing_clock
   CROSS JOIN LATERAL (
    SELECT COALESCE(
     (SELECT pe.unit_price_minor FROM public.price_entries pe WHERE pe.variant_id=sku.id
    AND pe.price_list_id=s.price_list_id AND pe.mode IN ('subscription','any') AND pe.active
    AND pe.min_qty<=(v->>'qty')::integer AND pe.valid_from<=pricing_clock.at
    AND (pe.valid_to IS NULL OR pe.valid_to>pricing_clock.at)
    ORDER BY CASE pe.mode WHEN 'subscription' THEN 0 ELSE 1 END,pe.min_qty DESC,pe.valid_from DESC,pe.id LIMIT 1),
     (SELECT unit_price_minor FROM public.catalog_admission_derived_subscription_prices(
       s.price_list_id, s.currency_code, sku.id, (v->>'qty')::integer, pricing_clock.at
     ))
    ) AS unit_price_minor
   ) price;
  IF lines IS NULL OR jsonb_array_length(lines)<>jsonb_array_length(requested)
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(lines) v WHERE v->'unitPriceMinor'='null') THEN
   RAISE EXCEPTION 'subscription_edit_catalog_unavailable' USING ERRCODE='22023';
  END IF;
  quote_key:='command:'||encode(sha256(convert_to(p_actor_id::text||':'||p_key,'UTF8')),'hex');
  v_expires_at:=p_now+make_interval(mins=>public.subscription_edit_quote_ttl_minutes_read());
  quote_hash:=encode(sha256(convert_to(quote_key||':'||fingerprint||':'||lines::text||':'||v_expires_at::text,'UTF8')),'hex');
  INSERT INTO public.subscription_edit_quotes(subscription_id,idempotency_key,request_fingerprint,quote_hash,
   expected_template_version,proposed_lines,proposed_cadence_days,current_total_minor,new_total_minor,currency_code,expires_at)
   VALUES(s.id,quote_key,fingerprint,quote_hash,version,lines,cadence,current_total,total,s.currency_code,v_expires_at) RETURNING * INTO q;
  answer:=jsonb_build_object('status','previewed','canApply',true,'quoteHash',q.quote_hash,'quoteExpiresAt',q.expires_at,
   'templateVersion',version,'lines',lines,'currentTotalMinor',current_total,'newTotalMinor',total,
   'priceAgreementPolicy',jsonb_build_object('kind','lock_until_edit','proration','none','cycleEffect','future_unlocked_cycles_only'));
 EXCEPTION WHEN SQLSTATE '22023' OR invalid_text_representation OR numeric_value_out_of_range THEN
  GET STACKED DIAGNOSTICS reason=MESSAGE_TEXT;
  IF SQLSTATE = '22023' AND reason = 'subscription_edit_quote_ttl_minutes_policy_invalid' THEN
   RAISE;
  END IF;
  answer:=jsonb_build_object('status','refused','canApply',false,'reason',reason);
 END;
 INSERT INTO public.subscription_command_receipts(actor_id,idempotency_key,subscription_id,client_id,command_fingerprint,command,quote_hash,result,status)
  VALUES(p_actor_id,p_key,s.id,p_client_id,fingerprint,command,q.quote_hash,answer,answer->>'status');
 RETURN answer;
END;
$$;

CREATE OR REPLACE FUNCTION public.customer_subscription_apply_bundle_as_actor(
  p_subscription_id uuid,
  p_idempotency_key text,
  p_accepted_quote_hash text,
  p_core_lines jsonb,
  p_addon_lines jsonb DEFAULT '[]'::jsonb,
  p_composition_constraint jsonb DEFAULT '{}'::jsonb,
  p_cadence_days integer DEFAULT NULL,
  p_expected_template_version integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_principal_id uuid;
  v_client_id uuid;
  v_command_key text;
  v_key_identity jsonb;
  v_subscription public.subscriptions%ROWTYPE;
  v_quote public.subscription_edit_quotes%ROWTYPE;
  v_existing public.subscription_events%ROWTYPE;
  v_event_id uuid;
  v_fingerprint text;
  v_line jsonb;
  v_acceptance jsonb;
BEGIN
  -- A deferred trigger re-enters the existing customer authority by event ID.
  -- This tuple of NULL arguments was never a valid commerce command.
  IF pg_trigger_depth()>0 AND p_idempotency_key IS NULL AND p_accepted_quote_hash IS NULL AND p_core_lines IS NULL THEN
    PERFORM public.catalog_customer_edit_acceptance_assert(p_subscription_id);
    RETURN NULL;
  END IF;
  IF p_idempotency_key IS NULL OR p_idempotency_key <> btrim(p_idempotency_key)
    OR char_length(p_idempotency_key) NOT BETWEEN 8 AND 180
  THEN
    RAISE EXCEPTION 'subscription_edit_invalid_idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF starts_with(p_idempotency_key, 'command:') THEN
    RAISE EXCEPTION 'subscription_command_reserved_idempotency_key' USING ERRCODE = '22023';
  END IF;
  v_principal_id := auth.uid();
  IF v_principal_id IS NULL THEN
    RAISE EXCEPTION 'subscription_edit_not_found' USING ERRCODE = '22023';
  END IF;
  SELECT client.id INTO v_client_id FROM public.clients AS client
   WHERE client.principal_id = v_principal_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'subscription_edit_not_found' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_subscription FROM public.subscriptions
   WHERE id = p_subscription_id AND client_id = v_client_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'subscription_edit_forbidden' USING ERRCODE = '22023';
  END IF;

  v_command_key := 'command:' || encode(sha256(convert_to(
    v_principal_id::text || ':' || p_idempotency_key, 'UTF8')), 'hex');
  v_key_identity := jsonb_build_object('derivation', 'principal-sha256.v1', 'actorId', v_principal_id);

  SELECT * INTO v_existing FROM public.subscription_events
   WHERE subscription_id = v_subscription.id AND idempotency_key = v_command_key;
  IF FOUND THEN
    IF COALESCE(v_existing.payload->'commandKeyIdentity', v_existing.payload#>'{payload,commandKeyIdentity}') IS DISTINCT FROM v_key_identity THEN
      RAISE EXCEPTION 'subscription_command_ambiguous_idempotency_key' USING ERRCODE = '23505';
    END IF;
    IF v_existing.event_type <> 'subscription.customer_self_service.update_bundle'
      OR v_existing.payload->>'action' IS DISTINCT FROM 'update_bundle'
    THEN
      RAISE EXCEPTION 'subscription_edit_idempotency_conflict' USING ERRCODE = '23505';
    END IF;
  ELSE
    SELECT * INTO v_existing FROM public.subscription_events
     WHERE subscription_id = v_subscription.id AND idempotency_key = p_idempotency_key;
    IF FOUND THEN
      IF COALESCE(v_existing.payload->'commandKeyIdentity', v_existing.payload#>'{payload,commandKeyIdentity}') IS NOT NULL THEN
        RAISE EXCEPTION 'subscription_command_ambiguous_idempotency_key' USING ERRCODE = '23505';
      END IF;
      IF starts_with(v_existing.event_type, 'subscription.customer_self_service.') THEN
        IF v_existing.event_type <> 'subscription.customer_self_service.update_bundle'
          OR v_existing.payload->>'action' IS DISTINCT FROM 'update_bundle'
        THEN
          RAISE EXCEPTION 'subscription_edit_idempotency_conflict' USING ERRCODE = '23505';
        END IF;
      ELSE
        -- A system row at the raw key belongs to its producer, never this command.
        v_existing := NULL;
      END IF;
    END IF;
  END IF;

  SELECT * INTO v_quote FROM public.subscription_edit_quotes
   WHERE subscription_id = v_subscription.id AND idempotency_key = v_command_key FOR UPDATE;
  IF FOUND THEN
    IF v_quote.command_key_identity IS DISTINCT FROM v_key_identity THEN
      RAISE EXCEPTION 'subscription_command_ambiguous_idempotency_key' USING ERRCODE = '23505';
    END IF;
  ELSE
    SELECT * INTO v_quote FROM public.subscription_edit_quotes
     WHERE subscription_id = v_subscription.id AND idempotency_key = p_idempotency_key
       AND command_key_identity IS NULL FOR UPDATE;
  END IF;
  IF v_existing.id IS NOT NULL THEN
    v_fingerprint := public.subscription_bundle_edit_fingerprint(
      v_subscription.id, p_core_lines, COALESCE(p_addon_lines, '[]'::jsonb),
      COALESCE(p_composition_constraint, '{}'::jsonb),
      COALESCE(p_cadence_days, v_subscription.cadence_days),
      COALESCE(p_expected_template_version, v_quote.expected_template_version)
    );
    IF v_quote.id IS NULL OR v_existing.event_type <> 'subscription.customer_self_service.update_bundle'
      OR v_existing.payload->>'action' IS DISTINCT FROM 'update_bundle'
      OR v_quote.quote_hash IS DISTINCT FROM p_accepted_quote_hash
      OR v_quote.request_fingerprint <> v_fingerprint
      OR v_quote.accepted_event_id IS DISTINCT FROM v_existing.id
    THEN
      RAISE EXCEPTION 'subscription_edit_idempotency_conflict' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object(
      'contractVersion', 'customer.self_service.v1',
      'subscriptionAction', jsonb_build_object(
        'subscriptionId', v_subscription.id,
        'action', 'update_bundle',
        'status', 'replayed',
        'subscriptionStatus', v_subscription.status,
        'nextCycleAt', v_subscription.next_cycle_at,
        'templateVersion', v_subscription.template_version,
        'eventId', v_existing.id
      )
    );
  END IF;

  IF v_quote.id IS NULL OR v_quote.quote_hash IS DISTINCT FROM p_accepted_quote_hash THEN
    RAISE EXCEPTION 'subscription_edit_quote_required' USING ERRCODE = '22023';
  END IF;
  v_fingerprint := public.subscription_bundle_edit_fingerprint(
    v_subscription.id, p_core_lines, COALESCE(p_addon_lines, '[]'::jsonb),
    COALESCE(p_composition_constraint, '{}'::jsonb),
    COALESCE(p_cadence_days, v_subscription.cadence_days),
    COALESCE(p_expected_template_version, v_subscription.template_version)
  );
  IF v_quote.request_fingerprint <> v_fingerprint THEN
    RAISE EXCEPTION 'subscription_edit_idempotency_conflict' USING ERRCODE = '23505';
  END IF;
  IF v_quote.status <> 'previewed' OR v_quote.expires_at <= statement_timestamp() THEN
    RAISE EXCEPTION 'subscription_edit_quote_expired' USING ERRCODE = '22023';
  END IF;
  IF v_subscription.status <> 'active'
    OR v_subscription.template_version <> v_quote.expected_template_version
  THEN
    RAISE EXCEPTION 'subscription_edit_stale_template' USING ERRCODE = '22023';
  END IF;
  IF v_subscription.next_cycle_at IS NOT NULL
    AND statement_timestamp() >= v_subscription.next_cycle_at
      - make_interval(hours => v_subscription.edit_window_hours)
  THEN
    RAISE EXCEPTION 'subscription_edit_window_closed' USING ERRCODE = '22023';
  END IF;
  PERFORM public.subscription_lifecycle_assert_unlocked_cycle(
    v_subscription.id, v_subscription.next_cycle_at
  );

  PERFORM 1 FROM public.subscription_renewal_terms
   WHERE subscription_id = v_subscription.id AND currency_code = v_quote.currency_code FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'subscription_edit_price_context_missing' USING ERRCODE = '22023';
  END IF;
  -- Hold the saved SKUs through the template insert so deletion cannot race acceptance.
  IF v_quote.new_total_minor <= 0 OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_quote.proposed_lines) AS line
    WHERE NOT EXISTS (
      SELECT 1 FROM public.catalog_skus AS sku WHERE sku.id = (line->>'variantId')::uuid FOR KEY SHARE
    )
  ) THEN
    RAISE EXCEPTION 'subscription_edit_catalog_unavailable' USING ERRCODE = '22023';
  END IF;

  v_acceptance:=v_quote.catalog_acceptance;
  IF v_acceptance IS NOT NULL THEN PERFORM public.catalog_acceptance_assert_v2(v_acceptance); END IF;
  DELETE FROM public.subscription_lines WHERE subscription_id = v_subscription.id;
  FOR v_line IN SELECT value FROM jsonb_array_elements(v_quote.proposed_lines)
  LOOP
    INSERT INTO public.subscription_lines (
      subscription_id, variant_id, quantity, sort_order, is_addon,
      unit_price_minor, currency_code
    ) VALUES (
      v_subscription.id,
      (v_line->>'variantId')::uuid,
      (v_line->>'quantity')::integer,
      (v_line->>'sortOrder')::integer,
      (v_line->>'isAddon')::boolean,
      (v_line->>'unitPriceMinor')::bigint,
      v_quote.currency_code
    );
  END LOOP;
  DELETE FROM public.subscription_renewal_term_lines WHERE subscription_id = v_subscription.id;
  INSERT INTO public.subscription_renewal_term_lines (subscription_id, line_ordinal, sku, quantity, unit_amount_minor)
    SELECT v_subscription.id, (line->>'sortOrder')::integer + 1, sku.sku,
      (line->>'quantity')::integer, (line->>'unitPriceMinor')::bigint
    FROM jsonb_array_elements(v_quote.proposed_lines) line
    JOIN public.catalog_skus sku ON sku.id = (line->>'variantId')::uuid;
  UPDATE public.subscription_renewal_terms SET updated_at = statement_timestamp()
  WHERE subscription_id = v_subscription.id;

  UPDATE public.subscriptions SET
    cadence_days = v_quote.proposed_cadence_days,
    template_version = template_version + 1,
    updated_at = statement_timestamp()
  WHERE id = v_subscription.id RETURNING * INTO v_subscription;

  INSERT INTO public.subscription_events (
    subscription_id, event_type, idempotency_key, payload, occurred_at
  ) VALUES (
    v_subscription.id,
    'subscription.customer_self_service.update_bundle',
    v_command_key,
    jsonb_build_object(
      'action', 'update_bundle',
      'commandKeyIdentity', v_key_identity,
      'quoteHash', v_quote.quote_hash,
      'templateVersion', v_subscription.template_version,
      'newTotalMinor', v_quote.new_total_minor,
      'currency', v_quote.currency_code
    ),
    statement_timestamp()
  ) RETURNING id INTO v_event_id;
  UPDATE public.subscription_edit_quotes SET
    status = 'accepted', accepted_event_id = v_event_id,
    accepted_at = statement_timestamp()
  WHERE id = v_quote.id;
  PERFORM public.catalog_attach_edit_acceptance(v_event_id,v_acceptance);

  RETURN jsonb_build_object(
    'contractVersion', 'customer.self_service.v1',
    'subscriptionAction', jsonb_build_object(
      'subscriptionId', v_subscription.id,
      'action', 'update_bundle',
      'status', 'applied',
      'subscriptionStatus', v_subscription.status,
      'nextCycleAt', v_subscription.next_cycle_at,
      'templateVersion', v_subscription.template_version,
      'eventId', v_event_id
    )
  );
END;
$$;
