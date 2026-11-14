-- Durable neutral diagnostics and native local dispatch composition.
ALTER TABLE public.fulfillment_dispatch_refs ADD COLUMN outcome jsonb;

CREATE TABLE public.fulfillment_operator_attempts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 shipment_id uuid NOT NULL REFERENCES public.fulfillment_shipments(id),
 order_id uuid NOT NULL REFERENCES public.commerce_orders(id),
 idempotency_key text NOT NULL UNIQUE,
 provider_key text NOT NULL,
 status text NOT NULL CHECK (status IN ('recorded','succeeded','failed')),
 payload jsonb NOT NULL DEFAULT '{}',
 error jsonb,
 actor_type text NOT NULL,
 actor_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.fulfillment_operator_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.fulfillment_operator_attempts FROM PUBLIC;

ALTER TABLE public.fulfillment_shipment_operations DROP CONSTRAINT fulfillment_shipment_operations_operation_type_check;
ALTER TABLE public.fulfillment_shipment_operations ADD CONSTRAINT fulfillment_shipment_operations_operation_type_check CHECK (operation_type IN ('shipment_created','shipment_advanced','evidence_recorded','shipment_cancelled','shipment_exception_raised','order_routed','provider_attempt_recorded'));

CREATE FUNCTION public.fulfillment_dispatch_outcome(p_result jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE e jsonb:=coalesce(p_result->'error','{}'); code text;
BEGIN
 IF p_result->>'kind' NOT IN ('accepted','unknown','not_dispatched') THEN
  RAISE EXCEPTION 'fulfillment_dispatch_result_invalid' USING ERRCODE='22023'; END IF;
 code:=e->>'code';
 IF code IS NULL OR code !~ '^[A-Za-z0-9][A-Za-z0-9_]{0,95}$' THEN code:='operation_failed'; END IF;
 RETURN jsonb_build_object('classification',CASE WHEN p_result->>'kind'='not_dispatched' THEN 'failed' ELSE 'uncertain' END,
  'code',code,'status',CASE WHEN jsonb_typeof(e->'status')='number' AND (e->>'status')::numeric BETWEEN 100 AND 599 AND trunc((e->>'status')::numeric)=(e->>'status')::numeric THEN e->'status' ELSE 'null'::jsonb END,
  'retryable',coalesce(e->'retryable'='true'::jsonb,false),'mayHaveSucceeded',p_result->>'kind'<>'not_dispatched')
  || CASE WHEN jsonb_typeof(e->'submissionAttempted')='boolean' THEN jsonb_build_object('submissionAttempted',e->'submissionAttempted') ELSE '{}' END
  || CASE WHEN jsonb_typeof(e->'responseBodyRead')='boolean' THEN jsonb_build_object('responseBodyRead',e->'responseBodyRead') ELSE '{}' END;
END; $$;

CREATE FUNCTION public.fulfillment_record_operator_attempt(p_key text,p_shipment_id uuid,p_provider_key text,p_status text,p_payload jsonb,p_error jsonb,p_actor_type text,p_actor_id uuid,p_metadata jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE prior public.fulfillment_operator_attempts; parcel public.fulfillment_shipments;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('fulfillment-operator-attempt|'||p_key,0));
 SELECT * INTO prior FROM public.fulfillment_operator_attempts WHERE idempotency_key=p_key;
 IF FOUND THEN
  RETURN jsonb_build_object('contractVersion','commerce.fulfillment.v0','fulfillmentOrderId',prior.shipment_id,'orderId',prior.order_id,
   'status',(SELECT status FROM public.fulfillment_shipments WHERE id=prior.shipment_id),'replayed',true);
 END IF;
 SELECT * INTO parcel FROM public.fulfillment_shipments WHERE id=p_shipment_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'commerce_fulfillment_not_found' USING ERRCODE='22023'; END IF;
 IF nullif(btrim(p_key),'') IS NULL OR nullif(btrim(p_provider_key),'') IS NULL OR p_actor_type IS DISTINCT FROM 'operator'
  OR p_actor_id IS NULL OR p_status IS NULL OR p_status NOT IN ('recorded','succeeded','failed')
  OR jsonb_typeof(p_payload) IS DISTINCT FROM 'object' THEN
  RAISE EXCEPTION 'commerce_fulfillment_invalid_input' USING ERRCODE='22023'; END IF;
 INSERT INTO public.fulfillment_operator_attempts(shipment_id,order_id,idempotency_key,provider_key,status,payload,error,actor_type,actor_id)
 VALUES(parcel.id,parcel.order_id,p_key,p_provider_key,p_status,p_payload,p_error,p_actor_type,p_actor_id);
 INSERT INTO public.fulfillment_shipment_operations(shipment_id,order_id,operation_type,idempotency_key,payload)
 VALUES(parcel.id,parcel.order_id,'provider_attempt_recorded',p_key||':operation',jsonb_build_object('providerRef',p_provider_key,'status',p_status,'actorId',p_actor_id));
 RETURN jsonb_build_object('contractVersion','commerce.fulfillment.v0','fulfillmentOrderId',parcel.id,'orderId',parcel.order_id,'status',parcel.status,'replayed',false);
END; $$;

CREATE OR REPLACE FUNCTION public.fulfillment_dispatch_claim(p_key text, p_shipment uuid, p_order uuid, p_parcel text, p_mode text, p_evidence jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE v_ref public.fulfillment_dispatch_refs%ROWTYPE; v_context public.fulfillment_dispatch_contexts%ROWTYPE; v_replayed boolean;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('native-dispatch|' || p_shipment::text,0));
 PERFORM id FROM public.fulfillment_shipments WHERE id=p_shipment AND order_id=p_order FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'fulfillment_dispatch_identity_invalid' USING ERRCODE='22023'; END IF;
 SELECT * INTO v_context FROM public.fulfillment_dispatch_contexts WHERE shipment_id=p_shipment FOR UPDATE;
 IF NOT FOUND OR v_context.withheld THEN RETURN jsonb_build_object('kind','refused','refusal',jsonb_build_object('reason','withheld','phase','claim','retryable',false)); END IF;
 IF v_context.provider_ref IS DISTINCT FROM p_evidence->>'providerRef' THEN RETURN jsonb_build_object('kind','refused','refusal',jsonb_build_object('reason','provider_mismatch','phase','claim','retryable',false)); END IF;
 IF v_context.contact_revision IS DISTINCT FROM p_evidence->'contactRevision' THEN
  RETURN jsonb_build_object('kind','refused','refusal',jsonb_build_object('reason','contact_stale','phase','claim','retryable',true));
 END IF;
 IF p_evidence->>'commandFingerprint' IS NULL OR p_evidence->>'commandFingerprint' !~ '^[a-f0-9]{64}$' OR btrim(COALESCE(p_evidence->>'providerRef',''))='' THEN
  RAISE EXCEPTION 'fulfillment_dispatch_evidence_invalid' USING ERRCODE='22023';
 END IF;
 SELECT * INTO v_ref FROM public.fulfillment_dispatch_refs WHERE request_key=p_key OR shipment_id=p_shipment FOR UPDATE;
 v_replayed := FOUND;
 IF FOUND THEN
  IF v_ref.request_key<>p_key OR v_ref.shipment_id<>p_shipment OR v_ref.order_id<>p_order OR v_ref.parcel_ref IS DISTINCT FROM p_parcel OR v_ref.evidence->>'providerRef' IS DISTINCT FROM p_evidence->>'providerRef' THEN
   RAISE EXCEPTION 'fulfillment_dispatch_key_conflict' USING ERRCODE='23505';
  END IF;
  IF v_ref.status='draft' AND v_ref.external_ref IS NULL THEN
   v_replayed := v_ref.evidence IS NOT DISTINCT FROM p_evidence
    AND (v_ref.mode=p_mode OR (v_ref.mode IN ('stage','live') AND p_mode='shadow'));
   UPDATE public.fulfillment_dispatch_refs SET evidence=p_evidence,
    mode=CASE WHEN v_ref.mode IN ('stage','live') AND p_mode='shadow' THEN v_ref.mode ELSE p_mode END,
    remap_count=CASE WHEN v_ref.evidence IS DISTINCT FROM p_evidence THEN 1 ELSE remap_count END,
    updated_at=CASE WHEN v_replayed THEN updated_at ELSE now() END
    WHERE id=v_ref.id RETURNING * INTO v_ref;
  ELSIF v_ref.evidence->>'commandFingerprint' IS DISTINCT FROM p_evidence->>'commandFingerprint' OR v_ref.mode<>p_mode THEN
   RAISE EXCEPTION 'fulfillment_dispatch_key_conflict' USING ERRCODE='23505';
  END IF;
 ELSE
  INSERT INTO public.fulfillment_dispatch_refs(request_key,shipment_id,order_id,parcel_ref,mode,evidence)
  VALUES(p_key,p_shipment,p_order,p_parcel,p_mode,p_evidence) RETURNING * INTO v_ref;
 END IF;
 RETURN jsonb_build_object('kind','claimed','record',public.fulfillment_dispatch_read(v_ref,v_replayed));
END;
$$;

CREATE OR REPLACE FUNCTION public.fulfillment_record_provider_attempt(p_key text,p_shipment uuid,p_evidence jsonb,p_mode text)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE v_attempt public.fulfillment_provider_attempts%ROWTYPE;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('native-dispatch|' || p_shipment::text,0));
 PERFORM id FROM public.fulfillment_shipments WHERE id=p_shipment FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'fulfillment_attempt_shipment_missing' USING ERRCODE='22023'; END IF;
 SELECT * INTO v_attempt FROM public.fulfillment_provider_attempts WHERE attempt_key=p_key;
 IF FOUND THEN
  IF v_attempt.shipment_id<>p_shipment OR v_attempt.provider_kind IS DISTINCT FROM p_evidence->>'providerRef' THEN RAISE EXCEPTION 'fulfillment_attempt_key_conflict' USING ERRCODE='23505'; END IF;
  RETURN jsonb_build_object('replayed',true);
 END IF;
 IF NOT EXISTS (SELECT 1 FROM public.fulfillment_dispatch_refs WHERE shipment_id=p_shipment AND evidence=p_evidence AND (mode=p_mode OR (mode IN ('stage','live') AND p_mode='shadow'))) THEN
  RAISE EXCEPTION 'fulfillment_attempt_unclaimed_evidence' USING ERRCODE='22023';
 END IF;
 INSERT INTO public.fulfillment_provider_attempts(attempt_key,shipment_id,provider_kind,mode,evidence,status)
 VALUES(p_key,p_shipment,p_evidence->>'providerRef',p_mode,p_evidence,'recorded');
 RETURN jsonb_build_object('replayed',false);
