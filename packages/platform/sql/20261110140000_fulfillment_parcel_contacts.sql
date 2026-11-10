-- Private delivery data is separate from dispatch evidence and public projections.
CREATE TABLE public.fulfillment_parcel_contacts (
 shipment_id uuid PRIMARY KEY REFERENCES public.fulfillment_shipments(id),
 client_id uuid NOT NULL REFERENCES public.clients(id),
 contact jsonb NOT NULL,
 captured_at timestamptz NOT NULL DEFAULT now(),
 erased_at timestamptz,
 CONSTRAINT fulfillment_parcel_contacts_shape_check CHECK (jsonb_typeof(contact) IN ('object','null'))
);
ALTER TABLE public.fulfillment_parcel_contacts ENABLE ROW LEVEL SECURITY;
INSERT INTO public.client_absorption_policy (table_name, disposition, note) VALUES ('fulfillment_parcel_contacts', 'block', 'Private parcel contact history remains attached to its delivery owner.');

CREATE FUNCTION public.fulfillment_delivery_contact_resolve(p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE contact jsonb; chosen jsonb; candidate jsonb; recipient text; phone text; destination_complete boolean; carrier_complete boolean;
BEGIN
 FOR candidate IN SELECT value FROM jsonb_array_elements(coalesce(p_input->'selectedDeliveryCandidates','[]')) LOOP
  IF jsonb_typeof(candidate)='object' THEN chosen:=candidate; EXIT; END IF;
 END LOOP;
 FOR candidate IN SELECT value FROM jsonb_array_elements(coalesce(p_input->'recipientCandidates','[]')) LOOP
  recipient:=nullif(btrim(candidate#>>'{}'),''); EXIT WHEN recipient IS NOT NULL;
 END LOOP;
 FOR candidate IN SELECT value FROM jsonb_array_elements(coalesce(p_input->'phoneCandidates','[]')) LOOP
  phone:=nullif(btrim(candidate#>>'{}'),''); EXIT WHEN phone IS NOT NULL;
 END LOOP;
 IF coalesce((p_input->>'frozenContactPresent')::boolean,false) THEN contact:=p_input->'frozenContact';
 ELSIF jsonb_typeof(p_input->'channelOrderSnapshot')='object' THEN
  contact:=jsonb_build_object('schemaVersion',1,'source','channel_order_snapshot','revision',1,
   'recipientName',nullif(btrim(p_input#>>'{channelOrderSnapshot,shipTo,recipientName}'),''),
   'contactEmail',nullif(btrim(lower(p_input#>>'{channelOrderSnapshot,buyer,email}')),''),
   'contactPhone',coalesce(nullif(btrim(p_input#>>'{channelOrderSnapshot,shipTo,phone}'),''),nullif(btrim(p_input#>>'{channelOrderSnapshot,buyer,phone}'),'')),
   'line1',p_input#>>'{channelOrderSnapshot,shipTo,line1}','line2',nullif(btrim(p_input#>>'{channelOrderSnapshot,shipTo,line2}'),''),
   'city',p_input#>>'{channelOrderSnapshot,shipTo,city}','postalCode',p_input#>>'{channelOrderSnapshot,shipTo,postalCode}',
   'country',upper(p_input#>>'{channelOrderSnapshot,shipTo,countryCode}'),'selectedDelivery',chosen,'deliveryInstructions',NULL,'courierInstructions',NULL);
 ELSE
  contact:=jsonb_build_object('schemaVersion',1,'source','legacy_inferred','revision',1,'recipientName',recipient,
   'contactEmail',CASE WHEN lower(coalesce(p_input->>'legacyClientEmail','')) LIKE '%.invalid' THEN NULL ELSE nullif(btrim(lower(p_input->>'legacyClientEmail')),'') END,
   'contactPhone',phone,'line1',p_input->>'line1','line2',nullif(btrim(p_input->>'line2'),''),
   'city',p_input->>'city','postalCode',p_input->>'postalCode','country',p_input->>'country','selectedDelivery',chosen,
   'deliveryInstructions',p_input->>'deliveryInstructions','courierInstructions',p_input->>'courierInstructions');
 END IF;
 destination_complete:=jsonb_typeof(contact)='object' AND contact->>'schemaVersion'='1'
  AND coalesce(contact->>'revision','') ~ '^[1-9][0-9]*$' AND nullif(btrim(contact->>'source'),'') IS NOT NULL
  AND nullif(btrim(contact->>'line1'),'') IS NOT NULL AND nullif(btrim(contact->>'city'),'') IS NOT NULL
  AND nullif(btrim(contact->>'postalCode'),'') IS NOT NULL AND nullif(btrim(contact->>'country'),'') IS NOT NULL;
 carrier_complete:=destination_complete AND nullif(btrim(contact->>'recipientName'),'') IS NOT NULL AND nullif(btrim(contact->>'contactPhone'),'') IS NOT NULL;
 RETURN jsonb_build_object('contact',CASE WHEN jsonb_typeof(contact)='object' THEN contact ELSE 'null'::jsonb END,
  'destinationComplete',destination_complete,'carrierComplete',carrier_complete);
END; $$;

CREATE FUNCTION public.fulfillment_capture_parcel_contact(p_shipment_id uuid,p_contact jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE prior public.fulfillment_parcel_contacts; owner_id uuid; value jsonb:='{}'; k text; delivery jsonb; point jsonb; address jsonb;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('native-dispatch|'||p_shipment_id::text,0));
 SELECT o.client_id INTO owner_id FROM public.fulfillment_shipments s JOIN public.commerce_orders o ON o.id=s.order_id WHERE s.id=p_shipment_id FOR UPDATE OF s;
 IF NOT FOUND OR owner_id IS NULL OR jsonb_typeof(p_contact) IS DISTINCT FROM 'object' THEN
  RAISE EXCEPTION 'fulfillment_parcel_contact_invalid' USING ERRCODE='22023'; END IF;
 -- Subject lock precedes the receipt check; erasure cannot race a fresh insert.
 PERFORM id FROM public.clients WHERE id=owner_id FOR KEY SHARE;
 IF EXISTS(SELECT 1 FROM public.identity_privacy_erasures WHERE client_id=owner_id) THEN RETURN jsonb_build_object('erased',true); END IF;
 -- Explicit allowlist; neither commands, credentials nor arbitrary host fields persist.
 FOREACH k IN ARRAY ARRAY['schemaVersion','source','revision','recipientName','contactEmail','contactPhone','line1','line2','city','postalCode','country','deliveryInstructions','courierInstructions'] LOOP
  value:=value||jsonb_build_object(k,p_contact->k);
 END LOOP;
 IF jsonb_typeof(p_contact->'selectedDelivery')='object' THEN
  delivery:='{}';
  FOREACH k IN ARRAY ARRAY['providerKind','carrierKind','carrierCode','serviceCode','service','deliveryKind','kind'] LOOP
   IF p_contact->'selectedDelivery' ? k THEN delivery:=delivery||jsonb_build_object(k,p_contact#>ARRAY['selectedDelivery',k]); END IF;
  END LOOP;
  IF jsonb_typeof(p_contact#>'{selectedDelivery,pickupPoint}')='object' THEN
   point:='{}'; address:='{}';
   FOREACH k IN ARRAY ARRAY['id','pointId','name'] LOOP
    IF p_contact#>'{selectedDelivery,pickupPoint}' ? k THEN point:=point||jsonb_build_object(k,p_contact#>ARRAY['selectedDelivery','pickupPoint',k]); END IF;
   END LOOP;
   IF jsonb_typeof(p_contact#>'{selectedDelivery,pickupPoint,address}')='object' THEN
    FOREACH k IN ARRAY ARRAY['line1','postalCode','city','country'] LOOP
     IF p_contact#>'{selectedDelivery,pickupPoint,address}' ? k THEN address:=address||jsonb_build_object(k,p_contact#>ARRAY['selectedDelivery','pickupPoint','address',k]); END IF;
    END LOOP;
    point:=point||jsonb_build_object('address',address);
   END IF;
   delivery:=delivery||jsonb_build_object('pickupPoint',point);
  END IF;
 END IF;
 value:=value||jsonb_build_object('selectedDelivery',delivery);
 SELECT * INTO prior FROM public.fulfillment_parcel_contacts WHERE shipment_id=p_shipment_id FOR UPDATE;
 IF FOUND THEN
  IF prior.erased_at IS NOT NULL THEN RETURN jsonb_build_object('erased',true); END IF;
  IF prior.contact=value THEN RETURN jsonb_build_object('replayed',true); END IF;
  IF EXISTS(SELECT 1 FROM public.fulfillment_dispatch_refs WHERE shipment_id=p_shipment_id AND status<>'draft') THEN
   RAISE EXCEPTION 'fulfillment_parcel_contact_frozen' USING ERRCODE='22023'; END IF;
  UPDATE public.fulfillment_parcel_contacts SET contact=value,captured_at=now() WHERE shipment_id=p_shipment_id;
 ELSE INSERT INTO public.fulfillment_parcel_contacts(shipment_id,client_id,contact) VALUES(p_shipment_id,owner_id,value);
 END IF;
 RETURN jsonb_build_object('replayed',false);
END; $$;

CREATE FUNCTION public.fulfillment_resolve_parcel_contact(p_shipment_id uuid)
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
 IF purchase.metadata ? 'deliveryContactOverride' OR coalesce(purchase.metadata->'runtimeFinalize','{}') ? 'deliveryContact' THEN
  RAISE EXCEPTION 'commerce_oms_replacement_delivery_contact_invalid' USING ERRCODE='22023'; END IF;
 destination:=public.commerce_read_destination('shipment',parcel.id); address:=destination->'address';
 SELECT * INTO customer FROM public.clients WHERE id=purchase.client_id;
 result:=public.fulfillment_delivery_contact_resolve(jsonb_build_object(
  'selectedDeliveryCandidates',jsonb_build_array(parcel.metadata->'selectedDelivery',purchase.metadata->'selectedDelivery',purchase.metadata#>'{runtimeFinalize,selectedDelivery}',address->'selectedDelivery'),
  'channelOrderSnapshot',purchase.metadata->'channelOrderSnapshot',
  'recipientCandidates',jsonb_build_array(address->>'recipientName',concat_ws(' ',customer.first_name,customer.last_name),address->>'label'),
  'phoneCandidates',jsonb_build_array(address->>'contactPhone',customer.phone),'legacyClientEmail',customer.email,
  'line1',address->>'line1','line2',address->>'line2','city',address->>'city','postalCode',address->>'postalCode','country',address->>'country',
  'deliveryInstructions',address->>'deliveryNotes','courierInstructions',address->>'courierInstructions'));
 IF NOT coalesce((result->>'destinationComplete')::boolean,false) THEN
  RAISE EXCEPTION 'commerce_oms_replacement_delivery_contact_invalid' USING ERRCODE='22023'; END IF;
 PERFORM public.fulfillment_capture_parcel_contact(parcel.id,result->'contact');
 RETURN (SELECT contact FROM public.fulfillment_parcel_contacts WHERE shipment_id=parcel.id);
END; $$;

CREATE FUNCTION public.fulfillment_export_parcel_contacts(p_client_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
 RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('shipmentId',shipment_id,'contact',contact,'capturedAt',captured_at,'erasedAt',erased_at) ORDER BY shipment_id)
  FROM public.fulfillment_parcel_contacts WHERE client_id=p_client_id),'[]'::jsonb);
END; $$;

CREATE FUNCTION public.fulfillment_erase_parcel_contacts(p_client_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE affected integer;
BEGIN
 PERFORM id FROM public.clients WHERE id=p_client_id FOR UPDATE;
 UPDATE public.fulfillment_parcel_contacts SET contact='{}'::jsonb,erased_at=now() WHERE client_id=p_client_id AND erased_at IS NULL;
 GET DIAGNOSTICS affected=ROW_COUNT;
 RETURN jsonb_build_object('erased',affected);
END; $$;

REVOKE ALL ON TABLE public.fulfillment_parcel_contacts FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fulfillment_delivery_contact_resolve(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fulfillment_capture_parcel_contact(uuid,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fulfillment_resolve_parcel_contact(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fulfillment_export_parcel_contacts(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fulfillment_erase_parcel_contacts(uuid) FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'REVOKE ALL ON TABLE public.fulfillment_parcel_contacts FROM anon'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'REVOKE ALL ON TABLE public.fulfillment_parcel_contacts FROM authenticated'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'REVOKE ALL ON TABLE public.fulfillment_parcel_contacts FROM service_role'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.fulfillment_delivery_contact_resolve(jsonb), public.fulfillment_capture_parcel_contact(uuid,jsonb), public.fulfillment_resolve_parcel_contact(uuid), public.fulfillment_export_parcel_contacts(uuid), public.fulfillment_erase_parcel_contacts(uuid) FROM anon'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.fulfillment_delivery_contact_resolve(jsonb), public.fulfillment_capture_parcel_contact(uuid,jsonb), public.fulfillment_resolve_parcel_contact(uuid), public.fulfillment_export_parcel_contacts(uuid), public.fulfillment_erase_parcel_contacts(uuid) FROM authenticated'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'GRANT EXECUTE ON FUNCTION public.fulfillment_capture_parcel_contact(uuid,jsonb), public.fulfillment_export_parcel_contacts(uuid), public.fulfillment_erase_parcel_contacts(uuid) TO service_role'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'GRANT SELECT (client_id) ON TABLE public.fulfillment_parcel_contacts TO service_role;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'CREATE POLICY fulfillment_parcel_contacts_absorption_census ON public.fulfillment_parcel_contacts FOR SELECT TO service_role USING (true);'; END IF; END; $$;
