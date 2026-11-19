-- Verify positive money against the current provider attempt and its durable evidence.
-- Webhook signatures and provider readbacks retain different provenance.
-- Existing function OIDs and exact completed result fingerprints are preserved.

-- Historical rows keep their original keys and fingerprints, without a capture basis.
ALTER TABLE public.payment_provider_attempt_evidence
 ADD COLUMN captured_amount_basis text CHECK (captured_amount_basis = 'provider_capture_v1');

CREATE OR REPLACE FUNCTION public.payment_provider_event_ingest(
  p_provider text,
  p_provider_event_id text,
  p_event_type text,
  p_provider_payment_id text,
  p_settlement_intent_id uuid,
  p_payment_attempt_id uuid,
  p_amount_minor integer,
  p_currency text,
  p_signature_verified boolean,
  p_payload jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_attempt public.payment_provider_attempts%ROWTYPE;
  v_settlement_intent_id uuid := p_settlement_intent_id;
  v_payment_attempt_id uuid := p_payment_attempt_id;
  v_event public.payment_provider_attempt_evidence%ROWTYPE;
  v_replayed boolean := false;
  v_truth jsonb := p_payload -> '__paymentTruth';
  v_captured_amount_basis text := v_truth ->> 'capturedAmountBasis';
  v_event_fingerprint text := v_truth ->> 'fingerprint';
  v_source_evidence jsonb := COALESCE(v_truth -> 'evidence', '{}'::jsonb);
BEGIN
  IF p_provider IS NULL OR btrim(p_provider) = ''
    OR p_provider_event_id IS NULL OR btrim(p_provider_event_id) = ''
    OR p_event_type NOT IN (
      'payment.requires_action',
      'payment.succeeded',
      'payment.failed',
      'payment.refunded',
      'payment.disputed',
      'setup.succeeded',
      'setup.failed',
      'setup.requires_action'
    )
    OR p_signature_verified IS DISTINCT FROM true
    OR (v_captured_amount_basis IS NOT NULL AND (
      v_captured_amount_basis <> 'provider_capture_v1' OR p_event_type <> 'payment.succeeded'
      OR p_amount_minor IS NULL OR p_amount_minor <= 0 OR p_currency IS NULL
    ))
    OR (v_truth IS NOT NULL AND jsonb_typeof(v_truth) <> 'object')
    OR (v_event_fingerprint IS NOT NULL AND v_event_fingerprint !~ '^[0-9a-f]{64}$')
    OR (v_truth IS NOT NULL AND (
      v_event_fingerprint IS NULL
      OR jsonb_typeof(v_source_evidence) <> 'object'
    ))
  THEN
    RAISE EXCEPTION 'payment_control_event_invalid_or_unverified' USING ERRCODE = '22023';
  END IF;

  IF v_payment_attempt_id IS NULL AND p_provider_payment_id IS NOT NULL THEN
    SELECT *
      INTO v_attempt
      FROM public.payment_provider_attempts
     WHERE provider = p_provider
       AND provider_attempt_id = p_provider_payment_id
     ORDER BY created_at DESC
     LIMIT 1;

    IF FOUND THEN
      v_payment_attempt_id := v_attempt.id;
      v_settlement_intent_id := COALESCE(v_settlement_intent_id, v_attempt.settlement_intent_id);
    END IF;
  END IF;

  INSERT INTO public.payment_provider_attempt_evidence (
    provider,
    provider_event_id,
    event_type,
    processing_status,
    payload,
    error,
    settlement_intent_id,
    payment_attempt_id,
    provider_payment_id,
    amount_minor,
    currency,
    signature_verified,
    received_via,
    event_fingerprint,
    captured_amount_basis,
    source_evidence
  )
  VALUES (
    p_provider,
    p_provider_event_id,
    p_event_type,
    'received',
    COALESCE(p_payload, '{}'::jsonb) - '__paymentTruth',
    '{}'::jsonb,
    v_settlement_intent_id,
    v_payment_attempt_id,
    p_provider_payment_id,
    p_amount_minor,
    p_currency,
    true,
    'payment.control.v0',
    v_event_fingerprint,
    v_captured_amount_basis,
    v_source_evidence
  )
  ON CONFLICT (provider, provider_event_id) DO NOTHING
  RETURNING * INTO v_event;

  IF NOT FOUND THEN
    v_replayed := true;
    SELECT *
      INTO v_event
      FROM public.payment_provider_attempt_evidence
     WHERE provider = p_provider
       AND provider_event_id = p_provider_event_id
     FOR UPDATE;

    IF v_event.event_fingerprint IS NOT NULL
      AND v_event_fingerprint IS NOT NULL
      AND v_event_fingerprint IS DISTINCT FROM v_event.event_fingerprint
    THEN
      RAISE EXCEPTION 'commerce_payment_event_idempotency_conflict'
        USING ERRCODE = '23505';
    END IF;

    IF v_event.event_fingerprint IS NULL AND v_event_fingerprint IS NOT NULL THEN
      UPDATE public.payment_provider_attempt_evidence
         SET event_fingerprint = v_event_fingerprint,
             source_evidence = v_source_evidence
       WHERE id = v_event.id
       RETURNING * INTO v_event;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'contractVersion', 'commerce.v0',
    'paymentEvent', jsonb_build_object(
      'id', v_event.id,
      'provider', p_provider,
      'providerEventId', p_provider_event_id,
      'eventType', p_event_type,
      'paymentIntentId', v_event.settlement_intent_id,
      'paymentAttemptId', v_event.payment_attempt_id,
      'eventFingerprint', v_event.event_fingerprint,
      'occurredAt', v_event.source_evidence->>'observedAt',
      'replayed', v_replayed
    )
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.payment_provider_assert_truth(p_intent_id uuid,p_outcome text,p_amount bigint,p_currency text,p_at timestamptz,p_evidence jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE i public.commerce_settlement_intents%ROWTYPE; s public.payment_provider_states%ROWTYPE;
 a public.payment_provider_attempts%ROWTYPE; e public.payment_provider_attempt_evidence%ROWTYPE;
BEGIN
 SELECT * INTO i FROM public.commerce_settlement_intents WHERE id=p_intent_id;
 IF i.channel_key IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.payment_provider_profile(i.channel_key) policy WHERE policy.requires_attempt_truth) AND NOT EXISTS(SELECT 1 FROM public.payment_provider_states WHERE id=i.id) THEN RETURN; END IF;
 SELECT * INTO s FROM public.payment_provider_states WHERE id=i.id;
 SELECT * INTO a FROM public.payment_provider_attempts WHERE id=s.active_attempt_id AND settlement_intent_id=i.id;
 IF NOT FOUND THEN RAISE EXCEPTION 'payment_control_result_active_attempt_not_found' USING ERRCODE='22023'; END IF;
 IF p_evidence->>'sourceKind'='execution_response' THEN
  IF p_evidence->>'sourceReference' IS DISTINCT FROM a.id::text
   OR p_evidence->>'attemptRef' IS DISTINCT FROM a.id::text
   OR p_amount IS DISTINCT FROM i.amount_minor OR p_currency IS DISTINCT FROM i.currency_code
   OR p_evidence->>'payloadFingerprint' IS DISTINCT FROM encode(sha256(convert_to(a.response_payload::text,'UTF8')),'hex')
   OR p_outcome IS DISTINCT FROM 'refused'
   OR (p_evidence->>'observedAt')::timestamptz IS DISTINCT FROM p_at THEN
   RAISE EXCEPTION 'payment_control_result_evidence_mismatch' USING ERRCODE='22023'; END IF;
  RETURN;
 END IF;
 SELECT * INTO e FROM public.payment_provider_attempt_evidence WHERE id::text=p_evidence->>'sourceReference';
 IF NOT FOUND OR e.settlement_intent_id IS DISTINCT FROM i.id THEN
  RAISE EXCEPTION 'payment_control_result_event_mismatch' USING ERRCODE='22023'; END IF;
 IF e.payment_attempt_id IS NULL THEN RAISE EXCEPTION 'payment_control_result_attempt_unresolved' USING ERRCODE='22023'; END IF;
 IF e.payment_attempt_id IS DISTINCT FROM a.id OR p_evidence->>'attemptRef' IS DISTINCT FROM a.id::text THEN
  RAISE EXCEPTION 'payment_control_result_attempt_mismatch' USING ERRCODE='22023'; END IF;
 IF p_outcome='captured' AND (e.captured_amount_basis IS DISTINCT FROM 'provider_capture_v1' OR e.amount_minor IS NULL OR e.amount_minor<=0
  OR e.amount_minor IS DISTINCT FROM i.amount_minor OR e.currency IS DISTINCT FROM i.currency_code) THEN
  RAISE EXCEPTION 'payment_control_result_success_evidence_required' USING ERRCODE='22023'; END IF;
 IF p_evidence->>'sourceKind'='reconciliation_read' THEN
  IF e.received_via IS DISTINCT FROM 'reconciliation_read.v1'
   OR e.signature_verified IS NOT NULL
   OR e.provider IS DISTINCT FROM a.provider
   OR e.event_type IS DISTINCT FROM 'payment.succeeded'
   OR e.provider_payment_id IS NULL
   OR (e.provider_payment_id IS DISTINCT FROM a.provider_attempt_id
    AND e.provider_payment_id IS DISTINCT FROM a.provider_session_id)
   OR p_outcome IS DISTINCT FROM 'captured'
   OR p_amount IS DISTINCT FROM i.amount_minor OR p_currency IS DISTINCT FROM i.currency_code
   OR (e.source_evidence->>'observedAt')::timestamptz IS DISTINCT FROM p_at
   OR (p_evidence->>'observedAt')::timestamptz IS DISTINCT FROM p_at
   OR p_evidence->>'payloadFingerprint' IS DISTINCT FROM e.event_fingerprint THEN
   RAISE EXCEPTION 'payment_control_result_evidence_mismatch' USING ERRCODE='22023'; END IF;
  RETURN;
 END IF;
 IF e.signature_verified IS DISTINCT FROM true OR e.provider IS DISTINCT FROM a.provider
  OR e.provider_payment_id IS DISTINCT FROM a.provider_attempt_id
  OR p_amount IS DISTINCT FROM i.amount_minor OR p_currency IS DISTINCT FROM i.currency_code
  OR (e.amount_minor>0 AND e.amount_minor<>i.amount_minor) OR (e.currency IS NOT NULL AND e.currency<>i.currency_code)
  OR p_outcome IS DISTINCT FROM (CASE e.event_type WHEN 'payment.succeeded' THEN 'captured' WHEN 'payment.failed' THEN 'refused' ELSE 'indeterminate' END)
  OR p_evidence->>'payloadFingerprint' IS DISTINCT FROM COALESCE(e.event_fingerprint,encode(sha256(convert_to(e.payload::text,'UTF8')),'hex'))
  OR p_evidence->>'sourceKind' IS DISTINCT FROM 'accepted_event'
  OR (p_evidence->>'observedAt')::timestamptz IS DISTINCT FROM p_at THEN
  RAISE EXCEPTION 'payment_control_result_evidence_mismatch' USING ERRCODE='22023'; END IF;
END;
$$;

-- Call the lifecycle predicate only after obtaining the aggregate lock.
-- The bounded lookup also serves invoker truth routes without exposing provider tables.
CREATE FUNCTION public.payment_provider_capture_requires_review(p_intent_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
 SELECT EXISTS (
  SELECT 1 FROM public.commerce_settlement_intents i
  JOIN public.commerce_orders o ON o.id=i.order_id
  JOIN public.payment_provider_states s ON s.id=i.id
  WHERE i.id=p_intent_id AND (
   i.status='cancelled' OR s.status='cancelled' OR o.status IN ('cancelled','expired')
   OR (o.status='pending_payment' AND o.metadata->>'paymentStatus'='expired')
  )
 );
$$;
REVOKE ALL ON FUNCTION public.payment_provider_capture_requires_review(uuid) FROM PUBLIC;

-- Resolve existing review through the indexed attempt evidence and event identity.
CREATE FUNCTION public.payment_provider_capture_review_required(p_intent_id uuid,p_attempt_id uuid)
RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
 SELECT EXISTS (
  SELECT 1 FROM public.payment_provider_attempt_evidence e
  JOIN public.payment_truth_events t ON t.source_event_id='provider:'||e.id::text
   AND t.settlement_intent_id=e.settlement_intent_id
   AND t.source_evidence->>'sourceReference'=e.id::text
   AND t.source_evidence->>'attemptRef'=e.payment_attempt_id::text
   AND t.source_evidence->>'payloadFingerprint'=e.event_fingerprint
  WHERE e.settlement_intent_id=p_intent_id AND e.payment_attempt_id=p_attempt_id
   AND e.event_type='payment.succeeded' AND e.captured_amount_basis='provider_capture_v1'
   AND t.state='open' AND t.outcome='captured' AND t.review_required_at IS NOT NULL
 );
$$;
REVOKE ALL ON FUNCTION public.payment_provider_capture_review_required(uuid,uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.payment_provider_attempt_read(p_intent_id uuid,p_attempt_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
 SELECT jsonb_build_object('contractVersion','commerce.v0','paymentAttempt',jsonb_build_object(
  'id',a.id,'paymentIntentId',a.settlement_intent_id,'paymentId',a.payment_id,'status',a.status,
  'provider',a.provider,'providerAttemptId',a.provider_attempt_id,'providerSessionId',a.provider_session_id,
  'nextActionKind',a.next_action_kind,'idempotencyKey',a.idempotency_key,'replayed',false),
  'orderId',i.order_id,'intentStatus',s.status,'settlementStatus',i.status,
  'captureReviewRequired',public.payment_provider_capture_review_required(i.id,a.id),
  'amountMinor',a.amount_minor,'currency',a.currency,'requestPayload',a.request_payload,'responsePayload',a.response_payload,
  'observedSuccess',EXISTS(SELECT 1 FROM public.payment_provider_attempts prior
   JOIN public.payment_provider_attempt_evidence e ON e.payment_attempt_id=prior.id AND e.settlement_intent_id=prior.settlement_intent_id
   WHERE prior.settlement_intent_id=s.id AND e.provider=prior.provider AND e.provider_payment_id=prior.provider_attempt_id
    AND e.signature_verified IS TRUE AND e.event_type='payment.succeeded'),
  'observedFailure',EXISTS(SELECT 1 FROM public.payment_provider_attempt_evidence e WHERE e.payment_attempt_id=a.id
   AND e.settlement_intent_id=s.id AND e.provider=a.provider AND e.provider_payment_id=a.provider_attempt_id
   AND e.signature_verified IS TRUE AND e.event_type='payment.failed'
   AND (e.amount_minor IS NULL OR e.amount_minor=0 OR e.amount_minor=i.amount_minor)
   AND (e.currency IS NULL OR e.currency=i.currency_code)))
 FROM public.payment_provider_attempts a JOIN public.payment_provider_states s ON s.id=a.settlement_intent_id
 JOIN public.commerce_settlement_intents i ON i.id=s.id
 WHERE s.id=p_intent_id AND a.id=COALESCE(p_attempt_id,s.active_attempt_id);
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
  PERFORM public.payment_provider_lock_aggregate(v_event.settlement_intent_id);
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
  PERFORM public.payment_provider_assert_truth(v_intent.id,p_outcome,v_event.amount_minor,v_event.currency_code,p_occurred_at,p_source_evidence);
  IF p_outcome='captured' AND (
    v_order.status='cancelled' OR public.payment_provider_capture_requires_review(v_intent.id)
  ) THEN
    UPDATE public.payment_truth_events SET outcome='captured',failure_class=NULL,failure_reason=NULL,
      review_required_at=now(),updated_at=now()
    WHERE id=v_event.id OR (v_intent.channel_key='sandbox' AND settlement_intent_id=v_intent.id
      AND state='open' AND review_required_at IS NULL AND outcome='indeterminate'
      AND source_evidence->>'attemptRef'=p_source_evidence->>'attemptRef');
    RETURN;
  END IF;

  -- An original renewal refusal can have committed under another event key
  -- before its provider result arrives. Its attempt-bound rung receipt admits
  -- reuse of that exact financial transition; later retry attempts settle their
  -- own keys below.
  IF p_outcome='refused' AND public.payment_provider_retry_failure_recorded(
    v_intent.id,p_idempotency_key,p_source_evidence->>'attemptRef') THEN
    SELECT transition.id INTO v_transition_id
    FROM public.subscription_retry_receipts receipt
    JOIN public.subscription_retry_obligations obligation ON obligation.id=receipt.obligation_id
    JOIN public.subscription_renewal_outcomes outcome ON outcome.renewal_operation_id=obligation.renewal_operation_id
    JOIN public.commerce_settlement_transitions transition ON transition.intent_id=v_intent.id
      AND transition.idempotency_key=outcome.event_key||':settlement' AND transition.outcome='failed'
    WHERE receipt.receipt_key=p_idempotency_key AND receipt.kind='failure' AND receipt.attempt_sequence=0
      AND obligation.renewal_operation_id=v_intent.renewal_operation_id AND outcome.outcome='refused';
  END IF;
  IF v_transition_id IS NULL THEN
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
  END IF;

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
      -- Recovery also withdraws a decline notice already claimed by dispatch.
      UPDATE public.subscription_dunning_notifications
      SET status='skipped',error=COALESCE(error,'cycle_recovered'),settled_at=p_occurred_at,
        claim_token=NULL,lease_expires_at=NULL,updated_at=p_occurred_at
      WHERE case_id IN (SELECT id FROM public.subscription_dunning_cases WHERE cycle_id=v_order.subscription_cycle_id)
        AND notification_kind='payment_failed'
        AND status IN ('queued','sending');
    END IF;
  ELSE
    IF v_order.subscription_cycle_id IS NOT NULL AND NOT public.payment_provider_retry_failure_recorded(
      v_intent.id,p_idempotency_key,p_source_evidence->>'attemptRef'
    ) THEN
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

CREATE OR REPLACE FUNCTION public.oms_cancel_unpaid_order_owned(p_key text,p_order uuid,p_reason text,p_actor uuid,p_metadata jsonb,p_at timestamptz)
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
  -- The exact prior command is final even when late capture evidence arrives later.
  SELECT * INTO receipt FROM public.commerce_order_operations WHERE idempotency_key=p_key;
  IF FOUND THEN
    IF receipt.operation_type <> 'order_cancelled' OR receipt.order_id IS DISTINCT FROM p_order
      OR receipt.payload->>'reason' IS DISTINCT FROM p_reason THEN
      RAISE EXCEPTION 'oms_cancel_unpaid_order_idempotency_conflict' USING ERRCODE='23505';
    END IF;
    RETURN jsonb_build_object('contractVersion','platform.oms.order.v1','orderId',p_order,'status',target.status,'replayed',true);
  END IF;
  PERFORM id FROM public.commerce_settlement_intents WHERE order_id=p_order ORDER BY id FOR UPDATE;
  PERFORM a.id FROM public.payment_simulator_attempts a JOIN public.commerce_settlement_intents i
    ON i.id=a.settlement_intent_id WHERE i.order_id=p_order ORDER BY a.id FOR UPDATE OF a;
  PERFORM e.id FROM public.payment_simulator_observations e JOIN public.payment_simulator_attempts a
    ON a.id=e.attempt_id JOIN public.commerce_settlement_intents i ON i.id=a.settlement_intent_id
    WHERE i.order_id=p_order ORDER BY e.id FOR UPDATE OF e;
  PERFORM e.id FROM public.payment_truth_events e JOIN public.commerce_settlement_intents i
    ON i.id=e.settlement_intent_id WHERE i.order_id=p_order ORDER BY e.id FOR UPDATE OF e;
  PERFORM a.id FROM public.payment_provider_attempts a JOIN public.commerce_settlement_intents i ON i.id=a.settlement_intent_id WHERE i.order_id=p_order ORDER BY a.id FOR UPDATE OF a;
  PERFORM e.id FROM public.payment_provider_attempt_evidence e JOIN public.commerce_settlement_intents i ON i.id=e.settlement_intent_id WHERE i.order_id=p_order ORDER BY e.id FOR UPDATE OF e;
  IF EXISTS(SELECT 1 FROM public.payment_provider_attempts pa JOIN public.commerce_settlement_intents pi ON pi.id=pa.settlement_intent_id
 WHERE pi.order_id=p_order AND (pa.status='succeeded'
 OR EXISTS(SELECT 1 FROM public.payment_provider_attempt_evidence pe WHERE pe.settlement_intent_id=pa.settlement_intent_id
 AND pe.payment_attempt_id=pa.id AND pe.provider=pa.provider AND pe.provider_payment_id=pa.provider_attempt_id
 AND pe.signature_verified IS TRUE AND pe.event_type='payment.succeeded'))) THEN
    RAISE EXCEPTION 'oms_cancel_unpaid_order_payment_already_moved' USING ERRCODE='23505';
  END IF;
  IF EXISTS(SELECT 1 FROM public.payment_provider_attempts pa JOIN public.commerce_settlement_intents pi ON pi.id=pa.settlement_intent_id
 WHERE pi.order_id=p_order AND pa.status IN ('created','sent_to_provider','requires_action','processing')) THEN
    RAISE EXCEPTION 'oms_cancel_unpaid_order_payment_in_flight' USING ERRCODE='23505';
  END IF;
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
  IF target.status='cancelled' THEN
    RETURN jsonb_build_object('contractVersion','platform.oms.order.v1','orderId',p_order,'status','cancelled','replayed',true);
  END IF;
  IF target.status<>'pending_payment' THEN
    RAISE EXCEPTION 'oms_cancel_unpaid_order_invalid_status' USING ERRCODE='22023';
  END IF;
  IF p_actor IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.commerce_operators WHERE id=p_actor) THEN
    RAISE EXCEPTION 'oms_cancel_unpaid_order_actor_unknown' USING ERRCODE='23503';
  END IF;
  -- Provider lifecycle terminalization fences fresh preparation keys as well
  -- as inline retries. Preserve the existing non-provider settlement mapping.
  UPDATE public.commerce_settlement_intents i SET status=CASE WHEN EXISTS(
    SELECT 1 FROM public.payment_provider_states WHERE id=i.id) THEN 'cancelled' ELSE 'failed' END,
    failure_reason='admin_oms_cancelled_unpaid_order',updated_at=p_at
    WHERE order_id=p_order AND status<>'settled';
  UPDATE public.payment_provider_states SET status='cancelled',payment_status='cancelled',
    failure_reason='admin_oms_cancelled_unpaid_order',metadata=metadata||jsonb_build_object(
      'paymentStatus','cancelled','source','commerce.oms.v0'),updated_at=p_at
    WHERE id IN (SELECT id FROM public.commerce_settlement_intents WHERE order_id=p_order)
      AND status NOT IN ('succeeded','cancelled','refunded','partially_refunded','disputed');
  UPDATE public.payment_provider_attempts SET status='cancelled',failure_reason='admin_oms_cancelled_unpaid_order',updated_at=p_at
    WHERE settlement_intent_id IN (SELECT id FROM public.commerce_settlement_intents WHERE order_id=p_order)
      AND status NOT IN ('succeeded','cancelled','failed','expired');
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

CREATE OR REPLACE FUNCTION public.payment_provider_result_apply(
 p_idempotency_key text,p_payment_intent_id uuid,p_payment_event_id uuid,p_result_status text,
 p_occurred_at timestamptz,p_failure_reason text,p_failure_class text,p_failure_class_decided_by text,
 p_dunning_template_slug text,p_recovery_url_path text,p_recovery_template_slug text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE fingerprint text; legacy_fingerprint text; receipt public.payment_provider_receipts%ROWTYPE;
 i public.commerce_settlement_intents%ROWTYPE; s public.payment_provider_states%ROWTYPE;
 a public.payment_provider_attempts%ROWTYPE; e public.payment_provider_attempt_evidence%ROWTYPE;
 o public.commerce_orders%ROWTYPE; kind text:='state_changed'; answer jsonb; truth jsonb; evidence jsonb;
 outcome text; native_failure text; from_status text; held record; recovery_token text; recovery_expires_at timestamptz;
 renewal public.subscription_renewal_operations%ROWTYPE; retry_preparation public.subscription_retry_receipts%ROWTYPE;
 retry_obligation public.subscription_retry_obligations%ROWTYPE;
 retry_sequence integer; logical_cycle integer; retry_result jsonb; expiry_escalation boolean:=false; handoff jsonb;
 capture_requires_review boolean:=false; already_applied_expiry boolean:=false;
BEGIN
 IF p_idempotency_key IS NULL OR btrim(p_idempotency_key)='' OR length(p_idempotency_key)<8
  OR p_payment_intent_id IS NULL OR p_result_status IS NULL OR p_result_status NOT IN ('succeeded','failed','expired','refunded','partially_refunded','disputed')
  OR p_occurred_at IS NULL THEN RAISE EXCEPTION 'payment_control_result_invalid_input' USING ERRCODE='22023'; END IF;
 IF p_payment_event_id IS NOT NULL THEN
  SELECT * INTO e FROM public.payment_provider_attempt_evidence WHERE id=p_payment_event_id;
  IF FOUND AND e.settlement_intent_id=p_payment_intent_id AND e.payment_attempt_id IS NULL THEN
   RAISE EXCEPTION 'payment_control_result_attempt_unresolved' USING ERRCODE='22023'; END IF;
 END IF;
 PERFORM public.payment_provider_lock_aggregate(p_payment_intent_id);
 legacy_fingerprint:=md5(p_payment_intent_id::text||'|'||COALESCE(p_payment_event_id::text,'')||'|'||p_result_status||'|'||p_occurred_at::text||'|'||COALESCE(p_failure_reason,''));
 fingerprint:=md5(p_payment_intent_id::text||'|'||COALESCE(p_payment_event_id::text,'')||'|'||p_result_status||'|'||p_occurred_at::text||'|'||COALESCE(p_failure_reason,'')||CASE WHEN p_failure_class IS NULL THEN '' ELSE '|failure_class='||p_failure_class END);
 SELECT * INTO receipt FROM public.payment_provider_receipts WHERE scope='commerce.payment_result.apply' AND idempotency_key=p_idempotency_key FOR UPDATE;
 IF FOUND THEN
  IF receipt.status='completed' AND receipt.response_payload IS NOT NULL AND
   (receipt.request_fingerprint=fingerprint OR (p_failure_class IS NOT NULL AND receipt.request_fingerprint=legacy_fingerprint AND EXISTS(
    SELECT 1 FROM public.payment_provider_attempts WHERE id=NULLIF(receipt.metadata->>'paymentAttemptId','')::uuid AND failure_class=p_failure_class))) THEN
   RETURN jsonb_set(receipt.response_payload,'{paymentResult,replayed}','true'::jsonb,false); END IF;
  RAISE EXCEPTION 'payment_control_result_idempotency_conflict' USING ERRCODE='23505'; END IF;
 SELECT * INTO i FROM public.commerce_settlement_intents WHERE id=p_payment_intent_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'payment_control_result_intent_not_found' USING ERRCODE='22023'; END IF;
 SELECT * INTO s FROM public.payment_provider_states WHERE id=i.id FOR UPDATE;
 SELECT * INTO a FROM public.payment_provider_attempts WHERE id=s.active_attempt_id AND settlement_intent_id=i.id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'payment_control_result_active_attempt_not_found' USING ERRCODE='22023'; END IF;
 IF p_payment_event_id IS NOT NULL THEN
  SELECT * INTO e FROM public.payment_provider_attempt_evidence WHERE id=p_payment_event_id FOR UPDATE;
  IF NOT FOUND OR e.settlement_intent_id IS DISTINCT FROM i.id THEN
   RAISE EXCEPTION 'payment_control_result_event_mismatch' USING ERRCODE='22023'; END IF;
  IF e.payment_attempt_id IS DISTINCT FROM a.id THEN
   RAISE EXCEPTION 'payment_control_result_attempt_mismatch' USING ERRCODE='22023'; END IF;
  IF e.amount_minor>0 AND e.amount_minor<>i.amount_minor AND (p_result_status NOT IN ('refunded','partially_refunded') OR (SELECT refund_event_money_original FROM public.payment_provider_profile(e.provider))) THEN
   RAISE EXCEPTION 'payment_control_result_amount_mismatch' USING ERRCODE='22023'; END IF;
  IF e.currency IS NOT NULL AND e.currency<>i.currency_code THEN
   RAISE EXCEPTION 'payment_control_result_currency_mismatch' USING ERRCODE='22023'; END IF;
 END IF;
 SELECT * INTO o FROM public.commerce_orders WHERE id=i.order_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'payment_control_result_order_not_found' USING ERRCODE='22023'; END IF;
 from_status:=s.status;
 IF p_result_status='succeeded' THEN
  IF p_payment_event_id IS NULL THEN
   RAISE EXCEPTION 'payment_control_result_success_evidence_required' USING ERRCODE='22023'; END IF;
 ELSIF p_result_status IN ('failed','expired') THEN
  capture_requires_review:=public.payment_provider_capture_requires_review(i.id);
  already_applied_expiry:=p_result_status='expired' AND s.status='expired' AND a.status='expired';
  IF public.payment_provider_capture_review_required(i.id,a.id)
    OR (s.target_kind='one_time_order' AND capture_requires_review AND NOT already_applied_expiry) THEN
   kind:='ignored_failure_protected_state';
  ELSIF s.status IN ('succeeded','refunded','partially_refunded','disputed') THEN kind:='ignored_failure_after_success_or_terminal';
  ELSIF s.target_kind='subscription_cycle' AND EXISTS(SELECT 1 FROM public.subscription_cycles WHERE id=s.subscription_cycle_id AND status IN ('skipped','cancelled') FOR UPDATE) THEN
   UPDATE public.payment_provider_attempts SET status=p_result_status,failure_reason=COALESCE(p_failure_reason,p_result_status),updated_at=now() WHERE id=a.id;
   UPDATE public.payment_provider_states SET payment_status=p_result_status,metadata=metadata||jsonb_build_object('paymentStatus',p_result_status,'failureReason',COALESCE(p_failure_reason,p_result_status),'source','payment.control.v0'),updated_at=now() WHERE id=s.id;
   kind:='ignored_failure_terminalized_cycle';
  ELSIF capture_requires_review AND NOT already_applied_expiry THEN kind:='ignored_failure_protected_state';
  ELSIF s.status=p_result_status AND a.status=p_result_status THEN kind:='ignored_duplicate_terminal_failure'; END IF;
 ELSE
  RETURN public.payment_refund_apply_result(p_idempotency_key,p_payment_intent_id,p_payment_event_id,p_result_status,
   p_occurred_at,p_failure_reason,p_failure_class,p_failure_class_decided_by);
 END IF;
 IF kind='state_changed' THEN
  outcome:=CASE WHEN p_result_status='succeeded' THEN 'captured' ELSE 'refused' END;
  native_failure:=CASE WHEN outcome='refused' THEN CASE WHEN p_failure_class IN ('authorization_refused','insufficient_funds','method_unavailable','risk_refused','unknown_refusal') THEN p_failure_class ELSE 'unknown_refusal' END END;
  evidence:=CASE WHEN p_payment_event_id IS NULL THEN
   jsonb_build_object('sourceKind','execution_response','sourceReference',a.id,'attemptRef',a.id,
    'observedStatus',p_result_status,'observedAt',p_occurred_at,'payloadFingerprint',encode(sha256(convert_to(a.response_payload::text,'UTF8')),'hex'))
   ELSE jsonb_build_object('sourceKind',CASE WHEN e.received_via='reconciliation_read.v1' THEN 'reconciliation_read' ELSE 'accepted_event' END,
    'sourceReference',e.id,'attemptRef',a.id,
    'observedStatus',p_result_status,'observedAt',p_occurred_at,'payloadFingerprint',COALESCE(e.event_fingerprint,encode(sha256(convert_to(e.payload::text,'UTF8')),'hex'))) END;
  PERFORM public.payment_provider_assert_truth(i.id,outcome,i.amount_minor,i.currency_code,p_occurred_at,evidence);
  capture_requires_review:=outcome='captured' AND public.payment_provider_capture_requires_review(i.id);
  IF outcome='captured' AND i.status='settled' AND s.status IN ('succeeded','refunded','partially_refunded','disputed') THEN
   kind:='ignored_duplicate_success';
  ELSIF outcome='captured' AND s.status IN ('refunded','partially_refunded','disputed') THEN
   RAISE EXCEPTION 'payment_control_result_terminal_intent' USING ERRCODE='22023';
  ELSIF outcome='captured' AND public.payment_provider_capture_review_required(i.id,a.id) THEN
   kind:='ignored_success_requiring_review';
  ELSIF outcome='captured' AND NOT capture_requires_review AND i.status<>'settled' AND i.renewal_operation_id IS NOT NULL THEN
   SELECT * INTO retry_obligation FROM public.subscription_retry_obligations
    WHERE renewal_operation_id=i.renewal_operation_id FOR UPDATE;
   IF FOUND AND retry_obligation.state<>'recovered' THEN
    SELECT r.* INTO retry_preparation FROM public.subscription_retry_receipts r
     WHERE r.obligation_id=retry_obligation.id AND r.kind='prepare' AND r.attempt_sequence=retry_obligation.attempt_sequence;
    retry_result:=public.subscription_retry_record_recovery(i.renewal_operation_id,p_idempotency_key||':truth',
     evidence||jsonb_build_object('prepareKey',retry_preparation.receipt_key,'evidenceKey','provider:'||e.id::text,
      'occurredAt',p_occurred_at,'firstRecordedAt',to_char(e.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'externalRef',COALESCE(a.provider_attempt_id,e.provider_payment_id),
      'amountMinor',i.amount_minor,'currency',i.currency_code,'template',p_recovery_template_slug));
    IF retry_result->>'state' IS DISTINCT FROM 'recovered' THEN
     kind:='ignored_success_requiring_review';
    END IF;
   END IF;
  END IF;
  IF outcome='refused' AND s.target_kind='subscription_cycle' AND i.renewal_operation_id IS NOT NULL THEN
   SELECT op.* INTO renewal FROM public.subscription_renewal_operations op
    JOIN public.subscription_cycles c ON c.renewal_operation_id=op.id AND c.id=s.subscription_cycle_id
    WHERE op.id=i.renewal_operation_id AND op.subscription_id=s.subscription_id
     AND o.renewal_operation_id=op.id AND o.subscription_cycle_id=c.id
     AND i.renewal_operation_fingerprint=op.operation_fingerprint FOR UPDATE OF op;
   IF NOT FOUND OR renewal.cycle_snapshot#>>'{cycle,status}' IS DISTINCT FROM 'correlated' THEN
    RAISE EXCEPTION 'subscription_renewal_cycle_correlation_required' USING ERRCODE='22023'; END IF;
   logical_cycle:=(renewal.cycle_snapshot#>>'{cycle,logicalCycleNumber}')::integer;
   SELECT r.* INTO retry_preparation FROM public.subscription_retry_receipts r
    JOIN public.subscription_retry_obligations obligation ON obligation.id=r.obligation_id
    WHERE obligation.renewal_operation_id=renewal.id AND r.kind='prepare'
     AND r.input->>'paymentIntentId'=i.id::text AND r.input->>'idempotencyKey'=a.idempotency_key
     AND r.input->>'providerIdempotencyKey'=a.request_payload->>'providerIdempotencyKey'
     AND r.input->>'providerRequestFingerprint'=a.request_payload->>'providerRequestFingerprint';
   IF FOUND THEN retry_sequence:=retry_preparation.attempt_sequence;
   ELSIF renewal.external_attempt_ref IN (a.id::text,a.provider_attempt_id)
    AND renewal.cycle_snapshot->>'externalAttemptSequence'='0' THEN retry_sequence:=0;
   ELSE RAISE EXCEPTION 'subscription_retry_not_prepared' USING ERRCODE='22023'; END IF;
   -- A same-attempt expiry records a lifecycle escalation. Its decline already
   -- owns the financial failure and retry stage; neither effect runs again.
   expiry_escalation:=p_result_status='expired' AND s.status='failed' AND a.status='failed' AND EXISTS(
    SELECT 1 FROM public.subscription_retry_receipts r
    JOIN public.subscription_retry_obligations obligation ON obligation.id=r.obligation_id
    WHERE obligation.renewal_operation_id=renewal.id AND r.kind='failure' AND r.attempt_sequence=retry_sequence
     AND r.input->>'paymentIntentId'=i.id::text AND r.input->>'paymentAttemptId'=a.id::text);
   IF NOT expiry_escalation THEN
   -- The retry owner records the financial failure first. Truth below reuses
   -- this exact key's settlement receipt, rather than making a second transition.
   retry_result:=public.subscription_retry_apply_failure(renewal.id,p_idempotency_key||':truth',
    jsonb_build_object('attemptSequence',retry_sequence,'logicalCycleNumber',logical_cycle,
     'paymentIntentId',i.id,'paymentAttemptId',a.id,'paymentId',s.payment_id,'provider',a.provider,
     'providerAttemptId',a.provider_attempt_id,'subscriptionCycleId',s.subscription_cycle_id,
     'renewalOperationId',renewal.id,'occurredAt',p_occurred_at,
     'failureClass',p_failure_class,'reason',COALESCE(p_failure_reason,p_result_status),
     'externalRef',CASE WHEN retry_sequence=0 THEN renewal.external_attempt_ref ELSE COALESCE(a.provider_attempt_id,a.id::text) END,
     'evidenceKey',COALESCE(e.id::text,a.id::text),'firstRecordedAt',COALESCE(e.created_at,a.updated_at)));
  END IF;
   END IF;
  IF kind='state_changed' AND NOT expiry_escalation AND NOT (
   outcome='captured' AND (i.status='settled' OR retry_result IS NOT NULL)
  ) THEN
   truth:=public.payment_truth_ingest_event('provider:'||COALESCE(e.id::text,p_idempotency_key),encode(sha256(convert_to(jsonb_build_object('eventId',e.id,'intentId',i.id,'attemptId',a.id,'outcome',outcome)::text,'UTF8')),'hex'),
    p_idempotency_key||':truth',i.id,outcome,i.amount_minor,i.currency_code,p_occurred_at,native_failure,p_failure_reason,evidence,p_dunning_template_slug,p_recovery_url_path,p_recovery_template_slug);
   IF outcome='captured' AND NOT COALESCE(truth#>>'{event,applicationStatus}'='applied'
    AND truth#>>'{event,outcome}'='captured'
    AND truth#>>'{effects,paymentResultRecorded}'='true'
    AND truth#>>'{financial,settlementStatus}'='settled',false) THEN
    kind:='ignored_success_requiring_review';
   END IF;
  END IF;
  IF kind='state_changed' THEN
  UPDATE public.payment_provider_states SET status=p_result_status,payment_status=p_result_status,
   provider_payment_id=CASE WHEN p_result_status='succeeded' THEN
    CASE WHEN e.received_via='reconciliation_read.v1' THEN COALESCE(a.provider_attempt_id,e.provider_payment_id)
      ELSE COALESCE(e.provider_payment_id,provider_payment_id) END
    ELSE provider_payment_id END,
   failure_reason=CASE WHEN p_result_status='succeeded' THEN NULL ELSE COALESCE(p_failure_reason,p_result_status) END,updated_at=now() WHERE id=s.id;
  UPDATE public.payment_provider_attempts SET status=p_result_status,failure_reason=CASE WHEN p_result_status='succeeded' THEN NULL ELSE COALESCE(p_failure_reason,p_result_status) END,updated_at=now() WHERE id=a.id;
  IF p_result_status IN ('failed','expired') AND o.subscription_cycle_id IS NULL THEN
   IF p_result_status='failed' THEN
    UPDATE public.commerce_orders SET metadata=metadata||jsonb_build_object(
     'paymentStatus','declined','failureReason',COALESCE(p_failure_reason,p_result_status),
     'lastDeclineAt',p_occurred_at,'recoverable',true,'source','payment.control.v0'),updated_at=now() WHERE id=o.id;
    -- The first recoverable-decline metadata transition owns the delayed notice
    -- and its authority in the native checkout recovery token ledger.
    IF o.client_id IS NOT NULL AND (o.metadata->>'paymentStatus' IS DISTINCT FROM 'declined'
     OR COALESCE((o.metadata->>'recoverable')::boolean,false) IS DISTINCT FROM true) THEN
     recovery_token:='rcv_'||replace(gen_random_uuid()::text,'-','')||replace(gen_random_uuid()::text,'-','');
     recovery_expires_at:=now()+interval '24 hours';
     INSERT INTO public.commerce_checkout_recovery_tokens(order_id,client_id,token_hash,expires_at)
     VALUES(o.id,o.client_id,encode(sha256(convert_to(recovery_token,'UTF8')),'hex'),recovery_expires_at)
     ON CONFLICT (token_hash) DO NOTHING;
     INSERT INTO public.outbox_events(aggregate_type,aggregate_id,event_type,idempotency_key,available_at,payload,metadata)
     VALUES('commerce_order',o.id,'commerce.payment.failed','payment_failed:'||o.id,now()+interval '3 minutes',
      jsonb_build_object('orderId','order_'||o.id,'orderUuid',o.id,'totalCents',o.total_amount_minor,
       'currency',o.currency_code,'recoveryToken',recovery_token,
       'mode',CASE WHEN EXISTS(SELECT 1 FROM public.subscription_activations WHERE order_id=o.id)
        OR COALESCE(o.metadata#>>'{orderDraftSnapshot,context,mode}',o.metadata#>>'{quoteSnapshot,quote,context,mode}')='subscription'
        THEN 'subscription_cycle' ELSE 'one_time' END,
       'failureReason',COALESCE(p_failure_reason,p_result_status),'hasSubscriptionContext',EXISTS(
        SELECT 1 FROM public.subscription_activations WHERE order_id=o.id) OR COALESCE(
        o.metadata#>>'{orderDraftSnapshot,context,mode}',o.metadata#>>'{quoteSnapshot,quote,context,mode}','one_time')='subscription',
       'expiresAt',recovery_expires_at,'occurredAt',now()),
      jsonb_build_object('source','payment_provider_result_apply_recoverable_decline'))
     ON CONFLICT (event_type,idempotency_key) DO NOTHING;
    END IF;
    kind:='recoverable_decline';
   ELSE
    IF EXISTS(SELECT 1 FROM public.subscription_activations WHERE order_id=o.id AND state='provisional') THEN
     PERFORM public.commerce_compensate_abandoned_checkout(
      'payment-expired:'||o.id,o.id,'subscription_activation_failed',p_occurred_at);
    END IF;
    UPDATE public.commerce_orders SET status='expired',metadata=metadata||jsonb_build_object(
     'paymentStatus','expired','failureReason',COALESCE(p_failure_reason,p_result_status),'source','payment.control.v0'),
     updated_at=now() WHERE id=o.id;
    FOR held IN SELECT id FROM public.fulfillment_inventory_reservations
     WHERE purchase_order_id=o.id AND status='held' ORDER BY id FOR UPDATE LOOP
     PERFORM public.fulfillment_release_purchase_reservation(
      'payment-expired:'||held.id,held.id,'payment_expired','{}'::jsonb,p_occurred_at);
    END LOOP;
   END IF;
  END IF;
  END IF;
 END IF;
 IF p_failure_class IS NOT NULL AND kind NOT IN ('ignored_success_requiring_review','ignored_failure_protected_state') THEN
  UPDATE public.payment_provider_attempts SET failure_class=p_failure_class,response_payload=response_payload||
   CASE WHEN p_failure_class_decided_by IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('failureClassDecidedBy',p_failure_class_decided_by) END WHERE id=a.id;
 END IF;
 IF p_payment_event_id IS NOT NULL THEN
  UPDATE public.payment_provider_attempt_evidence SET processed_at=now(),processing_status=CASE WHEN kind LIKE 'ignored%' THEN 'ignored' ELSE 'processed' END WHERE id=e.id;
 END IF;
 IF kind NOT IN ('ignored_duplicate_success','ignored_success_requiring_review','ignored_failure_protected_state') THEN
 INSERT INTO public.payment_provider_transitions(settlement_intent_id,payment_attempt_id,provider_event_id,transition_kind,from_status,to_status,reason,idempotency_key,occurred_at,payload)
 VALUES(i.id,a.id,p_payment_event_id,'business_result',from_status,p_result_status,kind,p_idempotency_key||':payment_result',p_occurred_at,jsonb_build_object('orderId',o.id,'resultStatus',p_result_status,'source','payment.control.v0')||
  CASE WHEN outcome IS DISTINCT FROM 'refused' OR retry_result IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('retryObligationId',retry_result->>'id',
   'retryAttempt',retry_result->'retry_attempt','nextRetryAt',retry_result->'next_retry_at','retryFailureKey',p_idempotency_key||':truth') END);
 END IF;
 answer:=jsonb_build_object('contractVersion','commerce.v0','paymentResult',jsonb_build_object('paymentIntentId',i.id,'paymentAttemptId',a.id,'paymentId',s.payment_id,'orderId',o.id,'status',p_result_status,'kind',kind,'idempotencyKey',p_idempotency_key,'replayed',false));
 IF p_result_status='failed' AND kind<>'ignored_failure_protected_state' AND p_payment_event_id IS NOT NULL
  AND p_idempotency_key='provider-webhook:'||e.provider||':'||e.provider_event_id||':apply' THEN
  BEGIN
   handoff:=public.payment_reconciliation_open_dunning_from_failed_result(
    'provider-webhook:'||e.provider||':'||e.provider_event_id||':dunning',i.id,e.provider_event_id,
    p_failure_reason,p_occurred_at,p_failure_class,a.id,p_dunning_template_slug,p_recovery_url_path);
  EXCEPTION WHEN SQLSTATE '55000' THEN
   IF SQLERRM NOT IN ('subscription_dunning_failed_attempt_unattributed','subscription_dunning_case_unattributed',
    'subscription_dunning_replay_unavailable','subscription_dunning_failed_attempt_ambiguous','subscription_dunning_failed_attempt_rung_mismatch') THEN RAISE; END IF;
   handoff:=jsonb_build_object('subscriptionWebhookDunning',jsonb_build_object('opened',false,'replayed',false,
    'reason',SQLERRM,'failedPaymentAttemptId',a.id));
  END;
  answer:=answer||handoff;
 END IF;
 INSERT INTO public.payment_provider_receipts(scope,idempotency_key,request_fingerprint,status,response_payload,metadata)
 VALUES('commerce.payment_result.apply',p_idempotency_key,fingerprint,'completed',answer,jsonb_build_object('paymentIntentId',i.id,'paymentAttemptId',a.id)||
  CASE WHEN e.received_via='reconciliation_read.v1' THEN jsonb_build_object('paymentEventId',e.id) ELSE '{}'::jsonb END);
 RETURN answer;
END;
$$;

-- The server readback adapter vouches for provenance. The database locks and
-- checks the referenced attempt, then stores money and observation before either
-- reconciliation or subscription recovery can consume it.
CREATE FUNCTION public.payment_provider_record_capture_readback(
 p_idempotency_key text,p_order_id uuid,p_intent_id uuid,p_attempt_id uuid,p_payment_id uuid,
 p_provider text,p_provider_payment_id text,p_provider_status text,p_occurred_at timestamptz,
 p_checked_at timestamptz,p_amount_minor jsonb,p_currency text,p_captured_amount_basis text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
 i public.commerce_settlement_intents%ROWTYPE;
 s public.payment_provider_states%ROWTYPE;
 a public.payment_provider_attempts%ROWTYPE;
 e public.payment_provider_attempt_evidence%ROWTYPE;
 v_readback jsonb;
 v_event_key text;
 v_fingerprint text;
BEGIN
 IF length(btrim(COALESCE(p_idempotency_key,'')))<8
  OR btrim(COALESCE(p_provider_payment_id,''))='' OR btrim(COALESCE(p_provider_status,''))=''
  OR p_occurred_at IS NULL OR p_checked_at IS NULL THEN
  RAISE EXCEPTION 'payment_control_result_success_evidence_required' USING ERRCODE='22023'; END IF;

 PERFORM public.payment_provider_lock_aggregate(p_intent_id);
 SELECT * INTO i FROM public.commerce_settlement_intents WHERE id=p_intent_id;
 SELECT * INTO s FROM public.payment_provider_states WHERE id=i.id FOR UPDATE;
 SELECT * INTO a FROM public.payment_provider_attempts WHERE id=s.active_attempt_id AND settlement_intent_id=i.id FOR UPDATE;
 IF NOT FOUND OR i.order_id IS DISTINCT FROM p_order_id
  OR a.id IS DISTINCT FROM p_attempt_id OR s.payment_id IS DISTINCT FROM p_payment_id
  OR a.provider IS DISTINCT FROM p_provider
  OR (p_provider_payment_id IS DISTINCT FROM a.provider_attempt_id
   AND p_provider_payment_id IS DISTINCT FROM a.provider_session_id) THEN
  RAISE EXCEPTION 'payment_reconciliation_apply_claim_mismatch' USING ERRCODE='22023'; END IF;
 IF p_captured_amount_basis IS DISTINCT FROM 'provider_capture_v1' OR i.amount_minor<=0 OR p_amount_minor IS DISTINCT FROM to_jsonb(i.amount_minor)
  OR upper(p_currency) IS DISTINCT FROM i.currency_code THEN
  RAISE EXCEPTION 'payment_control_result_success_evidence_required' USING ERRCODE='22023'; END IF;

 v_readback:=jsonb_build_object('observedAt',p_occurred_at,'checkedAt',p_checked_at,
  'providerStatus',p_provider_status,'amountMinor',i.amount_minor,'currency',i.currency_code);
 v_event_key:='provider-readback:'||encode(sha256(convert_to(p_idempotency_key,'UTF8')),'hex');
 v_fingerprint:=encode(sha256(convert_to(v_readback::text,'UTF8')),'hex');
 INSERT INTO public.payment_provider_attempt_evidence (
  provider,provider_event_id,event_type,settlement_intent_id,payment_attempt_id,
  provider_payment_id,amount_minor,currency,received_via,event_fingerprint,captured_amount_basis,source_evidence
 ) VALUES (
  p_provider,v_event_key,'payment.succeeded',i.id,a.id,p_provider_payment_id,
  i.amount_minor,i.currency_code,'reconciliation_read.v1',v_fingerprint,p_captured_amount_basis,v_readback
 ) ON CONFLICT (provider,provider_event_id) DO NOTHING RETURNING * INTO e;
 IF NOT FOUND THEN
  SELECT * INTO e FROM public.payment_provider_attempt_evidence
   WHERE provider=p_provider AND provider_event_id=v_event_key FOR UPDATE;
  IF e.received_via IS DISTINCT FROM 'reconciliation_read.v1'
   OR e.settlement_intent_id IS DISTINCT FROM i.id OR e.payment_attempt_id IS DISTINCT FROM a.id
   OR e.provider_payment_id IS DISTINCT FROM p_provider_payment_id
   OR e.event_fingerprint IS DISTINCT FROM v_fingerprint THEN
   RAISE EXCEPTION 'payment_reconciliation_apply_evidence_conflict' USING ERRCODE='23505'; END IF;
 END IF;
 RETURN jsonb_build_object('id',e.id,'fingerprint',e.event_fingerprint);
END;
$$;
-- A changed normalization can acknowledge an exact completed historical delivery.
-- The transition links its receipt to this immutable event independently of timestamp spelling.
CREATE FUNCTION public.commerce_payment_control_completed_capture_receipt(
 p_provider text,p_provider_event_id text,p_provider_payment_id text,p_legacy_fingerprint text
)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
 SELECT e.id
 FROM public.payment_provider_attempt_evidence e
 JOIN public.payment_provider_receipts r ON r.scope='commerce.payment_result.apply'
  AND r.idempotency_key='provider-webhook:'||e.provider||':'||e.provider_event_id||':apply'
 JOIN public.payment_provider_transitions t ON t.idempotency_key=r.idempotency_key||':payment_result'
  AND t.provider_event_id=e.id AND t.settlement_intent_id=e.settlement_intent_id
  AND t.payment_attempt_id=e.payment_attempt_id AND t.transition_kind='business_result'
  AND t.to_status='succeeded'
 WHERE e.provider=p_provider AND e.provider_event_id=p_provider_event_id
  AND e.provider_payment_id=p_provider_payment_id AND e.event_fingerprint=p_legacy_fingerprint
  AND e.event_type='payment.succeeded' AND e.signature_verified IS TRUE
  AND e.received_via='payment.control.v0'
  AND e.captured_amount_basis IS NULL AND r.status='completed'
  AND r.response_payload#>>'{paymentResult,status}'='succeeded'
  AND r.response_payload#>>'{paymentResult,idempotencyKey}'=r.idempotency_key
  AND r.response_payload#>>'{paymentResult,paymentIntentId}'=e.settlement_intent_id::text
  AND r.response_payload#>>'{paymentResult,paymentAttemptId}'=e.payment_attempt_id::text
$$;

REVOKE ALL ON FUNCTION public.commerce_payment_control_completed_capture_receipt(text,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.payment_provider_record_capture_readback(text,uuid,uuid,uuid,uuid,text,text,text,timestamptz,timestamptz,jsonb,text,text) FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.payment_provider_record_capture_readback(text,uuid,uuid,uuid,uuid,text,text,text,timestamptz,timestamptz,jsonb,text,text), public.commerce_payment_control_completed_capture_receipt(text,text,text,text), public.payment_provider_capture_review_required(uuid,uuid), public.payment_provider_capture_requires_review(uuid) FROM anon;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.payment_provider_record_capture_readback(text,uuid,uuid,uuid,uuid,text,text,text,timestamptz,timestamptz,jsonb,text,text), public.commerce_payment_control_completed_capture_receipt(text,text,text,text), public.payment_provider_capture_review_required(uuid,uuid), public.payment_provider_capture_requires_review(uuid) FROM authenticated;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.payment_provider_record_capture_readback(text,uuid,uuid,uuid,uuid,text,text,text,timestamptz,timestamptz,jsonb,text,text), public.payment_provider_capture_review_required(uuid,uuid), public.payment_provider_capture_requires_review(uuid) FROM service_role;'; END IF; END; $$;

DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'GRANT EXECUTE ON FUNCTION public.commerce_payment_control_completed_capture_receipt(text,text,text,text), public.payment_provider_capture_requires_review(uuid) TO service_role;'; END IF; END; $$;

CREATE OR REPLACE FUNCTION public.commerce_payment_control_apply_reconciliation_result(
  p_idempotency_key text,
  p_expected_order_id uuid,
  p_expected_payment_intent_id uuid,
  p_expected_payment_attempt_id uuid,
  p_expected_payment_id uuid,
  p_provider text,
  p_provider_payment_id text,
  p_local_status text,
  p_provider_status text,
  p_result_status text,
  p_occurred_at timestamptz,
  p_failure_reason text,
  p_checked_at timestamptz,
  p_payload jsonb,
  p_failure_class text DEFAULT NULL,
  p_failure_class_decided_by text DEFAULT NULL,
  p_dunning_template_slug text DEFAULT 'payment_failed',
  p_recovery_url_path text DEFAULT '/recover',
  p_recovery_template_slug text DEFAULT 'recovered'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_apply jsonb;
  v_payment_result jsonb;
  v_evidence jsonb;
  v_dunning jsonb;
  v_dunning_refusal text;
  v_existing_evidence public.payment_provider_reconciliation_runs%ROWTYPE;
  v_has_existing_evidence boolean := false;
  v_evidence_key text;
  v_evidence_payload jsonb;
  v_kind text;
  v_correction_status text;
  v_applied boolean;
  v_apply_replayed boolean;
  v_evidence_replayed boolean := false;
  v_dunning_replayed boolean := false;
  v_payment_event_id uuid;
  v_readback jsonb;
  v_has_result_receipt boolean;
  v_previous_kind text;
  v_review_observed_at timestamptz;
  v_equivalent_review_replay boolean := false;
BEGIN
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' OR length(p_idempotency_key) < 8
    OR p_expected_order_id IS NULL
    OR p_expected_payment_intent_id IS NULL
    OR p_expected_payment_attempt_id IS NULL
    OR p_expected_payment_id IS NULL
    OR p_provider IS NULL OR btrim(p_provider) = ''
    OR p_provider_payment_id IS NULL OR btrim(p_provider_payment_id) = ''
    OR p_local_status IS NULL OR btrim(p_local_status) = ''
    OR p_provider_status IS NULL OR btrim(p_provider_status) = ''
    OR p_result_status NOT IN ('succeeded', 'failed')
    OR p_occurred_at IS NULL
    OR p_checked_at IS NULL
    OR (p_payload IS NOT NULL AND jsonb_typeof(p_payload) <> 'object')
  THEN
    RAISE EXCEPTION 'payment_reconciliation_apply_invalid_input' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('commerce.payment.reconciliation.apply:' || p_idempotency_key, 0)
  );
  IF p_result_status = 'succeeded' THEN
    PERFORM public.payment_provider_lock_aggregate(p_expected_payment_intent_id);
    SELECT (metadata ->> 'paymentEventId')::uuid, response_payload #>> '{paymentResult,kind}'
      INTO v_payment_event_id, v_previous_kind
      FROM public.payment_provider_receipts
     WHERE scope = 'commerce.payment_result.apply' AND idempotency_key = p_idempotency_key
     FOR UPDATE;
    v_has_result_receipt := FOUND;
    -- Review is final for this verified attempt. Concurrent reads can observe the
    -- same money at different times, but only an equivalent claim can reuse it.
    v_equivalent_review_replay := v_previous_kind IS NOT DISTINCT FROM 'ignored_success_requiring_review'
      AND v_payment_event_id IS NOT NULL AND p_failure_reason IS NULL AND p_failure_class IS NULL
      AND EXISTS(SELECT 1 FROM public.payment_provider_states s
       WHERE s.id=p_expected_payment_intent_id AND s.active_attempt_id=p_expected_payment_attempt_id)
      AND public.payment_provider_capture_review_required(p_expected_payment_intent_id,p_expected_payment_attempt_id);
    -- Keep the original fingerprint for a completed historical receipt with no
    -- event ID. Only a fresh success creates a provider readback evidence row.
    IF NOT v_has_result_receipt OR v_equivalent_review_replay THEN
      IF p_payload ? 'observedMoney' THEN
        -- The renewal owner already sends its normalized carrier in this shape.
        IF p_provider_status IS DISTINCT FROM 'succeeded'
          OR p_payload ->> 'providerOccurredAt' IS NULL
          OR (p_payload ->> 'providerOccurredAt')::timestamptz IS DISTINCT FROM p_occurred_at THEN
          RAISE EXCEPTION 'payment_control_result_success_evidence_required' USING ERRCODE = '22023';
        END IF;
        v_readback := p_payload -> 'observedMoney';
      ELSE
        IF p_payload ->> 'normalizedStatus' IS DISTINCT FROM 'succeeded' THEN
          RAISE EXCEPTION 'payment_control_result_success_evidence_required' USING ERRCODE = '22023';
        END IF;
        v_readback := p_payload;
      END IF;
      IF v_equivalent_review_replay THEN
        SELECT (e.source_evidence->>'observedAt')::timestamptz
          INTO v_review_observed_at
          FROM public.payment_provider_attempt_evidence e
          JOIN public.commerce_settlement_intents i ON i.id=e.settlement_intent_id
          JOIN public.payment_provider_states s ON s.id=i.id AND s.active_attempt_id=e.payment_attempt_id
          JOIN public.payment_provider_attempts a ON a.id=e.payment_attempt_id AND a.settlement_intent_id=i.id
         WHERE e.id=v_payment_event_id AND e.received_via='reconciliation_read.v1'
           AND e.settlement_intent_id=p_expected_payment_intent_id AND e.payment_attempt_id=p_expected_payment_attempt_id
           AND i.order_id=p_expected_order_id AND s.payment_id=p_expected_payment_id
           AND e.provider=p_provider AND a.provider=e.provider AND e.provider_payment_id=p_provider_payment_id
           AND e.provider_payment_id IN (a.provider_attempt_id,a.provider_session_id)
           AND e.captured_amount_basis='provider_capture_v1'
           AND e.captured_amount_basis=p_payload->>'capturedAmountBasis'
           AND e.source_evidence->>'providerStatus'=p_provider_status
           AND v_readback->'amountMinor'=to_jsonb(e.amount_minor)
           AND upper(v_readback->>'currency')=e.currency;
        IF v_review_observed_at IS NULL THEN
          RAISE EXCEPTION 'payment_reconciliation_apply_evidence_conflict' USING ERRCODE='23505';
        END IF;
      ELSE
        v_payment_event_id := (public.payment_provider_record_capture_readback(
          p_idempotency_key, p_expected_order_id, p_expected_payment_intent_id,
          p_expected_payment_attempt_id, p_expected_payment_id, p_provider, p_provider_payment_id,
          p_provider_status, p_occurred_at, p_checked_at, v_readback -> 'amountMinor',
          v_readback ->> 'currency', p_payload ->> 'capturedAmountBasis'
        ) ->> 'id')::uuid;
      END IF;
    END IF;
  END IF;
  v_apply := public.payment_provider_result_apply(
    p_idempotency_key => p_idempotency_key,
    p_payment_intent_id => p_expected_payment_intent_id,
    p_payment_event_id => v_payment_event_id,
    p_result_status => p_result_status,
    p_occurred_at => COALESCE(v_review_observed_at,p_occurred_at),
    p_failure_reason => p_failure_reason,
    p_failure_class => p_failure_class,
    p_failure_class_decided_by => p_failure_class_decided_by,
    p_dunning_template_slug => p_dunning_template_slug,
    p_recovery_url_path => p_recovery_url_path,
    p_recovery_template_slug => p_recovery_template_slug
  );
  v_payment_result := v_apply -> 'paymentResult';

  IF v_payment_result IS NULL
    OR v_payment_result ->> 'status' IS DISTINCT FROM p_result_status
    OR NULLIF(btrim(v_payment_result ->> 'kind'), '') IS NULL
    OR (v_payment_result ->> 'paymentIntentId')::uuid IS DISTINCT FROM p_expected_payment_intent_id
    OR (v_payment_result ->> 'paymentAttemptId')::uuid IS DISTINCT FROM p_expected_payment_attempt_id
    OR (v_payment_result ->> 'paymentId')::uuid IS DISTINCT FROM p_expected_payment_id
    OR (v_payment_result ->> 'orderId')::uuid IS DISTINCT FROM p_expected_order_id
  THEN
    RAISE EXCEPTION 'payment_reconciliation_apply_claim_mismatch' USING ERRCODE = '22023';
  END IF;

  v_kind := v_payment_result ->> 'kind';
  v_correction_status := CASE WHEN v_kind LIKE 'ignored%' THEN 'ignored' ELSE 'corrected' END;
  v_applied := v_correction_status = 'corrected';
  v_apply_replayed := COALESCE((v_payment_result ->> 'replayed')::boolean, false);

  v_evidence_key := p_idempotency_key || ':evidence';
  SELECT *
    INTO v_existing_evidence
    FROM public.payment_provider_reconciliation_runs
   WHERE idempotency_key = v_evidence_key
   FOR UPDATE;
  v_has_existing_evidence := FOUND;

  IF v_has_existing_evidence AND v_existing_evidence.payload ->> 'dunningObservationRefusal' IN (
    'subscription_dunning_failed_attempt_unattributed',
    'subscription_dunning_case_unattributed',
    'subscription_dunning_replay_unavailable',
    'subscription_dunning_failed_attempt_ambiguous',
    'subscription_dunning_failed_attempt_rung_mismatch'
  ) THEN
    v_dunning_refusal := v_existing_evidence.payload ->> 'dunningObservationRefusal';
    v_dunning := jsonb_build_object('subscriptionWebhookDunning',
      jsonb_build_object('opened', false, 'replayed', true,
        'reason', v_dunning_refusal,
        'failedPaymentAttemptId', p_expected_payment_attempt_id));
    v_dunning_replayed := true;
  ELSIF p_result_status = 'failed' AND v_kind NOT LIKE 'ignored%' THEN
    BEGIN
      v_dunning := public.payment_reconciliation_open_dunning_from_failed_result(
        p_idempotency_key || ':dunning',
        p_expected_payment_intent_id,
        NULL,
        p_failure_reason,
        p_occurred_at,
        p_failure_class,
        p_expected_payment_attempt_id, p_dunning_template_slug, p_recovery_url_path
      );
    EXCEPTION WHEN SQLSTATE '55000' THEN
      IF SQLERRM NOT IN (
        'subscription_dunning_failed_attempt_unattributed',
        'subscription_dunning_case_unattributed',
        'subscription_dunning_replay_unavailable',
        'subscription_dunning_failed_attempt_ambiguous',
        'subscription_dunning_failed_attempt_rung_mismatch'
      ) THEN
        RAISE;
      END IF;
      v_dunning_refusal := SQLERRM;
      v_dunning := jsonb_build_object('subscriptionWebhookDunning',
        jsonb_build_object('opened', false, 'replayed', false,
          'reason', v_dunning_refusal,
          'failedPaymentAttemptId', p_expected_payment_attempt_id));
    END;
    v_dunning_replayed := COALESCE(
      (v_dunning #>> '{subscriptionWebhookDunning,replayed}')::boolean,
      false
    );
  END IF;

  v_evidence_payload := (COALESCE(p_payload, '{}'::jsonb) - 'dunningObservationRefusal') || jsonb_build_object(
    'applied', v_applied,
    'resultStatus', p_result_status,
    'resultKind', v_kind
  );
  IF v_dunning_refusal IS NOT NULL THEN
    v_evidence_payload := v_evidence_payload || jsonb_build_object(
      'dunningObservationRefusal', v_dunning_refusal
    );
  END IF;

  IF v_has_existing_evidence THEN
    IF v_equivalent_review_replay THEN
      -- The original review receipt keeps its checked time and recorded payload.
      p_local_status := v_existing_evidence.local_status;
      p_checked_at := v_existing_evidence.checked_at;
      v_evidence_payload := v_existing_evidence.payload;
    END IF;
    -- Upgraded callers add the observed amount to an otherwise exact replay.
    -- A legacy response is never evidence for a fresh success or a new readback.
    IF p_result_status = 'succeeded' AND v_apply_replayed AND v_payment_event_id IS NULL
      AND NOT (v_existing_evidence.payload ? 'amountMinor')
      AND v_evidence_payload -> 'amountMinor' = (
        SELECT to_jsonb(amount_minor) FROM public.payment_provider_attempts WHERE id = p_expected_payment_attempt_id
      ) THEN
      v_evidence_payload := v_evidence_payload - 'amountMinor';
    END IF;
    IF p_result_status='succeeded' AND v_apply_replayed AND v_payment_event_id IS NULL
      AND NOT (v_existing_evidence.payload ? 'capturedAmountBasis')
      AND v_evidence_payload ->> 'capturedAmountBasis' = 'provider_capture_v1' THEN
      v_evidence_payload := v_evidence_payload - 'capturedAmountBasis';
    END IF;
    IF v_existing_evidence.provider IS DISTINCT FROM p_provider
      OR v_existing_evidence.provider_payment_id IS DISTINCT FROM p_provider_payment_id
      OR v_existing_evidence.payment_intent_id IS DISTINCT FROM p_expected_payment_intent_id
      OR v_existing_evidence.payment_attempt_id IS DISTINCT FROM p_expected_payment_attempt_id
      OR v_existing_evidence.local_status IS DISTINCT FROM p_local_status
      OR v_existing_evidence.provider_status IS DISTINCT FROM p_provider_status
      OR v_existing_evidence.correction_status IS DISTINCT FROM v_correction_status
      OR v_existing_evidence.checked_at IS DISTINCT FROM p_checked_at
      OR v_existing_evidence.payload IS DISTINCT FROM v_evidence_payload
    THEN
      RAISE EXCEPTION 'payment_reconciliation_apply_evidence_conflict' USING ERRCODE = '23505';
    END IF;
    v_evidence_replayed := true;
  END IF;

  v_evidence := public.commerce_payment_control_record_reconciliation(
    v_evidence_key,
    p_provider,
    p_provider_payment_id,
    p_expected_payment_intent_id,
    p_expected_payment_attempt_id,
    p_local_status,
    p_provider_status,
    v_correction_status,
    p_checked_at,
    v_evidence_payload
  );

  RETURN jsonb_build_object(
    'contractVersion', 'commerce.v0',
    'paymentReconciliationApply', jsonb_build_object(
      'paymentResult', v_payment_result,
      'paymentReconciliation', v_evidence -> 'paymentReconciliation',
      'subscriptionWebhookDunning', v_dunning -> 'subscriptionWebhookDunning',
      'correctionStatus', v_correction_status,
      'applied', v_applied,
      'applyReplayed', v_apply_replayed,
      'evidenceReplayed', v_evidence_replayed,
      'dunningReplayed', v_dunning_replayed,
      'replayed', v_apply_replayed AND v_evidence_replayed
        AND (v_dunning IS NULL OR v_dunning_replayed)
    )
  );
END;
$$;

-- A stale claim may read only handles belonging to the current attempt.
CREATE OR REPLACE FUNCTION public.commerce_payment_reconciliation_claim_stale_attempts(
  p_now timestamptz DEFAULT now(),
  p_stale_after_seconds integer DEFAULT 900,
  p_limit integer DEFAULT 50,
  p_claim_key text DEFAULT NULL
)
RETURNS TABLE (
  payment_attempt_id uuid,
  payment_intent_id uuid,
  payment_id uuid,
  order_id uuid,
  subscription_id uuid,
  subscription_cycle_id uuid,
  provider text,
  provider_payment_id text,
  provider_attempt_id text,
  provider_session_id text,
  attempt_status text,
  intent_status text,
  amount_cents bigint,
  currency text,
  order_mode text,
  cycle_retry_attempt integer,
  cycle_next_retry_at timestamptz,
  local_updated_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_claim_key text;
  v_cutoff timestamptz;
BEGIN
  IF p_now IS NULL
    OR p_stale_after_seconds IS NULL
    OR p_stale_after_seconds < 60
    OR p_stale_after_seconds > 86400
    OR p_limit IS NULL
    OR p_limit < 1
    OR p_limit > 500
  THEN
    RAISE EXCEPTION 'payment_reconciliation_claim_invalid_input' USING ERRCODE = '22023';
  END IF;

  v_claim_key := COALESCE(
    NULLIF(btrim(p_claim_key), ''),
    'payment-provider-reconciliation:' || floor(extract(epoch FROM p_now) / 1800)::bigint::text
  );
  IF length(v_claim_key) < 8 THEN
    RAISE EXCEPTION 'payment_reconciliation_claim_invalid_key' USING ERRCODE = '22023';
  END IF;

  v_cutoff := p_now - make_interval(secs => p_stale_after_seconds);

  RETURN QUERY
    WITH candidates AS (
      SELECT
        a.id AS payment_attempt_id,
        i.id AS payment_intent_id,
        i.payment_id,
        i.order_id,
        i.subscription_id,
        i.subscription_cycle_id,
        a.provider,
        CASE
          WHEN (SELECT readback_reference_order FROM public.payment_provider_profile(a.provider)) = 'session-attempt-intent' THEN COALESCE(a.provider_session_id, a.provider_attempt_id)
          ELSE COALESCE(a.provider_attempt_id, a.provider_session_id)
        END AS provider_payment_id,
        a.provider_attempt_id,
        a.provider_session_id,
        a.status AS attempt_status,
        i.status AS intent_status,
        a.amount_minor AS amount_cents,
        a.currency,
        CASE WHEN o.subscription_cycle_id IS NULL THEN 'one_time' ELSE 'subscription_cycle' END AS order_mode,
        COALESCE(retry.retry_attempt, 0) AS cycle_retry_attempt,
        retry.next_retry_at AS cycle_next_retry_at,
        GREATEST(a.updated_at, i.updated_at) AS local_updated_at
      FROM public.payment_provider_attempts AS a
      JOIN (SELECT state.*, intent.order_id FROM public.payment_provider_states state
        JOIN public.commerce_settlement_intents intent ON intent.id=state.id) AS i
        ON i.id = a.settlement_intent_id
       AND i.active_attempt_id = a.id
      JOIN public.commerce_orders AS o
        ON o.id = i.order_id
      LEFT JOIN public.subscription_cycles AS c
        ON c.id = i.subscription_cycle_id
       AND c.subscription_id = i.subscription_id
      LEFT JOIN public.subscription_retry_obligations retry ON retry.cycle_id=c.id
      LEFT JOIN LATERAL (
        SELECT max(r.checked_at) AS last_checked_at
          FROM public.payment_provider_reconciliation_runs AS r
         WHERE r.payment_attempt_id = a.id
      ) AS latest_run ON true
      WHERE (
          (
            i.target_kind = 'subscription_cycle'
            AND o.subscription_cycle_id IS NOT NULL
            AND i.subscription_id IS NOT NULL
            AND i.subscription_cycle_id IS NOT NULL
            AND c.subscription_id = i.subscription_id
            AND o.subscription_cycle_id = i.subscription_cycle_id
            AND c.id IS NOT NULL
          )
          OR (
            i.target_kind = 'one_time_order'
            AND o.subscription_cycle_id IS NULL
            AND i.subscription_id IS NULL
            AND i.subscription_cycle_id IS NULL

            AND o.subscription_cycle_id IS NULL
          )
        )
        AND i.status IN ('requires_action', 'processing')
        AND a.status IN ('sent_to_provider', 'requires_action', 'processing')
        AND (SELECT claim_stale FROM public.payment_provider_profile(a.provider))
        AND GREATEST(a.updated_at, i.updated_at) <= v_cutoff
        AND NOT public.payment_provider_capture_review_required(i.id,a.id)
        AND (
          a.provider_attempt_id IS NOT NULL
          OR a.provider_session_id IS NOT NULL
        )
        AND NOT EXISTS (
          SELECT 1
            FROM public.payment_provider_reconciliation_runs AS r
           WHERE r.payment_attempt_id = a.id
             AND r.correction_status = 'corrected'
             AND r.provider_status IN ('succeeded', 'failed')
        )
      ORDER BY latest_run.last_checked_at ASC NULLS FIRST,
               GREATEST(a.updated_at, i.updated_at) ASC,
               a.id ASC
      LIMIT p_limit
      FOR UPDATE OF a SKIP LOCKED
    ),
    claimed AS (
      INSERT INTO public.payment_provider_reconciliation_runs (
        provider,
        provider_payment_id,
        payment_intent_id,
        payment_attempt_id,
        local_status,
        provider_status,
        correction_status,
        idempotency_key,
        checked_at,
        payload
      )
      SELECT
        candidates.provider,
        candidates.provider_payment_id,
        candidates.payment_intent_id,
        candidates.payment_attempt_id,
        candidates.attempt_status,
        'claiming',
        'observed',
        v_claim_key || ':' || candidates.payment_attempt_id::text,
        p_now,
        jsonb_build_object(
          'source', 'payment-provider-reconciliation.claim.v0',
          'intentStatus', candidates.intent_status,
          'orderId', candidates.order_id,
          'subscriptionId', candidates.subscription_id,
          'subscriptionCycleId', candidates.subscription_cycle_id,
          'staleAfterSeconds', p_stale_after_seconds
        )
      FROM candidates
      ON CONFLICT (idempotency_key) DO NOTHING
      RETURNING public.payment_provider_reconciliation_runs.payment_attempt_id
    )
    SELECT
      candidates.payment_attempt_id,
      candidates.payment_intent_id,
      candidates.payment_id,
      candidates.order_id,
      candidates.subscription_id,
      candidates.subscription_cycle_id,
      candidates.provider,
      candidates.provider_payment_id,
      candidates.provider_attempt_id,
      candidates.provider_session_id,
      candidates.attempt_status,
      candidates.intent_status,
      candidates.amount_cents,
      candidates.currency,
      candidates.order_mode,
      candidates.cycle_retry_attempt,
      candidates.cycle_next_retry_at,
      candidates.local_updated_at
    FROM candidates
    JOIN claimed
      ON claimed.payment_attempt_id = candidates.payment_attempt_id
    ORDER BY candidates.local_updated_at ASC, candidates.payment_attempt_id ASC;
END;
$$;
