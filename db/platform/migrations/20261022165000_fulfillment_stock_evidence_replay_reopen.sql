CREATE OR REPLACE FUNCTION public.fulfillment_record_stock_evidence(
  p_source_key text, p_idempotency_key text, p_fingerprint text, p_sku text,
  p_threshold_kind text, p_severity text, p_provider_for_sale integer,
  p_local_available integer
) RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE v_existing public.fulfillment_stock_evidence%ROWTYPE;
BEGIN
  SELECT * INTO v_existing FROM public.fulfillment_stock_evidence
   WHERE idempotency_key = p_idempotency_key FOR UPDATE;
  IF FOUND THEN
    IF v_existing.operation_fingerprint <> p_fingerprint THEN
      RAISE EXCEPTION 'fulfillment_stock_evidence_idempotency_conflict' USING ERRCODE = '23505';
    END IF;
    UPDATE public.fulfillment_stock_evidence SET
      status = 'open', severity = p_severity,
      provider_for_sale_quantity = p_provider_for_sale,
      local_available_quantity = p_local_available,
      last_seen_at = clock_timestamp(), resolved_at = NULL
     WHERE idempotency_key = p_idempotency_key;
    RETURN jsonb_build_object('replayed', true);
  END IF;
  INSERT INTO public.fulfillment_stock_evidence(
    idempotency_key, operation_fingerprint, source_key, sku, threshold_kind,
    severity, provider_for_sale_quantity, local_available_quantity
  ) VALUES (
    p_idempotency_key, p_fingerprint, p_source_key, p_sku, p_threshold_kind,
    p_severity, p_provider_for_sale, p_local_available
  );
  RETURN jsonb_build_object('replayed', false);
END $$;
