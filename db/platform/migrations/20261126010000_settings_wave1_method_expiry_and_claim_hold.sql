-- Stage 5 Wave 1: validate and read installed policies for method expiry warning
-- days (E4) and promotion claim hold hours (E7) with historical absence fallbacks.

CREATE FUNCTION public.payment_method_expiry_warning_days_validate(p_policy jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_days numeric;
BEGIN
  IF p_policy IS NULL OR jsonb_typeof(p_policy) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'payment_method_expiry_warning_days_policy_invalid' USING ERRCODE = '22023';
  END IF;
  IF NOT (p_policy ?& ARRAY['revision', 'warningDays'])
    OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_policy) k WHERE k NOT IN ('revision', 'warningDays'))
    OR jsonb_typeof(p_policy->'revision') IS DISTINCT FROM 'string'
    OR btrim(p_policy->>'revision', E' \t\n\r\f\u000b\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff') = ''
    OR jsonb_typeof(p_policy->'warningDays') IS DISTINCT FROM 'number' THEN
    RAISE EXCEPTION 'payment_method_expiry_warning_days_policy_invalid' USING ERRCODE = '22023';
  END IF;
  BEGIN
    v_days := (p_policy->>'warningDays')::numeric;
  EXCEPTION WHEN data_exception THEN
    RAISE EXCEPTION 'payment_method_expiry_warning_days_policy_invalid' USING ERRCODE = '22023';
  END;
  IF v_days <> trunc(v_days) OR v_days < 1 OR v_days > 365 THEN
    RAISE EXCEPTION 'payment_method_expiry_warning_days_policy_invalid' USING ERRCODE = '22023';
  END IF;
  RETURN jsonb_build_object('revision', p_policy->>'revision', 'warningDays', v_days::integer);
END;
$$;

CREATE FUNCTION public.payment_method_expiry_warning_days_read()
RETURNS integer
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_raw_policy text;
BEGIN
  SELECT value_text INTO v_raw_policy
  FROM public.commerce_settings
  WHERE key = 'payment_method_expiry_warning_days';
  IF NOT FOUND THEN RETURN 30; END IF;
  BEGIN
    RETURN (public.payment_method_expiry_warning_days_validate(v_raw_policy::jsonb)->>'warningDays')::integer;
  EXCEPTION WHEN data_exception THEN
    RAISE EXCEPTION 'payment_method_expiry_warning_days_policy_invalid' USING ERRCODE = '22023';
  END;
END;
$$;

CREATE OR REPLACE FUNCTION public.subscription_method_health_read(p_subscription_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
 WITH policy AS MATERIALIZED (
  SELECT public.payment_method_expiry_warning_days_read() AS warning_days
 )
 SELECT to_jsonb(h) FROM (
  SELECT s.id AS subscription_id,s.client_id,s.status AS subscription_status,s.next_cycle_at,m.id AS payment_method_ref_id,
   m.provider_kind,m.method_kind,m.provider_method_ref,m.provider_customer_ref,m.consent_snapshot,m.expires_at AS method_expires_at,
   CASE WHEN m.id IS NULL THEN 'method_missing'
    WHEN m.consent_snapshot->>'recurringModel' IS NOT NULL AND m.consent_snapshot->>'recurringModel'<>'O' THEN 'mandate_not_chargeable_unattended'
    WHEN m.consent_snapshot->>'recurringModel' IS NULL AND m.method_kind<>'card' THEN 'mandate_not_chargeable_unattended'
    WHEN m.expires_at IS NOT NULL AND m.expires_at<=now()+make_interval(days => p.warning_days) THEN 'method_expiring'
    ELSE 'healthy' END AS health_state,false AS narrow_activation_gap
  FROM policy p
  CROSS JOIN public.subscriptions s
  LEFT JOIN public.payment_method_refs m ON m.subscription_id=s.id AND m.client_id=s.client_id AND m.status='active' AND m.active
  WHERE s.status='active' AND s.id=p_subscription_id
 ) h;
$$;

CREATE FUNCTION public.promotion_claim_hold_hours_validate(p_policy jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_hours numeric;
BEGIN
  IF p_policy IS NULL OR jsonb_typeof(p_policy) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'promotion_claim_hold_hours_policy_invalid' USING ERRCODE = '22023';
  END IF;
  IF NOT (p_policy ?& ARRAY['revision', 'holdHours'])
    OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_policy) k WHERE k NOT IN ('revision', 'holdHours'))
    OR jsonb_typeof(p_policy->'revision') IS DISTINCT FROM 'string'
    OR btrim(p_policy->>'revision', E' \t\n\r\f\u000b\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff') = ''
    OR jsonb_typeof(p_policy->'holdHours') IS DISTINCT FROM 'number' THEN
    RAISE EXCEPTION 'promotion_claim_hold_hours_policy_invalid' USING ERRCODE = '22023';
  END IF;
  BEGIN
    v_hours := (p_policy->>'holdHours')::numeric;
  EXCEPTION WHEN data_exception THEN
    RAISE EXCEPTION 'promotion_claim_hold_hours_policy_invalid' USING ERRCODE = '22023';
  END;
  IF v_hours <> trunc(v_hours) OR v_hours < 1 OR v_hours > 720 THEN
    RAISE EXCEPTION 'promotion_claim_hold_hours_policy_invalid' USING ERRCODE = '22023';
  END IF;
  RETURN jsonb_build_object('revision', p_policy->>'revision', 'holdHours', v_hours::integer);
