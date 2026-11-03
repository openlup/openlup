-- Native observed-stock purchase slice of inventory_reserve_order/items,
-- inventory_release_reservation and inventory_expire_reservations. Local lots,
-- locations, balance counters and movements are a named limit. Two deliberate
-- differences: changed-key input and elapsed initial expiry refuse by name.
ALTER TABLE public.fulfillment_inventory_reservations
  ALTER COLUMN renewal_operation_id DROP NOT NULL,
  ADD COLUMN purchase_order_id uuid;
ALTER TABLE public.fulfillment_inventory_reservations
  ADD CONSTRAINT fulfillment_inventory_reservations_purchase_order_fkey
    FOREIGN KEY (purchase_order_id) REFERENCES public.commerce_orders(id) ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT fulfillment_inventory_reservations_owner_check
    CHECK ((renewal_operation_id IS NULL) = (purchase_order_id IS NOT NULL)) NOT VALID;
ALTER TABLE public.fulfillment_inventory_reservations
  VALIDATE CONSTRAINT fulfillment_inventory_reservations_purchase_order_fkey,
  VALIDATE CONSTRAINT fulfillment_inventory_reservations_owner_check;

CREATE TABLE public.fulfillment_purchase_reservation_receipts (
  idempotency_key text CONSTRAINT fulfillment_purchase_reservation_receipts_pkey PRIMARY KEY,
  command jsonb NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fulfillment_purchase_reservation_receipts_key_check
    CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  CONSTRAINT fulfillment_purchase_reservation_receipts_command_check CHECK (jsonb_typeof(command) = 'object'),
  CONSTRAINT fulfillment_purchase_reservation_receipts_result_check CHECK (jsonb_typeof(result) = 'object')
);
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX fulfillment_inventory_reservations_purchase_order_idx
  ON public.fulfillment_inventory_reservations(purchase_order_id) WHERE purchase_order_id IS NOT NULL;
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX fulfillment_inventory_reservations_purchase_expiry_idx
  ON public.fulfillment_inventory_reservations(expires_at,id)
  WHERE purchase_order_id IS NOT NULL AND status = 'held';

CREATE FUNCTION public.inventory_admission_try_enter() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE prior_ms integer;
BEGIN
  IF pg_catalog.current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION 'inventory_admission_isolation_unsupported' USING ERRCODE='22023';
  END IF;
  IF NOT pg_catalog.pg_try_advisory_xact_lock(846832106,1) THEN
    RAISE EXCEPTION 'inventory_admission_busy' USING ERRCODE='55P03';
  END IF;
  SELECT setting::integer INTO prior_ms FROM pg_catalog.pg_settings WHERE name='lock_timeout';
  PERFORM pg_catalog.set_config('lock_timeout',CASE WHEN prior_ms=0 THEN '50' ELSE least(prior_ms,50)::text END,true);
END; $$;

