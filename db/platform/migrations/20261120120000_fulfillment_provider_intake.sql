-- Durable provider intake. All classifications are closed facts supplied by the adapter.
ALTER TABLE public.shipment_external_refs ADD COLUMN carrier_ref text;
ALTER TABLE public.shipment_external_refs ADD COLUMN service_ref text;
ALTER TABLE public.shipment_external_refs ADD COLUMN public_url text;
ALTER TABLE public.fulfillment_operator_status_evidence ADD COLUMN occurrence_key text;
ALTER TABLE public.fulfillment_operator_status_evidence ADD COLUMN canonical_status text;
ALTER TABLE public.fulfillment_operator_status_evidence ADD COLUMN recovery_classification text;
CREATE UNIQUE INDEX fulfillment_intake_occurrence_key ON public.fulfillment_operator_status_evidence(shipment_id,occurrence_key);

CREATE FUNCTION public.fulfillment_intake_record_observation(p_key text,p_shipment uuid,p_observation jsonb,p_received timestamptz) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE receipt public.fulfillment_observations; inserted boolean;
BEGIN
 IF nullif(btrim(p_key),'') IS NULL OR p_received IS NULL OR p_observation#>>'{fact,rawEvent,reference}' IS NULL
  OR p_observation->>'eventKey' IS DISTINCT FROM p_key THEN RAISE EXCEPTION 'observation_evidence_not_recorded' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('intake-receipt|'||p_key,0));
 SELECT * INTO receipt FROM public.fulfillment_observations WHERE event_key=p_key;
 inserted:=NOT FOUND;
 IF inserted THEN
  PERFORM public.fulfillment_record_observation(p_key,p_shipment,p_observation,p_received);
  SELECT * INTO receipt FROM public.fulfillment_observations WHERE event_key=p_key;
 END IF;
 IF receipt.observation#>>'{fact,rawEvent,reference}' IS NULL OR receipt.observation->>'eventKey' IS DISTINCT FROM p_key THEN
  RAISE EXCEPTION 'observation_evidence_not_recorded' USING ERRCODE='22023'; END IF;
 RETURN jsonb_build_object('replayed',NOT inserted,'receiptId',receipt.event_key,'observation',receipt.observation);
END;
$$;

