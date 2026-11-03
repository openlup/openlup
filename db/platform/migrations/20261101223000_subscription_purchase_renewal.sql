-- Native purchase-to-renewal attachment. Service activation and renewal materialization
-- are separate durable duties: a failed materializer never pauses customer service.
-- The activation signature and its payment-truth checks remain unchanged. Only its
-- native commit helper records the attachment duty. No managed SQL is replaced.
-- Runtime uses bounded readers/writers; neither new table exposes direct access.
-- Existing term-line INSERT/DELETE grants remain for incumbent collection writers.

ALTER TABLE public.subscription_method_states ADD COLUMN method_ref text, ADD COLUMN evidence_ref text;

CREATE TABLE public.subscription_renewal_attachments (
  order_id uuid PRIMARY KEY REFERENCES public.commerce_orders(id),
  subscription_id uuid UNIQUE REFERENCES public.subscriptions(id),
  purchase_facts jsonb,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (purchase_facts IS NULL OR jsonb_typeof(purchase_facts) = 'object'),
  CHECK (completed_at IS NULL OR (subscription_id IS NOT NULL AND purchase_facts IS NOT NULL))
);

CREATE TABLE public.subscription_method_state_events (
  event_key text PRIMARY KEY CHECK (char_length(event_key) BETWEEN 8 AND 180),
  subscription_id uuid NOT NULL REFERENCES public.subscriptions(id),
  input jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Bounded, replay-stable purchase facts, accepted before activation. The caller is
-- trusted server composition, not a browser or a mandate verification endpoint.
CREATE FUNCTION public.subscription_register_renewal_purchase(p_order_id uuid, p_facts jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_row public.subscription_renewal_attachments; v_line jsonb; v_key text;
  v_activation public.subscription_activations; v_order public.commerce_orders;
BEGIN
  SELECT * INTO v_order FROM public.commerce_orders WHERE id=p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'subscription_renewal_purchase_order_missing' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_activation FROM public.subscription_activations WHERE order_id=p_order_id FOR UPDATE;
  IF NOT FOUND OR v_activation.state='compensated' THEN
    RAISE EXCEPTION 'subscription_renewal_purchase_not_declared' USING ERRCODE='22023'; END IF;
  IF p_facts IS NULL OR jsonb_typeof(p_facts) IS DISTINCT FROM 'object'
    OR p_facts - ARRAY['settlementChannelKey','authorizationRef','unattendedChargeAuthorizedAt','payerAccountRef',
      'methodRef','methodEvidenceRef','stockSourceKey','templateId','cadenceDays','currency',
      'lines','shippingAmountMinor','acquisitionRef'] <> '{}'::jsonb THEN
    RAISE EXCEPTION 'subscription_renewal_purchase_invalid' USING ERRCODE='22023'; END IF;
  FOREACH v_key IN ARRAY ARRAY['settlementChannelKey','authorizationRef','methodRef','methodEvidenceRef','stockSourceKey','templateId'] LOOP
    IF jsonb_typeof(p_facts->v_key) IS DISTINCT FROM 'string' OR char_length(btrim(p_facts->>v_key)) NOT BETWEEN 1 AND 180 THEN
      RAISE EXCEPTION 'subscription_renewal_purchase_invalid' USING ERRCODE='22023'; END IF;
  END LOOP;
  -- This writer does not create a real mandate. Native real-PSP setup remains unavailable.
  IF p_facts->>'settlementChannelKey' IS DISTINCT FROM 'sandbox' OR p_facts->>'stockSourceKey' !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'
    OR p_facts->>'currency' !~ '^[A-Z]{3}$' OR p_facts->>'currency' IS NULL
    OR NOT coalesce(p_facts->>'cadenceDays' ~ '^[1-9][0-9]*$',false)
    OR jsonb_typeof(p_facts->'cadenceDays') IS DISTINCT FROM 'number'
    OR (p_facts->>'cadenceDays')::numeric IS DISTINCT FROM v_activation.cadence_days::numeric
    OR NOT coalesce(p_facts->>'shippingAmountMinor' ~ '^[0-9]+$',false)
    OR jsonb_typeof(p_facts->'shippingAmountMinor') IS DISTINCT FROM 'number'
    OR (p_facts->>'shippingAmountMinor')::numeric <> 0
    OR jsonb_typeof(p_facts->'unattendedChargeAuthorizedAt') IS DISTINCT FROM 'string'
    OR NOT isfinite((p_facts->>'unattendedChargeAuthorizedAt')::timestamptz)
    OR jsonb_typeof(p_facts->'lines') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'subscription_renewal_purchase_invalid' USING ERRCODE='22023'; END IF;
  FOREACH v_key IN ARRAY ARRAY['payerAccountRef','acquisitionRef'] LOOP
    IF NOT (p_facts ? v_key) OR (p_facts->v_key <> 'null'::jsonb AND
      (jsonb_typeof(p_facts->v_key) <> 'string' OR char_length(btrim(p_facts->>v_key)) NOT BETWEEN 1 AND 180)) THEN
      RAISE EXCEPTION 'subscription_renewal_purchase_invalid' USING ERRCODE='22023'; END IF;
  END LOOP;
  IF jsonb_array_length(p_facts->'lines') NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'subscription_renewal_purchase_invalid' USING ERRCODE='22023'; END IF;
  FOR v_line IN SELECT value FROM jsonb_array_elements(p_facts->'lines') LOOP
    IF jsonb_typeof(v_line) IS DISTINCT FROM 'object' OR v_line - ARRAY['lineOrdinal','sku','quantity','unitAmountMinor'] <> '{}'::jsonb
      OR jsonb_typeof(v_line->'sku') IS DISTINCT FROM 'string' OR char_length(btrim(v_line->>'sku')) NOT BETWEEN 1 AND 180
      OR NOT coalesce(v_line->>'lineOrdinal' ~ '^[1-9][0-9]*$',false)
      OR NOT coalesce(v_line->>'quantity' ~ '^[1-9][0-9]*$',false)
      OR NOT coalesce(v_line->>'unitAmountMinor' ~ '^[0-9]+$',false)
      OR jsonb_typeof(v_line->'lineOrdinal') IS DISTINCT FROM 'number'
      OR jsonb_typeof(v_line->'quantity') IS DISTINCT FROM 'number'
      OR jsonb_typeof(v_line->'unitAmountMinor') IS DISTINCT FROM 'number'
      OR (v_line->>'lineOrdinal')::numeric > 2147483647 OR (v_line->>'quantity')::numeric > 2147483647
      OR (v_line->>'unitAmountMinor')::numeric > 9007199254740991 THEN
      RAISE EXCEPTION 'subscription_renewal_purchase_invalid' USING ERRCODE='22023'; END IF;
  END LOOP;
  IF (SELECT count(DISTINCT value->>'sku') FROM jsonb_array_elements(p_facts->'lines')) <> jsonb_array_length(p_facts->'lines')
    OR (SELECT count(DISTINCT (value->>'lineOrdinal')::integer) FROM jsonb_array_elements(p_facts->'lines')) <> jsonb_array_length(p_facts->'lines')
    OR (SELECT sum((value->>'quantity')::numeric*(value->>'unitAmountMinor')::numeric) FROM jsonb_array_elements(p_facts->'lines')) NOT BETWEEN 1 AND 9007199254740991 THEN
    RAISE EXCEPTION 'subscription_renewal_purchase_invalid' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_row FROM public.subscription_renewal_attachments WHERE order_id=p_order_id FOR UPDATE;
  IF FOUND AND v_row.purchase_facts IS NOT NULL THEN
    IF v_row.purchase_facts IS DISTINCT FROM p_facts THEN
      RAISE EXCEPTION 'subscription_renewal_purchase_conflict' USING ERRCODE='23505'; END IF;
    RETURN jsonb_build_object('orderId',p_order_id,'replayed',true);
  END IF;
  INSERT INTO public.subscription_renewal_attachments(order_id,subscription_id,purchase_facts)
    VALUES(p_order_id,v_activation.subscription_id,p_facts)
    ON CONFLICT(order_id) DO UPDATE SET purchase_facts=excluded.purchase_facts;
  RETURN jsonb_build_object('orderId',p_order_id,'replayed',false);
END; $$;

CREATE FUNCTION public.subscription_capture_renewal_attachment(p_order_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_subscription_id uuid;
BEGIN
  SELECT subscription_id INTO v_subscription_id FROM public.subscription_activations
    WHERE order_id=p_order_id AND state='active';
  IF v_subscription_id IS NULL THEN
    RAISE EXCEPTION 'subscription_renewal_attachment_not_active' USING ERRCODE='22023'; END IF;
  INSERT INTO public.subscription_renewal_attachments(order_id,subscription_id)
    VALUES(p_order_id,v_subscription_id)
    ON CONFLICT(order_id) DO UPDATE SET subscription_id=excluded.subscription_id;
END; $$;

CREATE FUNCTION public.subscription_complete_renewal_attachment(p_order_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_row public.subscription_renewal_attachments; v_activation public.subscription_activations; v_facts jsonb;
BEGIN
  PERFORM 1 FROM public.commerce_orders WHERE id=p_order_id FOR UPDATE;
  SELECT * INTO v_activation FROM public.subscription_activations WHERE order_id=p_order_id FOR UPDATE;
  SELECT * INTO v_row FROM public.subscription_renewal_attachments WHERE order_id=p_order_id FOR UPDATE;
  IF NOT FOUND OR v_row.subscription_id IS NULL OR v_activation.state IS DISTINCT FROM 'active' OR v_row.purchase_facts IS NULL THEN
    RAISE EXCEPTION 'subscription_renewal_attachment_not_ready' USING ERRCODE='22023'; END IF;
  IF v_row.completed_at IS NOT NULL THEN
    RETURN jsonb_build_object('subscriptionId',v_row.subscription_id,'replayed',true); END IF;
  v_facts:=v_row.purchase_facts;
  INSERT INTO public.subscription_renewal_terms(subscription_id,currency_code,stock_source_key,settlement_channel_key,
    unattended_charge_authorized_at,authorization_ref,payer_account_ref)
    VALUES(v_row.subscription_id,v_facts->>'currency',v_facts->>'stockSourceKey',v_facts->>'settlementChannelKey',
      (v_facts->>'unattendedChargeAuthorizedAt')::timestamptz,v_facts->>'authorizationRef',v_facts->>'payerAccountRef');
  INSERT INTO public.subscription_renewal_term_lines(subscription_id,line_ordinal,sku,quantity,unit_amount_minor)
    SELECT v_row.subscription_id,(value->>'lineOrdinal')::integer,value->>'sku',(value->>'quantity')::integer,
      (value->>'unitAmountMinor')::bigint FROM jsonb_array_elements(v_facts->'lines');
  INSERT INTO public.subscription_method_states(subscription_id,health_state,method_ref,evidence_ref)
    VALUES(v_row.subscription_id,'healthy',v_facts->>'methodRef',v_facts->>'methodEvidenceRef');
  INSERT INTO public.subscription_method_state_events(event_key,subscription_id,input)
    VALUES('purchase:'||p_order_id::text,v_row.subscription_id,jsonb_build_object('methodRef',v_facts->>'methodRef',
      'healthState','healthy','evidenceRef',v_facts->>'methodEvidenceRef'));
  UPDATE public.subscription_renewal_attachments SET completed_at=now() WHERE order_id=p_order_id;
  RETURN jsonb_build_object('subscriptionId',v_row.subscription_id,'replayed',false);
END; $$;

CREATE FUNCTION public.subscription_transition_sandbox_method(p_subscription_id uuid,p_event_key text,
  p_expected_state text,p_health_state text,p_method_ref text,p_evidence_ref text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_input jsonb; v_existing jsonb; v_state text;
BEGIN
  IF p_event_key IS NULL OR char_length(p_event_key) NOT BETWEEN 8 AND 180
    OR p_method_ref IS NULL OR char_length(btrim(p_method_ref)) NOT BETWEEN 1 AND 180
    OR p_evidence_ref IS NULL OR char_length(btrim(p_evidence_ref)) NOT BETWEEN 1 AND 180
    OR p_health_state IS NULL OR p_health_state NOT IN ('healthy','method_missing','mandate_not_chargeable_unattended','pending_activation') THEN
    RAISE EXCEPTION 'subscription_sandbox_method_invalid' USING ERRCODE='22023'; END IF;
  v_input:=jsonb_build_object('expectedState',p_expected_state,'healthState',p_health_state,'methodRef',p_method_ref,'evidenceRef',p_evidence_ref);
  SELECT health_state INTO v_state FROM public.subscription_method_states WHERE subscription_id=p_subscription_id FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM public.subscription_renewal_attachments WHERE subscription_id=p_subscription_id
    AND completed_at IS NOT NULL AND purchase_facts->>'settlementChannelKey'='sandbox') THEN
    RAISE EXCEPTION 'subscription_sandbox_method_missing' USING ERRCODE='22023'; END IF;
  SELECT input INTO v_existing FROM public.subscription_method_state_events WHERE event_key=p_event_key;
  IF FOUND THEN
    IF v_existing IS DISTINCT FROM v_input OR NOT EXISTS(SELECT 1 FROM public.subscription_method_state_events
      WHERE event_key=p_event_key AND subscription_id=p_subscription_id) THEN
      RAISE EXCEPTION 'subscription_sandbox_method_conflict' USING ERRCODE='23505'; END IF;
    RETURN jsonb_build_object('healthState',p_health_state,'replayed',true); END IF;
  IF v_state IS DISTINCT FROM p_expected_state THEN
    RAISE EXCEPTION 'subscription_sandbox_method_stale' USING ERRCODE='40001'; END IF;
  INSERT INTO public.subscription_method_state_events(event_key,subscription_id,input) VALUES(p_event_key,p_subscription_id,v_input);
  UPDATE public.subscription_method_states SET health_state=p_health_state,narrow_activation_gap=(p_health_state='pending_activation'),
    method_ref=p_method_ref,evidence_ref=p_evidence_ref,updated_at=now()
    WHERE subscription_id=p_subscription_id;
  RETURN jsonb_build_object('healthState',p_health_state,'replayed',false);
END; $$;

-- Same native activation transaction plus durable attachment capture.
CREATE OR REPLACE FUNCTION public.subscription_activation_commit(
  p_activation public.subscription_activations,
  p_idempotency_key text,
  p_payment_fingerprint text,
  p_paid_at timestamptz,
  p_repaired boolean
)
RETURNS public.subscription_activations
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_subscription_id uuid;
  v_cycle_id uuid;
  v_next_cycle_at timestamptz;
  v_activated public.subscription_activations%ROWTYPE;
BEGIN
  v_next_cycle_at := p_paid_at + (p_activation.cadence_days * interval '1 day');

  INSERT INTO public.subscriptions
    (client_id, status, cadence_days, next_cycle_at, started_at)
  VALUES (p_activation.client_id, 'active', p_activation.cadence_days, v_next_cycle_at, p_paid_at)
  RETURNING id INTO v_subscription_id;

  -- The cycle the captured payment paid for. It is written as paid because the
  -- money rail already said so; writing it as planned would make the first
  -- renewal ask for the same instant twice.
  INSERT INTO public.subscription_cycles (subscription_id, scheduled_at, status)
  VALUES (v_subscription_id, p_paid_at, 'paid')
  RETURNING id INTO v_cycle_id;

  UPDATE public.commerce_orders
     SET subscription_cycle_id = v_cycle_id, updated_at = p_paid_at
   WHERE id = p_activation.order_id;

  UPDATE public.subscription_activations
     SET state = 'active',
         subscription_id = v_subscription_id,
         payment_fingerprint = p_payment_fingerprint,
         activation_idempotency_key = p_idempotency_key,
         repaired = p_repaired,
         activated_at = p_paid_at
   WHERE order_id = p_activation.order_id
  RETURNING * INTO v_activated;

  INSERT INTO public.subscription_events
    (subscription_id, event_type, idempotency_key, payload, occurred_at)
  VALUES (
    v_subscription_id, 'subscription.activated', p_idempotency_key,
    jsonb_build_object(
      'orderId', p_activation.order_id,
      'cadenceDays', p_activation.cadence_days,
      'nextCycleAt', v_next_cycle_at,
      'repaired', p_repaired),
    p_paid_at)
  ON CONFLICT (subscription_id, idempotency_key) DO NOTHING;

  PERFORM public.subscription_capture_renewal_attachment(p_activation.order_id);
  RETURN v_activated;
END;
$$;

-- Sandbox observations are evidence, not a second attempt record or settlement
-- writer. Terminal application remains the incumbent fenced renewal routine.
CREATE FUNCTION public.subscription_record_sandbox_renewal_observation(p_operation_id uuid,
  p_fingerprint text,p_external_ref text,p_outcome text,p_occurred_at timestamptz)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_op public.subscription_renewal_operations; v_event public.subscription_renewal_outcomes;
BEGIN
  SELECT * INTO v_op FROM public.subscription_renewal_operations WHERE id=p_operation_id FOR UPDATE;
  IF NOT FOUND OR v_op.operation_fingerprint IS DISTINCT FROM p_fingerprint
    OR v_op.cycle_snapshot->>'settlementChannelKey' IS DISTINCT FROM 'sandbox'
    OR v_op.external_attempt_ref IS DISTINCT FROM p_external_ref
    OR p_external_ref IS NULL OR p_external_ref NOT LIKE 'sandbox-renewal:'||p_operation_id::text||':%'
    OR p_outcome IS NULL OR p_outcome NOT IN ('succeeded','refused') OR p_occurred_at IS NULL OR NOT isfinite(p_occurred_at) THEN
    RAISE EXCEPTION 'subscription_sandbox_observation_invalid' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_event FROM public.subscription_renewal_outcomes
    WHERE renewal_operation_id=p_operation_id AND event_key='sandbox-observation:'||p_operation_id::text;
  IF FOUND THEN
    IF v_event.outcome IS DISTINCT FROM p_outcome OR v_event.occurred_at IS DISTINCT FROM p_occurred_at
      OR v_event.external_ref IS DISTINCT FROM p_external_ref OR v_event.operation_fingerprint IS DISTINCT FROM p_fingerprint THEN
      RAISE EXCEPTION 'subscription_sandbox_observation_conflict' USING ERRCODE='23505'; END IF;
    RETURN;
  END IF;
  IF v_op.state IS DISTINCT FROM 'attempt_prepared' THEN
    RAISE EXCEPTION 'subscription_sandbox_observation_terminal' USING ERRCODE='22023'; END IF;
  INSERT INTO public.subscription_renewal_outcomes(renewal_operation_id,operation_fingerprint,event_key,outcome,external_ref,occurred_at)
    VALUES(p_operation_id,p_fingerprint,'sandbox-observation:'||p_operation_id::text,p_outcome,p_external_ref,p_occurred_at);
END; $$;
-- Runtime needs pending identifiers and three snapshot fields, never the raw
-- facts or method-event ledger. These fixed projections keep both new tables closed.
CREATE FUNCTION public.subscription_pending_renewal_attachments(p_limit integer)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('orderId',a.order_id,'subscriptionId',a.subscription_id,
    'hasPurchaseFacts',a.purchase_facts IS NOT NULL) ORDER BY a.created_at,a.order_id),'[]'::jsonb)
  FROM (SELECT order_id,subscription_id,purchase_facts,created_at FROM public.subscription_renewal_attachments
    WHERE completed_at IS NULL AND subscription_id IS NOT NULL ORDER BY created_at,order_id
    LIMIT least(greatest(coalesce(p_limit,100),1),500)) a;
$$;

CREATE FUNCTION public.subscription_renewal_purchase_facts(p_subscription_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT jsonb_build_object('templateId',purchase_facts->'templateId',
    'shippingAmountMinor',purchase_facts->'shippingAmountMinor','acquisitionRef',purchase_facts->'acquisitionRef')
  FROM public.subscription_renewal_attachments
  WHERE subscription_id=p_subscription_id AND completed_at IS NOT NULL;
$$;

REVOKE ALL ON FUNCTION public.subscription_register_renewal_purchase(uuid,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.subscription_capture_renewal_attachment(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.subscription_complete_renewal_attachment(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.subscription_transition_sandbox_method(uuid,text,text,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.subscription_record_sandbox_renewal_observation(uuid,text,text,text,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.subscription_pending_renewal_attachments(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.subscription_renewal_purchase_facts(uuid) FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.subscription_register_renewal_purchase(uuid,jsonb),public.subscription_capture_renewal_attachment(uuid),public.subscription_complete_renewal_attachment(uuid),public.subscription_transition_sandbox_method(uuid,text,text,text,text,text),public.subscription_record_sandbox_renewal_observation(uuid,text,text,text,timestamptz),public.subscription_pending_renewal_attachments(integer),public.subscription_renewal_purchase_facts(uuid) FROM anon'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.subscription_register_renewal_purchase(uuid,jsonb),public.subscription_capture_renewal_attachment(uuid),public.subscription_complete_renewal_attachment(uuid),public.subscription_transition_sandbox_method(uuid,text,text,text,text,text),public.subscription_record_sandbox_renewal_observation(uuid,text,text,text,timestamptz),public.subscription_pending_renewal_attachments(integer),public.subscription_renewal_purchase_facts(uuid) FROM authenticated'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'GRANT EXECUTE ON FUNCTION public.subscription_register_renewal_purchase(uuid,jsonb),public.subscription_capture_renewal_attachment(uuid),public.subscription_complete_renewal_attachment(uuid),public.subscription_transition_sandbox_method(uuid,text,text,text,text,text),public.subscription_record_sandbox_renewal_observation(uuid,text,text,text,timestamptz),public.subscription_pending_renewal_attachments(integer),public.subscription_renewal_purchase_facts(uuid) TO service_role'; END IF; END; $$;

-- Narrow even installer defaults: access is through the bounded functions above.
REVOKE ALL ON TABLE public.subscription_renewal_attachments FROM PUBLIC;
REVOKE ALL ON TABLE public.subscription_method_state_events FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'REVOKE ALL ON TABLE public.subscription_renewal_attachments,public.subscription_method_state_events FROM anon'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'REVOKE ALL ON TABLE public.subscription_renewal_attachments,public.subscription_method_state_events FROM authenticated'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'REVOKE ALL ON TABLE public.subscription_renewal_attachments,public.subscription_method_state_events FROM service_role'; END IF; END; $$;
