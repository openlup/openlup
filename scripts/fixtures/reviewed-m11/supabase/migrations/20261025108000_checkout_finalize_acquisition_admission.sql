-- CTL-M11 reviewed fixture: check retained acquisition evidence immediately before
-- first provisional subscription creation. Existing finalize replay, fingerprints,
-- client/address ownership, money snapshots and one-time orders keep their paths.
-- Requires the preceding private helper, terms reader and metadata decoder.
-- Preserve existing SECURITY DEFINER, fixed path and service-only execution.
-- Admitted pin: config/reviewed-platform-forwards.json managedCommerceForwards.
-- M11 feature PRs (the K1 stack) introduce these bytes in registry order.
-- This file requires every earlier same-rail M10/M11 pin to have landed.
-- Pin admission does not establish installation or runtime behavior.
CREATE OR REPLACE FUNCTION public.commerce_finalize_order_for_checkout(p_idempotency_key text, p_order_id uuid, p_mode text, p_client_id uuid, p_shipping_address_id uuid, p_pet_id uuid, p_quote_snapshot jsonb, p_order_draft_snapshot jsonb, p_metadata jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = public, pg_catalog
    AS $$
DECLARE
  v_scope constant text := 'commerce.checkout_order_finalize';
  v_request_fingerprint text;
  v_existing public.commerce_idempotency_keys%ROWTYPE;
  v_completed_order public.commerce_orders%ROWTYPE;
  v_completed_order_id text;
  v_order public.commerce_orders%ROWTYPE;
  v_client public.clients%ROWTYPE;
  v_address public.addresses%ROWTYPE;
  v_pet public.pets%ROWTYPE;
  v_item public.commerce_order_items%ROWTYPE;
  v_sku public.catalog_skus%ROWTYPE;
  v_items jsonb := '[]'::jsonb;
  v_response jsonb;
  v_context_mode text;
  v_expected_context_mode text;
  v_mode_discount_lines integer;
  v_provisional jsonb;
  v_subscription_id uuid := NULL;
  v_subscription_cycle_id uuid := NULL;
  v_invoice_buyer_snapshot jsonb;
  v_runtime_metadata jsonb;
  v_is_neutral boolean := (coalesce(p_metadata, '{}'::jsonb) ->> 'checkoutCommandVersion')
    IS NOT DISTINCT FROM 'commerce.checkout_command.v1';
BEGIN
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' OR length(p_idempotency_key) < 8
    OR p_order_id IS NULL
    OR p_mode NOT IN ('one_time', 'subscription_cycle')
    OR p_client_id IS NULL
    OR p_shipping_address_id IS NULL
    OR p_quote_snapshot IS NULL
    OR p_order_draft_snapshot IS NULL
  THEN
    RAISE EXCEPTION 'commerce_runtime_finalize_invalid_input' USING ERRCODE = '22023';
  END IF;
  IF p_mode = 'subscription_cycle' AND p_pet_id IS NULL AND NOT v_is_neutral THEN
    RAISE EXCEPTION 'commerce_runtime_finalize_subscription_requires_pet' USING ERRCODE = '22023';
  END IF;
  v_expected_context_mode := CASE
    WHEN p_mode = 'subscription_cycle' THEN 'subscription'
    ELSE 'one_time'
  END;
  v_context_mode := p_quote_snapshot #>> '{quote,context,mode}';
  IF v_context_mode IS NULL OR v_context_mode IS DISTINCT FROM v_expected_context_mode THEN
    RAISE EXCEPTION
      'commerce_runtime_finalize_mode_binding_mismatch: p_mode=% context.mode=%',
      p_mode, coalesce(v_context_mode, 'null')
      USING ERRCODE = '22023';
  END IF;
  IF p_mode = 'one_time' THEN
    SELECT count(*)
      INTO v_mode_discount_lines
      FROM jsonb_array_elements(coalesce(p_quote_snapshot #> '{quote,lines}', '[]'::jsonb)) AS line,
           jsonb_array_elements(coalesce(line -> 'pricingComponents', '[]'::jsonb)) AS component
     WHERE component ->> 'componentType' = 'mode_discount';
    IF v_mode_discount_lines > 0 THEN
      RAISE EXCEPTION
        'commerce_runtime_finalize_line_mode_binding_mismatch: p_mode=one_time subscription_lines=%',
        v_mode_discount_lines
        USING ERRCODE = '22023';
    END IF;
  END IF;

  v_request_fingerprint := md5(
    p_order_id::text || '|' ||
    p_mode || '|' ||
    p_client_id::text || '|' ||
    p_shipping_address_id::text || '|' ||
    coalesce(p_pet_id::text, '') || '|' ||
    p_quote_snapshot::text || '|' ||
    p_order_draft_snapshot::text || '|' ||
    CASE
      WHEN jsonb_typeof(coalesce(p_metadata, '{}'::jsonb)) = 'object'
        THEN (coalesce(p_metadata, '{}'::jsonb) - 'deliveryContact')::text
      ELSE coalesce(p_metadata, '{}'::jsonb)::text
    END
  );

  SELECT *
    INTO v_existing
    FROM public.commerce_idempotency_keys
   WHERE scope = v_scope
     AND idempotency_key = p_idempotency_key
   FOR UPDATE;

  IF FOUND THEN
    IF v_existing.status = 'completed'
      AND v_existing.request_fingerprint = v_request_fingerprint
      AND v_existing.response_payload IS NOT NULL
    THEN
      RETURN jsonb_set(v_existing.response_payload, '{finalizedOrder,replayed}', 'true'::jsonb, false);
    END IF;

    IF v_existing.status = 'completed' THEN
      v_completed_order_id := coalesce(
        nullif(v_existing.response_payload #>> '{finalizedOrder,orderId}', ''),
        nullif(v_existing.metadata ->> 'orderId', '')
      );
      IF v_completed_order_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        SELECT original.*
          INTO v_completed_order
          FROM public.commerce_orders original
         WHERE original.id = v_completed_order_id::uuid
         FOR UPDATE;
        IF FOUND AND v_completed_order.status IN (
          'paid', 'failed', 'expired', 'fulfillment_pending', 'fulfilled',
          'cancelled', 'refunded'
        ) THEN
          RAISE EXCEPTION 'commerce_runtime_finalize_journey_consumed' USING ERRCODE = '23505';
        END IF;
      END IF;
    END IF;

    RAISE EXCEPTION 'commerce_runtime_finalize_idempotency_conflict' USING ERRCODE = '23505';
  END IF;

  SELECT * INTO v_order
    FROM public.commerce_orders
   WHERE id = p_order_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'commerce_runtime_finalize_order_not_found' USING ERRCODE = '22023';
  END IF;
  IF v_order.status <> 'draft' THEN
    RAISE EXCEPTION 'commerce_runtime_finalize_order_not_draft' USING ERRCODE = '22023';
  END IF;
  IF v_order.metadata->'quoteSnapshot' IS DISTINCT FROM p_quote_snapshot
    OR v_order.metadata->'orderDraftSnapshot' IS DISTINCT FROM p_order_draft_snapshot
  THEN
    RAISE EXCEPTION 'commerce_runtime_finalize_snapshot_mismatch' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_client
    FROM public.clients
   WHERE id = p_client_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'commerce_runtime_finalize_client_not_found' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_address
    FROM public.addresses
   WHERE id = p_shipping_address_id
     AND client_id = p_client_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'commerce_runtime_finalize_shipping_address_not_owned' USING ERRCODE = '22023';
  END IF;

  IF p_pet_id IS NOT NULL THEN
    SELECT * INTO v_pet
      FROM public.pets
     WHERE id = p_pet_id
       AND client_id = p_client_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'commerce_runtime_finalize_pet_not_owned' USING ERRCODE = '22023';
    END IF;
  END IF;

  INSERT INTO public.commerce_idempotency_keys (
    scope,
    idempotency_key,
    request_fingerprint,
    status,
    metadata
  )
  VALUES (
    v_scope,
    p_idempotency_key,
    v_request_fingerprint,
    'in_progress',
    jsonb_build_object('boundary', 'commerce_finalize_order_for_checkout')
  );

  FOR v_item IN
    SELECT *
      FROM public.commerce_order_items
     WHERE order_id = p_order_id
     ORDER BY created_at, id
     FOR UPDATE
  LOOP
    SELECT * INTO v_sku
      FROM public.catalog_skus
     WHERE sku = v_item.product_snapshot->>'sku'
       AND status <> 'archived'
     LIMIT 1;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'commerce_runtime_finalize_unknown_sku: %', v_item.product_snapshot->>'sku'
        USING ERRCODE = '22023';
    END IF;

    UPDATE public.commerce_order_items
       SET sku_id = v_sku.id,
           mode_at_line = CASE WHEN p_mode = 'subscription_cycle' THEN 'subscription' ELSE 'one_time' END,
           variant_snapshot = jsonb_build_object(
             'skuId', v_sku.id,
             'sku', v_sku.sku,
             'title', v_sku.title,
             'petType', v_sku.pet_type,
             'netWeightG', v_sku.net_weight_g,
             'formatCode', v_sku.format_code,
             'unitFormCode', v_sku.unit_form_code,
             'kcalPerUnit', v_sku.kcal_per_unit,
             'source', 'commerce.runtime.hidden.v0'
           ),
           product_snapshot = product_snapshot || jsonb_build_object(
             'skuId', v_sku.id,
             'source', 'commerce.runtime.hidden.v0'
           )
     WHERE id = v_item.id;

    v_items := v_items || jsonb_build_object(
      'orderItemId', v_item.id,
      'skuId', v_sku.id,
      'sku', v_sku.sku,
      'quantity', v_item.quantity
    );
  END LOOP;

  IF jsonb_array_length(v_items) = 0 THEN
    RAISE EXCEPTION 'commerce_runtime_finalize_missing_order_items' USING ERRCODE = '22023';
  END IF;
  IF p_mode = 'subscription_cycle' AND v_order.subscription_id IS NULL THEN
    PERFORM private.commerce_assert_acquisition_admission(p_quote_snapshot, p_client_id);
    v_provisional := public.subscription_create_provisional_for_checkout(
      p_order_id,
      p_client_id,
      p_pet_id,
      p_shipping_address_id,
      p_quote_snapshot
    );
    v_subscription_id := (v_provisional->>'subscriptionId')::uuid;
    v_subscription_cycle_id := (v_provisional->>'subscriptionCycleId')::uuid;
  END IF;

  v_invoice_buyer_snapshot := CASE
    WHEN jsonb_typeof(coalesce(p_metadata, '{}'::jsonb)->'invoiceBuyerSnapshot') = 'object'
      THEN coalesce(p_metadata, '{}'::jsonb)->'invoiceBuyerSnapshot'
    ELSE NULL
  END;
  v_runtime_metadata := (coalesce(p_metadata, '{}'::jsonb) - 'invoiceBuyerSnapshot')
    || jsonb_build_object('source', 'commerce.runtime.hidden.v0');

  UPDATE public.commerce_orders
     SET client_id = p_client_id,
         shipping_address_id = p_shipping_address_id,
         pet_id = p_pet_id,
         mode = p_mode,
         subscription_id = COALESCE(v_subscription_id, subscription_id),
         subscription_cycle_id = COALESCE(v_subscription_cycle_id, subscription_cycle_id),
         metadata = metadata || jsonb_build_object(
           'clientId', p_client_id,
           'shippingAddressId', p_shipping_address_id,
           'petId', p_pet_id,
           'petSnapshot',
             CASE WHEN p_pet_id IS NULL THEN NULL ELSE jsonb_build_object(
               'id', v_pet.id,
               'clientId', v_pet.client_id,
               'petType', v_pet.pet_type,
               'name', v_pet.name,
               'breed', v_pet.breed,
               'ageLabel', v_pet.age_label,
               'weightKg', v_pet.weight_kg,
               'source', 'commerce.runtime.hidden.v0'
             ) END,
           'runtimeFinalize', v_runtime_metadata
         ) || CASE
           WHEN v_invoice_buyer_snapshot IS NULL THEN '{}'::jsonb
           ELSE jsonb_build_object('invoiceBuyerSnapshot', v_invoice_buyer_snapshot)
         END,
         updated_at = now()
   WHERE id = p_order_id
   RETURNING * INTO v_order;

  v_response := jsonb_build_object(
    'contractVersion', 'commerce.v0',
    'finalizedOrder', jsonb_build_object(
      'orderId', v_order.id,
      'orderRef', 'order_' || v_order.id::text,
      'mode', v_order.mode,
      'clientId', v_order.client_id,
      'petId', v_order.pet_id,
      'shippingAddressId', v_order.shipping_address_id,
      'subscriptionId', v_order.subscription_id,
      'subscriptionCycleId', v_order.subscription_cycle_id,
      'total', jsonb_build_object('amountMinor', v_order.total_cents, 'currency', v_order.currency),
      'items', v_items,
      'replayed', false
    )
  );

  UPDATE public.commerce_idempotency_keys
     SET status = 'completed',
         response_payload = v_response,
         metadata = metadata || jsonb_build_object('orderId', v_order.id)
   WHERE scope = v_scope
     AND idempotency_key = p_idempotency_key;

  RETURN v_response;
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_finalize_order_for_checkout(text,uuid,text,uuid,uuid,uuid,jsonb,jsonb,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_finalize_order_for_checkout(text,uuid,text,uuid,uuid,uuid,jsonb,jsonb,jsonb) TO service_role;
