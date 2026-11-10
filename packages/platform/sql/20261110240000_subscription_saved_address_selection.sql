CREATE TABLE public.customer_payment_preferences (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
 scope text NOT NULL CHECK (scope IN ('one_time','subscription','any')), method_kind text NOT NULL CHECK (method_kind IN ('instant','card','transfer')),
 last_selected_at timestamptz NOT NULL DEFAULT now(), source text NOT NULL DEFAULT 'hidden_customer_preferences',
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(client_id,scope)
);

CREATE INDEX customer_payment_preferences_client_recent ON public.customer_payment_preferences(client_id,last_selected_at DESC);

CREATE TABLE public.customer_delivery_preferences (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
 scope text NOT NULL CHECK (scope IN ('one_time','subscription','any')), delivery_kind text NOT NULL CHECK (delivery_kind IN ('courier','parcel-locker')),
 provider_kind text NOT NULL CHECK (provider_kind IN ('warehouse','carrier','manual','simulator')),
 provider_ref text NOT NULL, carrier_kind text NOT NULL, carrier_code text NOT NULL, service_code text NOT NULL,
 pickup_point_id text, pickup_point_name text, pickup_point_address jsonb,
 CONSTRAINT customer_delivery_preferences_pickup_check CHECK (delivery_kind IN ('courier') OR pickup_point_id IS NOT NULL),
 last_selected_at timestamptz NOT NULL DEFAULT now(), source text NOT NULL DEFAULT 'customer_account',
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(client_id,scope)
);

CREATE INDEX customer_delivery_preferences_client_recent ON public.customer_delivery_preferences(client_id,last_selected_at DESC);

