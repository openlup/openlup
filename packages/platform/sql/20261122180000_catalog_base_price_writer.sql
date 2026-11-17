-- Native, unbound immediate gross base-price writer and read-only readiness.
-- Authenticated execution derives the verified session actor; direct table access
-- remains denied. Readiness only reads native evidence and never locks commerce.
-- The managed rail does not supply this feature.

CREATE TABLE public.catalog_price_setup_receipts (
  scope text NOT NULL CHECK (scope = 'catalog.price_setup.base'),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 240),
  request_fingerprint text NOT NULL CHECK (length(request_fingerprint)=64 AND translate(request_fingerprint,'0123456789abcdef','')=''),
  status text NOT NULL CHECK (status IN ('in_progress', 'completed')),
  metadata jsonb NOT NULL CHECK (jsonb_typeof(metadata) = 'object'),
  response_payload jsonb,
  PRIMARY KEY (scope, idempotency_key),
  CHECK ((status = 'completed') = (response_payload IS NOT NULL))
);
ALTER TABLE public.catalog_price_setup_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.catalog_price_setup_receipts FROM PUBLIC;

CREATE FUNCTION public.catalog_price_setup_require_human_admin() RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE actor uuid := auth.uid();
BEGIN
  IF actor IS NULL OR NOT public.platform_human_membership_is_administrator(actor)
    OR EXISTS (SELECT 1 FROM public.platform_control_operators WHERE principal_id = actor) THEN
    RAISE EXCEPTION 'catalog_price_setup_operator_required' USING ERRCODE = '42501';
  END IF;
  RETURN actor;
END;
$$;

CREATE FUNCTION public.commerce_offer_policy_v2_readiness() RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
    AS $_$
DECLARE
  v_now timestamptz := statement_timestamp();
  v_inputs jsonb;
  -- The settlement profile, read from its commerce_settings mirror. Nothing in
  -- this body precedes the first use of either value, so they join v_now as initialisers
  -- rather than as statements. Both readers raise 55000 instead of returning a default,
  -- which is what makes an unconfigured deployment refuse to answer this gate rather than
  -- answer it wrongly; the caller already reads a failed readiness call as not-ready.
  v_region_code text := public.catalog_price_setup_region_code();
  v_settlement_currency text := public.catalog_price_setup_settlement_currency();
  v_reasons text[] := ARRAY[]::text[];
  v_acquisition jsonb;
  v_first_legacy_count bigint := 0;
  v_first_pair_count bigint := 0;
  v_first_active_count bigint := 0;
  v_bundle_count bigint := 0;
  v_active_price_list_count bigint := 0;
  v_active_core_skus bigint := 0;
  v_price_mismatch_count bigint := 0;
  v_subscription_policy_count bigint := 0;
  v_subscription_policy_derives_band boolean := false;
  v_policy_history_count bigint := 0;
  v_policy_well_formed boolean := false;
  v_policy_discount_bps integer;
  v_policy_quantum integer;
  v_legacy_count bigint := 0;
  v_legacy_invalid_count bigint := 0;
  v_legacy_fingerprint text := md5('');
  v_legacy_cohort_fingerprint text := md5('');
  v_legacy_baseline_count integer;
  v_legacy_baseline_fingerprint text;
  v_legacy_baseline_matches boolean := false;
  v_watchdog_ready boolean := false;
  v_claim_sweep_ready boolean := false;
  v_automatic_v2_money_checked_count bigint := 0;
  v_automatic_v2_money_mismatch_count bigint := 0;
