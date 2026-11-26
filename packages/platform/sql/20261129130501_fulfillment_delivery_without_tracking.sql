-- Pin a dispatch known when the first delivery receipt is admitted, before its ACK.
ALTER TABLE public.fulfillment_observations ADD COLUMN prebound_arrival_dispatch_id uuid;

CREATE OR REPLACE FUNCTION public.fulfillment_intake_record_observation(p_key text,p_shipment uuid,p_observation jsonb,p_received timestamptz) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE receipt public.fulfillment_observations; inserted boolean; arrival_dispatch uuid; write_result jsonb;
BEGIN
 IF nullif(btrim(p_key),'') IS NULL OR p_received IS NULL OR p_observation#>>'{fact,rawEvent,reference}' IS NULL
  OR p_observation->>'eventKey' IS DISTINCT FROM p_key THEN RAISE EXCEPTION 'observation_evidence_not_recorded' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('intake-receipt|'||p_key,0));
 SELECT * INTO receipt FROM public.fulfillment_observations WHERE event_key=p_key;
 inserted:=NOT FOUND;
 IF inserted THEN
  IF p_observation#>>'{fact,canonicalStatus}' = 'delivered'
   AND p_observation#>>'{fact,provenance,source}' = 'provider_webhook'
   AND p_observation#>>'{fact,provenance,authority}' = 'provider_asserted'
   AND p_observation->'trackingRefs' = '[]'::jsonb
  THEN
   SELECT (array_agg(d.id))[1] INTO arrival_dispatch FROM public.fulfillment_dispatch_refs d
   WHERE d.evidence->>'providerRef' = p_observation#>>'{fact,providerKind}' AND d.mode <> 'shadow'
     AND d.external_ref = p_observation#>>'{correlation,externalRef}' AND d.status IN ('uncertain', 'created')
   HAVING count(*) = 1;
  END IF;
  write_result := public.fulfillment_record_observation(p_key,p_shipment,p_observation,p_received);
  IF arrival_dispatch IS NOT NULL AND write_result->>'replayed' = 'false' THEN
   UPDATE public.fulfillment_observations SET prebound_arrival_dispatch_id=arrival_dispatch WHERE event_key=p_key;
  END IF;
  SELECT * INTO receipt FROM public.fulfillment_observations WHERE event_key=p_key;
 END IF;
 IF receipt.observation#>>'{fact,rawEvent,reference}' IS NULL OR receipt.observation->>'eventKey' IS DISTINCT FROM p_key THEN
  RAISE EXCEPTION 'observation_evidence_not_recorded' USING ERRCODE='22023'; END IF;
 RETURN jsonb_build_object('replayed',NOT inserted,'receiptId',receipt.event_key,'observation',receipt.observation);
END;
$$;

