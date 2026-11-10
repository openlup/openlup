-- Exact parcel stock ownership and explicit operator transactions.
CREATE TABLE public.fulfillment_parcel_reservation_sets (
 shipment_id uuid PRIMARY KEY REFERENCES public.fulfillment_shipments(id),
 order_id uuid NOT NULL REFERENCES public.commerce_orders(id),
 recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.fulfillment_parcel_lines (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 shipment_id uuid NOT NULL REFERENCES public.fulfillment_parcel_reservation_sets(shipment_id),
 order_item_id uuid NOT NULL REFERENCES public.commerce_order_items(id),
 sku_id uuid REFERENCES public.catalog_skus(id),
 sku text,
 quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 2147483647),
 title text,
 product_snapshot jsonb NOT NULL DEFAULT '{}',
 UNIQUE (shipment_id,order_item_id)
);
CREATE TABLE public.fulfillment_parcel_line_reservations (
 line_id uuid NOT NULL REFERENCES public.fulfillment_parcel_lines(id),
 reservation_id uuid NOT NULL REFERENCES public.fulfillment_inventory_reservations(id),
 quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 2147483647),
 PRIMARY KEY (line_id,reservation_id)
);
CREATE TABLE public.fulfillment_operator_receipts (
 kind text NOT NULL CHECK (kind IN ('replacement','cancel','consume')),
 idempotency_key text NOT NULL,
 command jsonb NOT NULL,
 result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (kind,idempotency_key)
);
CREATE TABLE public.fulfillment_operator_status_evidence (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 event_key text NOT NULL UNIQUE REFERENCES public.fulfillment_observations(event_key),
 shipment_id uuid NOT NULL REFERENCES public.fulfillment_shipments(id),
 provider_status text,
 occurred_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.fulfillment_parcel_reservation_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fulfillment_parcel_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fulfillment_parcel_line_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fulfillment_operator_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fulfillment_operator_status_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commerce_order_operations DROP CONSTRAINT commerce_order_operations_operation_type_check;
ALTER TABLE public.commerce_order_operations ADD CONSTRAINT commerce_order_operations_operation_type_check CHECK (operation_type IN ('hold_created','hold_released','order_cancelled','order_refunded','replacement_shipment_requested'));
CREATE FUNCTION public.fulfillment_capture_new_parcel_reservations(p_shipment_id uuid,p_creation_key text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE parcel public.fulfillment_shipments; item record; line_id uuid;
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
 FOR item IN SELECT oi.*,cs.sku,cs.title,o.renewal_operation_id,o.renewal_operation_fingerprint,
  coalesce(o.metadata#>ARRAY['orderDraftSnapshot','lines',(coalesce(oi.source_line_ordinal,oi.line_ordinal)-1)::text],'{}') snapshot
  FROM public.commerce_order_items oi JOIN public.commerce_orders o ON o.id=oi.order_id
  LEFT JOIN public.catalog_skus cs ON cs.id=oi.sku_id WHERE oi.order_id=parcel.order_id ORDER BY oi.id LOOP
  INSERT INTO public.fulfillment_parcel_lines(shipment_id,order_item_id,sku_id,sku,quantity,title,product_snapshot)
   VALUES(parcel.id,item.id,item.sku_id,item.sku,item.quantity,item.title,item.snapshot) RETURNING id INTO line_id;
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
CREATE FUNCTION public.fulfillment_read_replacement_preparation(p_shipment_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.fulfillment_shipments WHERE id=p_shipment_id AND replaces_shipment_id IS NOT NULL) THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('contact',public.fulfillment_resolve_parcel_contact(p_shipment_id),'lines',
  (SELECT jsonb_agg(jsonb_build_object('sku',sku,'title',title,'quantity',quantity) ORDER BY id) FROM public.fulfillment_parcel_lines WHERE shipment_id=p_shipment_id));
END;
$$;
CREATE FUNCTION public.fulfillment_record_operator_status_evidence(p_event_key text,p_shipment_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE answer jsonb; observation jsonb;
BEGIN
 answer:=public.fulfillment_record_status_evidence(p_event_key,p_shipment_id);
 SELECT o.observation INTO observation FROM public.fulfillment_observations o WHERE o.event_key=p_event_key;
 INSERT INTO public.fulfillment_operator_status_evidence(event_key,shipment_id,provider_status,occurred_at)
 VALUES(p_event_key,p_shipment_id,observation#>>'{providerStatus,primary}',(observation#>>'{fact,occurredAt}')::timestamptz)
 ON CONFLICT(event_key) DO NOTHING;
 RETURN answer;
END;
$$;
CREATE FUNCTION public.fulfillment_consume_parcel_reservations(p_idempotency_key text,p_shipment_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE prior public.fulfillment_operator_receipts; answer jsonb; ids jsonb;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('parcel-consume-key|'||p_idempotency_key,0));
 SELECT * INTO prior FROM public.fulfillment_operator_receipts WHERE kind='consume' AND idempotency_key=p_idempotency_key;
 IF FOUND THEN
  IF prior.command->>'shipmentId' IS DISTINCT FROM p_shipment_id::text THEN RAISE EXCEPTION 'fulfillment_parcel_consumption_idempotency_conflict' USING ERRCODE='23505'; END IF;
  RETURN prior.result||jsonb_build_object('replayed',true);
 END IF;
 PERFORM id FROM public.fulfillment_shipments WHERE id=p_shipment_id FOR UPDATE;
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM public.fulfillment_parcel_reservation_sets WHERE shipment_id=p_shipment_id) THEN
  RAISE EXCEPTION 'fulfillment_parcel_reservations_not_recorded' USING ERRCODE='22023'; END IF;
 WITH consumed AS (
  UPDATE public.fulfillment_inventory_reservations r SET status='consumed',expires_at=NULL,terminal_reason=NULL,updated_at=now()
  WHERE r.id IN(SELECT a.reservation_id FROM public.fulfillment_parcel_line_reservations a JOIN public.fulfillment_parcel_lines l ON l.id=a.line_id WHERE l.shipment_id=p_shipment_id)
   AND r.status IN ('held','committed') RETURNING r.id)
 SELECT coalesce(jsonb_agg(id ORDER BY id),'[]') INTO ids FROM consumed;
 answer:=jsonb_build_object('consumedReservationIds',ids,'replayed',false);
 INSERT INTO public.fulfillment_operator_receipts(kind,idempotency_key,command,result)
 VALUES('consume',p_idempotency_key,jsonb_build_object('shipmentId',p_shipment_id),answer);
 RETURN answer;
END;
$$;
CREATE FUNCTION public.commerce_oms_request_replacement_shipment(p_idempotency_key text,p_order_id uuid,p_reason text,p_actor_id uuid,p_provider_ref text,p_source_key text,p_metadata jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE purchase public.commerce_orders; predecessor public.fulfillment_shipments; parcel public.fulfillment_shipments;
 prior public.fulfillment_operator_receipts; contact jsonb; command jsonb; answer jsonb; op public.commerce_order_operations;
 item record; stock public.fulfillment_stock_current; reservation_id uuid; line_id uuid; fingerprint text; latest uuid;
 hold_ids uuid[]; primary_hold uuid; blocking text; destination_id uuid;
BEGIN
 IF p_idempotency_key IS NULL OR length(p_idempotency_key)<8 OR btrim(p_idempotency_key)=''
  OR p_order_id IS NULL OR p_actor_id IS NULL OR p_reason IS NULL OR p_reason NOT IN ('damaged','lost','returned_undelivered','other') THEN
  RAISE EXCEPTION 'commerce_oms_replacement_invalid_input' USING ERRCODE='22023'; END IF;
 command:=jsonb_build_object('orderId',p_order_id,'reason',p_reason,'actorUserId',p_actor_id,'metadata',coalesce(p_metadata,'{}'));
 PERFORM pg_advisory_xact_lock(hashtextextended('parcel-replacement-key|'||p_idempotency_key,0));
 SELECT * INTO prior FROM public.fulfillment_operator_receipts WHERE kind='replacement' AND idempotency_key=p_idempotency_key;
 IF FOUND THEN
  IF prior.command IS DISTINCT FROM command THEN RAISE EXCEPTION 'commerce_oms_replacement_idempotency_conflict' USING ERRCODE='23505'; END IF;
  RETURN prior.result||jsonb_build_object('replayed',true);
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('commerce-order-delivery|'||p_order_id::text,0));
 SELECT * INTO purchase FROM public.commerce_orders WHERE id=p_order_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'commerce_oms_replacement_order_not_found' USING ERRCODE='22023'; END IF;
 SELECT * INTO predecessor FROM public.fulfillment_shipments WHERE order_id=p_order_id ORDER BY sequence_no DESC,id DESC LIMIT 1;
 IF NOT FOUND THEN RAISE EXCEPTION 'commerce_oms_replacement_no_parcel_to_replace' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('native-dispatch|'||predecessor.id::text,0));
 SELECT * INTO predecessor FROM public.fulfillment_shipments WHERE id=predecessor.id FOR UPDATE;
 SELECT * INTO purchase FROM public.commerce_orders WHERE id=p_order_id FOR UPDATE;
 SELECT id INTO latest FROM public.fulfillment_shipments WHERE order_id=p_order_id ORDER BY sequence_no DESC,id DESC LIMIT 1;
 IF latest IS DISTINCT FROM predecessor.id OR predecessor.order_id IS DISTINCT FROM purchase.id THEN
  RAISE EXCEPTION 'commerce_oms_replacement_stale_parcel' USING ERRCODE='40001'; END IF;
 IF purchase.status NOT IN ('paid','fulfillment_pending','fulfilled') THEN RAISE EXCEPTION 'commerce_oms_replacement_order_not_replaceable' USING ERRCODE='22023'; END IF;
 IF purchase.client_id IS NULL THEN RAISE EXCEPTION 'commerce_oms_replacement_missing_client' USING ERRCODE='22023'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.commerce_settlement_intents WHERE order_id=p_order_id AND status='settled') THEN
  RAISE EXCEPTION 'commerce_oms_replacement_payment_not_succeeded' USING ERRCODE='22023'; END IF;
 IF purchase.subscription_cycle_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.subscription_cycles WHERE id=purchase.subscription_cycle_id AND status='paid') THEN
  RAISE EXCEPTION 'commerce_oms_replacement_subscription_cycle_not_paid' USING ERRCODE='22023'; END IF;
 contact:=public.fulfillment_resolve_parcel_contact(predecessor.id);
 destination_id:=(public.commerce_read_destination('shipment',predecessor.id)->>'destinationId')::uuid;
 IF EXISTS(SELECT 1 FROM public.fulfillment_shipments WHERE order_id=p_order_id AND sequence_no>0 AND status IN ('created','label_pending')) THEN
  RAISE EXCEPTION 'commerce_oms_replacement_undispatched_replacement_exists' USING ERRCODE='22023'; END IF;
 SELECT reason INTO blocking FROM public.commerce_order_holds WHERE order_id=p_order_id AND status='active' AND reason<>'fulfillment_exception' ORDER BY created_at,id LIMIT 1 FOR UPDATE;
 IF blocking IS NOT NULL THEN RAISE EXCEPTION 'commerce_oms_replacement_blocked_by_%_hold',blocking USING ERRCODE='22023'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.commerce_order_items WHERE order_id=p_order_id) THEN RAISE EXCEPTION 'commerce_oms_replacement_missing_order_items' USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM public.commerce_order_items oi LEFT JOIN public.catalog_skus sku ON sku.id=oi.sku_id WHERE oi.order_id=p_order_id AND sku.id IS NULL) THEN
  RAISE EXCEPTION 'commerce_oms_replacement_missing_catalog_sku' USING ERRCODE='22023'; END IF;
 -- The host explicitly binds the captured provider to its observed-stock source.
 IF p_provider_ref IS NULL OR p_source_key IS NULL OR p_source_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'
  OR contact#>>'{selectedDelivery,providerKind}' IS DISTINCT FROM p_provider_ref THEN
  RAISE EXCEPTION 'commerce_oms_replacement_provider_binding_invalid' USING ERRCODE='22023'; END IF;
 WITH released AS (UPDATE public.commerce_order_holds SET status='released',released_at=now(),released_by=p_actor_id,updated_at=now(),
  metadata=metadata||jsonb_build_object('releasedBy','commerce_oms_request_replacement_shipment','replacementReason',p_reason)
  WHERE order_id=p_order_id AND status='active' AND reason='fulfillment_exception' RETURNING id,created_at)
 SELECT coalesce(array_agg(id ORDER BY created_at,id),ARRAY[]::uuid[]),(array_agg(id ORDER BY created_at,id))[1] INTO hold_ids,primary_hold FROM released;
 PERFORM public.inventory_admission_try_enter();
 PERFORM s.sku FROM public.fulfillment_stock_current s JOIN public.catalog_skus sku ON sku.sku=s.sku
 JOIN public.commerce_order_items oi ON oi.sku_id=sku.id WHERE oi.order_id=p_order_id AND s.source_key=p_source_key ORDER BY s.sku FOR UPDATE OF s;
 FOR item IN SELECT sku.sku,sum(oi.quantity) quantity FROM public.commerce_order_items oi JOIN public.catalog_skus sku ON sku.id=oi.sku_id WHERE oi.order_id=p_order_id GROUP BY sku.sku ORDER BY sku.sku LOOP
  SELECT * INTO stock FROM public.fulfillment_stock_current WHERE source_key=p_source_key AND sku=item.sku;
  IF NOT FOUND THEN RAISE EXCEPTION 'inventory_external_provider_stock_missing' USING ERRCODE='23514'; END IF;
  IF stock.stale_after<=now() THEN RAISE EXCEPTION 'inventory_external_provider_stock_stale' USING ERRCODE='23514'; END IF;
  IF stock.inventory_class IS DISTINCT FROM 'sellable' OR (public.inventory_available_to_promise(p_source_key,item.sku,now(),false)->>'available_quantity')::bigint<item.quantity THEN
   RAISE EXCEPTION 'inventory_external_provider_insufficient_available_stock' USING ERRCODE='23514'; END IF;
 END LOOP;
 INSERT INTO public.fulfillment_shipments(order_id,port_key,provider_type,create_idempotency_key,metadata,sequence_no,replaces_shipment_id,replacement_reason)
 VALUES(p_order_id,predecessor.port_key,predecessor.provider_type,p_idempotency_key||':fulfillment',coalesce(p_metadata,'{}')||jsonb_build_object('source','commerce_oms_request_replacement_shipment','replacementReason',p_reason),predecessor.sequence_no+1,predecessor.id,p_reason) RETURNING * INTO parcel;
 INSERT INTO public.commerce_destination_bindings(shipment_id,destination_id) VALUES(parcel.id,destination_id);
 INSERT INTO public.fulfillment_parcel_contacts(shipment_id,client_id,contact) VALUES(parcel.id,purchase.client_id,contact);
 INSERT INTO public.fulfillment_parcel_reservation_sets(shipment_id,order_id) VALUES(parcel.id,p_order_id);
 fingerprint:=encode(sha256(convert_to(command::text,'UTF8')),'hex');
 FOR item IN SELECT oi.*,sku.sku,sku.title,coalesce(purchase.metadata#>ARRAY['orderDraftSnapshot','lines',(coalesce(oi.source_line_ordinal,oi.line_ordinal)-1)::text],'{}') snapshot
  FROM public.commerce_order_items oi JOIN public.catalog_skus sku ON sku.id=oi.sku_id WHERE oi.order_id=p_order_id ORDER BY oi.id LOOP
  INSERT INTO public.fulfillment_inventory_reservations(purchase_order_id,operation_fingerprint,source_key,status,expires_at)
   VALUES(p_order_id,fingerprint,p_source_key,'committed',NULL) RETURNING id INTO reservation_id;
  INSERT INTO public.fulfillment_inventory_reservation_lines(reservation_id,operation_fingerprint,sku,quantity) VALUES(reservation_id,fingerprint,item.sku,item.quantity);
  INSERT INTO public.fulfillment_parcel_lines(shipment_id,order_item_id,sku_id,sku,quantity,title,product_snapshot)
   VALUES(parcel.id,item.id,item.sku_id,item.sku,item.quantity,item.title,item.snapshot) RETURNING id INTO line_id;
  INSERT INTO public.fulfillment_parcel_line_reservations(line_id,reservation_id,quantity) VALUES(line_id,reservation_id,item.quantity);
 END LOOP;
 INSERT INTO public.fulfillment_shipment_operations(shipment_id,order_id,operation_type,idempotency_key,payload)
 VALUES(parcel.id,p_order_id,'shipment_created',p_idempotency_key||':created',jsonb_build_object('operatorUserId',p_actor_id,'sequenceNo',parcel.sequence_no,'replacesFulfillmentOrderId',predecessor.id,'replacementReason',p_reason));
 INSERT INTO public.commerce_order_operations(order_id,hold_id,actor_id,operation_type,idempotency_key,payload)
 VALUES(p_order_id,primary_hold,p_actor_id,'replacement_shipment_requested',p_idempotency_key||':operation',jsonb_build_object('reason',p_reason,'sequenceNo',parcel.sequence_no,'fulfillmentOrderId',parcel.id,'replacesFulfillmentOrderId',predecessor.id,'releasedHoldIds',to_jsonb(hold_ids),'metadata',coalesce(p_metadata,'{}'),'source','commerce.oms.v0')) RETURNING * INTO op;
 answer:=jsonb_build_object('contractVersion','commerce.v0','operation',jsonb_build_object('id',op.id,'orderId',op.order_id,'type',op.operation_type,'holdId',op.hold_id,'actorUserId',op.actor_id,'occurredAt',op.occurred_at,'payload',op.payload),
 'replacement',jsonb_build_object('fulfillmentOrderId',parcel.id,'orderId',p_order_id,'sequenceNo',parcel.sequence_no,'replacesFulfillmentOrderId',predecessor.id,'reason',p_reason,'status','created'),'releasedHoldIds',to_jsonb(hold_ids),'replayed',false);
 INSERT INTO public.fulfillment_operator_receipts(kind,idempotency_key,command,result) VALUES('replacement',p_idempotency_key,command,answer);
 RETURN answer;
END;
$$;
CREATE FUNCTION public.fulfillment_operator_cancel_order(p_idempotency_key text,p_shipment_id uuid,p_reason text,p_actor_id uuid,p_metadata jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE parcel public.fulfillment_shipments; purchase public.commerce_orders; prior public.fulfillment_operator_receipts;
 answer jsonb; ids uuid[]:=ARRAY[]::uuid[]; disposition text; confirmed boolean; recorded boolean; recorded_mode text; old_op public.fulfillment_shipment_operations;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('parcel-cancel-key|'||p_idempotency_key,0));
 SELECT * INTO prior FROM public.fulfillment_operator_receipts WHERE kind='cancel' AND idempotency_key=p_idempotency_key;
 IF FOUND THEN
  IF prior.command->>'shipmentId' IS DISTINCT FROM p_shipment_id::text OR prior.command->>'reason' IS DISTINCT FROM p_reason THEN
   RAISE EXCEPTION 'commerce_fulfillment_cancel_idempotency_conflict' USING ERRCODE='23505'; END IF;
  RETURN prior.result||jsonb_build_object('replayed',true);
 END IF;
 -- Share the preparation lock so no dispatch may begin between evidence and cancellation.
 PERFORM pg_advisory_xact_lock(hashtextextended('native-dispatch|'||p_shipment_id::text,0));
 SELECT * INTO parcel FROM public.fulfillment_shipments WHERE id=p_shipment_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'commerce_fulfillment_not_found' USING ERRCODE='22023'; END IF;
 recorded:=EXISTS(SELECT 1 FROM public.fulfillment_parcel_reservation_sets WHERE shipment_id=parcel.id);
 disposition:=CASE WHEN recorded THEN 'recorded' ELSE 'reservations_not_recorded' END;
 IF parcel.status='cancelled' THEN
  SELECT * INTO old_op FROM public.fulfillment_shipment_operations WHERE shipment_id=parcel.id AND operation_type='shipment_cancelled' ORDER BY occurred_at DESC,id DESC LIMIT 1;
  RETURN jsonb_build_object('contractVersion','commerce.fulfillment.v0','fulfillmentOrderId',parcel.id,'orderId',parcel.order_id,'status','cancelled','replayed',true,
   'releasedReservationCount',coalesce((old_op.payload->>'releasedReservationCount')::integer,0),'reservationDisposition',disposition);
 END IF;
 SELECT lower(btrim(e.provider_status))='cancelled' INTO confirmed FROM public.fulfillment_operator_status_evidence e
 WHERE e.shipment_id=parcel.id ORDER BY e.occurred_at DESC NULLS LAST,e.created_at DESC,e.id DESC LIMIT 1;
 confirmed:=coalesce(confirmed,false) AND parcel.status='exception';
 IF confirmed THEN
  SELECT * INTO purchase FROM public.commerce_orders WHERE id=parcel.order_id FOR UPDATE;
  recorded_mode:=purchase.metadata#>>'{orderDraftSnapshot,context,mode}';
  IF recorded_mode IS NULL AND purchase.status IN ('paid','fulfillment_pending') THEN
   RAISE EXCEPTION 'commerce_fulfillment_provider_cancel_order_mode_unproven' USING ERRCODE='22023'; END IF;
  IF recorded_mode<>'one_time' OR purchase.status NOT IN ('paid','fulfillment_pending') THEN
   RAISE EXCEPTION 'commerce_fulfillment_provider_cancel_order_ineligible' USING ERRCODE='22023'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.commerce_settlement_intents WHERE order_id=purchase.id AND status='settled') THEN
   RAISE EXCEPTION 'commerce_fulfillment_provider_cancel_payment_not_succeeded' USING ERRCODE='22023'; END IF;
  IF EXISTS(SELECT 1 FROM public.commerce_order_holds WHERE order_id=purchase.id AND status='active') THEN
   RAISE EXCEPTION 'commerce_fulfillment_provider_cancel_active_hold' USING ERRCODE='22023'; END IF;
  UPDATE public.fulfillment_inventory_reservations SET status='released',terminal_reason='order_cancelled',updated_at=now()
   WHERE (purchase_order_id=purchase.id OR (renewal_operation_id=purchase.renewal_operation_id
     AND operation_fingerprint=purchase.renewal_operation_fingerprint)) AND status IN ('held','committed');
  UPDATE public.commerce_orders SET status='cancelled',cancelled_at=now(),updated_at=now(),metadata=metadata||jsonb_build_object('source','operator_provider_cancel_confirmed','suppressOrderCanceledEmail',true,
   'providerCancellation',jsonb_build_object('reason',p_reason,'actorUserId',p_actor_id,'confirmedAt',now())) WHERE id=purchase.id;
  INSERT INTO public.commerce_order_operations(order_id,actor_id,operation_type,source,idempotency_key,payload)
   VALUES(purchase.id,p_actor_id,'order_cancelled','commerce.fulfillment.provider_cancel_confirmed',p_idempotency_key||':order',jsonb_build_object('reason',p_reason,'metadata',coalesce(p_metadata,'{}'),'providerStatus','CANCELLED'));
 ELSE
  IF EXISTS(SELECT 1 FROM public.fulfillment_dispatch_refs WHERE shipment_id=parcel.id AND status NOT IN ('failed','cancelled')) THEN
   RAISE EXCEPTION 'commerce_fulfillment_cancel_provider_dispatch_active' USING ERRCODE='22023'; END IF;
  IF parcel.status NOT IN ('created','packed','label_pending') THEN RAISE EXCEPTION 'commerce_fulfillment_cancel_after_label_forbidden' USING ERRCODE='22023'; END IF;
  SELECT coalesce(array_agg(DISTINCT a.reservation_id ORDER BY a.reservation_id),ARRAY[]::uuid[]) INTO ids
   FROM public.fulfillment_parcel_line_reservations a JOIN public.fulfillment_parcel_lines l ON l.id=a.line_id WHERE l.shipment_id=parcel.id;
  UPDATE public.fulfillment_inventory_reservations SET status='released',terminal_reason='fulfillment_cancelled',updated_at=now()
   WHERE id=ANY(ids) AND status IN ('held','committed');
 END IF;
 UPDATE public.fulfillment_shipments SET status='cancelled',cancelled_at=now(),updated_at=now(),metadata=metadata||jsonb_build_object('releasedReservationIds',to_jsonb(ids),'providerCancellationConfirmed',confirmed) WHERE id=parcel.id;
 INSERT INTO public.fulfillment_shipment_operations(shipment_id,order_id,operation_type,idempotency_key,payload)
 VALUES(parcel.id,parcel.order_id,'shipment_cancelled',p_idempotency_key,jsonb_build_object('reason',p_reason,'operatorUserId',p_actor_id,'metadata',coalesce(p_metadata,'{}'),
  'providerCancellationConfirmed',confirmed,'releasedReservationIds',to_jsonb(ids),'releasedReservationCount',cardinality(ids),'reservationDisposition',disposition));
 answer:=jsonb_build_object('contractVersion','commerce.fulfillment.v0','fulfillmentOrderId',parcel.id,'orderId',parcel.order_id,'status','cancelled','replayed',false,'releasedReservationCount',cardinality(ids),'reservationDisposition',disposition);
 INSERT INTO public.fulfillment_operator_receipts(kind,idempotency_key,command,result) VALUES('cancel',p_idempotency_key,jsonb_build_object('shipmentId',parcel.id,'reason',p_reason),answer);
 RETURN answer;
