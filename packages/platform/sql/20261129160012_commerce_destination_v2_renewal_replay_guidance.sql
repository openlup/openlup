CREATE OR REPLACE FUNCTION public.commerce_register_order_destination_v2(p_ctx jsonb, p_order_id uuid, p_kind text, p_scope_ref uuid,
  p_expected_selection_revision uuid, p_expected_binding jsonb, p_expected_service jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_replay boolean := current_setting('transaction_isolation') = 'read committed';
  v_found uuid;
  v_bound public.commerce_destination_v2_order_bindings;
  v_result jsonb;
  v_selection jsonb := jsonb_build_object('kind', 'checkout', 'scopeRef', p_scope_ref, 'selectionRevision', p_expected_selection_revision);
BEGIN
  IF p_kind IS DISTINCT FROM 'checkout' THEN RETURN public.commerce_destination_v2_refusal('kind', 'version'); END IF;
  IF p_order_id IS NULL THEN RETURN public.commerce_destination_v2_refusal('input', 'orderId'); END IF;
  IF NOT public.commerce_destination_v2_valid_context(p_ctx, p_scope_ref) THEN
    RETURN public.commerce_destination_v2_refusal('owner', 'owner');
  END IF;
  IF v_replay THEN
    LOCK TABLE public.identity_privacy_erasures IN SHARE MODE;
    PERFORM 1 FROM public.clients WHERE id = (p_ctx->>'clientId')::uuid FOR KEY SHARE;
    -- Acquire the row lock's implicit table lock outside the NOWAIT handler.
    LOCK TABLE public.commerce_orders IN ROW SHARE MODE;
  ELSIF current_setting('transaction_isolation') <> 'repeatable read' THEN
    RETURN public.commerce_destination_v2_refusal('isolation', 'isolation');
  END IF;
  BEGIN
    SELECT id INTO v_found FROM public.commerce_orders WHERE id = p_order_id
      AND client_id = (p_ctx->>'clientId')::uuid FOR UPDATE NOWAIT;
  EXCEPTION WHEN lock_not_available THEN
    RETURN public.commerce_destination_v2_refusal('busy', 'orderId');
  END;
  IF v_found IS NULL THEN RETURN public.commerce_destination_v2_refusal('unavailable', 'orderId'); END IF;
  IF v_replay THEN
    -- A separate RC statement can see a child committed while this invocation waited.
    SELECT * INTO v_bound FROM public.commerce_destination_v2_order_bindings WHERE order_id = p_order_id;
    v_result := public.commerce_destination_v2_check_retained(p_ctx, v_bound, 'orderId');
    IF v_result ? 'outcome' THEN RETURN v_result; END IF;
    IF NOT public.commerce_destination_v2_valid_binding(p_expected_binding) THEN
      RETURN public.commerce_destination_v2_refusal('binding', 'destination');
    END IF;
    IF NOT public.commerce_destination_v2_valid_pins(v_selection, p_expected_service, p_scope_ref) THEN
      RETURN public.commerce_destination_v2_refusal('binding', CASE WHEN p_expected_selection_revision IS NULL THEN 'destination' ELSE 'selectedDelivery' END);
    END IF;
    IF p_expected_binding IS DISTINCT FROM v_result->'binding' OR v_selection IS DISTINCT FROM v_bound.selection
      OR p_expected_service IS DISTINCT FROM v_bound.service THEN
      v_result := public.commerce_destination_v2_refusal('occupied', 'orderId');
      IF v_bound.selection->>'kind' = 'subscription' THEN
        RETURN v_result || jsonb_build_object('recheck',
          'Use the authorized subscription workflow to read the retained destination for this order.');
      END IF;
      RETURN v_result;
    END IF;
    RETURN v_result->'binding';
  END IF;
  -- The fence already holds the guards, and the caller passes this writer's inserted order.
  v_result := public.commerce_recheck_destination_v2(p_ctx, p_kind, p_scope_ref,
    p_expected_selection_revision, p_expected_binding, p_expected_service);
  IF v_result ? 'outcome' THEN RETURN v_result; END IF;
  INSERT INTO public.commerce_destination_v2_order_bindings (order_id, snapshot_ref, selection, service)
    VALUES (p_order_id, (p_expected_binding->>'snapshotRef')::uuid, v_result->'selection', v_result->'service');
  RETURN v_result->'binding';
END;
$$;
