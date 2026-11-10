-- Atomic operator shipment evidence, exact handoff stock and delivery chronology.
ALTER TABLE public.fulfillment_shipment_operations ADD COLUMN actor_user_id uuid;
ALTER TABLE public.fulfillment_shipment_operations ADD CONSTRAINT fulfillment_shipment_operations_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES public.platform_human_principals(principal_id) ON DELETE SET NULL NOT VALID;
ALTER TABLE public.shipment_external_refs ADD COLUMN provider_kind text;
ALTER TABLE public.shipment_external_refs DROP CONSTRAINT shipment_external_refs_shipment_role_id_key;
ALTER TABLE public.shipment_external_refs ADD CONSTRAINT shipment_external_refs_shipment_role_id_key UNIQUE NULLS NOT DISTINCT (shipment_id,ref_role,external_id,provider_kind);
ALTER TABLE public.fulfillment_operator_receipts DROP CONSTRAINT fulfillment_operator_receipts_kind_check;
ALTER TABLE public.fulfillment_operator_receipts ADD CONSTRAINT fulfillment_operator_receipts_kind_check CHECK (kind IN ('replacement','cancel','consume','label','handoff','tracking'));
CREATE OR REPLACE FUNCTION public.fulfillment_record_alignment_arrival(p_key text,p_shipment uuid,p_arrived timestamptz,p_evidence text)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE v_arrival public.subscription_delivery_alignment_arrivals%ROWTYPE; v_replayed boolean; v_subscription uuid; v_operator boolean;
BEGIN
 IF btrim(COALESCE(p_key,''))='' OR p_arrived IS NULL OR p_evidence NOT LIKE 'evidence:%' OR p_evidence IS NULL THEN RAISE EXCEPTION 'fulfillment_arrival_invalid' USING ERRCODE='22023'; END IF;
 -- Arrival commands lock subscription before shipment, then the delivery trigger
 -- locks the case. Direct shipment writes already hold the shipment lock when
 -- their AFTER trigger acquires the subscription; callers must use this command
 -- or acquire the subscription first to preserve the same lock order.
 SELECT cycle.subscription_id INTO v_subscription FROM public.fulfillment_shipments shipment
 JOIN public.commerce_orders order_row ON order_row.id=shipment.order_id
 JOIN public.subscription_cycles cycle ON cycle.id=order_row.subscription_cycle_id WHERE shipment.id=p_shipment;
 IF v_subscription IS NOT NULL THEN PERFORM id FROM public.subscriptions WHERE id=v_subscription FOR UPDATE; END IF;
 PERFORM id FROM public.fulfillment_shipments WHERE id=p_shipment FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'fulfillment_arrival_shipment_missing' USING ERRCODE='22023'; END IF;
 SELECT * INTO v_arrival FROM public.subscription_delivery_alignment_arrivals WHERE request_key=p_key;
 v_replayed := FOUND;
 v_operator := p_key='operator-tracking-arrival|'||p_shipment::text AND p_evidence='evidence:operator-tracking:'||p_shipment::text;
 IF FOUND THEN
  IF v_arrival.shipment_id<>p_shipment OR (NOT v_operator AND v_arrival.delivered_at<>p_arrived) OR v_arrival.evidence_ref<>p_evidence THEN RAISE EXCEPTION 'fulfillment_arrival_key_conflict' USING ERRCODE='23505'; END IF;
 ELSE
  INSERT INTO public.subscription_delivery_alignment_arrivals VALUES(p_key,p_shipment,p_arrived,p_evidence);
 END IF;
 -- Ordinary arrival keys retain strict replay. Operator chronology can only repair earlier.
 UPDATE public.fulfillment_shipments SET delivered_at=p_arrived,updated_at=now()
 WHERE id=p_shipment AND (NOT v_replayed OR v_operator)
 AND (delivered_at IS NULL OR (v_operator AND p_arrived<delivered_at));
 RETURN jsonb_build_object('replayed',v_replayed);
