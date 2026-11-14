-- Private contact authority and retained correction responses are separate from evidence.
CREATE TABLE public.fulfillment_order_contacts (
 order_id uuid PRIMARY KEY REFERENCES public.commerce_orders(id),
 client_id uuid NOT NULL REFERENCES public.clients(id),
 contact jsonb,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 erased_at timestamptz
);

CREATE TABLE public.fulfillment_contact_correction_receipts (
 idempotency_key text PRIMARY KEY,
 order_id uuid NOT NULL REFERENCES public.commerce_orders(id),
 client_id uuid NOT NULL REFERENCES public.clients(id),
 shipment_id uuid REFERENCES public.fulfillment_shipments(id),
 request_fingerprint text NOT NULL,
 response_payload jsonb,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 erased_at timestamptz
);

ALTER TABLE public.fulfillment_order_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fulfillment_contact_correction_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.fulfillment_order_contacts FROM PUBLIC;
REVOKE ALL ON TABLE public.fulfillment_contact_correction_receipts FROM PUBLIC;
INSERT INTO public.client_absorption_policy (table_name, disposition, note) VALUES ('fulfillment_order_contacts', 'block', 'Recorded delivery contact history prevents lead absorption.');
INSERT INTO public.client_absorption_policy (table_name, disposition, note) VALUES ('fulfillment_contact_correction_receipts', 'block', 'Recorded delivery contact history prevents lead absorption.');

