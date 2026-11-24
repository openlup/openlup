CREATE OR REPLACE FUNCTION public.fulfillment_record_stock_current(
  p_source_key text, p_idempotency_key text, p_fingerprint text, p_sku text,
  p_total integer, p_for_sale integer, p_reserved_unavailable integer,
  p_inventory_class text, p_last_synced_at timestamptz, p_stale_after timestamptz,
  p_sync_run_id text
) RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE v_fingerprint text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_idempotency_key, 0));
  SELECT operation_fingerprint INTO v_fingerprint
    FROM public.fulfillment_stock_operations
   WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_fingerprint <> p_fingerprint THEN
      RAISE EXCEPTION 'fulfillment_stock_current_idempotency_conflict' USING ERRCODE = '23505',
        DETAIL = 'openlup:stock_current:replay_conflict';
    END IF;
    RETURN jsonb_build_object('replayed', true, 'readBack', true);
  END IF;
  INSERT INTO public.fulfillment_stock_current(
    source_key, sku, total_quantity, for_sale_quantity, reserved_unavailable_quantity,
    inventory_class, last_synced_at, stale_after, sync_run_id, idempotency_key,
    operation_fingerprint
  ) VALUES (
    p_source_key, p_sku, p_total, p_for_sale, p_reserved_unavailable,
    p_inventory_class, p_last_synced_at, p_stale_after, p_sync_run_id,
    p_idempotency_key, p_fingerprint
  ) ON CONFLICT (source_key, sku) DO UPDATE SET
    total_quantity = EXCLUDED.total_quantity,
    for_sale_quantity = EXCLUDED.for_sale_quantity,
    reserved_unavailable_quantity = EXCLUDED.reserved_unavailable_quantity,
    inventory_class = EXCLUDED.inventory_class,
    last_synced_at = EXCLUDED.last_synced_at,
    stale_after = EXCLUDED.stale_after,
    sync_run_id = EXCLUDED.sync_run_id,
    idempotency_key = EXCLUDED.idempotency_key,
    operation_fingerprint = EXCLUDED.operation_fingerprint,
    updated_at = now();
  INSERT INTO public.fulfillment_stock_operations(
    idempotency_key, operation_fingerprint, source_key, sku
  ) VALUES (p_idempotency_key, p_fingerprint, p_source_key, p_sku);
  RETURN jsonb_build_object('replayed', false, 'readBack', true);
END $$;