END;
$$;
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
  RETURN v_shipment;
END;
$$;
CREATE OR REPLACE FUNCTION public.commerce_order_emit_cancelled_notification()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF coalesce(NEW.metadata->>'suppressOrderCanceledEmail','false')='true' THEN RETURN NULL; END IF;
  INSERT INTO public.outbox_events
    (aggregate_type, aggregate_id, event_type, idempotency_key, payload, metadata)
  VALUES ('commerce_order', NEW.id, 'commerce.order.cancelled', 'order_cancelled:' || NEW.id::text,
          jsonb_build_object('orderUuid', NEW.id, 'occurredAt', NEW.cancelled_at),
          jsonb_build_object('source', 'commerce_order_emit_cancelled_notification'))
  ON CONFLICT (event_type, idempotency_key) DO NOTHING;
  RETURN NULL;
END;
$$;
REVOKE ALL ON TABLE public.fulfillment_parcel_reservation_sets FROM PUBLIC;
REVOKE ALL ON TABLE public.fulfillment_parcel_lines FROM PUBLIC;
REVOKE ALL ON TABLE public.fulfillment_parcel_line_reservations FROM PUBLIC;
REVOKE ALL ON TABLE public.fulfillment_operator_receipts FROM PUBLIC;
REVOKE ALL ON TABLE public.fulfillment_operator_status_evidence FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fulfillment_capture_new_parcel_reservations(uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fulfillment_read_replacement_preparation(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fulfillment_record_operator_status_evidence(text,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fulfillment_consume_parcel_reservations(text,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.commerce_oms_request_replacement_shipment(text,uuid,text,uuid,text,text,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fulfillment_operator_cancel_order(text,uuid,text,uuid,jsonb) FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'REVOKE ALL ON TABLE public.fulfillment_parcel_reservation_sets, public.fulfillment_parcel_lines, public.fulfillment_parcel_line_reservations, public.fulfillment_operator_receipts, public.fulfillment_operator_status_evidence FROM anon'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'REVOKE ALL ON TABLE public.fulfillment_parcel_reservation_sets, public.fulfillment_parcel_lines, public.fulfillment_parcel_line_reservations, public.fulfillment_operator_receipts, public.fulfillment_operator_status_evidence FROM authenticated'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'REVOKE ALL ON TABLE public.fulfillment_parcel_reservation_sets, public.fulfillment_parcel_lines, public.fulfillment_parcel_line_reservations, public.fulfillment_operator_receipts, public.fulfillment_operator_status_evidence FROM service_role'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.fulfillment_capture_new_parcel_reservations(uuid,text), public.fulfillment_read_replacement_preparation(uuid), public.fulfillment_record_operator_status_evidence(text,uuid), public.fulfillment_consume_parcel_reservations(text,uuid), public.commerce_oms_request_replacement_shipment(text,uuid,text,uuid,text,text,jsonb), public.fulfillment_operator_cancel_order(text,uuid,text,uuid,jsonb) FROM anon'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.fulfillment_capture_new_parcel_reservations(uuid,text), public.fulfillment_read_replacement_preparation(uuid), public.fulfillment_record_operator_status_evidence(text,uuid), public.fulfillment_consume_parcel_reservations(text,uuid), public.commerce_oms_request_replacement_shipment(text,uuid,text,uuid,text,text,jsonb), public.fulfillment_operator_cancel_order(text,uuid,text,uuid,jsonb) FROM authenticated'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'GRANT EXECUTE ON FUNCTION public.fulfillment_capture_new_parcel_reservations(uuid,text), public.fulfillment_read_replacement_preparation(uuid), public.fulfillment_record_operator_status_evidence(text,uuid), public.fulfillment_consume_parcel_reservations(text,uuid), public.commerce_oms_request_replacement_shipment(text,uuid,text,uuid,text,text,jsonb), public.fulfillment_operator_cancel_order(text,uuid,text,uuid,jsonb) TO service_role'; END IF; END; $$;
