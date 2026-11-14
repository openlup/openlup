-- Explicit intake evidence; legacy callers retain push and exact acceptance replay.
CREATE FUNCTION public.fulfillment_dispatch_finish(p_id uuid,p_result jsonb,p_ack boolean,p_intake_channel text)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE v_ref public.fulfillment_dispatch_refs%ROWTYPE; v_replayed boolean := false;
BEGIN
 IF p_intake_channel IS NULL OR p_intake_channel NOT IN ('push','poll') THEN RAISE EXCEPTION 'fulfillment_dispatch_intake_channel_invalid' USING ERRCODE='22023'; END IF;
 IF p_result->>'kind'='accepted' AND p_result ? 'receiptKey' AND p_result->>'receiptKey' IS DISTINCT FROM p_result->>'labelKey' THEN RAISE EXCEPTION 'fulfillment_dispatch_receipt_key_conflict' USING ERRCODE='22023'; END IF;
 SELECT * INTO v_ref FROM public.fulfillment_dispatch_refs WHERE id=p_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'fulfillment_dispatch_missing' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('native-dispatch|' || v_ref.shipment_id::text,0));
 PERFORM id FROM public.fulfillment_shipments WHERE id=v_ref.shipment_id FOR UPDATE;
 SELECT * INTO v_ref FROM public.fulfillment_dispatch_refs WHERE id=p_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'fulfillment_dispatch_missing' USING ERRCODE='22023'; END IF;
 IF p_result->>'kind'='accepted' THEN
  IF v_ref.evidence IS DISTINCT FROM p_result->'evidence' OR btrim(COALESCE(p_result->>'externalRef',''))='' THEN RAISE EXCEPTION 'fulfillment_dispatch_acceptance_identity' USING ERRCODE='23505'; END IF;
  IF v_ref.external_ref IS NOT NULL AND v_ref.external_ref IS DISTINCT FROM p_result->>'externalRef' THEN RAISE EXCEPTION 'fulfillment_dispatch_acceptance_conflict' USING ERRCODE='23505'; END IF;
  IF v_ref.status='created' THEN
   IF v_ref.acceptance IS DISTINCT FROM p_result THEN RAISE EXCEPTION 'fulfillment_dispatch_ack_key_conflict' USING ERRCODE='23505'; END IF;
   v_replayed := true;
  ELSIF v_ref.status IN ('submitting','uncertain') THEN
   UPDATE public.fulfillment_dispatch_refs SET external_ref=p_result->>'externalRef',status=CASE WHEN p_ack THEN 'created' ELSE 'uncertain' END,
    acceptance=p_result,updated_at=now() WHERE id=p_id RETURNING * INTO v_ref;
   IF p_ack THEN
    PERFORM public.fulfillment_supersede_no_effect_commands(v_ref.shipment_id,v_ref.evidence->>'providerRef');
    PERFORM public.fulfillment_record_provider_attempt(p_result->>'providerAttemptKey',v_ref.shipment_id,v_ref.evidence,v_ref.mode);
    IF btrim(COALESCE(p_result->>'labelKey',''))='' OR p_result->>'labelKey'=p_result->>'providerAttemptKey' THEN RAISE EXCEPTION 'fulfillment_dispatch_ack_keys_invalid' USING ERRCODE='22023'; END IF;
    -- A 3pl accepts an outbound command; it does not create a label owned by
    -- this kernel. Its native commitment is dispatch evidence, which also
    -- fences local cancellation. The host's label ACK key stays the receipt key.
    PERFORM public.fulfillment_record_evidence(p_result->>'labelKey',v_ref.shipment_id,p_intake_channel,'dispatch',p_result->>'externalRef','{}'::jsonb,now());
   END IF;
  ELSE RAISE EXCEPTION 'fulfillment_dispatch_not_submitted' USING ERRCODE='22023'; END IF;
 ELSE
  IF p_ack OR p_result->>'kind' NOT IN ('unknown','not_dispatched') THEN RAISE EXCEPTION 'fulfillment_dispatch_result_invalid' USING ERRCODE='22023'; END IF;
  IF v_ref.status='submitting' THEN
   UPDATE public.fulfillment_dispatch_refs SET status=CASE WHEN p_result->>'kind'='unknown' THEN 'uncertain' ELSE 'failed' END,updated_at=now() WHERE id=p_id RETURNING * INTO v_ref;
  END IF;
 END IF;
 IF p_ack THEN RETURN jsonb_build_object('acknowledged',true,'replayed',v_replayed,'record',public.fulfillment_dispatch_read(v_ref,v_replayed)); END IF;
 RETURN public.fulfillment_dispatch_read(v_ref,v_replayed);
END;
$$;

CREATE OR REPLACE FUNCTION public.fulfillment_dispatch_finish(p_id uuid,p_result jsonb,p_ack boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
 RETURN public.fulfillment_dispatch_finish(p_id,p_result,p_ack,'push');
END;
$$;

REVOKE ALL ON FUNCTION public.fulfillment_dispatch_finish(uuid,jsonb,boolean,text) FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.fulfillment_dispatch_finish(uuid,jsonb,boolean,text) FROM anon;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.fulfillment_dispatch_finish(uuid,jsonb,boolean,text) FROM authenticated;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'GRANT EXECUTE ON FUNCTION public.fulfillment_dispatch_finish(uuid,jsonb,boolean,text) TO service_role;'; END IF; END; $$;