CREATE OR REPLACE FUNCTION public.commerce_read_destination(p_scope text,p_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE d public.commerce_destinations; o public.commerce_orders; s public.subscriptions;
 v_id uuid; v_client uuid; v_order uuid; v_count integer; a public.subscription_activations;
 op public.subscription_renewal_operations; v_ref text; saved public.customer_saved_addresses;
BEGIN
 IF p_scope IS NULL OR p_scope NOT IN ('order','subscription','shipment') OR p_id IS NULL THEN
  RAISE EXCEPTION 'commerce_destination_invalid_scope' USING ERRCODE='22023'; END IF;
 IF p_scope='shipment' THEN
  PERFORM pg_advisory_xact_lock(hashtextextended('native-dispatch|'||p_id::text,0));
  SELECT order_id INTO v_order FROM public.fulfillment_shipments WHERE id=p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'commerce_destination_parent_missing' USING ERRCODE='22023'; END IF;
  SELECT client_id INTO v_client FROM public.commerce_orders WHERE id=v_order;
  SELECT destination_id INTO v_id FROM public.commerce_destination_bindings WHERE shipment_id=p_id;
  IF v_id IS NULL THEN
   v_id:=(public.commerce_read_destination('order',v_order)->>'destinationId')::uuid;
   INSERT INTO public.commerce_destination_bindings(shipment_id,destination_id) VALUES(p_id,v_id);
  END IF;
 ELSIF p_scope='subscription' THEN
  SELECT * INTO s FROM public.subscriptions WHERE id=p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'commerce_destination_parent_missing' USING ERRCODE='22023'; END IF;
  v_client:=s.client_id;
  IF s.shipping_saved_address_id IS NOT NULL THEN
   SELECT * INTO saved FROM public.customer_saved_addresses WHERE id=s.shipping_saved_address_id AND client_id=s.client_id;
   IF NOT FOUND THEN RAISE EXCEPTION 'commerce_destination_owner_mismatch' USING ERRCODE='22023'; END IF;
   -- A claim freezes a new immutable document; canonical bytes are never saved-row identity.
   INSERT INTO public.commerce_destinations(client_id,address)
   VALUES(s.client_id,jsonb_build_object('savedAddressId',saved.id,'recipientName',saved.recipient_name,
    'line1',saved.line1,'line2',saved.line2,'city',saved.city,'postalCode',saved.postal_code,'country',saved.country,
    'contactPhone',saved.contact_phone,'label',saved.label,'companyName',saved.company_name,'taxId',saved.tax_id,
    'deliveryNotes',saved.delivery_notes,'courierInstructions',saved.courier_instructions)) RETURNING * INTO d;
   RETURN jsonb_build_object('destinationId',d.id,'revision',d.revision,'clientId',d.client_id,'address',d.address);
  END IF;
  SELECT destination_id INTO v_id FROM public.commerce_destination_bindings WHERE subscription_id=p_id;
  IF v_id IS NULL THEN
   SELECT count(*) INTO v_count FROM public.subscription_activations WHERE subscription_id=p_id AND state='active';
   IF v_count>1 THEN RAISE EXCEPTION 'commerce_destination_origin_ambiguous' USING ERRCODE='23505'; END IF;
   IF v_count=1 THEN
    SELECT * INTO a FROM public.subscription_activations WHERE subscription_id=p_id AND state='active';
    SELECT * INTO o FROM public.commerce_orders WHERE id=a.order_id;
    IF a.client_id IS DISTINCT FROM v_client OR o.client_id IS DISTINCT FROM v_client THEN
     RAISE EXCEPTION 'commerce_destination_owner_mismatch' USING ERRCODE='22023'; END IF;
    SELECT id INTO v_id FROM public.commerce_destinations WHERE purchase_order_id=a.order_id;
   END IF;
  END IF;
 ELSE
  SELECT * INTO o FROM public.commerce_orders WHERE id=p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'commerce_destination_parent_missing' USING ERRCODE='22023'; END IF;
  v_client:=o.client_id;
  SELECT destination_id INTO v_id FROM public.commerce_destination_bindings WHERE order_id=p_id;
  IF v_id IS NULL AND o.renewal_operation_id IS NOT NULL THEN
   SELECT * INTO op FROM public.subscription_renewal_operations WHERE id=o.renewal_operation_id;
   IF NOT FOUND OR op.operation_fingerprint IS DISTINCT FROM o.renewal_operation_fingerprint
    OR NOT EXISTS(SELECT 1 FROM public.subscriptions WHERE id=op.subscription_id AND client_id=v_client)
    OR NOT EXISTS(SELECT 1 FROM public.subscription_cycles WHERE id=o.subscription_cycle_id
      AND subscription_id=op.subscription_id AND renewal_operation_id=op.id
      AND renewal_operation_fingerprint=op.operation_fingerprint) THEN
    RAISE EXCEPTION 'commerce_destination_owner_mismatch' USING ERRCODE='22023'; END IF;
   v_ref:=op.cycle_snapshot#>>'{orderSnapshot,shippingAddressRef}';
   BEGIN v_id:=v_ref::uuid;
   EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'commerce_destination_frozen_ref_invalid' USING ERRCODE='22023'; END;
  ELSIF v_id IS NULL THEN
   SELECT id INTO v_id FROM public.commerce_destinations WHERE purchase_order_id=p_id;
  END IF;
 END IF;
 IF v_id IS NULL THEN RAISE EXCEPTION 'commerce_destination_unavailable' USING ERRCODE='22023'; END IF;
 SELECT * INTO d FROM public.commerce_destinations WHERE id=v_id;
 IF NOT FOUND OR d.client_id IS DISTINCT FROM v_client THEN
  RAISE EXCEPTION 'commerce_destination_owner_mismatch' USING ERRCODE='22023'; END IF;
 RETURN jsonb_build_object('destinationId',d.id,'revision',d.revision,'clientId',d.client_id,'address',d.address);
END; $$;

CREATE OR REPLACE FUNCTION public.subscription_change_shipping_destination(
 p_actor_id uuid,p_client_id uuid,p_key text,p_subscription_id uuid,p_payload jsonb,p_expected_version integer,p_now timestamptz DEFAULT now())
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE s public.subscriptions; r public.subscription_command_receipts; sh public.fulfillment_shipments;
 doc jsonb:='{}'; input jsonb; fp text; k text; value text; v_id uuid; event_id uuid;
 v_old uuid; v_operator boolean; answer jsonb; reason text; parcel_reason text; moved boolean:=false;
BEGIN
 IF p_actor_id IS NULL OR p_client_id IS NULL OR p_subscription_id IS NULL OR p_key IS NULL
  OR p_key<>btrim(p_key) OR length(p_key) NOT BETWEEN 8 AND 180 OR p_expected_version IS NULL OR p_expected_version<1
  OR p_now IS NULL OR NOT isfinite(p_now) OR jsonb_typeof(p_payload) IS DISTINCT FROM 'object' THEN
  RAISE EXCEPTION 'subscription_command_invalid_input' USING ERRCODE='22023'; END IF;
 v_operator:=p_payload->>'actorKind'='operator';
 IF coalesce(v_operator,false) THEN
  PERFORM public.communications_require_active_operator(p_actor_id);
  IF EXISTS(SELECT 1 FROM public.platform_control_operators WHERE principal_id=p_actor_id)
   OR NOT public.platform_human_membership_is_administrator(p_actor_id) THEN
   RAISE EXCEPTION 'customer_support_command_requires_human' USING ERRCODE='42501'; END IF;
 ELSIF NOT EXISTS(SELECT 1 FROM public.clients WHERE id=p_client_id AND principal_id=p_actor_id) THEN
  RAISE EXCEPTION 'subscription_command_forbidden' USING ERRCODE='42501';
 END IF;
 input:=jsonb_build_object('clientId',p_client_id,'subscriptionId',p_subscription_id,
  'action','change_shipping_address','payload',p_payload,'expectedVersion',p_expected_version);
 fp:=encode(sha256(convert_to(input::text,'UTF8')),'hex');
 PERFORM pg_advisory_xact_lock(hashtextextended(p_actor_id::text||':'||p_key,0));
 SELECT * INTO s FROM public.subscriptions WHERE id=p_subscription_id AND client_id=p_client_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'subscription_command_forbidden' USING ERRCODE='42501'; END IF;
 SELECT * INTO r FROM public.subscription_command_receipts WHERE actor_id=p_actor_id AND idempotency_key=p_key FOR UPDATE;
 IF FOUND THEN
  IF r.command_fingerprint<>fp THEN RAISE EXCEPTION 'subscription_command_idempotency_conflict' USING ERRCODE='23505'; END IF;
  IF r.status='refused' THEN RETURN r.result; END IF;
  RETURN r.result||jsonb_build_object('replayed',true);
 END IF;
 BEGIN
  IF s.template_version<>p_expected_version THEN reason:='version_conflict';
  ELSIF s.status NOT IN ('active','paused') THEN reason:='invalid_transition';
  ELSIF p_payload-ARRAY['newAddress','reason','actorKind']<>'{}'::jsonb
   OR coalesce(p_payload->>'actorKind','customer') NOT IN ('customer','operator')
   OR jsonb_typeof(p_payload->'newAddress') IS DISTINCT FROM 'object'
   OR (p_payload->'newAddress')-ARRAY['recipientName','line1','line2','city','postalCode','country','contactPhone']<>'{}'::jsonb THEN reason:='invalid_address'; END IF;
  IF reason IS NOT NULL THEN RAISE EXCEPTION '%',reason USING ERRCODE='P0001'; END IF;
  FOREACH k IN ARRAY ARRAY['recipientName','line1','line2','city','postalCode','country','contactPhone','label','companyName','taxId','deliveryNotes','courierInstructions'] LOOP
   value:=btrim(p_payload->'newAddress'->>k);
   IF k IN ('recipientName','line1','city','postalCode','country') OR p_payload->'newAddress' ? k THEN
    IF jsonb_typeof(p_payload->'newAddress'->k) IS DISTINCT FROM 'string' OR length(value) NOT BETWEEN
     (CASE WHEN k='country' THEN 2 ELSE 1 END) AND (CASE WHEN k='country' THEN 3 WHEN k='postalCode' THEN 32 WHEN k='contactPhone' THEN 64 ELSE 200 END) THEN
     RAISE EXCEPTION 'invalid_address' USING ERRCODE='P0001'; END IF;
   END IF;
   doc:=doc||jsonb_build_object(k,CASE WHEN k='country' THEN upper(value) ELSE value END);
  END LOOP;
  -- Address, unlike other commands, is allowed during dunning without a method.
  -- A claimed native snapshot owns the next cycle before its cycle row exists.
  IF EXISTS(SELECT 1 FROM public.subscription_renewal_operations WHERE subscription_id=s.id
   AND scheduled_at=s.next_cycle_at AND state IN ('claimed','reserved','attempt_prepared')) THEN
   RAISE EXCEPTION 'payment_blocked' USING ERRCODE='P0001'; END IF;
  BEGIN PERFORM public.subscription_lifecycle_assert_unlocked_cycle(s.id,s.next_cycle_at);
  EXCEPTION WHEN invalid_parameter_value THEN
   IF SQLERRM<>'subscription_lifecycle_payment_blocked' THEN RAISE; END IF;
   RAISE EXCEPTION 'payment_blocked' USING ERRCODE='P0001'; END;
  INSERT INTO public.commerce_destinations(client_id,address,created_at) VALUES(s.client_id,doc,p_now) RETURNING id INTO v_id;
  INSERT INTO public.commerce_destination_bindings(subscription_id,destination_id,updated_at) VALUES(s.id,v_id,p_now)
   ON CONFLICT(subscription_id) DO UPDATE SET destination_id=EXCLUDED.destination_id,updated_at=EXCLUDED.updated_at;
  UPDATE public.subscriptions SET shipping_saved_address_id=NULL,updated_at=p_now WHERE id=s.id;
  SELECT parcel.* INTO sh FROM public.fulfillment_shipments parcel
   JOIN public.commerce_orders o ON o.id=parcel.order_id JOIN public.subscription_cycles c ON c.id=o.subscription_cycle_id
   WHERE c.subscription_id=s.id AND o.client_id=s.client_id ORDER BY o.created_at DESC,parcel.sequence_no DESC,parcel.id DESC LIMIT 1;
  parcel_reason:=CASE WHEN sh.id IS NULL THEN 'no_current_parcel' WHEN NOT coalesce(v_operator,false) THEN 'customer_future_only' ELSE NULL END;
  IF sh.id IS NOT NULL THEN
   PERFORM pg_advisory_xact_lock(hashtextextended('native-dispatch|'||sh.id::text,0));
   SELECT * INTO sh FROM public.fulfillment_shipments WHERE id=sh.id FOR UPDATE;
   BEGIN v_old:=(public.commerce_read_destination('shipment',sh.id)->>'destinationId')::uuid;
   EXCEPTION WHEN invalid_parameter_value THEN
    IF SQLERRM<>'commerce_destination_unavailable' THEN RAISE; END IF;
   END;
   IF parcel_reason IS NULL THEN
    IF EXISTS(SELECT 1 FROM public.fulfillment_dispatch_refs WHERE shipment_id=sh.id)
     OR EXISTS(SELECT 1 FROM public.commerce_fulfillment_provider_commands WHERE shipment_id=sh.id)
     OR EXISTS(SELECT 1 FROM public.fulfillment_provider_attempts WHERE shipment_id=sh.id) THEN parcel_reason:='dispatch_owned';
    ELSIF sh.status NOT IN ('created','packed','label_pending') THEN parcel_reason:='status_ineligible';
    ELSE
     INSERT INTO public.commerce_destination_bindings(order_id,destination_id,updated_at) VALUES(sh.order_id,v_id,p_now)
      ON CONFLICT(order_id) DO UPDATE SET destination_id=EXCLUDED.destination_id,updated_at=EXCLUDED.updated_at;
     INSERT INTO public.commerce_destination_bindings(shipment_id,destination_id,updated_at) VALUES(sh.id,v_id,p_now)
      ON CONFLICT(shipment_id) DO UPDATE SET destination_id=EXCLUDED.destination_id,updated_at=EXCLUDED.updated_at;
     UPDATE public.fulfillment_dispatch_contexts SET contact_revision=jsonb_build_object('schemaVersion',1,'source','commerce-destination:'||v_id::text,'revision',1) WHERE shipment_id=sh.id;
     moved:=true;
    END IF;
   END IF;
  END IF;
  INSERT INTO public.subscription_events(subscription_id,event_type,idempotency_key,payload,occurred_at)
   VALUES(s.id,'subscription.customer_self_service.change_shipping_address','command:'||encode(sha256(convert_to(p_actor_id::text||':'||p_key,'UTF8')),'hex'),
    jsonb_build_object('action','change_shipping_address','payload',jsonb_build_object('shippingAddressId',v_id)
     ||CASE WHEN p_payload ? 'reason' THEN jsonb_build_object('reason',p_payload->'reason') ELSE '{}'::jsonb END,
     'reason',NULLIF(p_payload->>'reason',''),
     'actorKind',CASE WHEN coalesce(v_operator,false) THEN 'operator' ELSE 'customer' END,'actorId',p_actor_id,
     'outcome',CASE WHEN moved THEN 'applied' ELSE 'applied_from_next_parcel' END,
     'appliesFrom',CASE WHEN moved THEN 'current_parcel' ELSE 'next_parcel' END,'futureDestinationId',v_id,
     'priceAgreementPolicy',jsonb_build_object('kind','lock_until_edit','proration','none','cycleEffect','future_unlocked_cycles_only')),p_now) RETURNING id INTO event_id;
  INSERT INTO public.outbox_events(aggregate_type,aggregate_id,event_type,idempotency_key,payload,metadata)
   VALUES('subscription',s.id,'subscription.address_changed','subscription.address_changed:'||event_id::text,
    jsonb_build_object('clientId',s.client_id,'subscriptionId',s.id,'action','change_shipping_address','nextCycleAt',s.next_cycle_at,
     'occurredAt',p_now,'sourceEventId',event_id,'outcome',CASE WHEN moved THEN 'applied' ELSE 'applied_from_next_parcel' END,
     'appliesFrom',CASE WHEN moved THEN 'current_parcel' ELSE 'next_parcel' END,'futureDestinationId',v_id),
    jsonb_build_object('source','subscription_change_shipping_destination')) ON CONFLICT(event_type,idempotency_key) DO NOTHING;
  answer:=jsonb_build_object('outcome',CASE WHEN moved THEN 'applied' ELSE 'applied_from_next_parcel' END,
   'appliesFrom',CASE WHEN moved THEN 'current_parcel' ELSE 'next_parcel' END,'futureDestinationId',v_id,'replayed',false,
   'subscriptionStatus',s.status,'nextCycleAt',s.next_cycle_at,'templateVersion',s.template_version,'eventId',event_id,'appliedBy',CASE WHEN coalesce(v_operator,false) THEN 'customer_self_service_delegate' END,
   'currentParcel',jsonb_build_object('outcome',CASE WHEN moved THEN 'updated' ELSE 'skipped' END,'reason',parcel_reason,
    'orderId',sh.order_id,'shipmentId',sh.id,'destinationId',CASE WHEN moved THEN v_id ELSE v_old END));
 EXCEPTION WHEN raise_exception THEN
  IF SQLERRM NOT IN ('version_conflict','invalid_transition','invalid_address','payment_blocked') THEN RAISE; END IF;
  reason:=SQLERRM;
  answer:=jsonb_build_object('outcome',CASE WHEN reason='version_conflict' THEN 'conflict' ELSE 'refused' END,'refusalCode',reason,'replayed',false);
 END;
 INSERT INTO public.subscription_command_receipts(actor_id,idempotency_key,subscription_id,client_id,command_fingerprint,command,result,status,created_at)
 VALUES(p_actor_id,p_key,s.id,s.client_id,fp,input-'payload'||jsonb_build_object('payloadFingerprint',encode(sha256(convert_to(p_payload::text,'UTF8')),'hex')),
  answer,CASE WHEN answer->>'outcome' IN ('refused','conflict') THEN 'refused' ELSE 'applied' END,p_now);
 RETURN answer;
END; $$;

CREATE FUNCTION public.subscription_select_saved_shipping_address(p_actor_id uuid,p_client_id uuid,p_key text,p_subscription_id uuid,p_payload jsonb,p_now timestamptz DEFAULT now())
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE s public.subscriptions; prior public.subscription_events; address_id uuid; address_kind text; event_id uuid;
BEGIN
 IF p_key IS NULL OR char_length(btrim(p_key))<8 THEN
  RAISE EXCEPTION 'customer_self_service_invalid_idempotency_key' USING ERRCODE='P0001'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.clients WHERE id=p_client_id AND principal_id=p_actor_id) THEN
  RAISE EXCEPTION 'customer_self_service_not_found' USING ERRCODE='P0001'; END IF;
 SELECT * INTO s FROM public.subscriptions WHERE id=p_subscription_id AND client_id=p_client_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'customer_self_service_forbidden' USING ERRCODE='P0001'; END IF;
 SELECT * INTO prior FROM public.subscription_events WHERE subscription_id=s.id AND idempotency_key=p_key;
 IF FOUND THEN
  RETURN jsonb_build_object('status','replayed','subscriptionId',s.id,'shippingAddressId',s.shipping_saved_address_id,
   'subscriptionStatus',s.status,'nextCycleAt',s.next_cycle_at,'templateVersion',s.template_version,'eventId',prior.id);
 END IF;
 -- Like the reference wrapper, ownership of a nonempty ID precedes the locked-cycle guard.
 IF s.status IN ('active','paused') THEN
  address_id:=nullif(coalesce(p_payload,'{}')->>'shippingAddressId','')::uuid;
  IF address_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.customer_saved_addresses WHERE id=address_id AND client_id=p_client_id) THEN
   RAISE EXCEPTION 'customer_self_service_invalid_address' USING ERRCODE='P0001'; END IF;
 ELSE address_id:=nullif(coalesce(p_payload,'{}')->>'shippingAddressId','')::uuid;
 END IF;
 IF s.status NOT IN ('active','paused') OR address_id IS NULL THEN
  RAISE EXCEPTION 'customer_self_service_invalid_address' USING ERRCODE='P0001'; END IF;
 SELECT kind INTO address_kind FROM public.customer_saved_addresses WHERE id=address_id AND client_id=p_client_id;
 IF address_kind IS NULL OR address_kind NOT IN ('shipping','both') THEN
  RAISE EXCEPTION 'customer_self_service_invalid_address' USING ERRCODE='P0001'; END IF;
 IF EXISTS(SELECT 1 FROM public.subscription_renewal_operations WHERE subscription_id=s.id
  AND scheduled_at=s.next_cycle_at AND state IN ('claimed','reserved','attempt_prepared')) THEN
  RAISE EXCEPTION 'customer_self_service_payment_blocked' USING ERRCODE='P0001'; END IF;
 BEGIN PERFORM public.subscription_lifecycle_assert_unlocked_cycle(s.id,s.next_cycle_at);
 EXCEPTION WHEN invalid_parameter_value THEN
  IF SQLERRM<>'subscription_lifecycle_payment_blocked' THEN RAISE; END IF;
  RAISE EXCEPTION 'customer_self_service_payment_blocked' USING ERRCODE='P0001'; END;
 UPDATE public.subscriptions SET shipping_saved_address_id=address_id,updated_at=p_now WHERE id=s.id;
 INSERT INTO public.subscription_events(subscription_id,event_type,idempotency_key,payload,occurred_at)
 VALUES(s.id,'subscription.customer_self_service.change_shipping_address',p_key,
  jsonb_build_object('action','change_shipping_address','payload',coalesce(p_payload,'{}')-'repricedLines'-'recipeLines'-'addonLines'-'expectedTemplateVersion'-'acceptedQuoteHash',
   'quotePreviewId',NULL,'reason',nullif(p_payload->>'reason',''),
   'priceAgreementPolicy',jsonb_build_object('kind','lock_until_edit','proration','none','cycleEffect','future_unlocked_cycles_only')),p_now)
 RETURNING id INTO event_id;
 PERFORM public.customer_account_event_append(p_actor_id,p_client_id,'subscription.address_changed','subscription',s.id,
  jsonb_build_object('action','change_shipping_address','sourceEventId',event_id),p_now);
 INSERT INTO public.outbox_events(aggregate_type,aggregate_id,event_type,idempotency_key,payload,metadata)
 VALUES('subscription',s.id,'subscription.address_changed','subscription.address_changed:'||event_id::text,
  jsonb_build_object('clientId',s.client_id,'subscriptionId',s.id,'action','change_shipping_address','nextCycleAt',s.next_cycle_at,'occurredAt',p_now),
  jsonb_build_object('source','subscription_select_saved_shipping_address')) ON CONFLICT(event_type,idempotency_key) DO NOTHING;
 RETURN jsonb_build_object('status','applied','subscriptionId',s.id,'shippingAddressId',address_id,
  'subscriptionStatus',s.status,'nextCycleAt',s.next_cycle_at,'templateVersion',s.template_version,'eventId',event_id);
