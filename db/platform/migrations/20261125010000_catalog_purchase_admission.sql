-- Keep native purchases on the original draft rail until a bound quote owner is available.
CREATE FUNCTION public.catalog_admission_lock_shared() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  LOCK TABLE public.catalog_products IN SHARE MODE;
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_admission_lock_shared() FROM PUBLIC;

CREATE FUNCTION public.catalog_admission_lock_checkout_price(p_list_id uuid, p_sku_ids uuid[]) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_sku_id uuid;
BEGIN
  IF p_list_id IS NULL OR cardinality(p_sku_ids) NOT BETWEEN 1 AND 100 OR p_sku_ids IS NULL
    OR array_position(p_sku_ids, NULL::uuid) IS NOT NULL THEN
    RAISE EXCEPTION 'catalog_admission_price_context_required' USING ERRCODE = '22023';
  END IF;
  LOCK TABLE public.price_lists IN SHARE MODE;
  FOR v_sku_id IN SELECT DISTINCT id FROM unnest(p_sku_ids) AS sku(id) ORDER BY id LOOP
    PERFORM public.catalog_price_setup_lock_context(p_list_id, v_sku_id);
  END LOOP;
  LOCK TABLE public.price_entries IN SHARE MODE;
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_admission_lock_checkout_price(uuid,uuid[]) FROM PUBLIC;

CREATE FUNCTION public.catalog_admission_create_order_draft(
  p_key text, p_quote jsonb, p_draft jsonb, p_client uuid, p_evidence jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'catalog_admission_quote_authority_required' USING ERRCODE = '55000';
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_admission_create_order_draft(text,jsonb,jsonb,uuid,jsonb) FROM PUBLIC;

CREATE FUNCTION public.catalog_admission_requires_quote_authority(p_skus text[], p_offer_version text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.catalog_skus s JOIN public.catalog_products p ON p.id = s.product_id
    WHERE s.sku = ANY(p_skus) AND (
      p.publication_facts->'schemaVersion' = '3'::jsonb
      OR s.publication_facts->'schemaVersion' = '3'::jsonb
      OR EXISTS (
        SELECT 1 FROM public.catalog_sku_revisions r
        JOIN public.catalog_publication_heads h ON h.product_id = r.product_id
        WHERE r.sku_id = s.id AND r.full_facts::jsonb->'schemaVersion' = '3'::jsonb
      )
      OR (p_offer_version IS NOT NULL AND (s.publication_facts->'memberships') @>
        jsonb_build_array(jsonb_build_object('offerVersion', p_offer_version)))
    )
  );
$$;
REVOKE ALL ON FUNCTION public.catalog_admission_requires_quote_authority(text[],text) FROM PUBLIC;

CREATE FUNCTION public.catalog_admission_replay_order_draft(
  p_key text, p_client uuid, p_lane text, p_digest text
) RETURNS jsonb
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_receipt public.commerce_order_draft_receipts%ROWTYPE;
  v_order public.commerce_orders%ROWTYPE;
  v_submit jsonb;
BEGIN
  IF p_key IS NULL OR char_length(btrim(p_key)) NOT BETWEEN 8 AND 120 THEN
    RAISE EXCEPTION 'commerce_order_draft_invalid_idempotency_key' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_key, 0));
  SELECT * INTO v_receipt FROM public.commerce_order_draft_receipts WHERE idempotency_key = p_key FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO v_order FROM public.commerce_orders WHERE id = v_receipt.order_id;
  v_submit := v_order.metadata->'catalogAdmissionSubmit';
  IF NOT FOUND OR v_order.client_id IS DISTINCT FROM p_client
    OR v_receipt.request_fingerprint IS DISTINCT FROM md5(
      (v_order.metadata->'quoteSnapshot')::text || '|' || (v_order.metadata->'orderDraftSnapshot')::text
      || '|' || coalesce(v_order.client_id::text, ''))
    OR v_receipt.response_payload#>>'{orderDraft,idempotencyKey}' IS DISTINCT FROM p_key
    OR v_receipt.response_payload#>>'{orderDraft,orderId}' IS DISTINCT FROM 'order_' || v_order.id::text
    OR v_receipt.response_payload#>'{orderDraft,quoteSnapshot}' IS DISTINCT FROM v_order.metadata->'quoteSnapshot'
    OR (v_order.catalog_receipt_key IS NOT NULL AND v_order.catalog_receipt_key IS DISTINCT FROM p_key)
    OR (CASE WHEN v_submit IS NULL THEN v_receipt.request_fingerprint IS DISTINCT FROM p_digest
             ELSE (v_submit->>'lane', v_submit->>'requestKey', v_submit->>'clientId', v_submit->>'submitDigest')
               IS DISTINCT FROM (p_lane, p_key, p_client::text, p_digest) END) THEN
    RAISE EXCEPTION 'commerce_order_draft_idempotency_conflict' USING ERRCODE = '23505';
  END IF;
  IF v_receipt.invalidated_at IS NOT NULL THEN
    RAISE EXCEPTION 'commerce_order_draft_expired' USING ERRCODE = '40001';
  END IF;
  RETURN jsonb_set(v_receipt.response_payload, '{orderDraft,replayed}', 'true'::jsonb, false);
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_admission_replay_order_draft(text,uuid,text,text) FROM PUBLIC;