END;
$$;
CREATE FUNCTION public.fulfillment_operator_record_label(p_key text,p_shipment uuid,p_command jsonb,p_actor uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE parcel public.fulfillment_shipments; prior public.fulfillment_operator_receipts; answer jsonb; conflicting_order uuid;
 provider text:=p_command->>'providerKind'; tracking text:=p_command->>'providerTrackingId'; previous_refs jsonb;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('operator-label-key|'||coalesce(p_key,''),0));
 SELECT * INTO prior FROM public.fulfillment_operator_receipts WHERE kind='label' AND idempotency_key=p_key;
 IF FOUND THEN
  SELECT * INTO parcel FROM public.fulfillment_shipments WHERE id=(prior.result->>'fulfillmentOrderId')::uuid;
  RETURN prior.result||jsonb_build_object('status',parcel.status,'replayed',true);
 END IF;
 IF nullif(btrim(p_key),'') IS NULL OR nullif(btrim(provider),'') IS NULL OR (tracking IS NOT NULL AND nullif(btrim(tracking),'') IS NULL) THEN
  RAISE EXCEPTION 'commerce_fulfillment_label_invalid' USING ERRCODE='22023'; END IF;
 -- Serialize all namespaces of this number, including unattributed historical evidence.
 PERFORM pg_advisory_xact_lock(hashtextextended('operator-tracking-reference|'||tracking,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('native-dispatch|'||p_shipment::text,0));
 SELECT * INTO parcel FROM public.fulfillment_shipments WHERE id=p_shipment FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'commerce_fulfillment_not_found' USING ERRCODE='22023'; END IF;
 IF parcel.status IN ('handed_over','in_transit','delivered','cancelled') THEN
  RAISE EXCEPTION 'commerce_fulfillment_label_invalid_status' USING ERRCODE='22023'; END IF;
 SELECT s.order_id INTO conflicting_order FROM public.shipment_external_refs r JOIN public.fulfillment_shipments s ON s.id=r.shipment_id
 WHERE r.ref_role='tracking' AND r.external_id=tracking AND r.provider_kind IS NULL AND s.order_id<>parcel.order_id
 ORDER BY s.order_id,r.id LIMIT 1;
 IF FOUND THEN RAISE EXCEPTION 'commerce_fulfillment_tracking_reference_unattributed' USING ERRCODE='23505',
  DETAIL=jsonb_build_object('conflictingOrderId',conflicting_order)::text; END IF;
 IF EXISTS(SELECT 1 FROM public.shipment_external_refs r JOIN public.fulfillment_shipments s ON s.id=r.shipment_id
  WHERE r.ref_role='tracking' AND r.external_id=tracking AND r.provider_kind=provider AND s.order_id<>parcel.order_id) THEN
  RAISE EXCEPTION 'commerce_fulfillment_tracking_ref_conflict' USING ERRCODE='23505'; END IF;
 -- Retain the previous native references in the private command receipt before reattribution.
 SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id),'[]') INTO previous_refs
 FROM public.shipment_external_refs r JOIN public.fulfillment_shipments s ON s.id=r.shipment_id
 WHERE s.order_id=parcel.order_id AND r.ref_role='tracking' AND r.external_id=tracking AND (r.provider_kind=provider OR r.provider_kind IS NULL);
 DELETE FROM public.shipment_external_refs r USING public.fulfillment_shipments s
 WHERE s.id=r.shipment_id AND s.order_id=parcel.order_id AND r.ref_role='tracking' AND r.external_id=tracking AND (r.provider_kind=provider OR r.provider_kind IS NULL);
 IF tracking IS NOT NULL THEN
  INSERT INTO public.shipment_external_refs(shipment_id,ref_role,external_id,provider_kind) VALUES(parcel.id,'tracking',tracking,provider);
 END IF;
 UPDATE public.fulfillment_shipments SET status='label_created',updated_at=now() WHERE id=parcel.id;
 INSERT INTO public.fulfillment_shipment_operations(shipment_id,order_id,operation_type,idempotency_key,actor_user_id,payload)
 VALUES(parcel.id,parcel.order_id,'shipment_advanced',p_key||':operation',p_actor,
  jsonb_build_object('toStatus','label_created','providerKind',provider,'providerTrackingId',tracking,'labelUrl',p_command->'labelUrl','customerTrackingDeferred',tracking IS NULL));
 answer:=jsonb_build_object('contractVersion','commerce.fulfillment.v0','fulfillmentOrderId',parcel.id,'orderId',parcel.order_id,'status','label_created','replayed',false);
 INSERT INTO public.fulfillment_operator_receipts(kind,idempotency_key,command,result)
 VALUES('label',p_key,jsonb_build_object('shipmentId',parcel.id,'actorUserId',p_actor,'request',p_command,'attemptStatus','succeeded','previousReferences',previous_refs),answer);
 RETURN answer;