END;
$$;

CREATE OR REPLACE FUNCTION public.fulfillment_dispatch_finish(p_id uuid,p_result jsonb,p_ack boolean,p_intake_channel text)
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
    acceptance=p_result,outcome=CASE WHEN p_ack THEN NULL ELSE public.fulfillment_dispatch_outcome(p_result) END,updated_at=now() WHERE id=p_id RETURNING * INTO v_ref;
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
   UPDATE public.fulfillment_dispatch_refs SET status=CASE WHEN p_result->>'kind'='unknown' THEN 'uncertain' ELSE 'failed' END,outcome=public.fulfillment_dispatch_outcome(p_result),updated_at=now() WHERE id=p_id RETURNING * INTO v_ref;
  END IF;
 END IF;
 IF p_ack THEN RETURN jsonb_build_object('acknowledged',true,'replayed',v_replayed,'record',public.fulfillment_dispatch_read(v_ref,v_replayed)); END IF;
 RETURN public.fulfillment_dispatch_read(v_ref,v_replayed);
END;
$$;

CREATE FUNCTION public.fulfillment_operator_create_order(p_key text,p_order_id uuid,p_port_key text,p_actor_id uuid,p_metadata jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE purchase public.commerce_orders; parcel public.fulfillment_shipments; destination jsonb; address jsonb; customer public.clients;
 contact jsonb; resolution jsonb; mode text; created jsonb;
BEGIN
 IF p_key IS NULL OR length(btrim(p_key))<8 OR p_order_id IS NULL THEN
  RAISE EXCEPTION 'commerce_fulfillment_invalid_input' USING ERRCODE='22023'; END IF;
 -- Replay remains first-write: return the recorded parcel and its current status.
 SELECT * INTO parcel FROM public.fulfillment_shipments WHERE create_idempotency_key=p_key OR (order_id=p_order_id AND sequence_no=0) LIMIT 1;
 IF FOUND THEN RETURN jsonb_build_object('contractVersion','commerce.fulfillment.v0','fulfillmentOrderId',parcel.id,'orderId',parcel.order_id,'status',parcel.status,'replayed',true); END IF;
 SELECT * INTO purchase FROM public.commerce_orders WHERE id=p_order_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'commerce_fulfillment_order_not_found' USING ERRCODE='22023'; END IF;
 -- A concurrent creator may have committed while this call waited for the order.
 SELECT * INTO parcel FROM public.fulfillment_shipments WHERE order_id=p_order_id AND sequence_no=0;
 IF FOUND THEN RETURN jsonb_build_object('contractVersion','commerce.fulfillment.v0','fulfillmentOrderId',parcel.id,'orderId',parcel.order_id,'status',parcel.status,'replayed',true); END IF;
 IF purchase.status NOT IN ('paid','fulfillment_pending') THEN RAISE EXCEPTION 'commerce_fulfillment_order_not_fulfillable' USING ERRCODE='22023'; END IF;
 IF purchase.client_id IS NULL THEN RAISE EXCEPTION 'commerce_fulfillment_missing_client' USING ERRCODE='22023'; END IF;
 mode:=purchase.metadata#>>'{orderDraftSnapshot,context,mode}';
 IF mode IS NULL OR mode NOT IN ('one_time','subscription_cycle') THEN RAISE EXCEPTION 'commerce_fulfillment_order_mode_unproven' USING ERRCODE='22023'; END IF;
 destination:=public.commerce_read_destination('order',purchase.id); address:=destination->'address';
 SELECT * INTO customer FROM public.clients WHERE id=purchase.client_id;
 IF NOT (purchase.metadata ? 'deliveryContactOverride') AND NOT (coalesce(purchase.metadata->'runtimeFinalize','{}') ? 'deliveryContact')
  AND purchase.metadata ? 'channelOrderSnapshot' AND jsonb_typeof(purchase.metadata->'channelOrderSnapshot') IS DISTINCT FROM 'object' THEN
  RAISE EXCEPTION 'commerce_fulfillment_delivery_contact_invalid' USING ERRCODE='22023'; END IF;
 resolution:=public.fulfillment_delivery_contact_resolve(jsonb_build_object(
  'frozenContactPresent',purchase.metadata ? 'deliveryContactOverride' OR coalesce(purchase.metadata->'runtimeFinalize','{}') ? 'deliveryContact',
  'frozenContact',CASE WHEN purchase.metadata ? 'deliveryContactOverride' THEN purchase.metadata->'deliveryContactOverride' ELSE purchase.metadata#>'{runtimeFinalize,deliveryContact}' END,
  'channelOrderSnapshot',purchase.metadata->'channelOrderSnapshot',
  'selectedDeliveryCandidates',jsonb_build_array(purchase.metadata->'selectedDelivery',purchase.metadata#>'{runtimeFinalize,selectedDelivery}',address->'selectedDelivery'),
  'recipientCandidates',jsonb_build_array(address->>'recipientName',concat_ws(' ',customer.first_name,customer.last_name),address->>'label'),
  'phoneCandidates',jsonb_build_array(address->>'contactPhone',customer.phone),'legacyClientEmail',customer.email,
  'line1',address->>'line1','line2',address->>'line2','city',address->>'city','postalCode',address->>'postalCode','country',address->>'country',
  'deliveryInstructions',address->>'deliveryNotes','courierInstructions',address->>'courierInstructions'));
 IF NOT coalesce((resolution->>'destinationComplete')::boolean,false) THEN RAISE EXCEPTION 'commerce_fulfillment_delivery_contact_invalid' USING ERRCODE='22023'; END IF;
 contact:=resolution->'contact';
 IF NOT EXISTS(SELECT 1 FROM public.commerce_settlement_intents WHERE order_id=purchase.id AND status='settled') THEN
  RAISE EXCEPTION 'commerce_fulfillment_payment_not_succeeded' USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM public.commerce_order_holds WHERE order_id=purchase.id AND status='active') THEN RAISE EXCEPTION 'commerce_fulfillment_active_hold' USING ERRCODE='22023'; END IF;
 IF mode='subscription_cycle' AND NOT EXISTS(SELECT 1 FROM public.subscription_cycles WHERE id=purchase.subscription_cycle_id AND status='paid') THEN
  RAISE EXCEPTION 'commerce_fulfillment_subscription_cycle_not_paid' USING ERRCODE='22023'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.commerce_order_items WHERE order_id=purchase.id) THEN RAISE EXCEPTION 'commerce_fulfillment_missing_order_items' USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM public.commerce_order_items oi LEFT JOIN public.catalog_skus cs ON cs.id=oi.sku_id WHERE oi.order_id=purchase.id AND cs.id IS NULL) THEN
  RAISE EXCEPTION 'commerce_fulfillment_missing_catalog_sku' USING ERRCODE='22023'; END IF;
 created:=public.fulfillment_create_shipment(p_key,purchase.id,p_port_key,coalesce(p_metadata,'{}')||jsonb_build_object('actorId',p_actor_id),now());
 SELECT * INTO parcel FROM public.fulfillment_shipments WHERE id=(created#>>'{shipment,id}')::uuid;
 -- The canonical opener captures only the new parcel's recorded reservation generation.
 IF EXISTS(SELECT 1 FROM public.fulfillment_parcel_lines line WHERE line.shipment_id=parcel.id AND
  coalesce((SELECT sum(a.quantity) FROM public.fulfillment_parcel_line_reservations a JOIN public.fulfillment_inventory_reservations r ON r.id=a.reservation_id
   WHERE a.line_id=line.id AND r.status IN ('held','committed')),0)<line.quantity) THEN
  RAISE EXCEPTION 'commerce_fulfillment_missing_inventory_reservation' USING ERRCODE='22023'; END IF;
 PERFORM public.commerce_read_destination('shipment',parcel.id);
 PERFORM public.fulfillment_capture_parcel_contact(parcel.id,contact);
 RETURN jsonb_build_object('contractVersion','commerce.fulfillment.v0','fulfillmentOrderId',parcel.id,'orderId',parcel.order_id,'status',parcel.status,'replayed',false);
END; $$;

CREATE FUNCTION public.fulfillment_dispatch_candidate_ids(p_port_key text,p_provider_key text,p_limit integer)
RETURNS TABLE(shipment_id uuid) LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
 SELECT s.id FROM public.fulfillment_shipments s JOIN public.commerce_orders o ON o.id=s.order_id
 LEFT JOIN public.fulfillment_dispatch_refs r ON r.shipment_id=s.id
 WHERE s.port_key=p_port_key AND s.status IN ('created','label_pending') AND
 ((r.external_ref IS NOT NULL AND r.mode IN ('stage','live') AND r.status IN ('created','uncertain') AND r.evidence->>'providerRef'=p_provider_key)
 OR (o.status IN ('paid','fulfillment_pending') AND (r.id IS NULL OR (r.status='draft' AND r.external_ref IS NULL))
  AND EXISTS(SELECT 1 FROM public.commerce_settlement_intents i WHERE i.order_id=o.id AND i.status='settled')
  AND NOT EXISTS(SELECT 1 FROM public.commerce_order_holds h WHERE h.order_id=o.id AND h.status='active')))
 ORDER BY s.created_at,s.id LIMIT greatest(1,least(coalesce(p_limit,25),100));
$$;

CREATE FUNCTION public.fulfillment_native_dispatch_begin(p_id uuid,p_fingerprint text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE ref public.fulfillment_dispatch_refs; purchase public.commerce_orders; reason text;
BEGIN
 SELECT * INTO ref FROM public.fulfillment_dispatch_refs WHERE id=p_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'fulfillment_dispatch_missing' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('native-dispatch|'||ref.shipment_id::text,0));
 PERFORM id FROM public.fulfillment_shipments WHERE id=ref.shipment_id FOR UPDATE;
 SELECT * INTO ref FROM public.fulfillment_dispatch_refs WHERE id=p_id FOR UPDATE;
 IF ref.status<>'draft' THEN RETURN public.fulfillment_dispatch_begin(p_id,p_fingerprint); END IF;
 SELECT * INTO purchase FROM public.commerce_orders WHERE id=ref.order_id FOR UPDATE;
 IF NOT EXISTS(SELECT 1 FROM public.fulfillment_parcel_reservation_sets WHERE shipment_id=ref.shipment_id) THEN reason:='dispatch_reservations_not_recorded';
 ELSIF purchase.metadata#>>'{orderDraftSnapshot,context,mode}' IS NULL OR purchase.metadata#>>'{orderDraftSnapshot,context,mode}' NOT IN ('one_time','subscription_cycle') THEN reason:='order_mode_unproven';
 ELSIF NOT EXISTS(SELECT 1 FROM public.fulfillment_parcel_contacts c WHERE c.shipment_id=ref.shipment_id AND c.erased_at IS NULL AND jsonb_typeof(c.contact)='object') OR EXISTS(SELECT 1 FROM public.identity_privacy_erasures WHERE client_id=purchase.client_id) THEN reason:='not_dispatchable';
 ELSIF NOT EXISTS(SELECT 1 FROM public.commerce_settlement_intents WHERE order_id=ref.order_id AND status='settled') THEN reason:='payment_not_succeeded';
 ELSIF purchase.metadata#>>'{orderDraftSnapshot,context,mode}'='subscription_cycle' AND NOT EXISTS(SELECT 1 FROM public.subscription_cycles WHERE id=purchase.subscription_cycle_id AND status='paid') THEN reason:='subscription_cycle_not_paid'; END IF;
 IF reason IS NOT NULL THEN RETURN jsonb_build_object('kind','refused','refusal',jsonb_build_object('reason',reason,'phase','begin','retryable',false)); END IF;
 UPDATE public.fulfillment_dispatch_refs SET outcome=NULL WHERE id=p_id;
 RETURN public.fulfillment_dispatch_begin(p_id,p_fingerprint);
END; $$;

CREATE FUNCTION public.fulfillment_dispatch_mark_stale_submissions_uncertain(p_before timestamptz)
RETURNS integer LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE count integer;
BEGIN
 UPDATE public.fulfillment_dispatch_refs SET status='uncertain',updated_at=now(),
 outcome=jsonb_build_object('classification','uncertain','code','dispatch_submission_stale','status',NULL,'retryable',false,'mayHaveSucceeded',true,'submissionAttempted',true)
 WHERE status='submitting' AND updated_at<p_before;
 GET DIAGNOSTICS count=ROW_COUNT;
 RETURN count;
END; $$;










CREATE FUNCTION public.fulfillment_dispatch_read_candidate(p_shipment_id uuid,p_provider_key text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE parcel public.fulfillment_shipments; purchase public.commerce_orders; ref public.fulfillment_dispatch_refs;
 contact jsonb; resolution jsonb; lines jsonb; candidate jsonb;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('native-dispatch|'||p_shipment_id::text,0));
 SELECT * INTO parcel FROM public.fulfillment_shipments WHERE id=p_shipment_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'fulfillment_preparation_shipment_missing' USING ERRCODE='22023'; END IF;
 SELECT * INTO purchase FROM public.commerce_orders WHERE id=parcel.order_id;
 candidate:=jsonb_build_object('requestKey',parcel.create_idempotency_key,'fulfillmentRef',parcel.id,'orderRef',parcel.order_id,
  'orderNumber',purchase.metadata->>'orderNumber','parcelRef',NULL);
 SELECT * INTO ref FROM public.fulfillment_dispatch_refs WHERE shipment_id=parcel.id;
 IF FOUND AND ref.external_ref IS NOT NULL AND ref.status IN ('created','uncertain') AND ref.mode IN ('stage','live') AND ref.evidence->>'providerRef'=p_provider_key THEN
  -- ACK repair needs identity only. It precedes all contact preparation and admission.
  RETURN candidate||jsonb_build_object('recovery',true);
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.fulfillment_parcel_reservation_sets WHERE shipment_id=parcel.id) THEN
  RAISE EXCEPTION 'dispatch_reservations_not_recorded' USING ERRCODE='22023'; END IF;
 IF purchase.metadata#>>'{orderDraftSnapshot,context,mode}' IS NULL OR purchase.metadata#>>'{orderDraftSnapshot,context,mode}' NOT IN ('one_time','subscription_cycle') THEN
  RAISE EXCEPTION 'order_mode_unproven' USING ERRCODE='22023'; END IF;
 contact:=public.fulfillment_resolve_parcel_contact(parcel.id);
 resolution:=public.fulfillment_delivery_contact_resolve(jsonb_build_object('frozenContactPresent',true,'frozenContact',contact));
 IF NOT coalesce((resolution->>'carrierComplete')::boolean,false) OR
  coalesce(contact#>>'{selectedDelivery,providerKind}',contact#>>'{selectedDelivery,providerRef}') IS DISTINCT FROM p_provider_key THEN RETURN NULL; END IF;
 SELECT jsonb_agg(jsonb_build_object('skuRef',sku,'title',title,'quantity',quantity,
  'productRef',product_snapshot->>'productRef','packRef',product_snapshot->>'packRef',
  'lotRef',product_snapshot->>'lotNumber','expirationDate',product_snapshot->>'expirationDate') ORDER BY id) INTO lines
 FROM public.fulfillment_parcel_lines WHERE shipment_id=parcel.id;
 IF lines IS NULL THEN RAISE EXCEPTION 'commerce_fulfillment_missing_order_items' USING ERRCODE='22023'; END IF;
 RETURN candidate||jsonb_build_object('contact',contact,'lines',lines);
END; $$;

REVOKE ALL ON FUNCTION public.fulfillment_dispatch_outcome(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fulfillment_record_operator_attempt(text,uuid,text,text,jsonb,jsonb,text,uuid,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fulfillment_dispatch_claim(text,uuid,uuid,text,text,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fulfillment_record_provider_attempt(text,uuid,jsonb,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fulfillment_dispatch_finish(uuid,jsonb,boolean,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fulfillment_operator_create_order(text,uuid,text,uuid,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fulfillment_dispatch_candidate_ids(text,text,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fulfillment_native_dispatch_begin(uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fulfillment_dispatch_mark_stale_submissions_uncertain(timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fulfillment_dispatch_read_candidate(uuid,text) FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
 EXECUTE 'REVOKE ALL ON FUNCTION public.fulfillment_dispatch_outcome(jsonb) FROM anon;';
 EXECUTE 'REVOKE ALL ON FUNCTION public.fulfillment_record_operator_attempt(text,uuid,text,text,jsonb,jsonb,text,uuid,jsonb) FROM anon;';
 EXECUTE 'REVOKE ALL ON FUNCTION public.fulfillment_dispatch_claim(text,uuid,uuid,text,text,jsonb) FROM anon;';
 EXECUTE 'REVOKE ALL ON FUNCTION public.fulfillment_record_provider_attempt(text,uuid,jsonb,text) FROM anon;';
 EXECUTE 'REVOKE ALL ON FUNCTION public.fulfillment_dispatch_finish(uuid,jsonb,boolean,text) FROM anon;';
 EXECUTE 'REVOKE ALL ON FUNCTION public.fulfillment_operator_create_order(text,uuid,text,uuid,jsonb) FROM anon;';
 EXECUTE 'REVOKE ALL ON FUNCTION public.fulfillment_dispatch_candidate_ids(text,text,integer) FROM anon;';
 EXECUTE 'REVOKE ALL ON FUNCTION public.fulfillment_native_dispatch_begin(uuid,text) FROM anon;';
 EXECUTE 'REVOKE ALL ON FUNCTION public.fulfillment_dispatch_mark_stale_submissions_uncertain(timestamptz) FROM anon;';
 EXECUTE 'REVOKE ALL ON FUNCTION public.fulfillment_dispatch_read_candidate(uuid,text) FROM anon;';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
 EXECUTE 'REVOKE ALL ON FUNCTION public.fulfillment_dispatch_outcome(jsonb) FROM authenticated;';
 EXECUTE 'REVOKE ALL ON FUNCTION public.fulfillment_record_operator_attempt(text,uuid,text,text,jsonb,jsonb,text,uuid,jsonb) FROM authenticated;';
 EXECUTE 'REVOKE ALL ON FUNCTION public.fulfillment_dispatch_claim(text,uuid,uuid,text,text,jsonb) FROM authenticated;';
 EXECUTE 'REVOKE ALL ON FUNCTION public.fulfillment_record_provider_attempt(text,uuid,jsonb,text) FROM authenticated;';
 EXECUTE 'REVOKE ALL ON FUNCTION public.fulfillment_dispatch_finish(uuid,jsonb,boolean,text) FROM authenticated;';
 EXECUTE 'REVOKE ALL ON FUNCTION public.fulfillment_operator_create_order(text,uuid,text,uuid,jsonb) FROM authenticated;';
 EXECUTE 'REVOKE ALL ON FUNCTION public.fulfillment_dispatch_candidate_ids(text,text,integer) FROM authenticated;';
 EXECUTE 'REVOKE ALL ON FUNCTION public.fulfillment_native_dispatch_begin(uuid,text) FROM authenticated;';
 EXECUTE 'REVOKE ALL ON FUNCTION public.fulfillment_dispatch_mark_stale_submissions_uncertain(timestamptz) FROM authenticated;';
 EXECUTE 'REVOKE ALL ON FUNCTION public.fulfillment_dispatch_read_candidate(uuid,text) FROM authenticated;';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
 EXECUTE 'GRANT EXECUTE ON FUNCTION public.fulfillment_dispatch_outcome(jsonb) TO service_role;';
 EXECUTE 'GRANT EXECUTE ON FUNCTION public.fulfillment_record_operator_attempt(text,uuid,text,text,jsonb,jsonb,text,uuid,jsonb) TO service_role;';
 EXECUTE 'GRANT EXECUTE ON FUNCTION public.fulfillment_dispatch_claim(text,uuid,uuid,text,text,jsonb) TO service_role;';
 EXECUTE 'GRANT EXECUTE ON FUNCTION public.fulfillment_record_provider_attempt(text,uuid,jsonb,text) TO service_role;';
 EXECUTE 'GRANT EXECUTE ON FUNCTION public.fulfillment_dispatch_finish(uuid,jsonb,boolean,text) TO service_role;';
 EXECUTE 'GRANT EXECUTE ON FUNCTION public.fulfillment_operator_create_order(text,uuid,text,uuid,jsonb) TO service_role;';
 EXECUTE 'GRANT EXECUTE ON FUNCTION public.fulfillment_dispatch_candidate_ids(text,text,integer) TO service_role;';
 EXECUTE 'GRANT EXECUTE ON FUNCTION public.fulfillment_native_dispatch_begin(uuid,text) TO service_role;';
 EXECUTE 'GRANT EXECUTE ON FUNCTION public.fulfillment_dispatch_mark_stale_submissions_uncertain(timestamptz) TO service_role;';
 EXECUTE 'GRANT EXECUTE ON FUNCTION public.fulfillment_dispatch_read_candidate(uuid,text) TO service_role;';
END IF; END; $$;
