-- Managed subscription stock wait preserves the original unpaid basket and schedule.
-- Latest donor logic uses the M06 available-to-promise seam as a renewal.
-- Its own existing hold remains reusable; no availability arithmetic lives here.
-- No pause, charge, scheduler or provider call is
-- introduced here. Waiting/resumed facts require the original transactional proof.
-- Internal functions and raw frozen snapshots are service-role only.

CREATE TABLE public.subscription_stock_wait_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id uuid NOT NULL REFERENCES public.subscriptions(id) ON DELETE RESTRICT,
  client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE RESTRICT,
  scheduled_at timestamptz NOT NULL,
  state text NOT NULL CHECK (state IN ('waiting','stock_secured','resumed','closed')),
  cycle_number integer NOT NULL CHECK (cycle_number > 0),
  due_snapshot jsonb NOT NULL,
  template_snapshot jsonb NOT NULL,
  pricing_snapshot jsonb NOT NULL,
  order_snapshot jsonb NOT NULL,
  fingerprint text NOT NULL,
  notice_messages jsonb NOT NULL DEFAULT '{}',
  deficits jsonb NOT NULL CHECK (jsonb_typeof(deficits) = 'array'),
  cycle_id uuid REFERENCES public.subscription_cycles(id) ON DELETE RESTRICT,
  order_id uuid REFERENCES public.commerce_orders(id) ON DELETE RESTRICT,
  fulfillment_id uuid REFERENCES public.commerce_fulfillment_orders(id) ON DELETE RESTRICT,
  opened_at timestamptz NOT NULL DEFAULT now(),
  last_checked_at timestamptz NOT NULL DEFAULT now(),
  last_selected_at timestamptz,
  stock_secured_at timestamptz,
  resumed_at timestamptz,
  closed_at timestamptz,
  block_reason text,
  UNIQUE (subscription_id, scheduled_at)
);
ALTER TABLE public.subscription_stock_wait_cases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.subscription_stock_wait_cases FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.subscription_stock_wait_cases FROM openlup_mcp_reader;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.subscription_stock_wait_cases TO service_role;
INSERT INTO public.client_absorption_policy (table_name, disposition, note) VALUES
 ('subscription_stock_wait_cases', 'block',
  'A frozen subscription delivery is a commercial obligation bound to its original client; never carry or rebind it when absorbing a lead.');
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX subscription_stock_wait_candidates_idx
  ON public.subscription_stock_wait_cases(state,last_checked_at,id);

CREATE FUNCTION public.subscription_stock_wait_projection(p_case public.subscription_stock_wait_cases)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
SELECT jsonb_build_object('id',p_case.id,'subscriptionId',p_case.subscription_id,
 'clientId',p_case.client_id,'scheduledAt',p_case.scheduled_at,'cycleNumber',p_case.cycle_number,'state',p_case.state,
 'deficits',p_case.deficits,'cycleId',p_case.cycle_id,'orderId',p_case.order_id,
 'fulfillmentId',p_case.fulfillment_id,'openedAt',p_case.opened_at,
 'lastCheckedAt',p_case.last_checked_at,'resumedAt',p_case.resumed_at,'stockSecuredAt',p_case.stock_secured_at,
 'closedAt',p_case.closed_at,'blockReason',p_case.block_reason);
$$;

