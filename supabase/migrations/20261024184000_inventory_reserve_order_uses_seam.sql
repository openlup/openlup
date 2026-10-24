-- M06 reviewed replacement: preserve allocator locks, refusals and lifecycle.
-- Provider availability comes only from the shared ATP seam; renewal exemption
-- requires the actual order/cycle relationship, never a hold kind or metadata.

CREATE OR REPLACE FUNCTION public.inventory_reserve_order(p_idempotency_key text, p_order_id uuid, p_order_item_id uuid, p_subscription_cycle_id uuid, p_sku_id uuid, p_quantity integer, p_kind text, p_payment_status text, p_expires_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_metadata jsonb DEFAULT '{}'::jsonb, p_provider_kind text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_catalog'
    AS $_$
DECLARE
  v_existing jsonb;
  v_balance public.inventory_balances%ROWTYPE;
  v_location_id uuid;
  v_location_code text;
  v_remaining integer;
  v_allocate integer;
  v_reservation_id uuid;
  v_first_reservation_id uuid;
  v_reservation_ids jsonb := '[]'::jsonb;
  v_provider_stock record;
  v_provider_stock_rows integer;
  v_sku text;
  v_provider_available integer;
  v_active_reserved integer;
BEGIN
  IF p_payment_status NOT IN ('created', 'requires_action', 'processing', 'succeeded') THEN
    RAISE EXCEPTION 'inventory_reservation_payment_status_not_reservable' USING ERRCODE = '22023';
  END IF;
  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'inventory_reservation_invalid_quantity' USING ERRCODE = '22023';
  END IF;

  SELECT jsonb_build_object(
    'contractVersion', 'inventory.v0',
    'reservationId', id,
    'status', status,
    'replayed', true
  )
    INTO v_existing
    FROM public.inventory_reservations
   WHERE idempotency_key = p_idempotency_key
     AND sku_id = p_sku_id
   LIMIT 1;
  IF v_existing IS NOT NULL THEN
    RETURN v_existing;
  END IF;

  IF p_provider_kind = 'omnipack' THEN
    SELECT sku INTO v_sku
      FROM public.catalog_skus
     WHERE id = p_sku_id;
    IF v_sku IS NULL THEN
      RAISE EXCEPTION 'inventory_external_provider_sku_not_found' USING ERRCODE = '22023';
    END IF;

    IF to_regclass('public.fulfillment_provider_stock_current') IS NULL THEN
      RAISE EXCEPTION 'inventory_external_provider_stock_missing' USING ERRCODE = '23514';
    END IF;

    EXECUTE
      'SELECT provider_for_sale_quantity, stale_after, last_synced_at
         FROM public.fulfillment_provider_stock_current
        WHERE provider_kind = $1
          AND catalog_sku_id = $2
        FOR UPDATE'
      INTO v_provider_stock
      USING p_provider_kind, p_sku_id;
    GET DIAGNOSTICS v_provider_stock_rows = ROW_COUNT;
    IF v_provider_stock_rows = 0 THEN
      RAISE EXCEPTION 'inventory_external_provider_stock_missing' USING ERRCODE = '23514';
    END IF;
    IF v_provider_stock.stale_after <= now() THEN
      RAISE EXCEPTION 'inventory_external_provider_stock_stale' USING ERRCODE = '23514';
    END IF;

    SELECT atp.available_quantity INTO v_provider_available
      FROM public.inventory_available_to_promise(
        p_sku_id, now(),
        EXISTS (
          SELECT 1 FROM public.commerce_orders o
          JOIN public.subscription_cycles c ON c.id=o.subscription_cycle_id
           WHERE o.id=p_order_id AND o.mode='subscription_cycle'
             AND c.id=p_subscription_cycle_id
        )
      ) atp;
    IF v_provider_available < p_quantity THEN
      RAISE EXCEPTION 'inventory_external_provider_insufficient_available_stock' USING ERRCODE = '23514';
    END IF;

    SELECT id, code
      INTO v_location_id, v_location_code
      FROM public.inventory_locations
     WHERE code = 'omnipack-stock-master'
       AND status = 'active'
       AND fulfillable = true
     LIMIT 1;
    IF v_location_id IS NULL THEN
      RAISE EXCEPTION 'inventory_external_provider_location_missing' USING ERRCODE = '23514';
    END IF;

    INSERT INTO public.inventory_balances (sku_id, location_id, lot_id, on_hand)
    VALUES (p_sku_id, v_location_id, NULL, v_provider_stock.provider_for_sale_quantity)
    ON CONFLICT ON CONSTRAINT inventory_balances_unique_stock_key DO NOTHING;

    SELECT *
      INTO v_balance
      FROM public.inventory_balances
     WHERE sku_id = p_sku_id
       AND location_id = v_location_id
       AND lot_id IS NULL
     FOR UPDATE;

    UPDATE public.inventory_balances
       SET on_hand = greatest(v_balance.on_hand, v_provider_stock.provider_for_sale_quantity, v_balance.reserved + p_quantity),
           updated_at = now()
     WHERE id = v_balance.id
     RETURNING * INTO v_balance;

    INSERT INTO public.inventory_reservations (
      idempotency_key, order_id, order_item_id, subscription_cycle_id, sku_id,
      location_id, lot_id, quantity, kind, expires_at, metadata
    )
    VALUES (
      p_idempotency_key, p_order_id, p_order_item_id, p_subscription_cycle_id, p_sku_id,
      v_location_id, NULL, p_quantity, p_kind,
      coalesce(
        p_expires_at,
        now() + CASE WHEN p_kind = 'subscription_retry_window' THEN interval '72 hours' ELSE interval '30 minutes' END
      ),
      coalesce(p_metadata, '{}'::jsonb)
        || jsonb_build_object(
          'providerKind', p_provider_kind,
          'stockAuthority', 'external_stock_master_with_local_reservations',
          'providerForSaleAtReservation', v_provider_stock.provider_for_sale_quantity,
          'providerStockSyncedAt', v_provider_stock.last_synced_at
        )
    )
    RETURNING id INTO v_reservation_id;

    UPDATE public.inventory_balances
       SET reserved = reserved + p_quantity,
           updated_at = now()
     WHERE id = v_balance.id;

    INSERT INTO public.inventory_stock_movements (
      idempotency_key, movement_type, sku_id, location_id, lot_id, reservation_id,
      quantity_delta, reason, metadata
    )
    VALUES (
      p_idempotency_key || ':' || v_reservation_id::text,
      'reservation_created',
      p_sku_id,
      v_location_id,
      NULL,
      v_reservation_id,
      p_quantity,
      'order_reserved',
      coalesce(p_metadata, '{}'::jsonb)
        || jsonb_build_object('providerKind', p_provider_kind, 'stockAuthority', 'external_stock_master_with_local_reservations')
    );

    RETURN jsonb_build_object(
      'contractVersion', 'inventory.v0',
      'reservationId', v_reservation_id,
      'reservationIds', jsonb_build_array(v_reservation_id),
      'locationId', v_location_id,
      'locationCode', v_location_code,
      'status', 'reserved',
      'stockAuthority', 'external_stock_master_with_local_reservations',
      'replayed', false
    );
  END IF;

  SELECT b.location_id, min(l.code)
    INTO v_location_id, v_location_code
    FROM public.inventory_balances b
    JOIN public.inventory_locations l ON l.id = b.location_id
    LEFT JOIN public.inventory_lots lot ON lot.id = b.lot_id
   WHERE b.sku_id = p_sku_id
     AND l.status = 'active'
     AND l.fulfillable = true
     AND (lot.id IS NULL OR (lot.status = 'available' AND (lot.expires_at IS NULL OR lot.expires_at > now())))
   GROUP BY b.location_id
  HAVING sum(greatest(
    0,
    b.on_hand
      - b.unavailable
      - b.safety_stock
      - coalesce((
          SELECT sum(r.quantity)
            FROM public.inventory_reservations r
           WHERE r.sku_id = b.sku_id
             AND r.location_id = b.location_id
             AND r.lot_id IS NOT DISTINCT FROM b.lot_id
             AND r.status = 'reserved'
             AND (r.expires_at IS NULL OR r.expires_at > now())
        ), 0)
  )) >= p_quantity
   ORDER BY min(l.code)
   LIMIT 1;

  IF v_location_id IS NULL THEN
    RAISE EXCEPTION 'inventory_reservation_insufficient_available_stock' USING ERRCODE = '23514';
  END IF;

  v_remaining := p_quantity;

  FOR v_balance IN
    SELECT b.*
    FROM public.inventory_balances b
    JOIN public.inventory_locations l ON l.id = b.location_id
    LEFT JOIN public.inventory_lots lot ON lot.id = b.lot_id
   WHERE b.sku_id = p_sku_id
     AND b.location_id = v_location_id
     AND l.status = 'active'
     AND l.fulfillable = true
     AND (lot.id IS NULL OR (lot.status = 'available' AND (lot.expires_at IS NULL OR lot.expires_at > now())))
   ORDER BY lot.expires_at NULLS LAST, l.code
   FOR UPDATE OF b
  LOOP
    EXIT WHEN v_remaining <= 0;

    SELECT coalesce(sum(r.quantity), 0)
      INTO v_active_reserved
      FROM public.inventory_reservations r
     WHERE r.sku_id = v_balance.sku_id
       AND r.location_id = v_balance.location_id
       AND r.lot_id IS NOT DISTINCT FROM v_balance.lot_id
       AND r.status = 'reserved'
       AND (r.expires_at IS NULL OR r.expires_at > now());

    v_allocate := least(
      v_remaining,
      greatest(0, v_balance.on_hand - v_active_reserved - v_balance.unavailable - v_balance.safety_stock)
    );
    CONTINUE WHEN v_allocate <= 0;

    INSERT INTO public.inventory_reservations (
      idempotency_key, order_id, order_item_id, subscription_cycle_id, sku_id,
      location_id, lot_id, quantity, kind, expires_at, metadata
    )
    VALUES (
      p_idempotency_key, p_order_id, p_order_item_id, p_subscription_cycle_id, p_sku_id,
      v_balance.location_id, v_balance.lot_id, v_allocate, p_kind,
      coalesce(
        p_expires_at,
        now() + CASE WHEN p_kind = 'subscription_retry_window' THEN interval '72 hours' ELSE interval '30 minutes' END
      ),
      coalesce(p_metadata, '{}'::jsonb)
    )
    RETURNING id INTO v_reservation_id;

    v_first_reservation_id := coalesce(v_first_reservation_id, v_reservation_id);
    v_reservation_ids := v_reservation_ids || to_jsonb(v_reservation_id);

    UPDATE public.inventory_balances
       SET reserved = reserved + v_allocate,
           updated_at = now()
     WHERE id = v_balance.id;

    INSERT INTO public.inventory_stock_movements (
      idempotency_key, movement_type, sku_id, location_id, lot_id, reservation_id,
      quantity_delta, reason, metadata
    )
    VALUES (
      p_idempotency_key || ':' || v_reservation_id::text, 'reservation_created',
      p_sku_id, v_balance.location_id, v_balance.lot_id, v_reservation_id,
      v_allocate, 'order_reserved', coalesce(p_metadata, '{}'::jsonb)
    );

    v_remaining := v_remaining - v_allocate;
  END LOOP;

  IF v_remaining <> 0 THEN
    RAISE EXCEPTION 'inventory_reservation_allocation_incomplete' USING ERRCODE = '23514';
  END IF;

  RETURN jsonb_build_object(
    'contractVersion', 'inventory.v0',
    'reservationId', v_first_reservation_id,
    'reservationIds', v_reservation_ids,
    'locationId', v_location_id,
    'locationCode', v_location_code,
    'status', 'reserved',
    'replayed', false
  );
END;
$_$;