END;
$$;

CREATE FUNCTION public.promotion_claim_hold_hours_read()
RETURNS integer
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_raw_policy text;
BEGIN
  SELECT value_text INTO v_raw_policy
  FROM public.commerce_settings
  WHERE key = 'promotion_claim_hold_hours';
  IF NOT FOUND THEN RETURN 24; END IF;
  BEGIN
    RETURN (public.promotion_claim_hold_hours_validate(v_raw_policy::jsonb)->>'holdHours')::integer;
  EXCEPTION WHEN data_exception THEN
    RAISE EXCEPTION 'promotion_claim_hold_hours_policy_invalid' USING ERRCODE = '22023';
  END;
END;
$$;

CREATE OR REPLACE FUNCTION public.commerce_create_promoted_order_draft_with_outbox(
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
  v_response jsonb;
  v_order_id uuid;
  v_discount jsonb;
  v_definition public.commerce_promotion_definitions%ROWTYPE;
  v_adjustment public.commerce_order_adjustments%ROWTYPE;
  v_claim public.commerce_promotion_claims%ROWTYPE;
  v_global bigint;
  v_customer bigint;
  v_global_limit integer;
  v_customer_limit integer;
  v_lines bigint;
  v_order_discount bigint;
  v_shipping bigint;
  v_shipping_discount bigint;
  v_total bigint;
  v_shipping_terms jsonb;
  v_allocation_fingerprint text;
BEGIN
  v_response := public.catalog_admission_replay_order_draft(p_idempotency_key, p_client_id, 'native-draft',
    md5(p_quote_snapshot::text || '|' || p_order_draft_snapshot::text || '|' || coalesce(p_client_id::text, '')));
  IF v_response IS NOT NULL THEN RETURN v_response; END IF;
  PERFORM public.catalog_admission_check_legacy_draft(p_idempotency_key,p_order_draft_snapshot,p_client_id,false);

  SELECT COALESCE(sum((line.value#>>'{lineSubtotalGross,amountMinor}')::bigint), 0)
    INTO v_lines
    FROM jsonb_array_elements(p_order_draft_snapshot->'lines') AS line(value);
  SELECT
    COALESCE(sum((discount.value->>'amountOffMinor')::bigint)
      FILTER (WHERE discount.value->>'appliesTo' <> 'shipping'), 0),
    COALESCE(sum((discount.value->>'amountOffMinor')::bigint)
      FILTER (WHERE discount.value->>'appliesTo' = 'shipping'), 0)
    INTO v_order_discount, v_shipping_discount
    FROM jsonb_array_elements(COALESCE(p_order_draft_snapshot->'discounts', '[]'::jsonb))
      AS discount(value);
  v_shipping := COALESCE((p_order_draft_snapshot#>>'{totals,shippingGross,amountMinor}')::bigint, 0);
  IF v_shipping_discount IS DISTINCT FROM
      COALESCE((p_order_draft_snapshot#>>'{totals,shippingDiscountGross,amountMinor}')::bigint, 0)
    OR v_order_discount IS DISTINCT FROM
      (p_order_draft_snapshot#>>'{totals,discountTotalGross,amountMinor}')::bigint
    OR v_lines IS DISTINCT FROM
      (p_order_draft_snapshot#>>'{totals,subtotalGross,amountMinor}')::bigint THEN
    RAISE EXCEPTION 'commerce_order_draft_money_components_mismatch' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(COALESCE(p_order_draft_snapshot->'discounts', '[]'::jsonb))
      AS discount(value)
    WHERE discount.value->>'appliesTo' = 'line'
  ) THEN
    RAISE EXCEPTION 'commerce_promotion_line_allocation_unsupported' USING ERRCODE = '22023';
  END IF;
  v_shipping_terms := p_order_draft_snapshot#>'{context,shippingTerms}';
  IF v_shipping_terms IS NOT NULL THEN
    IF jsonb_typeof(v_shipping_terms) IS DISTINCT FROM 'object'
      OR v_shipping_terms - ARRAY['version','currency','flatMinor','freeThresholdMinor'] <> '{}'::jsonb
      OR v_shipping_terms->>'version' IS DISTINCT FROM 'shipping-threshold.v1'
      OR v_shipping_terms->>'currency' IS DISTINCT FROM p_order_draft_snapshot->>'currency'
      OR COALESCE(v_shipping_terms->>'flatMinor','') !~ '^[0-9]{1,10}$'
      OR COALESCE(v_shipping_terms->>'freeThresholdMinor','') !~ '^[0-9]{1,10}$' THEN
      RAISE EXCEPTION 'commerce_order_draft_money_components_mismatch' USING ERRCODE = '22023';
    END IF;
    IF (v_shipping_terms->>'flatMinor')::bigint > 2147483647
      OR (v_shipping_terms->>'freeThresholdMinor')::bigint > 2147483647
      OR v_shipping IS DISTINCT FROM (CASE
        WHEN v_lines - v_order_discount >= (v_shipping_terms->>'freeThresholdMinor')::bigint THEN 0
        ELSE (v_shipping_terms->>'flatMinor')::bigint END) THEN
      RAISE EXCEPTION 'commerce_order_draft_money_components_mismatch' USING ERRCODE = '22023';
    END IF;
  END IF;
  v_total := v_lines + v_shipping - v_order_discount - v_shipping_discount;
  IF v_total IS DISTINCT FROM
      (p_order_draft_snapshot#>>'{totals,totalGross,amountMinor}')::bigint THEN
    RAISE EXCEPTION 'commerce_order_draft_money_equation_mismatch' USING ERRCODE = '22023';
  END IF;
  IF v_total <= 0 THEN
    RAISE EXCEPTION 'commerce_zero_payable_order_unsupported' USING ERRCODE = '22023';
  END IF;

  v_response := public.commerce_create_order_draft_with_outbox(
    p_idempotency_key, p_quote_snapshot, p_order_draft_snapshot, p_client_id
  );
  IF (v_response#>>'{orderDraft,replayed}')::boolean THEN RETURN v_response; END IF;
  v_order_id := replace(v_response#>>'{orderDraft,orderId}', 'order_', '')::uuid;
  v_allocation_fingerprint := encode(sha256(convert_to(
    p_order_draft_snapshot::text || '|effective-line-allocation.v1', 'UTF8'
  )), 'hex');

  IF v_order_discount > 0 THEN
    DELETE FROM public.commerce_order_items WHERE order_id = v_order_id;
    WITH source_lines AS (
      SELECT
        line.ordinality::integer AS source_ordinal,
        line.value->>'sku' AS sku,
        (line.value->>'quantity')::integer AS quantity,
        (line.value#>>'{unitPriceGross,amountMinor}')::bigint AS catalog_unit,
        (line.value#>>'{lineSubtotalGross,amountMinor}')::bigint AS catalog_line
      FROM jsonb_array_elements(p_order_draft_snapshot->'lines')
        WITH ORDINALITY AS line(value, ordinality)
    ), bases AS (
      SELECT source.*,
        floor((v_lines - v_order_discount)::numeric * source.catalog_line / v_lines)::bigint AS effective_base,
        ((v_lines - v_order_discount)::numeric * source.catalog_line / v_lines)
          - floor((v_lines - v_order_discount)::numeric * source.catalog_line / v_lines) AS fraction
      FROM source_lines AS source
    ), remainder AS (
      SELECT v_lines - v_order_discount - sum(effective_base) AS cents FROM bases
    ), allocated_lines AS (
      SELECT base.*,
        base.effective_base + CASE WHEN row_number() OVER (
          ORDER BY base.fraction DESC, base.source_ordinal
        ) <= remainder.cents THEN 1 ELSE 0 END AS effective_line
      FROM bases AS base CROSS JOIN remainder
    ), split_lines AS (
      SELECT allocated.*,
        allocated.quantity - (allocated.effective_line % allocated.quantity)::integer AS split_quantity,
        allocated.effective_line / allocated.quantity AS effective_unit
      FROM allocated_lines AS allocated
      UNION ALL
      SELECT allocated.*,
        (allocated.effective_line % allocated.quantity)::integer,
        allocated.effective_line / allocated.quantity + 1
      FROM allocated_lines AS allocated
      WHERE allocated.effective_line % allocated.quantity > 0
    ), prepared AS (
      SELECT split.*, sku_row.id AS sku_id,
        row_number() OVER (
          ORDER BY split.source_ordinal, split.effective_unit, split.split_quantity
        )::integer AS final_ordinal
      FROM split_lines AS split
      JOIN public.catalog_skus AS sku_row ON sku_row.sku = split.sku
      WHERE split.split_quantity > 0
    )
    INSERT INTO public.commerce_order_items (
      order_id, sku_id, line_ordinal, quantity, unit_amount_minor, line_amount_minor,
      source_line_ordinal, catalog_unit_amount_minor, catalog_line_amount_minor,
      promotion_discount_allocated_minor, promotion_allocation_fingerprint
    )
    SELECT
      v_order_id, prepared.sku_id, prepared.final_ordinal,
      prepared.split_quantity, prepared.effective_unit,
      prepared.effective_unit * prepared.split_quantity,
      prepared.source_ordinal, prepared.catalog_unit,
      prepared.catalog_unit * prepared.split_quantity,
      (prepared.catalog_unit - prepared.effective_unit) * prepared.split_quantity,
      v_allocation_fingerprint
    FROM prepared ORDER BY prepared.final_ordinal;
  END IF;

  IF v_shipping > 0 THEN
    INSERT INTO public.commerce_order_adjustments (
      order_id, kind, scope, amount_minor
    ) VALUES (v_order_id, 'shipping_charge', 'shipping', v_shipping);
  END IF;

  FOR v_discount IN
    SELECT value FROM jsonb_array_elements(COALESCE(p_order_draft_snapshot->'discounts', '[]'::jsonb))
    WHERE value ? 'promotionId' AND COALESCE((value->>'amountOffMinor')::bigint, 0) > 0
    ORDER BY value->>'promotionId'
  LOOP
    SELECT * INTO v_definition
    FROM public.commerce_promotion_lock_definition(v_discount->>'promotionId');
    IF v_definition.promotion_id IS NULL OR NOT v_definition.active OR v_definition.definition->>'status' <> 'active' THEN
      RAISE EXCEPTION 'commerce_promotion_definition_not_active' USING ERRCODE = '40001';
    END IF;
    v_global_limit := NULLIF(v_definition.definition->>'redemption_limit_global', '')::integer;
    v_customer_limit := NULLIF(v_definition.definition->>'redemption_limit_per_customer', '')::integer;
    SELECT count(*) FILTER (WHERE status IN ('reserved', 'redeemed')),
      count(*) FILTER (WHERE status IN ('reserved', 'redeemed') AND client_id = p_client_id)
    INTO v_global, v_customer FROM public.commerce_promotion_claims
    WHERE promotion_id = v_definition.promotion_id;
    IF v_global_limit IS NOT NULL AND v_global >= v_global_limit THEN
      RAISE EXCEPTION 'commerce_promotion_global_limit_reached' USING ERRCODE = '40001';
    END IF;
    IF v_customer_limit IS NOT NULL AND p_client_id IS NULL THEN
      RAISE EXCEPTION 'commerce_promotion_client_required' USING ERRCODE = '22023';
    END IF;
    IF v_customer_limit IS NOT NULL AND v_customer >= v_customer_limit THEN
      RAISE EXCEPTION 'commerce_promotion_customer_limit_reached' USING ERRCODE = '40001';
    END IF;
    INSERT INTO public.commerce_order_adjustments (
      order_id, kind, scope, amount_minor, promotion_id, definition_fingerprint
    ) VALUES (
      v_order_id, 'promotion_discount', v_discount->>'appliesTo',
      (v_discount->>'amountOffMinor')::bigint,
      v_definition.promotion_id, v_definition.definition_fingerprint
    ) RETURNING * INTO v_adjustment;
    INSERT INTO public.commerce_promotion_claims (
      promotion_id, definition_fingerprint, adjustment_id,
      order_id, client_id, amount_off_minor, expires_at
    ) VALUES (
      v_definition.promotion_id, v_definition.definition_fingerprint, v_adjustment.id,
      v_order_id, p_client_id, v_adjustment.amount_minor,
      now() + make_interval(hours => public.promotion_claim_hold_hours_read())
    ) RETURNING * INTO v_claim;
    INSERT INTO public.commerce_promotion_claim_events (claim_id, event_key, transition)
    VALUES (v_claim.id, 'reserved:' || v_order_id::text, 'reserved');
  END LOOP;
  RETURN v_response;
END;
$$;

REVOKE ALL ON FUNCTION public.payment_method_expiry_warning_days_validate(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.payment_method_expiry_warning_days_read() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.promotion_claim_hold_hours_validate(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.promotion_claim_hold_hours_read() FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.payment_method_expiry_warning_days_validate(jsonb), public.payment_method_expiry_warning_days_read(), public.promotion_claim_hold_hours_validate(jsonb), public.promotion_claim_hold_hours_read() FROM anon;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.payment_method_expiry_warning_days_validate(jsonb), public.payment_method_expiry_warning_days_read(), public.promotion_claim_hold_hours_validate(jsonb), public.promotion_claim_hold_hours_read() FROM authenticated;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'GRANT EXECUTE ON FUNCTION public.payment_method_expiry_warning_days_validate(jsonb), public.payment_method_expiry_warning_days_read(), public.promotion_claim_hold_hours_validate(jsonb), public.promotion_claim_hold_hours_read() TO service_role;'; END IF; END; $$;