CREATE FUNCTION public.fulfillment_intake_find_dispatch(p_provider text,p_correlation jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE ref public.fulfillment_dispatch_refs; matches integer; match_kind text;
BEGIN
 -- Provider identity has precedence. Merchant lookup uses recorded order/dispatch foreign keys only.
 SELECT count(*) INTO matches FROM public.fulfillment_dispatch_refs d
 WHERE d.evidence->>'providerRef'=p_provider AND d.mode<>'shadow' AND (
  (d.external_ref IS NOT NULL AND d.external_ref=p_correlation->>'externalRef') OR
  (d.parcel_ref IS NOT NULL AND d.parcel_ref=p_correlation->>'providerFulfillmentRef'));
 IF matches>1 THEN RAISE EXCEPTION 'fulfillment_observation_correlation_conflict' USING ERRCODE='23505'; END IF;
 IF matches=1 THEN
  SELECT * INTO ref FROM public.fulfillment_dispatch_refs d
  WHERE d.evidence->>'providerRef'=p_provider AND d.mode<>'shadow' AND (
   (d.external_ref IS NOT NULL AND d.external_ref=p_correlation->>'externalRef') OR
   (d.parcel_ref IS NOT NULL AND d.parcel_ref=p_correlation->>'providerFulfillmentRef'));
  match_kind:='provider';
 ELSE
  SELECT * INTO ref FROM public.fulfillment_dispatch_refs d
  WHERE d.evidence->>'providerRef'=p_provider AND d.mode<>'shadow' AND d.shipment_id::text=p_correlation->>'fulfillmentRef';
  IF FOUND THEN match_kind:='native';
  ELSE
   SELECT count(*) INTO matches FROM public.commerce_orders o
   WHERE o.metadata->>'orderNumber'=p_correlation->>'orderNumber'
    OR (o.id::text=p_correlation->>'merchantOrderRef' AND NOT EXISTS(
      SELECT 1 FROM public.commerce_orders numbered WHERE numbered.metadata->>'orderNumber'=p_correlation->>'orderNumber'));
   IF matches>1 THEN RAISE EXCEPTION 'fulfillment_observation_correlation_conflict' USING ERRCODE='23505'; END IF;
   -- Native parcel creation owns immutable association chronology; dispatch update time is mutable.
   SELECT d.* INTO ref FROM public.fulfillment_dispatch_refs d JOIN public.commerce_orders o ON o.id=d.order_id
    JOIN public.fulfillment_shipments shipment ON shipment.id=d.shipment_id
   WHERE d.evidence->>'providerRef'=p_provider AND d.mode<>'shadow'
    AND (o.metadata->>'orderNumber'=p_correlation->>'orderNumber'
      OR (o.id::text=p_correlation->>'merchantOrderRef' AND NOT EXISTS(
        SELECT 1 FROM public.commerce_orders numbered WHERE numbered.metadata->>'orderNumber'=p_correlation->>'orderNumber')))
   ORDER BY shipment.created_at DESC,d.id DESC LIMIT 1;
   IF NOT FOUND THEN RETURN NULL; END IF;
   SELECT CASE WHEN o.metadata->>'orderNumber'=p_correlation->>'orderNumber' THEN 'merchant' ELSE 'native' END
    INTO match_kind FROM public.commerce_orders o WHERE o.id=ref.order_id;
  END IF;
 END IF;
 IF (p_correlation->>'fulfillmentRef' IS NOT NULL AND p_correlation->>'fulfillmentRef' IS DISTINCT FROM ref.shipment_id::text)
  OR (p_correlation->>'orderRef' IS NOT NULL AND p_correlation->>'orderRef' IS DISTINCT FROM ref.order_id::text)
  OR (p_correlation->>'parcelRef' IS NOT NULL AND p_correlation->>'parcelRef' IS DISTINCT FROM ref.parcel_ref)
  OR (p_correlation->>'externalRef' IS NOT NULL AND ref.external_ref IS NOT NULL AND p_correlation->>'externalRef' IS DISTINCT FROM ref.external_ref)
  OR (p_correlation->>'providerFulfillmentRef' IS NOT NULL AND ref.parcel_ref IS NOT NULL AND p_correlation->>'providerFulfillmentRef' IS DISTINCT FROM ref.parcel_ref) THEN
  RAISE EXCEPTION 'fulfillment_observation_correlation_conflict' USING ERRCODE='23505'; END IF;
 RETURN public.fulfillment_dispatch_read(ref)||jsonb_build_object('acceptance',ref.acceptance,'matchedBy',match_kind,
  'orderNumber',(SELECT o.metadata->>'orderNumber' FROM public.commerce_orders o WHERE o.id=ref.order_id));
END;
$$;

CREATE FUNCTION public.fulfillment_intake_read_state(p_shipment uuid) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
 SELECT jsonb_build_object('status',s.status,'handedOverAt',s.handed_over_at,
 'latestOccurredAt',(SELECT max(e.occurred_at) FROM public.fulfillment_operator_status_evidence e WHERE e.shipment_id=s.id),
 'carrierRef',c.contact#>>'{selectedDelivery,carrierKind}',
 'serviceRef',coalesce(c.contact#>>'{selectedDelivery,serviceCode}',c.contact#>>'{selectedDelivery,service}'))
 FROM public.fulfillment_shipments s LEFT JOIN public.fulfillment_parcel_contacts c ON c.shipment_id=s.id AND c.erased_at IS NULL
 WHERE s.id=p_shipment;
$$;

CREATE FUNCTION public.fulfillment_intake_heal_exception(p_key text,p_shipment uuid,p_evidence jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE candidate public.commerce_order_holds; latest public.fulfillment_operator_status_evidence; proof public.fulfillment_operator_status_evidence; healed integer:=0;
BEGIN
 SELECT * INTO proof FROM public.fulfillment_operator_status_evidence WHERE shipment_id=p_shipment AND event_key=p_key;
 IF NOT FOUND OR proof.occurred_at IS NULL OR proof.canonical_status IS NULL OR proof.canonical_status NOT IN ('provider_received','picking','packed','in_transit','delivered') THEN
  RETURN jsonb_build_object('released',0); END IF;
 SELECT * INTO latest FROM public.fulfillment_operator_status_evidence WHERE shipment_id=p_shipment AND canonical_status='exception'
 ORDER BY occurred_at DESC NULLS LAST,created_at DESC,id DESC LIMIT 1;
 IF NOT FOUND OR latest.occurred_at IS NULL OR proof.occurred_at<=latest.occurred_at
  OR latest.recovery_classification IS NULL OR latest.recovery_classification NOT IN ('provider_recovered','delivery_only')
  OR (latest.recovery_classification='delivery_only' AND proof.canonical_status<>'delivered') THEN
  RETURN jsonb_build_object('released',0,'reason','provider_exception_scope_unproven'); END IF;
 FOR candidate IN SELECT h.* FROM public.commerce_order_holds h JOIN public.commerce_orders o ON o.id=h.order_id
 JOIN public.fulfillment_shipments s ON s.order_id=o.id
 WHERE s.id=p_shipment AND o.status NOT IN ('cancelled','refunded') AND h.status='active' AND h.reason='fulfillment_exception'
  AND h.created_by IS NULL AND h.metadata->>'source'='fulfillment.provider_exception'
  AND h.metadata->>'shipmentId'=p_shipment::text ORDER BY h.id FOR UPDATE OF h LOOP
  PERFORM public.oms_release_hold('intake-heal:'||candidate.id::text,candidate.id,NULL,NULL,
   CASE WHEN proof.canonical_status='delivered' THEN 'delivered' ELSE 'provider_recovered' END,
   jsonb_build_object('source','fulfillment.provider_exception_healed','statusEvidenceId',proof.id,'clearedStatusEvidenceId',latest.id));
  healed:=healed+1;
 END LOOP;
 RETURN jsonb_build_object('released',healed);
END;
$$;

CREATE FUNCTION public.fulfillment_intake_record_status(p_key text,p_dispatch uuid,p_shipment uuid,p_status text,p_evidence jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE dispatch public.fulfillment_dispatch_refs; prior public.fulfillment_operator_status_evidence; occurrence text:=p_evidence#>>'{intake,occurrenceKey}'; classification text:=p_evidence#>>'{intake,recovery}'; answer jsonb;
BEGIN
 SELECT * INTO dispatch FROM public.fulfillment_dispatch_refs WHERE id=p_dispatch AND shipment_id=p_shipment;
 IF NOT FOUND OR dispatch.evidence->>'providerRef' IS NULL OR dispatch.evidence->>'providerRef' IS DISTINCT FROM p_evidence#>>'{fact,providerKind}' THEN
  RAISE EXCEPTION 'fulfillment_status_evidence_correlation' USING ERRCODE='22023'; END IF;
 IF p_status IS DISTINCT FROM p_evidence#>>'{fact,canonicalStatus}' OR occurrence IS NULL OR btrim(occurrence)='' OR p_status IS NULL OR p_status NOT IN ('provider_received','picking','packed','in_transit','delivered','exception','cancelled')
  OR (classification IS NOT NULL AND classification NOT IN ('provider_recovered','delivery_only','manual')) THEN
  RAISE EXCEPTION 'observation_evidence_not_recorded' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('intake-status|'||p_shipment::text,0));
 -- Polling keeps its current working envelope; only webhook callers restore a receipt.
 PERFORM public.fulfillment_intake_record_observation(p_key,NULL,p_evidence,(p_evidence->>'firstReceivedAt')::timestamptz);
 UPDATE public.fulfillment_observations SET shipment_id=p_shipment WHERE event_key=p_key AND (shipment_id IS NULL OR shipment_id=p_shipment);
 IF NOT FOUND THEN RAISE EXCEPTION 'fulfillment_status_evidence_correlation' USING ERRCODE='22023'; END IF;
 SELECT * INTO prior FROM public.fulfillment_operator_status_evidence WHERE shipment_id=p_shipment AND occurrence_key=occurrence;
 IF FOUND THEN RETURN jsonb_build_object('replayed',true,'statusEvidenceId',prior.id); END IF;
 PERFORM public.fulfillment_record_operator_status_evidence(p_key,p_shipment);
 UPDATE public.fulfillment_operator_status_evidence SET provider_status=p_status,canonical_status=p_status,occurrence_key=occurrence,
 recovery_classification=classification,occurred_at=(p_evidence#>>'{fact,occurredAt}')::timestamptz WHERE event_key=p_key RETURNING * INTO prior;
 PERFORM public.fulfillment_intake_heal_exception(p_key,p_shipment,p_evidence);
 RETURN jsonb_build_object('replayed',false,'statusEvidenceId',prior.id);
END;
$$;

CREATE FUNCTION public.fulfillment_intake_quarantine(p_key text,p_evidence jsonb,p_reason text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE inserted boolean;
BEGIN
 IF p_reason IS NULL OR p_reason NOT IN ('missing_correlation','missing_external_ref','unknown_status','state_conflict') THEN
  RAISE EXCEPTION 'fulfillment_quarantine_reason_invalid' USING ERRCODE='22023'; END IF;
 INSERT INTO public.fulfillment_observations(event_key,observation,first_received_at,outcome)
 VALUES('quarantine:'||p_key,jsonb_build_object('eventKey',p_key,'correlation',p_evidence->'correlation'),now(),jsonb_build_object('status','quarantined','reason',p_reason))
 ON CONFLICT DO NOTHING;
 inserted:=FOUND;
 RETURN jsonb_build_object('replayed',NOT inserted);
END;
$$;

CREATE FUNCTION public.fulfillment_intake_annotate_stock_contention(p_key text,p_shipment uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
 UPDATE public.fulfillment_observations SET observation=jsonb_set(observation,'{diagnostics}',coalesce(observation->'diagnostics','{}')||
  jsonb_build_object('stockContention',jsonb_build_object('sqlState','55P03','phase','provider_stock_consumed','retryable',true)))
 WHERE event_key=p_key AND shipment_id=p_shipment AND outcome IS NULL;
END;
$$;

CREATE FUNCTION public.fulfillment_intake_close_recovered_picked(p_shipment uuid) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE affected integer;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.fulfillment_operator_receipts WHERE kind='consume' AND command->>'shipmentId'=p_shipment::text) THEN RETURN 0; END IF;
 UPDATE public.fulfillment_observations SET outcome=jsonb_build_object('status','processed'),
 observation=jsonb_set(observation,'{diagnostics}',coalesce(observation->'diagnostics','{}')||jsonb_build_object('recoveredPickedReceipt',jsonb_build_object('receiptRef',event_key,'closed',true)))
 WHERE shipment_id=p_shipment AND outcome IS NULL AND observation#>>'{fact,canonicalStatus}'='packed'
 AND observation#>>'{diagnostics,stockContention,sqlState}'='55P03';
 GET DIAGNOSTICS affected=ROW_COUNT;
 RETURN affected;
END;
$$;

CREATE FUNCTION public.fulfillment_intake_consume_packed(p_key text,p_shipment uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE parcel public.fulfillment_shipments; answer jsonb;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('parcel-consume-key|'||p_key,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('native-dispatch|'||p_shipment::text,0));
 SELECT * INTO parcel FROM public.fulfillment_shipments WHERE id=p_shipment FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'commerce_fulfillment_not_found' USING ERRCODE='22023'; END IF;
 IF parcel.status IN ('cancelled','exception') THEN RAISE EXCEPTION 'commerce_fulfillment_stock_consumed_requires_label' USING ERRCODE='22023'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.fulfillment_dispatch_refs d WHERE d.shipment_id=p_shipment AND d.status='created' AND d.acceptance->>'kind'='accepted'
 AND EXISTS(SELECT 1 FROM public.shipment_external_refs r WHERE r.shipment_id=p_shipment AND r.ref_role='dispatch' AND r.external_id=d.external_ref)) THEN
  RAISE EXCEPTION 'commerce_fulfillment_stock_consumed_requires_label' USING ERRCODE='22023'; END IF;
 answer:=public.fulfillment_consume_parcel_reservations(p_key,p_shipment);
 IF parcel.status IN ('created','label_pending','label_created') THEN
  UPDATE public.fulfillment_shipments SET status='packed',updated_at=now() WHERE id=p_shipment;
  INSERT INTO public.fulfillment_shipment_operations(shipment_id,order_id,operation_type,idempotency_key,payload)
  VALUES(p_shipment,parcel.order_id,'shipment_advanced',p_key||':packed',jsonb_build_object('toStatus','packed')) ON CONFLICT DO NOTHING;
 END IF;
 RETURN answer;
END;
$$;

CREATE FUNCTION public.fulfillment_intake_record_exception(p_key text,p_shipment uuid,p_reason text,p_evidence jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE parcel public.fulfillment_shipments; op public.commerce_order_operations; held public.commerce_order_holds; replayed boolean:=false;
BEGIN
 IF p_reason IS DISTINCT FROM 'provider_exception' THEN RAISE EXCEPTION 'fulfillment_exception_reason_invalid' USING ERRCODE='22023'; END IF;
 SELECT * INTO parcel FROM public.fulfillment_shipments WHERE id=p_shipment;
 IF NOT FOUND THEN RAISE EXCEPTION 'commerce_fulfillment_not_found' USING ERRCODE='22023'; END IF;
 PERFORM id FROM public.commerce_orders WHERE id=parcel.order_id FOR UPDATE;
 INSERT INTO public.commerce_order_operations(order_id,operation_type,idempotency_key,payload)
 VALUES(parcel.order_id,'hold_created',p_key||':operation',jsonb_build_object('source','fulfillment.provider_exception','shipmentId',p_shipment))
 ON CONFLICT DO NOTHING RETURNING * INTO op;
 IF NOT FOUND THEN
  SELECT * INTO op FROM public.commerce_order_operations WHERE idempotency_key=p_key||':operation';
  IF op.order_id<>parcel.order_id OR op.payload->>'source' IS DISTINCT FROM 'fulfillment.provider_exception' OR op.payload->>'shipmentId' IS DISTINCT FROM p_shipment::text THEN
   RAISE EXCEPTION 'fulfillment_exception_idempotency_conflict' USING ERRCODE='23505'; END IF;
  RETURN jsonb_build_object('replayed',true,'holdId',op.hold_id);
 END IF;
 INSERT INTO public.commerce_order_holds(order_id,reason,note,created_by,idempotency_key,metadata)
 VALUES(parcel.order_id,'fulfillment_exception','provider_exception',NULL,p_key,
  jsonb_build_object('source','fulfillment.provider_exception','shipmentId',p_shipment))
 ON CONFLICT DO NOTHING RETURNING * INTO held;
 IF NOT FOUND THEN
  replayed:=true;
  SELECT * INTO held FROM public.commerce_order_holds WHERE order_id=parcel.order_id AND reason='fulfillment_exception' AND status='active' ORDER BY created_at DESC,id LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'fulfillment_exception_hold_missing' USING ERRCODE='22023'; END IF;
 END IF;
 UPDATE public.commerce_order_operations SET hold_id=held.id WHERE id=op.id;
 RETURN jsonb_build_object('replayed',replayed,'holdId',held.id);
END;
$$;

CREATE FUNCTION public.fulfillment_intake_record_tracking(p_key text,p_shipment uuid,p_command jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE parcel public.fulfillment_shipments; tracking text:=p_command->>'trackingNumber'; provider text:=p_command->>'providerRef'; conflicting uuid;
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'inventory_admission_isolation_unsupported' USING ERRCODE='22023'; END IF;
 IF nullif(btrim(tracking),'') IS NULL OR nullif(btrim(provider),'') IS NULL THEN RAISE EXCEPTION 'fulfillment_tracking_reference_invalid' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('operator-tracking-reference|'||tracking,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('native-dispatch|'||p_shipment::text,0));
 SELECT * INTO parcel FROM public.fulfillment_shipments WHERE id=p_shipment FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'commerce_fulfillment_not_found' USING ERRCODE='22023'; END IF;
 IF parcel.status NOT IN ('handed_over','in_transit','delivered') THEN RAISE EXCEPTION 'commerce_fulfillment_tracking_before_handoff_forbidden' USING ERRCODE='22023'; END IF;
 SELECT s.order_id INTO conflicting FROM public.shipment_external_refs r JOIN public.fulfillment_shipments s ON s.id=r.shipment_id
 WHERE r.ref_role='tracking' AND r.external_id=tracking AND r.provider_kind IS NULL AND s.order_id<>parcel.order_id ORDER BY s.order_id LIMIT 1;
 IF FOUND THEN RAISE EXCEPTION 'commerce_fulfillment_tracking_reference_unattributed' USING ERRCODE='23505',DETAIL=jsonb_build_object('conflictingOrderId',conflicting)::text; END IF;
 IF EXISTS(SELECT 1 FROM public.shipment_external_refs r JOIN public.fulfillment_shipments s ON s.id=r.shipment_id
  WHERE r.ref_role='tracking' AND r.external_id=tracking AND r.provider_kind=provider AND s.order_id<>parcel.order_id) THEN
  RAISE EXCEPTION 'commerce_fulfillment_tracking_ref_conflict' USING ERRCODE='23505'; END IF;
 -- Same-order reassignment is parcel-scoped, with attribution guarded above.
 DELETE FROM public.shipment_external_refs r USING public.fulfillment_shipments s WHERE s.id=r.shipment_id AND s.order_id=parcel.order_id
 AND r.ref_role='tracking' AND r.external_id=tracking AND (r.provider_kind=provider OR r.provider_kind IS NULL) AND r.shipment_id<>parcel.id;
 INSERT INTO public.shipment_external_refs(shipment_id,ref_role,external_id,provider_kind,carrier_ref,service_ref,public_url)
 VALUES(parcel.id,'tracking',tracking,provider,p_command->>'carrierKind',p_command->>'service',p_command->>'trackingUrl')
 ON CONFLICT ON CONSTRAINT shipment_external_refs_shipment_role_id_key DO UPDATE SET carrier_ref=EXCLUDED.carrier_ref,service_ref=EXCLUDED.service_ref,public_url=EXCLUDED.public_url;
 -- Reference evidence commits independently before the existing tracking command.
 RETURN jsonb_build_object('readBack',EXISTS(SELECT 1 FROM public.shipment_external_refs WHERE shipment_id=p_shipment AND ref_role='tracking' AND external_id=tracking AND provider_kind=provider));
END;
$$;

CREATE FUNCTION public.fulfillment_emit_shipment_dispatched(p_shipment uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE parcel public.fulfillment_shipments;
BEGIN
 SELECT * INTO parcel FROM public.fulfillment_shipments WHERE id=p_shipment;
 IF NOT FOUND OR parcel.status NOT IN ('handed_over','in_transit') OR parcel.delivered_at IS NOT NULL
 OR EXISTS(SELECT 1 FROM public.fulfillment_operator_status_evidence WHERE shipment_id=p_shipment AND canonical_status='delivered')
 OR NOT EXISTS(SELECT 1 FROM public.shipment_external_refs WHERE shipment_id=p_shipment AND ref_role='tracking' AND external_id IS NOT NULL) THEN RETURN; END IF;
 INSERT INTO public.outbox_events(aggregate_type,aggregate_id,event_type,idempotency_key,payload,metadata)
 VALUES('commerce_order',parcel.order_id,'commerce.shipment.dispatched','shipment_dispatched:'||parcel.id::text,
 jsonb_build_object('orderUuid',parcel.order_id,'shipmentUuid',parcel.id,'occurredAt',parcel.handed_over_at),jsonb_build_object('source','fulfillment_emit_shipment_dispatched'))
 ON CONFLICT(event_type,idempotency_key) DO NOTHING;
END;
$$;
CREATE FUNCTION public.fulfillment_emit_shipment_status_notice() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
 PERFORM public.fulfillment_emit_shipment_dispatched(NEW.id);
 IF NEW.status='delivered' THEN
  INSERT INTO public.outbox_events(aggregate_type,aggregate_id,event_type,idempotency_key,payload,metadata)
  VALUES('commerce_order',NEW.order_id,'commerce.shipment.delivered','shipment_delivered:'||NEW.id::text,
   jsonb_build_object('orderUuid',NEW.order_id,'shipmentUuid',NEW.id,'occurredAt',NEW.delivered_at),
   jsonb_build_object('source','fulfillment_emit_shipment_status_notice')) ON CONFLICT(event_type,idempotency_key) DO NOTHING;
 END IF;
 RETURN NEW;
END;
$$;
CREATE FUNCTION public.fulfillment_emit_shipment_reference_notice() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
 IF NEW.ref_role='tracking' THEN PERFORM public.fulfillment_emit_shipment_dispatched(NEW.shipment_id); END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER trg_fulfillment_emit_shipment_status_notice AFTER UPDATE OF status ON public.fulfillment_shipments FOR EACH ROW EXECUTE FUNCTION public.fulfillment_emit_shipment_status_notice();
CREATE TRIGGER trg_fulfillment_emit_shipment_reference_notice AFTER INSERT OR UPDATE ON public.shipment_external_refs FOR EACH ROW EXECUTE FUNCTION public.fulfillment_emit_shipment_reference_notice();

CREATE OR REPLACE FUNCTION public.fulfillment_emit_shipment_exception_notification()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.fulfillment_shipments
     WHERE order_id = NEW.order_id
       AND (handed_over_at IS NOT NULL OR status = 'delivered')
  ) THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.outbox_events
    (aggregate_type, aggregate_id, event_type, idempotency_key, payload, metadata)
  VALUES ('commerce_order', NEW.order_id, 'commerce.shipment.exception',
          'shipment_exception:' || NEW.id::text,
          jsonb_build_object('orderUuid', NEW.order_id, 'holdUuid', NEW.id,
                             'occurredAt', NEW.created_at),
          jsonb_build_object('source', 'fulfillment_emit_shipment_exception_notification'))
  ON CONFLICT (event_type, idempotency_key) DO NOTHING;
  RETURN NULL;
END;
$$;

-- Closed intake execution; browser roles retain no payload access.
REVOKE ALL ON FUNCTION public.fulfillment_intake_record_observation(text,uuid,jsonb,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fulfillment_intake_find_dispatch(text,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fulfillment_intake_read_state(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fulfillment_intake_heal_exception(text,uuid,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fulfillment_intake_record_status(text,uuid,uuid,text,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fulfillment_intake_quarantine(text,jsonb,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fulfillment_intake_annotate_stock_contention(text,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fulfillment_intake_close_recovered_picked(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fulfillment_intake_consume_packed(text,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fulfillment_intake_record_exception(text,uuid,text,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fulfillment_intake_record_tracking(text,uuid,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fulfillment_emit_shipment_dispatched(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fulfillment_emit_shipment_status_notice() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fulfillment_emit_shipment_reference_notice() FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.fulfillment_intake_record_observation(text,uuid,jsonb,timestamptz), public.fulfillment_intake_find_dispatch(text,jsonb), public.fulfillment_intake_read_state(uuid), public.fulfillment_intake_heal_exception(text,uuid,jsonb), public.fulfillment_intake_record_status(text,uuid,uuid,text,jsonb), public.fulfillment_intake_quarantine(text,jsonb,text), public.fulfillment_intake_annotate_stock_contention(text,uuid), public.fulfillment_intake_close_recovered_picked(uuid), public.fulfillment_intake_consume_packed(text,uuid), public.fulfillment_intake_record_exception(text,uuid,text,jsonb), public.fulfillment_intake_record_tracking(text,uuid,jsonb), public.fulfillment_emit_shipment_dispatched(uuid), public.fulfillment_emit_shipment_status_notice(), public.fulfillment_emit_shipment_reference_notice() FROM anon;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.fulfillment_intake_record_observation(text,uuid,jsonb,timestamptz), public.fulfillment_intake_find_dispatch(text,jsonb), public.fulfillment_intake_read_state(uuid), public.fulfillment_intake_heal_exception(text,uuid,jsonb), public.fulfillment_intake_record_status(text,uuid,uuid,text,jsonb), public.fulfillment_intake_quarantine(text,jsonb,text), public.fulfillment_intake_annotate_stock_contention(text,uuid), public.fulfillment_intake_close_recovered_picked(uuid), public.fulfillment_intake_consume_packed(text,uuid), public.fulfillment_intake_record_exception(text,uuid,text,jsonb), public.fulfillment_intake_record_tracking(text,uuid,jsonb), public.fulfillment_emit_shipment_dispatched(uuid), public.fulfillment_emit_shipment_status_notice(), public.fulfillment_emit_shipment_reference_notice() FROM authenticated;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'GRANT EXECUTE ON FUNCTION public.fulfillment_intake_record_observation(text,uuid,jsonb,timestamptz), public.fulfillment_intake_find_dispatch(text,jsonb), public.fulfillment_intake_read_state(uuid), public.fulfillment_intake_heal_exception(text,uuid,jsonb), public.fulfillment_intake_record_status(text,uuid,uuid,text,jsonb), public.fulfillment_intake_quarantine(text,jsonb,text), public.fulfillment_intake_annotate_stock_contention(text,uuid), public.fulfillment_intake_close_recovered_picked(uuid), public.fulfillment_intake_consume_packed(text,uuid), public.fulfillment_intake_record_exception(text,uuid,text,jsonb), public.fulfillment_intake_record_tracking(text,uuid,jsonb), public.fulfillment_emit_shipment_dispatched(uuid) TO service_role;'; END IF; END; $$;
