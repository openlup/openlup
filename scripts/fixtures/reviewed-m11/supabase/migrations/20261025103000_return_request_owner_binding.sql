-- CTL-M11 reviewed fixture: resolve the server-supplied principal to its customer,
-- lock only that customer's order, and bind both fresh and replayed return keys
-- to the same principal, order and normalized command. Reconstruct old command
-- fingerprints without updating historical requests. Preserve duplicate lines,
-- eligibility, response shape and the incumbent reason/disposition vocabulary.
-- A nonblocking global-key gate refuses another in-flight customer uniformly;
-- a constraint-specific unique-violation handler covers direct-insert races.
-- Preserve SECURITY DEFINER, public/pg_catalog path and service-only execution.
-- Admitted pin: config/reviewed-platform-forwards.json managedCommerceForwards.
-- M11 feature PRs (the K1 stack) introduce these bytes in registry order.
-- This file requires every earlier same-rail M10/M11 pin to have landed.
-- Pin admission does not establish installation or runtime behavior.

CREATE OR REPLACE FUNCTION public.commerce_return_request_create(p_idempotency_key text, p_order_id uuid, p_lines jsonb, p_reason_code text, p_customer_note text DEFAULT NULL::text, p_requested_by uuid DEFAULT NULL::uuid) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_order public.commerce_orders%ROWTYPE;
  v_request public.commerce_return_requests%ROWTYPE;
  v_item public.commerce_order_items%ROWTYPE;
  v_client_id uuid;
  v_constraint text;
  v_lines jsonb;
  v_fingerprint text;
  v_prior_fingerprint text;
  v_line jsonb;
  v_quantity integer;
  v_sku text;
  v_disposition text;
