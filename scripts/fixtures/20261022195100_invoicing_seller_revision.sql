-- Managed seller freezing wraps the incumbent requests and versioned claims.
-- Definers preserve the managed donor authority; direct browser/table access is closed.
CREATE TABLE public.invoicing_managed_seller_revisions (
  obligation_kind text NOT NULL CHECK (obligation_kind IN ('issue','correction')),
  obligation_id uuid NOT NULL,
  invoice_id uuid NOT NULL REFERENCES public.accounting_invoices(id),
  eligibility_version text NOT NULL CHECK (eligibility_version='invoicing.seller.v1'),
  revision_ref text,
  seller_facts jsonb,
  captured_at timestamptz,
  capture_generation integer,
  PRIMARY KEY(obligation_kind,obligation_id),
  CHECK ((seller_facts IS NULL AND revision_ref IS NULL AND captured_at IS NULL AND capture_generation IS NULL)
    OR (jsonb_typeof(seller_facts)='object' AND revision_ref IS NOT NULL AND captured_at IS NOT NULL AND capture_generation IS NOT NULL))
);
REVOKE ALL ON TABLE public.invoicing_managed_seller_revisions FROM PUBLIC, anon, authenticated;
ALTER TABLE public.invoicing_managed_seller_revisions ENABLE ROW LEVEL SECURITY;
CREATE FUNCTION public.invoicing_managed_request_with_seller_policy(p_key text,p_source_kind text,p_source_id uuid,p_provider text,p_evidence jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
DECLARE v_order uuid; v_invoice uuid; v_old_invoice uuid; v_obligation uuid; v_result jsonb; v_existing boolean; v_status text;
BEGIN
  IF nullif(btrim(p_key),'') IS NULL OR nullif(btrim(p_provider),'') IS NULL OR jsonb_typeof(p_evidence) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'invoicing_managed_request_invalid' USING ERRCODE='22023'; END IF;
  IF p_source_kind='correction' THEN
    SELECT id INTO v_invoice FROM public.accounting_invoices WHERE id=p_source_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'invoicing_managed_parent_missing' USING ERRCODE='22023'; END IF;
    -- The donor scaffold has no reliable new/replayed flag. Check physical
    -- obligation identity under the same parent lock before invoking it.
    SELECT id,status INTO v_obligation,v_status FROM public.accounting_invoice_correction_outbox
      WHERE invoice_id=v_invoice AND provider_kind=p_provider AND correction_reason=p_evidence->>'reason';
    v_existing:=FOUND;
    IF v_existing THEN
      RETURN jsonb_build_object('correctionOutbox',jsonb_build_object('id',v_obligation,'invoiceId',v_invoice,'status',v_status),'replayed',true);
    END IF;
    v_result:=public.accounting_invoice_request_correction_scaffold(v_invoice,p_evidence->>'reason',p_evidence,p_provider);
    v_obligation:=(v_result->'correctionOutbox'->>'id')::uuid;
  ELSE
    IF p_source_kind='paid' THEN v_order:=p_source_id;
    ELSIF p_source_kind='handoff' THEN SELECT order_id INTO v_order FROM public.commerce_fulfillment_orders WHERE id=p_source_id;
    ELSE RAISE EXCEPTION 'invoicing_managed_source_unsupported' USING ERRCODE='22023'; END IF;
    PERFORM 1 FROM public.commerce_orders WHERE id=v_order FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'invoicing_managed_order_missing' USING ERRCODE='22023'; END IF;
    SELECT id INTO v_old_invoice FROM public.accounting_invoices WHERE order_id=v_order ORDER BY created_at,id LIMIT 1;
    v_existing:=FOUND;
    IF p_source_kind='paid' THEN v_result:=public.accounting_invoice_issue_request_from_paid_order(p_key,p_source_id,p_provider);
    ELSE v_result:=public.accounting_invoice_issue_request_from_handoff(p_key,p_source_id,p_provider); END IF;
    v_invoice:=(v_result->'invoice'->>'id')::uuid;
    SELECT id INTO v_obligation FROM public.accounting_invoice_issue_outbox WHERE invoice_id=v_invoice AND provider_kind=p_provider;
  END IF;
  IF NOT v_existing AND v_obligation IS NOT NULL THEN
    INSERT INTO public.invoicing_managed_seller_revisions(obligation_kind,obligation_id,invoice_id,eligibility_version)
    VALUES(CASE WHEN p_source_kind='correction' THEN 'correction' ELSE 'issue' END,v_obligation,v_invoice,'invoicing.seller.v1');
  END IF;
  RETURN v_result;
END;
$$;
CREATE FUNCTION public.invoicing_managed_claim_with_seller(p_limit integer,p_order uuid,p_seller jsonb,p_revision text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
DECLARE v_claim jsonb; v_seller public.invoicing_managed_seller_revisions%ROWTYPE; v_rows jsonb:='[]';
BEGIN
  IF jsonb_typeof(p_seller) IS DISTINCT FROM 'object' OR nullif(btrim(p_revision),'') IS NULL THEN
    RAISE EXCEPTION 'invoicing_seller_required' USING ERRCODE='22023'; END IF;
  FOR v_claim IN SELECT value FROM jsonb_array_elements(public.accounting_invoice_issue_outbox_claim(p_limit,300,p_order,'accounting.issue.v2')) LOOP
    SELECT * INTO v_seller FROM public.invoicing_managed_seller_revisions WHERE obligation_kind='issue' AND obligation_id=(v_claim->>'outboxId')::uuid FOR UPDATE;
    IF FOUND THEN
      UPDATE public.invoicing_managed_seller_revisions SET seller_facts=coalesce(seller_facts,p_seller),revision_ref=coalesce(revision_ref,p_revision),
        captured_at=coalesce(captured_at,now()),capture_generation=coalesce(capture_generation,(v_claim->>'attemptCount')::integer)
        WHERE obligation_kind='issue' AND obligation_id=v_seller.obligation_id RETURNING * INTO v_seller;
      v_claim:=v_claim||jsonb_build_object('seller',v_seller.seller_facts,'sellerRevision',v_seller.revision_ref,'sellerMode','frozen');
    ELSE v_claim:=v_claim||jsonb_build_object('seller',p_seller,'sellerRevision',p_revision,'sellerMode','legacy_fallback'); END IF;
    v_rows:=v_rows||jsonb_build_array(v_claim);
  END LOOP;
  RETURN v_rows;
END;
$$;
CREATE FUNCTION public.invoicing_managed_claim_corrections_with_seller(p_limit integer,p_seller jsonb,p_revision text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
DECLARE v_claim jsonb; v_seller public.invoicing_managed_seller_revisions%ROWTYPE; v_rows jsonb:='[]';
BEGIN
  IF jsonb_typeof(p_seller) IS DISTINCT FROM 'object' OR nullif(btrim(p_revision),'') IS NULL THEN
    RAISE EXCEPTION 'invoicing_seller_required' USING ERRCODE='22023'; END IF;
  FOR v_claim IN SELECT value FROM jsonb_array_elements(public.accounting_invoice_correction_outbox_claim(p_limit,300,'accounting.correction.v2')) LOOP
    SELECT * INTO v_seller FROM public.invoicing_managed_seller_revisions WHERE obligation_kind='correction' AND obligation_id=(v_claim->>'outboxId')::uuid FOR UPDATE;
    IF FOUND THEN
      UPDATE public.invoicing_managed_seller_revisions SET seller_facts=coalesce(seller_facts,p_seller),revision_ref=coalesce(revision_ref,p_revision),
        captured_at=coalesce(captured_at,now()),capture_generation=coalesce(capture_generation,(v_claim->>'attemptCount')::integer)
        WHERE obligation_kind='correction' AND obligation_id=v_seller.obligation_id RETURNING * INTO v_seller;
      v_claim:=v_claim||jsonb_build_object('seller',v_seller.seller_facts,'sellerRevision',v_seller.revision_ref,'sellerMode','frozen');
    ELSE v_claim:=v_claim||jsonb_build_object('seller',p_seller,'sellerRevision',p_revision,'sellerMode','legacy_fallback'); END IF;
    v_rows:=v_rows||jsonb_build_array(v_claim);
  END LOOP;
  RETURN v_rows;
END;
$$;
REVOKE ALL ON FUNCTION public.invoicing_managed_request_with_seller_policy(text,text,uuid,text,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.invoicing_managed_request_with_seller_policy(text,text,uuid,text,jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.invoicing_managed_claim_with_seller(integer,uuid,jsonb,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.invoicing_managed_claim_with_seller(integer,uuid,jsonb,text) TO service_role;
REVOKE ALL ON FUNCTION public.invoicing_managed_claim_corrections_with_seller(integer,jsonb,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.invoicing_managed_claim_corrections_with_seller(integer,jsonb,text) TO service_role;