END; $$;

CREATE FUNCTION public.customer_preferences_read(p_actor uuid,p_client uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.clients WHERE id=p_client AND principal_id=p_actor) THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('payment',coalesce((SELECT jsonb_agg(to_jsonb(p) ORDER BY last_selected_at DESC) FROM public.customer_payment_preferences p WHERE client_id=p_client),'[]'),
 'delivery',coalesce((SELECT jsonb_agg(to_jsonb(p) ORDER BY last_selected_at DESC) FROM public.customer_delivery_preferences p WHERE client_id=p_client),'[]'));
END; $$;

CREATE FUNCTION public.customer_preference_save(p_actor uuid,p_client uuid,p_kind text,p_data jsonb,p_now timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE answer jsonb;
BEGIN
 IF p_kind='payment' THEN LOCK TABLE public.customer_payment_preferences IN ROW EXCLUSIVE MODE;
 ELSIF p_kind='delivery' THEN LOCK TABLE public.customer_delivery_preferences IN ROW EXCLUSIVE MODE;
 ELSE RAISE EXCEPTION 'customer_preference_invalid_kind' USING ERRCODE='22023'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.clients WHERE id=p_client AND principal_id=p_actor) THEN RETURN NULL; END IF;
 IF p_kind='payment' THEN
  INSERT INTO public.customer_payment_preferences(client_id,scope,method_kind,last_selected_at,updated_at)
  VALUES(p_client,p_data->>'scope',p_data->>'methodKind',p_now,p_now)
  ON CONFLICT(client_id,scope) DO UPDATE SET method_kind=EXCLUDED.method_kind,last_selected_at=p_now,updated_at=p_now
  RETURNING to_jsonb(customer_payment_preferences.*) INTO answer;
 ELSE
  INSERT INTO public.customer_delivery_preferences(client_id,scope,delivery_kind,provider_kind,provider_ref,carrier_kind,carrier_code,service_code,pickup_point_id,pickup_point_name,pickup_point_address,last_selected_at,updated_at)
  VALUES(p_client,p_data->>'scope',p_data->>'deliveryKind',p_data->>'providerFamily',p_data->>'providerKind',p_data->>'carrierKind',p_data->>'carrierCode',p_data->>'serviceCode',p_data#>>'{pickupPoint,id}',p_data#>>'{pickupPoint,name}',nullif(p_data#>'{pickupPoint,address}','null'::jsonb),p_now,p_now)
  ON CONFLICT(client_id,scope) DO UPDATE SET delivery_kind=EXCLUDED.delivery_kind,provider_kind=EXCLUDED.provider_kind,provider_ref=EXCLUDED.provider_ref,
   carrier_kind=EXCLUDED.carrier_kind,carrier_code=EXCLUDED.carrier_code,service_code=EXCLUDED.service_code,pickup_point_id=EXCLUDED.pickup_point_id,
   pickup_point_name=EXCLUDED.pickup_point_name,pickup_point_address=EXCLUDED.pickup_point_address,last_selected_at=p_now,updated_at=p_now
  RETURNING to_jsonb(customer_delivery_preferences.*) INTO answer;
 END IF;
 RETURN answer;
END; $$;

CREATE FUNCTION public.customer_renewal_delivery_selection(p_subscription uuid,p_metadata jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE selection jsonb; owner_id uuid;
BEGIN
 p_metadata:=coalesce(p_metadata,'{}');
 IF p_metadata ? 'selectedDelivery' OR p_metadata#>'{runtimeFinalize,selectedDelivery}' IS NOT NULL THEN RETURN p_metadata; END IF;
 SELECT client_id INTO owner_id FROM public.subscriptions WHERE id=p_subscription;
 SELECT jsonb_build_object('kind',p.delivery_kind,'deliveryKind',p.delivery_kind,'providerKind',p.provider_ref,
  'carrierKind',p.carrier_kind,'carrierCode',p.carrier_code,'serviceCode',p.service_code,
  'pickupPoint',CASE WHEN p.delivery_kind='parcel-locker' THEN jsonb_build_object('id',p.pickup_point_id,'provider',p.carrier_kind,'name',p.pickup_point_name,'address',p.pickup_point_address) ELSE 'null'::jsonb END)
 INTO selection FROM public.customer_delivery_preferences p WHERE client_id=owner_id AND scope IN ('subscription','any')
 AND (delivery_kind='courier' OR (pickup_point_id IS NOT NULL AND pickup_point_name IS NOT NULL AND pickup_point_address IS NOT NULL))
 ORDER BY CASE scope WHEN 'subscription' THEN 0 ELSE 1 END,last_selected_at DESC,updated_at DESC LIMIT 1;
 IF selection IS NULL OR jsonb_typeof(selection)<>'object' THEN
  SELECT coalesce(o.metadata->'selectedDelivery',o.metadata#>'{runtimeFinalize,selectedDelivery}') INTO selection
  FROM public.commerce_orders o WHERE o.client_id=owner_id AND
   (EXISTS(SELECT 1 FROM public.subscription_cycles c WHERE c.id=o.subscription_cycle_id AND c.subscription_id=p_subscription)
    OR EXISTS(SELECT 1 FROM public.subscription_activations a WHERE a.order_id=o.id AND a.subscription_id=p_subscription))
   AND (o.metadata ? 'selectedDelivery' OR o.metadata#>'{runtimeFinalize,selectedDelivery}' IS NOT NULL) ORDER BY o.created_at ASC LIMIT 1;
 END IF;
 IF selection IS NOT NULL AND jsonb_typeof(selection)='object' THEN RETURN p_metadata||jsonb_build_object('selectedDelivery',selection); END IF;
 RETURN p_metadata;
END; $$;

CREATE FUNCTION public.customer_preferences_prepare_erasure()
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN LOCK TABLE public.customer_payment_preferences,public.customer_delivery_preferences IN SHARE ROW EXCLUSIVE MODE; RETURN true; END; $$;

CREATE FUNCTION public.customer_preferences_export(p_client uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN RETURN jsonb_build_object('payment',coalesce((SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM public.customer_payment_preferences p WHERE client_id=p_client),'[]'),
 'delivery',coalesce((SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM public.customer_delivery_preferences p WHERE client_id=p_client),'[]')); END; $$;

CREATE FUNCTION public.customer_preferences_erase(p_client uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN DELETE FROM public.customer_payment_preferences WHERE client_id=p_client; DELETE FROM public.customer_delivery_preferences WHERE client_id=p_client; RETURN true; END; $$;

CREATE FUNCTION public.customer_default_address_hints(p_client uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN RETURN jsonb_build_object('shipping',(SELECT id FROM public.customer_saved_addresses WHERE client_id=p_client AND kind IN ('shipping','both') ORDER BY is_default DESC,updated_at DESC LIMIT 1),
 'billing',(SELECT id FROM public.customer_saved_addresses WHERE client_id=p_client AND kind IN ('billing','both') ORDER BY is_default DESC,updated_at DESC LIMIT 1),
 'payment',coalesce((SELECT jsonb_agg(jsonb_build_object('scope',scope,'methodKind',method_kind) ORDER BY last_selected_at DESC) FROM public.customer_payment_preferences WHERE client_id=p_client),'[]'));
END; $$;

CREATE OR REPLACE FUNCTION public.commerce_prepare_subscription_renewal(
  p_operation_id uuid,
  p_claim_token uuid,
  p_now timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  v_operation public.subscription_renewal_operations%ROWTYPE;
  v_reservation public.fulfillment_inventory_reservations%ROWTYPE;
  v_cycle_id uuid;
  v_order_id uuid;
  v_intent_id uuid;
  v_line jsonb;
  v_line_ordinal integer := 0;
  v_sku_id uuid;
  v_quantity integer;
  v_unit_amount bigint;
  v_total bigint;
  v_currency text;
  v_channel text;
BEGIN
  SELECT subscription_id INTO v_operation.subscription_id
    FROM public.subscription_renewal_operations WHERE id = p_operation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'commerce_renewal_operation_not_found' USING ERRCODE = '22023';
  END IF;
  PERFORM id FROM public.subscriptions
   WHERE id = v_operation.subscription_id FOR UPDATE;

  SELECT * INTO v_operation FROM public.subscription_renewal_operations
   WHERE id = p_operation_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'commerce_renewal_operation_not_found' USING ERRCODE = '22023';
  END IF;
  IF v_operation.claim_token <> p_claim_token
    OR v_operation.lease_expires_at <= COALESCE(p_now, now())
  THEN
    RAISE EXCEPTION 'commerce_renewal_stale_claim' USING ERRCODE = '40001';
  END IF;

  SELECT cycle.id, order_row.id, intent.id
    INTO v_cycle_id, v_order_id, v_intent_id
    FROM public.subscription_cycles cycle
    JOIN public.commerce_orders order_row ON order_row.subscription_cycle_id = cycle.id
    JOIN public.commerce_settlement_intents intent ON intent.order_id = order_row.id
   WHERE cycle.renewal_operation_id = p_operation_id;
  IF FOUND THEN
    IF v_operation.state <> 'attempt_prepared' THEN
      RAISE EXCEPTION 'commerce_renewal_artifact_state_conflict' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object(
      'contractVersion', 'platform.subscription.renewal.v1', 'replayed', true,
      'operationId', p_operation_id, 'operationFingerprint', v_operation.operation_fingerprint,
      'cycleId', v_cycle_id, 'orderId', v_order_id, 'settlementIntentId', v_intent_id,
      'state', v_operation.state);
  END IF;
  IF v_operation.state <> 'reserved' THEN
    RAISE EXCEPTION 'commerce_renewal_reservation_required' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_reservation FROM public.fulfillment_inventory_reservations
   WHERE renewal_operation_id = p_operation_id FOR UPDATE;
  IF NOT FOUND OR v_reservation.status <> 'held'
    OR v_reservation.expires_at <= COALESCE(p_now, now())
    OR v_reservation.operation_fingerprint <> v_operation.operation_fingerprint
  THEN
    RAISE EXCEPTION 'commerce_renewal_active_reservation_required' USING ERRCODE = '22023';
  END IF;

  v_currency := v_operation.cycle_snapshot->>'currency';
  v_channel := v_operation.cycle_snapshot->>'settlementChannelKey';
  v_total := (v_operation.cycle_snapshot->>'totalAmountMinor')::bigint;
  IF v_currency !~ '^[A-Z]{3}$' OR btrim(COALESCE(v_channel, '')) = '' OR v_total < 1 THEN
    RAISE EXCEPTION 'commerce_renewal_invalid_snapshot' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.subscription_cycles (
    subscription_id, scheduled_at, status, renewal_operation_id,
    renewal_operation_fingerprint, updated_at
  ) VALUES (
    v_operation.subscription_id, v_operation.scheduled_at, 'payment_pending', p_operation_id,
    v_operation.operation_fingerprint, COALESCE(p_now, now())
  ) RETURNING id INTO v_cycle_id;

  INSERT INTO public.commerce_orders (
    client_id, subscription_cycle_id, status, currency_code, total_amount_minor,
    source_kind, metadata, renewal_operation_id, renewal_operation_fingerprint, updated_at
  ) SELECT subscription.client_id, v_cycle_id, 'pending_payment', v_currency, v_total,
           'storefront', public.customer_renewal_delivery_selection(v_operation.subscription_id,jsonb_build_object(
             'source', 'subscription.renewal',
             'renewalIdentityKey', v_operation.identity_key,
             'renewalOperationFingerprint', v_operation.operation_fingerprint,
             'cycleSnapshot', v_operation.cycle_snapshot)),
           p_operation_id, v_operation.operation_fingerprint, COALESCE(p_now, now())
      FROM public.subscriptions subscription WHERE subscription.id = v_operation.subscription_id
  RETURNING id INTO v_order_id;

  FOR v_line IN SELECT value FROM jsonb_array_elements(v_operation.cycle_snapshot->'lines')
  LOOP
    v_line_ordinal := v_line_ordinal + 1;
    v_quantity := (v_line->>'quantity')::integer;
    v_unit_amount := (v_line->>'unitAmountMinor')::bigint;
    SELECT id INTO v_sku_id FROM public.catalog_skus WHERE sku = v_line->>'sku';
    IF NOT FOUND OR v_quantity < 1 OR v_unit_amount < 0 THEN
      RAISE EXCEPTION 'commerce_renewal_invalid_line' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.commerce_order_items (
      order_id, sku_id, line_ordinal, quantity, unit_amount_minor, line_amount_minor
    ) VALUES (
      v_order_id, v_sku_id, v_line_ordinal, v_quantity, v_unit_amount,
      v_quantity * v_unit_amount);
  END LOOP;

  PERFORM public.commerce_open_settlement_intent(
    v_operation.identity_key || ':settlement', v_order_id, v_channel, v_total, v_currency,
    jsonb_build_object(
      'renewalOperationId', p_operation_id,
      'renewalOperationFingerprint', v_operation.operation_fingerprint),
    COALESCE(p_now, now()));
  SELECT id INTO v_intent_id FROM public.commerce_settlement_intents WHERE order_id = v_order_id;
  UPDATE public.commerce_settlement_intents
     SET renewal_operation_id = p_operation_id,
         renewal_operation_fingerprint = v_operation.operation_fingerprint,
         updated_at = COALESCE(p_now, now())
   WHERE id = v_intent_id;
  UPDATE public.fulfillment_inventory_reservations
     SET status = 'committed', expires_at = NULL, updated_at = COALESCE(p_now, now())
   WHERE id = v_reservation.id;
  UPDATE public.subscription_renewal_operations
     SET state = 'attempt_prepared', attempt_prepared_at = COALESCE(p_now, now()),
         updated_at = COALESCE(p_now, now())
   WHERE id = p_operation_id RETURNING * INTO v_operation;

  RETURN jsonb_build_object(
    'contractVersion', 'platform.subscription.renewal.v1', 'replayed', false,
    'operationId', p_operation_id, 'operationFingerprint', v_operation.operation_fingerprint,
    'cycleId', v_cycle_id, 'orderId', v_order_id, 'settlementIntentId', v_intent_id,
    'state', v_operation.state);
END;
$$;

ALTER TABLE public.customer_payment_preferences ENABLE ROW LEVEL SECURITY;

INSERT INTO public.client_absorption_policy (table_name, disposition, note) VALUES ('customer_payment_preferences', 'block', 'Customer preference history stays with its owner.');

DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'GRANT SELECT (client_id) ON TABLE public.customer_payment_preferences TO service_role;'; END IF; END; $$;

DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'CREATE POLICY customer_payment_preferences_absorption_census ON public.customer_payment_preferences FOR SELECT TO service_role USING (true);'; END IF; END; $$;

ALTER TABLE public.customer_delivery_preferences ENABLE ROW LEVEL SECURITY;

INSERT INTO public.client_absorption_policy (table_name, disposition, note) VALUES ('customer_delivery_preferences', 'block', 'Customer preference history stays with its owner.');

DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'GRANT SELECT (client_id) ON TABLE public.customer_delivery_preferences TO service_role;'; END IF; END; $$;

DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'CREATE POLICY customer_delivery_preferences_absorption_census ON public.customer_delivery_preferences FOR SELECT TO service_role USING (true);'; END IF; END; $$;

REVOKE ALL ON FUNCTION public.subscription_select_saved_shipping_address(uuid,uuid,text,uuid,jsonb,timestamptz), public.customer_preferences_read(uuid,uuid), public.customer_preference_save(uuid,uuid,text,jsonb,timestamptz), public.customer_renewal_delivery_selection(uuid,jsonb), public.customer_preferences_prepare_erasure(), public.customer_preferences_export(uuid), public.customer_preferences_erase(uuid), public.customer_default_address_hints(uuid) FROM PUBLIC;

DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.subscription_select_saved_shipping_address(uuid,uuid,text,uuid,jsonb,timestamptz), public.customer_preferences_read(uuid,uuid), public.customer_preference_save(uuid,uuid,text,jsonb,timestamptz), public.customer_renewal_delivery_selection(uuid,jsonb), public.customer_preferences_prepare_erasure(), public.customer_preferences_export(uuid), public.customer_preferences_erase(uuid), public.customer_default_address_hints(uuid) FROM anon'; END IF; END; $$;

DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.subscription_select_saved_shipping_address(uuid,uuid,text,uuid,jsonb,timestamptz), public.customer_preferences_read(uuid,uuid), public.customer_preference_save(uuid,uuid,text,jsonb,timestamptz), public.customer_renewal_delivery_selection(uuid,jsonb), public.customer_preferences_prepare_erasure(), public.customer_preferences_export(uuid), public.customer_preferences_erase(uuid), public.customer_default_address_hints(uuid) FROM authenticated'; END IF; END; $$;

DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'GRANT EXECUTE ON FUNCTION public.subscription_select_saved_shipping_address(uuid,uuid,text,uuid,jsonb,timestamptz), public.customer_preferences_read(uuid,uuid), public.customer_preference_save(uuid,uuid,text,jsonb,timestamptz), public.customer_renewal_delivery_selection(uuid,jsonb), public.customer_preferences_prepare_erasure(), public.customer_preferences_export(uuid), public.customer_preferences_erase(uuid), public.customer_default_address_hints(uuid) TO service_role'; END IF; END; $$;