END;
$$;
CREATE FUNCTION public.fulfillment_operator_hand_off(p_key text,p_shipment uuid,p_actor uuid,p_metadata jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE parcel public.fulfillment_shipments; prior public.fulfillment_operator_receipts; answer jsonb; consumed jsonb:='[]'; disposition text;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('operator-handoff-key|'||coalesce(p_key,''),0));
 PERFORM pg_advisory_xact_lock(hashtextextended('native-dispatch|'||p_shipment::text,0));
 SELECT * INTO parcel FROM public.fulfillment_shipments WHERE id=p_shipment FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'commerce_fulfillment_not_found' USING ERRCODE='22023'; END IF;
 disposition:=CASE WHEN EXISTS(SELECT 1 FROM public.fulfillment_parcel_reservation_sets WHERE shipment_id=parcel.id) THEN 'recorded' ELSE 'reservations_not_recorded' END;
 IF parcel.status IN ('handed_over','in_transit','delivered') THEN
  SELECT * INTO prior FROM public.fulfillment_operator_receipts WHERE kind='handoff' AND idempotency_key=jsonb_build_array(p_key,parcel.id)::text;
  IF NOT FOUND THEN
   SELECT * INTO prior FROM public.fulfillment_operator_receipts WHERE kind='handoff' AND (command->>'shipmentId')::uuid=parcel.id
   ORDER BY created_at DESC,idempotency_key DESC LIMIT 1;
  END IF;
  RETURN coalesce(prior.result,jsonb_build_object('contractVersion','commerce.fulfillment.v0','fulfillmentOrderId',parcel.id,'orderId',parcel.order_id,
    'reservationDisposition',disposition,'consumedReservationCount',0))||jsonb_build_object('status',parcel.status,'replayed',true);
 END IF;
 IF parcel.status NOT IN ('label_created','packed') THEN RAISE EXCEPTION 'commerce_fulfillment_handoff_requires_label' USING ERRCODE='22023'; END IF;
 IF disposition='recorded' THEN
  consumed:=public.fulfillment_consume_parcel_reservations(jsonb_build_array('operator-handoff',p_key,parcel.id)::text,parcel.id)->'consumedReservationIds';
 END IF;
 UPDATE public.fulfillment_shipments SET status='handed_over',handed_over_at=now(),updated_at=now() WHERE id=parcel.id;
 INSERT INTO public.fulfillment_shipment_operations(shipment_id,order_id,operation_type,idempotency_key,actor_user_id,payload)
 VALUES(parcel.id,parcel.order_id,'shipment_advanced',p_key||':operation',p_actor,
  jsonb_build_object('toStatus','handed_over','metadata',coalesce(p_metadata,'{}'),'reservationDisposition',disposition,'consumedReservationCount',jsonb_array_length(consumed)))
 ON CONFLICT(idempotency_key) DO NOTHING;
 answer:=jsonb_build_object('contractVersion','commerce.fulfillment.v0','fulfillmentOrderId',parcel.id,'orderId',parcel.order_id,'status','handed_over','replayed',false,
  'reservationDisposition',disposition,'consumedReservationCount',jsonb_array_length(consumed));
 INSERT INTO public.fulfillment_operator_receipts(kind,idempotency_key,command,result)
 VALUES('handoff',jsonb_build_array(p_key,parcel.id)::text,jsonb_build_object('idempotencyKey',p_key,'shipmentId',parcel.id,'actorUserId',p_actor,'metadata',coalesce(p_metadata,'{}'),'consumedReservationIds',consumed),answer)
 ON CONFLICT(kind,idempotency_key) DO NOTHING;
 RETURN answer;