CREATE FUNCTION public.catalog_admission_check_legacy_draft(
  p_key text, p_draft jsonb, p_client uuid, p_lock boolean
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_skus text[] := ARRAY(SELECT line->>'sku' FROM jsonb_array_elements(
    CASE WHEN jsonb_typeof(p_draft->'lines')='array' THEN p_draft->'lines' ELSE '[]'::jsonb END) AS line);
BEGIN
  IF p_lock THEN
    PERFORM 1 FROM public.clients WHERE id=p_client FOR KEY SHARE;
    PERFORM 1 FROM public.catalog_skus WHERE sku=ANY(v_skus) ORDER BY id FOR KEY SHARE;
    PERFORM public.catalog_admission_lock_shared();
    -- A caller's older transaction snapshot must not hide a concurrent issue.
    IF current_setting('transaction_isolation') IN ('repeatable read','serializable') THEN
      PERFORM 1 FROM public.catalog_products p WHERE id IN (
        SELECT product_id FROM public.catalog_skus WHERE sku=ANY(v_skus)
      ) ORDER BY p.id FOR NO KEY UPDATE;
    END IF;
  END IF;
  IF public.catalog_admission_requires_quote_authority(v_skus,
      coalesce(p_draft#>>'{context,offerVersion,version}',p_draft#>>'{context,offerVersion}'))
    OR EXISTS (
      SELECT 1 FROM public.commerce_orders source_order
      WHERE source_order.id = CASE WHEN p_key ~ '^checkout-recovery-recreate:[a-f0-9-]{36}$'
        AND pg_input_is_valid(split_part(p_key,':',2),'uuid') THEN split_part(p_key,':',2)::uuid END
        AND source_order.client_id = p_client
        AND (source_order.catalog_acceptance IS NOT NULL
          OR source_order.metadata#>'{quoteSnapshot,quote,context,starterRenewalTerms}' IS NOT NULL
          OR source_order.metadata#>>'{catalogAdmissionSubmit,acceptanceTokenDigest}' IS NOT NULL)
    ) THEN
    RAISE EXCEPTION 'catalog_admission_quote_authority_required' USING ERRCODE = '55000';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_admission_check_legacy_draft(text,jsonb,uuid,boolean) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.commerce_create_order_draft_with_outbox(
  p_idempotency_key text,
  p_quote_snapshot jsonb,
  p_order_draft_snapshot jsonb,
  p_client_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog
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

CREATE OR REPLACE FUNCTION public.commerce_create_promoted_order_draft_with_outbox(
  p_idempotency_key text,
  p_quote_snapshot jsonb,
  p_order_draft_snapshot jsonb,
  p_client_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog
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
      v_order_id, p_client_id, v_adjustment.amount_minor, now() + interval '24 hours'
    ) RETURNING * INTO v_claim;
    INSERT INTO public.commerce_promotion_claim_events (claim_id, event_key, transition)
    VALUES (v_claim.id, 'reserved:' || v_order_id::text, 'reserved');
  END LOOP;
  RETURN v_response;
END;
$$;

CREATE FUNCTION public.catalog_admission_line_bindings_valid(p_lines jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF jsonb_typeof(p_lines) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
  RETURN jsonb_array_length(p_lines) BETWEEN 1 AND 100
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_lines) WITH ORDINALITY AS line(value, position)
      WHERE (CASE WHEN jsonb_typeof(value) = 'object' THEN
        value - ARRAY['sourceOrdinal','lineKey','skuId','skuCode','mode','quantity','role','source','skuRevisionId'] = '{}'::jsonb
        AND value->'sourceOrdinal' = to_jsonb(position)
        AND (NOT value ? 'lineKey' OR public.catalog_publication_text_valid(value->'lineKey',240,true))
        AND jsonb_typeof(value->'skuId') = 'string'
        AND value->>'skuId' ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
        AND jsonb_typeof(value->'skuCode') = 'string' AND value->>'skuCode' ~ '^[A-Za-z0-9._:-]{1,160}$'
        AND value->>'mode' IN ('one_time','subscription') AND value->>'role' IN ('core','addon')
        AND jsonb_typeof(value->'quantity') = 'number' AND value->>'quantity' ~ '^[1-9][0-9]{0,9}$'
        AND pg_input_is_valid(value->>'quantity','integer')
        AND (value->>'source' = 'legacy' AND NOT value ? 'skuRevisionId'
          OR value->>'source' IN ('fresh','retained') AND jsonb_typeof(value->'skuRevisionId') = 'string'
            AND value->>'skuRevisionId' ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$') END) IS DISTINCT FROM true
    )
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_lines) line WHERE line ? 'lineKey'
      GROUP BY line->'lineKey' HAVING count(*) > 1);
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_admission_line_bindings_valid(jsonb) FROM PUBLIC;

CREATE FUNCTION public.catalog_admission_legacy_review_valid(p_review jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT coalesce((CASE WHEN jsonb_typeof(p_review) = 'object' THEN
    p_review - ARRAY['identityComparison','priceEvidenceRef','policyEvidenceRef','priorPriceEvidenceRef','priorPolicyEvidenceRef'] = '{}'::jsonb
      AND p_review->>'priceEvidenceRef' ~ '^price\.v1:[0-9a-f]{64}$'
      AND p_review->>'policyEvidenceRef' ~ '^policy\.v1:[0-9a-f]{64}$'
      AND (p_review->>'identityComparison' = 'unavailable' AND NOT p_review ?| ARRAY['priorPriceEvidenceRef','priorPolicyEvidenceRef']
        OR p_review->>'identityComparison' IN ('equal','changed')
          AND p_review->>'priorPriceEvidenceRef' ~ '^price\.v1:[0-9a-f]{64}$'
          AND p_review->>'priorPolicyEvidenceRef' ~ '^policy\.v1:[0-9a-f]{64}$'
          AND (p_review->>'identityComparison' = 'equal') =
            ((p_review->'priceEvidenceRef',p_review->'policyEvidenceRef') =
             (p_review->'priorPriceEvidenceRef',p_review->'priorPolicyEvidenceRef'))) END),false);
$$;
REVOKE ALL ON FUNCTION public.catalog_admission_legacy_review_valid(jsonb) FROM PUBLIC;

CREATE FUNCTION public.catalog_admission_evidence_valid(p_admission jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF (CASE WHEN jsonb_typeof(p_admission) = 'object' THEN
    p_admission - ARRAY['quoteRef','quoteDigest','moneyVersion','priceEvidenceRef','policyEvidenceRef',
      'acceptanceTokenDigest','consultedHeads','offer','lineBindings','legacyReviewEvidence','destinationRef','destinationDigest','graduation'] = '{}'::jsonb
    AND p_admission->>'moneyVersion' = 'v0'
    AND p_admission->>'quoteDigest' ~ '^[0-9a-f]{64}$'
    AND p_admission->>'priceEvidenceRef' ~ '^price\.v1:[0-9a-f]{64}$'
    AND p_admission->>'policyEvidenceRef' ~ '^policy\.v1:[0-9a-f]{64}$'
    AND (NOT p_admission ? 'quoteRef' OR public.catalog_publication_text_valid(p_admission->'quoteRef',240,true))
    AND (NOT p_admission ? 'acceptanceTokenDigest' OR p_admission->>'acceptanceTokenDigest' ~ '^[0-9a-f]{64}$')
    AND jsonb_typeof(p_admission->'consultedHeads') = 'array'
    AND (NOT p_admission ? 'offer' OR (jsonb_typeof(p_admission->'offer') = 'object'
      AND (p_admission->'offer') - ARRAY['ref','version'] = '{}'::jsonb
      AND public.catalog_publication_text_valid(p_admission#>'{offer,ref}',240,true)
      AND public.catalog_publication_text_valid(p_admission#>'{offer,version}',240,true)))
    AND public.catalog_admission_line_bindings_valid(p_admission->'lineBindings')
    AND (NOT p_admission ? 'legacyReviewEvidence' OR public.catalog_admission_legacy_review_valid(p_admission->'legacyReviewEvidence'))
    AND (NOT p_admission ?| ARRAY['destinationRef','destinationDigest']
      OR public.catalog_publication_text_valid(p_admission->'destinationRef',240,true)
      AND p_admission->>'destinationDigest' ~ '^[0-9a-f]{64}$')
    AND (NOT p_admission ? 'graduation' OR (jsonb_typeof(p_admission->'graduation') = 'object'
      AND (p_admission->'graduation') - ARRAY['phaseDigest','lineBindings'] = '{}'::jsonb
      AND p_admission#>>'{graduation,phaseDigest}' ~ '^[0-9a-f]{64}$'
      AND public.catalog_admission_line_bindings_valid(p_admission#>'{graduation,lineBindings}')))
    END) IS DISTINCT FROM true THEN RETURN false; END IF;
  RETURN jsonb_array_length(p_admission->'consultedHeads') <= 500 AND NOT EXISTS (
    SELECT 1 FROM (
      SELECT head, lag(head->>'productId') OVER (ORDER BY position) AS previous
      FROM jsonb_array_elements(p_admission->'consultedHeads') WITH ORDINALITY AS heads(head,position)
    ) ordered
    WHERE (CASE WHEN jsonb_typeof(head) = 'object' THEN
      head - ARRAY['productId','publicationId','revision','documentDigest'] = '{}'::jsonb
      AND jsonb_typeof(head->'productId') = 'string' AND head->>'productId' ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
      AND jsonb_typeof(head->'publicationId') = 'string' AND head->>'publicationId' ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
      AND jsonb_typeof(head->'revision') = 'number' AND head->>'revision' ~ '^[1-9][0-9]{0,9}$'
      AND pg_input_is_valid(head->>'revision','integer') AND head->>'documentDigest' ~ '^[0-9a-f]{64}$'
      AND (previous IS NULL OR previous COLLATE "C" < head->>'productId' COLLATE "C") END) IS DISTINCT FROM true
  );
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_admission_evidence_valid(jsonb) FROM PUBLIC;

CREATE FUNCTION public.catalog_admission_submit_valid(p_submit jsonb, p_client uuid, p_key text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT coalesce((CASE WHEN jsonb_typeof(p_submit) = 'object' THEN
    p_submit - ARRAY['schemaVersion','ownerNamespace','actorRef','clientId','lane','requestKey',
      'submitDigest','acceptanceTokenDigest','legacyReviewEvidence'] = '{}'::jsonb
    AND p_submit->'schemaVersion' = '1'::jsonb
    AND public.catalog_publication_text_valid(p_submit->'ownerNamespace',240,true)
    AND (NOT p_submit ? 'actorRef' OR public.catalog_publication_text_valid(p_submit->'actorRef',240,true))
    AND p_submit->>'clientId' = p_client::text AND p_submit->>'requestKey' = p_key
    AND public.catalog_publication_text_valid(p_submit->'lane',240,true)
    AND p_submit->>'submitDigest' ~ '^[0-9a-f]{64}$'
    AND (p_submit->'acceptanceTokenDigest' = 'null'::jsonb OR p_submit->>'acceptanceTokenDigest' ~ '^[0-9a-f]{64}$')
    AND (NOT p_submit ? 'legacyReviewEvidence' OR public.catalog_admission_legacy_review_valid(p_submit->'legacyReviewEvidence'))
    END),false);
$$;
REVOKE ALL ON FUNCTION public.catalog_admission_submit_valid(jsonb,uuid,text) FROM PUBLIC;

CREATE FUNCTION public.catalog_admission_assert_current(
  p_reviewed jsonb, p_document jsonb, p_mode text, p_context jsonb, p_admission jsonb, p_digest text
) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT public.catalog_admission_evidence_valid(p_admission)
    OR p_admission->>'quoteDigest' IS DISTINCT FROM p_digest
    OR p_document - ARRAY['reviewedProjection','consultedHeads','offer','lineBindings','priceEvidenceRef','policyEvidenceRef'] <> '{}'::jsonb
    OR (p_document->'consultedHeads', p_document->'lineBindings', p_document->'offer', p_document->'priceEvidenceRef', p_document->'policyEvidenceRef')
      IS DISTINCT FROM (p_admission->'consultedHeads', p_admission->'lineBindings', p_admission->'offer', p_admission->'priceEvidenceRef', p_admission->'policyEvidenceRef')
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_admission->'lineBindings') line WHERE line->>'mode' IS DISTINCT FROM p_mode)
    OR p_admission ?| ARRAY['acceptanceTokenDigest','graduation'] THEN
    RAISE EXCEPTION 'catalog_admission_evidence_binding_mismatch' USING ERRCODE = '22023';
  END IF;
  IF current_setting('transaction_isolation') <> 'repeatable read' OR pg_is_in_recovery()
    OR (SELECT count(*) FROM pg_locks WHERE pid = pg_backend_pid() AND locktype = 'relation'
      AND relation IN ('public.catalog_products'::regclass,'public.price_lists'::regclass,'public.price_entries'::regclass)
      AND mode = 'ShareLock' AND granted) <> 3 THEN
    RAISE EXCEPTION 'catalog_admission_fence_unavailable' USING ERRCODE = '55000';
  END IF;
  IF p_document->'reviewedProjection' IS DISTINCT FROM p_reviewed THEN
    RAISE EXCEPTION 'catalog_admission_quote_projection_moved' USING ERRCODE = '40001';
  END IF;
  IF p_document ? 'offer' THEN
    RAISE EXCEPTION 'catalog_admission_membership_authority_unavailable' USING ERRCODE = '55000';
  END IF;
  IF p_mode IS DISTINCT FROM 'one_time' OR p_context->>'policy' IS DISTINCT FROM 'not_applicable'
    OR p_context->>'channel' IS DISTINCT FROM 'D2C' THEN
    RAISE EXCEPTION 'catalog_admission_price_context_required' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_admission->'consultedHeads') consulted
    WHERE NOT EXISTS (
      SELECT 1 FROM public.catalog_publication_heads h
      JOIN public.catalog_publications issue ON (issue.product_id,issue.id,issue.revision) = (h.product_id,h.publication_id,h.revision)
      JOIN public.catalog_product_document_revisions d ON d.id = issue.document_revision_id
      WHERE h.product_id = (consulted->>'productId')::uuid AND h.publication_id = (consulted->>'publicationId')::uuid
        AND h.revision = (consulted->>'revision')::integer AND d.digest = consulted->>'documentDigest'
    )
  ) THEN
    RAISE EXCEPTION 'catalog_publication_head_moved' USING ERRCODE = '40001';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_admission->'lineBindings') line
    JOIN public.catalog_skus s ON s.id = (line->>'skuId')::uuid JOIN public.catalog_products p ON p.id = s.product_id
    WHERE s.status = 'archived' OR p.status = 'archived'
  ) THEN
    RAISE EXCEPTION 'catalog_admission_roster_archived' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_admission->'lineBindings') line
    WHERE line->>'role' <> 'core' OR line->>'source' = 'retained' OR NOT EXISTS (
      SELECT 1 FROM public.catalog_skus s JOIN public.catalog_products p ON p.id = s.product_id
      WHERE s.id = (line->>'skuId')::uuid AND s.sku = line->>'skuCode'
        AND p.status = 'active' AND s.status = 'active' AND s.sellable_standalone AND NOT s.is_addon
        AND (line->>'quantity')::integer >= s.min_order_qty
        AND CASE WHEN line->>'source' = 'legacy'
          THEN NOT public.catalog_admission_requires_quote_authority(ARRAY[s.sku], NULL)
          ELSE EXISTS (
            SELECT 1 FROM public.catalog_sku_revisions r
            JOIN public.catalog_publication_heads h ON h.product_id = r.product_id
            JOIN public.catalog_publications issue ON issue.id = h.publication_id
            WHERE r.id = (line->>'skuRevisionId')::uuid AND r.sku_id = s.id
              AND issue.canonical_state::jsonb->'skus' @> jsonb_build_array(jsonb_build_object('revisionId',r.id,'skuId',s.id))
              AND p.publication_facts->>'lifecycleState' = 'active' AND s.publication_facts->>'lifecycleState' = 'active'
              AND EXISTS (SELECT 1 FROM jsonb_array_elements(p_admission->'consultedHeads') head WHERE head->>'productId' = h.product_id::text)
          )
        END
    )
  ) THEN
    RAISE EXCEPTION 'catalog_admission_line_ineligible' USING ERRCODE = '22023';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_admission_assert_current(jsonb,jsonb,text,jsonb,jsonb,text) FROM PUBLIC;

CREATE FUNCTION public.catalog_admission_accept(
  p_reviewed jsonb, p_document jsonb, p_mode text, p_context jsonb, p_digest text
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_admission jsonb := (p_document - 'reviewedProjection') || jsonb_build_object('moneyVersion','v0','quoteDigest',p_digest);
BEGIN
  PERFORM public.catalog_admission_assert_current(p_reviewed,p_document,p_mode,p_context,v_admission,p_digest);
  RETURN v_admission;
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_admission_accept(jsonb,jsonb,text,jsonb,text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.catalog_acceptance_assert_v2(p_acceptance jsonb) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE reference jsonb;
BEGIN
 IF jsonb_typeof(p_acceptance) IS DISTINCT FROM 'object' OR p_acceptance->'schemaVersion' IS DISTINCT FROM '2'::jsonb
  OR p_acceptance - ARRAY['schemaVersion','lines','admission'] <> '{}'::jsonb OR jsonb_typeof(p_acceptance->'lines') IS DISTINCT FROM 'array'
  OR octet_length(CAST(p_acceptance AS text))>1048576
  OR (p_acceptance ? 'admission' AND NOT public.catalog_admission_evidence_valid(p_acceptance->'admission')) THEN
  RAISE EXCEPTION 'catalog_acceptance_invalid' USING ERRCODE='22023',
   HINT='Supply a schema-2 acceptance with 1 to 100 distinct SKU identities and codes.'; END IF;
 IF jsonb_array_length(p_acceptance->'lines') NOT BETWEEN 1 AND 100
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_acceptance->'lines') l GROUP BY l->>'skuId' HAVING count(*)>1)
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_acceptance->'lines') l GROUP BY l->>'skuCode' HAVING count(*)>1) THEN
  RAISE EXCEPTION 'catalog_acceptance_invalid' USING ERRCODE='22023',
   HINT='Supply a schema-2 acceptance with 1 to 100 distinct SKU identities and codes.'; END IF;
 FOR reference IN SELECT value FROM jsonb_array_elements(p_acceptance->'lines') LOOP PERFORM public.catalog_accepted_reference_assert_v2(reference); END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.catalog_acceptance_roster_valid_v2(p_acceptance jsonb,p_basket jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
 IF jsonb_typeof(p_basket) IS DISTINCT FROM 'object' OR p_acceptance->'schemaVersion' IS DISTINCT FROM '2'::jsonb
  OR jsonb_typeof(p_acceptance->'lines') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
 IF p_acceptance ? 'admission' AND (
  NOT public.catalog_admission_evidence_valid(p_acceptance->'admission')
  OR (SELECT jsonb_object_agg(code,qty) FROM (
    SELECT line->>'skuCode' code,sum((line->>'quantity')::integer) qty
    FROM jsonb_array_elements(p_acceptance#>'{admission,lineBindings}') line GROUP BY line->>'skuCode'
  ) grouped) IS DISTINCT FROM p_basket
  OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_acceptance#>'{admission,lineBindings}') line
    WHERE CASE WHEN line->>'source'='legacy' THEN EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_acceptance->'lines') ref WHERE ref->'skuId'=line->'skuId'
    ) ELSE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_acceptance->'lines') ref
      WHERE (ref->'skuId',ref->'skuCode',ref->'skuRevisionId')=(line->'skuId',line->'skuCode',line->'skuRevisionId')) END)
 ) THEN RETURN false; END IF;
 RETURN (SELECT count(*)=count(DISTINCT l->>'skuCode') AND count(*)>0
  AND NOT EXISTS(SELECT 1 FROM jsonb_object_keys(p_basket) AS codes(code)
   WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_acceptance->'lines') ref WHERE ref->>'skuCode'=codes.code)
    AND NOT EXISTS(SELECT 1 FROM public.catalog_skus k WHERE k.sku=codes.code
      AND k.publication_facts->'schemaVersion' IS DISTINCT FROM '3'::jsonb))
  AND bool_and(coalesce(p_basket ? (l->>'skuCode') AND EXISTS(
   SELECT 1 FROM public.catalog_skus k WHERE k.sku=l->>'skuCode' AND to_jsonb(k.id)=l->'skuId'),false))
  FROM jsonb_array_elements(p_acceptance->'lines') l);