-- Apply a retained verified arrival against the existing, provider-bound parcel.
CREATE FUNCTION public.fulfillment_intake_record_delivery_without_tracking(
  p_event_key text, p_dispatch uuid, p_shipment uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  receipt public.fulfillment_observations;
  dispatch public.fulfillment_dispatch_refs;
  parcel public.fulfillment_shipments;
  provider text;
  tracking text;
  current_tracking text;
  reference_count integer;
  original_time text;
  arrived_at timestamptz;
  fact_time timestamptz;
  subscription uuid;
  operation_key text := 'verified-delivery|' || encode(sha256(convert_to(p_event_key, 'UTF8')), 'hex');
  no_readback constant jsonb := '{"readBack":false}';
  result jsonb;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'inventory_admission_isolation_unsupported' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO receipt FROM public.fulfillment_observations
  WHERE event_key = p_event_key AND shipment_id = p_shipment;
  IF NOT FOUND THEN RETURN no_readback; END IF;
  provider := receipt.observation#>>'{fact,providerKind}';
  SELECT count(*), min(r.external_id) INTO reference_count, tracking
  FROM public.shipment_external_refs r
  WHERE r.shipment_id = p_shipment AND r.ref_role = 'tracking' AND r.provider_kind = provider;
  IF reference_count <> 1 THEN RETURN no_readback; END IF;

  -- Reference writers lock the number before a parcel. The canonical delivery
  -- writer then owns operation key -> subscription -> dispatch -> parcel.
  PERFORM pg_advisory_xact_lock(hashtextextended('intake-status|' || p_shipment::text, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('operator-tracking-reference|' || tracking, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('operator-tracking-key|' || operation_key, 0));
  SELECT c.subscription_id INTO subscription
  FROM public.fulfillment_shipments s JOIN public.commerce_orders o ON o.id = s.order_id
  JOIN public.subscription_cycles c ON c.id = o.subscription_cycle_id WHERE s.id = p_shipment;
  IF subscription IS NOT NULL THEN
    PERFORM 1 FROM public.subscriptions WHERE id = subscription FOR UPDATE;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('native-dispatch|' || p_shipment::text, 0));
  SELECT * INTO parcel FROM public.fulfillment_shipments WHERE id = p_shipment FOR UPDATE;
  IF NOT FOUND OR parcel.status NOT IN ('handed_over', 'in_transit', 'delivered') THEN
    RETURN no_readback;
  END IF;

  SELECT * INTO receipt FROM public.fulfillment_observations
  WHERE event_key = p_event_key AND shipment_id = p_shipment;
  IF NOT FOUND OR (receipt.outcome IS NOT NULL AND receipt.outcome->>'status' IS DISTINCT FROM 'processed')
    OR receipt.observation#>>'{fact,providerKind}' IS DISTINCT FROM provider
    OR receipt.observation#>>'{fact,canonicalStatus}' IS DISTINCT FROM 'delivered'
    OR receipt.observation#>>'{fact,provenance,source}' IS DISTINCT FROM 'provider_webhook'
    OR receipt.observation#>>'{fact,provenance,authority}' IS DISTINCT FROM 'provider_asserted'
    OR receipt.observation->'trackingRefs' IS DISTINCT FROM '[]'::jsonb
    OR coalesce(receipt.observation#>>'{diagnostics,admission,rejectedTrackingRefs}', '0') <> '0'
    OR coalesce(receipt.observation#>>'{diagnostics,redactedFieldCount}', '0') <> '0'
  THEN RETURN no_readback; END IF;

  SELECT * INTO dispatch FROM public.fulfillment_dispatch_refs
  WHERE id = p_dispatch AND shipment_id = p_shipment AND order_id = parcel.order_id
    AND status = 'created' AND mode <> 'shadow' AND evidence->>'providerRef' = provider;
  IF NOT FOUND OR NOT EXISTS (
    SELECT 1 FROM public.commerce_orders WHERE id = parcel.order_id
      AND status IN ('paid', 'fulfillment_pending', 'fulfilled')
  ) OR EXISTS (
    SELECT 1 FROM public.fulfillment_shipments other WHERE other.replaces_shipment_id = p_shipment
  ) THEN RETURN no_readback; END IF;

  -- An order number alone may have selected the newest of several parcels.
  -- Anchor arrival to authenticated parcel identity, or a lone parcel with
  -- an external dispatch identity already established before the receipt.
  IF (receipt.observation#>>'{correlation,fulfillmentRef}' IS NOT NULL
      AND receipt.observation#>>'{correlation,fulfillmentRef}' IS DISTINCT FROM p_shipment::text)
    OR (receipt.observation#>>'{correlation,providerFulfillmentRef}' IS NOT NULL
      AND receipt.observation#>>'{correlation,providerFulfillmentRef}' IS DISTINCT FROM dispatch.parcel_ref)
    OR (receipt.observation#>>'{correlation,parcelRef}' IS NOT NULL
      AND receipt.observation#>>'{correlation,parcelRef}' IS DISTINCT FROM dispatch.parcel_ref)
    OR (receipt.observation#>>'{correlation,externalRef}' IS NOT NULL
      AND receipt.observation#>>'{correlation,externalRef}' IS DISTINCT FROM dispatch.external_ref)
    OR (receipt.observation#>>'{correlation,orderRef}' IS NOT NULL
      AND receipt.observation#>>'{correlation,orderRef}' IS DISTINCT FROM parcel.order_id::text)
  THEN RETURN no_readback; END IF;

  IF (
    receipt.observation#>>'{correlation,fulfillmentRef}' = p_shipment::text
    OR dispatch.parcel_ref IN (receipt.observation#>>'{correlation,providerFulfillmentRef}',
                               receipt.observation#>>'{correlation,parcelRef}')
    OR (dispatch.external_ref = receipt.observation#>>'{correlation,externalRef}'
      AND receipt.prebound_arrival_dispatch_id = p_dispatch
      AND parcel.sequence_no = 0 AND parcel.replaces_shipment_id IS NULL AND NOT EXISTS (
      SELECT 1 FROM public.fulfillment_shipments other
      WHERE other.order_id = parcel.order_id AND other.id <> p_shipment
    ))
  ) IS NOT TRUE OR EXISTS (
    SELECT 1 FROM public.fulfillment_dispatch_refs other
    WHERE other.shipment_id <> p_shipment AND other.mode <> 'shadow'
      AND other.evidence->>'providerRef' = provider
      AND (other.external_ref = receipt.observation#>>'{correlation,externalRef}'
        OR other.parcel_ref IN (receipt.observation#>>'{correlation,providerFulfillmentRef}',
                                receipt.observation#>>'{correlation,parcelRef}'))
  ) THEN RETURN no_readback; END IF;

  SELECT count(*), min(r.external_id) INTO reference_count, current_tracking
  FROM public.shipment_external_refs r
  WHERE r.shipment_id = p_shipment AND r.ref_role = 'tracking' AND r.provider_kind = provider;
  IF reference_count <> 1 OR current_tracking IS DISTINCT FROM tracking OR EXISTS (
    SELECT 1 FROM public.shipment_external_refs r
    WHERE r.shipment_id <> p_shipment AND r.ref_role = 'tracking' AND r.external_id = tracking
      AND (r.provider_kind = provider OR r.provider_kind IS NULL)
  ) THEN RETURN no_readback; END IF;

  original_time := receipt.observation#>>'{intake,occurredAt}';
  IF original_time IS NULL
    OR original_time !~ '^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?([Zz]|[+-]\d{2}:?\d{2})$'
    OR NOT pg_input_is_valid(original_time, 'timestamp with time zone')
    OR NOT pg_input_is_valid(receipt.observation#>>'{fact,occurredAt}', 'timestamp with time zone')
  THEN RETURN no_readback; END IF;
  arrived_at := original_time::timestamptz;
  fact_time := (receipt.observation#>>'{fact,occurredAt}')::timestamptz;
  IF (arrived_at IS DISTINCT FROM fact_time AND date_trunc('milliseconds', arrived_at) IS DISTINCT FROM fact_time)
    OR arrived_at < parcel.created_at OR arrived_at > receipt.first_received_at OR arrived_at > now()
    OR NOT EXISTS (
      SELECT 1 FROM public.fulfillment_operator_status_evidence e
      WHERE e.shipment_id = p_shipment AND e.canonical_status = 'delivered'
        AND e.occurrence_key = receipt.observation#>>'{intake,occurrenceKey}'
        AND e.occurred_at = fact_time
    ) OR EXISTS (
      SELECT 1 FROM public.fulfillment_operator_status_evidence e
      WHERE e.shipment_id = p_shipment
        AND (e.canonical_status = 'cancelled' OR (e.canonical_status = 'exception' AND e.recovery_classification = 'manual'))
        AND (e.occurred_at IS NULL OR e.occurred_at >= date_trunc('milliseconds', arrived_at))
    )
  THEN RETURN no_readback; END IF;

  result := public.fulfillment_operator_record_tracking(operation_key, p_shipment,
    jsonb_build_object('status', 'delivered', 'providerTrackingId', tracking,
      'rawEvent', jsonb_build_object('occurredAt', to_char(arrived_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))), NULL);
  RETURN jsonb_build_object('readBack', result->>'status' = 'delivered' AND EXISTS (
    SELECT 1 FROM public.fulfillment_shipments
    WHERE id = p_shipment AND status = 'delivered' AND delivered_at <= arrived_at
  ));
END;
$$;

REVOKE ALL ON FUNCTION public.fulfillment_intake_record_delivery_without_tracking(text,uuid,uuid) FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.fulfillment_intake_record_delivery_without_tracking(text,uuid,uuid) FROM anon;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.fulfillment_intake_record_delivery_without_tracking(text,uuid,uuid) FROM authenticated;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'GRANT EXECUTE ON FUNCTION public.fulfillment_intake_record_delivery_without_tracking(text,uuid,uuid) TO service_role;'; END IF; END; $$;
