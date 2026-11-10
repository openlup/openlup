-- Operator unpaid cancellation and external refund status recording.
-- Private payment attempts remain behind an owned command, without raw grants.

CREATE FUNCTION public.oms_cancel_unpaid_order_owned(p_key text,p_order uuid,p_reason text,p_actor uuid,p_metadata jsonb,p_at timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  target public.commerce_orders%ROWTYPE;
  receipt public.commerce_order_operations%ROWTYPE;
  subscription_hint uuid; locked_subscription uuid; hint_found boolean;
  held record;
BEGIN
  IF p_key IS NULL OR char_length(btrim(p_key)) < 8 OR p_order IS NULL
    OR p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'oms_cancel_unpaid_order_invalid_input' USING ERRCODE='22023';
  END IF;
  -- Serialize the command key, including concurrent reuse across different orders.
  PERFORM pg_advisory_xact_lock(hashtextextended('oms-unpaid-cancel:'||p_key,0));
  -- The order is the common payment/checkout mutex. Settlement can lock a
  -- subscription after the order; checkout compensation can already hold its
  -- parent before requesting the order.
  -- This command never writes or locks that parent. Recheck its hinted binding
  -- after the order lock, then lock intents, attempts, observations and truth.
  SELECT COALESCE(c.subscription_id,a.subscription_id) INTO subscription_hint
    FROM public.commerce_orders o
    LEFT JOIN public.subscription_cycles c ON c.id=o.subscription_cycle_id
    LEFT JOIN public.subscription_activations a ON a.order_id=o.id WHERE o.id=p_order;
  hint_found:=FOUND;
  SELECT * INTO target FROM public.commerce_orders WHERE id=p_order FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'oms_cancel_unpaid_order_not_found' USING ERRCODE='22023'; END IF;
  SELECT COALESCE(c.subscription_id,a.subscription_id) INTO locked_subscription
    FROM public.commerce_orders o
    LEFT JOIN public.subscription_cycles c ON c.id=o.subscription_cycle_id
    LEFT JOIN public.subscription_activations a ON a.order_id=o.id WHERE o.id=p_order;
  IF NOT hint_found OR locked_subscription IS DISTINCT FROM subscription_hint THEN
    RAISE EXCEPTION 'oms_cancel_unpaid_order_aggregate_changed' USING ERRCODE='55000';
  END IF;
  PERFORM id FROM public.commerce_settlement_intents WHERE order_id=p_order ORDER BY id FOR UPDATE;
  PERFORM a.id FROM public.payment_simulator_attempts a JOIN public.commerce_settlement_intents i
    ON i.id=a.settlement_intent_id WHERE i.order_id=p_order ORDER BY a.id FOR UPDATE OF a;
  PERFORM e.id FROM public.payment_simulator_observations e JOIN public.payment_simulator_attempts a
    ON a.id=e.attempt_id JOIN public.commerce_settlement_intents i ON i.id=a.settlement_intent_id
    WHERE i.order_id=p_order ORDER BY e.id FOR UPDATE OF e;
  PERFORM e.id FROM public.payment_truth_events e JOIN public.commerce_settlement_intents i
    ON i.id=e.settlement_intent_id WHERE i.order_id=p_order ORDER BY e.id FOR UPDATE OF e;
  IF EXISTS(SELECT 1 FROM public.payment_simulator_attempts a JOIN public.commerce_settlement_intents i
    ON i.id=a.settlement_intent_id WHERE i.order_id=p_order AND a.state='dispatched') THEN
    RAISE EXCEPTION 'oms_cancel_unpaid_order_payment_in_flight' USING ERRCODE='23505';
  END IF;
  IF EXISTS(SELECT 1 FROM public.payment_simulator_attempts a JOIN public.commerce_settlement_intents i
    ON i.id=a.settlement_intent_id WHERE i.order_id=p_order AND a.state IN ('captured','indeterminate'))
    OR EXISTS(SELECT 1 FROM public.commerce_settlement_intents WHERE order_id=p_order AND status='settled')
    OR EXISTS(SELECT 1 FROM public.payment_truth_events e JOIN public.commerce_settlement_intents i
      ON i.id=e.settlement_intent_id WHERE i.order_id=p_order AND e.outcome IN ('captured','indeterminate')) THEN
    RAISE EXCEPTION 'oms_cancel_unpaid_order_payment_already_moved' USING ERRCODE='23505';
  END IF;
  SELECT * INTO receipt FROM public.commerce_order_operations WHERE idempotency_key=p_key;
  IF FOUND THEN
    IF receipt.operation_type <> 'order_cancelled' OR receipt.order_id IS DISTINCT FROM p_order
      OR receipt.payload->>'reason' IS DISTINCT FROM p_reason THEN
      RAISE EXCEPTION 'oms_cancel_unpaid_order_idempotency_conflict' USING ERRCODE='23505';
    END IF;
    RETURN jsonb_build_object('contractVersion','platform.oms.order.v1','orderId',p_order,'status',target.status,'replayed',true);
  END IF;
  IF target.status='cancelled' THEN
    RETURN jsonb_build_object('contractVersion','platform.oms.order.v1','orderId',p_order,'status','cancelled','replayed',true);
  END IF;
  IF target.status<>'pending_payment' THEN
    RAISE EXCEPTION 'oms_cancel_unpaid_order_invalid_status' USING ERRCODE='22023';
  END IF;
  IF p_actor IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.commerce_operators WHERE id=p_actor) THEN
    RAISE EXCEPTION 'oms_cancel_unpaid_order_actor_unknown' USING ERRCODE='23503';
  END IF;
  -- Native settlement intents represent cancelled unpaid work as failed. The
  -- cancelled order fences future attempts; late captures keep their review path.
  UPDATE public.commerce_settlement_intents SET status='failed',failure_reason='admin_oms_cancelled_unpaid_order',updated_at=p_at
    WHERE order_id=p_order AND status<>'settled';
  UPDATE public.commerce_orders SET status='cancelled',cancelled_at=p_at,updated_at=p_at,
    metadata=metadata||jsonb_build_object('cancellation',jsonb_build_object(
      'reason',p_reason,'actorId',p_actor,'request',COALESCE(p_metadata,'{}'::jsonb))) WHERE id=p_order;
  INSERT INTO public.commerce_order_operations(order_id,actor_id,operation_type,idempotency_key,payload,occurred_at)
    VALUES(p_order,p_actor,'order_cancelled',p_key,jsonb_build_object('reason',p_reason),p_at);
  -- The release primitive owns its key and row lock. Do not lock a reservation
  -- before that key, and do not release another order's or a renewal's stock.
  FOR held IN SELECT id FROM public.fulfillment_inventory_reservations
    WHERE purchase_order_id=p_order AND status='held' ORDER BY id LOOP
    PERFORM public.fulfillment_release_purchase_reservation(
      'oms-cancel-release:'||encode(sha256(convert_to(p_key||':'||held.id::text,'UTF8')),'hex'),
      held.id,p_reason,jsonb_build_object('operatorCancellationKey',p_key),p_at);
  END LOOP;
  RETURN jsonb_build_object('contractVersion','platform.oms.order.v1','orderId',p_order,'status','cancelled','replayed',false);