BEGIN
  v_inputs := public.catalog_price_setup_readiness_inputs();
  WITH canonical_legacy AS (
    SELECT legacy.*
    FROM public.catalog_price_setup_promotions() legacy
    WHERE legacy.promotion_engine_version = 'promotion-engine.v1'
      AND legacy.trigger_type = 'automatic'
      AND legacy.code IS NULL
      AND legacy.discount_type = 'percentage'
      AND legacy.discount_value = 44.404
      AND legacy.applies_to_kind = 'order_total'
      AND (legacy.applies_to_payload - 'acquisitionTerms') = '{"cart_mode":"subscription"}'::jsonb
      AND legacy.stacking_rule = 'exclusive'
      AND legacy.eligibility = '{"first_subscription_purchase":true}'::jsonb
      AND legacy.redemption_limit_per_customer = 1
      AND legacy.redemption_limit_global IS NULL
      AND legacy.status = 'active'
      AND v_region_code = ANY(legacy.region_availability)
      AND legacy.valid_from <= v_now
      AND (legacy.valid_to IS NULL OR legacy.valid_to > v_now)
  ), canonical_pair AS (
    SELECT legacy.id AS legacy_id, mirror.id AS mirror_id,
      mirror.status AS mirror_status,
      mirror.applies_to_payload = legacy.applies_to_payload
        AND mirror.stacking_rule = legacy.stacking_rule
        AND mirror.eligibility = legacy.eligibility
        AND mirror.valid_from IS NOT DISTINCT FROM legacy.valid_from
        AND mirror.valid_to IS NOT DISTINCT FROM legacy.valid_to
        AND mirror.redemption_limit_global IS NOT DISTINCT FROM legacy.redemption_limit_global
        AND mirror.redemption_limit_per_customer IS NOT DISTINCT FROM legacy.redemption_limit_per_customer
        AND mirror.region_availability IS NOT DISTINCT FROM legacy.region_availability
        AS shared_shape_matches
    FROM canonical_legacy legacy
    JOIN public.catalog_price_setup_promotions() mirror ON mirror.v2_mirror_of = legacy.id
      AND mirror.promotion_engine_version = 'promotion-engine.v2'
      AND mirror.trigger_type = 'automatic'
      AND mirror.code IS NULL
      AND mirror.discount_type = 'percentage'
      AND mirror.discount_value = 50
      AND mirror.applies_to_kind = 'order_total'
      AND mirror.benefit_lane = 'product'
      AND mirror.benefit_kind = 'target_percentage'
      AND mirror.benefit_value_bps = 5000
      AND mirror.benefit_value_minor IS NULL
  )
  SELECT (SELECT count(*) FROM canonical_legacy), count(*), count(*) FILTER (
    WHERE mirror_status = 'active' AND shared_shape_matches
  ) INTO v_first_legacy_count, v_first_pair_count, v_first_active_count
  FROM canonical_pair;

  BEGIN
    v_acquisition := public.catalog_price_setup_acquisition_terms(v_now);
  EXCEPTION WHEN SQLSTATE '22023' OR SQLSTATE '55000' THEN
    IF SQLERRM NOT IN ('acquisition_terms_invalid', 'acquisition_terms_ambiguous', 'acquisition_terms_not_effective') THEN RAISE; END IF;
    IF v_first_legacy_count = 1 AND v_first_pair_count = 1 AND v_first_active_count <> 1 THEN
      v_reasons := array_append(v_reasons, 'first_subscription_mirror_not_ready');
    ELSE
      v_reasons := array_append(v_reasons, 'first_subscription_pair_invalid');
    END IF;
  END;

  SELECT count(*) INTO v_bundle_count
  FROM public.catalog_price_setup_promotions() bundle
  WHERE bundle.promotion_engine_version = 'promotion-engine.v1'
    AND bundle.v2_mirror_of IS NULL
    AND bundle.trigger_type = 'automatic'
    AND bundle.code IS NULL
    AND bundle.discount_type = 'percentage'
    AND bundle.discount_value = 5
    AND bundle.applies_to_kind = 'order_total'
    AND bundle.applies_to_payload = '{"cart_mode":"one_time"}'::jsonb
    AND bundle.stacking_rule = 'stackable_with_any'
    AND bundle.eligibility = '{"min_cart_minor":12000}'::jsonb
    AND bundle.status = 'active'
    AND bundle.benefit_lane = 'product'
    AND bundle.benefit_kind = 'percentage'
    AND bundle.benefit_value_bps = 500
    AND bundle.redemption_limit_global IS NULL
    AND bundle.redemption_limit_per_customer IS NULL
    AND v_region_code = ANY(bundle.region_availability)
    AND bundle.valid_from <= v_now
    AND (bundle.valid_to IS NULL OR bundle.valid_to >= v_now);
  IF v_bundle_count <> 1 THEN
    v_reasons := array_append(v_reasons, 'bundle_5_policy_invalid');
  END IF;

  SELECT count(*) INTO v_active_price_list_count
  FROM public.price_lists
  WHERE region_code = v_region_code AND currency = v_settlement_currency AND status = 'active'
    AND valid_from <= v_now AND (valid_to IS NULL OR valid_to > v_now);

  SELECT count(*), COALESCE(bool_and(
      policy.rounding_rule = 'FLOOR_TO_QUANTUM'
      AND policy.digest = public.catalog_price_setup_policy_digest(
        policy.id, policy.revision_no, policy.price_list_id,
        policy.region_code, policy.currency, policy.channel,
        policy.effective_from, CASE WHEN policy.closed_from_open THEN NULL ELSE policy.effective_to END,
        policy.discount_bps, policy.rounding_quantum_minor, policy.rounding_rule)
      AND policy.rounding_quantum_minor > 0
      AND policy.discount_bps BETWEEN 0 AND 10000
    ), false), min(policy.discount_bps), min(policy.rounding_quantum_minor)
  INTO v_subscription_policy_count, v_policy_well_formed, v_policy_discount_bps, v_policy_quantum
  FROM public.subscription_price_policy_revisions policy
  WHERE policy.price_list_id = (
      SELECT id FROM public.price_lists
      WHERE region_code = v_region_code AND currency = v_settlement_currency AND status = 'active'
        AND valid_from <= v_now AND (valid_to IS NULL OR valid_to > v_now)
      ORDER BY created_at DESC, id DESC LIMIT 1)
    AND policy.region_code = v_region_code
    AND policy.currency = v_settlement_currency
    AND policy.channel = 'D2C'
    AND policy.effective_from <= v_now
    AND (policy.effective_to IS NULL OR policy.effective_to > v_now);

  -- The runtime price authority reads a stored subscription row only while the
  -- list has no D2C policy history at all; once it has, the price is derived
  -- from the one effective revision. Counting that history without a time
  -- filter makes the gate check the branch the runtime reads.
  SELECT count(*) INTO v_policy_history_count
  FROM public.subscription_price_policy_revisions policy
  WHERE policy.price_list_id = (
      SELECT id FROM public.price_lists
      WHERE region_code = v_region_code AND currency = v_settlement_currency AND status = 'active'
        AND valid_from <= v_now AND (valid_to IS NULL OR valid_to > v_now)
      ORDER BY created_at DESC, id DESC LIMIT 1)
    AND policy.region_code = v_region_code
    AND policy.currency = v_settlement_currency
    AND policy.channel = 'D2C';

  WITH active_list AS (
    SELECT id FROM public.price_lists
    WHERE region_code = v_region_code AND currency = v_settlement_currency AND status = 'active'
      AND valid_from <= v_now AND (valid_to IS NULL OR valid_to > v_now)
    ORDER BY created_at DESC, id DESC LIMIT 1
  ), core_skus AS (
    SELECT sku.id
    FROM public.catalog_skus sku
    WHERE sku.status = 'active'
      AND sku.is_addon = false
      AND (sku.sellable_standalone OR sku.sellable_in_subscription)
  ), price_shape AS (
    SELECT sku.id,
      count(entry.id) FILTER (
        WHERE entry.mode = 'one_time' AND entry.min_qty = 1
      ) AS base_entries,
      count(entry.id) FILTER (
        WHERE entry.mode = 'one_time' AND entry.min_qty = 1
          AND entry.amount_kind = 'gross'
          AND entry.unit_price_minor > 0
      ) AS base_valid,
      min(entry.unit_price_minor) FILTER (
        WHERE entry.mode = 'one_time' AND entry.min_qty = 1
      ) AS base_minor,
      count(entry.id) FILTER (WHERE entry.mode = 'subscription') AS subscription_entries,
      count(entry.id) FILTER (
        WHERE entry.mode = 'subscription' AND entry.min_qty = 1
          AND entry.amount_kind = 'gross'
          AND entry.unit_price_minor > 0
      ) AS subscription_valid,
      count(entry.id) FILTER (
        WHERE entry.mode = 'any'
          OR entry.amount_kind <> 'gross'
          OR entry.min_qty <> 1
      ) AS overriding_or_drifted_entries
    FROM core_skus sku
    CROSS JOIN active_list list
    LEFT JOIN public.price_entries entry
      ON entry.price_list_id = list.id
     AND entry.variant_id = sku.id
     AND entry.active = true
     AND entry.valid_from <= v_now
     AND (entry.valid_to IS NULL OR entry.valid_to > v_now)
     AND entry.mode IN ('one_time', 'subscription', 'any')
    GROUP BY sku.id
  ), derived_shape AS (
    -- The subscription unit the runtime derives from the base: integer floor to
    -- the revision's quantum. NULL while no revision is effective.
    SELECT price_shape.*,
      ((price_shape.base_minor::bigint * (10000 - v_policy_discount_bps)) / 10000 / v_policy_quantum)
        * v_policy_quantum AS derived_minor
    FROM price_shape
  )
  SELECT count(*), count(*) FILTER (
    WHERE NOT COALESCE(
      base_entries = 1
      AND base_valid = 1
      AND overriding_or_drifted_entries = 0
      AND (
        (v_policy_history_count = 0
          AND subscription_entries = 1
          AND subscription_valid = 1)
        OR (v_policy_history_count > 0
          AND v_subscription_policy_count = 1
          AND v_policy_well_formed
          AND subscription_entries = 0
          AND derived_minor > 0)
      ), false)
  ), v_subscription_policy_count = 1 AND v_policy_well_formed
    AND COALESCE(bool_and(derived_minor > 0) FILTER (WHERE base_valid = 1), true)
  INTO v_active_core_skus, v_price_mismatch_count, v_subscription_policy_derives_band
  FROM derived_shape;

  IF v_active_price_list_count <> 1 OR v_active_core_skus = 0 OR v_price_mismatch_count <> 0 THEN
    v_reasons := array_append(v_reasons, 'catalog_1490_legacy_1340_invalid');
  END IF;

  -- Native governing retained purchase/edit terms are validated by the inputs
  -- owner; membership is independently checked against the audited baseline.
  v_legacy_count := (v_inputs#>>'{cohort,count}')::bigint;
  v_legacy_fingerprint := v_inputs#>>'{agreements,fingerprint}';
  v_legacy_cohort_fingerprint := v_inputs#>>'{cohort,fingerprint}';
  SELECT count(*) INTO v_legacy_invalid_count
  FROM public.subscriptions s
  WHERE s.offer_policy_assignment_state = 'legacy_frozen' AND s.is_test_fixture = false
    AND (s.currency_code IS DISTINCT FROM v_settlement_currency
      OR s.offer_policy_version <> 'commerce.offer-policy.v1'
      OR s.promotion_engine_version <> 'promotion-engine.v1'
      OR EXISTS (SELECT 1 FROM public.subscription_lines l
        WHERE l.subscription_id = s.id AND l.unit_price_minor <= 0));
  -- Audited never-populated zero is the documented installation delta.
  IF v_legacy_invalid_count <> 0 THEN
    v_reasons := array_append(v_reasons, 'legacy_frozen_records_invalid');
  END IF;
  SELECT expected_count, expected_fingerprint
  INTO v_legacy_baseline_count, v_legacy_baseline_fingerprint
  FROM public.commerce_offer_policy_rollout_baselines
  WHERE baseline_key = 'legacy_frozen.v1'; -- gitleaks:allow -- public schema sentinel
  v_legacy_baseline_matches := COALESCE(v_legacy_count = v_legacy_baseline_count
    AND v_legacy_cohort_fingerprint = v_legacy_baseline_fingerprint, false);
  IF NOT v_legacy_baseline_matches THEN
    RAISE EXCEPTION 'catalog_price_setup_native_cohort_unverified' USING ERRCODE = '55000';
  END IF;

  -- The scheduled watchdog owns the expensive full-history promotion/claim
  -- reconciliation. Request-path readiness consumes only its small persisted
  -- heartbeat, and requires the observer + claim-sweep posture to have been
  -- green recently. This prevents a cold request from running an unbounded
  -- health scan while retaining fail-closed operational evidence.
  SELECT COALESCE(
    control.enabled
      AND control.last_status = 'success'
      AND control.last_success_at >= v_now - interval '6 hours'
      AND control.last_success_at <= v_now
      AND control.metadata->>'promotionReady' = 'true',
    false
  ) INTO v_watchdog_ready
  FROM public.platform_job_controls control
  WHERE control.job_name = 'platform-watchdog';
  v_watchdog_ready := COALESCE(v_watchdog_ready, false);

  SELECT COALESCE(
    control.enabled
      AND control.last_status = 'success'
      AND control.last_success_at >= v_now - interval '15 minutes'
      AND control.last_success_at <= v_now,
    false
  ) INTO v_claim_sweep_ready
  FROM public.platform_job_controls control
  WHERE control.job_name = 'promotion-claim-sweep';
  v_claim_sweep_ready := COALESCE(v_claim_sweep_ready, false);

  IF NOT v_watchdog_ready THEN
    v_reasons := array_append(v_reasons, 'promotion_watchdog_not_ready');
  END IF;
  IF NOT v_claim_sweep_ready THEN
    v_reasons := array_append(v_reasons, 'promotion_claim_sweep_not_ready');
  END IF;

  -- The code-health RPC intentionally owns only explicit code-v2 evidence.
  -- Independently reconcile the frozen quote/header of recent orders assigned
  -- to automatic offer-policy v2 so an acquisition money drift closes
  -- new assignment too. The 24-hour created_at window keeps the runtime probe
  -- bounded; Canonical Order Money remains the write-time invariant.
  WITH automatic_v2_orders AS (
    SELECT orders.id, orders.currency_code AS currency,
      (money.value->>'subtotal')::bigint AS subtotal_cents,
      (money.value->>'discount')::bigint AS discount_cents,
      (money.value->>'shipping')::bigint AS shipping_cents,
      (money.value->>'shippingDiscount')::bigint AS shipping_discount_cents,
      orders.total_amount_minor AS total_cents,
      orders.metadata#>'{quoteSnapshot,quote}' AS quote
    FROM public.commerce_orders orders
    CROSS JOIN LATERAL (SELECT public.catalog_price_setup_order_inputs(orders.id) AS value) money
    WHERE orders.created_at >= v_now - interval '24 hours'
      AND orders.created_at <= v_now
      AND orders.status IN ('paid', 'fulfillment_pending', 'fulfilled', 'refunded')
      AND orders.metadata#>>'{quoteSnapshot,quote,context,pricingPolicy,promotionEngineVersion}'
        = 'promotion-engine.v2'
  ), extracted AS (
    SELECT automatic_v2_orders.*,
      CASE WHEN COALESCE(quote#>>'{subtotalGross,amountMinor}', '') ~ '^[0-9]{1,16}$'
        THEN (quote#>>'{subtotalGross,amountMinor}')::bigint END AS quote_subtotal,
      CASE WHEN COALESCE(quote#>>'{discountTotalGross,amountMinor}', '') ~ '^[0-9]{1,16}$'
        THEN (quote#>>'{discountTotalGross,amountMinor}')::bigint END AS quote_discount,
      CASE WHEN COALESCE(quote#>>'{shippingGross,amountMinor}', '0') ~ '^[0-9]{1,16}$'
        THEN COALESCE(quote#>>'{shippingGross,amountMinor}', '0')::bigint END AS quote_shipping,
      CASE WHEN COALESCE(quote#>>'{shippingDiscountGross,amountMinor}', '0') ~ '^[0-9]{1,16}$'
        THEN COALESCE(quote#>>'{shippingDiscountGross,amountMinor}', '0')::bigint END
        AS quote_shipping_discount,
      CASE WHEN COALESCE(quote#>>'{totalGross,amountMinor}', '') ~ '^[0-9]{1,16}$'
        THEN (quote#>>'{totalGross,amountMinor}')::bigint END AS quote_total
    FROM automatic_v2_orders
  )
  SELECT count(*), count(*) FILTER (WHERE
    jsonb_typeof(quote) IS DISTINCT FROM 'object'
    OR currency IS DISTINCT FROM v_settlement_currency
    OR quote#>>'{subtotalGross,currency}' IS DISTINCT FROM v_settlement_currency
    OR quote#>>'{discountTotalGross,currency}' IS DISTINCT FROM v_settlement_currency
    OR (quote ? 'shippingGross' AND quote#>>'{shippingGross,currency}' IS DISTINCT FROM v_settlement_currency)
    OR (quote ? 'shippingDiscountGross'
      AND quote#>>'{shippingDiscountGross,currency}' IS DISTINCT FROM v_settlement_currency)
    OR quote#>>'{totalGross,currency}' IS DISTINCT FROM v_settlement_currency
    OR quote_subtotal IS DISTINCT FROM subtotal_cents::bigint
    OR quote_discount IS DISTINCT FROM discount_cents::bigint
    OR quote_shipping IS DISTINCT FROM shipping_cents::bigint
    OR quote_shipping_discount IS DISTINCT FROM shipping_discount_cents::bigint
    OR quote_total IS DISTINCT FROM total_cents::bigint
  ) INTO v_automatic_v2_money_checked_count, v_automatic_v2_money_mismatch_count
  FROM extracted;

  IF v_automatic_v2_money_mismatch_count <> 0 THEN
    v_reasons := array_append(v_reasons, 'automatic_v2_money_invalid');
  END IF;

  RETURN jsonb_build_object(
    'contractVersion', 'commerce-offer-policy-v2-readiness.v1',
    'ready', cardinality(v_reasons) = 0,
    'checkedAt', v_now,
    'reasons', to_jsonb(v_reasons),
    'evidence', jsonb_build_object(
      'acquisition', CASE WHEN v_acquisition IS NULL THEN NULL ELSE
        (v_acquisition - ARRAY['schemaVersion','sourcePromotionId']) ||
        jsonb_build_object('contractVersion', 'commerce-acquisition-readiness.v1') END,
      'firstSubscriptionPairCount', v_first_pair_count,
      'firstSubscriptionLegacyCount', v_first_legacy_count,
      'firstSubscriptionActiveCount', v_first_active_count,
      'bundlePolicyCount', v_bundle_count,
      'activePriceListCount', v_active_price_list_count,
      'activeCoreSkuCount', v_active_core_skus,
      'priceMismatchCount', v_price_mismatch_count,
      'subscriptionPricePolicyCount', v_subscription_policy_count,
      'subscriptionPricePolicyDerivesBand', v_subscription_policy_derives_band,
      'legacyFrozenCount', v_legacy_count,
      'legacyFrozenInvalidCount', v_legacy_invalid_count,
      'legacyFrozenFingerprint', v_legacy_fingerprint,
      'legacyFrozenBaselineCount', v_legacy_baseline_count,
      'legacyFrozenBaselineMatches', v_legacy_baseline_matches,
      'promotionWatchdogReady', v_watchdog_ready,
      'promotionClaimSweepReady', v_claim_sweep_ready,
      'automaticV2MoneyCheckedCount', v_automatic_v2_money_checked_count,
      'automaticV2MoneyMismatchCount', v_automatic_v2_money_mismatch_count
    )
  );
END;
$_$;

CREATE FUNCTION public.catalog_price_setup_preview(
  p_variant_id uuid, p_price_list_id uuid, p_unit_price_minor integer DEFAULT NULL) RETURNS jsonb
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
    AS $$
DECLARE
  v_now timestamptz := statement_timestamp();
  v_sku public.catalog_skus%ROWTYPE;
  v_list public.price_lists%ROWTYPE;
  v_gate_list_id uuid;
  v_current public.price_entries%ROWTYPE;
  v_current_count integer;
  v_pending_count integer;
  v_history_count integer;
  v_policy_count integer;
  v_policy public.subscription_price_policy_revisions%ROWTYPE;
  v_stored_count integer;
  v_stored_minor integer;
  v_subscription jsonb;
  v_readiness jsonb;
  v_proposed jsonb;
  v_result jsonb;
BEGIN
  PERFORM public.catalog_price_setup_require_human_admin();
  IF p_unit_price_minor IS NOT NULL AND p_unit_price_minor < 1 THEN
    RETURN jsonb_build_object('outcome', 'validation_issue', 'reason', 'unit_price_invalid');
  END IF;
  SELECT * INTO v_sku FROM public.catalog_skus WHERE id = p_variant_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'validation_issue', 'reason', 'sku_not_found');
  END IF;
  SELECT * INTO v_list FROM public.price_lists WHERE id = p_price_list_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'validation_issue', 'reason', 'price_list_not_found');
  END IF;

  -- The list the readiness gate reads.
  SELECT id INTO v_gate_list_id FROM public.price_lists
  WHERE region_code = public.catalog_price_setup_region_code()
    AND currency = public.catalog_price_setup_settlement_currency() AND status = 'active'
    AND valid_from <= v_now AND (valid_to IS NULL OR valid_to > v_now)
  ORDER BY created_at DESC, id DESC LIMIT 1;

  -- The SKU's open one-time rows at minimum quantity one on this list: effective
  -- ones, and ones starting now or later, which apply refuses to overtake.
  SELECT count(*) FILTER (WHERE entry.valid_from <= v_now),
    count(*) FILTER (WHERE entry.valid_from >= v_now)
  INTO v_current_count, v_pending_count
  FROM public.price_entries entry
  WHERE entry.price_list_id = v_list.id AND entry.variant_id = v_sku.id
    AND entry.mode = 'one_time' AND entry.min_qty = 1 AND entry.active = true
    AND (entry.valid_to IS NULL OR entry.valid_to > v_now);
  IF v_current_count = 1 THEN
    SELECT * INTO v_current FROM public.price_entries entry
    WHERE entry.price_list_id = v_list.id AND entry.variant_id = v_sku.id
      AND entry.mode = 'one_time' AND entry.min_qty = 1 AND entry.active = true
      AND entry.valid_from <= v_now AND (entry.valid_to IS NULL OR entry.valid_to > v_now);
  END IF;

  -- The subscription price as the runtime authority resolves it on this list:
  -- derived once the list has D2C policy history, stored as its own row before.
  SELECT count(*), count(*) FILTER (WHERE policy.effective_from <= v_now
      AND (policy.effective_to IS NULL OR policy.effective_to > v_now))
  INTO v_history_count, v_policy_count
  FROM public.subscription_price_policy_revisions policy
  WHERE policy.price_list_id = v_list.id AND policy.region_code = v_list.region_code
    AND policy.currency = v_list.currency AND policy.channel = 'D2C';
  IF v_history_count > 0 AND v_policy_count = 1 THEN
    SELECT * INTO v_policy FROM public.subscription_price_policy_revisions policy
    WHERE policy.price_list_id = v_list.id AND policy.region_code = v_list.region_code
      AND policy.currency = v_list.currency AND policy.channel = 'D2C'
      AND policy.effective_from <= v_now
      AND (policy.effective_to IS NULL OR policy.effective_to > v_now);
    v_subscription := jsonb_build_object('kind', 'derived', 'revisionId', v_policy.id,
      'discountBps', v_policy.discount_bps,
      'roundingQuantumMinor', v_policy.rounding_quantum_minor,
      'derivedUnitPriceMinor',
        ((v_current.unit_price_minor::bigint * (10000 - v_policy.discount_bps)) / 10000
          / v_policy.rounding_quantum_minor) * v_policy.rounding_quantum_minor);
  ELSIF v_history_count > 0 THEN
    v_subscription := jsonb_build_object('kind', 'unresolved', 'reason',
      CASE WHEN v_policy_count = 0 THEN 'subscription_policy_not_effective'
        ELSE 'subscription_policy_ambiguous' END);
  ELSE
    SELECT count(*), min(entry.unit_price_minor) INTO v_stored_count, v_stored_minor
    FROM public.price_entries entry
    WHERE entry.price_list_id = v_list.id AND entry.variant_id = v_sku.id
      AND entry.mode = 'subscription' AND entry.min_qty = 1 AND entry.active = true
      AND entry.valid_from <= v_now AND (entry.valid_to IS NULL OR entry.valid_to > v_now);
    v_subscription := CASE WHEN v_stored_count = 1
      THEN jsonb_build_object('kind', 'stored', 'unitPriceMinor', v_stored_minor)
      ELSE jsonb_build_object('kind', 'unresolved', 'reason',
        CASE WHEN v_stored_count = 0 THEN 'subscription_price_not_found'
          ELSE 'subscription_price_ambiguous' END)
    END;
  END IF;

  v_readiness := public.commerce_offer_policy_v2_readiness();

  IF p_unit_price_minor IS NOT NULL THEN
    -- Refuse what apply would refuse for this target and state.
    IF v_sku.status = 'archived' THEN
      RETURN jsonb_build_object('outcome', 'validation_issue', 'reason', 'sku_archived');
    ELSIF v_list.status <> 'active' OR v_list.region_code <> public.catalog_price_setup_region_code()
      OR v_list.currency <> public.catalog_price_setup_settlement_currency()
      OR v_list.valid_from > v_now OR (v_list.valid_to IS NOT NULL AND v_list.valid_to <= v_now) THEN
      RETURN jsonb_build_object('outcome', 'validation_issue', 'reason', 'price_list_not_active');
    ELSIF v_current_count > 1 THEN
      RETURN jsonb_build_object('outcome', 'validation_issue', 'reason', 'base_price_ambiguous');
    ELSIF v_pending_count > 0 THEN
      RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'expected_state_mismatch');
    END IF;
    -- Perform apply's write, read the gate, then roll the write back.
    BEGIN
      UPDATE public.price_entries SET active = false, valid_to = v_now, updated_at = v_now
      WHERE id = v_current.id;
      INSERT INTO public.price_entries (price_list_id, variant_id, mode, min_qty,
        unit_price_minor, amount_kind, active, valid_from)
      VALUES (v_list.id, v_sku.id, 'one_time', 1, p_unit_price_minor, 'gross', true, v_now);
      v_proposed := public.commerce_offer_policy_v2_readiness();
      RAISE EXCEPTION 'catalog_price_setup_preview_rolled_back';
    EXCEPTION WHEN raise_exception THEN
      IF SQLERRM <> 'catalog_price_setup_preview_rolled_back' THEN
        RAISE;
      END IF;
    END;
  END IF;

  v_result := jsonb_build_object(
    'outcome', 'preview',
    'variantId', v_sku.id,
    'priceListId', v_list.id,
    'inGate', v_sku.status = 'active' AND v_sku.is_addon = false
      AND (v_sku.sellable_standalone OR v_sku.sellable_in_subscription)
      AND v_list.id IS NOT DISTINCT FROM v_gate_list_id,
    'current', CASE WHEN v_current.id IS NULL THEN NULL ELSE jsonb_build_object(
      'entryId', v_current.id, 'unitPriceMinor', v_current.unit_price_minor,
      'validFrom', v_current.valid_from) END,
    'currentCount', v_current_count,
    'subscription', v_subscription,
    'readiness', jsonb_build_object(
      'ready', v_readiness->'ready', 'reasons', v_readiness->'reasons'));
  IF p_unit_price_minor IS NOT NULL THEN
    v_result := v_result || jsonb_build_object('proposed', jsonb_build_object(
      'unitPriceMinor', p_unit_price_minor,
      'readiness', jsonb_build_object(
        'ready', v_proposed->'ready', 'reasons', v_proposed->'reasons')));
  END IF;
  RETURN v_result;
END;
$$;

CREATE FUNCTION public.catalog_price_setup_apply(p_canonical_command text, p_fingerprint text) RETURNS jsonb
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
    AS $$
DECLARE
  v_now timestamptz := statement_timestamp();
  v_actor uuid;
  v_command jsonb;
  v_expected jsonb;
  v_key text;
  v_variant_id uuid;
  v_list_id uuid;
  v_unit_price_minor integer;
  v_expected_entry_id uuid;
  v_expected_unit_price_minor integer;
  v_inserted integer;
  v_existing public.catalog_price_setup_receipts%ROWTYPE;
  v_sku public.catalog_skus%ROWTYPE;
  v_list public.price_lists%ROWTYPE;
  v_refusal text;
  v_current public.price_entries%ROWTYPE;
  v_current_count integer;
  v_pending_count integer;
  v_entry_id uuid;
  v_before jsonb;
  v_after jsonb;
  v_added jsonb;
  v_response jsonb;
BEGIN
  -- 1. The actor: an active human administrator's session.
  v_actor := public.catalog_price_setup_require_human_admin();

  -- 2. The fingerprint binds the exact command bytes.
  IF p_canonical_command IS NULL OR octet_length(p_canonical_command) NOT BETWEEN 2 AND 4096
    OR p_fingerprint IS NULL OR p_fingerprint !~ '^[0-9a-f]{64}$'
    OR encode(sha256(convert_to(p_canonical_command, 'UTF8')), 'hex') <> p_fingerprint THEN
    RETURN jsonb_build_object('outcome', 'validation_issue', 'reason', 'command_fingerprint_invalid');
  END IF;

  -- 3. The strict command: exactly these keys, one-time gross at minimum quantity
  -- one, a positive integer amount, and an expected state that is either wholly
  -- null (no base yet) or wholly set.
  BEGIN
    v_command := p_canonical_command::jsonb;
  EXCEPTION WHEN invalid_text_representation OR untranslatable_character THEN
    RETURN jsonb_build_object('outcome', 'validation_issue', 'reason', 'command_invalid');
  END;
  IF jsonb_typeof(v_command) IS DISTINCT FROM 'object'
    OR jsonb_typeof(v_command->'expected') IS DISTINCT FROM 'object' THEN
    RETURN jsonb_build_object('outcome', 'validation_issue', 'reason', 'command_invalid');
  END IF;
  v_expected := v_command->'expected';
  IF EXISTS (SELECT FROM jsonb_object_keys(v_command) command_key WHERE command_key NOT IN (
      'schemaVersion', 'commandKey', 'variantId', 'priceListId', 'mode', 'minQty',
      'amountKind', 'unitPriceMinor', 'expected'))
    OR EXISTS (SELECT FROM jsonb_object_keys(v_expected) expected_key
      WHERE expected_key NOT IN ('entryId', 'unitPriceMinor'))
    OR v_command->'schemaVersion' IS DISTINCT FROM '1'::jsonb
    OR jsonb_typeof(v_command->'commandKey') IS DISTINCT FROM 'string'
    OR length(v_command->>'commandKey') NOT BETWEEN 1 AND 240
    OR btrim(v_command->>'commandKey') <> v_command->>'commandKey'
    OR jsonb_typeof(v_command->'variantId') IS DISTINCT FROM 'string'
    OR v_command->>'variantId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR jsonb_typeof(v_command->'priceListId') IS DISTINCT FROM 'string'
    OR v_command->>'priceListId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR v_command->'mode' IS DISTINCT FROM '"one_time"'::jsonb
    OR v_command->'minQty' IS DISTINCT FROM '1'::jsonb
    OR v_command->'amountKind' IS DISTINCT FROM '"gross"'::jsonb
    OR jsonb_typeof(v_command->'unitPriceMinor') IS DISTINCT FROM 'number'
    OR v_command->>'unitPriceMinor' !~ '^[1-9][0-9]{0,9}$'
    OR NOT (v_expected ? 'entryId' AND v_expected ? 'unitPriceMinor')
    OR NOT (
      (jsonb_typeof(v_expected->'entryId') = 'null'
        AND jsonb_typeof(v_expected->'unitPriceMinor') = 'null')
      OR (jsonb_typeof(v_expected->'entryId') = 'string'
        AND v_expected->>'entryId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        AND jsonb_typeof(v_expected->'unitPriceMinor') = 'number'
        AND v_expected->>'unitPriceMinor' ~ '^(0|[1-9][0-9]{0,9})$')) THEN
    RETURN jsonb_build_object('outcome', 'validation_issue', 'reason', 'command_invalid');
  END IF;
  -- Both amounts matched a digit pattern above, so these casts cannot fail.
  IF (v_command->>'unitPriceMinor')::bigint > 2147483647
    OR (v_expected->>'unitPriceMinor')::bigint > 2147483647 THEN
    RETURN jsonb_build_object('outcome', 'validation_issue', 'reason', 'command_invalid');
  END IF;
  v_key := v_command->>'commandKey';
  v_variant_id := (v_command->>'variantId')::uuid;
  v_list_id := (v_command->>'priceListId')::uuid;
  v_unit_price_minor := (v_command->>'unitPriceMinor')::integer;
  v_expected_entry_id := (v_expected->>'entryId')::uuid;
  v_expected_unit_price_minor := (v_expected->>'unitPriceMinor')::integer;

  -- 4. The receipt, before the target is read, so that a completed command replays
  -- whatever has changed since. A refusal returned below removes this call's
  -- in-progress receipt; an exception rolls it back.
  INSERT INTO public.catalog_price_setup_receipts
    (scope, idempotency_key, request_fingerprint, status, metadata)
  VALUES ('catalog.price_setup.base', v_key, p_fingerprint, 'in_progress',
    jsonb_build_object('actorId', v_actor, 'variantId', v_variant_id, 'priceListId', v_list_id))
  ON CONFLICT (scope, idempotency_key) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted = 0 THEN
    SELECT * INTO v_existing FROM public.catalog_price_setup_receipts
    WHERE scope = 'catalog.price_setup.base' AND idempotency_key = v_key FOR UPDATE;
    IF v_existing.request_fingerprint IS DISTINCT FROM p_fingerprint THEN
      RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'command_key_reused');
    ELSIF v_existing.status = 'completed' AND v_existing.response_payload IS NOT NULL THEN
      IF v_existing.metadata->>'actorId' IS DISTINCT FROM v_actor::text THEN
        RETURN jsonb_build_object('outcome', 'unauthorized', 'reason', 'operator_mismatch');
      END IF;
      RETURN v_existing.response_payload || jsonb_build_object('outcome', 'replayed');
    END IF;
    RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'command_in_progress');
  END IF;

  -- 5. The target: a SKU that is not archived, and the active list of the
  -- settlement region and currency.
  SELECT * INTO v_sku FROM public.catalog_skus WHERE id = v_variant_id;
  SELECT * INTO v_list FROM public.price_lists WHERE id = v_list_id;
  v_refusal := CASE
    WHEN v_sku.id IS NULL THEN 'sku_not_found'
    WHEN v_sku.status = 'archived' THEN 'sku_archived'
    WHEN v_list.id IS NULL THEN 'price_list_not_found'
    WHEN v_list.status <> 'active' OR v_list.region_code <> public.catalog_price_setup_region_code()
      OR v_list.currency <> public.catalog_price_setup_settlement_currency()
      OR v_list.valid_from > v_now OR (v_list.valid_to IS NOT NULL AND v_list.valid_to <= v_now)
      THEN 'price_list_not_active'
  END;

  IF v_refusal IS NULL THEN
    -- 6. One command at a time for this list and SKU, and a row lock against
    -- other writers of its open base rows.
    PERFORM pg_advisory_xact_lock(hashtextextended(
      'catalog-price-setup:' || v_list_id::text || ':' || v_variant_id::text, 0));
    PERFORM 1 FROM public.price_entries entry
    WHERE entry.price_list_id = v_list_id AND entry.variant_id = v_variant_id
      AND entry.mode = 'one_time' AND entry.min_qty = 1 AND entry.active = true
      AND (entry.valid_to IS NULL OR entry.valid_to > v_now)
    FOR NO KEY UPDATE;

    -- 7. The state: at most one effective base, and none starting now or later.
    SELECT count(*) FILTER (WHERE entry.valid_from <= v_now),
      count(*) FILTER (WHERE entry.valid_from >= v_now)
    INTO v_current_count, v_pending_count
    FROM public.price_entries entry
    WHERE entry.price_list_id = v_list_id AND entry.variant_id = v_variant_id
      AND entry.mode = 'one_time' AND entry.min_qty = 1 AND entry.active = true
      AND (entry.valid_to IS NULL OR entry.valid_to > v_now);
    IF v_current_count > 1 THEN
      v_refusal := 'base_price_ambiguous';
    END IF;
  END IF;

  IF v_refusal IS NOT NULL THEN
    DELETE FROM public.catalog_price_setup_receipts
    WHERE scope = 'catalog.price_setup.base' AND idempotency_key = v_key;
    RETURN jsonb_build_object('outcome', 'validation_issue', 'reason', v_refusal);
  END IF;

  SELECT * INTO v_current FROM public.price_entries entry
  WHERE entry.price_list_id = v_list_id AND entry.variant_id = v_variant_id
    AND entry.mode = 'one_time' AND entry.min_qty = 1 AND entry.active = true
    AND entry.valid_from <= v_now AND (entry.valid_to IS NULL OR entry.valid_to > v_now);
  IF v_pending_count > 0
    OR v_current.id IS DISTINCT FROM v_expected_entry_id
    OR v_current.unit_price_minor IS DISTINCT FROM v_expected_unit_price_minor THEN
    RAISE EXCEPTION 'catalog_price_setup_expected_state_mismatch' USING ERRCODE = '40001';
  END IF;

  -- 8. The readiness verdict before the write.
  v_before := public.commerce_offer_policy_v2_readiness();

  -- 9. Close the current base and insert its replacement at the same instant.
  IF v_current.id IS NOT NULL THEN
    UPDATE public.price_entries SET active = false, valid_to = v_now, updated_at = v_now
    WHERE id = v_current.id;
  END IF;
  INSERT INTO public.price_entries (price_list_id, variant_id, mode, min_qty,
    unit_price_minor, amount_kind, active, valid_from)
  VALUES (v_list_id, v_variant_id, 'one_time', 1, v_unit_price_minor, 'gross', true, v_now)
  RETURNING id INTO v_entry_id;

  -- 10. Refuse a change after which the gate reports a reason it did not report
  -- before. An unrelated reason that was already there neither blocks the change
  -- nor hides one the change adds.
  v_after := public.commerce_offer_policy_v2_readiness();
  SELECT COALESCE(jsonb_agg(reason.code ORDER BY reason.n), '[]'::jsonb) INTO v_added
  FROM jsonb_array_elements_text(v_after->'reasons') WITH ORDINALITY AS reason(code, n)
  WHERE NOT ((v_before->'reasons') ? reason.code);
  IF jsonb_array_length(v_added) > 0 THEN
    RAISE EXCEPTION 'catalog_price_setup_readiness_would_fail'
      USING ERRCODE = '55000', DETAIL = v_added::text;
  END IF;

  -- 11. Complete the receipt with the response a replay returns.
  v_response := jsonb_build_object('outcome', 'committed', 'receipt', jsonb_build_object(
    'commandKey', v_key, 'variantId', v_variant_id, 'priceListId', v_list_id,
    'actorId', v_actor,
    'previous', CASE WHEN v_current.id IS NULL THEN NULL ELSE jsonb_build_object(
      'entryId', v_current.id, 'unitPriceMinor', v_current.unit_price_minor,
      'validFrom', v_current.valid_from) END,
    'current', jsonb_build_object('entryId', v_entry_id,
      'unitPriceMinor', v_unit_price_minor, 'validFrom', v_now)));
  UPDATE public.catalog_price_setup_receipts
  SET status = 'completed', response_payload = v_response
  WHERE scope = 'catalog.price_setup.base' AND idempotency_key = v_key;
  RETURN v_response;
END;
$$;

REVOKE ALL ON FUNCTION public.catalog_price_setup_require_human_admin() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.commerce_offer_policy_v2_readiness() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.catalog_price_setup_preview(uuid,uuid,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.catalog_price_setup_apply(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.catalog_price_setup_preview(uuid,uuid,integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.catalog_price_setup_apply(text,text) TO authenticated;
