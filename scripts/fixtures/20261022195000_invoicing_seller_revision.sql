-- Eligibility is a creation marker, never a wall-clock inference or historical backfill.
CREATE TABLE public.invoicing_seller_revisions (
  duty_id uuid PRIMARY KEY REFERENCES public.invoicing_duties(id),
  eligibility_version text NOT NULL CHECK (eligibility_version='invoicing.seller.v1'),
  revision_ref text,
  seller_facts jsonb,
  captured_at timestamptz,
  capture_generation integer,
  CHECK ((seller_facts IS NULL AND revision_ref IS NULL AND captured_at IS NULL AND capture_generation IS NULL)
    OR (jsonb_typeof(seller_facts)='object' AND revision_ref IS NOT NULL AND captured_at IS NOT NULL AND capture_generation IS NOT NULL))
);
CREATE FUNCTION public.invoicing_request_with_seller_policy(p_key text,p_source_kind text,p_source_id uuid,p_order_id uuid,p_evidence jsonb,p_occurred_at timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE v_result jsonb; v_existing boolean; v_prior_duty boolean; v_duty uuid; v_timeout text:=current_setting('lock_timeout');
BEGIN
  IF p_source_kind='correction' THEN
    SELECT child.id INTO v_duty FROM public.invoicing_duties child JOIN public.invoicing_duties parent ON parent.id=child.parent_duty_id WHERE parent.order_id=p_order_id;
    IF FOUND THEN RETURN jsonb_build_object('kind','correction_requested','dutyId',v_duty,'replayed',true); END IF;
    RETURN public.invoicing_request_reversal(p_key,p_order_id,p_evidence->>'reason',p_evidence||jsonb_build_object('sellerPolicyVersion','invoicing.seller.v1'));
  END IF;
  IF NOT pg_try_advisory_xact_lock(hashtextextended('invoicing:'||p_order_id::text,0)) THEN RAISE EXCEPTION 'invoicing_capture_busy' USING ERRCODE='55P03'; END IF;
  PERFORM set_config('lock_timeout','100ms',true);
  PERFORM 1 FROM public.commerce_orders WHERE id=p_order_id FOR UPDATE;
  -- A new sidecar around an older document/request is still a legacy obligation.
  v_prior_duty:=EXISTS(SELECT 1 FROM public.invoicing_duties WHERE order_id=p_order_id AND parent_duty_id IS NULL);
  v_existing:=EXISTS(SELECT 1 FROM public.invoicing_duties WHERE order_id=p_order_id AND parent_duty_id IS NULL)
    OR EXISTS(SELECT 1 FROM public.accounting_documents WHERE order_id=p_order_id AND correction_of_document_id IS NULL);
  v_result:=public.invoicing_capture_duty(p_key,p_source_kind,p_source_id,p_order_id,p_evidence,p_occurred_at);
  v_duty:=(v_result->>'dutyId')::uuid;
  IF v_existing AND NOT v_prior_duty THEN UPDATE public.invoicing_duties SET seller_policy_version=NULL WHERE id=v_duty; END IF;
  IF NOT v_existing THEN INSERT INTO public.invoicing_seller_revisions(duty_id,eligibility_version) VALUES(v_duty,'invoicing.seller.v1') ON CONFLICT DO NOTHING; END IF;
  PERFORM set_config('lock_timeout',v_timeout,true);
  RETURN v_result;
END;
$$;
CREATE FUNCTION public.invoicing_claim_with_seller(p_limit integer,p_visibility integer,p_provider text,p_seller jsonb,p_revision text,p_order_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE v_claim jsonb; v_seller public.invoicing_seller_revisions%ROWTYPE; v_rows jsonb:='[]';
BEGIN
  IF jsonb_typeof(p_seller) IS DISTINCT FROM 'object' OR nullif(btrim(p_revision),'') IS NULL THEN
    RAISE EXCEPTION 'invoicing_seller_required' USING ERRCODE='22023'; END IF;
  FOR v_claim IN SELECT value FROM jsonb_array_elements(public.invoicing_claim_duties(p_limit,p_visibility,p_provider,p_order_id)) LOOP
    -- Only unit-76 children explicitly marked at their creation are eligible.
    INSERT INTO public.invoicing_seller_revisions(duty_id,eligibility_version)
      SELECT id,'invoicing.seller.v1' FROM public.invoicing_duties WHERE id=(v_claim->>'id')::uuid AND seller_policy_version='invoicing.seller.v1'
      ON CONFLICT DO NOTHING;
    SELECT * INTO v_seller FROM public.invoicing_seller_revisions WHERE duty_id=(v_claim->>'id')::uuid FOR UPDATE;
    IF FOUND THEN
      UPDATE public.invoicing_seller_revisions SET seller_facts=coalesce(seller_facts,p_seller),revision_ref=coalesce(revision_ref,p_revision),
        captured_at=coalesce(captured_at,now()),capture_generation=coalesce(capture_generation,(v_claim->>'generation')::integer)
        WHERE duty_id=v_seller.duty_id RETURNING * INTO v_seller;
      v_claim:=v_claim||jsonb_build_object('seller',v_seller.seller_facts,'sellerRevision',v_seller.revision_ref,'sellerMode','frozen');
    ELSE
      v_claim:=v_claim||jsonb_build_object('seller',p_seller,'sellerRevision',p_revision,'sellerMode','legacy_fallback');
    END IF;
    v_rows:=v_rows||jsonb_build_array(v_claim);
  END LOOP;
  RETURN v_rows;
END;
$$;

REVOKE ALL ON TABLE public.invoicing_seller_revisions FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.invoicing_request_with_seller_policy(text,text,uuid,uuid,jsonb,timestamptz) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.invoicing_claim_with_seller(integer,integer,text,jsonb,text,uuid) FROM PUBLIC, anon, authenticated;
