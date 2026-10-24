CREATE OR REPLACE FUNCTION public.fulfillment_reserve_subscription_renewal(
  p_operation_id uuid,
  p_claim_token uuid,
  p_hold_seconds integer DEFAULT 900,
  p_now timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  v_operation public.subscription_renewal_operations%ROWTYPE;
  v_reservation public.fulfillment_inventory_reservations%ROWTYPE;
  v_line jsonb;
  v_source text;
  v_sku text;
  v_quantity integer;
  v_available integer;
BEGIN
  IF p_operation_id IS NULL OR p_claim_token IS NULL
    OR p_hold_seconds IS NULL OR p_hold_seconds NOT BETWEEN 60 AND 86400
  THEN
    RAISE EXCEPTION 'fulfillment_renewal_reservation_invalid_input' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_operation FROM public.subscription_renewal_operations
   WHERE id = p_operation_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'fulfillment_renewal_reservation_operation_not_found' USING ERRCODE = '22023';
  END IF;
  IF v_operation.claim_token <> p_claim_token
    OR v_operation.lease_expires_at <= COALESCE(p_now, now())
  THEN
    RAISE EXCEPTION 'fulfillment_renewal_reservation_stale_claim' USING ERRCODE = '40001';
  END IF;

  SELECT * INTO v_reservation FROM public.fulfillment_inventory_reservations
   WHERE renewal_operation_id = p_operation_id FOR UPDATE;
  IF FOUND THEN
    IF v_reservation.operation_fingerprint <> v_operation.operation_fingerprint THEN
      RAISE EXCEPTION 'fulfillment_renewal_reservation_fingerprint_conflict' USING ERRCODE = '23505';
    END IF;
    IF v_reservation.status = 'held'
      AND v_reservation.expires_at <= COALESCE(p_now, now())
      AND v_operation.state = 'reserved'
    THEN
      UPDATE public.fulfillment_inventory_reservations
         SET status = 'expired', expires_at = NULL,
             terminal_reason = 'reservation_expired', updated_at = COALESCE(p_now, now())
       WHERE id = v_reservation.id
       RETURNING * INTO v_reservation;
      UPDATE public.subscription_renewal_operations
         SET state = 'refused', terminal_outcome = 'refused',
             terminal_reason = 'reservation_expired', terminal_at = COALESCE(p_now, now()),
             updated_at = COALESCE(p_now, now())
       WHERE id = p_operation_id RETURNING * INTO v_operation;
      INSERT INTO public.subscription_renewal_outcomes (
        renewal_operation_id, operation_fingerprint, event_key, outcome, reason, occurred_at
      ) VALUES (
        p_operation_id, v_operation.operation_fingerprint,
        v_operation.identity_key || ':reservation-expired', 'refused',
        'reservation_expired', COALESCE(p_now, now()));
      RETURN jsonb_build_object(
        'reserved', false, 'replayed', true, 'reservationId', v_reservation.id,
        'status', 'expired', 'reason', 'reservation_expired');
    END IF;
    RETURN jsonb_build_object(
      'reserved', v_reservation.status IN ('held', 'committed', 'consumed'),
      'replayed', true, 'reservationId', v_reservation.id,
      'status', v_reservation.status, 'reason', v_reservation.terminal_reason);
  END IF;

  IF v_operation.state <> 'claimed' THEN
    RAISE EXCEPTION 'fulfillment_renewal_reservation_invalid_state' USING ERRCODE = '22023';
  END IF;
  v_source := v_operation.cycle_snapshot->>'stockSourceKey';
  IF v_source IS NULL OR v_source !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$' THEN
    RAISE EXCEPTION 'fulfillment_renewal_reservation_invalid_snapshot' USING ERRCODE = '22023';
  END IF;

  -- Lock all stock rows in a deterministic order before computing ATP, so two different
  -- operations containing the same SKUs cannot both spend the same observed availability.
  PERFORM stock.sku
    FROM public.fulfillment_stock_current stock
    JOIN jsonb_array_elements(v_operation.cycle_snapshot->'lines') line
      ON stock.source_key = v_source AND stock.sku = line->>'sku'
   ORDER BY stock.sku
   FOR UPDATE OF stock;

  FOR v_line IN SELECT value FROM jsonb_array_elements(v_operation.cycle_snapshot->'lines')
  LOOP
    v_sku := v_line->>'sku';
    BEGIN v_quantity := (v_line->>'quantity')::integer;
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
      RAISE EXCEPTION 'fulfillment_renewal_reservation_invalid_snapshot' USING ERRCODE = '22023';
    END;
    IF btrim(COALESCE(v_sku, '')) = '' OR v_quantity < 1 THEN
      RAISE EXCEPTION 'fulfillment_renewal_reservation_invalid_snapshot' USING ERRCODE = '22023';
    END IF;

    SELECT (public.inventory_available_to_promise(v_source,v_sku,COALESCE(p_now,now()),true)
      ->>'available_quantity')::integer INTO v_available;
    IF v_available < v_quantity THEN
      UPDATE public.subscription_renewal_operations
         SET state = 'refused', terminal_outcome = 'refused',
             terminal_reason = 'inventory_unavailable', terminal_at = COALESCE(p_now, now()),
             updated_at = COALESCE(p_now, now())
       WHERE id = p_operation_id RETURNING * INTO v_operation;
      INSERT INTO public.subscription_renewal_outcomes (
        renewal_operation_id, operation_fingerprint, event_key, outcome, reason, occurred_at
      ) VALUES (
        p_operation_id, v_operation.operation_fingerprint,
        v_operation.identity_key || ':inventory', 'refused', 'inventory_unavailable',
        COALESCE(p_now, now()));
      RETURN jsonb_build_object(
        'reserved', false, 'replayed', false, 'reservationId', NULL,
        'status', 'refused', 'reason', 'inventory_unavailable');
    END IF;
  END LOOP;

  INSERT INTO public.fulfillment_inventory_reservations (
    renewal_operation_id, operation_fingerprint, source_key, expires_at, created_at, updated_at
  ) VALUES (
    p_operation_id, v_operation.operation_fingerprint, v_source,
    COALESCE(p_now, now()) + make_interval(secs => p_hold_seconds),
    COALESCE(p_now, now()), COALESCE(p_now, now())
  ) RETURNING * INTO v_reservation;

  FOR v_line IN SELECT value FROM jsonb_array_elements(v_operation.cycle_snapshot->'lines')
  LOOP
    INSERT INTO public.fulfillment_inventory_reservation_lines (
      reservation_id, operation_fingerprint, sku, quantity
    ) VALUES (
      v_reservation.id, v_operation.operation_fingerprint,
      v_line->>'sku', (v_line->>'quantity')::integer);
  END LOOP;

  UPDATE public.subscription_renewal_operations
     SET state = 'reserved', updated_at = COALESCE(p_now, now())
   WHERE id = p_operation_id;
  RETURN jsonb_build_object(
    'reserved', true, 'replayed', false, 'reservationId', v_reservation.id,
    'status', 'held', 'reason', NULL);
END;
$$;
