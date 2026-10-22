-- Managed correction v2: donor bodies and service-only fixed-path definer authority.
CREATE FUNCTION public.accounting_invoice_correction_outbox_claim(
  p_limit integer,
  p_lease_seconds integer,
  p_contract_version text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_rows jsonb;
BEGIN
  IF p_contract_version IS DISTINCT FROM 'accounting.correction.v2' THEN
    RAISE EXCEPTION 'accounting_invoice_correction_claim_contract_required' USING ERRCODE = '22023';
  END IF;
  WITH candidates AS (
    SELECT outbox.id
      FROM public.accounting_invoice_correction_outbox outbox
      JOIN public.accounting_invoices invoice ON invoice.id = outbox.invoice_id
     WHERE invoice.status = 'correction_requested'
       AND invoice.provider_invoice_id IS NOT NULL
       AND (outbox.attempt_count = 0
         OR outbox.payload->>'providerCreateIdentity' = 'accounting-correction:' || outbox.id::text)
       AND (
         outbox.status = 'pending'
         OR (outbox.status = 'failed' AND coalesce(outbox.next_attempt_at, outbox.created_at) <= now())
         OR (outbox.status = 'processing' AND outbox.next_attempt_at <= now())
       )
     ORDER BY outbox.created_at
     LIMIT greatest(least(coalesce(p_limit, 10), 50), 1)
     FOR UPDATE SKIP LOCKED
  ),
  claimed AS (
    UPDATE public.accounting_invoice_correction_outbox outbox
       SET status = 'processing',
           attempt_count = outbox.attempt_count + 1,
           next_attempt_at = now() + make_interval(secs => greatest(coalesce(p_lease_seconds, 300), 60)),
           last_error = '{}'::jsonb,
           payload = CASE WHEN outbox.attempt_count = 0 THEN outbox.payload || jsonb_build_object(
             'providerCreateIdentity', 'accounting-correction:' || outbox.id::text
           ) ELSE outbox.payload END
      FROM candidates
     WHERE outbox.id = candidates.id
     RETURNING outbox.*
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'outboxId', claimed.id,
    'attemptCount', claimed.attempt_count,
    'providerKind', claimed.provider_kind,
    'invoiceId', invoice.id,
    'providerInvoiceId', invoice.provider_invoice_id,
    'correctionReason', claimed.correction_reason,
    'payload', claimed.payload,
    'invoice', jsonb_build_object(
      'id', invoice.id,
      'orderRef', invoice.order_ref,
      'invoiceRef', invoice.invoice_ref,
      'documentKind', invoice.document_kind,
      'ksefRequired', invoice.ksef_required,
      'currency', invoice.currency,
      'buyerSnapshot', invoice.buyer_snapshot,
      'linesSnapshot', invoice.lines_snapshot,
      'totalGrossCents', invoice.total_gross_cents,
      'providerInvoiceId', invoice.provider_invoice_id,
      'providerInvoiceNumber', invoice.provider_invoice_number
    )
  )), '[]'::jsonb)
    INTO v_rows
    FROM claimed
    JOIN public.accounting_invoices invoice ON invoice.id = claimed.invoice_id;
  RETURN v_rows;