END;
$$;
CREATE FUNCTION public.fulfillment_operator_record_tracking(p_key text,p_shipment uuid,p_command jsonb,p_actor uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE parcel public.fulfillment_shipments; op public.fulfillment_shipment_operations; answer jsonb; subscription uuid;
 target_status text:=p_command->>'status'; tracking text:=p_command->>'providerTrackingId';
 raw_time text:=nullif(btrim(p_command#>>'{rawEvent,occurredAt}'),''); delivery_time timestamptz;
BEGIN
 IF target_status='delivered' AND raw_time ~ '^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$' THEN
  BEGIN delivery_time:=raw_time::timestamptz; EXCEPTION WHEN OTHERS THEN delivery_time:=NULL; END;
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('operator-tracking-key|'||coalesce(p_key,''),0));
 -- Arrival and alignment use subscription -> parcel -> case. Never take the parcel first.
 SELECT cycle.subscription_id INTO subscription FROM public.fulfillment_shipments s JOIN public.commerce_orders o ON o.id=s.order_id
 JOIN public.subscription_cycles cycle ON cycle.id=o.subscription_cycle_id WHERE s.id=p_shipment;
 IF subscription IS NOT NULL THEN PERFORM id FROM public.subscriptions WHERE id=subscription FOR UPDATE; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('native-dispatch|'||p_shipment::text,0));
 SELECT * INTO parcel FROM public.fulfillment_shipments WHERE id=p_shipment FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'commerce_fulfillment_not_found' USING ERRCODE='22023'; END IF;
 SELECT * INTO op FROM public.fulfillment_shipment_operations WHERE idempotency_key=p_key;
 IF FOUND THEN
  IF op.shipment_id IS DISTINCT FROM p_shipment OR op.payload->>'status' IS DISTINCT FROM target_status
   OR coalesce(op.payload->>'providerTrackingId','') IS DISTINCT FROM coalesce(tracking,'') THEN
   RAISE EXCEPTION 'commerce_fulfillment_tracking_idempotency_conflict' USING ERRCODE='23505'; END IF;
  IF target_status='delivered' AND delivery_time IS NOT NULL AND (parcel.delivered_at IS NULL OR delivery_time<parcel.delivered_at) THEN
   PERFORM public.fulfillment_record_alignment_arrival('operator-tracking-arrival|'||parcel.id::text,parcel.id,delivery_time,'evidence:operator-tracking:'||parcel.id::text);
  END IF;
  RETURN jsonb_build_object('contractVersion','commerce.fulfillment.v0','fulfillmentOrderId',parcel.id,'orderId',parcel.order_id,'status',parcel.status,'replayed',true);
 END IF;
 IF target_status IS NULL OR target_status NOT IN ('in_transit','delivered','exception') THEN RAISE EXCEPTION 'commerce_fulfillment_invalid_tracking_status' USING ERRCODE='22023'; END IF;
 IF parcel.status='delivered' THEN
  IF target_status<>'delivered' THEN RAISE EXCEPTION 'commerce_fulfillment_tracking_after_delivered_forbidden' USING ERRCODE='22023'; END IF;
  IF delivery_time IS NOT NULL AND (parcel.delivered_at IS NULL OR delivery_time<parcel.delivered_at) THEN
   PERFORM public.fulfillment_record_alignment_arrival('operator-tracking-arrival|'||parcel.id::text,parcel.id,delivery_time,'evidence:operator-tracking:'||parcel.id::text);
  END IF;
  RETURN jsonb_build_object('contractVersion','commerce.fulfillment.v0','fulfillmentOrderId',parcel.id,'orderId',parcel.order_id,'status','delivered','replayed',true);
 END IF;
 IF target_status IN ('in_transit','delivered') AND parcel.status NOT IN ('handed_over','in_transit') THEN
  RAISE EXCEPTION 'commerce_fulfillment_tracking_before_handoff_forbidden' USING ERRCODE='22023'; END IF;
 IF target_status='exception' AND parcel.status NOT IN ('label_created','handed_over','in_transit','exception') THEN
  RAISE EXCEPTION 'commerce_fulfillment_tracking_before_label_forbidden' USING ERRCODE='22023'; END IF;
 IF tracking IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.shipment_external_refs r JOIN public.fulfillment_shipments s ON s.id=r.shipment_id
   WHERE s.order_id=parcel.order_id AND r.ref_role='tracking' AND r.external_id=tracking) THEN
  RAISE EXCEPTION 'commerce_fulfillment_tracking_ref_not_active' USING ERRCODE='22023'; END IF;
 IF target_status='delivered' THEN
  PERFORM public.fulfillment_record_alignment_arrival('operator-tracking-arrival|'||parcel.id::text,parcel.id,coalesce(delivery_time,now()),'evidence:operator-tracking:'||parcel.id::text);
 END IF;
 UPDATE public.fulfillment_shipments SET status=target_status,updated_at=now() WHERE id=parcel.id;
 INSERT INTO public.fulfillment_shipment_operations(shipment_id,order_id,operation_type,idempotency_key,actor_user_id,payload)
 VALUES(parcel.id,parcel.order_id,'shipment_advanced',p_key,p_actor,
  jsonb_build_object('toStatus',target_status,'status',target_status,'providerTrackingId',tracking));
 answer:=jsonb_build_object('contractVersion','commerce.fulfillment.v0','fulfillmentOrderId',parcel.id,'orderId',parcel.order_id,'status',target_status,'replayed',false);
 INSERT INTO public.fulfillment_operator_receipts(kind,idempotency_key,command,result)
 VALUES('tracking',p_key,jsonb_build_object('shipmentId',parcel.id,'actorUserId',p_actor,'request',p_command),answer);
 RETURN answer;
END;
$$;

REVOKE ALL ON FUNCTION public.fulfillment_operator_record_label(text,uuid,jsonb,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fulfillment_operator_hand_off(text,uuid,uuid,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fulfillment_operator_record_tracking(text,uuid,jsonb,uuid) FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.fulfillment_operator_record_label(text,uuid,jsonb,uuid), public.fulfillment_operator_hand_off(text,uuid,uuid,jsonb), public.fulfillment_operator_record_tracking(text,uuid,jsonb,uuid) FROM anon'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.fulfillment_operator_record_label(text,uuid,jsonb,uuid), public.fulfillment_operator_hand_off(text,uuid,uuid,jsonb), public.fulfillment_operator_record_tracking(text,uuid,jsonb,uuid) FROM authenticated'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'GRANT EXECUTE ON FUNCTION public.fulfillment_operator_record_label(text,uuid,jsonb,uuid), public.fulfillment_operator_hand_off(text,uuid,uuid,jsonb), public.fulfillment_operator_record_tracking(text,uuid,jsonb,uuid) TO service_role'; END IF; END; $$;
