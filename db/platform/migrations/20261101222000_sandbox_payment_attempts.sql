-- Sandbox-only durable attempts and verified observations. No real provider store.
-- Captures after cancellation are terminal operator-review facts, never settlement.
ALTER TABLE public.payment_truth_events ADD COLUMN review_required_at timestamptz;
ALTER TABLE public.payment_truth_events ADD CONSTRAINT payment_truth_events_review_terminal_check CHECK (
  review_required_at IS NULL OR (state = 'open' AND outcome = 'captured'
    AND settlement_transition_id IS NULL AND settled_at IS NULL
    AND dunning_case_id IS NULL AND accounting_document_id IS NULL)
);
CREATE TABLE public.payment_simulator_attempts (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT payment_simulator_attempts_pkey PRIMARY KEY,
  settlement_intent_id uuid NOT NULL CONSTRAINT payment_simulator_attempts_intent_fkey REFERENCES public.commerce_settlement_intents(id),
  request_key text NOT NULL CONSTRAINT payment_simulator_attempts_request_key_key UNIQUE,
  request_fingerprint text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  state text NOT NULL DEFAULT 'dispatched',
  dispatched_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  authorization_ref text NOT NULL,
  unattended_charge_authorized_at timestamptz NOT NULL,
  payer_account_ref text,
  method_ref text NOT NULL,
  method_evidence_ref text NOT NULL,
  last_observation_id uuid,
  CONSTRAINT payment_simulator_attempts_request_key_check CHECK (NOT (btrim(request_key) = '')),
  CONSTRAINT payment_simulator_attempts_fingerprint_check CHECK (char_length(request_fingerprint) = 64),
  CONSTRAINT payment_simulator_attempts_state_check CHECK (state IN ('dispatched','indeterminate','refused','expired','captured')),
  CONSTRAINT payment_simulator_attempts_method_facts_check CHECK (
    NOT (btrim(authorization_ref) = '') AND NOT (btrim(method_ref) = '') AND NOT (btrim(method_evidence_ref) = '')
    AND (payer_account_ref IS NULL OR NOT (btrim(payer_account_ref) = ''))),
  CONSTRAINT payment_simulator_attempts_observation_check CHECK ((state = 'dispatched') = (last_observation_id IS NULL))
);
CREATE UNIQUE INDEX payment_simulator_attempts_one_active_idx ON public.payment_simulator_attempts(settlement_intent_id) WHERE is_active;
CREATE TABLE public.payment_simulator_observations (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT payment_simulator_observations_pkey PRIMARY KEY,
  attempt_id uuid NOT NULL CONSTRAINT payment_simulator_observations_attempt_fkey REFERENCES public.payment_simulator_attempts(id),
  event_key text NOT NULL CONSTRAINT payment_simulator_observations_event_key_key UNIQUE,
  event_fingerprint text NOT NULL,
  outcome text NOT NULL,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_simulator_observations_event_key_check CHECK (NOT (btrim(event_key) = '')),
  CONSTRAINT payment_simulator_observations_fingerprint_check CHECK (char_length(event_fingerprint) = 64),
  CONSTRAINT payment_simulator_observations_outcome_check CHECK (outcome IN ('captured','refused','expired','indeterminate'))
);
ALTER TABLE public.payment_simulator_attempts ADD CONSTRAINT payment_simulator_attempts_last_observation_fkey
  FOREIGN KEY(last_observation_id) REFERENCES public.payment_simulator_observations(id);
CREATE INDEX payment_simulator_observations_attempt_idx ON public.payment_simulator_observations(attempt_id,created_at,id);


REVOKE ALL ON TABLE public.payment_simulator_attempts FROM PUBLIC;
REVOKE ALL ON TABLE public.payment_simulator_observations FROM PUBLIC;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    EXECUTE 'REVOKE ALL ON TABLE public.payment_simulator_attempts,public.payment_simulator_observations FROM anon';
  END IF;
END; $$;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    EXECUTE 'REVOKE ALL ON TABLE public.payment_simulator_attempts,public.payment_simulator_observations FROM authenticated';
  END IF;
END; $$;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
    EXECUTE 'REVOKE ALL ON TABLE public.payment_simulator_attempts,public.payment_simulator_observations FROM service_role';
  END IF;
END; $$;