CREATE FUNCTION public.fulfillment_reserve_purchase_order_items(
  p_idempotency_key text, p_order_id uuid, p_source_key text, p_items jsonb,
  p_payment_status text, p_expires_at timestamptz, p_metadata jsonb DEFAULT '{}',
  p_now timestamptz DEFAULT now()
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  receipt public.fulfillment_purchase_reservation_receipts%ROWTYPE;
  command jsonb; fingerprint text; item jsonb; line record;
  v_item_id uuid; v_sku_id uuid; qty integer; v_reservation_id uuid;
  results jsonb := '[]'; answer jsonb; expiry timestamptz;
  stock public.fulfillment_stock_current%ROWTYPE;
BEGIN
  IF p_payment_status IS NULL OR p_payment_status NOT IN ('created','requires_action','processing','succeeded') THEN
    RAISE EXCEPTION 'inventory_reservation_payment_status_not_reservable' USING ERRCODE='22023';
  END IF;
  IF p_order_id IS NULL OR p_now IS NULL OR NOT isfinite(p_now)
    OR p_idempotency_key IS NULL OR char_length(btrim(p_idempotency_key)) NOT BETWEEN 8 AND 200
    OR p_source_key IS NULL OR p_source_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'
    OR p_metadata IS NULL OR jsonb_typeof(p_metadata)<>'object' THEN
    RAISE EXCEPTION 'fulfillment_purchase_reservation_invalid_input' USING ERRCODE='22023';
  END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items)<>'array' OR jsonb_array_length(p_items)=0 THEN
    RAISE EXCEPTION 'inventory_reservation_items_invalid' USING ERRCODE='22023';
  END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    BEGIN
      v_item_id:=(item->>'orderItemId')::uuid; v_sku_id:=(item->>'skuId')::uuid; qty:=(item->>'quantity')::integer;
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
      RAISE EXCEPTION 'inventory_reservation_item_invalid' USING ERRCODE='22023';
    END;
    IF v_item_id IS NULL OR v_sku_id IS NULL OR qty IS NULL OR qty<=0 THEN
      RAISE EXCEPTION 'inventory_reservation_item_invalid' USING ERRCODE='22023';
    END IF;
  END LOOP;
  IF (SELECT count(DISTINCT value->>'orderItemId') FROM jsonb_array_elements(p_items))<>jsonb_array_length(p_items) THEN
    RAISE EXCEPTION 'inventory_reservation_item_invalid' USING ERRCODE='22023';
  END IF;
  command := jsonb_build_object('action','reserve','orderId',p_order_id,'sourceKey',p_source_key,
    'items',p_items,'paymentStatus',p_payment_status,'expiresAt',p_expires_at AT TIME ZONE 'UTC','metadata',p_metadata);
  SELECT * INTO receipt FROM public.fulfillment_purchase_reservation_receipts WHERE idempotency_key=p_idempotency_key;
  IF NOT FOUND THEN
    PERFORM public.inventory_admission_try_enter();
    PERFORM pg_advisory_xact_lock(hashtextextended('purchase-reservation:'||p_idempotency_key,0));
    SELECT * INTO receipt FROM public.fulfillment_purchase_reservation_receipts WHERE idempotency_key=p_idempotency_key;
  END IF;
  IF FOUND THEN
    IF receipt.command<>command THEN
      RAISE EXCEPTION 'fulfillment_purchase_reservation_idempotency_conflict' USING ERRCODE='23505';
    END IF;
    -- Retained identity and current state, never a newly extended lease.
    SELECT jsonb_agg(value || jsonb_build_object('status',CASE WHEN r.status='held' THEN 'reserved' ELSE r.status END,
      'replayed',true) ORDER BY ordinal) INTO results
      FROM jsonb_array_elements(receipt.result->'reservations') WITH ORDINALITY AS entry(value,ordinal)
      JOIN public.fulfillment_inventory_reservations r ON r.id=(value->>'reservationId')::uuid;
    RETURN receipt.result || jsonb_build_object('reservations',results,'replayed',true);
  END IF;
  expiry := COALESCE(p_expires_at,p_now+interval '30 minutes');
  IF NOT isfinite(expiry) OR expiry<=p_now THEN
    RAISE EXCEPTION 'fulfillment_purchase_reservation_elapsed_expiry' USING ERRCODE='22023';
  END IF;
  PERFORM 1 FROM public.commerce_orders WHERE id=p_order_id AND renewal_operation_id IS NULL AND status IN ('pending_payment','paid') FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'fulfillment_purchase_reservation_order_invalid' USING ERRCODE='22023';
  END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    v_item_id:=(item->>'orderItemId')::uuid; v_sku_id:=(item->>'skuId')::uuid; qty:=(item->>'quantity')::integer;
    PERFORM 1 FROM public.commerce_order_items oi
      WHERE oi.id=v_item_id AND oi.order_id=p_order_id AND oi.sku_id=v_sku_id AND oi.quantity=qty FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'fulfillment_purchase_reservation_item_mismatch' USING ERRCODE='22023';
    END IF;
  END LOOP;
  -- Match renewal/stock-wait/retry ordering before any ATP read.
  PERFORM s.sku FROM public.fulfillment_stock_current s
    JOIN public.catalog_skus sku ON sku.sku=s.sku
    JOIN jsonb_array_elements(p_items) i ON (i->>'skuId')::uuid=sku.id
    WHERE s.source_key=p_source_key ORDER BY s.sku FOR UPDATE OF s;
  FOR line IN SELECT sku.sku,sum((i->>'quantity')::integer) quantity
    FROM jsonb_array_elements(p_items) i JOIN public.catalog_skus sku ON sku.id=(i->>'skuId')::uuid
    GROUP BY sku.sku ORDER BY sku.sku LOOP
    SELECT * INTO stock FROM public.fulfillment_stock_current WHERE source_key=p_source_key AND sku=line.sku;
    IF NOT FOUND THEN RAISE EXCEPTION 'inventory_external_provider_stock_missing' USING ERRCODE='23514'; END IF;
    IF stock.stale_after<=p_now THEN RAISE EXCEPTION 'inventory_external_provider_stock_stale' USING ERRCODE='23514'; END IF;
    IF stock.inventory_class<>'sellable' OR (public.inventory_available_to_promise(p_source_key,line.sku,p_now,false)->>'available_quantity')::bigint<line.quantity THEN
      RAISE EXCEPTION 'inventory_external_provider_insufficient_available_stock' USING ERRCODE='23514';
    END IF;
  END LOOP;
  fingerprint:=encode(sha256(convert_to(command::text,'UTF8')),'hex');
  FOR item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    INSERT INTO public.fulfillment_inventory_reservations(purchase_order_id,operation_fingerprint,source_key,expires_at,created_at,updated_at)
      VALUES(p_order_id,fingerprint,p_source_key,expiry,p_now,p_now) RETURNING id INTO v_reservation_id;
    INSERT INTO public.fulfillment_inventory_reservation_lines(reservation_id,operation_fingerprint,sku,quantity)
      SELECT v_reservation_id,fingerprint,sku.sku,(item->>'quantity')::integer FROM public.catalog_skus sku WHERE sku.id=(item->>'skuId')::uuid;
    results:=results||jsonb_build_array(jsonb_build_object('orderItemId',item->>'orderItemId',
      'reservationId',v_reservation_id,'status','reserved','replayed',false));
  END LOOP;
  answer:=jsonb_build_object('contractVersion','inventory.v0','status','reserved','reservations',results,'replayed',false);
  INSERT INTO public.fulfillment_purchase_reservation_receipts(idempotency_key,command,result,created_at)
    VALUES(p_idempotency_key,command,answer,p_now);
  RETURN answer;
