-- The retained document and the service pin come from the same verified order binding.
CREATE FUNCTION public.fulfillment_destination_contact_v2(p_order_id uuid,p_shipment_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  owner_id uuid; bound public.commerce_destination_v2_order_bindings; ctx jsonb; retained jsonb;
  document jsonb; address jsonb; contact jsonb; classes jsonb; recipient jsonb;
  field text; member text; byte_limit integer; value jsonb; item jsonb; previous text;
  controls constant text := U&'[\0001-\001F\007F-\009F]';
BEGIN
  SELECT client_id INTO owner_id FROM public.commerce_orders WHERE id=p_order_id;
  IF NOT FOUND THEN RETURN public.commerce_destination_v2_refusal('unavailable','orderId'); END IF;
  IF NOT EXISTS(SELECT 1 FROM public.fulfillment_shipments WHERE id=p_shipment_id AND order_id=p_order_id) THEN
    RETURN public.commerce_destination_v2_refusal('unavailable','shipmentId');
  END IF;
  SELECT * INTO bound FROM public.commerce_destination_v2_order_bindings WHERE order_id=p_order_id;
  SELECT jsonb_build_object('clientId',owner_id,'scopeRef',d.scope_ref,'owner',d.owner_scope) INTO ctx
    FROM public.commerce_destination_v2_documents d WHERE d.snapshot_ref=bound.snapshot_ref;
  IF NOT public.commerce_destination_v2_is_uuid(ctx->'scopeRef')
    OR NOT public.commerce_destination_v2_valid_context(ctx,(ctx->>'scopeRef')::uuid) THEN
    RETURN public.commerce_destination_v2_refusal('unavailable','shipmentId');
  END IF;
  retained:=public.commerce_destination_v2_check_retained(ctx,bound,'shipmentId');
  IF retained ? 'outcome' THEN RETURN retained; END IF;
  document:=retained->'document';
  address:=document->'address'; contact:=document->'contact'; classes:=document->'classificationKeys';
  IF jsonb_typeof(address) IS DISTINCT FROM 'object' OR jsonb_typeof(contact) IS DISTINCT FROM 'object'
    OR jsonb_typeof(classes) IS DISTINCT FROM 'array' THEN
    RETURN public.commerce_destination_v2_refusal('stored_binding','destination');
  END IF;
  IF address - ARRAY['line1','line2','city','subdivision','postalCode','country'] <> '{}'::jsonb
    OR NOT address ?& ARRAY['line1','city','postalCode','country']
    OR address->>'country' COLLATE "C" !~ '^[A-Z]{2}$'
    OR (address ? 'subdivision' AND address->>'subdivision' COLLATE "C" !~ '^[A-Z0-9-]{1,16}$')
    OR contact - ARRAY['recipientName','contactPhone','contactEmail','companyName','label','taxId','deliveryNotes','courierInstructions'] <> '{}'::jsonb
    OR jsonb_array_length(classes)>32 THEN
    RETURN public.commerce_destination_v2_refusal('stored_binding','destination');
  END IF;
  FOR field, member, byte_limit IN SELECT * FROM (VALUES
    ('address','line1',200),('address','line2',200),('address','city',120),('address','postalCode',32),
    ('address','country',2),('address','subdivision',16),('contact','recipientName',200),
    ('contact','contactPhone',64),('contact','contactEmail',254),('contact','companyName',200),
    ('contact','label',200),('contact','taxId',64),('contact','deliveryNotes',500),('contact','courierInstructions',500)
  ) AS fields(section,key,limit_bytes) LOOP
    value:=document->field->member;
    IF value IS NULL THEN CONTINUE; END IF;
    IF jsonb_typeof(value)<>'string' OR (value #>> '{}') COLLATE "C" ~ controls
      OR octet_length(value #>> '{}')>byte_limit OR btrim(value #>> '{}')=''
      OR (field='address' AND ((value #>> '{}')<>btrim(value #>> '{}') OR NOT ((value #>> '{}') IS NFC NORMALIZED))) THEN
      RETURN public.commerce_destination_v2_refusal('stored_binding','destination');
    END IF;
  END LOOP;
  FOR item IN SELECT element FROM jsonb_array_elements(classes) AS e(element) LOOP
    member:=item #>> '{}';
    IF jsonb_typeof(item)<>'string' OR char_length(member)>64
      OR member COLLATE "C" !~ '^[a-z][a-z0-9]*([._-][a-z0-9]+)*$' OR previous COLLATE "C">=member THEN
      RETURN public.commerce_destination_v2_refusal('stored_binding','destination');
    END IF;
    previous:=member;
  END LOOP;
  IF NOT contact ?& ARRAY['recipientName','contactPhone'] THEN
    RETURN jsonb_build_object('outcome','refused','code','destination_contact_incomplete',
      'field',CASE WHEN contact ? 'recipientName' THEN 'contact.contactPhone' ELSE 'contact.recipientName' END,
      'observed','Required recipient contact is missing.','cause','The first parcel requires a recipient name and phone.',
      'fix','Send the original order evidence to the order owner for review.',
      'recheck','Recheck only after an authorized order disposition.');
  END IF;
  recipient:=jsonb_strip_nulls(jsonb_build_object('recipientName',contact->'recipientName','contactPhone',contact->'contactPhone',
    'contactEmail',contact->'contactEmail','deliveryInstructions',contact->'deliveryNotes','courierInstructions',contact->'courierInstructions'));
  RETURN jsonb_build_object('schemaVersion',2,'source','destination_binding','revision',1,
    'binding',retained->'binding','classificationKeys',classes,'service',bound.service,'address',address,'recipient',recipient);
END; $$;
REVOKE ALL ON FUNCTION public.fulfillment_destination_contact_v2(uuid,uuid) FROM PUBLIC;

CREATE FUNCTION public.fulfillment_freeze_destination_contact_v2(p_shipment_id uuid,p_contact jsonb,p_action text)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  parcel public.fulfillment_shipments; owner_id uuid; prior public.fulfillment_parcel_contacts;
  projection jsonb; refusal jsonb; present boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('native-dispatch|'||p_shipment_id::text,0));
  SELECT * INTO parcel FROM public.fulfillment_shipments WHERE id=p_shipment_id FOR UPDATE;
  SELECT client_id INTO owner_id FROM public.commerce_orders WHERE id=parcel.order_id FOR KEY SHARE;
  PERFORM id FROM public.clients WHERE id=owner_id FOR KEY SHARE;
  projection:=public.fulfillment_destination_contact_v2(parcel.order_id,p_shipment_id);
  IF projection ? 'outcome' THEN
    refusal:=projection;
  ELSE
    SELECT * INTO prior FROM public.fulfillment_parcel_contacts WHERE shipment_id=p_shipment_id FOR UPDATE;
    present:=FOUND;
    IF p_action='capture' AND p_contact IS DISTINCT FROM projection THEN
      refusal:=public.commerce_destination_v2_refusal('input','contact');
    ELSIF present AND prior.erased_at IS NOT NULL THEN
      refusal:=public.commerce_destination_v2_refusal('unavailable','shipmentId');
    ELSIF present AND (prior.client_id IS DISTINCT FROM owner_id OR prior.contact IS DISTINCT FROM projection) THEN
      refusal:=public.commerce_destination_v2_refusal('stored_binding','destination');
    ELSIF NOT present AND (p_action<>'open' OR parcel.sequence_no<>0 OR NOT EXISTS(
      SELECT 1 FROM public.fulfillment_shipments s JOIN public.fulfillment_shipment_operations op ON op.shipment_id=s.id
      WHERE s.id=parcel.id AND op.order_id=parcel.order_id AND op.operation_type='shipment_created'
        AND op.idempotency_key=parcel.create_idempotency_key||':operation'
        AND s.xmin=op.xmin AND op.xmin::text=mod(pg_current_xact_id()::text::numeric,4294967296)::text
    )) THEN
      refusal:=public.commerce_destination_v2_refusal('unavailable','shipmentId');
    END IF;
  END IF;
  IF refusal IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE=refusal->>'code', DETAIL=refusal->>'field', HINT=refusal->>'fix';
  END IF;
  IF present THEN RETURN jsonb_build_object('replayed',true,'contact',prior.contact); END IF;
  INSERT INTO public.fulfillment_parcel_contacts(shipment_id,client_id,contact) VALUES(parcel.id,owner_id,projection);
  RETURN jsonb_build_object('replayed',false,'contact',projection);
END; $$;
REVOKE ALL ON FUNCTION public.fulfillment_freeze_destination_contact_v2(uuid,jsonb,text) FROM PUBLIC;

CREATE FUNCTION public.fulfillment_destination_line_snapshot_v2(p_source jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  k text; v jsonb; t text;
BEGIN
  IF jsonb_typeof(p_source) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'address_invalid_input' USING ERRCODE='22023', DETAIL='productSnapshot', HINT='Correct the indicated input.';
  END IF;
  FOR k,v IN SELECT key,value FROM jsonb_each(p_source)
    WHERE key IN ('productRef','packRef','lotRef','lotNumber','lotCode','expirationDate','expiresAt') AND value<>'null'::jsonb LOOP
    k:=CASE WHEN k IN ('lotNumber','lotCode') THEN 'lotRef' WHEN k='expiresAt' THEN 'expirationDate' ELSE k END;
    t:=v #>> '{}';
    IF jsonb_typeof(v)<>'string' OR (k<>'expirationDate' AND t COLLATE "C" !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')
      OR (k='expirationDate' AND t COLLATE "C" !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$') THEN
      RAISE EXCEPTION 'address_invalid_input' USING ERRCODE='22023', DETAIL='productSnapshot.'||k, HINT='Correct the indicated input.';
    END IF;
    IF k='expirationDate' THEN
      BEGIN
        PERFORM make_date(substr(t,1,4)::int,substr(t,6,2)::int,substr(t,9,2)::int);
      EXCEPTION WHEN datetime_field_overflow THEN
        RAISE EXCEPTION 'address_invalid_input' USING ERRCODE='22023', DETAIL='productSnapshot.expirationDate', HINT='Correct the indicated input.';
      END;
    END IF;
  END LOOP;
  RETURN jsonb_strip_nulls(jsonb_build_object('productRef',p_source->'productRef','packRef',p_source->'packRef',
    'lotRef',coalesce(nullif(p_source->'lotRef','null'::jsonb),nullif(p_source->'lotNumber','null'::jsonb),p_source->'lotCode'),
    'expirationDate',coalesce(nullif(p_source->'expirationDate','null'::jsonb),p_source->'expiresAt')));
END; $$;
REVOKE ALL ON FUNCTION public.fulfillment_destination_line_snapshot_v2(jsonb) FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
  EXECUTE 'REVOKE ALL ON FUNCTION public.fulfillment_destination_contact_v2(uuid,uuid), public.fulfillment_freeze_destination_contact_v2(uuid,jsonb,text), public.fulfillment_destination_line_snapshot_v2(jsonb) FROM anon;';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
  EXECUTE 'REVOKE ALL ON FUNCTION public.fulfillment_destination_contact_v2(uuid,uuid), public.fulfillment_freeze_destination_contact_v2(uuid,jsonb,text), public.fulfillment_destination_line_snapshot_v2(jsonb) FROM authenticated;';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
  EXECUTE 'REVOKE ALL ON FUNCTION public.fulfillment_destination_contact_v2(uuid,uuid), public.fulfillment_freeze_destination_contact_v2(uuid,jsonb,text), public.fulfillment_destination_line_snapshot_v2(jsonb) FROM service_role;';
END IF; END; $$;

CREATE OR REPLACE FUNCTION public.fulfillment_capture_parcel_contact(p_shipment_id uuid,p_contact jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE prior public.fulfillment_parcel_contacts; owner_id uuid; order_ref uuid; value jsonb:='{}'; k text; delivery jsonb; point jsonb; address jsonb;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('native-dispatch|'||p_shipment_id::text,0));
 SELECT o.client_id,o.id INTO owner_id,order_ref FROM public.fulfillment_shipments s JOIN public.commerce_orders o ON o.id=s.order_id WHERE s.id=p_shipment_id FOR UPDATE OF s;
 IF EXISTS(SELECT 1 FROM public.commerce_destination_v2_order_bindings WHERE order_id=order_ref) THEN
  RETURN public.fulfillment_freeze_destination_contact_v2(p_shipment_id,p_contact,'capture');
 END IF;
 IF NOT FOUND OR owner_id IS NULL OR jsonb_typeof(p_contact) IS DISTINCT FROM 'object' THEN
  RAISE EXCEPTION 'fulfillment_parcel_contact_invalid' USING ERRCODE='22023'; END IF;
 IF p_contact->'schemaVersion'='2'::jsonb THEN
  RAISE EXCEPTION 'destination_dialect_invalid' USING ERRCODE='22023', DETAIL='shipmentId', HINT='Use the supported entry.';
 END IF;
 -- Subject lock precedes the receipt check; erasure cannot race a fresh insert.
 PERFORM id FROM public.clients WHERE id=owner_id FOR KEY SHARE;
 IF EXISTS(SELECT 1 FROM public.identity_privacy_erasures WHERE client_id=owner_id) THEN RETURN jsonb_build_object('erased',true); END IF;
 -- Explicit allowlist; neither commands, credentials nor arbitrary host fields persist.
 FOREACH k IN ARRAY ARRAY['schemaVersion','source','revision','recipientName','contactEmail','contactPhone','line1','line2','city','postalCode','country','deliveryInstructions','courierInstructions'] LOOP
  value:=value||jsonb_build_object(k,p_contact->k);
 END LOOP;
 IF jsonb_typeof(p_contact->'selectedDelivery')='object' THEN
  delivery:='{}';
  FOREACH k IN ARRAY ARRAY['providerKind','providerRef','carrierKind','carrierCode','serviceCode','service','deliveryKind','kind'] LOOP
   IF p_contact->'selectedDelivery' ? k THEN delivery:=delivery||jsonb_build_object(k,p_contact#>ARRAY['selectedDelivery',k]); END IF;
  END LOOP;
  IF jsonb_typeof(p_contact#>'{selectedDelivery,pickupPoint}')='object' THEN
   point:='{}'; address:='{}';
   FOREACH k IN ARRAY ARRAY['id','pointId','provider','name'] LOOP
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
  RETURN jsonb_build_object('replayed',true,'contact',prior.contact);
 ELSE INSERT INTO public.fulfillment_parcel_contacts(shipment_id,client_id,contact) VALUES(p_shipment_id,owner_id,value);
 END IF;
 RETURN jsonb_build_object('replayed',false,'contact',value);
END; $$;

CREATE OR REPLACE FUNCTION public.fulfillment_capture_new_parcel_reservations(p_shipment_id uuid,p_creation_key text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE parcel public.fulfillment_shipments; item record; line_id uuid; destination_v2 boolean;
BEGIN
 SELECT * INTO parcel FROM public.fulfillment_shipments WHERE id=p_shipment_id FOR UPDATE;
 -- Only the canonical opener's new audit in this transaction may freeze an original.
 -- A historical parcel must never acquire an association from today's order stock.
 IF NOT FOUND OR parcel.sequence_no<>0 OR NOT EXISTS(
  SELECT 1 FROM public.fulfillment_shipment_operations op WHERE op.shipment_id=parcel.id
   AND op.operation_type='shipment_created' AND op.idempotency_key=p_creation_key||':operation'
   AND op.xmin::text=mod(pg_current_xact_id()::text::numeric,4294967296)::text) THEN
  RAISE EXCEPTION 'fulfillment_parcel_reservation_capture_not_new' USING ERRCODE='22023'; END IF;
 INSERT INTO public.fulfillment_parcel_reservation_sets(shipment_id,order_id) VALUES(parcel.id,parcel.order_id)
 ON CONFLICT DO NOTHING;
 IF NOT FOUND THEN RETURN jsonb_build_object('replayed',true); END IF;
 SELECT EXISTS(SELECT 1 FROM public.commerce_destination_v2_order_bindings WHERE order_id=parcel.order_id) INTO destination_v2;
 FOR item IN SELECT oi.*,cs.sku,cs.title,o.renewal_operation_id,o.renewal_operation_fingerprint,
  coalesce(o.metadata#>ARRAY['orderDraftSnapshot','lines',(coalesce(oi.source_line_ordinal,oi.line_ordinal)-1)::text],'{}') snapshot
  FROM public.commerce_order_items oi JOIN public.commerce_orders o ON o.id=oi.order_id
  LEFT JOIN public.catalog_skus cs ON cs.id=oi.sku_id WHERE oi.order_id=parcel.order_id ORDER BY oi.id LOOP
  INSERT INTO public.fulfillment_parcel_lines(shipment_id,order_item_id,sku_id,sku,quantity,title,product_snapshot)
   VALUES(parcel.id,item.id,item.sku_id,item.sku,item.quantity,item.title,
    CASE WHEN destination_v2 THEN public.fulfillment_destination_line_snapshot_v2(item.snapshot) ELSE item.snapshot END) RETURNING id INTO line_id;
  INSERT INTO public.fulfillment_parcel_line_reservations(line_id,reservation_id,quantity)
  SELECT DISTINCT line_id,r.id,item.quantity FROM public.fulfillment_inventory_reservations r
   JOIN public.fulfillment_purchase_reservation_receipts receipt ON receipt.command->>'orderId'=parcel.order_id::text
   CROSS JOIN LATERAL jsonb_array_elements(coalesce(receipt.result->'reservations','[]')) entry
   WHERE receipt.command->>'action'='reserve' AND (entry->>'orderItemId')::uuid=item.id
    AND (entry->>'reservationId')::uuid=r.id AND r.purchase_order_id=parcel.order_id
    AND r.status IN ('held','committed')
  ON CONFLICT DO NOTHING;
  INSERT INTO public.fulfillment_parcel_line_reservations(line_id,reservation_id,quantity)
  SELECT line_id,r.id,item.quantity FROM public.fulfillment_inventory_reservations r
   JOIN public.fulfillment_inventory_reservation_lines rl ON rl.reservation_id=r.id AND rl.sku=item.sku
   WHERE r.renewal_operation_id=item.renewal_operation_id
    AND r.operation_fingerprint=item.renewal_operation_fingerprint AND r.status IN ('held','committed')
  ON CONFLICT DO NOTHING;
 END LOOP;
 RETURN jsonb_build_object('replayed',false);
END;
$$;

CREATE OR REPLACE FUNCTION public.fulfillment_capture_order_contact_for_shipment(p_shipment_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE purchase public.commerce_orders; override_contact public.fulfillment_order_contacts; contact jsonb; result jsonb;
BEGIN
 SELECT o.* INTO purchase FROM public.commerce_orders o JOIN public.fulfillment_shipments s ON s.order_id=o.id WHERE s.id=p_shipment_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'fulfillment_parcel_contact_missing' USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM public.commerce_destination_v2_order_bindings WHERE order_id=purchase.id) THEN
  RETURN public.fulfillment_freeze_destination_contact_v2(p_shipment_id,NULL,'open');
 END IF;
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

CREATE OR REPLACE FUNCTION public.fulfillment_open_shipment(
  p_idempotency_key text,
  p_order_id uuid,
  p_port_key text,
  p_metadata jsonb,
  p_requested_at timestamptz
)
RETURNS public.fulfillment_shipments
LANGUAGE plpgsql
SET search_path = public, pg_catalog, pg_temp
AS $$
DECLARE
  v_port public.fulfillment_ports%ROWTYPE;
  v_shipment public.fulfillment_shipments%ROWTYPE;
  v_capture jsonb;
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
          '{}'::jsonb, p_requested_at, p_requested_at)
  RETURNING * INTO v_shipment;

  INSERT INTO public.fulfillment_shipment_operations
    (shipment_id, order_id, operation_type, idempotency_key, payload, occurred_at)
  VALUES (v_shipment.id, p_order_id, 'shipment_created', p_idempotency_key || ':operation',
          jsonb_build_object('portKey', v_port.port_key, 'providerType', v_port.provider_type),
          p_requested_at);

  PERFORM public.fulfillment_capture_new_parcel_reservations(v_shipment.id,p_idempotency_key);
  v_capture := public.fulfillment_capture_order_contact_for_shipment(v_shipment.id);
  -- Delay caller metadata until the contact owner has resolved the dialect.
  IF v_capture#>'{contact,schemaVersion}'='2'::jsonb THEN
    IF p_metadata IS DISTINCT FROM '{}'::jsonb THEN
      RAISE EXCEPTION 'address_invalid_input' USING ERRCODE='22023', DETAIL='metadata', HINT='Correct the indicated input.';
    END IF;
  ELSIF coalesce(p_metadata,'{}'::jsonb)<>'{}'::jsonb THEN
    UPDATE public.fulfillment_shipments SET metadata=p_metadata WHERE id=v_shipment.id RETURNING * INTO v_shipment;
  END IF;
  RETURN v_shipment;
END;
$$;

CREATE OR REPLACE FUNCTION public.fulfillment_operator_create_order(p_key text,p_order_id uuid,p_port_key text,p_actor_id uuid,p_metadata jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE purchase public.commerce_orders; parcel public.fulfillment_shipments; destination jsonb; address jsonb; customer public.clients;
 contact jsonb; resolution jsonb; mode text; created jsonb; destination_v2 boolean;
BEGIN
 IF p_key IS NULL OR length(btrim(p_key))<8 OR p_order_id IS NULL THEN
  RAISE EXCEPTION 'commerce_fulfillment_invalid_input' USING ERRCODE='22023'; END IF;
 -- Replay remains first-write: return the recorded parcel and its current status.
 SELECT s.* INTO parcel FROM public.fulfillment_shipments s WHERE s.create_idempotency_key=p_key AND EXISTS(
  SELECT 1 FROM public.commerce_destination_v2_order_bindings WHERE order_id IN (p_order_id,s.order_id)
 );
 IF NOT FOUND THEN
  SELECT * INTO parcel FROM public.fulfillment_shipments WHERE create_idempotency_key=p_key OR (order_id=p_order_id AND sequence_no=0) LIMIT 1;
 END IF;
 IF FOUND THEN
  IF parcel.order_id<>p_order_id AND EXISTS(
   SELECT 1 FROM public.commerce_destination_v2_order_bindings WHERE order_id IN (p_order_id,parcel.order_id)
  ) THEN
   RAISE EXCEPTION 'commerce_fulfillment_destination_replay_conflict' USING ERRCODE='23505', DETAIL='orderId';
  END IF;
  RETURN jsonb_build_object('contractVersion','commerce.fulfillment.v0','fulfillmentOrderId',parcel.id,'orderId',parcel.order_id,'status',parcel.status,'replayed',true);
 END IF;
 SELECT * INTO purchase FROM public.commerce_orders WHERE id=p_order_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'commerce_fulfillment_order_not_found' USING ERRCODE='22023'; END IF;
 -- A concurrent creator may have committed while this call waited for the order.
 SELECT * INTO parcel FROM public.fulfillment_shipments WHERE order_id=p_order_id AND sequence_no=0;
 IF FOUND THEN RETURN jsonb_build_object('contractVersion','commerce.fulfillment.v0','fulfillmentOrderId',parcel.id,'orderId',parcel.order_id,'status',parcel.status,'replayed',true); END IF;
 IF purchase.status NOT IN ('paid','fulfillment_pending') THEN RAISE EXCEPTION 'commerce_fulfillment_order_not_fulfillable' USING ERRCODE='22023'; END IF;
 IF purchase.client_id IS NULL THEN RAISE EXCEPTION 'commerce_fulfillment_missing_client' USING ERRCODE='22023'; END IF;
 mode:=purchase.metadata#>>'{orderDraftSnapshot,context,mode}';
 IF NOT public.fulfillment_order_mode_proven(mode) THEN RAISE EXCEPTION 'commerce_fulfillment_order_mode_unproven' USING ERRCODE='22023'; END IF;
 SELECT EXISTS(SELECT 1 FROM public.commerce_destination_v2_order_bindings WHERE order_id=purchase.id) INTO destination_v2;
 IF destination_v2 THEN
  IF p_metadata IS DISTINCT FROM '{}'::jsonb THEN
   RAISE EXCEPTION 'address_invalid_input' USING ERRCODE='22023', DETAIL='metadata', HINT='Correct the indicated input.';
  END IF;
  IF p_actor_id IS NULL THEN
   RAISE EXCEPTION 'address_invalid_input' USING ERRCODE='22023', DETAIL='actorId', HINT='Correct the indicated input.';
  END IF;
 ELSE
 destination:=public.commerce_read_destination('order',purchase.id); address:=destination->'address';
 SELECT * INTO customer FROM public.clients WHERE id=purchase.client_id;
 IF NOT EXISTS(SELECT 1 FROM public.fulfillment_order_contacts WHERE order_id=purchase.id)
  AND NOT (purchase.metadata ? 'deliveryContactOverride') AND NOT (coalesce(purchase.metadata->'runtimeFinalize','{}') ? 'deliveryContact')
  AND purchase.metadata ? 'channelOrderSnapshot' AND jsonb_typeof(purchase.metadata->'channelOrderSnapshot') IS DISTINCT FROM 'object' THEN
  RAISE EXCEPTION 'commerce_fulfillment_delivery_contact_invalid' USING ERRCODE='22023'; END IF;
 -- Use the same effective authority as reads, including a pre-parcel correction.
 BEGIN
  contact:=(public.commerce_oms_resolve_delivery_contact_v1(purchase.id))->'contact';
 EXCEPTION WHEN invalid_parameter_value THEN
  IF SQLERRM='fulfillment_contact_not_recorded' THEN
   RAISE EXCEPTION 'commerce_fulfillment_delivery_contact_invalid' USING ERRCODE='22023'; END IF;
  RAISE;
 END;
 resolution:=public.fulfillment_delivery_contact_resolve(jsonb_build_object('frozenContactPresent',true,'frozenContact',contact));
 IF NOT coalesce((resolution->>'destinationComplete')::boolean,false) THEN RAISE EXCEPTION 'commerce_fulfillment_delivery_contact_invalid' USING ERRCODE='22023'; END IF;
 contact:=resolution->'contact';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.commerce_settlement_intents WHERE order_id=purchase.id AND status='settled') THEN
  RAISE EXCEPTION 'commerce_fulfillment_payment_not_succeeded' USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM public.commerce_order_holds WHERE order_id=purchase.id AND status='active') THEN RAISE EXCEPTION 'commerce_fulfillment_active_hold' USING ERRCODE='22023'; END IF;
 IF mode='subscription_cycle' AND NOT EXISTS(SELECT 1 FROM public.subscription_cycles WHERE id=purchase.subscription_cycle_id AND status='paid') THEN
  RAISE EXCEPTION 'commerce_fulfillment_subscription_cycle_not_paid' USING ERRCODE='22023'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.commerce_order_items WHERE order_id=purchase.id) THEN RAISE EXCEPTION 'commerce_fulfillment_missing_order_items' USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM public.commerce_order_items oi LEFT JOIN public.catalog_skus cs ON cs.id=oi.sku_id WHERE oi.order_id=purchase.id AND cs.id IS NULL) THEN
  RAISE EXCEPTION 'commerce_fulfillment_missing_catalog_sku' USING ERRCODE='22023'; END IF;
 IF destination_v2 THEN
  created:=public.fulfillment_create_shipment(p_key,purchase.id,p_port_key,'{}'::jsonb,now());
 ELSE
  created:=public.fulfillment_create_shipment(p_key,purchase.id,p_port_key,coalesce(p_metadata,'{}')||jsonb_build_object('actorId',p_actor_id),now());
 END IF;
 SELECT * INTO parcel FROM public.fulfillment_shipments WHERE id=(created#>>'{shipment,id}')::uuid;
 IF destination_v2 AND (created->>'replayed')::boolean THEN
  RETURN jsonb_build_object('contractVersion','commerce.fulfillment.v0','fulfillmentOrderId',parcel.id,'orderId',parcel.order_id,'status',parcel.status,'replayed',true);
 END IF;
 -- The canonical opener captures only the new parcel's recorded reservation generation.
 IF NOT public.fulfillment_parcel_reservations_covered(parcel.id) THEN
  RAISE EXCEPTION 'commerce_fulfillment_missing_inventory_reservation' USING ERRCODE='22023'; END IF;
 IF destination_v2 THEN
  UPDATE public.fulfillment_shipments SET metadata=jsonb_build_object('actorId',p_actor_id) WHERE id=parcel.id;
 ELSE
  PERFORM public.commerce_read_destination('shipment',parcel.id);
  PERFORM public.fulfillment_capture_parcel_contact(parcel.id,contact);
 END IF;
 RETURN jsonb_build_object('contractVersion','commerce.fulfillment.v0','fulfillmentOrderId',parcel.id,'orderId',parcel.order_id,'status',parcel.status,'replayed',false);
END; $$;

CREATE OR REPLACE FUNCTION public.fulfillment_resolve_parcel_contact(p_shipment_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE prior public.fulfillment_parcel_contacts; parcel public.fulfillment_shipments; purchase public.commerce_orders;
 customer public.clients; destination jsonb; address jsonb; result jsonb; present boolean;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('native-dispatch|'||p_shipment_id::text,0));
 SELECT * INTO parcel FROM public.fulfillment_shipments WHERE id=p_shipment_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'fulfillment_parcel_contact_missing' USING ERRCODE='22023'; END IF;
 SELECT * INTO purchase FROM public.commerce_orders WHERE id=parcel.order_id;
 IF EXISTS(SELECT 1 FROM public.commerce_destination_v2_order_bindings WHERE order_id=parcel.order_id) THEN
  RETURN public.fulfillment_freeze_destination_contact_v2(parcel.id,NULL,'resolve')->'contact';
 END IF;
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