END;
$$;

REVOKE ALL ON FUNCTION public.oms_cancel_unpaid_order_owned(text,uuid,text,uuid,jsonb,timestamptz) FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.oms_cancel_unpaid_order_owned(text,uuid,text,uuid,jsonb,timestamptz) FROM anon'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.oms_cancel_unpaid_order_owned(text,uuid,text,uuid,jsonb,timestamptz) FROM authenticated'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'GRANT EXECUTE ON FUNCTION public.oms_cancel_unpaid_order_owned(text,uuid,text,uuid,jsonb,timestamptz) TO service_role'; END IF; END; $$;

CREATE OR REPLACE FUNCTION public.oms_cancel_unpaid_order(
  p_idempotency_key text,
  p_order_id uuid,
  p_reason text,
  p_actor_id uuid DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'::jsonb,
  p_requested_at timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  RETURN public.oms_cancel_unpaid_order_owned(p_idempotency_key,p_order_id,p_reason,p_actor_id,p_metadata,p_requested_at);
END;
$$;

CREATE OR REPLACE FUNCTION public.oms_mark_refunded(
  p_idempotency_key text,
  p_order_id uuid,
  p_reason text,
  p_actor_id uuid DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'::jsonb,
  p_requested_at timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_existing public.commerce_order_operations%ROWTYPE;
  v_order public.commerce_orders%ROWTYPE;
BEGIN
  IF p_idempotency_key IS NULL OR char_length(btrim(p_idempotency_key)) < 8 OR p_order_id IS NULL OR p_reason IS NULL OR btrim(p_reason) = ''
  THEN
    RAISE EXCEPTION 'oms_mark_refunded_invalid_input' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_existing
    FROM public.commerce_order_operations WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.order_id IS DISTINCT FROM p_order_id
      OR v_existing.payload->>'reason' IS DISTINCT FROM p_reason
    THEN
      RAISE EXCEPTION 'oms_mark_refunded_idempotency_conflict' USING ERRCODE = '23505';
    END IF;
    SELECT * INTO v_order FROM public.commerce_orders WHERE id = v_existing.order_id;
    RETURN jsonb_build_object('contractVersion', 'platform.oms.order.v1',
      'orderId', v_existing.order_id, 'status', v_order.status, 'replayed', true);
  END IF;

  SELECT * INTO v_order FROM public.commerce_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'oms_mark_refunded_order_not_found' USING ERRCODE = '22023';
  END IF;

  IF v_order.status = 'refunded' THEN
    RETURN jsonb_build_object('contractVersion', 'platform.oms.order.v1',
      'orderId', p_order_id, 'status', 'refunded', 'replayed', true);
  END IF;

  IF v_order.status <> 'paid' THEN
    RAISE EXCEPTION 'oms_mark_refunded_invalid_status' USING ERRCODE = '22023';
  END IF;

  UPDATE public.commerce_orders
     SET status = 'refunded',
         refunded_at = p_requested_at,
         updated_at = p_requested_at,
         metadata = metadata || jsonb_build_object('source', 'admin_manual_refund', 'refund', jsonb_build_object(
           'reason', p_reason, 'actorId', p_actor_id,
           'request', COALESCE(p_metadata, '{}'::jsonb)))
   WHERE id = p_order_id;

  INSERT INTO public.commerce_order_operations
    (order_id, actor_id, operation_type, idempotency_key, payload, occurred_at)
  VALUES (p_order_id, p_actor_id, 'order_refunded', p_idempotency_key,
          jsonb_build_object('reason', p_reason), p_requested_at);

  RETURN jsonb_build_object('contractVersion', 'platform.oms.order.v1',
    'orderId', p_order_id, 'status', 'refunded', 'replayed', false);
END;
$$;

CREATE OR REPLACE FUNCTION public.commerce_order_emit_refunded_notification()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  -- A manual external mark records status only; genuine refund duties remain active.
  IF NEW.metadata->>'source' = 'admin_manual_refund' THEN RETURN NULL; END IF;
  INSERT INTO public.outbox_events
    (aggregate_type, aggregate_id, event_type, idempotency_key, payload, metadata)
  VALUES ('commerce_order', NEW.id, 'commerce.order.refunded', 'order_refunded:' || NEW.id::text,
          jsonb_build_object('orderUuid', NEW.id, 'occurredAt', NEW.refunded_at),
          jsonb_build_object('source', 'commerce_order_emit_refunded_notification'))
  ON CONFLICT (event_type, idempotency_key) DO NOTHING;
  RETURN NULL;
END;
$$;
