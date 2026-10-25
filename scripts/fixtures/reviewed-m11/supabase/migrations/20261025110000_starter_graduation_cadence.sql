-- Admit the 14, 21 and 28 day graduation cadence set in both managed routines.
-- Provisional creation uses the subscription column default for timezone.
-- Inert fixture only; no live migration or new graduation mode.
-- migration:allow-security-definer: preserve the existing scoped routines,
-- fixed search path and signatures without widening execution authority.
-- migration:allow-grant: restate service-only execution and revoke public roles.

CREATE OR REPLACE FUNCTION public.subscription_create_provisional_for_checkout(p_order_id uuid, p_client_id uuid, p_pet_id uuid, p_shipping_address_id uuid, p_quote_snapshot jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_catalog'
    AS $_$
DECLARE
  v_cadence_days integer;
  v_currency text;
  v_region_code text;
  v_size_constraint jsonb;
  v_subscription_id uuid;
  v_cycle_id uuid;
  v_template_snapshot jsonb;
  v_line_count integer;
  -- Optional acquisition marker fields.
  v_starter_input jsonb;
  v_starter_marker jsonb;
  v_starter_interval integer;
  v_starter_discount_bps integer;
  v_starter_discount_minor integer;
  v_starter_basis_subtotal integer;
  v_starter_cadence_days integer;
  v_starter_lines jsonb;
  v_starter_graduation jsonb;
  v_starter_line jsonb;
  v_starter_template_version constant integer := 1;
BEGIN
  v_starter_input := p_quote_snapshot #> '{quote,context,starterPack}';
  IF v_starter_input IS NOT NULL AND jsonb_typeof(v_starter_input) <> 'null' THEN
    IF jsonb_typeof(v_starter_input) <> 'object'
      OR v_starter_input->>'schemaVersion' IS DISTINCT FROM '1'
    THEN
      RAISE EXCEPTION 'subscription_starter_pack_invalid_schema' USING ERRCODE = '22023';
    END IF;

    -- The initial interval becomes the acquisition cadence.
    IF NOT COALESCE(v_starter_input->>'starterIntervalDays', '') ~ '^[0-9]+$' THEN
      RAISE EXCEPTION 'subscription_starter_pack_invalid_interval' USING ERRCODE = '22023';
    END IF;
    v_starter_interval := (v_starter_input->>'starterIntervalDays')::integer;
    IF v_starter_interval < 7 OR v_starter_interval > 28 THEN
      RAISE EXCEPTION 'subscription_starter_pack_invalid_interval' USING ERRCODE = '22023';
    END IF;

    IF jsonb_typeof(v_starter_input->'delivery2') <> 'object'
      OR NOT COALESCE(v_starter_input #>> '{delivery2,discountBps}', '') ~ '^[0-9]+$'
      OR NOT COALESCE(v_starter_input #>> '{delivery2,discountMinor}', '') ~ '^[0-9]+$'
      OR NOT COALESCE(v_starter_input #>> '{delivery2,basisSubtotalMinor}', '') ~ '^[0-9]+$'
    THEN
      RAISE EXCEPTION 'subscription_starter_pack_invalid_delivery2' USING ERRCODE = '22023';
    END IF;
    v_starter_discount_bps := (v_starter_input #>> '{delivery2,discountBps}')::integer;
    v_starter_discount_minor := (v_starter_input #>> '{delivery2,discountMinor}')::integer;
    v_starter_basis_subtotal := (v_starter_input #>> '{delivery2,basisSubtotalMinor}')::integer;
    IF v_starter_discount_bps > 10000 THEN
      RAISE EXCEPTION 'subscription_starter_pack_invalid_delivery2' USING ERRCODE = '22023';
    END IF;
    IF v_starter_discount_minor > v_starter_basis_subtotal THEN
      RAISE EXCEPTION 'subscription_starter_pack_discount_out_of_range' USING ERRCODE = '22023';
    END IF;
    -- The second delivery must retain at least 100 payable minor units.
    IF v_starter_basis_subtotal - v_starter_discount_minor < 100 THEN
      RAISE EXCEPTION 'subscription_starter_pack_payable_below_floor' USING ERRCODE = '22023';
    END IF;

    IF NOT COALESCE(v_starter_input #>> '{graduation,cadenceDays}', '') ~ '^[0-9]+$' THEN
      RAISE EXCEPTION 'subscription_starter_pack_invalid_graduation_cadence' USING ERRCODE = '22023';
    END IF;
    v_starter_cadence_days := (v_starter_input #>> '{graduation,cadenceDays}')::integer;
    IF v_starter_cadence_days NOT IN (14, 21, 28) THEN
      RAISE EXCEPTION 'subscription_starter_pack_invalid_graduation_cadence' USING ERRCODE = '22023';
    END IF;

    v_starter_lines := v_starter_input #> '{graduation,lines}';
    IF v_starter_lines IS NULL
      OR jsonb_typeof(v_starter_lines) <> 'array'
      OR jsonb_array_length(v_starter_lines) = 0
    THEN
      RAISE EXCEPTION 'subscription_starter_pack_invalid_graduation_lines' USING ERRCODE = '22023';
    END IF;

    FOR v_starter_line IN SELECT value FROM jsonb_array_elements(v_starter_lines) LOOP
      IF jsonb_typeof(v_starter_line) <> 'object'
        OR COALESCE(v_starter_line->>'sku', '') = ''
        OR NOT COALESCE(v_starter_line->>'qty', '') ~ '^[1-9][0-9]*$'
        OR NOT COALESCE(v_starter_line->>'sortOrder', '') ~ '^[0-9]+$'
        OR jsonb_typeof(v_starter_line->'isAddon') <> 'boolean'
        OR jsonb_typeof(v_starter_line->'quoteLine') <> 'object'
      THEN
        RAISE EXCEPTION 'subscription_starter_pack_invalid_graduation_lines' USING ERRCODE = '22023';
      END IF;
      -- Frozen line amounts must be valid before acquisition.
      IF NOT COALESCE(v_starter_line #>> '{quoteLine,unitPriceGross,amountMinor}', '') ~ '^[0-9]+$'
        OR NOT COALESCE(v_starter_line #>> '{quoteLine,lineSubtotalGross,amountMinor}', '') ~ '^[0-9]+$'
      THEN
        RAISE EXCEPTION 'subscription_starter_pack_invalid_graduation_quote_line' USING ERRCODE = '22023';
      END IF;
    END LOOP;

    v_starter_graduation := jsonb_build_object(
      'cadenceDays', v_starter_cadence_days,
      'lines', v_starter_lines
    );
    IF jsonb_typeof(v_starter_input #> '{graduation,sizeConstraint}') = 'object' THEN
      v_starter_graduation := v_starter_graduation || jsonb_build_object(
        'sizeConstraint', v_starter_input #> '{graduation,sizeConstraint}'
      );
    END IF;

    -- Rebuild validated fields with the server template version.
    v_starter_marker := jsonb_build_object(
      'schemaVersion', '1',
      'starterIntervalDays', v_starter_interval,
      'basisTemplateVersion', v_starter_template_version,
      'delivery2', jsonb_build_object(
        'discountBps', v_starter_discount_bps,
        'discountMinor', v_starter_discount_minor,
        'basisSubtotalMinor', v_starter_basis_subtotal
      ),
      'graduation', v_starter_graduation
    );
  END IF;

  v_cadence_days := COALESCE(
    v_starter_interval,
    nullif(p_quote_snapshot #>> '{quote,context,cadenceDays}', '')::integer
  );
  IF v_cadence_days IS NULL OR v_cadence_days < 1 THEN
    RAISE EXCEPTION 'subscription_provisional_invalid_cadence' USING ERRCODE = '22023';
  END IF;

  SELECT region_code, currency, COALESCE(size_constraint, '{}'::jsonb)
    INTO v_region_code, v_currency, v_size_constraint
    FROM public.commerce_orders
   WHERE id = p_order_id;

  -- A provisional subscription cannot renew until activation.
  INSERT INTO public.subscriptions (
    client_id, pet_id, cadence_days, currency, region_code, status,
    size_constraint, shipping_address_id, billing_address_id,
    next_cycle_at, template_version, timezone, starter_pack
  )
  VALUES (
    p_client_id, p_pet_id, v_cadence_days, v_currency, v_region_code, 'pending_activation',
    v_size_constraint, p_shipping_address_id, p_shipping_address_id,
    NULL, v_starter_template_version, DEFAULT, v_starter_marker
  )
  RETURNING id INTO v_subscription_id;

  -- Seed standing lines from the finalized order.
  INSERT INTO public.subscription_lines (
    subscription_id, variant_id, qty, sort_order, is_addon, template_version, line_metadata
  )
  SELECT
    v_subscription_id,
    oi.sku_id,
    oi.quantity,
    (row_number() OVER (ORDER BY oi.created_at, oi.id))::integer - 1,
    false,
    1,
    jsonb_build_object(
      'source', 'commerce.checkout.provisional.v0',
      'orderItemId', oi.id,
      'productSnapshot', oi.product_snapshot
    )
  FROM public.commerce_order_items oi
  WHERE oi.order_id = p_order_id
    AND oi.sku_id IS NOT NULL;

  SELECT count(*) INTO v_line_count
    FROM public.subscription_lines
   WHERE subscription_id = v_subscription_id;
  IF v_line_count = 0 THEN
    RAISE EXCEPTION 'subscription_provisional_no_lines' USING ERRCODE = '22023';
  END IF;

  -- The initial cycle must use the canonical template snapshot.
  v_template_snapshot := public.subscription_current_template_snapshot(v_subscription_id);

  INSERT INTO public.subscription_cycles (
    subscription_id, cycle_number, scheduled_at, status, template_version,
    template_snapshot, pricing_snapshot, engine_idempotency_key, order_id, retry_attempt
  )
  VALUES (
    v_subscription_id,
    1,
    now(),
    'payment_pending',
    1,
    v_template_snapshot,
    jsonb_build_object('source', 'commerce.checkout.provisional.v0', 'quoteSnapshot', p_quote_snapshot),
    -- Use a separate deterministic initial-cycle key.
    'checkout-initial-cycle:' || p_order_id::text,
    p_order_id,
    0
  )
  RETURNING id INTO v_cycle_id;

  RETURN jsonb_build_object(
    'subscriptionId', v_subscription_id,
    'subscriptionCycleId', v_cycle_id
  );
END;
$_$;

REVOKE ALL ON FUNCTION public.subscription_create_provisional_for_checkout(uuid,uuid,uuid,uuid,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.subscription_create_provisional_for_checkout(uuid,uuid,uuid,uuid,jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.subscription_apply_starter_graduation(p_subscription_id uuid, p_idempotency_key text, p_mode text DEFAULT 'full'::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_catalog'
    AS $_$
DECLARE
  v_subscription public.subscriptions%ROWTYPE;
  v_marker jsonb;
  v_graduation jsonb;
  v_cadence_days integer;
  v_starter_interval integer;
  v_basis_template_version integer;
  v_next_template_version integer;
  v_open_cycles integer;
  v_line jsonb;
  v_line_ordinal integer;
  v_quote_line jsonb;
  v_variant_id uuid;
  v_line_id uuid;
  v_unit_price integer;
  v_event_id uuid;
  v_now constant timestamptz := now();
BEGIN
  IF p_subscription_id IS NULL
    OR p_idempotency_key IS NULL
    OR btrim(p_idempotency_key) = ''
  THEN
    RAISE EXCEPTION 'subscription_starter_graduation_invalid_input' USING ERRCODE = '22023';
  END IF;
  IF p_mode NOT IN ('full', 'cadence_only') THEN
    RAISE EXCEPTION 'subscription_starter_graduation_invalid_mode' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_subscription
    FROM public.subscriptions
   WHERE id = p_subscription_id
   FOR UPDATE;

  IF NOT FOUND OR v_subscription.starter_pack IS NULL THEN
    RETURN jsonb_build_object(
      'contractVersion', 'subscription.starter_graduation.v1',
      'starterGraduation', jsonb_build_object(
        'subscriptionId', p_subscription_id, 'mode', p_mode, 'applied', false,
        'reason', 'not_a_starter_subscription',
        'templateVersion', NULL, 'cadenceDays', NULL
      )
    );
  END IF;

  SELECT count(*)::integer INTO v_open_cycles
    FROM public.subscription_cycles
   WHERE subscription_id = p_subscription_id
     AND status IN ('payment_pending', 'retry_scheduled');
  IF v_open_cycles > 0 THEN
    RAISE EXCEPTION 'subscription_starter_graduation_open_cycle'
      USING
        ERRCODE = '22023',
        DETAIL = 'Subscription ' || p_subscription_id::text || ' has ' || v_open_cycles::text
          || ' cycle(s) in payment_pending or retry_scheduled.',
        HINT = 'Settle or terminalize the open cycle before graduating the template.';
  END IF;

  v_marker := v_subscription.starter_pack;
  v_graduation := v_marker->'graduation';
  v_basis_template_version := (v_marker->>'basisTemplateVersion')::integer;
  v_starter_interval := (v_marker->>'starterIntervalDays')::integer;
  v_cadence_days := (v_graduation->>'cadenceDays')::integer;

  IF p_mode = 'cadence_only' THEN
    IF v_subscription.cadence_days IS DISTINCT FROM v_starter_interval
      OR v_subscription.cadence_days IN (14, 21, 28)
    THEN
      RETURN jsonb_build_object(
        'contractVersion', 'subscription.starter_graduation.v1',
        'starterGraduation', jsonb_build_object(
          'subscriptionId', p_subscription_id, 'mode', p_mode, 'applied', false,
          'reason', 'cadence_already_normal',
          'templateVersion', v_subscription.template_version,
          'cadenceDays', v_subscription.cadence_days
        )
      );
    END IF;
    IF v_cadence_days IS NULL OR v_cadence_days NOT IN (14, 21, 28) THEN
      RAISE EXCEPTION 'subscription_starter_graduation_invalid_cadence' USING ERRCODE = '22023';
    END IF;

    UPDATE public.subscriptions
       SET cadence_days = v_cadence_days,
           template_version = template_version + 1,
           updated_at = v_now
     WHERE id = p_subscription_id
     RETURNING * INTO v_subscription;

    INSERT INTO public.subscription_events (
      subscription_id, event_type, idempotency_key, payload, occurred_at
    )
    VALUES (
      p_subscription_id,
      'subscription.starter_cadence_normalized',
      p_idempotency_key,
      jsonb_build_object(
        'mode', p_mode,
        'starterIntervalDays', v_starter_interval,
        'cadenceDays', v_cadence_days,
        'basisTemplateVersion', v_basis_template_version,
        'templateVersion', v_subscription.template_version
      ),
      v_now
    );

    RETURN jsonb_build_object(
      'contractVersion', 'subscription.starter_graduation.v1',
      'starterGraduation', jsonb_build_object(
        'subscriptionId', p_subscription_id, 'mode', p_mode, 'applied', true,
        'reason', 'cadence_normalized',
        'templateVersion', v_subscription.template_version,
        'cadenceDays', v_subscription.cadence_days
      )
    );
  END IF;

  -- Apply the complete standing template.
  IF v_subscription.template_version IS DISTINCT FROM v_basis_template_version THEN
    RETURN jsonb_build_object(
      'contractVersion', 'subscription.starter_graduation.v1',
      'starterGraduation', jsonb_build_object(
        'subscriptionId', p_subscription_id, 'mode', p_mode, 'applied', false,
        'reason', 'template_version_moved',
        'templateVersion', v_subscription.template_version,
        'cadenceDays', v_subscription.cadence_days
      )
    );
  END IF;
  IF v_cadence_days IS NULL OR v_cadence_days NOT IN (14, 21, 28) THEN
    RAISE EXCEPTION 'subscription_starter_graduation_invalid_cadence' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(v_graduation->'lines') <> 'array'
    OR jsonb_array_length(v_graduation->'lines') = 0
  THEN
    RAISE EXCEPTION 'subscription_starter_graduation_invalid_lines' USING ERRCODE = '22023';
  END IF;

  UPDATE public.subscriptions
     SET cadence_days = v_cadence_days,
         size_constraint = CASE
           WHEN jsonb_typeof(v_graduation->'sizeConstraint') = 'object'
             THEN v_graduation->'sizeConstraint'
           ELSE size_constraint
         END,
         template_version = template_version + 1,
         updated_at = v_now
   WHERE id = p_subscription_id
   RETURNING * INTO v_subscription;
  v_next_template_version := v_subscription.template_version;

  DELETE FROM public.subscription_lines
   WHERE subscription_id = p_subscription_id
     AND is_addon = false;

  FOR v_line, v_line_ordinal IN
    SELECT value, ordinality::integer
      FROM jsonb_array_elements(v_graduation->'lines') WITH ORDINALITY
  LOOP
    SELECT id INTO v_variant_id
      FROM public.catalog_skus
     WHERE sku = v_line->>'sku'
     LIMIT 1;
    IF v_variant_id IS NULL THEN
      RAISE EXCEPTION 'subscription_starter_graduation_unknown_sku: %', v_line->>'sku'
        USING ERRCODE = '22023';
    END IF;

    v_quote_line := COALESCE(v_line->'quoteLine', '{}'::jsonb);
    INSERT INTO public.subscription_lines (
      subscription_id, variant_id, qty, sort_order, is_addon, template_version, line_metadata
    )
    VALUES (
      p_subscription_id,
      v_variant_id,
      (v_line->>'qty')::integer,
      COALESCE((v_line->>'sortOrder')::integer, v_line_ordinal - 1),
      COALESCE((v_line->>'isAddon')::boolean, false),
      v_next_template_version,
      jsonb_build_object(
        'productSnapshot', jsonb_build_object('quoteLine', v_quote_line),
        'source', 'starter_graduation'
      )
    )
    RETURNING id INTO v_line_id;

    v_unit_price := CASE
      WHEN (v_quote_line #>> '{unitPriceGross,amountMinor}') ~ '^[0-9]+$'
        THEN (v_quote_line #>> '{unitPriceGross,amountMinor}')::integer
      WHEN (v_quote_line->>'unitGrossMinor') ~ '^[0-9]+$'
        THEN (v_quote_line->>'unitGrossMinor')::integer
      ELSE NULL
    END;
    INSERT INTO public.subscription_price_agreements (
      subscription_id, subscription_line_id, variant_id, currency, unit_price_gross_minor,
      quote_line, template_version, source_action, idempotency_key, started_at
    )
    VALUES (
      p_subscription_id, v_line_id, v_variant_id, v_subscription.currency, v_unit_price,
      v_quote_line, v_next_template_version, 'starter_graduation', p_idempotency_key, v_now
    )
    ON CONFLICT DO NOTHING;
  END LOOP;

  INSERT INTO public.subscription_events (
    subscription_id, event_type, idempotency_key, payload, occurred_at
  )
  VALUES (
    p_subscription_id,
    'subscription.starter_graduated',
    p_idempotency_key,
    jsonb_build_object(
      'mode', p_mode,
      'starterIntervalDays', v_starter_interval,
      'cadenceDays', v_cadence_days,
      'basisTemplateVersion', v_basis_template_version,
      'templateVersion', v_next_template_version,
      'lineCount', jsonb_array_length(v_graduation->'lines'),
      'priceAgreementPolicy', jsonb_build_object(
        'kind', 'lock_until_edit', 'proration', 'none',
        'cycleEffect', 'future_unlocked_cycles_only'
      )
    ),
    v_now
  )
  RETURNING id INTO v_event_id;

  UPDATE public.subscription_price_agreements
     SET event_id = v_event_id, updated_at = v_now
   WHERE subscription_id = p_subscription_id
     AND idempotency_key = p_idempotency_key;

  RETURN jsonb_build_object(
    'contractVersion', 'subscription.starter_graduation.v1',
    'starterGraduation', jsonb_build_object(
      'subscriptionId', p_subscription_id, 'mode', p_mode, 'applied', true,
      'reason', 'graduated',
      'templateVersion', v_next_template_version,
      'cadenceDays', v_cadence_days
    )
  );
END;
$_$;

REVOKE ALL ON FUNCTION public.subscription_apply_starter_graduation(uuid,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.subscription_apply_starter_graduation(uuid,text,text) TO service_role;