END;
$$;

CREATE OR REPLACE FUNCTION public.catalog_order_acceptance_final(p_order_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE target public.commerce_orders; basket jsonb; submit jsonb;
BEGIN
 SELECT * INTO target FROM public.commerce_orders WHERE id=p_order_id;
 submit := target.metadata->'catalogAdmissionSubmit';
 IF submit IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM public.commerce_order_draft_receipts r WHERE r.order_id=p_order_id
   AND public.catalog_admission_submit_valid(submit,target.client_id,r.idempotency_key)
   AND r.response_payload#>>'{orderDraft,idempotencyKey}'=r.idempotency_key
   AND r.response_payload#>>'{orderDraft,orderId}'='order_'||p_order_id::text
   AND r.response_payload#>'{orderDraft,quoteSnapshot}'=target.metadata->'quoteSnapshot'
   AND r.request_fingerprint=md5((target.metadata->'quoteSnapshot')::text || '|'
    || (target.metadata->'orderDraftSnapshot')::text || '|' || coalesce(target.client_id::text,''))
 ) THEN RAISE EXCEPTION 'catalog_acceptance_receipt_mismatch' USING ERRCODE='22023'; END IF;
 IF target.catalog_acceptance IS NULL THEN RETURN; END IF;
 IF target.renewal_operation_id IS NOT NULL THEN
  IF NOT EXISTS(SELECT 1 FROM public.subscription_renewal_operations op WHERE op.id=target.renewal_operation_id
   AND op.catalog_acceptance=target.catalog_acceptance AND op.catalog_acceptance_fingerprint=target.renewal_operation_fingerprint)
   THEN RAISE EXCEPTION 'catalog_acceptance_snapshot_mismatch' USING ERRCODE='22023',
   HINT='Use the stored renewal operation, its original acceptance and its frozen snapshot.'; END IF;
 ELSIF target.catalog_receipt_key IS NULL OR NOT EXISTS(
   SELECT 1 FROM public.commerce_order_draft_receipts r WHERE r.order_id=p_order_id AND r.idempotency_key=target.catalog_receipt_key
  ) THEN RAISE EXCEPTION 'catalog_acceptance_receipt_mismatch' USING ERRCODE='22023',
   HINT='Supply the persisted draft receipt for this order and retry with its original key.';
 END IF;
 basket:=public.catalog_order_evidence_v2(p_order_id,target.metadata,target.catalog_acceptance,target.renewal_operation_id IS NULL);
 IF basket IS NULL OR (target.catalog_basket IS NOT NULL AND target.catalog_basket IS DISTINCT FROM basket)
  OR (target.catalog_basket IS NULL AND NOT EXISTS(SELECT 1 FROM public.commerce_order_items WHERE order_id=p_order_id)) THEN
  RAISE EXCEPTION 'catalog_acceptance_line_mismatch' USING ERRCODE='22023',
   HINT='Reconcile the accepted SKU revisions and quantities with the authoritative basket before retrying.'; END IF;
 IF target.catalog_acceptance ? 'admission' AND (
  NOT public.catalog_acceptance_roster_valid_v2(target.catalog_acceptance,basket)
  OR EXISTS (
   WITH expected AS (
    SELECT (line->>'sourceOrdinal')::integer coordinate,(line->>'skuId')::uuid sku_id,(line->>'quantity')::integer quantity
    FROM jsonb_array_elements(target.catalog_acceptance#>'{admission,lineBindings}') line
   ), actual AS (
    SELECT coalesce(source_line_ordinal,line_ordinal) coordinate,sku_id,sum(quantity) quantity
    FROM public.commerce_order_items WHERE order_id=p_order_id GROUP BY 1,2
   )
   SELECT 1 FROM expected FULL JOIN actual USING (coordinate,sku_id) WHERE expected.quantity IS DISTINCT FROM actual.quantity
  )
  OR EXISTS (SELECT 1 FROM jsonb_array_elements(target.metadata#>'{orderDraftSnapshot,lines}') WITH ORDINALITY AS draft(line,coordinate)
   LEFT JOIN LATERAL (SELECT target.catalog_acceptance#>ARRAY['admission','lineBindings',(draft.coordinate-1)::text] AS binding) bound ON true
   WHERE (draft.line->'sku',draft.line->'quantity') IS DISTINCT FROM (bound.binding->'skuCode',bound.binding->'quantity'))
 ) THEN RAISE EXCEPTION 'catalog_acceptance_line_mismatch' USING ERRCODE='22023'; END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.catalog_order_line_sum_acceptance(
  p_order_id uuid,
  p_old_order_id uuid DEFAULT NULL,
  p_old_header public.commerce_orders DEFAULT NULL,
  p_new_header public.commerce_orders DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_acceptance jsonb;
  v_client_id uuid;
  v_submit jsonb;
BEGIN
  IF pg_catalog.pg_trigger_depth()=0 THEN RETURN; END IF;
  IF p_old_order_id IS NOT NULL THEN
    IF p_old_order_id = p_order_id THEN RETURN; END IF;
    p_order_id := p_old_order_id;
  END IF;
  SELECT catalog_acceptance, client_id, metadata->'catalogAdmissionSubmit' INTO v_acceptance, v_client_id, v_submit
    FROM public.commerce_orders
   WHERE id = p_order_id;
  IF p_new_header IS DISTINCT FROM NULL AND p_old_header.metadata ? 'catalogAdmissionSubmit' AND
    (p_old_header.client_id, p_old_header.metadata->'catalogAdmissionSubmit', p_old_header.metadata->'quoteSnapshot', p_old_header.metadata->'orderDraftSnapshot')
    IS DISTINCT FROM
    (p_new_header.client_id, p_new_header.metadata->'catalogAdmissionSubmit', p_new_header.metadata->'quoteSnapshot', p_new_header.metadata->'orderDraftSnapshot')
  THEN
    RAISE EXCEPTION 'catalog_acceptance_immutable' USING ERRCODE='55000';
  END IF;
  IF coalesce(p_old_header.catalog_acceptance, p_new_header.catalog_acceptance, v_acceptance, v_submit) IS NULL THEN RETURN; END IF;
  IF (pg_catalog.current_setting('role')='authenticated' OR session_user='authenticated')
    AND NOT EXISTS (SELECT 1 FROM public.clients c WHERE c.id=v_client_id AND c.principal_id=auth.uid())
  THEN
    RAISE EXCEPTION 'subscription_lifecycle_forbidden' USING ERRCODE='22023',
      HINT='Submit the change for an order owned by the current customer.';
  END IF;
  IF p_new_header IS DISTINCT FROM NULL THEN
    IF p_old_header.catalog_acceptance IS NOT NULL AND
      (p_old_header.catalog_acceptance, p_old_header.catalog_basket, p_old_header.catalog_receipt_key, p_old_header.renewal_operation_id, p_old_header.renewal_operation_fingerprint)
      IS DISTINCT FROM (p_new_header.catalog_acceptance, p_new_header.catalog_basket, p_new_header.catalog_receipt_key, p_new_header.renewal_operation_id, p_new_header.renewal_operation_fingerprint)
    THEN
      RAISE EXCEPTION 'catalog_acceptance_immutable' USING ERRCODE = '55000',
   HINT='Replay the owner command with its original acceptance and evidence.';
    END IF;
    IF p_new_header.catalog_acceptance IS NOT NULL THEN
      PERFORM public.catalog_acceptance_assert_v2(p_new_header.catalog_acceptance);
    END IF;
    RETURN;
  END IF;

  IF v_acceptance IS NOT NULL OR v_submit IS NOT NULL THEN
    PERFORM public.catalog_order_acceptance_final(p_order_id);
  END IF;
END;
$$;

-- Attach the host's legacy submit before its native draft transaction commits.
CREATE FUNCTION public.catalog_admission_attach_legacy_submit(p_key text,p_client uuid,p_submit jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_order_id uuid;
BEGIN
  IF NOT public.catalog_admission_submit_valid(p_submit,p_client,p_key) THEN
    RAISE EXCEPTION 'catalog_admission_evidence_binding_mismatch' USING ERRCODE='22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_key,0));
  SELECT r.order_id INTO v_order_id FROM public.commerce_order_draft_receipts r
    JOIN public.commerce_orders o ON o.id=r.order_id
    WHERE r.idempotency_key=p_key AND o.client_id=p_client
      AND r.xmin::text::bigint = pg_current_xact_id()::text::bigint % 4294967296
      AND r.invalidated_at IS NULL AND o.catalog_acceptance IS NULL
      AND NOT o.metadata ? 'catalogAdmissionSubmit'
      AND NOT public.catalog_admission_requires_quote_authority(ARRAY(
        SELECT sku.sku FROM public.commerce_order_items i JOIN public.catalog_skus sku ON sku.id=i.sku_id
        WHERE i.order_id=o.id),NULL)
    FOR UPDATE OF r,o;
  IF NOT FOUND THEN RAISE EXCEPTION 'catalog_acceptance_receipt_mismatch' USING ERRCODE='22023'; END IF;
  UPDATE public.commerce_orders SET metadata=jsonb_set(metadata, '{catalogAdmissionSubmit}', p_submit)
    WHERE id=v_order_id;
  PERFORM public.catalog_order_acceptance_final(v_order_id);
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_admission_attach_legacy_submit(text,uuid,jsonb) FROM PUBLIC;

CREATE FUNCTION public.catalog_admission_guard_purchase_item(p_item public.commerce_order_items) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF pg_trigger_depth()=0 THEN RETURN; END IF;
  IF EXISTS (
    SELECT 1 FROM public.commerce_order_items i
    JOIN public.catalog_skus s ON s.id=i.sku_id
    JOIN public.commerce_orders o ON o.id=i.order_id
    WHERE i.id=p_item.id AND o.renewal_operation_id IS NULL
      AND public.catalog_admission_requires_quote_authority(ARRAY[s.sku],NULL)
  ) THEN
    RAISE EXCEPTION 'catalog_admission_quote_authority_required' USING ERRCODE='55000';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_admission_guard_purchase_item(public.commerce_order_items) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.commerce_order_assert_line_sum()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_order_id uuid;
  v_declared bigint;
  v_sum bigint;
BEGIN
  -- Branching statements rather than one CASE expression on purpose: the procedural language
  -- compiles an expression into a single query, so every record field named in any arm must exist
  -- on every row type the trigger can see, and the two row types here differ.
  IF TG_TABLE_NAME = 'commerce_orders' THEN
    v_order_id := NEW.id;
    PERFORM public.catalog_order_line_sum_acceptance(v_order_id, p_old_header => OLD, p_new_header => NEW);
  ELSIF TG_OP = 'DELETE' THEN
    v_order_id := OLD.order_id;
  ELSE
    v_order_id := NEW.order_id;
    -- Transfer runs under the owning migration login. Ordinary table writers
    -- may not add governed purchase lines outside the native draft owner.
    IF NOT pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid=TG_RELID),'USAGE') THEN
      IF TG_OP='INSERT' THEN PERFORM public.catalog_admission_guard_purchase_item(NEW);
      ELSIF (OLD.order_id,OLD.sku_id,OLD.quantity) IS DISTINCT FROM (NEW.order_id,NEW.sku_id,NEW.quantity) THEN
        PERFORM public.catalog_admission_guard_purchase_item(NEW);
      END IF;
    END IF;
    IF TG_OP = 'UPDATE' THEN
      PERFORM public.catalog_order_line_sum_acceptance(v_order_id, OLD.order_id);
    END IF;
  END IF;

  SELECT total_amount_minor INTO v_declared
    FROM public.commerce_orders
   WHERE id = v_order_id;
  -- The order is gone: a cascade took it, and there is nothing left to be consistent with.
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(sum(line_amount_minor), 0) INTO v_sum
    FROM public.commerce_order_items
   WHERE order_id = v_order_id;

  SELECT v_sum + COALESCE(sum(CASE
    WHEN kind = 'shipping_charge' THEN amount_minor
    WHEN kind = 'promotion_discount' AND scope = 'shipping' THEN -amount_minor
    ELSE 0 END), 0) INTO v_sum
    FROM public.commerce_order_adjustments
   WHERE order_id = v_order_id;

  IF v_sum IS DISTINCT FROM COALESCE(v_declared, 0) THEN
    RAISE EXCEPTION 'commerce_order_line_sum_mismatch' USING ERRCODE = '23514',
      DETAIL = format('order %s declares %s and its lines sum to %s',
                      v_order_id, COALESCE(v_declared::text, 'nothing'), v_sum);
  END IF;

  PERFORM public.catalog_order_line_sum_acceptance(v_order_id);
  RETURN NULL;
END;
$$;

DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'GRANT EXECUTE ON FUNCTION public.catalog_admission_guard_purchase_item(public.commerce_order_items) TO authenticated;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'GRANT EXECUTE ON FUNCTION public.catalog_admission_check_legacy_draft(text,jsonb,uuid,boolean), public.catalog_admission_requires_quote_authority(text[],text), public.catalog_admission_replay_order_draft(text,uuid,text,text), public.catalog_admission_attach_legacy_submit(text,uuid,jsonb), public.catalog_admission_assert_current(jsonb,jsonb,text,jsonb,jsonb,text), public.catalog_admission_guard_purchase_item(public.commerce_order_items) TO service_role;'; END IF; END; $$;