CREATE FUNCTION public.subscription_stock_wait_read(p_case_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
 SELECT public.subscription_stock_wait_projection(c)||jsonb_build_object('waitingNoticeRelevant',
  s.status='active' AND s.next_cycle_at=c.scheduled_at)
 FROM public.subscription_stock_wait_cases c JOIN public.subscriptions s ON s.id=c.subscription_id WHERE c.id=p_case_id;
$$;

CREATE FUNCTION public.subscription_stock_wait_frozen(p_subscription_id uuid,p_scheduled_at timestamptz)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
 v_subscription public.subscriptions%ROWTYPE; v_case public.subscription_stock_wait_cases%ROWTYPE;
 v_cycle public.subscription_cycles%ROWTYPE; v_order public.commerce_orders%ROWTYPE;
 v_payment public.commerce_payments%ROWTYPE; v_intent public.commerce_payment_intents%ROWTYPE;
 v_key public.commerce_idempotency_keys%ROWTYPE; v_prefix text; v_literal text; v_instant timestamptz;
 v_template jsonb; v_pricing jsonb; v_snapshot jsonb; v_expected text; v_metadata jsonb; v_identity_error text;
BEGIN
 SELECT * INTO v_subscription FROM public.subscriptions WHERE id=p_subscription_id;
 IF NOT FOUND OR v_subscription.status<>'active' OR v_subscription.next_cycle_at IS DISTINCT FROM p_scheduled_at THEN RETURN NULL; END IF;
 SELECT * INTO v_case FROM public.subscription_stock_wait_cases
  WHERE subscription_id=p_subscription_id AND scheduled_at=p_scheduled_at;
 IF v_case.id IS NOT NULL AND (v_case.state NOT IN ('waiting','stock_secured')
  OR v_case.client_id IS DISTINCT FROM v_subscription.client_id) THEN RETURN NULL; END IF;
 SELECT * INTO v_cycle FROM public.subscription_cycles
  WHERE subscription_id=p_subscription_id AND scheduled_at=p_scheduled_at ORDER BY cycle_number DESC LIMIT 1;
 IF v_cycle.id IS NULL THEN
  IF v_case.id IS NULL OR v_case.cycle_id IS NOT NULL OR v_case.order_id IS NOT NULL THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('case',public.subscription_stock_wait_projection(v_case),
   'binding',jsonb_build_object('caseId',v_case.id,'cycleId',NULL,'orderId',NULL,'paymentId',NULL,'engineIdempotencyKey',NULL),
   'snapshots',jsonb_build_object('cycleNumber',v_case.cycle_number,'retryAttempt',0,'providerAttemptSequence',0,
    'templateSnapshot',v_case.template_snapshot,'pricingSnapshot',v_case.pricing_snapshot,'orderSnapshot',v_case.order_snapshot));
 END IF;
 IF v_cycle.status<>'payment_pending' OR v_cycle.paid_at IS NOT NULL OR v_cycle.renewal_quarantined_until>now() THEN RETURN NULL; END IF;
 SELECT * INTO v_order FROM public.commerce_orders WHERE id=v_cycle.order_id;
 IF v_order.id IS NULL OR v_order.status<>'pending_payment'
  OR COALESCE(v_order.metadata->>'paymentStatus','pending')<>'pending' THEN RETURN NULL; END IF;
 IF EXISTS(SELECT 1 FROM public.commerce_payments p WHERE p.order_id=v_order.id
    AND (p.status<>'pending' OR p.provider_payment_id IS NOT NULL OR p.provider<>'own_engine_payment'))
  OR EXISTS(SELECT 1 FROM public.commerce_payment_intents i WHERE i.order_id=v_order.id
    AND (i.status<>'created' OR i.active_attempt_id IS NOT NULL OR i.provider_payment_id IS NOT NULL))
  OR EXISTS(SELECT 1 FROM public.commerce_payment_attempts a WHERE a.payment_id IN
    (SELECT p.id FROM public.commerce_payments p WHERE p.order_id=v_order.id)
    OR a.payment_intent_id IN(SELECT i.id FROM public.commerce_payment_intents i WHERE i.order_id=v_order.id)) THEN RETURN NULL; END IF;
 SELECT * INTO v_payment FROM public.commerce_payments WHERE id=v_cycle.payment_id;
 IF (SELECT count(*) FROM public.subscription_cycles WHERE subscription_id=p_subscription_id AND scheduled_at=p_scheduled_at)<>1
  OR v_order.subscription_id IS DISTINCT FROM p_subscription_id OR v_order.subscription_cycle_id IS DISTINCT FROM v_cycle.id
  OR v_order.client_id IS DISTINCT FROM v_subscription.client_id OR v_payment.id IS NULL
  OR v_payment.order_id IS DISTINCT FROM v_order.id OR v_payment.amount_cents IS DISTINCT FROM v_order.total_cents
  OR v_payment.currency IS DISTINCT FROM v_order.currency OR (SELECT count(*) FROM public.commerce_payments WHERE order_id=v_order.id)<>1
  OR (v_case.id IS NOT NULL AND ((v_case.cycle_id IS NOT NULL AND v_case.cycle_id<>v_cycle.id)
    OR (v_case.order_id IS NOT NULL AND v_case.order_id<>v_order.id))) THEN
  RAISE EXCEPTION 'stock_wait_recovery_graph_invalid';
 END IF;
 v_template := v_cycle.template_snapshot; v_pricing := v_cycle.pricing_snapshot; v_snapshot := v_order.metadata->'orderSnapshot';
 IF jsonb_typeof(v_template) IS DISTINCT FROM 'object' OR jsonb_typeof(v_pricing) IS DISTINCT FROM 'object'
  OR jsonb_typeof(v_snapshot) IS DISTINCT FROM 'object' OR v_snapshot->>'currency' IS DISTINCT FROM v_order.currency
  OR v_snapshot#>>'{totals,totalGross,amountMinor}' IS DISTINCT FROM v_order.total_cents::text
  OR (v_case.id IS NOT NULL AND (v_case.cycle_number<>v_cycle.cycle_number OR v_case.template_snapshot<>v_template
   OR v_case.pricing_snapshot<>v_pricing OR v_case.order_snapshot<>v_snapshot)) THEN
  RAISE EXCEPTION 'stock_wait_recovery_snapshot_invalid';
 END IF;
 v_prefix := 'subscription:'||p_subscription_id::text||':cycle:';
 IF left(v_cycle.engine_idempotency_key,length(v_prefix))=v_prefix THEN
  v_literal := substr(v_cycle.engine_idempotency_key,length(v_prefix)+1);
  BEGIN v_instant := v_literal::timestamptz;
  EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN RAISE EXCEPTION 'stock_wait_recovery_identity_invalid'; END;
  IF v_instant IS DISTINCT FROM p_scheduled_at OR v_pricing->>'scheduledAt' IS DISTINCT FROM v_literal
   OR v_pricing->>'subscriptionId' IS DISTINCT FROM p_subscription_id::text
   OR v_pricing->>'cycleNumber' IS DISTINCT FROM v_cycle.cycle_number::text THEN
   RAISE EXCEPTION 'stock_wait_recovery_identity_invalid';
  END IF;
 ELSE
  -- Existing case snapshots remain readable under the opaque-key primitive
  -- contract. Managed recovery receives an explicit refusal: neither its
  -- decoder nor locked admission may turn this read into a renewal charge.
  IF v_case.id IS NULL THEN RAISE EXCEPTION 'stock_wait_recovery_identity_invalid'; END IF;
  v_identity_error := 'stock_wait_recovery_identity_invalid';
  v_literal := v_case.due_snapshot->>'nextCycleAt';
 END IF;
 v_expected := md5(p_subscription_id::text||'|'||v_cycle.cycle_number::text||'|'||p_scheduled_at::text||'|'
  ||v_template::text||'|'||v_pricing::text||'|'||v_snapshot::text);
 SELECT * INTO v_key FROM public.commerce_idempotency_keys WHERE scope='subscription.cycle_order.create'
  AND idempotency_key=v_cycle.engine_idempotency_key;
 IF v_key.status IS DISTINCT FROM 'completed' OR v_key.request_fingerprint IS DISTINCT FROM v_expected
  OR v_key.response_payload#>>'{subscriptionCycleOrder,cycleId}' IS DISTINCT FROM v_cycle.id::text
  OR v_key.response_payload#>>'{subscriptionCycleOrder,orderId}' IS DISTINCT FROM 'order_'||v_order.id::text
  OR v_key.response_payload#>>'{subscriptionCycleOrder,paymentId}' IS DISTINCT FROM 'payment_'||v_payment.id::text THEN
  RAISE EXCEPTION 'stock_wait_recovery_identity_invalid';
 END IF;
 SELECT * INTO v_intent FROM public.commerce_payment_intents WHERE order_id=v_order.id;
 IF v_intent.id IS NOT NULL THEN
  v_metadata := jsonb_build_object('source','subscription.renewal.cron.v0','runtimeIdempotencyKey',v_cycle.engine_idempotency_key,
   'cycleNumber',v_cycle.cycle_number,'scheduledAt',v_literal);
  v_expected := md5('subscription_cycle|'||v_order.id::text||'|'||p_subscription_id::text||'|'||v_cycle.id::text||'|'
   ||v_order.total_cents::text||'|'||v_order.currency||'|'||v_metadata::text);
  SELECT * INTO v_key FROM public.commerce_idempotency_keys WHERE scope='commerce.payment_intent.create'
   AND idempotency_key=v_cycle.engine_idempotency_key||':payment-intent';
  IF v_intent.target_kind<>'subscription_cycle' OR v_intent.subscription_id IS DISTINCT FROM p_subscription_id
   OR v_intent.subscription_cycle_id IS DISTINCT FROM v_cycle.id OR v_intent.payment_id IS DISTINCT FROM v_payment.id
   OR v_intent.amount_cents IS DISTINCT FROM v_order.total_cents OR v_intent.currency IS DISTINCT FROM v_order.currency
   OR v_key.status IS DISTINCT FROM 'completed' OR v_key.request_fingerprint IS DISTINCT FROM v_expected
   OR v_key.response_payload#>>'{paymentIntent,id}' IS DISTINCT FROM v_intent.id::text THEN
   RAISE EXCEPTION 'stock_wait_recovery_intent_invalid';
  END IF;
 END IF;
 RETURN jsonb_build_object('error',v_identity_error,'case',CASE WHEN v_case.id IS NULL THEN NULL ELSE public.subscription_stock_wait_projection(v_case) END,
  'binding',jsonb_build_object('caseId',v_case.id,'cycleId',v_cycle.id,'orderId',v_order.id,'paymentId',v_payment.id,
   'engineIdempotencyKey',v_cycle.engine_idempotency_key),
  'snapshots',jsonb_build_object('cycleNumber',v_cycle.cycle_number,'retryAttempt',v_cycle.retry_attempt,
   'providerAttemptSequence',v_cycle.provider_attempt_sequence,'templateSnapshot',v_template,'pricingSnapshot',v_pricing,'orderSnapshot',v_snapshot));
END; $$;

CREATE FUNCTION public.subscription_stock_wait_deficits(p_snapshot jsonb,p_order_id uuid,p_now timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_line record; v_stock public.fulfillment_provider_stock_current%ROWTYPE;
 v_required integer; v_own integer; v_available integer; v_result jsonb := '[]';
BEGIN
 IF jsonb_typeof(p_snapshot->'lines') IS DISTINCT FROM 'array' OR jsonb_array_length(p_snapshot->'lines')=0 THEN
   RAISE EXCEPTION 'stock_wait_invalid_basket';
 END IF;
 FOR v_line IN SELECT sku.id,sku.sku,sku.title,sku.net_weight_g,sum((line->>'quantity')::integer)::integer quantity
   FROM jsonb_array_elements(p_snapshot->'lines') line JOIN public.catalog_skus sku ON sku.sku=line->>'sku'
   GROUP BY sku.id ORDER BY sku.id
 LOOP
   v_required := v_line.quantity;
   IF v_required<1 THEN RAISE EXCEPTION 'stock_wait_invalid_quantity'; END IF;
   SELECT * INTO v_stock FROM public.fulfillment_provider_stock_current
    WHERE provider_kind='omnipack' AND catalog_sku_id=v_line.id FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION 'inventory_external_provider_stock_missing'; END IF;
   IF v_stock.stale_after<=p_now THEN RAISE EXCEPTION 'inventory_external_provider_stock_stale'; END IF;
   SELECT COALESCE(sum(quantity),0) INTO v_own FROM public.inventory_reservations
   WHERE order_id=p_order_id AND sku_id=v_line.id AND status='reserved' AND metadata->>'providerKind'='omnipack'
     AND (expires_at IS NULL OR expires_at>p_now);
   SELECT atp.available_quantity INTO v_available
    FROM public.inventory_available_to_promise(v_line.id,p_now,true) atp;
   IF v_own+v_available<v_required THEN
     v_result := v_result || jsonb_build_array(jsonb_build_object('skuId',v_line.id,'sku',v_line.sku,
      'productName',v_line.title,'sizeG',v_line.net_weight_g,'requiredUnits',v_required,
      'reservedUnits',v_own,'availableUnits',v_available,'missingUnits',v_required-v_own-v_available));
   END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_snapshot->'lines') line
   WHERE NOT EXISTS(SELECT 1 FROM public.catalog_skus sku WHERE sku.sku=line->>'sku')) THEN
   RAISE EXCEPTION 'inventory_external_provider_sku_not_found';
 END IF;
 RETURN v_result;