CREATE FUNCTION public.payment_simulator_read_attempt(p_intent_id uuid,p_attempt_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
 SELECT jsonb_build_object(
  'id',a.id,'settlementIntentId',a.settlement_intent_id,'orderId',i.order_id,
  'settlementChannelKey',i.channel_key,'orderStatus',o.status,'settlementStatus',i.status,
  'requestKey',a.request_key,'requestFingerprint',a.request_fingerprint,'active',a.is_active,
  'state',a.state,'dispatchedAt',a.dispatched_at,
  'methodFacts',jsonb_build_object('authorizationRef',a.authorization_ref,
    'unattendedChargeAuthorizedAt',a.unattended_charge_authorized_at,'payerAccountRef',a.payer_account_ref,
    'methodRef',a.method_ref,'methodEvidenceRef',a.method_evidence_ref),
  'latestObservation',CASE WHEN e.id IS NULL THEN NULL ELSE jsonb_build_object(
    'id',e.id,'eventKey',e.event_key,'fingerprint',e.event_fingerprint,'outcome',e.outcome,
    'occurredAt',e.occurred_at,'recordedAt',e.created_at) END)
 FROM public.payment_simulator_attempts a
 JOIN public.commerce_settlement_intents i ON i.id=a.settlement_intent_id AND i.channel_key='sandbox'
 JOIN public.commerce_orders o ON o.id=i.order_id
 LEFT JOIN public.payment_simulator_observations e ON e.id=a.last_observation_id
 WHERE a.settlement_intent_id=p_intent_id AND ((p_attempt_id IS NULL AND a.is_active) OR a.id=p_attempt_id);
$$;

CREATE FUNCTION public.payment_simulator_begin_attempt(p_request_key text,p_intent_id uuid,p_fingerprint text,p_method_facts jsonb,p_at timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE i public.commerce_settlement_intents%ROWTYPE; o public.commerce_orders%ROWTYPE;
 a public.payment_simulator_attempts%ROWTYPE; facts jsonb;
BEGIN
 IF p_request_key IS NULL OR char_length(btrim(p_request_key))<8 OR p_fingerprint IS NULL
  OR p_fingerprint !~ '^[0-9a-f]{64}$' OR p_at IS NULL OR NOT isfinite(p_at)
  OR p_method_facts IS NULL OR jsonb_typeof(p_method_facts)<>'object' THEN
  RAISE EXCEPTION 'payment_simulator_input_invalid' USING ERRCODE='22023'; END IF;
 SELECT * INTO i FROM public.commerce_settlement_intents WHERE id=p_intent_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'payment_simulator_intent_not_found' USING ERRCODE='22023'; END IF;
 IF i.channel_key<>'sandbox' THEN RAISE EXCEPTION 'native_prepared_attempt_store_unsupported' USING ERRCODE='22023'; END IF;
 SELECT * INTO o FROM public.commerce_orders WHERE id=i.order_id FOR UPDATE;
 SELECT * INTO i FROM public.commerce_settlement_intents WHERE id=p_intent_id FOR UPDATE;
 SELECT * INTO a FROM public.payment_simulator_attempts WHERE request_key=p_request_key;
 IF FOUND THEN
  IF a.settlement_intent_id IS DISTINCT FROM p_intent_id OR a.request_fingerprint IS DISTINCT FROM p_fingerprint
    OR (p_method_facts<>'{}'::jsonb AND p_method_facts IS DISTINCT FROM
      (public.payment_simulator_read_attempt(p_intent_id,a.id)->'methodFacts')) THEN
    RAISE EXCEPTION 'payment_simulator_request_conflict' USING ERRCODE='23505'; END IF;
  RETURN public.payment_simulator_read_attempt(p_intent_id,a.id)||jsonb_build_object('replayed',true);
 END IF;
 IF o.status<>'pending_payment' OR i.status='settled' THEN
  RAISE EXCEPTION 'payment_simulator_order_not_payable' USING ERRCODE='22023'; END IF;
 SELECT * INTO a FROM public.payment_simulator_attempts WHERE settlement_intent_id=p_intent_id AND is_active FOR UPDATE;
 IF FOUND AND a.state NOT IN ('refused','expired') THEN
  RAISE EXCEPTION 'payment_simulator_attempt_unresolved' USING ERRCODE='22023'; END IF;
 IF a.id IS NOT NULL AND EXISTS(SELECT 1 FROM public.payment_truth_events e
   WHERE e.settlement_intent_id=p_intent_id AND e.state='open' AND e.review_required_at IS NULL
     AND e.outcome='indeterminate' AND e.source_evidence->>'attemptRef'=a.id::text) THEN
  RAISE EXCEPTION 'payment_simulator_truth_unresolved' USING ERRCODE='22023'; END IF;
 facts:=CASE WHEN p_method_facts='{}'::jsonb THEN jsonb_build_object(
  'authorizationRef','sandbox:authorization:'||p_intent_id,
  'unattendedChargeAuthorizedAt',p_at,'payerAccountRef','sandbox:payer:'||o.client_id,
  'methodRef','sandbox:method:'||o.client_id,'methodEvidenceRef','sandbox:method-evidence:'||p_intent_id)
 ELSE p_method_facts END;
 IF (SELECT count(*) FROM jsonb_object_keys(facts))<>5
  OR NOT (facts ?& ARRAY['authorizationRef','unattendedChargeAuthorizedAt','payerAccountRef','methodRef','methodEvidenceRef'])
  OR COALESCE(facts->>'authorizationRef','') NOT LIKE 'sandbox:%'
  OR COALESCE(facts->>'methodRef','') NOT LIKE 'sandbox:%'
  OR COALESCE(facts->>'methodEvidenceRef','') NOT LIKE 'sandbox:%'
  OR (facts->>'payerAccountRef' IS NOT NULL AND facts->>'payerAccountRef' NOT LIKE 'sandbox:%')
  OR (facts->>'unattendedChargeAuthorizedAt') IS NULL
  OR NOT isfinite((facts->>'unattendedChargeAuthorizedAt')::timestamptz) THEN
  RAISE EXCEPTION 'payment_simulator_method_facts_invalid' USING ERRCODE='22023'; END IF;
 UPDATE public.payment_simulator_attempts SET is_active=false,updated_at=p_at WHERE id=a.id;
 INSERT INTO public.payment_simulator_attempts(settlement_intent_id,request_key,request_fingerprint,dispatched_at,updated_at,
  authorization_ref,unattended_charge_authorized_at,payer_account_ref,method_ref,method_evidence_ref)
 VALUES(p_intent_id,p_request_key,p_fingerprint,p_at,p_at,facts->>'authorizationRef',
  (facts->>'unattendedChargeAuthorizedAt')::timestamptz,facts->>'payerAccountRef',facts->>'methodRef',facts->>'methodEvidenceRef') RETURNING * INTO a;
 RETURN public.payment_simulator_read_attempt(p_intent_id,a.id)||jsonb_build_object('replayed',false);
END;
$$;

CREATE FUNCTION public.payment_simulator_record_observation(p_attempt_id uuid,p_event_key text,p_fingerprint text,p_outcome text,p_at timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE a public.payment_simulator_attempts%ROWTYPE; e public.payment_simulator_observations%ROWTYPE; order_id uuid;
BEGIN
 IF p_event_key IS NULL OR char_length(btrim(p_event_key))<8 OR p_fingerprint IS NULL OR p_fingerprint !~ '^[0-9a-f]{64}$'
  OR p_outcome IS NULL OR p_outcome NOT IN ('captured','refused','expired','indeterminate') OR p_at IS NULL OR NOT isfinite(p_at) THEN
  RAISE EXCEPTION 'payment_simulator_observation_invalid' USING ERRCODE='22023'; END IF;
 SELECT * INTO a FROM public.payment_simulator_attempts WHERE id=p_attempt_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'wrong_attempt' USING ERRCODE='22023'; END IF;
 SELECT i.order_id INTO order_id FROM public.commerce_settlement_intents i WHERE i.id=a.settlement_intent_id AND i.channel_key='sandbox';
 IF NOT FOUND THEN RAISE EXCEPTION 'native_prepared_attempt_store_unsupported' USING ERRCODE='22023'; END IF;
 PERFORM 1 FROM public.commerce_orders WHERE id=order_id FOR UPDATE;
 PERFORM 1 FROM public.commerce_settlement_intents WHERE id=a.settlement_intent_id FOR UPDATE;
 SELECT * INTO a FROM public.payment_simulator_attempts WHERE id=p_attempt_id FOR UPDATE;
 SELECT * INTO e FROM public.payment_simulator_observations WHERE event_key=p_event_key;
 IF FOUND THEN
  IF e.attempt_id IS DISTINCT FROM a.id OR e.event_fingerprint IS DISTINCT FROM p_fingerprint
   OR e.outcome IS DISTINCT FROM p_outcome OR e.occurred_at IS DISTINCT FROM p_at THEN
   RAISE EXCEPTION 'payment_simulator_observation_conflict' USING ERRCODE='23505'; END IF;
  RETURN jsonb_build_object('id',e.id,'replayed',true);
 END IF;
 IF NOT a.is_active THEN RAISE EXCEPTION 'wrong_attempt' USING ERRCODE='22023'; END IF;
 IF a.state='captured' OR (a.state IN ('refused','expired') AND p_outcome<>'captured') THEN
  RAISE EXCEPTION 'payment_simulator_terminal_observation' USING ERRCODE='22023'; END IF;
 INSERT INTO public.payment_simulator_observations(attempt_id,event_key,event_fingerprint,outcome,occurred_at)
 VALUES(a.id,p_event_key,p_fingerprint,p_outcome,p_at) RETURNING * INTO e;
 UPDATE public.payment_simulator_attempts SET state=p_outcome,last_observation_id=e.id,updated_at=p_at WHERE id=a.id;
 RETURN jsonb_build_object('id',e.id,'replayed',false);
END;
$$;

CREATE FUNCTION public.payment_simulator_assert_truth(p_intent_id uuid,p_outcome text,p_amount bigint,p_currency text,p_at timestamptz,p_evidence jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE i public.commerce_settlement_intents%ROWTYPE; a record; e record;
BEGIN
 SELECT * INTO i FROM public.commerce_settlement_intents WHERE id=p_intent_id;
 -- Generic truth must not depend on simulator storage for any other channel.
 IF i.channel_key IS DISTINCT FROM 'sandbox' THEN RETURN; END IF;
 PERFORM 1 FROM public.commerce_orders WHERE id=i.order_id FOR UPDATE;
 SELECT * INTO i FROM public.commerce_settlement_intents WHERE id=p_intent_id FOR UPDATE;
 SELECT * INTO a FROM public.payment_simulator_attempts WHERE settlement_intent_id=p_intent_id AND is_active FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'wrong_attempt' USING ERRCODE='22023'; END IF;
 SELECT * INTO e FROM public.payment_simulator_observations WHERE id=a.last_observation_id;
 IF NOT FOUND OR p_evidence->>'sourceReference' IS DISTINCT FROM e.id::text
  OR p_evidence->>'attemptRef' IS DISTINCT FROM a.id::text THEN
  RAISE EXCEPTION 'wrong_attempt' USING ERRCODE='22023'; END IF;
 IF p_outcome IS DISTINCT FROM (CASE WHEN e.outcome='expired' THEN 'refused' ELSE e.outcome END)
  OR p_amount IS DISTINCT FROM i.amount_minor OR p_currency IS DISTINCT FROM i.currency_code
  OR p_at IS DISTINCT FROM e.occurred_at OR p_evidence->>'observedStatus' IS DISTINCT FROM e.outcome
  OR p_evidence->>'payloadFingerprint' IS DISTINCT FROM e.event_fingerprint
  OR (p_evidence->>'observedAt')::timestamptz IS DISTINCT FROM e.occurred_at
  OR p_evidence->>'sourceKind' IS NULL OR p_evidence->>'sourceKind' NOT IN ('accepted_event','reconciliation_read') THEN
  RAISE EXCEPTION 'payment_simulator_evidence_mismatch' USING ERRCODE='22023'; END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.payment_truth_readback(
  p_event_id uuid,
  p_replayed boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public, pg_catalog
AS $$
  SELECT jsonb_build_object(
    'event', jsonb_build_object(
      'id', event.id,
      'sourceEventId', event.source_event_id,
      'fingerprint', event.event_fingerprint,
      'state', event.state,
      'reviewRequiredAt', event.review_required_at,
      'applicationStatus', CASE WHEN event.review_required_at IS NOT NULL THEN 'review_required' WHEN event.state='settled' THEN 'applied' ELSE 'awaiting_evidence' END,
      'outcome', event.outcome,
      'replayed', p_replayed
    ),
    'effects', jsonb_build_object(
      'paymentResultRecorded', event.settlement_transition_id IS NOT NULL,
      'dunningOpened', event.dunning_case_id IS NOT NULL,
      'accountingRequested', event.accounting_document_id IS NOT NULL
    ),
    'financial', jsonb_build_object(
      'settlementStatus', settlement.status,
      'orderStatus', order_row.status,
      'subscriptionStatus', subscription.status,
      'accountingStatus', document.status,
      'amountMinor', event.amount_minor,
      'currency', event.currency_code
    )
  )
  FROM public.payment_truth_events event
  JOIN public.commerce_settlement_intents settlement ON settlement.id = event.settlement_intent_id
  JOIN public.commerce_orders order_row ON order_row.id = settlement.order_id
  LEFT JOIN public.subscription_cycles cycle ON cycle.id = order_row.subscription_cycle_id
  LEFT JOIN public.subscriptions subscription ON subscription.id = cycle.subscription_id
  LEFT JOIN public.accounting_documents document ON document.id = event.accounting_document_id
  WHERE event.id = p_event_id;
$$;

CREATE OR REPLACE FUNCTION public.payment_truth_apply_terminal(
  p_event_id uuid,
  p_idempotency_key text,
  p_outcome text,
  p_occurred_at timestamptz,
  p_failure_class text,
  p_failure_reason text,
  p_source_evidence jsonb,
  p_dunning_template_slug text,
  p_recovery_url_path text,
  p_recovery_template_slug text
)
RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_event public.payment_truth_events%ROWTYPE;
  v_intent public.commerce_settlement_intents%ROWTYPE;
  v_order public.commerce_orders%ROWTYPE;
  v_cycle public.subscription_cycles%ROWTYPE;
  v_subscription public.subscriptions%ROWTYPE;
  v_settlement jsonb;
  v_dunning jsonb;
  v_accounting jsonb;
  v_positions jsonb;
  v_open_case_id uuid;
  v_transition_id uuid;
  v_dunning_case_id uuid;
  v_accounting_document_id uuid;
BEGIN
  SELECT * INTO v_event FROM public.payment_truth_events WHERE id = p_event_id;
  PERFORM 1 FROM public.commerce_orders WHERE id=(SELECT order_id FROM public.commerce_settlement_intents WHERE id=v_event.settlement_intent_id) FOR UPDATE;
  PERFORM 1 FROM public.commerce_settlement_intents WHERE id=v_event.settlement_intent_id FOR UPDATE;
  SELECT * INTO v_event FROM public.payment_truth_events WHERE id = p_event_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'payment_truth_event_not_found' USING ERRCODE = '22023'; END IF;
  IF v_event.state = 'settled' OR v_event.review_required_at IS NOT NULL THEN RETURN; END IF;
  IF p_outcome NOT IN ('captured', 'refused') THEN
    RAISE EXCEPTION 'payment_truth_terminal_outcome_invalid' USING ERRCODE = '22023';
  END IF;
  IF p_outcome = 'refused' AND p_failure_class IS NULL THEN
    RAISE EXCEPTION 'payment_truth_refusal_classification_required' USING ERRCODE = '22023';
  END IF;
  IF p_failure_class IS NOT NULL AND p_failure_class NOT IN (
    'authorization_refused', 'insufficient_funds', 'method_unavailable',
    'risk_refused', 'unknown_refusal'
  ) THEN
    RAISE EXCEPTION 'payment_truth_failure_class_invalid' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_intent
    FROM public.commerce_settlement_intents WHERE id = v_event.settlement_intent_id;
  SELECT * INTO v_order FROM public.commerce_orders WHERE id = v_intent.order_id;
  IF v_intent.amount_minor IS DISTINCT FROM v_event.amount_minor
    OR v_intent.currency_code IS DISTINCT FROM v_event.currency_code
  THEN
    RAISE EXCEPTION 'payment_truth_settlement_money_mismatch' USING ERRCODE = '22023';
  END IF;

  IF v_intent.channel_key='sandbox' THEN
    PERFORM public.payment_simulator_assert_truth(v_intent.id,p_outcome,v_event.amount_minor,v_event.currency_code,p_occurred_at,p_source_evidence);
  END IF;
  IF p_outcome='captured' AND v_order.status='cancelled' THEN
    UPDATE public.payment_truth_events SET outcome='captured',failure_class=NULL,failure_reason=NULL,
      review_required_at=now(),updated_at=now()
    WHERE id=v_event.id OR (v_intent.channel_key='sandbox' AND settlement_intent_id=v_intent.id
      AND state='open' AND review_required_at IS NULL AND outcome='indeterminate'
      AND source_evidence->>'attemptRef'=p_source_evidence->>'attemptRef');
    RETURN;
  END IF;

  v_settlement := public.commerce_record_settlement(
    p_idempotency_key || ':settlement',
    v_event.settlement_intent_id,
    CASE WHEN p_outcome = 'captured' THEN 'succeeded' ELSE 'failed' END,
    NULL,
    jsonb_build_object(
      'paymentTruthEventId', v_event.id,
      'sourceEvidence', COALESCE(p_source_evidence, '{}'::jsonb),
      'reason', p_failure_reason,
      'failureClass', p_failure_class
    ),
    p_occurred_at
  );
  v_transition_id := (v_settlement->>'transitionId')::uuid;

  IF p_outcome = 'captured' THEN
    -- Capture owed work only; no document construction or accounting call here.
    DECLARE v_capture_timeout text := current_setting('lock_timeout');
    BEGIN
      PERFORM set_config('lock_timeout', '100ms', true);
      PERFORM public.invoicing_capture_duty(
        p_idempotency_key || ':accounting', 'paid', v_transition_id, v_order.id,
        jsonb_build_object('settlementIntentId', v_intent.id, 'amountMinor', v_intent.amount_minor, 'currency', v_intent.currency_code),
        p_occurred_at
      );
      PERFORM set_config('lock_timeout', v_capture_timeout, true);
    EXCEPTION WHEN OTHERS OR query_canceled THEN
      -- query_canceled during capture is absorbed so settlement/recovery commit.
      -- Append-only, no FK locks or conflicting unique key. The retained paid
      -- transition is also durable retry evidence if host ACLs deny this marker.
      BEGIN
        PERFORM set_config('lock_timeout','100ms',true);
        INSERT INTO public.invoicing_capture_faults(order_id,source_kind,source_id,attempts,state,available_at)
          VALUES(v_order.id,'paid',v_transition_id,1,'retryable',now());
        PERFORM set_config('lock_timeout',v_capture_timeout,true);
      EXCEPTION WHEN OTHERS OR query_canceled THEN NULL;
      END;
    END;

    IF v_order.subscription_cycle_id IS NOT NULL THEN
      SELECT id INTO v_open_case_id
      FROM public.subscription_dunning_cases
      WHERE cycle_id = v_order.subscription_cycle_id AND status = 'open'
      FOR UPDATE;
      IF v_open_case_id IS NOT NULL THEN
        PERFORM public.dunning_lifecycle_record_recovery(
          v_open_case_id, p_occurred_at, p_recovery_template_slug
        );
      END IF;
    END IF;
  ELSE
    IF v_order.subscription_cycle_id IS NOT NULL THEN
      SELECT * INTO v_cycle
        FROM public.subscription_cycles WHERE id = v_order.subscription_cycle_id;
      SELECT * INTO v_subscription
        FROM public.subscriptions WHERE id = v_cycle.subscription_id;
      v_dunning := public.dunning_lifecycle_open_case(
        'payment-truth:dunning:' || v_cycle.id::text,
        v_subscription.id,
        v_cycle.id,
        v_subscription.client_id,
        1,
        NULL,
        p_failure_class,
        p_failure_reason,
        p_occurred_at,
        v_event.amount_minor,
        v_event.currency_code,
        p_dunning_template_slug,
        p_recovery_url_path
      );
      v_dunning_case_id := (v_dunning->>'caseId')::uuid;
    END IF;
  END IF;

  UPDATE public.payment_truth_events
  SET state = 'settled',
      outcome = p_outcome,
      failure_class = CASE WHEN p_outcome = 'refused' THEN p_failure_class ELSE NULL END,
      failure_reason = CASE WHEN p_outcome = 'refused' THEN p_failure_reason ELSE NULL END,
      settlement_transition_id = v_transition_id,
      dunning_case_id = v_dunning_case_id,
      accounting_document_id = v_accounting_document_id,
      settled_at = p_occurred_at,
      updated_at = p_occurred_at
  WHERE id = v_event.id;

  -- One verified terminal fact resolves older unknown facts for this same attempt.
  -- Share the transition; do not settle, notify or invoice a second time.
  IF v_intent.channel_key='sandbox' THEN
    UPDATE public.payment_truth_events
    SET state='settled',outcome=p_outcome,
      failure_class=CASE WHEN p_outcome='refused' THEN p_failure_class ELSE NULL END,
      failure_reason=CASE WHEN p_outcome='refused' THEN p_failure_reason ELSE NULL END,
      settlement_transition_id=v_transition_id,dunning_case_id=v_dunning_case_id,
      accounting_document_id=v_accounting_document_id,settled_at=p_occurred_at,updated_at=p_occurred_at
    WHERE id<>v_event.id AND settlement_intent_id=v_intent.id AND state='open'
      AND review_required_at IS NULL AND outcome='indeterminate'
      AND source_evidence->>'attemptRef'=p_source_evidence->>'attemptRef';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.payment_truth_ingest_event(
  p_source_event_id text,
  p_event_fingerprint text,
  p_idempotency_key text,
  p_settlement_intent_id uuid,
  p_outcome text,
  p_amount_minor bigint,
  p_currency_code text,
  p_occurred_at timestamptz,
  p_failure_class text,
  p_failure_reason text,
  p_source_evidence jsonb,
  p_dunning_template_slug text,
  p_recovery_url_path text,
  p_recovery_template_slug text
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_event public.payment_truth_events%ROWTYPE;
BEGIN
  IF p_source_event_id IS NULL OR btrim(p_source_event_id) = ''
    OR p_event_fingerprint !~ '^[0-9a-f]{64}$'
    OR p_idempotency_key IS NULL OR char_length(btrim(p_idempotency_key)) < 8
    OR p_outcome NOT IN ('captured', 'refused', 'indeterminate')
    OR p_amount_minor IS NULL OR p_amount_minor < 1
    OR p_currency_code !~ '^[A-Z]{3}$'
    OR p_source_evidence IS NULL OR jsonb_typeof(p_source_evidence) <> 'object'
    OR (p_outcome = 'refused') IS DISTINCT FROM (p_failure_class IS NOT NULL)
    OR (p_failure_class IS NOT NULL AND p_failure_class NOT IN (
      'authorization_refused', 'insufficient_funds', 'method_unavailable',
      'risk_refused', 'unknown_refusal'
    ))
  THEN
    RAISE EXCEPTION 'payment_truth_event_invalid' USING ERRCODE = '22023';
  END IF;

  PERFORM 1 FROM public.commerce_orders WHERE id=(SELECT order_id FROM public.commerce_settlement_intents WHERE id=p_settlement_intent_id) FOR UPDATE;
  PERFORM 1 FROM public.commerce_settlement_intents WHERE id=p_settlement_intent_id FOR UPDATE;
  SELECT * INTO v_event FROM public.payment_truth_events WHERE source_event_id=p_source_event_id FOR UPDATE;
  IF FOUND THEN
    IF v_event.event_fingerprint IS DISTINCT FROM p_event_fingerprint THEN
      RAISE EXCEPTION 'payment_truth_event_fingerprint_conflict' USING ERRCODE='23505'; END IF;
    RETURN public.payment_truth_readback(v_event.id,true);
  END IF;
  IF EXISTS(SELECT 1 FROM public.commerce_settlement_intents WHERE id=p_settlement_intent_id AND channel_key='sandbox') THEN
    PERFORM public.payment_simulator_assert_truth(p_settlement_intent_id,p_outcome,p_amount_minor,p_currency_code,p_occurred_at,p_source_evidence);
  END IF;
  IF EXISTS(SELECT 1 FROM public.commerce_settlement_intents WHERE id=p_settlement_intent_id AND channel_key='sandbox')
    AND p_source_event_id IS DISTINCT FROM 'sandbox:'||(p_source_evidence->>'sourceReference') THEN
    RAISE EXCEPTION 'payment_simulator_event_identity_mismatch' USING ERRCODE='22023'; END IF;

  INSERT INTO public.payment_truth_events (
    source_event_id, event_fingerprint, ingest_idempotency_key,
    settlement_intent_id, state, outcome, amount_minor, currency_code,
    failure_class, failure_reason, source_evidence, occurred_at, updated_at
  ) VALUES (
    p_source_event_id, p_event_fingerprint, p_idempotency_key,
    p_settlement_intent_id, 'open', p_outcome, p_amount_minor, p_currency_code,
    p_failure_class, p_failure_reason, p_source_evidence, p_occurred_at, p_occurred_at
  )
  ON CONFLICT ON CONSTRAINT payment_truth_events_source_event_id_key DO NOTHING
  RETURNING * INTO v_event;

  IF NOT FOUND THEN
    SELECT * INTO v_event
    FROM public.payment_truth_events
    WHERE source_event_id = p_source_event_id
    FOR UPDATE;
    IF v_event.event_fingerprint IS DISTINCT FROM p_event_fingerprint THEN
      RAISE EXCEPTION 'payment_truth_event_fingerprint_conflict' USING ERRCODE = '23505';
    END IF;
    RETURN public.payment_truth_readback(v_event.id, true);
  END IF;

  IF p_outcome IN ('captured', 'refused') THEN
    PERFORM public.payment_truth_apply_terminal(
      v_event.id, p_idempotency_key, p_outcome, p_occurred_at,
      p_failure_class, p_failure_reason, p_source_evidence,
      p_dunning_template_slug, p_recovery_url_path, p_recovery_template_slug
    );
  END IF;
  RETURN public.payment_truth_readback(v_event.id, false);
END;
$$;

CREATE OR REPLACE FUNCTION public.payment_truth_record_reconciliation(
  p_event_id uuid,
  p_idempotency_key text,
  p_evidence_fingerprint text,
  p_evidence_status text,
  p_outcome text,
  p_occurred_at timestamptz,
  p_failure_class text,
  p_failure_reason text,
  p_source_evidence jsonb,
  p_dunning_template_slug text,
  p_recovery_url_path text,
  p_recovery_template_slug text
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_event public.payment_truth_events%ROWTYPE;
  v_evidence public.payment_truth_reconciliation_evidence%ROWTYPE;
BEGIN
  IF p_idempotency_key IS NULL OR char_length(btrim(p_idempotency_key)) < 8
    OR p_evidence_fingerprint !~ '^[0-9a-f]{64}$'
    OR p_evidence_status NOT IN ('observed', 'failed')
    OR p_outcome NOT IN ('captured', 'refused', 'indeterminate')
    OR (p_evidence_status = 'failed' AND p_outcome <> 'indeterminate')
    OR (p_outcome = 'refused') IS DISTINCT FROM (p_failure_class IS NOT NULL)
    OR (p_failure_class IS NOT NULL AND p_failure_class NOT IN (
      'authorization_refused', 'insufficient_funds', 'method_unavailable',
      'risk_refused', 'unknown_refusal'
    ))
    OR p_source_evidence IS NULL OR jsonb_typeof(p_source_evidence) <> 'object'
  THEN
    RAISE EXCEPTION 'payment_truth_reconciliation_invalid' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_event FROM public.payment_truth_events WHERE id = p_event_id;
  PERFORM 1 FROM public.commerce_orders WHERE id=(SELECT order_id FROM public.commerce_settlement_intents WHERE id=v_event.settlement_intent_id) FOR UPDATE;
  PERFORM 1 FROM public.commerce_settlement_intents WHERE id=v_event.settlement_intent_id FOR UPDATE;
  SELECT * INTO v_event FROM public.payment_truth_events WHERE id = p_event_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'payment_truth_event_not_found' USING ERRCODE = '22023'; END IF;

  INSERT INTO public.payment_truth_reconciliation_evidence (
    event_id, idempotency_key, evidence_fingerprint, evidence_status,
    outcome, failure_class, failure_reason, source_evidence, occurred_at
  ) VALUES (
    p_event_id, p_idempotency_key, p_evidence_fingerprint, p_evidence_status,
    p_outcome, p_failure_class, p_failure_reason, p_source_evidence, p_occurred_at
  )
  ON CONFLICT ON CONSTRAINT payment_truth_reconciliation_idempotency_key_key DO NOTHING
  RETURNING * INTO v_evidence;

  IF NOT FOUND THEN
    SELECT * INTO v_evidence
    FROM public.payment_truth_reconciliation_evidence
    WHERE idempotency_key = p_idempotency_key;
    IF v_evidence.event_id IS DISTINCT FROM p_event_id
      OR v_evidence.evidence_fingerprint IS DISTINCT FROM p_evidence_fingerprint
    THEN
      RAISE EXCEPTION 'payment_truth_reconciliation_fingerprint_conflict' USING ERRCODE = '23505';
    END IF;
    RETURN public.payment_truth_readback(v_event.id, true);
  END IF;

  UPDATE public.payment_truth_events
  SET last_reconciled_at = p_occurred_at, updated_at = p_occurred_at
  WHERE id = v_event.id;

  IF v_event.state = 'open' AND v_event.review_required_at IS NULL
    AND p_evidence_status = 'observed'
    AND p_outcome IN ('captured', 'refused')
  THEN
    PERFORM public.payment_truth_apply_terminal(
      v_event.id, p_idempotency_key, p_outcome, p_occurred_at,
      p_failure_class, p_failure_reason, p_source_evidence,
      p_dunning_template_slug, p_recovery_url_path, p_recovery_template_slug
    );
    UPDATE public.payment_truth_reconciliation_evidence
    SET applied_at = p_occurred_at WHERE id = v_evidence.id;
  END IF;

  RETURN public.payment_truth_readback(v_event.id, false);
END;
$$;

CREATE OR REPLACE FUNCTION public.payment_truth_sweep_open_events(
  p_now timestamptz,
  p_limit integer
)
RETURNS jsonb
LANGUAGE sql
SET search_path = public, pg_catalog
AS $$
  WITH open_events AS (
    SELECT id FROM public.payment_truth_events
    WHERE state = 'open' AND review_required_at IS NULL AND occurred_at <= p_now
    ORDER BY occurred_at, id
    LIMIT GREATEST(COALESCE(p_limit, 1), 1)
    FOR UPDATE SKIP LOCKED
  )
  SELECT jsonb_build_object(
    'claimed', count(*)::integer,
    'settledIgnored', (SELECT count(*)::integer FROM public.payment_truth_events WHERE state = 'settled'),
    'eventIds', COALESCE(jsonb_agg(id ORDER BY id), '[]'::jsonb)
  ) FROM open_events;
$$;

REVOKE ALL ON FUNCTION public.payment_simulator_read_attempt(uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.payment_simulator_begin_attempt(text,uuid,text,jsonb,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.payment_simulator_record_observation(uuid,text,text,text,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.payment_simulator_assert_truth(uuid,text,bigint,text,timestamptz,jsonb) FROM PUBLIC;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.payment_simulator_read_attempt(uuid,uuid),public.payment_simulator_begin_attempt(text,uuid,text,jsonb,timestamptz),public.payment_simulator_record_observation(uuid,text,text,text,timestamptz),public.payment_simulator_assert_truth(uuid,text,bigint,text,timestamptz,jsonb) TO service_role';
  END IF;
END; $$;