END;
$$;

CREATE FUNCTION public.fulfillment_release_purchase_reservation(
  p_idempotency_key text,p_reservation_id uuid,p_reason text DEFAULT 'released',
  p_metadata jsonb DEFAULT '{}',p_now timestamptz DEFAULT now()
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  receipt public.fulfillment_purchase_reservation_receipts%ROWTYPE;
  reservation public.fulfillment_inventory_reservations%ROWTYPE;
  command jsonb; answer jsonb;
BEGIN
  IF p_idempotency_key IS NULL OR char_length(btrim(p_idempotency_key)) NOT BETWEEN 8 AND 200
    OR p_reservation_id IS NULL OR btrim(COALESCE(p_reason,''))='' OR p_now IS NULL OR NOT isfinite(p_now)
    OR p_metadata IS NULL OR jsonb_typeof(p_metadata)<>'object' THEN
    RAISE EXCEPTION 'fulfillment_purchase_release_invalid_input' USING ERRCODE='22023';
  END IF;
  command:=jsonb_build_object('action','release','reservationId',p_reservation_id,'reason',p_reason,'metadata',p_metadata);
  SELECT * INTO receipt FROM public.fulfillment_purchase_reservation_receipts WHERE idempotency_key=p_idempotency_key;
  IF NOT FOUND THEN
    PERFORM public.inventory_admission_try_enter();
    PERFORM pg_advisory_xact_lock(hashtextextended('purchase-reservation:'||p_idempotency_key,0));
    SELECT * INTO receipt FROM public.fulfillment_purchase_reservation_receipts WHERE idempotency_key=p_idempotency_key;
  END IF;
  IF FOUND THEN
    IF receipt.command<>command THEN RAISE EXCEPTION 'fulfillment_purchase_reservation_idempotency_conflict' USING ERRCODE='23505'; END IF;
    RETURN receipt.result||jsonb_build_object('replayed',true);
  END IF;
  SELECT * INTO reservation FROM public.fulfillment_inventory_reservations
    WHERE id=p_reservation_id AND purchase_order_id IS NOT NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'inventory_reservation_not_found' USING ERRCODE='22023'; END IF;
  IF reservation.status='held' THEN
    UPDATE public.fulfillment_inventory_reservations SET status='released',terminal_reason=p_reason,updated_at=p_now
      WHERE id=p_reservation_id RETURNING * INTO reservation;
    answer:=jsonb_build_object('contractVersion','inventory.v0','reservationId',p_reservation_id,'status',reservation.status,'replayed',false);
  ELSE
    answer:=jsonb_build_object('contractVersion','inventory.v0','reservationId',p_reservation_id,'status',reservation.status,'replayed',true);
  END IF;
  INSERT INTO public.fulfillment_purchase_reservation_receipts(idempotency_key,command,result,created_at)
    VALUES(p_idempotency_key,command,answer,p_now);
  RETURN answer;
END;
$$;

CREATE FUNCTION public.fulfillment_expire_purchase_reservations(p_now timestamptz DEFAULT pg_catalog.now(),p_limit integer DEFAULT 100)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE reservation record; count integer:=0;
BEGIN
  IF p_now IS NULL OR NOT pg_catalog.isfinite(p_now) OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'fulfillment_purchase_expiry_invalid_input' USING ERRCODE='22023';
  END IF;
  PERFORM public.inventory_admission_try_enter();
  FOR reservation IN SELECT id FROM public.fulfillment_inventory_reservations
    WHERE purchase_order_id IS NOT NULL AND status='held' AND expires_at<=p_now
    ORDER BY expires_at,id LIMIT p_limit FOR UPDATE LOOP
    UPDATE public.fulfillment_inventory_reservations SET status='expired',terminal_reason='reservation_expired',updated_at=p_now
      WHERE id=reservation.id;
    count:=count+1;
  END LOOP;
  RETURN pg_catalog.jsonb_build_object('contractVersion','inventory.v0','expiredCount',count);
END;
$$;

-- Aggregate compensation reuses the native donor and the purchase-only release
-- routine. Neither the caller nor a receipt can turn payment evidence into cancel.
CREATE FUNCTION public.commerce_cancel_abandoned_purchase_checkout(
  p_idempotency_key text,p_order_id uuid,p_reason text,p_now timestamptz DEFAULT now()
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  receipt public.fulfillment_purchase_reservation_receipts%ROWTYPE;
  target public.commerce_orders%ROWTYPE;
  command jsonb; answer jsonb; held record; released integer:=0; donor_key text;
  subscription_hint uuid; locked_subscription uuid; hint_found boolean;
BEGIN
  IF p_idempotency_key IS NULL OR length(p_idempotency_key) NOT BETWEEN 8 AND 200
    OR length(btrim(p_idempotency_key))<8 OR p_order_id IS NULL
    OR p_reason IS NULL OR btrim(p_reason)='' OR length(p_reason)>180
    OR p_now IS NULL OR NOT isfinite(p_now) THEN
    RAISE EXCEPTION 'commerce_checkout_compensation_invalid_input' USING ERRCODE='22023';
  END IF;
  command:=jsonb_build_object('action','cancel','orderId',p_order_id,'reason',p_reason);
  donor_key:='purchase-cancel:'||encode(sha256(convert_to(p_idempotency_key,'UTF8')),'hex');
  PERFORM pg_advisory_xact_lock(hashtextextended('purchase-reservation:'||donor_key,0));
  SELECT * INTO receipt FROM public.fulfillment_purchase_reservation_receipts WHERE idempotency_key=donor_key;
  IF FOUND THEN
    IF receipt.command<>command THEN
      RAISE EXCEPTION 'fulfillment_purchase_reservation_idempotency_conflict' USING ERRCODE='23505';
    END IF;
    RETURN receipt.result||jsonb_build_object('replayed',true);
  END IF;
  SELECT COALESCE(c.subscription_id,a.subscription_id) INTO subscription_hint
    FROM public.commerce_orders o
    LEFT JOIN public.subscription_cycles c ON c.id=o.subscription_cycle_id
    LEFT JOIN public.subscription_activations a ON a.order_id=o.id WHERE o.id=p_order_id;
  hint_found:=FOUND;
  IF subscription_hint IS NOT NULL THEN
    PERFORM 1 FROM public.subscriptions WHERE id=subscription_hint FOR UPDATE;
  END IF;
  SELECT * INTO target FROM public.commerce_orders WHERE id=p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    answer:=jsonb_build_object('cancelled',false,'reason','order_not_found','orderStatus',NULL);
  ELSIF target.renewal_operation_id IS NOT NULL THEN
    RAISE EXCEPTION 'commerce_checkout_compensation_renewal_order_unsupported' USING ERRCODE='22023';
  ELSE
    SELECT COALESCE(c.subscription_id,a.subscription_id) INTO locked_subscription
      FROM public.commerce_orders o
      LEFT JOIN public.subscription_cycles c ON c.id=o.subscription_cycle_id
      LEFT JOIN public.subscription_activations a ON a.order_id=o.id WHERE o.id=p_order_id;
    IF NOT hint_found OR locked_subscription IS DISTINCT FROM subscription_hint THEN
      RAISE EXCEPTION 'commerce_checkout_compensation_aggregate_changed' USING ERRCODE='55000';
    END IF;
    -- Root first, then every intent and attempt before their evidence.
    PERFORM id FROM public.commerce_settlement_intents WHERE order_id=p_order_id ORDER BY id FOR UPDATE;
    PERFORM a.id FROM public.payment_simulator_attempts a JOIN public.commerce_settlement_intents i
      ON i.id=a.settlement_intent_id WHERE i.order_id=p_order_id ORDER BY a.id FOR UPDATE OF a;
    PERFORM e.id FROM public.payment_simulator_observations e JOIN public.payment_simulator_attempts a
      ON a.id=e.attempt_id JOIN public.commerce_settlement_intents i ON i.id=a.settlement_intent_id
      WHERE i.order_id=p_order_id ORDER BY e.id FOR UPDATE OF e;
    PERFORM e.id FROM public.payment_truth_events e JOIN public.commerce_settlement_intents i
      ON i.id=e.settlement_intent_id WHERE i.order_id=p_order_id ORDER BY e.id FOR UPDATE OF e;
    IF EXISTS(SELECT 1 FROM public.payment_simulator_attempts a JOIN public.commerce_settlement_intents i
      ON i.id=a.settlement_intent_id WHERE i.order_id=p_order_id AND a.state='dispatched') THEN
      RETURN jsonb_build_object('cancelled',false,'reason','provider_attempt_in_flight');
    END IF;
    IF EXISTS(SELECT 1 FROM public.payment_simulator_attempts a JOIN public.commerce_settlement_intents i
      ON i.id=a.settlement_intent_id WHERE i.order_id=p_order_id AND a.state IN ('captured','indeterminate')) THEN
      RETURN jsonb_build_object('cancelled',false,'reason','money_recorded','orderStatus',target.status);
    END IF;
    IF EXISTS(SELECT 1 FROM public.commerce_settlement_intents WHERE order_id=p_order_id AND status='settled')
      OR EXISTS(SELECT 1 FROM public.payment_truth_events e JOIN public.commerce_settlement_intents i
        ON i.id=e.settlement_intent_id WHERE i.order_id=p_order_id AND e.outcome IN ('captured','indeterminate')) THEN
      answer:=jsonb_build_object('cancelled',false,'reason','money_recorded','orderStatus',target.status);
    ELSE
      answer:=public.commerce_compensate_abandoned_checkout(donor_key,p_order_id,p_reason,p_now);
      IF answer->>'cancelled'='true' THEN
        FOR held IN SELECT id FROM public.fulfillment_inventory_reservations
          WHERE purchase_order_id=p_order_id AND status='held' ORDER BY id FOR UPDATE LOOP
          PERFORM public.fulfillment_release_purchase_reservation(
            'cancel-release:'||encode(sha256(convert_to(p_idempotency_key||':'||held.id::text,'UTF8')),'hex'),
            held.id,p_reason,jsonb_build_object('compensationKey',p_idempotency_key),p_now);
          released:=released+1;
        END LOOP;
      END IF;
    END IF;
  END IF;
  answer:=answer||jsonb_build_object('releasedCount',released,'replayed',false);
  INSERT INTO public.fulfillment_purchase_reservation_receipts(idempotency_key,command,result,created_at)
    VALUES(donor_key,command,answer,p_now);
  RETURN answer;
END;
$$;

REVOKE ALL ON TABLE public.fulfillment_purchase_reservation_receipts FROM PUBLIC;
REVOKE ALL ON FUNCTION public.inventory_admission_try_enter() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fulfillment_reserve_purchase_order_items(text,uuid,text,jsonb,text,timestamptz,jsonb,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fulfillment_release_purchase_reservation(text,uuid,text,jsonb,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fulfillment_expire_purchase_reservations(timestamptz,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.commerce_cancel_abandoned_purchase_checkout(text,uuid,text,timestamptz) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    EXECUTE 'REVOKE ALL ON TABLE public.fulfillment_purchase_reservation_receipts FROM anon';
  END IF;
END; $$;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    EXECUTE 'REVOKE ALL ON TABLE public.fulfillment_purchase_reservation_receipts FROM authenticated';
  END IF;
END; $$;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
    EXECUTE 'REVOKE ALL ON TABLE public.fulfillment_purchase_reservation_receipts FROM service_role';
  END IF;
END; $$;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.inventory_admission_try_enter(), public.fulfillment_reserve_purchase_order_items(text,uuid,text,jsonb,text,timestamptz,jsonb,timestamptz), public.fulfillment_release_purchase_reservation(text,uuid,text,jsonb,timestamptz), public.fulfillment_expire_purchase_reservations(timestamptz,integer), public.commerce_cancel_abandoned_purchase_checkout(text,uuid,text,timestamptz) FROM anon';
  END IF;
END; $$;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.inventory_admission_try_enter(), public.fulfillment_reserve_purchase_order_items(text,uuid,text,jsonb,text,timestamptz,jsonb,timestamptz), public.fulfillment_release_purchase_reservation(text,uuid,text,jsonb,timestamptz), public.fulfillment_expire_purchase_reservations(timestamptz,integer), public.commerce_cancel_abandoned_purchase_checkout(text,uuid,text,timestamptz) FROM authenticated';
  END IF;
END; $$;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.fulfillment_reserve_purchase_order_items(text,uuid,text,jsonb,text,timestamptz,jsonb,timestamptz), public.fulfillment_release_purchase_reservation(text,uuid,text,jsonb,timestamptz), public.fulfillment_expire_purchase_reservations(timestamptz,integer), public.commerce_cancel_abandoned_purchase_checkout(text,uuid,text,timestamptz) TO service_role';
  END IF;
END; $$;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.inventory_admission_try_enter() FROM service_role';
  END IF;
END; $$;