END; $$;

CREATE FUNCTION public.subscription_stock_wait_enqueue(p_case public.subscription_stock_wait_cases,p_kind text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
 IF p_kind NOT IN ('started','resumed') THEN RAISE EXCEPTION 'stock_wait_event_invalid'; END IF;
 INSERT INTO public.outbox_events(aggregate_type,aggregate_id,event_type,idempotency_key,payload,metadata)
 VALUES('subscription_stock_wait',p_case.id,'subscription_stock_wait.'||p_kind,
   'subscription_stock_wait:'||p_case.id::text||':'||p_kind,
   jsonb_build_object('caseId',p_case.id,'clientId',p_case.client_id,'subscriptionId',p_case.subscription_id,
    'scheduledAt',p_case.scheduled_at,'deficits',p_case.deficits,'orderId',p_case.order_id),
   jsonb_build_object('source','subscription_stock_wait'))
 ON CONFLICT(event_type,idempotency_key) DO NOTHING;
END; $$;

CREATE FUNCTION public.subscription_stock_wait_admit(p_input jsonb,p_due jsonb,p_now timestamptz DEFAULT now())
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_subscription public.subscriptions%ROWTYPE; v_case public.subscription_stock_wait_cases%ROWTYPE;
 v_order public.commerce_orders%ROWTYPE; v_cycle public.subscription_cycles%ROWTYPE;
 v_sub uuid := (p_input->>'subscriptionId')::uuid; v_at timestamptz := (p_input->>'scheduledAt')::timestamptz;
 v_snapshot jsonb := p_input->'orderSnapshot'; v_deficits jsonb; v_response jsonb; v_error text; v_item record; v_own integer;
 v_prior_order_id uuid; v_generation text; v_frozen jsonb; v_recovery boolean := p_due ? 'stockWaitRecovery';
 v_fingerprint text := md5((p_input-'idempotencyKey')::text); v_created boolean := false;
BEGIN
 SELECT * INTO v_subscription FROM public.subscriptions WHERE id=v_sub FOR UPDATE;
 IF NOT FOUND OR v_subscription.status<>'active' OR v_subscription.next_cycle_at IS DISTINCT FROM v_at
  OR v_subscription.client_id::text IS DISTINCT FROM p_due->>'clientId' THEN RAISE EXCEPTION 'stock_wait_obligation_not_eligible'; END IF;
 SELECT * INTO v_case FROM public.subscription_stock_wait_cases WHERE subscription_id=v_sub AND scheduled_at=v_at FOR UPDATE;
 IF FOUND AND v_case.state='closed' THEN RAISE EXCEPTION 'stock_wait_obligation_closed'; END IF;
 IF FOUND AND (v_case.fingerprint<>v_fingerprint OR v_case.order_snapshot<>v_snapshot) THEN
   RAISE EXCEPTION 'stock_wait_frozen_snapshot_mismatch';
 END IF;
 SELECT * INTO v_cycle FROM public.subscription_cycles WHERE subscription_id=v_sub AND scheduled_at=v_at FOR UPDATE;
 IF FOUND THEN
   IF v_cycle.renewal_quarantined_until>p_now THEN RAISE EXCEPTION 'stock_wait_renewal_quarantined'; END IF;
   SELECT * INTO v_order FROM public.commerce_orders WHERE subscription_cycle_id=v_cycle.id FOR UPDATE;
   -- Aggregate roots precede intent/payment, matching the payment-control wrappers.
   IF v_recovery THEN
     PERFORM 1 FROM public.commerce_payment_intents WHERE order_id=v_order.id ORDER BY id FOR UPDATE;
     PERFORM 1 FROM public.commerce_payments WHERE order_id=v_order.id ORDER BY id FOR UPDATE;
   END IF;
   IF v_cycle.status<>'payment_pending' OR v_order.status<>'pending_payment' THEN
     IF v_recovery THEN RAISE EXCEPTION 'stock_wait_recovery_provider_owned'; END IF;
     RETURN public.subscription_create_cycle_order_with_outbox(p_input->>'idempotencyKey',v_sub,
       (p_input->>'cycleNumber')::integer,v_at,p_input->'templateSnapshot',p_input->'pricingSnapshot',v_snapshot)
       ||jsonb_build_object('bypass',true);
   END IF;
   IF EXISTS(SELECT 1 FROM public.commerce_payment_intents i JOIN public.commerce_payment_attempts a ON a.payment_intent_id=i.id WHERE i.order_id=v_order.id)
    OR EXISTS(SELECT 1 FROM public.commerce_payment_intents i WHERE i.order_id=v_order.id AND i.status<>'created') THEN
     IF v_recovery THEN RAISE EXCEPTION 'stock_wait_recovery_provider_owned'; END IF;
     RETURN public.subscription_create_cycle_order_with_outbox(p_input->>'idempotencyKey',v_sub,
       (p_input->>'cycleNumber')::integer,v_at,p_input->'templateSnapshot',p_input->'pricingSnapshot',v_snapshot)
       ||jsonb_build_object('bypass',true);
   END IF;
 END IF;
 IF v_recovery THEN
   IF p_input->>'idempotencyKey' IS DISTINCT FROM 'subscription:'||v_sub::text||':cycle:'||(p_input->>'scheduledAt') THEN
     RAISE EXCEPTION 'stock_wait_recovery_identity_invalid';
   END IF;
   v_frozen := public.subscription_stock_wait_frozen(v_sub,v_at);
   IF v_frozen IS NULL THEN RAISE EXCEPTION 'stock_wait_recovery_frozen_missing'; END IF;
   IF v_frozen->>'error' IS NOT NULL THEN RAISE EXCEPTION 'stock_wait_recovery_identity_invalid'; END IF;
   IF v_frozen->'binding' IS DISTINCT FROM p_due->'stockWaitRecovery' THEN
     RAISE EXCEPTION 'stock_wait_recovery_binding_changed';
   END IF;
   IF v_frozen#>>'{snapshots,cycleNumber}' IS DISTINCT FROM p_input->>'cycleNumber'
    OR v_frozen#>'{snapshots,templateSnapshot}' IS DISTINCT FROM p_input->'templateSnapshot'
    OR v_frozen#>'{snapshots,pricingSnapshot}' IS DISTINCT FROM p_input->'pricingSnapshot'
    OR v_frozen#>'{snapshots,orderSnapshot}' IS DISTINCT FROM v_snapshot
    OR (v_cycle.id IS NOT NULL AND v_cycle.engine_idempotency_key IS DISTINCT FROM p_input->>'idempotencyKey') THEN
     RAISE EXCEPTION 'stock_wait_recovery_snapshot_mismatch';
   END IF;
 END IF;
 IF v_cycle.id IS NOT NULL THEN
   IF v_cycle.template_snapshot IS DISTINCT FROM p_input->'templateSnapshot'
    OR v_cycle.pricing_snapshot IS DISTINCT FROM p_input->'pricingSnapshot'
    OR v_order.metadata->'orderSnapshot' IS DISTINCT FROM v_snapshot THEN
     RAISE EXCEPTION 'stock_wait_frozen_snapshot_mismatch';
   END IF;
 ELSIF public.subscription_current_template_snapshot(v_sub) IS DISTINCT FROM p_input->'templateSnapshot' THEN
   RAISE EXCEPTION 'stock_wait_template_binding_changed';
 END IF;
 v_deficits := public.subscription_stock_wait_deficits(v_snapshot,v_order.id,p_now);
 IF jsonb_array_length(v_deficits)=0 THEN
   v_prior_order_id := v_order.id;
   BEGIN
     v_response := public.subscription_create_cycle_order_with_outbox(p_input->>'idempotencyKey',v_sub,
      (p_input->>'cycleNumber')::integer,v_at,p_input->'templateSnapshot',p_input->'pricingSnapshot',v_snapshot);
     SELECT * INTO v_order FROM public.commerce_orders WHERE id=replace(v_response#>>'{subscriptionCycleOrder,orderId}','order_','')::uuid FOR UPDATE;
     -- Reacquire all missing lines in one subtransaction. Existing commitments survive a failed attempt.
     FOR v_item IN SELECT id,sku_id,quantity FROM public.commerce_order_items
       WHERE order_id=v_order.id ORDER BY sku_id,id LOOP
       SELECT COALESCE(sum(quantity),0) INTO v_own FROM public.inventory_reservations
        WHERE order_id=v_order.id AND order_item_id=v_item.id AND sku_id=v_item.sku_id AND status='reserved'
         AND metadata->>'providerKind'='omnipack' AND (expires_at IS NULL OR expires_at>p_now);
       IF v_own<v_item.quantity THEN
         -- A released/expired hold changes the generation even when the clock is unchanged.
         SELECT md5(COALESCE(string_agg(r.id::text||':'||r.status||':'||COALESCE(r.expires_at::text,''),',' ORDER BY r.id),''))
          INTO v_generation FROM public.inventory_reservations r WHERE r.order_id=v_order.id AND r.order_item_id=v_item.id;
         PERFORM public.inventory_reserve_order('stock-wait-reacquire:'||v_order.id::text||':'||v_item.id::text||':'||v_generation,
          v_order.id,v_item.id,v_order.subscription_cycle_id,v_item.sku_id,v_item.quantity-v_own,
          'subscription_retry_window','created',p_now+interval '72 hours',jsonb_build_object('source','subscription_stock_wait'), 'omnipack');
       END IF;
       SELECT COALESCE(sum(quantity),0) INTO v_own FROM public.inventory_reservations
        WHERE order_id=v_order.id AND order_item_id=v_item.id AND sku_id=v_item.sku_id AND status='reserved'
         AND metadata->>'providerKind'='omnipack' AND (expires_at IS NULL OR expires_at>p_now);
       IF v_own<v_item.quantity THEN RAISE EXCEPTION 'stock_wait_reservation_commitment_missing'; END IF;
     END LOOP;
   EXCEPTION WHEN check_violation THEN
     GET STACKED DIAGNOSTICS v_error=MESSAGE_TEXT;
     IF v_error NOT IN ('inventory_external_provider_insufficient_available_stock','inventory_reservation_insufficient_available_stock') THEN RAISE; END IF;
     v_response := NULL;
     SELECT * INTO v_order FROM public.commerce_orders WHERE id=v_prior_order_id;
     v_deficits := public.subscription_stock_wait_deficits(v_snapshot,v_order.id,p_now);
     IF jsonb_array_length(v_deficits)=0 THEN RAISE EXCEPTION 'stock_wait_shortage_evidence_mismatch'; END IF;
   END;
 END IF;
 IF jsonb_array_length(v_deficits)>0 THEN
   INSERT INTO public.subscription_stock_wait_cases(subscription_id,client_id,scheduled_at,state,cycle_number,
     due_snapshot,template_snapshot,pricing_snapshot,order_snapshot,fingerprint,deficits,cycle_id,order_id,last_checked_at)
   VALUES(v_sub,v_subscription.client_id,v_at,'waiting',(p_input->>'cycleNumber')::integer,p_due,
     p_input->'templateSnapshot',p_input->'pricingSnapshot',v_snapshot,v_fingerprint,v_deficits,v_cycle.id,v_order.id,p_now)
   ON CONFLICT(subscription_id,scheduled_at) DO UPDATE SET state='waiting',deficits=EXCLUDED.deficits,
    last_checked_at=p_now,block_reason=NULL RETURNING * INTO v_case;
   PERFORM public.subscription_stock_wait_enqueue(v_case,'started');
   RETURN jsonb_build_object('waiting',true,'caseId',v_case.id);
 END IF;
 IF v_case.id IS NOT NULL THEN
   UPDATE public.subscription_stock_wait_cases SET state='stock_secured',deficits='[]',last_checked_at=p_now,
    stock_secured_at=COALESCE(stock_secured_at,p_now),cycle_id=v_order.subscription_cycle_id,order_id=v_order.id,block_reason=NULL
    WHERE id=v_case.id RETURNING * INTO v_case;
 END IF;
 RETURN v_response||jsonb_build_object('waiting',false,'caseId',v_case.id,
  'binding',jsonb_build_object('caseId',v_case.id,'cycleId',v_order.subscription_cycle_id,'orderId',v_order.id,
   'paymentId',replace(v_response#>>'{subscriptionCycleOrder,paymentId}','payment_','')::uuid,
   'engineIdempotencyKey',p_input->>'idempotencyKey'));
EXCEPTION WHEN OTHERS THEN
 -- A busy stock lock is transient: preserve 55P03 for the next-run deferral.
 IF SQLSTATE='55P03' THEN RAISE; END IF;
 IF v_case.id IS NULL THEN RAISE; END IF;
 UPDATE public.subscription_stock_wait_cases SET block_reason='stock_wait_check_failed',last_checked_at=p_now
  WHERE id=v_case.id;
 RETURN jsonb_build_object('error','stock_wait_check_failed','caseId',v_case.id);
END; $$;

CREATE FUNCTION public.subscription_stock_wait_candidates(p_limit integer DEFAULT 50,p_now timestamptz DEFAULT now())
RETURNS SETOF jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_row record; v_literal text; v_prefix text; v_instant timestamptz; v_binding jsonb;
BEGIN
 UPDATE public.subscription_stock_wait_cases c SET state='closed',closed_at=p_now,block_reason='cancelled_or_superseded'
 FROM public.subscriptions s WHERE s.id=c.subscription_id AND c.state IN ('waiting','stock_secured')
  AND (s.status='cancelled' OR s.next_cycle_at IS DISTINCT FROM c.scheduled_at)
  AND NOT EXISTS(SELECT 1 FROM public.commerce_orders o WHERE o.id=c.order_id AND o.status IN ('paid','fulfillment_pending','fulfilled'))
  AND NOT EXISTS(SELECT 1 FROM public.commerce_payment_intents i JOIN public.commerce_payment_attempts a ON a.payment_intent_id=i.id WHERE i.order_id=c.order_id);
 FOR v_row IN
  WITH opportunities AS (
   SELECT s.id subscription_id,s.client_id,c.scheduled_at,c.id case_id,cycle.id cycle_id,o.id order_id,cycle.payment_id,
    cycle.engine_idempotency_key,COALESCE(o.currency,c.due_snapshot->>'currency',s.currency) currency,c.due_snapshot,
    c.last_selected_at selected_at,c.last_checked_at checked_at,c.id identity_id
   FROM public.subscription_stock_wait_cases c JOIN public.subscriptions s ON s.id=c.subscription_id
   LEFT JOIN public.subscription_cycles cycle ON cycle.subscription_id=s.id AND cycle.scheduled_at=c.scheduled_at
   LEFT JOIN public.commerce_orders o ON o.id=cycle.order_id
   WHERE c.state IN ('waiting','stock_secured') AND s.status='active' AND s.client_id=c.client_id
    AND s.next_cycle_at=c.scheduled_at AND c.scheduled_at<=p_now
    AND (cycle.id IS NULL OR (cycle.status='payment_pending' AND cycle.paid_at IS NULL
      AND (cycle.renewal_quarantined_until IS NULL OR cycle.renewal_quarantined_until<=p_now)))
    AND (o.id IS NULL OR (o.status='pending_payment' AND COALESCE(o.metadata->>'paymentStatus','pending')='pending'))
   UNION ALL
   SELECT s.id,s.client_id,cycle.scheduled_at,NULL::uuid,cycle.id,o.id,cycle.payment_id,cycle.engine_idempotency_key,
    o.currency,'{}'::jsonb,cycle.updated_at,cycle.created_at,cycle.id
   FROM public.subscription_cycles cycle JOIN public.subscriptions s ON s.id=cycle.subscription_id
   JOIN public.commerce_orders o ON o.id=cycle.order_id
   WHERE s.status='active' AND s.next_cycle_at=cycle.scheduled_at AND cycle.scheduled_at<=p_now
    AND cycle.status='payment_pending' AND cycle.paid_at IS NULL AND o.status='pending_payment'
    AND COALESCE(o.metadata->>'paymentStatus','pending')='pending'
    AND (cycle.renewal_quarantined_until IS NULL OR cycle.renewal_quarantined_until<=p_now)
    AND NOT EXISTS(SELECT 1 FROM public.subscription_stock_wait_cases c WHERE c.subscription_id=s.id AND c.scheduled_at=cycle.scheduled_at)
  ), selected AS (
   SELECT candidate.* FROM opportunities candidate
   WHERE NOT EXISTS(SELECT 1 FROM public.commerce_payments p WHERE p.order_id=candidate.order_id
     AND (p.status<>'pending' OR p.provider_payment_id IS NOT NULL OR p.provider<>'own_engine_payment'))
    AND NOT EXISTS(SELECT 1 FROM public.commerce_payment_intents i WHERE i.order_id=candidate.order_id
     AND (i.status<>'created' OR i.active_attempt_id IS NOT NULL OR i.provider_payment_id IS NOT NULL))
    AND NOT EXISTS(SELECT 1 FROM public.commerce_payment_attempts a WHERE a.payment_id IN
     (SELECT p.id FROM public.commerce_payments p WHERE p.order_id=candidate.order_id)
     OR a.payment_intent_id IN(SELECT i.id FROM public.commerce_payment_intents i WHERE i.order_id=candidate.order_id))
   ORDER BY selected_at NULLS FIRST,checked_at,identity_id LIMIT greatest(1,least(p_limit,50))
  ) SELECT selected.*,cl.email,cl.first_name,cl.last_name,m.provider_kind,m.provider_customer_ref,m.provider_method_ref,
   m.method_kind,m.status method_status,m.active method_active,m.expires_at method_expires_at,m.client_id method_client_id
  FROM selected JOIN public.clients cl ON cl.id=selected.client_id
  LEFT JOIN LATERAL(SELECT pm.* FROM public.commerce_payment_method_refs pm WHERE pm.subscription_id=selected.subscription_id
   ORDER BY (pm.active AND pm.status='active') DESC,pm.active DESC,pm.updated_at DESC,pm.created_at DESC LIMIT 1) m ON true
  ORDER BY selected.selected_at NULLS FIRST,selected.checked_at,selected.identity_id
 LOOP
  IF v_row.case_id IS NOT NULL THEN
   PERFORM 1 FROM public.subscription_stock_wait_cases WHERE id=v_row.case_id FOR UPDATE SKIP LOCKED;
   IF NOT FOUND THEN CONTINUE; END IF;
   UPDATE public.subscription_stock_wait_cases SET last_selected_at=p_now WHERE id=v_row.case_id;
  ELSE
   PERFORM 1 FROM public.subscription_cycles WHERE id=v_row.cycle_id FOR UPDATE SKIP LOCKED;
   IF NOT FOUND THEN CONTINUE; END IF;
   UPDATE public.subscription_cycles SET updated_at=p_now WHERE id=v_row.cycle_id;
  END IF;
  v_literal := COALESCE(v_row.due_snapshot->>'nextCycleAt',v_row.scheduled_at::text);
  IF v_row.cycle_id IS NOT NULL THEN
   v_prefix := 'subscription:'||v_row.subscription_id::text||':cycle:';
   IF left(v_row.engine_idempotency_key,length(v_prefix))=v_prefix THEN
    BEGIN
     v_instant := substr(v_row.engine_idempotency_key,length(v_prefix)+1)::timestamptz;
     IF v_instant=v_row.scheduled_at THEN v_literal:=substr(v_row.engine_idempotency_key,length(v_prefix)+1); END IF;
    EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
     -- Keep a valid row anchor so frozen-read refusal reaches row diagnostics
     -- and quarantine instead of invalidating the entire candidate array.
     v_literal:=v_row.scheduled_at::text;
    END;
   END IF;
  END IF;
  v_binding := jsonb_build_object('caseId',v_row.case_id,'cycleId',v_row.cycle_id,'orderId',v_row.order_id,
   'paymentId',v_row.payment_id,'engineIdempotencyKey',v_row.engine_idempotency_key);
  RETURN NEXT v_row.due_snapshot||jsonb_build_object('subscriptionId',v_row.subscription_id,'clientId',v_row.client_id,
   'nextCycleAt',v_literal,'currency',v_row.currency,'stockWaitRecovery',v_binding,'providerKind',COALESCE(v_row.provider_kind,''),
   'providerCustomerRef',v_row.provider_customer_ref,'providerMethodRef',v_row.provider_method_ref,'methodKind',COALESCE(v_row.method_kind,''),
   'methodStatus',v_row.method_status,'methodActive',v_row.method_active,'methodExpiresAt',v_row.method_expires_at,'methodClientId',v_row.method_client_id,
   'payerEmail',v_row.email,'payerName',NULLIF(btrim(concat_ws(' ',v_row.first_name,v_row.last_name)),''));
 END LOOP;
END; $$;

CREATE FUNCTION public.subscription_stock_wait_mark_resumed(p_order_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_case public.subscription_stock_wait_cases%ROWTYPE; v_order public.commerce_orders%ROWTYPE;
 v_fulfillment public.commerce_fulfillment_orders%ROWTYPE;
BEGIN
 SELECT * INTO v_case FROM public.subscription_stock_wait_cases WHERE order_id=p_order_id;
 IF NOT FOUND THEN RETURN NULL; END IF;
 -- Same subscription -> case -> order lock order as renewal admission.
 PERFORM 1 FROM public.subscriptions WHERE id=v_case.subscription_id FOR UPDATE;
 SELECT * INTO v_case FROM public.subscription_stock_wait_cases WHERE order_id=p_order_id FOR UPDATE;
 SELECT * INTO v_order FROM public.commerce_orders WHERE id=p_order_id FOR UPDATE;
 SELECT * INTO v_fulfillment FROM public.commerce_fulfillment_orders WHERE order_id=p_order_id FOR UPDATE;
 IF v_case.state='closed' OR v_order.status='pending_payment' THEN RETURN NULL; END IF;
 IF v_case.state NOT IN ('stock_secured','resumed') OR v_order.status NOT IN ('paid','fulfillment_pending','fulfilled')
  OR v_fulfillment.id IS NULL OR v_fulfillment.status NOT IN ('created','packed','label_pending','label_created','handed_over','in_transit','delivered') THEN
   RAISE EXCEPTION 'stock_wait_realization_admission_missing';
 END IF;
 IF v_case.state='resumed' AND v_case.fulfillment_id IS DISTINCT FROM v_fulfillment.id THEN
   RAISE EXCEPTION 'stock_wait_fulfillment_replay_mismatch';
 END IF;
 IF EXISTS(SELECT 1 FROM public.commerce_order_holds WHERE order_id=p_order_id AND status='active') THEN
   RAISE EXCEPTION 'stock_wait_realization_active_hold';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.subscription_cycles c WHERE c.id=v_case.cycle_id AND c.order_id=p_order_id AND c.status='paid')
  OR NOT EXISTS(SELECT 1 FROM public.commerce_payment_intents i WHERE i.order_id=p_order_id AND i.status='succeeded') THEN
   RAISE EXCEPTION 'stock_wait_paid_evidence_missing';
 END IF;
 IF EXISTS(SELECT 1 FROM public.commerce_order_items item WHERE item.order_id=p_order_id AND
   item.quantity>(SELECT COALESCE(sum(r.quantity),0) FROM public.inventory_reservations r WHERE r.order_id=p_order_id
    AND r.order_item_id=item.id AND r.sku_id=item.sku_id AND metadata->>'providerKind'='omnipack'
    AND (r.status='consumed' OR (r.status='reserved' AND (r.expires_at IS NULL OR r.expires_at>now()))))) THEN
   RAISE EXCEPTION 'stock_wait_paid_inventory_missing';
 END IF;
 IF v_case.state='resumed' THEN RETURN public.subscription_stock_wait_projection(v_case); END IF;
 UPDATE public.subscription_stock_wait_cases SET state='resumed',resumed_at=now(),fulfillment_id=v_fulfillment.id
  WHERE id=v_case.id RETURNING * INTO v_case;
 PERFORM public.subscription_stock_wait_enqueue(v_case,'resumed');
 RETURN public.subscription_stock_wait_projection(v_case);
END; $$;

CREATE FUNCTION public.subscription_stock_wait_normal_due(p_limit integer DEFAULT 50,p_now timestamptz DEFAULT now())
RETURNS SETOF jsonb LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog,public AS $$
 SELECT jsonb_build_object('subscriptionId',d.subscription_id,'clientId',d.client_id,
 'nextCycleAt',d.next_cycle_at,'currency',d.currency,'providerKind',COALESCE(d.provider_kind,''),
 'providerCustomerRef',d.provider_customer_ref,'providerMethodRef',d.provider_method_ref,'methodKind',d.method_kind,
 'payerEmail',d.payer_email,'payerName',d.payer_name,'methodStatus',d.method_status,'methodActive',d.method_active,
 'methodExpiresAt',d.method_expires_at,'methodClientId',d.method_client_id)
 FROM public.subscription_list_due_for_renewal(greatest(1,least(p_limit,50)),p_now) d
 ORDER BY d.next_cycle_at,d.subscription_id LIMIT greatest(1,least(p_limit,50));
$$;

CREATE FUNCTION public.subscription_stock_wait_summary(p_state text DEFAULT 'waiting')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF p_state NOT IN ('all','waiting','stock_secured','resumed','closed') THEN RAISE EXCEPTION 'stock_wait_summary_state_invalid'; END IF;
 RETURN jsonb_build_object('totalCount',(SELECT count(*) FROM public.subscription_stock_wait_cases c WHERE p_state='all' OR c.state=p_state),
  'productTotals',COALESCE((SELECT jsonb_agg(jsonb_build_object('sku',sku,'productName',product_name,'missingUnits',missing_units,'affectedCases',affected_cases) ORDER BY sku)
   FROM (SELECT line->>'sku' sku,min(line->>'productName') product_name,sum((line->>'missingUnits')::integer) missing_units,count(DISTINCT c.id) affected_cases
    FROM public.subscription_stock_wait_cases c CROSS JOIN LATERAL jsonb_array_elements(c.deficits) line
    WHERE (p_state='all' OR c.state=p_state) AND (line->>'missingUnits')::integer>0 GROUP BY line->>'sku') totals),'[]'::jsonb));
END; $$;

CREATE FUNCTION public.subscription_stock_wait_bind_notice(p_case_id uuid,p_event_id uuid,p_message jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE v_case public.subscription_stock_wait_cases%ROWTYPE;v_existing jsonb;
BEGIN
 SELECT * INTO v_case FROM public.subscription_stock_wait_cases WHERE id=p_case_id FOR UPDATE;
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM public.outbox_events e WHERE e.id=p_event_id AND e.aggregate_id=p_case_id
   AND e.aggregate_type='subscription_stock_wait' AND e.event_type IN ('subscription_stock_wait.started','subscription_stock_wait.resumed')) THEN
  RAISE EXCEPTION 'stock_wait_notice_binding_invalid';
 END IF;
 v_existing:=v_case.notice_messages->p_event_id::text;
 IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
 IF jsonb_typeof(p_message)<>'object' OR EXISTS(SELECT 1 FROM unnest(ARRAY['from','to','subject','html']) key WHERE nullif(btrim(p_message->>key),'') IS NULL) THEN
  RAISE EXCEPTION 'stock_wait_notice_message_invalid';
 END IF;
 UPDATE public.subscription_stock_wait_cases SET notice_messages=jsonb_set(notice_messages,ARRAY[p_event_id::text],p_message) WHERE id=p_case_id;
 RETURN p_message;
END; $$;

REVOKE ALL ON FUNCTION public.subscription_stock_wait_projection(public.subscription_stock_wait_cases) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.subscription_stock_wait_projection(public.subscription_stock_wait_cases) TO service_role;
REVOKE ALL ON FUNCTION public.subscription_stock_wait_read(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.subscription_stock_wait_read(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.subscription_stock_wait_frozen(uuid,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.subscription_stock_wait_frozen(uuid,timestamptz) TO service_role;
REVOKE ALL ON FUNCTION public.subscription_stock_wait_deficits(jsonb,uuid,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.subscription_stock_wait_deficits(jsonb,uuid,timestamptz) TO service_role;
REVOKE ALL ON FUNCTION public.subscription_stock_wait_enqueue(public.subscription_stock_wait_cases,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.subscription_stock_wait_enqueue(public.subscription_stock_wait_cases,text) TO service_role;
REVOKE ALL ON FUNCTION public.subscription_stock_wait_admit(jsonb,jsonb,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.subscription_stock_wait_admit(jsonb,jsonb,timestamptz) TO service_role;
REVOKE ALL ON FUNCTION public.subscription_stock_wait_candidates(integer,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.subscription_stock_wait_candidates(integer,timestamptz) TO service_role;
REVOKE ALL ON FUNCTION public.subscription_stock_wait_mark_resumed(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.subscription_stock_wait_mark_resumed(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.subscription_stock_wait_normal_due(integer,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.subscription_stock_wait_normal_due(integer,timestamptz) TO service_role;
REVOKE ALL ON FUNCTION public.subscription_stock_wait_summary(text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.subscription_stock_wait_summary(text) TO service_role;
REVOKE ALL ON FUNCTION public.subscription_stock_wait_bind_notice(uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.subscription_stock_wait_bind_notice(uuid,uuid,jsonb) TO service_role;
