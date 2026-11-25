CREATE FUNCTION public.catalog_price_setup_frozen_order_money_matches(
  p_money jsonb, p_totals jsonb, p_currency text
) RETURNS boolean LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
  SELECT COALESCE(p_money->>'currency' = p_currency
    AND jsonb_typeof(p_totals) = 'object'
    AND NOT EXISTS (
      SELECT 1 FROM (VALUES ('subtotal', 'subtotalGross'), ('discount', 'discountTotalGross'),
        ('shipping', 'shippingGross'), ('shippingDiscount', 'shippingDiscountGross'), ('total', 'totalGross')
      ) AS component(canonical, frozen)
      WHERE (p_totals#>ARRAY[component.frozen,'amountMinor'], p_totals#>>ARRAY[component.frozen,'currency'])
        IS DISTINCT FROM (p_money->component.canonical, p_currency)
    ), false);
$$;

CREATE FUNCTION public.catalog_price_setup_order_protection_verified(
  p_order_id uuid, p_claims jsonb, p_truth jsonb, p_acquisition jsonb
) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  o record;
  receipt record;
  intent record;
  settlement record;
  capture record;
  snapshot jsonb;
  quote jsonb;
  draft jsonb;
  context jsonb;
  submit jsonb;
  shipping_terms jsonb;
  money jsonb;
  mode text;
  subtotal numeric;
  product_discount numeric;
  shipping_discount numeric;
  shipping bigint;
  allocation_fingerprint text;
BEGIN
  SELECT id, client_id, metadata, catalog_acceptance, catalog_receipt_key, subscription_cycle_id,
    renewal_operation_id, recreated_from_order_id, recovery_root_order_id, created_at, paid_at,
    status, currency_code, total_amount_minor
  INTO o FROM public.commerce_orders WHERE id = p_order_id;
  IF NOT FOUND OR NOT COALESCE(isfinite(o.paid_at), false) OR o.status NOT IN ('paid','fulfillment_pending','fulfilled')
    OR o.catalog_acceptance IS NOT NULL OR o.renewal_operation_id IS NOT NULL
    OR o.recreated_from_order_id IS NOT NULL OR o.recovery_root_order_id IS NOT NULL
    OR o.metadata ? 'renewalOperationId' THEN RETURN false; END IF;

  snapshot := o.metadata->'quoteSnapshot';
  quote := snapshot->'quote';
  draft := o.metadata->'orderDraftSnapshot';
  context := draft->'context';
  submit := o.metadata->'catalogAdmissionSubmit';
  mode := context->>'mode';
  IF snapshot->>'contractVersion' IS DISTINCT FROM 'commerce.v0'
    OR draft->>'contractVersion' IS DISTINCT FROM 'commerce.v0'
    OR draft->>'source' IS DISTINCT FROM 'commerce.order_draft.bff.v0'
    OR draft->>'status' IS DISTINCT FROM 'draft'
    OR draft->>'paymentStatus' IS DISTINCT FROM 'not_started'
    OR jsonb_typeof(context) IS DISTINCT FROM 'object' OR context IS DISTINCT FROM quote->'context'
    OR NOT COALESCE(mode IN ('one_time', 'subscription'), false)
    OR NOT COALESCE(context->'pricingPolicy' @> '{"offerPolicyVersion":"commerce.offer-policy.v1","promotionEngineVersion":"promotion-engine.v1"}'
      OR context->'pricingPolicy' @> '{"offerPolicyVersion":"commerce.offer-policy.v2","promotionEngineVersion":"promotion-engine.v2"}', false)
    OR context ? 'renewalOperationId'
    OR o.currency_code IS NULL OR quote->>'currency' IS DISTINCT FROM o.currency_code
    OR draft->>'currency' IS DISTINCT FROM o.currency_code
    OR jsonb_typeof(draft->'lines') IS DISTINCT FROM 'array' OR draft->'lines' IS DISTINCT FROM quote->'lines'
    OR jsonb_typeof(draft->'discounts') IS DISTINCT FROM 'array' OR draft->'discounts' IS DISTINCT FROM quote->'discounts'
    OR NOT COALESCE(o.total_amount_minor BETWEEN 1 AND 2147483647, false) THEN RETURN false; END IF;

  SELECT idempotency_key, request_fingerprint, response_payload, created_at, count(*) OVER() AS copies
  INTO receipt FROM public.commerce_order_draft_receipts
  WHERE order_id = o.id AND invalidated_at IS NULL LIMIT 1;
  IF NOT FOUND OR receipt.copies <> 1 OR receipt.created_at IS DISTINCT FROM o.created_at
    OR receipt.idempotency_key LIKE 'checkout-recovery-recreate:%'
    OR (o.catalog_receipt_key IS NOT NULL AND o.catalog_receipt_key <> receipt.idempotency_key)
    OR receipt.request_fingerprint IS DISTINCT FROM md5(snapshot::text || '|' || draft::text || '|' || COALESCE(o.client_id::text, ''))
    OR receipt.response_payload IS DISTINCT FROM jsonb_build_object('contractVersion','commerce.v0',
      'orderDraft',jsonb_build_object('orderId','order_' || o.id::text, 'status','draft', 'paymentStatus','not_started',
        'idempotencyKey',receipt.idempotency_key, 'quoteSnapshot',snapshot, 'replayed',false))
    OR NOT public.catalog_admission_submit_valid(submit, o.client_id, receipt.idempotency_key) THEN RETURN false; END IF;
  IF NOT (SELECT count(*) = 1 AND bool_and(e.idempotency_key IS NOT DISTINCT FROM receipt.idempotency_key
    AND e.created_at = o.created_at
    AND (e.metadata->>'boundary') IS NOT DISTINCT FROM 'commerce_create_order_draft_with_outbox')
    FROM public.outbox_events e
    WHERE e.aggregate_type = 'commerce_order' AND e.aggregate_id = o.id AND e.event_type = 'commerce.order_draft.created')
  THEN RETURN false; END IF;

  IF mode = 'one_time' THEN
    IF o.subscription_cycle_id IS NOT NULL OR submit->'acceptanceTokenDigest' IS DISTINCT FROM 'null'::jsonb
      OR context ?| ARRAY['acquisitionTerms','starterPack','starterRenewalTerms','renewalTerms'] THEN RETURN false; END IF;
  ELSE
    IF context#>>'{pricingPolicy,promotionEngineVersion}' IS DISTINCT FROM 'promotion-engine.v2'
      OR context->>'acquisitionCapability' IS DISTINCT FROM 'subscription-acquisition.v1'
      OR NOT COALESCE(submit->>'acceptanceTokenDigest' ~ '^[0-9a-f]{64}$', false)
      OR p_acquisition->>'kind' IS DISTINCT FROM 'v2_standalone'
      OR context->'acquisitionTerms' IS DISTINCT FROM
        (p_acquisition - ARRAY['kind','legacyPairCount','standaloneCount','nextBoundaryAt'])
    THEN RETURN false; END IF;
  END IF;

  BEGIN
    money := public.catalog_price_setup_order_inputs(o.id);
  EXCEPTION WHEN SQLSTATE '55000' THEN
    IF SQLERRM <> 'catalog_price_setup_native_order_domain_unverified' THEN RAISE; END IF;
    RETURN false;
  END;
  IF NOT public.catalog_price_setup_frozen_order_money_matches(money, draft->'totals', o.currency_code)
    OR NOT public.catalog_price_setup_frozen_order_money_matches(money, quote, o.currency_code)
    OR draft->'taxIncluded' IS DISTINCT FROM quote->'taxIncluded'
    OR draft#>'{totals,netTotal}' IS DISTINCT FROM quote->'netTotal'
    OR draft#>'{totals,taxTotal}' IS DISTINCT FROM quote->'taxTotal'
  THEN RETURN false; END IF;

  -- Validate JSON amounts before arithmetic or typed expansion.
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(draft->'lines') l(line)
    CROSS JOIN LATERAL (VALUES (line->'quantity', 1),
      (line#>'{unitPriceGross,amountMinor}', 0), (line#>'{lineSubtotalGross,amountMinor}', 0)
    ) AS field(value, minimum)
    WHERE NOT COALESCE(CASE WHEN jsonb_typeof(value) = 'number'
      THEN value::numeric BETWEEN minimum AND 2147483647 AND trunc(value::numeric) = value::numeric END, false)
      OR jsonb_typeof(line->'sku') IS DISTINCT FROM 'string' OR line->>'sku' = ''
      OR line#>>'{unitPriceGross,currency}' IS DISTINCT FROM o.currency_code
      OR line#>>'{lineSubtotalGross,currency}' IS DISTINCT FROM o.currency_code)
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(draft->'discounts') d(discount)
      WHERE jsonb_typeof(discount->'promotionId') IS DISTINCT FROM 'string' OR discount->>'promotionId' = ''
        OR NOT COALESCE(discount->>'appliesTo' IN ('order_total','shipping'), false)
        OR NOT COALESCE(CASE WHEN jsonb_typeof(discount->'amountOffMinor') = 'number'
          THEN (discount->'amountOffMinor')::numeric BETWEEN 1 AND 2147483647
            AND trunc((discount->'amountOffMinor')::numeric) = (discount->'amountOffMinor')::numeric END, false))
  THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(draft->'discounts') d
    GROUP BY d->>'promotionId' HAVING count(*) <> 1) THEN RETURN false; END IF;

  SELECT sum((line#>'{lineSubtotalGross,amountMinor}')::numeric) INTO subtotal
  FROM jsonb_array_elements(draft->'lines') l(line);
  SELECT COALESCE(sum((d->'amountOffMinor')::numeric) FILTER (WHERE d->>'appliesTo' = 'order_total'), 0),
    COALESCE(sum((d->'amountOffMinor')::numeric) FILTER (WHERE d->>'appliesTo' = 'shipping'), 0)
  INTO product_discount, shipping_discount FROM jsonb_array_elements(draft->'discounts') d;
  shipping := (money->>'shipping')::bigint;
  IF to_jsonb(subtotal) IS DISTINCT FROM money->'subtotal'
    OR to_jsonb(product_discount) IS DISTINCT FROM money->'discount'
    OR to_jsonb(shipping_discount) IS DISTINCT FROM money->'shippingDiscount'
    OR subtotal - product_discount + shipping - shipping_discount <> o.total_amount_minor
  THEN RETURN false; END IF;

  shipping_terms := context->'shippingTerms';
  IF shipping_terms IS NOT NULL THEN
    IF jsonb_typeof(shipping_terms) IS DISTINCT FROM 'object'
      OR shipping_terms - ARRAY['version','currency','flatMinor','freeThresholdMinor'] <> '{}'::jsonb
      OR shipping_terms->>'version' IS DISTINCT FROM 'shipping-threshold.v1'
      OR shipping_terms->>'currency' IS DISTINCT FROM o.currency_code
      OR EXISTS (SELECT 1 FROM (VALUES (shipping_terms->'flatMinor'), (shipping_terms->'freeThresholdMinor')) field(value)
        WHERE NOT COALESCE(CASE WHEN jsonb_typeof(value) = 'number'
          THEN value::numeric BETWEEN 0 AND 2147483647 AND trunc(value::numeric) = value::numeric END, false))
    THEN RETURN false; END IF;
    -- Shipping is computed after non-shipping discounts.
    IF shipping <> (CASE WHEN subtotal - product_discount >= (shipping_terms->'freeThresholdMinor')::numeric
      THEN 0 ELSE (shipping_terms->'flatMinor')::numeric END) THEN RETURN false; END IF;
  END IF;

  allocation_fingerprint := encode(sha256(convert_to(draft::text || '|effective-line-allocation.v1','UTF8')), 'hex');
  IF EXISTS (
    WITH expected AS (
      SELECT ordinal, line->>'sku' AS sku, (line->'quantity')::numeric AS quantity,
        (line#>'{unitPriceGross,amountMinor}')::numeric AS unit_price,
        (line#>'{lineSubtotalGross,amountMinor}')::numeric AS gross
      FROM jsonb_array_elements(draft->'lines') WITH ORDINALITY AS l(line, ordinal)
    ), stored AS (
      SELECT COALESCE(i.source_line_ordinal, i.line_ordinal) AS ordinal, sku.sku,
        sum(i.quantity) AS quantity, COALESCE(i.catalog_unit_amount_minor, i.unit_amount_minor) AS unit_price,
        sum(COALESCE(i.catalog_line_amount_minor, i.line_amount_minor)) AS gross,
        bool_and(CASE WHEN product_discount = 0 THEN
          (i.source_line_ordinal, i.catalog_unit_amount_minor, i.catalog_line_amount_minor,
            i.promotion_discount_allocated_minor, i.promotion_allocation_fingerprint) IS NULL
          ELSE i.promotion_allocation_fingerprint IS NOT DISTINCT FROM allocation_fingerprint END) AS allocation_valid
      FROM public.commerce_order_items i LEFT JOIN public.catalog_skus sku ON sku.id = i.sku_id
      WHERE i.order_id = o.id GROUP BY 1, 2, 4
    )
    SELECT 1 FROM expected e FULL JOIN stored s USING (ordinal, sku, unit_price)
    WHERE (e.quantity, e.gross) IS DISTINCT FROM (s.quantity, s.gross)
      OR e.gross <> e.unit_price * e.quantity OR s.allocation_valid IS DISTINCT FROM true
  ) THEN RETURN false; END IF;

  IF (SELECT count(*) FROM public.commerce_order_adjustments WHERE order_id = o.id)
      <> jsonb_array_length(draft->'discounts') + (CASE WHEN shipping > 0 THEN 1 ELSE 0 END)
    OR (shipping > 0 AND NOT EXISTS (SELECT 1 FROM public.commerce_order_adjustments
      WHERE order_id = o.id AND kind = 'shipping_charge' AND scope = 'shipping' AND amount_minor = shipping
        AND promotion_id IS NULL AND definition_fingerprint IS NULL))
    OR jsonb_array_length(p_claims) IS DISTINCT FROM jsonb_array_length(draft->'discounts')
  THEN RETURN false; END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(draft->'discounts') d
    LEFT JOIN public.commerce_order_adjustments a ON a.order_id = o.id AND a.kind = 'promotion_discount'
      AND a.promotion_id = d->>'promotionId' AND a.scope = d->>'appliesTo'
      AND a.amount_minor = (d->'amountOffMinor')::numeric AND a.definition_fingerprint ~ '^[0-9a-f]{64}$'
    LEFT JOIN jsonb_to_recordset(p_claims) c(adjustment_id uuid, order_id uuid, client_id uuid, promotion_id text,
      definition_fingerprint text, amount_off_minor bigint, status text, reserved_at timestamptz, redeemed_at timestamptz,
      released_at timestamptz, release_reason text, event_count bigint, reserved_count bigint, redeemed_count bigint)
      ON c.adjustment_id = a.id
    WHERE a.id IS NULL OR (c.order_id, c.client_id, c.promotion_id, c.definition_fingerprint, c.amount_off_minor,
      c.status, c.reserved_at, c.redeemed_at, c.event_count, c.reserved_count, c.redeemed_count)
      IS DISTINCT FROM (o.id, o.client_id, a.promotion_id, a.definition_fingerprint, a.amount_minor,
      'redeemed'::text, o.created_at, o.paid_at, 2::bigint, 1::bigint, 1::bigint)
      OR c.released_at IS NOT NULL OR c.release_reason IS NOT NULL
  ) THEN RETURN false; END IF;

  SELECT id, settled_at, amount_minor, currency_code INTO intent
  FROM public.commerce_settlement_intents WHERE order_id = o.id AND channel_key = 'sandbox' AND status = 'settled';
  IF NOT FOUND OR (intent.settled_at, intent.amount_minor, intent.currency_code)
    IS DISTINCT FROM (o.paid_at, o.total_amount_minor, o.currency_code) THEN RETURN false; END IF;
  SELECT id, idempotency_key, payload, occurred_at, count(*) OVER() AS copies INTO settlement
  FROM public.commerce_settlement_transitions WHERE intent_id = intent.id AND to_status = 'settled' AND outcome = 'succeeded'
  LIMIT 1;
  IF NOT FOUND OR settlement.copies <> 1 OR settlement.occurred_at IS DISTINCT FROM o.paid_at THEN RETURN false; END IF;

  SELECT a.id AS attempt_id, e.id AS observation_id, e.created_at INTO capture
  FROM public.payment_simulator_attempts a
  JOIN public.payment_simulator_observations e ON e.id = a.last_observation_id AND e.attempt_id = a.id
  WHERE a.settlement_intent_id = intent.id AND a.is_active AND a.state = 'captured'
    AND e.outcome = 'captured' AND e.occurred_at = o.paid_at
    AND settlement.idempotency_key = 'sandbox:ingest:' || e.id::text || ':settlement';
  IF NOT FOUND THEN RETURN false; END IF;

  -- Earlier indeterminate observations can share the terminal transition.
  -- The transition identifies the only primary capture.
  IF NOT (
    SELECT count(*) FILTER (WHERE t.id::text = settlement.payload->>'paymentTruthEventId') = 1
      AND bool_and(COALESCE(
        (t.settlement_intent_id, t.settlement_transition_id, t.state, t.outcome, t.amount_minor, t.currency_code, t.settled_at)
          = (intent.id, settlement.id, 'settled'::text, 'captured'::text, intent.amount_minor, intent.currency_code, intent.settled_at)
        AND t.review_required_at IS NULL
        AND t.source_event_id = 'sandbox:' || e.id::text
        AND t.ingest_idempotency_key = 'sandbox:ingest:' || e.id::text
        AND t.occurred_at = e.occurred_at
        AND t.source_evidence - 'observedAt' = jsonb_build_object('sourceKind','accepted_event', 'sourceReference',e.id,
          'observedStatus',e.outcome, 'payloadFingerprint',e.event_fingerprint, 'attemptRef',capture.attempt_id)
        AND CASE WHEN t.source_evidence->>'observedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$'
          AND pg_input_is_valid(t.source_evidence->>'observedAt', 'timestamptz')
          THEN (t.source_evidence->>'observedAt')::timestamptz = e.occurred_at END
        -- The truth rail hashes the normalized event, including the observation
        -- fingerprint. A co-settled row keeps the hash of its original outcome.
        AND t.event_fingerprint = encode(sha256(convert_to(format(
          '{"amountMinor":%s,"currency":%s,"evidence":{"attemptRef":%s,"observedAt":%s,"observedStatus":%s,"payloadFingerprint":%s,"sourceKind":"accepted_event","sourceReference":%s},"failure":null,"occurredAt":%s,"outcome":%s,"settlementIntentId":%s,"sourceEventId":%s}',
          t.amount_minor, to_json(t.currency_code), to_json(capture.attempt_id), t.source_evidence->'observedAt',
          to_json(e.outcome), to_json(e.event_fingerprint), to_json(e.id), t.source_evidence->'observedAt',
          to_json(e.outcome), to_json(intent.id), to_json(t.source_event_id)), 'UTF8')), 'hex')
        AND CASE WHEN t.id::text = settlement.payload->>'paymentTruthEventId' THEN
          e.id = capture.observation_id AND t.source_evidence = settlement.payload->'sourceEvidence'
        ELSE e.outcome = 'indeterminate' AND e.created_at <= capture.created_at
          AND e.occurred_at <= intent.settled_at END, false))
    FROM jsonb_to_recordset(p_truth) AS t(id uuid, source_event_id text, event_fingerprint text,
      ingest_idempotency_key text, settlement_intent_id uuid, settlement_transition_id uuid, state text, outcome text,
      amount_minor bigint, currency_code text, source_evidence jsonb, review_required_at timestamptz,
      occurred_at timestamptz, settled_at timestamptz)
    LEFT JOIN public.payment_simulator_observations e
      ON e.attempt_id = capture.attempt_id AND e.id = CASE
        WHEN pg_input_is_valid(t.source_evidence->>'sourceReference', 'uuid') THEN (t.source_evidence->>'sourceReference')::uuid END
    WHERE t.id::text = settlement.payload->>'paymentTruthEventId' OR t.outcome = 'captured'
      OR t.settlement_transition_id = settlement.id OR t.review_required_at IS NOT NULL
  ) THEN RETURN false; END IF;

  IF mode = 'subscription' THEN
    RETURN EXISTS (SELECT 1 FROM public.subscription_activations a
      JOIN public.subscription_cycles cycle ON cycle.id = o.subscription_cycle_id AND cycle.subscription_id = a.subscription_id
      WHERE a.order_id = o.id AND a.client_id = o.client_id AND a.state = 'active' AND a.activated_at = intent.settled_at)
      AND (SELECT count(*) = 1 FROM jsonb_to_recordset(p_claims) c(promotion_id text, definition_fingerprint text)
        JOIN public.commerce_promotion_definitions p USING (promotion_id, definition_fingerprint)
        WHERE p.promotion_id = p_acquisition->>'sourcePromotionId');
  END IF;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.catalog_price_setup_assert_order_guards(p_at timestamptz) RETURNS void
 LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  o record;
  acquisition jsonb;
BEGIN
  IF p_at IS NULL THEN RAISE EXCEPTION 'catalog_price_setup_native_order_admission_unverified' USING ERRCODE = '55000'; END IF;
  FOR o IN
    WITH candidates AS MATERIALIZED (
      SELECT id, metadata, created_at, status, paid_at, subscription_cycle_id, catalog_acceptance,
        renewal_operation_id, recreated_from_order_id, recovery_root_order_id
      FROM public.commerce_orders WHERE created_at >= p_at - interval '24 hours' AND created_at <= p_at
        AND status IN ('paid','fulfillment_pending','fulfilled','refunded')
    ), claim_rows AS (
      SELECT c.id, c.adjustment_id, c.order_id, c.client_id, c.promotion_id, c.definition_fingerprint, c.amount_off_minor,
        c.status, c.reserved_at, c.redeemed_at, c.released_at, c.release_reason, count(e.claim_id) AS event_count,
        count(*) FILTER (WHERE e.transition = 'reserved' AND e.event_key = 'reserved:' || candidate.id::text
          AND e.occurred_at = candidate.created_at) AS reserved_count,
        count(*) FILTER (WHERE e.transition = 'redeemed' AND e.event_key = 'redeemed:paid') AS redeemed_count
      FROM candidates candidate JOIN public.commerce_promotion_claims c ON c.order_id = candidate.id
      LEFT JOIN public.commerce_promotion_claim_events e ON e.claim_id = c.id
      GROUP BY c.id
    ), claims AS (
      SELECT order_id, jsonb_agg(to_jsonb(claim_rows)) AS data FROM claim_rows GROUP BY order_id
    ), truth_rows AS (
      SELECT i.order_id, t.id, t.source_event_id, t.event_fingerprint, t.ingest_idempotency_key,
        t.settlement_intent_id, t.settlement_transition_id, t.state, t.outcome, t.amount_minor, t.currency_code,
        t.source_evidence, t.review_required_at, t.occurred_at, t.settled_at
      FROM candidates candidate JOIN public.commerce_settlement_intents i ON i.order_id = candidate.id
      JOIN public.payment_truth_events t ON t.settlement_intent_id = i.id
      WHERE i.channel_key = 'sandbox' AND i.status = 'settled'
    ), truth AS (
      SELECT order_id, jsonb_agg(to_jsonb(truth_rows) - 'order_id') AS data FROM truth_rows GROUP BY order_id
    )
    SELECT candidate.*, COALESCE(claims.data,'[]'::jsonb) AS claims, COALESCE(truth.data,'[]'::jsonb) AS truth,
      candidate.metadata#>'{quoteSnapshot,quote,context}' AS context
    FROM candidates candidate LEFT JOIN claims ON claims.order_id = candidate.id LEFT JOIN truth ON truth.order_id = candidate.id
  LOOP
    PERFORM public.catalog_price_setup_order_policy_pair(o.metadata);
    acquisition := NULL;
    IF o.status <> 'refunded' AND isfinite(o.paid_at) AND o.subscription_cycle_id IS NOT NULL
      AND o.catalog_acceptance IS NULL AND o.renewal_operation_id IS NULL
      AND o.recreated_from_order_id IS NULL AND o.recovery_root_order_id IS NULL
      AND o.context->>'mode' = 'subscription'
      AND o.context#>>'{pricingPolicy,promotionEngineVersion}' = 'promotion-engine.v2'
      AND o.context->>'acquisitionCapability' = 'subscription-acquisition.v1'
      AND jsonb_typeof(o.context->'acquisitionTerms') = 'object'
      AND o.metadata#>>'{catalogAdmissionSubmit,acceptanceTokenDigest}' ~ '^[0-9a-f]{64}$'
      AND jsonb_array_length(o.claims) > 0 AND jsonb_array_length(o.truth) > 0
    THEN
      BEGIN
        acquisition := public.catalog_price_setup_acquisition_terms(o.created_at);
      EXCEPTION WHEN SQLSTATE '22023' OR SQLSTATE '55000' THEN
        IF NOT ((SQLSTATE = '22023' AND SQLERRM = 'acquisition_terms_invalid')
          OR (SQLSTATE = '55000' AND SQLERRM IN ('acquisition_terms_ambiguous','acquisition_terms_not_effective')))
        THEN RAISE; END IF;
      END;
    END IF;
    IF public.catalog_price_setup_order_protection_verified(o.id, o.claims, o.truth, acquisition) THEN CONTINUE; END IF;
    IF jsonb_array_length(o.claims) > 0 THEN
      RAISE EXCEPTION 'catalog_price_setup_native_order_claim_guard_unverified' USING ERRCODE = '55000';
    END IF;
    IF o.context#>>'{pricingPolicy,promotionEngineVersion}' = 'promotion-engine.v2' THEN
      RAISE EXCEPTION 'catalog_price_setup_native_order_guard_unverified' USING ERRCODE = '55000';
    END IF;
    RAISE EXCEPTION 'catalog_price_setup_native_order_admission_unverified' USING ERRCODE = '55000';
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.commerce_offer_policy_v2_readiness() RETURNS jsonb
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
  SELECT count(*), count(*) FILTER (WHERE NOT public.catalog_price_setup_frozen_order_money_matches(
    public.catalog_price_setup_order_inputs(orders.id), orders.metadata#>'{quoteSnapshot,quote}', v_settlement_currency))
  INTO v_automatic_v2_money_checked_count, v_automatic_v2_money_mismatch_count
  FROM public.commerce_orders orders
  WHERE orders.created_at >= v_now - interval '24 hours'
    AND orders.created_at <= v_now
    AND orders.status IN ('paid', 'fulfillment_pending', 'fulfilled', 'refunded')
    AND orders.metadata#>>'{quoteSnapshot,quote,context,pricingPolicy,promotionEngineVersion}' = 'promotion-engine.v2';

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

REVOKE ALL ON FUNCTION public.catalog_price_setup_frozen_order_money_matches(jsonb,jsonb,text), public.catalog_price_setup_order_protection_verified(uuid,jsonb,jsonb,jsonb) FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
  EXECUTE 'REVOKE ALL ON FUNCTION public.catalog_price_setup_frozen_order_money_matches(jsonb,jsonb,text), public.catalog_price_setup_order_protection_verified(uuid,jsonb,jsonb,jsonb) FROM anon';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
  EXECUTE 'REVOKE ALL ON FUNCTION public.catalog_price_setup_frozen_order_money_matches(jsonb,jsonb,text), public.catalog_price_setup_order_protection_verified(uuid,jsonb,jsonb,jsonb) FROM authenticated';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
  EXECUTE 'REVOKE ALL ON FUNCTION public.catalog_price_setup_frozen_order_money_matches(jsonb,jsonb,text), public.catalog_price_setup_order_protection_verified(uuid,jsonb,jsonb,jsonb) FROM service_role';
END IF; END; $$;