BEGIN
  IF p_idempotency_key IS NULL OR length(btrim(p_idempotency_key)) < 8
    OR p_order_id IS NULL
    OR p_reason_code NOT IN ('damaged','wrong_item','not_as_described','pet_refused','changed_mind','other')
    OR p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0
  THEN
    RAISE EXCEPTION 'commerce_return_request_invalid_input' USING ERRCODE = '22023';
  END IF;

  SELECT id INTO v_client_id FROM public.clients WHERE auth_user_id = p_requested_by;
  IF v_client_id IS NULL THEN
    RAISE EXCEPTION 'commerce_return_request_order_not_found' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_order FROM public.commerce_orders
    WHERE id = p_order_id AND client_id = v_client_id FOR UPDATE;
  IF v_order.id IS NULL THEN
    RAISE EXCEPTION 'commerce_return_request_order_not_found' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_request FROM public.commerce_return_requests
    WHERE idempotency_key = btrim(p_idempotency_key);
  IF FOUND AND (v_request.requested_by IS DISTINCT FROM p_requested_by
    OR v_request.order_id IS DISTINCT FROM p_order_id) THEN
    RAISE EXCEPTION 'commerce_return_request_order_not_found' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    'commerce-return-request:' || v_client_id::text || ':' || btrim(p_idempotency_key), 0));
  SELECT * INTO v_request FROM public.commerce_return_requests
    WHERE idempotency_key = btrim(p_idempotency_key);
  IF FOUND THEN
    IF v_request.requested_by IS DISTINCT FROM p_requested_by
      OR v_request.order_id IS DISTINCT FROM p_order_id THEN
      RAISE EXCEPTION 'commerce_return_request_order_not_found' USING ERRCODE = '22023';
    END IF;

    SELECT jsonb_agg(line ORDER BY line) INTO v_lines FROM (
      SELECT jsonb_build_object(
        'orderItemId', (value->>'orderItemId')::uuid,
        'quantity', NULLIF(value->>'quantity', '')::integer,
        'sku', COALESCE(NULLIF(btrim(value->>'sku'), ''), item.product_snapshot->>'sku', 'unknown'),
        'restockDisposition', COALESCE(NULLIF(btrim(value->>'restockDisposition'), ''), 'restock')
      ) AS line
      FROM jsonb_array_elements(p_lines)
      LEFT JOIN public.commerce_order_items item
        ON item.id = (value->>'orderItemId')::uuid AND item.order_id = p_order_id
    ) normalized;
    v_fingerprint := encode(sha256(convert_to(jsonb_build_object(
      'orderId', p_order_id, 'requestedBy', p_requested_by, 'reasonCode', p_reason_code,
      'customerNote', NULLIF(btrim(coalesce(p_customer_note, '')), ''),
      'lines', v_lines)::text, 'UTF8')), 'hex');
    SELECT payload->>'commandFingerprint' INTO v_prior_fingerprint
      FROM public.commerce_return_operations
      WHERE return_request_id = v_request.id AND operation_type = 'requested'
        AND idempotency_key = btrim(p_idempotency_key) || ':requested';
    IF v_prior_fingerprint IS NULL THEN
      SELECT jsonb_agg(line ORDER BY line) INTO v_lines FROM (
        SELECT jsonb_build_object(
          'orderItemId', order_item_id, 'quantity', quantity,
          'sku', sku, 'restockDisposition', restock_disposition
        ) AS line
        FROM public.commerce_return_lines WHERE return_request_id = v_request.id
      ) normalized;
      v_prior_fingerprint := encode(sha256(convert_to(jsonb_build_object(
        'orderId', v_request.order_id, 'requestedBy', v_request.requested_by,
        'reasonCode', v_request.reason_code, 'customerNote', v_request.customer_note,
        'lines', v_lines)::text, 'UTF8')), 'hex');
    END IF;
    IF v_prior_fingerprint IS DISTINCT FROM v_fingerprint THEN
      RAISE EXCEPTION 'commerce_return_request_order_not_found' USING ERRCODE = '22023';
    END IF;
    RETURN jsonb_build_object(
      'contractVersion', 'commerce.returns.v0', 'returnRequestId', v_request.id,
      'status', v_request.status, 'replayed', true
    );
  END IF;

  IF NOT pg_try_advisory_xact_lock(hashtextextended(
    'commerce-return-request-key:' || btrim(p_idempotency_key), 0)) THEN
    RAISE EXCEPTION 'commerce_return_request_order_not_found' USING ERRCODE = '22023';
  END IF;
  IF v_order.status NOT IN ('paid','fulfilled') THEN
    RAISE EXCEPTION 'commerce_return_request_order_not_returnable' USING ERRCODE = '22023';
  END IF;

  BEGIN
    INSERT INTO public.commerce_return_requests (
      order_id, status, reason_code, customer_note, requested_by, idempotency_key
    ) VALUES (
      p_order_id, 'requested', p_reason_code, NULLIF(btrim(coalesce(p_customer_note, '')), ''),
      p_requested_by, btrim(p_idempotency_key)
    ) RETURNING * INTO v_request;
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    IF v_constraint = 'commerce_return_requests_idempotency_key_key' THEN
      RAISE EXCEPTION 'commerce_return_request_order_not_found' USING ERRCODE = '22023';
    END IF;
    RAISE;
  END;

  FOR v_line IN SELECT value FROM jsonb_array_elements(p_lines) LOOP
    v_quantity := NULLIF(v_line->>'quantity', '')::integer;
    v_sku := btrim(coalesce(v_line->>'sku', ''));
    v_disposition := coalesce(NULLIF(btrim(coalesce(v_line->>'restockDisposition', '')), ''), 'restock');
    IF v_quantity IS NULL OR v_quantity <= 0 OR (v_line->>'orderItemId') IS NULL THEN
      RAISE EXCEPTION 'commerce_return_request_invalid_line' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO v_item FROM public.commerce_order_items
      WHERE id = (v_line->>'orderItemId')::uuid AND order_id = p_order_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'commerce_return_request_line_not_in_order' USING ERRCODE = '22023';
    END IF;
    IF v_quantity > v_item.quantity THEN
      RAISE EXCEPTION 'commerce_return_request_quantity_exceeds_ordered' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.commerce_return_lines (
      return_request_id, order_item_id, sku, quantity, restock_disposition
    ) VALUES (
      v_request.id, v_item.id,
      coalesce(NULLIF(v_sku, ''), coalesce(v_item.product_snapshot->>'sku', 'unknown')),
      v_quantity, v_disposition
    );
  END LOOP;

  SELECT jsonb_agg(line ORDER BY line) INTO v_lines FROM (
    SELECT jsonb_build_object(
      'orderItemId', order_item_id, 'quantity', quantity,
      'sku', sku, 'restockDisposition', restock_disposition
    ) AS line
    FROM public.commerce_return_lines WHERE return_request_id = v_request.id
  ) normalized;
  v_fingerprint := encode(sha256(convert_to(jsonb_build_object(
    'orderId', p_order_id, 'requestedBy', p_requested_by, 'reasonCode', p_reason_code,
    'customerNote', v_request.customer_note, 'lines', v_lines)::text, 'UTF8')), 'hex');
  INSERT INTO public.commerce_return_operations (
    return_request_id, actor_user_id, operation_type, source, idempotency_key, payload
  ) VALUES (
    v_request.id, p_requested_by, 'requested', 'customer',
    btrim(p_idempotency_key) || ':requested',
    jsonb_build_object('reasonCode', p_reason_code, 'commandFingerprint', v_fingerprint)
  ) ON CONFLICT (idempotency_key) DO NOTHING;
  RETURN jsonb_build_object(
    'contractVersion', 'commerce.returns.v0', 'returnRequestId', v_request.id,
    'status', v_request.status, 'replayed', false
  );
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_return_request_create(text,uuid,jsonb,text,text,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_return_request_create(text,uuid,jsonb,text,text,uuid) TO service_role;