END;
$$;
REVOKE ALL ON FUNCTION public.accounting_invoice_correction_outbox_claim(integer,integer,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.accounting_invoice_correction_outbox_claim(integer,integer,text) TO service_role;

CREATE FUNCTION public.accounting_invoice_correction_outbox_succeed(
  p_outbox_id uuid,
  p_provider_invoice_id text,
  p_provider_invoice_number text,
  p_provider_raw jsonb,
  p_claim_attempt_count integer
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_invoice_id uuid;
  v_outbox public.accounting_invoice_correction_outbox%ROWTYPE;
  v_invoice public.accounting_invoices%ROWTYPE;
  v_code text;
BEGIN
  SELECT invoice_id INTO v_invoice_id FROM public.accounting_invoice_correction_outbox WHERE id = p_outbox_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'accounting_correction_outbox_not_found' USING ERRCODE = '22023'; END IF;
  SELECT * INTO v_invoice FROM public.accounting_invoices WHERE id = v_invoice_id FOR UPDATE;
  SELECT * INTO v_outbox FROM public.accounting_invoice_correction_outbox WHERE id = p_outbox_id FOR UPDATE;

  IF p_claim_attempt_count IS NULL THEN
    v_code := 'accounting_invoice_correction_claim_fence_required';
  ELSIF v_outbox.attempt_count IS DISTINCT FROM p_claim_attempt_count THEN
    v_code := 'accounting_invoice_correction_claim_generation_mismatch';
  ELSIF v_outbox.payload->>'providerCreateIdentity' IS DISTINCT FROM 'accounting-correction:' || v_outbox.id::text THEN
    v_code := 'accounting_invoice_correction_claim_identity_missing';
  ELSIF nullif(btrim(p_provider_invoice_id), '') IS NULL OR p_provider_invoice_id = v_invoice.provider_invoice_id THEN
    v_code := 'accounting_invoice_correction_claim_provider_identity_invalid';
  ELSIF v_outbox.status = 'succeeded' THEN
    IF v_invoice.metadata->>'correctionOutboxId' = v_outbox.id::text
      AND v_invoice.metadata->>'correctionProviderInvoiceId' = p_provider_invoice_id
      AND v_invoice.metadata->>'correctionProviderInvoiceNumber' IS NOT DISTINCT FROM p_provider_invoice_number
    THEN
      RETURN jsonb_build_object('ok', true, 'replayed', true);
    END IF;
    v_code := 'accounting_invoice_correction_claim_provider_identity_conflict';
  ELSIF v_invoice.status IS DISTINCT FROM 'correction_requested'
    OR v_outbox.status IS DISTINCT FROM 'processing'
    OR v_outbox.next_attempt_at IS NULL OR v_outbox.next_attempt_at <= now()
  THEN
    v_code := 'accounting_invoice_correction_claim_inactive';
  END IF;
  IF v_code IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'code', v_code); END IF;

  UPDATE public.accounting_invoice_correction_outbox
     SET status = 'succeeded', processed_at = now(), next_attempt_at = NULL, last_error = '{}'::jsonb
   WHERE id = p_outbox_id;
  UPDATE public.accounting_invoices
     SET status = 'corrected', correction_status = 'issued', email_status = 'pending',
         metadata = metadata || jsonb_build_object(
           'correctionOutboxId', v_outbox.id,
           'correctionProviderInvoiceId', p_provider_invoice_id,
           'correctionProviderInvoiceNumber', p_provider_invoice_number,
           'correctionReason', v_outbox.correction_reason
         ), updated_at = now()
   WHERE id = v_outbox.invoice_id RETURNING * INTO v_invoice;
  INSERT INTO public.accounting_invoice_operations (invoice_id, operation, provider_kind, provider_ref, payload)
  VALUES (v_invoice.id, 'correction_issued', v_outbox.provider_kind, p_provider_invoice_id, coalesce(p_provider_raw, '{}'::jsonb));
  INSERT INTO public.accounting_invoice_delivery_outbox (invoice_id, provider_kind, delivery_kind, status, metadata)
  VALUES (v_invoice.id, v_outbox.provider_kind, 'provider_email', 'pending', jsonb_build_object(
    'source', 'correction_issued', 'providerInvoiceId', p_provider_invoice_id, 'correctionReason', v_outbox.correction_reason
  ))
  ON CONFLICT (invoice_id, provider_kind, delivery_kind) DO UPDATE
    SET status = 'pending', processed_at = NULL, next_attempt_at = NULL,
        metadata = public.accounting_invoice_delivery_outbox.metadata || EXCLUDED.metadata, last_error = '{}'::jsonb;
  RETURN jsonb_build_object('ok', true, 'replayed', false, 'invoice', jsonb_build_object('id', v_invoice.id, 'status', v_invoice.status));
END;
$$;
REVOKE ALL ON FUNCTION public.accounting_invoice_correction_outbox_succeed(uuid,text,text,jsonb,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.accounting_invoice_correction_outbox_succeed(uuid,text,text,jsonb,integer) TO service_role;

CREATE FUNCTION public.accounting_invoice_correction_outbox_fail(
  p_outbox_id uuid,
  p_error jsonb,
  p_retry_seconds integer,
  p_claim_attempt_count integer
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_invoice_id uuid;
  v_outbox public.accounting_invoice_correction_outbox%ROWTYPE;
  v_invoice public.accounting_invoices%ROWTYPE;
  v_code text;
BEGIN
  SELECT invoice_id INTO v_invoice_id FROM public.accounting_invoice_correction_outbox WHERE id = p_outbox_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'accounting_correction_outbox_not_found' USING ERRCODE = '22023'; END IF;
  SELECT * INTO v_invoice FROM public.accounting_invoices WHERE id = v_invoice_id FOR UPDATE;
  SELECT * INTO v_outbox FROM public.accounting_invoice_correction_outbox WHERE id = p_outbox_id FOR UPDATE;
  IF p_claim_attempt_count IS NULL THEN
    v_code := 'accounting_invoice_correction_claim_fence_required';
  ELSIF v_outbox.attempt_count IS DISTINCT FROM p_claim_attempt_count THEN
    v_code := 'accounting_invoice_correction_claim_generation_mismatch';
  ELSIF v_outbox.payload->>'providerCreateIdentity' IS DISTINCT FROM 'accounting-correction:' || v_outbox.id::text THEN
    v_code := 'accounting_invoice_correction_claim_identity_missing';
  ELSIF v_invoice.status IS DISTINCT FROM 'correction_requested'
    OR v_outbox.status IS DISTINCT FROM 'processing'
    OR v_outbox.next_attempt_at IS NULL OR v_outbox.next_attempt_at <= now()
  THEN
    v_code := 'accounting_invoice_correction_claim_inactive';
  END IF;
  IF v_code IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'code', v_code); END IF;
  UPDATE public.accounting_invoice_correction_outbox
     SET status = 'failed', last_error = coalesce(p_error, '{}'::jsonb),
         next_attempt_at = now() + make_interval(secs => greatest(coalesce(p_retry_seconds, 900), 60))
   WHERE id = p_outbox_id RETURNING * INTO v_outbox;
  INSERT INTO public.accounting_invoice_operations (invoice_id, operation, provider_kind, payload)
  VALUES (v_outbox.invoice_id, 'correction_failed', v_outbox.provider_kind, coalesce(p_error, '{}'::jsonb));
  RETURN jsonb_build_object('ok', true, 'outbox', jsonb_build_object('id', v_outbox.id, 'status', v_outbox.status));
END;
$$;
REVOKE ALL ON FUNCTION public.accounting_invoice_correction_outbox_fail(uuid,jsonb,integer,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.accounting_invoice_correction_outbox_fail(uuid,jsonb,integer,integer) TO service_role;