CREATE FUNCTION public.fulfillment_delivery_contact_resolution(p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE result jsonb; disposition text;
BEGIN
 result:=public.fulfillment_delivery_contact_resolve(p_input);
 disposition:=CASE
  WHEN coalesce((p_input->>'frozenContactPresent')::boolean,false) THEN CASE
   WHEN jsonb_typeof(p_input->'frozenContact') IS DISTINCT FROM 'object' THEN 'frozen_malformed'
   WHEN coalesce((result->>'carrierComplete')::boolean,false) THEN 'frozen_complete' ELSE 'frozen_incomplete' END
  WHEN coalesce((p_input->>'orderCanonicalPresent')::boolean,false) THEN 'order_canonical_without_frozen'
  WHEN coalesce((result->>'carrierComplete')::boolean,false) THEN 'inferred_complete' ELSE 'inferred_incomplete' END;
 RETURN result||jsonb_build_object('resolutionVersion',1,'disposition',disposition);
END; $$;

-- A read never captures contact or destination data. A missing baseline stays missing.
CREATE FUNCTION public.commerce_oms_resolve_delivery_contact_v1(p_order_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE purchase public.commerce_orders; parcel public.fulfillment_shipments;
 customer public.clients; prior public.fulfillment_parcel_contacts; override_contact public.fulfillment_order_contacts;
 destination public.commerce_destinations; renewal public.subscription_renewal_operations;
 destination_id uuid; address jsonb; result jsonb; contact jsonb; baseline jsonb;
 scope text; frozen boolean; canonical boolean;
BEGIN
 IF p_order_id IS NULL THEN RAISE EXCEPTION 'commerce_oms_delivery_contact_invalid_input' USING ERRCODE='22023'; END IF;
 SELECT * INTO purchase FROM public.commerce_orders WHERE id=p_order_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'commerce_oms_shipping_address_order_not_found' USING ERRCODE='22023'; END IF;
 SELECT * INTO parcel FROM public.fulfillment_shipments WHERE order_id=p_order_id ORDER BY sequence_no DESC,id DESC LIMIT 1;
 SELECT * INTO override_contact FROM public.fulfillment_order_contacts WHERE order_id=p_order_id;
 SELECT * INTO prior FROM public.fulfillment_parcel_contacts WHERE shipment_id=parcel.id;
 IF override_contact.erased_at IS NOT NULL OR prior.erased_at IS NOT NULL
  OR EXISTS(SELECT 1 FROM public.identity_privacy_erasures WHERE client_id=purchase.client_id) THEN
  RAISE EXCEPTION 'fulfillment_contact_erased' USING ERRCODE='55000'; END IF;
 baseline:=purchase.metadata#>'{runtimeFinalize,deliveryContact}';
 canonical:=override_contact.order_id IS NOT NULL OR purchase.metadata ? 'deliveryContactOverride'
  OR coalesce(purchase.metadata->'runtimeFinalize','{}') ? 'deliveryContact';
 scope:=CASE WHEN parcel.id IS NOT NULL AND prior.shipment_id IS NOT NULL THEN 'parcel'
  WHEN parcel.id IS NOT NULL THEN 'legacy_inferred'
  WHEN override_contact.order_id IS NOT NULL OR purchase.metadata ? 'deliveryContactOverride' THEN 'order_override'
  WHEN coalesce(purchase.metadata->'runtimeFinalize','{}') ? 'deliveryContact' THEN 'baseline'
  ELSE 'legacy_inferred' END;
 frozen:=scope IN ('parcel','order_override','baseline');
 contact:=CASE scope WHEN 'parcel' THEN prior.contact
  WHEN 'order_override' THEN CASE WHEN override_contact.order_id IS NOT NULL THEN override_contact.contact ELSE purchase.metadata->'deliveryContactOverride' END
  WHEN 'baseline' THEN baseline ELSE NULL END;
 -- Frozen authority never falls back to mutable customer or destination rows.
 IF NOT frozen AND NOT canonical THEN
  IF parcel.id IS NOT NULL THEN
   address:=public.commerce_view_shipment_destination(parcel.id)->'address';
  ELSE
   SELECT b.destination_id INTO destination_id FROM public.commerce_destination_bindings b WHERE b.order_id=p_order_id;
   IF destination_id IS NULL AND purchase.renewal_operation_id IS NOT NULL THEN
    SELECT * INTO renewal FROM public.subscription_renewal_operations WHERE id=purchase.renewal_operation_id;
    IF NOT FOUND OR renewal.operation_fingerprint IS DISTINCT FROM purchase.renewal_operation_fingerprint
     OR NOT EXISTS(SELECT 1 FROM public.subscriptions WHERE id=renewal.subscription_id AND client_id=purchase.client_id)
     OR NOT EXISTS(SELECT 1 FROM public.subscription_cycles WHERE id=purchase.subscription_cycle_id AND subscription_id=renewal.subscription_id
      AND renewal_operation_id=renewal.id AND renewal_operation_fingerprint=renewal.operation_fingerprint) THEN
     RAISE EXCEPTION 'commerce_destination_owner_mismatch' USING ERRCODE='22023'; END IF;
    BEGIN destination_id:=(renewal.cycle_snapshot#>>'{orderSnapshot,shippingAddressRef}')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'commerce_destination_frozen_ref_invalid' USING ERRCODE='22023'; END;
   ELSIF destination_id IS NULL THEN
    SELECT id INTO destination_id FROM public.commerce_destinations WHERE purchase_order_id=p_order_id;
   END IF;
   IF destination_id IS NULL THEN RAISE EXCEPTION 'commerce_destination_unavailable' USING ERRCODE='22023'; END IF;
   SELECT * INTO destination FROM public.commerce_destinations WHERE id=destination_id;
   IF NOT FOUND OR destination.client_id IS DISTINCT FROM purchase.client_id THEN
    RAISE EXCEPTION 'commerce_destination_owner_mismatch' USING ERRCODE='22023'; END IF;
   address:=destination.address;
  END IF;
  SELECT * INTO customer FROM public.clients WHERE id=purchase.client_id;
 END IF;
 result:=public.fulfillment_delivery_contact_resolution(jsonb_build_object(
  'frozenContactPresent',frozen,'frozenContact',contact,'orderCanonicalPresent',canonical,
  'selectedDeliveryCandidates',jsonb_build_array(parcel.metadata->'selectedDelivery',purchase.metadata->'selectedDelivery',purchase.metadata#>'{runtimeFinalize,selectedDelivery}',address->'selectedDelivery'),
  'channelOrderSnapshot',purchase.metadata->'channelOrderSnapshot',
  'recipientCandidates',CASE WHEN address ? 'savedAddressId' AND address->>'recipientName' IS NULL THEN jsonb_build_array(address->>'recipientName')
   ELSE jsonb_build_array(address->>'recipientName',concat_ws(' ',customer.first_name,customer.last_name),address->>'label') END,
  'phoneCandidates',jsonb_build_array(address->>'contactPhone',customer.phone),'legacyClientEmail',customer.email,
  'line1',address->>'line1','line2',address->>'line2','city',address->>'city','postalCode',address->>'postalCode','country',address->>'country',
  'deliveryInstructions',address->>'deliveryNotes','courierInstructions',address->>'courierInstructions'));
 contact:=result->'contact';
 IF result->>'disposition'='order_canonical_without_frozen' OR jsonb_typeof(contact) IS DISTINCT FROM 'object'
  OR contact->>'schemaVersion' IS DISTINCT FROM '1' OR coalesce(contact->>'revision','') !~ '^[1-9][0-9]*$'
  OR nullif(btrim(contact->>'source'),'') IS NULL THEN contact:=NULL; END IF;
 IF NOT frozen AND NOT canonical AND NOT coalesce((result->>'destinationComplete')::boolean,false) THEN
  RAISE EXCEPTION 'fulfillment_contact_not_recorded' USING ERRCODE='22023'; END IF;
 IF jsonb_typeof(baseline) IS DISTINCT FROM 'object' OR baseline->>'schemaVersion' IS DISTINCT FROM '1'
  OR coalesce(baseline->>'revision','') !~ '^[1-9][0-9]*$' OR nullif(btrim(baseline->>'source'),'') IS NULL THEN baseline:=NULL; END IF;
 RETURN jsonb_build_object('resolutionVersion',1,'scope',scope,'baseline',baseline,'contact',contact,
  'contactDigest',CASE WHEN contact IS NOT NULL THEN md5(contact::text) ELSE NULL END);
END; $$;

CREATE FUNCTION public.commerce_oms_update_shipping_address(p_key text,p_order_id uuid,p_contact jsonb,p_actor_id uuid,p_metadata jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE receipt public.fulfillment_contact_correction_receipts; purchase public.commerce_orders; parcel public.fulfillment_shipments;
 operation public.commerce_order_operations; fingerprint text; latest_id uuid; resolution jsonb; current_contact jsonb; corrected jsonb;
 expected_revision integer; expected_digest text; revision integer; scope text; payload jsonb; response jsonb;
BEGIN
 SET LOCAL lock_timeout = '3s';
 IF p_key IS NULL OR btrim(p_key)='' OR length(p_key)<8 OR p_order_id IS NULL OR p_actor_id IS NULL
  OR jsonb_typeof(p_contact) IS DISTINCT FROM 'object'
  OR nullif(btrim(p_contact->>'recipientName'),'') IS NULL OR nullif(btrim(p_contact->>'contactEmail'),'') IS NULL
  OR nullif(btrim(p_contact->>'contactPhone'),'') IS NULL OR nullif(btrim(p_contact->>'line1'),'') IS NULL
  OR nullif(btrim(p_contact->>'city'),'') IS NULL OR nullif(btrim(p_contact->>'postalCode'),'') IS NULL
  OR nullif(btrim(p_contact->>'country'),'') IS NULL
  OR (coalesce(p_metadata,'{}') ? '_deliveryContactExpectedRevision' AND coalesce(p_metadata->>'_deliveryContactExpectedRevision','') !~ '^[1-9][0-9]*$')
  OR (coalesce(p_metadata,'{}') ? '_deliveryContactExpectedDigest' AND coalesce(p_metadata->>'_deliveryContactExpectedDigest','') !~ '^[0-9a-f]{32}$') THEN
  RAISE EXCEPTION 'commerce_oms_shipping_address_invalid_input' USING ERRCODE='22023'; END IF;
 expected_revision:=(p_metadata->>'_deliveryContactExpectedRevision')::integer;
 expected_digest:=p_metadata->>'_deliveryContactExpectedDigest';
 fingerprint:=md5(p_order_id::text||'|'||p_contact::text||'|'||p_actor_id::text||'|'||coalesce(p_metadata,'{}')::text);
 SELECT * INTO receipt FROM public.fulfillment_contact_correction_receipts WHERE idempotency_key=p_key FOR UPDATE;
 IF FOUND THEN
  IF receipt.erased_at IS NOT NULL OR EXISTS(SELECT 1 FROM public.identity_privacy_erasures WHERE client_id=receipt.client_id) THEN
   RAISE EXCEPTION 'fulfillment_contact_erased' USING ERRCODE='55000'; END IF;
  IF receipt.request_fingerprint=fingerprint AND receipt.response_payload IS NOT NULL THEN
   RETURN receipt.response_payload||jsonb_build_object('replayed',true,'result','replayed'); END IF;
  RAISE EXCEPTION 'commerce_oms_shipping_address_idempotency_conflict' USING ERRCODE='23505';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('commerce-order-delivery|'||p_order_id::text,0));
 SELECT * INTO purchase FROM public.commerce_orders WHERE id=p_order_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'commerce_oms_shipping_address_order_not_found' USING ERRCODE='22023'; END IF;
 SELECT * INTO parcel FROM public.fulfillment_shipments WHERE order_id=p_order_id ORDER BY sequence_no DESC,id DESC LIMIT 1;
 IF parcel.id IS NOT NULL THEN
  PERFORM pg_advisory_xact_lock(hashtextextended('native-dispatch|'||parcel.id::text,0));
  SELECT * INTO parcel FROM public.fulfillment_shipments WHERE id=parcel.id FOR UPDATE;
  SELECT * INTO purchase FROM public.commerce_orders WHERE id=p_order_id FOR UPDATE;
  SELECT id INTO latest_id FROM public.fulfillment_shipments WHERE order_id=p_order_id ORDER BY sequence_no DESC,id DESC LIMIT 1;
  IF purchase.id IS NULL OR parcel.order_id IS DISTINCT FROM purchase.id OR latest_id IS DISTINCT FROM parcel.id THEN
   RAISE EXCEPTION 'commerce_oms_delivery_contact_stale_revision' USING ERRCODE='40001'; END IF;
  PERFORM id FROM public.fulfillment_dispatch_refs WHERE shipment_id=parcel.id ORDER BY id FOR UPDATE;
  IF EXISTS(SELECT 1 FROM public.fulfillment_dispatch_refs WHERE shipment_id=parcel.id AND (status<>'draft' OR external_ref IS NOT NULL))
   OR EXISTS(SELECT 1 FROM public.shipment_external_refs WHERE shipment_id=parcel.id AND ref_role='dispatch')
   OR parcel.status NOT IN ('created','packed','label_pending') THEN
   RAISE EXCEPTION 'commerce_oms_delivery_contact_submission_started' USING ERRCODE='55000'; END IF;
  scope:='parcel';
 ELSE
  SELECT * INTO purchase FROM public.commerce_orders WHERE id=p_order_id FOR UPDATE;
  IF EXISTS(SELECT 1 FROM public.fulfillment_shipments WHERE order_id=p_order_id) THEN
   RAISE EXCEPTION 'commerce_oms_delivery_contact_stale_revision' USING ERRCODE='40001'; END IF;
  scope:='order';
 END IF;
 PERFORM id FROM public.clients WHERE id=purchase.client_id FOR KEY SHARE;
 IF EXISTS(SELECT 1 FROM public.identity_privacy_erasures WHERE client_id=purchase.client_id)
  OR EXISTS(SELECT 1 FROM public.fulfillment_order_contacts WHERE order_id=p_order_id AND erased_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM public.fulfillment_parcel_contacts WHERE shipment_id=parcel.id AND erased_at IS NOT NULL) THEN
  RAISE EXCEPTION 'fulfillment_contact_erased' USING ERRCODE='55000'; END IF;
 resolution:=public.commerce_oms_resolve_delivery_contact_v1(p_order_id);
 current_contact:=resolution->'contact';
 IF jsonb_typeof(current_contact) IS DISTINCT FROM 'object' OR coalesce(current_contact->>'revision','') !~ '^[1-9][0-9]*$' THEN
  RAISE EXCEPTION 'commerce_oms_delivery_contact_stale_revision' USING ERRCODE='40001'; END IF;
 revision:=(current_contact->>'revision')::integer;
 IF (expected_revision IS NOT NULL AND expected_revision IS DISTINCT FROM revision)
  OR (expected_digest IS NOT NULL AND expected_digest IS DISTINCT FROM md5(current_contact::text)) THEN
  RAISE EXCEPTION 'commerce_oms_delivery_contact_stale_revision' USING ERRCODE='40001'; END IF;
 corrected:=current_contact||jsonb_build_object('source',CASE WHEN scope='parcel' THEN 'oms_parcel_correction' ELSE 'oms_order_override' END,
  'revision',revision+1,'recipientName',btrim(p_contact->>'recipientName'),'contactEmail',btrim(lower(p_contact->>'contactEmail')),
  'contactPhone',btrim(p_contact->>'contactPhone'),'line1',btrim(p_contact->>'line1'),
  'line2',CASE WHEN p_contact ? 'line2' THEN nullif(btrim(p_contact->>'line2'),'') ELSE current_contact->>'line2' END,
  'city',btrim(p_contact->>'city'),'postalCode',btrim(p_contact->>'postalCode'),'country',upper(btrim(p_contact->>'country')),
  'deliveryInstructions',CASE WHEN p_contact ? 'deliveryInstructions' THEN nullif(btrim(p_contact->>'deliveryInstructions'),'') ELSE current_contact->>'deliveryInstructions' END,
  'courierInstructions',CASE WHEN p_contact ? 'courierInstructions' THEN nullif(btrim(p_contact->>'courierInstructions'),'') ELSE current_contact->>'courierInstructions' END);
 -- Claim only after every fence. A refused call leaves no receipt or audit row.
 INSERT INTO public.fulfillment_contact_correction_receipts(idempotency_key,order_id,client_id,shipment_id,request_fingerprint)
 VALUES(p_key,p_order_id,purchase.client_id,parcel.id,fingerprint);
 IF scope='parcel' THEN
  INSERT INTO public.fulfillment_parcel_contacts(shipment_id,client_id,contact) VALUES(parcel.id,purchase.client_id,corrected)
  ON CONFLICT(shipment_id) DO UPDATE SET contact=EXCLUDED.contact;
  -- Existing claim/begin fences compare this operational revision under the same lock.
  UPDATE public.fulfillment_dispatch_contexts SET contact_revision=jsonb_build_object(
   'schemaVersion',corrected->'schemaVersion','source',corrected->'source','revision',corrected->'revision') WHERE shipment_id=parcel.id;
 ELSE
  INSERT INTO public.fulfillment_order_contacts(order_id,client_id,contact) VALUES(p_order_id,purchase.client_id,corrected)
  ON CONFLICT(order_id) DO UPDATE SET contact=EXCLUDED.contact,updated_at=now();
 END IF;
 payload:=jsonb_build_object('scope',scope,'beforeRevision',revision,'afterRevision',revision+1,'contactDigest',md5(corrected::text),
  'metadata',coalesce(p_metadata,'{}')-'_deliveryContactExpectedRevision'-'_deliveryContactExpectedDigest','source','commerce.oms.v0');
 INSERT INTO public.commerce_order_operations(order_id,actor_id,operation_type,source,idempotency_key,payload)
 VALUES(p_order_id,p_actor_id,'shipping_address_updated','commerce.oms.v0',p_key||':operation',payload) RETURNING * INTO operation;
 response:=jsonb_build_object('contractVersion','commerce.v0','result','applied','scope',scope,'deliveryContact',corrected,
  'operation',jsonb_build_object('id',operation.id,'orderId',operation.order_id,'type',operation.operation_type,'holdId',operation.hold_id,
   'actorUserId',operation.actor_id,'occurredAt',operation.occurred_at,'payload',operation.payload),
  'address',jsonb_build_object('recipientName',corrected->>'recipientName','contactEmail',corrected->>'contactEmail','contactPhone',corrected->>'contactPhone',
   'line1',corrected->>'line1','line2',corrected->>'line2','city',corrected->>'city','postalCode',corrected->>'postalCode','country',corrected->>'country'),'replayed',false);
 UPDATE public.fulfillment_contact_correction_receipts SET response_payload=response,updated_at=now() WHERE idempotency_key=p_key;
 RETURN response;
END; $$;

CREATE FUNCTION public.fulfillment_capture_order_contact_for_shipment(p_shipment_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE purchase public.commerce_orders; override_contact public.fulfillment_order_contacts; contact jsonb; result jsonb;
BEGIN
 SELECT o.* INTO purchase FROM public.commerce_orders o JOIN public.fulfillment_shipments s ON s.order_id=o.id WHERE s.id=p_shipment_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'fulfillment_parcel_contact_missing' USING ERRCODE='22023'; END IF;
 SELECT * INTO override_contact FROM public.fulfillment_order_contacts WHERE order_id=purchase.id;
 IF override_contact.erased_at IS NOT NULL OR EXISTS(SELECT 1 FROM public.identity_privacy_erasures WHERE client_id=purchase.client_id) THEN
  RETURN jsonb_build_object('erased',true); END IF;
 contact:=CASE WHEN override_contact.order_id IS NOT NULL THEN override_contact.contact
  WHEN purchase.metadata ? 'deliveryContactOverride' THEN purchase.metadata->'deliveryContactOverride'
  WHEN coalesce(purchase.metadata->'runtimeFinalize','{}') ? 'deliveryContact' THEN purchase.metadata#>'{runtimeFinalize,deliveryContact}'
  ELSE NULL END;
 -- Absence is not a recorded checkout baseline. Existing explicit preparation
 -- owns the first capture for a legacy order.
 IF contact IS NULL THEN RETURN jsonb_build_object('captured',false); END IF;
 result:=public.fulfillment_delivery_contact_resolve(jsonb_build_object('frozenContactPresent',true,'frozenContact',contact));
 IF NOT coalesce((result->>'destinationComplete')::boolean,false) THEN RETURN jsonb_build_object('captured',false); END IF;
 RETURN public.fulfillment_capture_parcel_contact(p_shipment_id,contact);
END; $$;

ALTER TABLE public.commerce_order_operations DROP CONSTRAINT commerce_order_operations_operation_type_check;
ALTER TABLE public.commerce_order_operations ADD CONSTRAINT commerce_order_operations_operation_type_check CHECK (operation_type IN ('hold_created','hold_released','order_cancelled','order_refunded','replacement_shipment_requested','shipping_address_updated'));

CREATE OR REPLACE FUNCTION public.fulfillment_export_parcel_contacts(p_client_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
 RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('shipmentId',shipment_id,'contact',contact,'capturedAt',captured_at,'erasedAt',erased_at) ORDER BY shipment_id)
  FROM public.fulfillment_parcel_contacts WHERE client_id=p_client_id),'[]'::jsonb)
  ||coalesce((SELECT jsonb_agg(jsonb_build_object('resource','order_contact','orderId',order_id,'contact',contact,
   'createdAt',created_at,'updatedAt',updated_at,'erasedAt',erased_at) ORDER BY order_id)
   FROM public.fulfillment_order_contacts WHERE client_id=p_client_id),'[]'::jsonb)
  ||coalesce((SELECT jsonb_agg(jsonb_build_object('resource','correction_receipt','idempotencyKey',idempotency_key,
   'orderId',order_id,'shipmentId',shipment_id,'requestFingerprint',request_fingerprint,'response',response_payload,
   'createdAt',created_at,'updatedAt',updated_at,'erasedAt',erased_at) ORDER BY idempotency_key)
   FROM public.fulfillment_contact_correction_receipts WHERE client_id=p_client_id),'[]'::jsonb);
END; $$;

CREATE OR REPLACE FUNCTION public.fulfillment_erase_parcel_contacts(p_client_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE affected integer; count_rows integer;
BEGIN
 PERFORM id FROM public.clients WHERE id=p_client_id FOR UPDATE;
 UPDATE public.fulfillment_parcel_contacts SET contact='{}'::jsonb,erased_at=now() WHERE client_id=p_client_id AND erased_at IS NULL;
 GET DIAGNOSTICS affected=ROW_COUNT;
 UPDATE public.fulfillment_order_contacts SET contact=NULL,erased_at=now(),updated_at=now() WHERE client_id=p_client_id AND erased_at IS NULL;
 GET DIAGNOSTICS count_rows=ROW_COUNT; affected:=affected+count_rows;
 UPDATE public.fulfillment_contact_correction_receipts SET response_payload=NULL,erased_at=now(),updated_at=now() WHERE client_id=p_client_id AND erased_at IS NULL;
 GET DIAGNOSTICS count_rows=ROW_COUNT; affected:=affected+count_rows;
 RETURN jsonb_build_object('erased',affected);
END; $$;

CREATE OR REPLACE FUNCTION public.fulfillment_open_shipment(
  p_idempotency_key text,
  p_order_id uuid,
  p_port_key text,
  p_metadata jsonb,
  p_requested_at timestamptz
)
RETURNS public.fulfillment_shipments
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_port public.fulfillment_ports%ROWTYPE;
  v_shipment public.fulfillment_shipments%ROWTYPE;
BEGIN
  SELECT * INTO v_port FROM public.fulfillment_ports WHERE port_key = p_port_key;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'fulfillment_port_not_registered' USING ERRCODE = '22023';
  END IF;
  IF NOT v_port.routable THEN
    RAISE EXCEPTION 'fulfillment_port_not_routable' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.fulfillment_shipments
    (order_id, port_key, provider_type, create_idempotency_key, metadata, created_at, updated_at)
  VALUES (p_order_id, v_port.port_key, v_port.provider_type, p_idempotency_key,
          COALESCE(p_metadata, '{}'::jsonb), p_requested_at, p_requested_at)
  RETURNING * INTO v_shipment;

  INSERT INTO public.fulfillment_shipment_operations
    (shipment_id, order_id, operation_type, idempotency_key, payload, occurred_at)
  VALUES (v_shipment.id, p_order_id, 'shipment_created', p_idempotency_key || ':operation',
          jsonb_build_object('portKey', v_port.port_key, 'providerType', v_port.provider_type),
          p_requested_at);

  PERFORM public.fulfillment_capture_new_parcel_reservations(v_shipment.id,p_idempotency_key);
  PERFORM public.fulfillment_capture_order_contact_for_shipment(v_shipment.id);
  RETURN v_shipment;
END;
$$;

CREATE OR REPLACE FUNCTION public.fulfillment_resolve_parcel_contact(p_shipment_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE prior public.fulfillment_parcel_contacts; parcel public.fulfillment_shipments; purchase public.commerce_orders;
 customer public.clients; destination jsonb; address jsonb; result jsonb; present boolean;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('native-dispatch|'||p_shipment_id::text,0));
 SELECT * INTO parcel FROM public.fulfillment_shipments WHERE id=p_shipment_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'fulfillment_parcel_contact_missing' USING ERRCODE='22023'; END IF;
 SELECT * INTO purchase FROM public.commerce_orders WHERE id=parcel.order_id;
 PERFORM id FROM public.clients WHERE id=purchase.client_id FOR KEY SHARE;
 SELECT * INTO prior FROM public.fulfillment_parcel_contacts WHERE shipment_id=parcel.id FOR UPDATE;
 present:=FOUND;
 IF EXISTS(SELECT 1 FROM public.identity_privacy_erasures WHERE client_id=purchase.client_id) THEN
  RAISE EXCEPTION 'commerce_oms_replacement_delivery_contact_invalid' USING ERRCODE='22023'; END IF;
 IF present THEN
  result:=public.fulfillment_delivery_contact_resolve(jsonb_build_object('frozenContactPresent',true,'frozenContact',prior.contact));
  IF NOT coalesce((result->>'carrierComplete')::boolean,false) THEN
   RAISE EXCEPTION 'commerce_oms_replacement_delivery_contact_invalid' USING ERRCODE='22023'; END IF;
  RETURN prior.contact;
 END IF;
 IF EXISTS(SELECT 1 FROM public.fulfillment_order_contacts WHERE order_id=purchase.id) OR purchase.metadata ? 'deliveryContactOverride' OR coalesce(purchase.metadata->'runtimeFinalize','{}') ? 'deliveryContact' THEN
  RAISE EXCEPTION 'commerce_oms_replacement_delivery_contact_invalid' USING ERRCODE='22023'; END IF;
 destination:=public.commerce_read_destination('shipment',parcel.id); address:=destination->'address';
 SELECT * INTO customer FROM public.clients WHERE id=purchase.client_id;
 result:=public.fulfillment_delivery_contact_resolve(jsonb_build_object(
  'selectedDeliveryCandidates',jsonb_build_array(parcel.metadata->'selectedDelivery',purchase.metadata->'selectedDelivery',purchase.metadata#>'{runtimeFinalize,selectedDelivery}',address->'selectedDelivery'),
  'channelOrderSnapshot',purchase.metadata->'channelOrderSnapshot',
  'recipientCandidates',CASE WHEN address ? 'savedAddressId' AND address->>'recipientName' IS NULL
   THEN jsonb_build_array(address->>'recipientName')
   ELSE jsonb_build_array(address->>'recipientName',concat_ws(' ',customer.first_name,customer.last_name),address->>'label') END,
  'phoneCandidates',jsonb_build_array(address->>'contactPhone',customer.phone),'legacyClientEmail',customer.email,
  'line1',address->>'line1','line2',address->>'line2','city',address->>'city','postalCode',address->>'postalCode','country',address->>'country',
  'deliveryInstructions',address->>'deliveryNotes','courierInstructions',address->>'courierInstructions'));
 IF NOT coalesce((result->>'destinationComplete')::boolean,false) THEN
  RAISE EXCEPTION 'commerce_oms_replacement_delivery_contact_invalid' USING ERRCODE='22023'; END IF;
 PERFORM public.fulfillment_capture_parcel_contact(parcel.id,result->'contact');
 RETURN (SELECT contact FROM public.fulfillment_parcel_contacts WHERE shipment_id=parcel.id);
END; $$;

REVOKE ALL ON FUNCTION public.fulfillment_delivery_contact_resolution(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.commerce_oms_resolve_delivery_contact_v1(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.commerce_oms_update_shipping_address(text,uuid,jsonb,uuid,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fulfillment_capture_order_contact_for_shipment(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fulfillment_export_parcel_contacts(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fulfillment_erase_parcel_contacts(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fulfillment_resolve_parcel_contact(uuid) FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'REVOKE ALL ON TABLE public.fulfillment_order_contacts, public.fulfillment_contact_correction_receipts FROM anon;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'REVOKE ALL ON TABLE public.fulfillment_order_contacts, public.fulfillment_contact_correction_receipts FROM authenticated;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'REVOKE ALL ON TABLE public.fulfillment_order_contacts, public.fulfillment_contact_correction_receipts FROM service_role;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.fulfillment_delivery_contact_resolution(jsonb), public.commerce_oms_resolve_delivery_contact_v1(uuid), public.commerce_oms_update_shipping_address(text,uuid,jsonb,uuid,jsonb), public.fulfillment_capture_order_contact_for_shipment(uuid), public.fulfillment_export_parcel_contacts(uuid), public.fulfillment_erase_parcel_contacts(uuid), public.fulfillment_resolve_parcel_contact(uuid) FROM anon;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.fulfillment_delivery_contact_resolution(jsonb), public.commerce_oms_resolve_delivery_contact_v1(uuid), public.commerce_oms_update_shipping_address(text,uuid,jsonb,uuid,jsonb), public.fulfillment_capture_order_contact_for_shipment(uuid), public.fulfillment_export_parcel_contacts(uuid), public.fulfillment_erase_parcel_contacts(uuid), public.fulfillment_resolve_parcel_contact(uuid) FROM authenticated;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'GRANT EXECUTE ON FUNCTION public.commerce_oms_resolve_delivery_contact_v1(uuid), public.commerce_oms_update_shipping_address(text,uuid,jsonb,uuid,jsonb), public.fulfillment_capture_order_contact_for_shipment(uuid), public.fulfillment_export_parcel_contacts(uuid), public.fulfillment_erase_parcel_contacts(uuid) TO service_role;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'GRANT SELECT (client_id) ON TABLE public.fulfillment_order_contacts TO service_role;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'CREATE POLICY fulfillment_order_contacts_absorption_census ON public.fulfillment_order_contacts FOR SELECT TO service_role USING (true);'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'GRANT SELECT (client_id) ON TABLE public.fulfillment_contact_correction_receipts TO service_role;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'CREATE POLICY fulfillment_contact_correction_receipts_absorption_census ON public.fulfillment_contact_correction_receipts FOR SELECT TO service_role USING (true);'; END IF; END; $$;
