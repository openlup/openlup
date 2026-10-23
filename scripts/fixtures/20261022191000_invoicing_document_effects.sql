-- Fenced document effects. No payment, subscription, shipment or outbox trigger.
CREATE TABLE public.invoicing_document_observations (
  event_key text PRIMARY KEY,
  document_id uuid NOT NULL REFERENCES public.accounting_documents(id),
  observation jsonb NOT NULL,
  observed_at timestamptz NOT NULL
);
CREATE TABLE public.invoicing_delivery_receipts (
  delivery_id uuid PRIMARY KEY REFERENCES public.accounting_document_deliveries(id),
  generation integer NOT NULL DEFAULT 0,
  claim_token uuid,
  lease_until timestamptz,
  state text NOT NULL DEFAULT 'ready' CHECK (state IN ('ready','processing','sent','uncertain','failed')),
  result jsonb
);
CREATE FUNCTION public.invoicing_request_reversal(p_key text,p_order uuid,p_reason text,p_evidence jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE
  v_base public.invoicing_duties%ROWTYPE;
  v_child public.invoicing_duties%ROWTYPE;
  v_document public.accounting_documents%ROWTYPE;
  v_reversal jsonb;
  v_result jsonb;
  v_facts jsonb;
  v_prior public.invoicing_effect_receipts%ROWTYPE;
  v_existing_document uuid;
  v_ready uuid;
  v_safe_void boolean;
BEGIN
  IF nullif(btrim(p_key),'') IS NULL OR nullif(btrim(p_reason),'') IS NULL OR jsonb_typeof(p_evidence) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'invoicing_reversal_invalid' USING ERRCODE='22023'; END IF;
  IF NOT pg_try_advisory_xact_lock(hashtextextended('invoicing:'||p_order::text,0)) THEN RAISE EXCEPTION 'invoicing_capture_busy' USING ERRCODE='55P03'; END IF;
  PERFORM 1 FROM public.accounting_document_requests WHERE id=coalesce(
    (SELECT request_id FROM public.invoicing_duties WHERE order_id=p_order AND parent_duty_id IS NULL),
    (SELECT r.id FROM public.accounting_document_requests r JOIN public.accounting_document_operations o ON o.document_id=r.document_id
      JOIN public.invoicing_duties d ON o.idempotency_key='invoicing:request:'||d.id::text
      WHERE d.order_id=p_order AND d.parent_duty_id IS NULL AND r.request_kind='issue')) FOR UPDATE;
  SELECT * INTO v_base FROM public.invoicing_duties WHERE order_id=p_order AND parent_duty_id IS NULL FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('kind','missing'); END IF;
  v_reversal:=jsonb_build_object('key',p_key,'reason',p_reason,'evidence',p_evidence);
  SELECT * INTO v_prior FROM public.invoicing_effect_receipts WHERE receipt_key='reversal-key:'||p_key;
  IF FOUND AND (v_prior.duty_id<>v_base.id OR v_prior.payload IS DISTINCT FROM v_reversal) THEN
    RAISE EXCEPTION 'invoicing_reversal_key_conflict' USING ERRCODE='23505'; END IF;
  INSERT INTO public.invoicing_effect_receipts(receipt_key,duty_id,payload) VALUES('reversal-key:'||p_key,v_base.id,v_reversal) ON CONFLICT DO NOTHING;
  -- Once a compensation intent exists, later aliases cannot change its reason/evidence.
  IF v_base.reversal IS NOT NULL AND (v_base.reversal-'key') IS DISTINCT FROM (v_reversal-'key') THEN
    RAISE EXCEPTION 'invoicing_reversal_conflict' USING ERRCODE='23505'; END IF;
  UPDATE public.invoicing_duties SET reversal=coalesce(reversal,v_reversal) WHERE id=v_base.id;
  IF v_base.status='voided' THEN RETURN jsonb_build_object('kind','voided','replayed',true); END IF;
  IF v_base.status='blocked' THEN RETURN jsonb_build_object('kind','unsupported'); END IF;
  IF v_base.status IN ('processing','unknown') OR v_base.claim_token IS NOT NULL OR v_base.lease_until IS NOT NULL THEN RETURN jsonb_build_object('kind','pending_readback'); END IF;
  IF v_base.document_id IS NULL THEN
    SELECT o.document_id,r.id INTO v_base.document_id,v_base.request_id FROM public.accounting_document_operations o
      JOIN public.accounting_document_requests r ON r.document_id=o.document_id AND r.request_kind='issue'
      WHERE o.idempotency_key='invoicing:request:'||v_base.id::text;
  END IF;
  -- A live unlinked local document is still an outstanding obligation.
  IF EXISTS (SELECT 1 FROM public.accounting_documents a WHERE a.order_id=p_order
    AND a.correction_of_document_id IS NULL AND a.status<>'voided'
    AND a.id IS DISTINCT FROM v_base.document_id) THEN RETURN jsonb_build_object('kind','unsupported'); END IF;
  v_safe_void:=coalesce(
    (v_base.last_result->>'kind'='retryable' AND v_base.last_result->'evidence'->>'phase'='before_send')
    OR (v_base.last_result->>'kind'='absent' AND v_base.last_result->'evidence'->>'kind'='authoritative_absence'
      AND v_base.last_result->'evidence'->>'providerCreateIdentity'='invoicing:'||v_base.id::text),false);
  IF v_base.status<>'issued' AND EXISTS (SELECT 1 FROM public.accounting_document_requests
    WHERE id=v_base.request_id AND (status='processing' OR claim_token IS NOT NULL
      OR (attempts>0 AND NOT v_safe_void))) THEN RETURN jsonb_build_object('kind','pending_readback'); END IF;
  IF v_base.document_id IS NULL OR (v_base.status<>'issued' AND (v_base.generation=0 OR v_safe_void)) THEN
    IF v_base.document_id IS NOT NULL THEN
      PERFORM public.accounting_document_advance('invoicing:void:'||v_base.id::text,v_base.document_id,'voided');
      UPDATE public.accounting_document_requests SET status='discarded',claim_token=NULL,updated_at=now() WHERE id=v_base.request_id;
    END IF;
    UPDATE public.invoicing_duties SET status='voided' WHERE id=v_base.id;
    RETURN jsonb_build_object('kind','voided','replayed',false);
  END IF;
  SELECT * INTO v_child FROM public.invoicing_duties WHERE parent_duty_id=v_base.id;
  IF FOUND THEN RETURN jsonb_build_object('kind','correction_requested','dutyId',v_child.id,'replayed',true); END IF;
  SELECT * INTO v_document FROM public.accounting_documents WHERE id=v_base.document_id FOR UPDATE;
  IF v_document.provider_reference IS NULL THEN RETURN jsonb_build_object('kind','pending_readback'); END IF;
  SELECT id INTO v_existing_document FROM public.accounting_documents WHERE correction_of_document_id=v_base.document_id;
  IF FOUND THEN
    -- An old native child/request is an existing obligation, even when its M09
    -- sidecar is new. Do not call the constructor again or refreeze its seller.
    v_result:=jsonb_build_object('document',jsonb_build_object('id',v_existing_document));
  ELSE
    v_result:=public.accounting_document_request_correction('invoicing:correction:'||v_base.id::text,v_base.document_id,p_reason,p_evidence);
  END IF;
  INSERT INTO public.invoicing_duties(order_id,parent_duty_id,document_id,request_id,original_key,status,seller_policy_version)
    SELECT p_order,v_base.id,(v_result->'document'->>'id')::uuid,r.id,p_key,CASE WHEN doc.provider_reference IS NOT NULL THEN 'issued' WHEN doc.status='voided' THEN 'voided'
      WHEN r.attempts>0 OR r.status<>'pending' OR r.claim_token IS NOT NULL THEN 'unsupported' ELSE 'ready' END,
      CASE WHEN v_existing_document IS NULL AND p_evidence->>'sellerPolicyVersion'='invoicing.seller.v1' THEN 'invoicing.seller.v1' END
    FROM public.accounting_document_requests r JOIN public.accounting_documents doc ON doc.id=r.document_id WHERE r.document_id=(v_result->'document'->>'id')::uuid AND r.request_kind='correction'
    RETURNING * INTO v_child;
  UPDATE public.accounting_document_requests SET available_at='infinity'
    WHERE id=v_child.request_id AND v_child.status='ready' AND status='pending' AND attempts=0 AND claim_token IS NULL
    RETURNING id INTO v_ready;
  IF v_child.status='ready' AND v_ready IS NULL THEN
    UPDATE public.invoicing_duties SET status='unsupported' WHERE id=v_child.id RETURNING * INTO v_child;
  END IF;
  SELECT facts INTO v_facts FROM public.invoicing_fact_revisions WHERE duty_id=v_base.id;
  INSERT INTO public.invoicing_fact_revisions(duty_id,revision_ref,facts) VALUES(v_child.id,'correction:'||v_base.id::text,
    v_facts||jsonb_build_object('before',v_facts,'after',jsonb_build_object('totalGrossMinor',0,'totalNetMinor',0,'totalTaxMinor',0),
      'parentDocumentId',v_base.document_id,'parentExternalId',v_document.provider_reference,'reason',p_reason));
  RETURN jsonb_build_object('kind',CASE WHEN v_child.status='unsupported' THEN 'unsupported' ELSE 'correction_requested' END,'dutyId',v_child.id,'replayed',false);
END;
$$;
CREATE FUNCTION public.invoicing_finish_correction(p_duty uuid,p_token uuid,p_generation integer,p_external text,p_number text,p_proof jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE v_duty public.invoicing_duties%ROWTYPE; v_base public.invoicing_duties%ROWTYPE; v_payload jsonb; v_prior jsonb; v_parent_external text;
BEGIN
  -- Parent request precedes child request, then the corresponding duties.
  SELECT * INTO v_base FROM public.invoicing_duties WHERE id=(SELECT parent_duty_id FROM public.invoicing_duties WHERE id=p_duty);
  PERFORM 1 FROM public.accounting_document_requests WHERE id=v_base.request_id FOR UPDATE;
  PERFORM 1 FROM public.accounting_document_requests WHERE id=(SELECT request_id FROM public.invoicing_duties WHERE id=p_duty) FOR UPDATE;
  PERFORM 1 FROM public.invoicing_duties WHERE id=v_base.id FOR UPDATE;
  SELECT * INTO v_duty FROM public.invoicing_duties WHERE id=p_duty FOR UPDATE;
  IF NOT FOUND OR v_duty.parent_duty_id IS NULL THEN RAISE EXCEPTION 'invoicing_correction_missing' USING ERRCODE='22023'; END IF;
  v_payload:=jsonb_build_object('externalId',p_external,'number',p_number,'proof',p_proof);
  SELECT payload INTO v_prior FROM public.invoicing_effect_receipts WHERE receipt_key='correction:'||p_duty::text;
  IF FOUND THEN
    IF v_prior->>'externalId' IS DISTINCT FROM p_external OR v_prior->>'number' IS DISTINCT FROM p_number
      OR v_prior->'proof'->>'parentExternalId' IS DISTINCT FROM p_proof->>'parentExternalId' THEN RAISE EXCEPTION 'invoicing_correction_identity_conflict' USING ERRCODE='23505'; END IF;
    RETURN jsonb_build_object('kind','issued','replayed',true);
  END IF;
  IF v_duty.status<>'processing' OR v_duty.claim_token IS DISTINCT FROM p_token OR v_duty.generation IS DISTINCT FROM p_generation OR v_duty.lease_until<=now()
    THEN RETURN jsonb_build_object('kind','stale'); END IF;
  SELECT provider_reference INTO v_parent_external FROM public.accounting_documents WHERE id=v_base.document_id;
  IF nullif(btrim(p_external),'') IS NULL OR p_external=v_parent_external OR p_proof->>'kind' IS NULL OR p_proof->>'kind' NOT IN ('issued','readback_found')
    OR p_proof->>'externalId' IS DISTINCT FROM p_external OR p_proof->>'parentExternalId' IS DISTINCT FROM v_parent_external
    OR p_proof->>'providerCreateIdentity' IS DISTINCT FROM 'invoicing:'||p_duty::text
    OR (p_proof->>'kind'='issued' AND (v_duty.preflight_generation IS DISTINCT FROM p_generation OR v_duty.last_result->>'action'<>'create'))
  THEN RAISE EXCEPTION 'invoicing_correction_proof_invalid' USING ERRCODE='22023'; END IF;
  PERFORM public.accounting_document_advance('invoicing:correction-request:'||p_duty::text,v_duty.document_id,'issue_requested');
  PERFORM public.accounting_document_advance('invoicing:correction-issue:'||p_duty::text,v_duty.document_id,'issued',p_external,jsonb_build_object('number',p_number));
  PERFORM public.accounting_document_advance('invoicing:corrected:'||p_duty::text,v_base.document_id,'corrected');
  UPDATE public.accounting_document_requests SET status='succeeded',claim_token=NULL,error=NULL,updated_at=now() WHERE id=v_duty.request_id;
  UPDATE public.invoicing_duties SET status='issued',claim_token=NULL,lease_until=NULL,last_result=v_payload WHERE id=p_duty;
  INSERT INTO public.invoicing_effect_receipts(receipt_key,duty_id,payload) VALUES('correction:'||p_duty::text,p_duty,v_payload);
  RETURN jsonb_build_object('kind','issued','replayed',false);
END;
$$;
CREATE FUNCTION public.invoicing_record_observation(p_key text,p_document uuid,p_observation jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE v_prior public.invoicing_document_observations%ROWTYPE; v_state text;
BEGIN
  IF nullif(btrim(p_key),'') IS NULL OR p_observation->>'observedAt' IS NULL OR p_observation->>'kind' IS NULL
    OR p_observation->>'kind' NOT IN ('clearance','artifacts','unsupported') THEN
    RAISE EXCEPTION 'invoicing_observation_invalid' USING ERRCODE='22023'; END IF;
  PERFORM 1 FROM public.accounting_documents WHERE id=p_document FOR UPDATE;
  SELECT * INTO v_prior FROM public.invoicing_document_observations WHERE event_key=p_key;
  IF FOUND THEN
    IF v_prior.document_id IS DISTINCT FROM p_document OR v_prior.observation IS DISTINCT FROM p_observation THEN
      RAISE EXCEPTION 'invoicing_observation_conflict' USING ERRCODE='23505'; END IF;
    RETURN jsonb_build_object('replayed',true);
  END IF;
  IF p_observation->>'kind'='clearance' THEN
    v_state:=p_observation->>'state';
    IF v_state IS NULL OR v_state NOT IN ('not_submitted','pending','accepted','rejected','not_required')
      OR (v_state='accepted' AND nullif(btrim(p_observation->>'reference'),'') IS NULL) THEN
      RAISE EXCEPTION 'invoicing_clearance_invalid' USING ERRCODE='22023'; END IF;
    -- Older observations remain evidence without replacing newer projection.
    IF NOT EXISTS(SELECT 1 FROM public.invoicing_document_observations WHERE document_id=p_document
      AND observation->>'kind'='clearance' AND observed_at>(p_observation->>'observedAt')::timestamptz) THEN
      PERFORM public.accounting_document_record_submission(p_document,v_state,p_observation->>'reference',(p_observation->>'observedAt')::timestamptz);
    END IF;
  END IF;
  INSERT INTO public.invoicing_document_observations VALUES(p_key,p_document,p_observation,(p_observation->>'observedAt')::timestamptz);
  RETURN jsonb_build_object('replayed',false,'kind',p_observation->>'kind');
END;
$$;
CREATE FUNCTION public.invoicing_claim_deliveries(p_limit integer,p_visibility integer,p_require_clearance boolean,p_order_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE v_delivery public.accounting_document_deliveries%ROWTYPE; v_receipt public.invoicing_delivery_receipts%ROWTYPE; v_rows jsonb:='[]';
BEGIN
  FOR v_delivery IN SELECT d.* FROM public.accounting_document_deliveries d
    JOIN public.accounting_documents doc ON doc.id=d.document_id
    WHERE (p_order_id IS NULL OR doc.order_id=p_order_id)
      AND d.status IN ('pending','failed') AND d.available_at<=now() AND doc.provider_reference IS NOT NULL
      AND doc.status IN ('issued','accepted','corrected')
      AND (p_require_clearance IS NOT TRUE OR doc.submission_required IS NOT TRUE OR doc.submission_state='accepted')
      AND NOT EXISTS (SELECT 1 FROM public.invoicing_delivery_receipts s WHERE s.delivery_id=d.id AND s.state IN ('processing','sent','uncertain'))
    ORDER BY d.created_at,d.id LIMIT least(greatest(coalesce(p_limit,10),1),100) FOR UPDATE OF d, doc SKIP LOCKED LOOP
    INSERT INTO public.invoicing_delivery_receipts(delivery_id) VALUES(v_delivery.id) ON CONFLICT DO NOTHING;
    SELECT * INTO v_receipt FROM public.invoicing_delivery_receipts WHERE delivery_id=v_delivery.id FOR UPDATE;
    IF v_receipt.state IN ('processing','sent','uncertain') THEN CONTINUE; END IF;
    UPDATE public.invoicing_delivery_receipts SET generation=generation+1,claim_token=gen_random_uuid(),state='processing',
      lease_until=now()+make_interval(secs=>least(greatest(coalesce(p_visibility,300),1),3600)) WHERE delivery_id=v_delivery.id RETURNING * INTO v_receipt;
    UPDATE public.accounting_document_deliveries SET status='processing',attempts=v_receipt.generation,lease_until=v_receipt.lease_until,updated_at=now() WHERE id=v_delivery.id;
    v_rows:=v_rows||jsonb_build_array(to_jsonb(v_delivery)||to_jsonb(v_receipt));
  END LOOP;
  RETURN v_rows;
END;
$$;
CREATE FUNCTION public.invoicing_settle_delivery(p_delivery uuid,p_token uuid,p_generation integer,p_kind text,p_receipt text,p_evidence jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE v_row public.invoicing_delivery_receipts%ROWTYPE; v_payload jsonb;
BEGIN
  PERFORM 1 FROM public.accounting_document_deliveries WHERE id=p_delivery FOR UPDATE;
  SELECT * INTO v_row FROM public.invoicing_delivery_receipts WHERE delivery_id=p_delivery FOR UPDATE;
  v_payload:=jsonb_build_object('kind',p_kind,'receipt',p_receipt,'evidence',p_evidence);
  IF v_row.state='sent' THEN
    IF v_row.result IS DISTINCT FROM v_payload THEN RAISE EXCEPTION 'invoicing_delivery_conflict' USING ERRCODE='23505'; END IF;
    RETURN jsonb_build_object('kind','sent','replayed',true);
  END IF;
  IF v_row.delivery_id IS NULL OR v_row.state<>'processing' OR v_row.claim_token IS DISTINCT FROM p_token OR v_row.generation IS DISTINCT FROM p_generation
    THEN RETURN jsonb_build_object('kind','stale'); END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('sent','uncertain','failed_before_send') OR jsonb_typeof(p_evidence) IS DISTINCT FROM 'object'
    OR (p_kind='sent' AND nullif(btrim(p_receipt),'') IS NULL)
    OR (p_kind<>'sent' AND p_receipt IS NOT NULL)
    OR (p_kind='failed_before_send' AND p_evidence->>'phase' IS DISTINCT FROM 'before_send')
  THEN RAISE EXCEPTION 'invoicing_delivery_evidence_invalid' USING ERRCODE='22023'; END IF;
  UPDATE public.invoicing_delivery_receipts SET state=CASE WHEN p_kind='failed_before_send' THEN 'failed' ELSE p_kind END,
    result=v_payload,claim_token=NULL,lease_until=NULL WHERE delivery_id=p_delivery;
  IF p_kind='sent' THEN
    UPDATE public.accounting_document_deliveries SET status='succeeded',receipt_reference=p_receipt,delivered_at=now(),lease_until=NULL,updated_at=now() WHERE id=p_delivery;
    INSERT INTO public.accounting_document_delivery_attempts(delivery_id,attempt_ordinal,outcome,receipt_reference) VALUES(p_delivery,p_generation,'delivered',p_receipt);
  ELSIF p_kind='failed_before_send' THEN
    UPDATE public.accounting_document_deliveries SET status='failed',lease_until=NULL,
      available_at=CASE WHEN p_evidence->'retryable'='false'::jsonb THEN 'infinity'::timestamptz
        ELSE now()+make_interval(secs=>CASE WHEN jsonb_typeof(p_evidence->'retrySeconds')='number' THEN
          CASE WHEN (p_evidence->>'retrySeconds')::numeric=trunc((p_evidence->>'retrySeconds')::numeric)
            THEN least(greatest((p_evidence->>'retrySeconds')::numeric,0),86400)::integer ELSE 0 END
          ELSE 0 END) END,
      last_error=p_evidence,updated_at=now() WHERE id=p_delivery;
    INSERT INTO public.accounting_document_delivery_attempts(delivery_id,attempt_ordinal,outcome,error) VALUES(p_delivery,p_generation,'failed',p_evidence);
  END IF;
  RETURN jsonb_build_object('kind',p_kind,'replayed',false);
END;
$$;

REVOKE ALL ON TABLE public.invoicing_document_observations FROM PUBLIC, anon, authenticated;

REVOKE ALL ON TABLE public.invoicing_delivery_receipts FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.invoicing_request_reversal(text,uuid,text,jsonb) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.invoicing_finish_correction(uuid,uuid,integer,text,text,jsonb) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.invoicing_record_observation(text,uuid,jsonb) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.invoicing_claim_deliveries(integer,integer,boolean,uuid) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.invoicing_settle_delivery(uuid,uuid,integer,text,text,jsonb) FROM PUBLIC, anon, authenticated;
