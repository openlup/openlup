-- Immutable provider policies. NULL enumerates declarations for early tuple validation;
-- any other identifier resolves exactly one declaration or the generic fallback.
CREATE FUNCTION public.payment_provider_profile(p_provider text)
RETURNS TABLE (
 provider text,
 initial_flow text,
 one_time_flow text,
 requires_attempt_truth boolean,
 readback_reference_order text,
 claim_stale boolean,
 claim_prepared boolean,
 refund_kind text,
 refund_event_type text,
 refund_operation_path text[],
 refund_amount_path text[],
 refund_event_money_original boolean,
 refund_full_evidence boolean,
 refund_status_match boolean,
 refund_ignore_old boolean,
 refund_ignored_kind text,
 renewal_absence boolean,
 interactive boolean,
 trusted_oauth_codes text[],
 trusted_dispatch_codes text[],
 trusted_refusal_code text
) LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
 WITH declarations(provider,initial_flow,one_time_flow,requires_attempt_truth,readback_reference_order,claim_stale,claim_prepared,refund_kind,refund_event_type,refund_operation_path,refund_amount_path,refund_event_money_original,refund_full_evidence,refund_status_match,refund_ignore_old,refund_ignored_kind,renewal_absence,interactive,trusted_oauth_codes,trusted_dispatch_codes,trusted_refusal_code) AS (VALUES
  ('stripe','one_time_payment','one_time_payment',true,'attempt-intent-session',true,true,
   'cumulative-snapshot','charge.refunded',ARRAY['stripeRefundSnapshot','chargeId'],
   ARRAY['stripeRefundSnapshot','amountRefundedMinor'],true,true,true,true,'ignored_stripe_refund_snapshot',
   true,false,ARRAY[]::text[],ARRAY[]::text[],NULL::text),
  ('tpay','blik_recurring_activation','blik_one_time',true,'session-attempt-intent',true,true,
   'event-delta',NULL::text,NULL::text[],NULL::text[],false,false,false,false,NULL::text,
   true,true,ARRAY['tpay_oauth_failed','tpay_oauth_timeout','tpay_oauth_invalid_response'],
   ARRAY['tpay_request_encode_failed','tpay_request_deadline_exhausted'],'tpay_request_refused')
 )
 SELECT * FROM declarations WHERE p_provider IS NULL OR provider=p_provider
 UNION ALL
 SELECT p_provider,NULL,NULL,false,'attempt-intent-session',false,false,
  'event-delta',NULL,NULL,NULL,false,false,false,false,NULL,false,false,ARRAY[]::text[],ARRAY[]::text[],NULL
 WHERE p_provider IS NOT NULL AND NOT EXISTS(SELECT 1 FROM declarations WHERE provider=p_provider);
$$;

CREATE OR REPLACE FUNCTION public.payment_provider_attempt_prepare(
  p_idempotency_key text,
  p_settlement_intent_id uuid,
  p_provider text,
  p_provider_idempotency_key text,
  p_provider_request_fingerprint text,
  p_provider_flow text,
  p_payment_method_ref text,
  p_request_payload jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_scope constant text := 'commerce.payment_attempt.prepare_provider';
  v_request_fingerprint text;
  v_existing public.payment_provider_receipts%ROWTYPE;
  v_intent record;
  v_attempt public.payment_provider_attempts%ROWTYPE;
  v_attempt_id uuid;
  v_request_payload jsonb;
  v_response jsonb;
  v_order public.commerce_orders%ROWTYPE;
  v_active_attempt public.payment_provider_attempts%ROWTYPE;
  v_observed_success_attempt public.payment_provider_attempts%ROWTYPE;
  v_subscription_status text;
  v_inline_retry boolean := COALESCE(p_request_payload->>'source','')='commerce.checkout-inline-recovery.prepare.v1';
  v_expected_attempt_id uuid;
  v_hold record;
BEGIN
  IF v_inline_retry THEN
   IF NOT regexp_like(COALESCE(p_request_payload->>'expectedPaymentAttemptId',''),
     '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$')
    OR NOT regexp_like(COALESCE(p_request_payload->>'retryRequestId',''),
     '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$')
    OR COALESCE(p_request_payload->>'purchaseContext','') NOT IN ('one_time','subscription_initial') THEN
    RAISE EXCEPTION 'payment_control_inline_retry_invalid_context' USING ERRCODE='22023'; END IF;
   v_expected_attempt_id:=(p_request_payload->>'expectedPaymentAttemptId')::uuid;
  END IF;
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' OR length(p_idempotency_key) < 8
    OR p_settlement_intent_id IS NULL
    OR p_provider IS NULL OR btrim(p_provider) = ''
    OR p_provider_idempotency_key IS NULL OR btrim(p_provider_idempotency_key) = ''
    OR p_provider_request_fingerprint IS NULL OR btrim(p_provider_request_fingerprint) = ''
    OR p_provider_flow IS NULL OR btrim(p_provider_flow) = ''
  THEN
    RAISE EXCEPTION 'payment_control_provider_attempt_prepare_invalid_input' USING ERRCODE = '22023';
  END IF;

  IF p_provider_flow NOT IN (
    'one_time_payment',
    'setup_reusable_method',
    'off_session_payment',
    'blik_one_time',
    'blik_one_click',
    'pbl_one_time',
    'blik_recurring_activation',
    'recurring_charge'
  ) THEN
    RAISE EXCEPTION 'payment_control_provider_attempt_prepare_invalid_flow' USING ERRCODE = '22023';
  END IF;

  v_request_payload := COALESCE(p_request_payload, '{}'::jsonb) || jsonb_build_object(
    'providerIdempotencyKey', p_provider_idempotency_key,
    'providerRequestFingerprint', p_provider_request_fingerprint,
    'providerFlow', p_provider_flow,
    'paymentMethodRef', p_payment_method_ref
  );

  v_request_fingerprint := md5(
    p_settlement_intent_id::text || '|' ||
    p_provider || '|' ||
    p_provider_idempotency_key || '|' ||
    p_provider_request_fingerprint || '|' ||
    p_provider_flow || '|' ||
    COALESCE(p_payment_method_ref, '') || '|' ||
    v_request_payload::text
  );

  PERFORM public.payment_provider_lock_aggregate(p_settlement_intent_id);

  IF v_inline_retry AND EXISTS(SELECT 1 FROM public.commerce_settlement_intents i
    JOIN public.commerce_orders o ON o.id=i.order_id WHERE i.id=p_settlement_intent_id
     AND (o.status<>'pending_payment' OR o.metadata->>'paymentStatus'='expired')) THEN
    RAISE EXCEPTION 'payment_control_inline_retry_order_not_payable' USING ERRCODE='55000';
  END IF;

  SELECT *
    INTO v_existing
    FROM public.payment_provider_receipts
   WHERE scope = v_scope
     AND idempotency_key = p_idempotency_key
   FOR UPDATE;

  IF FOUND THEN
    IF v_existing.status = 'completed'
      AND v_existing.request_fingerprint = v_request_fingerprint
      AND v_existing.response_payload IS NOT NULL
    THEN
      v_attempt_id := (v_existing.response_payload -> 'paymentAttempt' ->> 'id')::uuid;
      SELECT *
        INTO v_attempt
        FROM public.payment_provider_attempts
       WHERE id = v_attempt_id;

      IF FOUND THEN
        RETURN jsonb_build_object(
          'contractVersion', 'commerce.v0',
          'paymentAttempt', jsonb_build_object(
            'id', v_attempt.id,
            'paymentIntentId', v_attempt.settlement_intent_id,
            'status', v_attempt.status,
            'provider', v_attempt.provider,
            'providerAttemptId', v_attempt.provider_attempt_id,
            'providerSessionId', v_attempt.provider_session_id,
            'nextActionKind', v_attempt.next_action_kind,
            'idempotencyKey', p_idempotency_key,
            'replayed', true
          )
        );
      END IF;

      RETURN jsonb_set(v_existing.response_payload, '{paymentAttempt,replayed}', 'true'::jsonb, false);
    END IF;

    RAISE EXCEPTION 'payment_control_provider_attempt_prepare_idempotency_conflict' USING ERRCODE = '23505';
  END IF;

  SELECT ps.*,i.amount_minor,i.currency_code AS currency,i.order_id,i.status AS settlement_status
    INTO v_intent FROM public.payment_provider_states ps
    JOIN public.commerce_settlement_intents i ON i.id=ps.id
    WHERE ps.id=p_settlement_intent_id FOR UPDATE OF ps;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'payment_control_provider_attempt_prepare_intent_not_found' USING ERRCODE = '22023';
  END IF;
  IF v_intent.status IN ('succeeded', 'cancelled', 'refunded', 'partially_refunded', 'disputed')
    OR v_intent.settlement_status IN ('settled','cancelled') THEN
    RAISE EXCEPTION 'payment_control_provider_attempt_prepare_intent_not_retryable' USING ERRCODE = '22023';
  END IF;

  -- Exact persisted receipts have already replayed above. A fresh browser key
  -- cannot authorize another provider call while any exact attempt is unresolved.
  SELECT a.* INTO v_observed_success_attempt FROM public.payment_provider_attempts a
  WHERE a.settlement_intent_id=v_intent.id AND a.payment_id=v_intent.payment_id AND EXISTS(
   SELECT 1 FROM public.payment_provider_attempt_evidence e WHERE e.settlement_intent_id=a.settlement_intent_id
    AND e.payment_attempt_id=a.id AND e.provider=a.provider AND e.provider_payment_id=a.provider_attempt_id
    AND e.signature_verified IS TRUE AND e.event_type='payment.succeeded')
  ORDER BY a.created_at DESC,a.id DESC LIMIT 1 FOR UPDATE;
  IF FOUND THEN
   RETURN jsonb_set(public.payment_provider_attempt_read(v_intent.id,v_observed_success_attempt.id),'{paymentAttempt,replayed}','true'::jsonb,false);
  END IF;
  SELECT * INTO v_order FROM public.commerce_orders WHERE id=v_intent.order_id;
  SELECT status INTO v_subscription_status FROM public.subscriptions WHERE id=v_intent.subscription_id;
  IF v_inline_retry THEN
   IF v_order.status<>'pending_payment' OR v_order.metadata->>'paymentStatus'='expired' THEN
    RAISE EXCEPTION 'payment_control_inline_retry_order_not_payable' USING ERRCODE='55000'; END IF;
   IF v_intent.status<>'failed' OR v_intent.active_attempt_id IS DISTINCT FROM v_expected_attempt_id THEN
    RAISE EXCEPTION 'payment_control_inline_retry_predecessor_mismatch' USING ERRCODE='55000'; END IF;
   SELECT * INTO v_active_attempt FROM public.payment_provider_attempts WHERE id=v_expected_attempt_id
    AND settlement_intent_id=v_intent.id AND payment_id=v_intent.payment_id FOR UPDATE;
   IF NOT FOUND OR v_active_attempt.status<>'failed' THEN
    RAISE EXCEPTION 'payment_control_inline_retry_predecessor_mismatch' USING ERRCODE='55000'; END IF;
   IF p_request_payload->>'purchaseContext'='subscription_initial' THEN
    IF NOT EXISTS(SELECT 1 FROM public.subscription_activations activation WHERE activation.order_id=v_order.id
     AND activation.client_id=v_order.client_id AND activation.state='provisional' AND activation.subscription_id IS NULL)
     OR NOT EXISTS(SELECT 1 FROM public.payment_provider_profile(p_provider) policy WHERE policy.initial_flow=p_provider_flow) THEN
     RAISE EXCEPTION 'payment_control_inline_retry_context_mismatch' USING ERRCODE='55000'; END IF;
   ELSIF v_intent.target_kind<>'one_time_order' OR EXISTS(SELECT 1 FROM public.subscription_activations WHERE order_id=v_order.id)
    OR NOT EXISTS(SELECT 1 FROM public.payment_provider_profile(p_provider) policy WHERE policy.one_time_flow=p_provider_flow) THEN
    RAISE EXCEPTION 'payment_control_inline_retry_context_mismatch' USING ERRCODE='55000'; END IF;
  END IF;
  IF v_intent.target_kind='subscription_cycle' AND (v_subscription_status IS NULL OR v_subscription_status<>'active') THEN
   IF NOT EXISTS(SELECT 1 FROM public.payment_provider_attempts WHERE settlement_intent_id=v_intent.id
    AND status NOT IN ('blocked_preflight','failed','cancelled','expired')) THEN
    UPDATE public.payment_provider_states SET status='cancelled',failure_reason='subscription_not_chargeable',updated_at=now()
     WHERE id=v_intent.id AND status IN ('created','failed');
    UPDATE public.commerce_settlement_intents SET status='cancelled',failure_reason='subscription_not_chargeable',updated_at=now()
     WHERE id=v_intent.id AND status IN ('created','failed');
    UPDATE public.subscription_cycles SET status='cancelled',updated_at=now() WHERE id=v_intent.subscription_cycle_id
     AND subscription_id=v_intent.subscription_id AND status IN ('planned','payment_pending');
    UPDATE public.subscription_retry_obligations SET next_retry_at=NULL,updated_at=now() WHERE cycle_id=v_intent.subscription_cycle_id AND state='waiting';
    -- Local renewal preparation commits stock before provider preparation. A
    -- definite no-dispatch refusal belongs to the renewal outcome owner, which
    -- releases that committed reservation as well as terminalizing the operation.
    IF EXISTS(SELECT 1 FROM public.subscription_renewal_operations
      WHERE id=v_order.renewal_operation_id AND state='attempt_prepared') THEN
     PERFORM public.commerce_record_subscription_renewal_outcome(
      v_order.renewal_operation_id,'not-chargeable:'||v_intent.id,
      v_order.renewal_operation_fingerprint,'refused',NULL,'subscription_not_chargeable',now());
     UPDATE public.commerce_settlement_intents SET status='cancelled',failure_reason='subscription_not_chargeable',updated_at=now()
      WHERE id=v_intent.id AND status='failed';
    END IF;
    UPDATE public.commerce_orders SET status='cancelled',updated_at=now(),metadata=metadata||jsonb_build_object('paymentStatus','cancelled','cancelReason','subscription_not_chargeable','source','payment.control.prepare')
     WHERE id=v_intent.order_id AND status='pending_payment';
    FOR v_hold IN SELECT id FROM public.fulfillment_inventory_reservations
     WHERE purchase_order_id=v_intent.order_id AND status='held' ORDER BY id FOR UPDATE LOOP
     PERFORM public.fulfillment_release_purchase_reservation(
      'not-chargeable:'||v_hold.id,v_hold.id,'subscription_not_chargeable','{}'::jsonb,now());
    END LOOP;
   END IF;
   RETURN jsonb_build_object('contractVersion','commerce.v0','paymentAttemptAdmission',jsonb_build_object(
    'status','skipped_not_chargeable','reason','payment_control_subscription_not_chargeable','paymentIntentId',v_intent.id));
  END IF;
  IF v_intent.active_attempt_id IS NOT NULL THEN
   SELECT * INTO v_active_attempt FROM public.payment_provider_attempts WHERE id=v_intent.active_attempt_id FOR UPDATE;
   IF FOUND AND v_active_attempt.status NOT IN ('blocked_preflight','failed','cancelled','expired') THEN
    RETURN jsonb_set(public.payment_provider_attempt_read(v_intent.id,v_active_attempt.id),'{paymentAttempt,replayed}','true'::jsonb,false);
   END IF;
  END IF;

  INSERT INTO public.payment_provider_receipts (
    scope,
    idempotency_key,
    request_fingerprint,
    status,
    metadata
  )
  VALUES (
    v_scope,
    p_idempotency_key,
    v_request_fingerprint,
    'in_progress',
    jsonb_build_object('boundary', 'payment_provider_attempt_prepare')
  );

  INSERT INTO public.payment_provider_attempts (
    settlement_intent_id,
    payment_id,
    provider,
    provider_attempt_id,
    provider_session_id,
    idempotency_key,
    status,
    amount_minor,
    currency,
    next_action_kind,
    request_payload,
    response_payload
  )
  VALUES (
    v_intent.id,
    v_intent.payment_id,
    p_provider,
    NULL,
    NULL,
    p_idempotency_key,
    'created',
    v_intent.amount_minor,
    v_intent.currency,
    NULL,
    v_request_payload,
    jsonb_build_object('providerCallPlanned', true, 'providerCall', false)
  )
  RETURNING * INTO v_attempt;

  UPDATE public.payment_provider_states
     SET active_attempt_id = v_attempt.id,
         status = 'processing',
         updated_at = now()
   WHERE id = v_intent.id;

  UPDATE public.payment_provider_states
     SET payment_status = 'pending',
         provider = p_provider,
         metadata = metadata || jsonb_build_object(
           'paymentIntentId', v_intent.id,
           'paymentAttemptId', v_attempt.id,
           'source', 'payment.control.v0'
         ),
         updated_at = now()
   WHERE payment_id = v_intent.payment_id;

  INSERT INTO public.payment_provider_transitions (
    settlement_intent_id,
    payment_attempt_id,
    transition_kind,
    from_status,
    to_status,
    reason,
    idempotency_key,
    payload
  )
  VALUES (
    v_intent.id,
    v_attempt.id,
    'attempt',
    'created',
    'created',
    'provider_attempt_prepared',
    p_idempotency_key || ':attempt_prepared',
    jsonb_build_object(
      'provider', p_provider,
      'providerIdempotencyKey', p_provider_idempotency_key,
      'providerRequestFingerprint', p_provider_request_fingerprint,
      'providerFlow', p_provider_flow
    )
  )
  ON CONFLICT (idempotency_key) DO NOTHING;

  v_response := jsonb_build_object(
    'contractVersion', 'commerce.v0',
    'paymentAttempt', jsonb_build_object(
      'id', v_attempt.id,
      'paymentIntentId', v_intent.id,
      'status', v_attempt.status,
      'provider', v_attempt.provider,
      'providerAttemptId', v_attempt.provider_attempt_id,
      'providerSessionId', v_attempt.provider_session_id,
      'nextActionKind', v_attempt.next_action_kind,
      'idempotencyKey', p_idempotency_key,
      'replayed', false
    )
  );

  UPDATE public.payment_provider_receipts
     SET status = 'completed',
         response_payload = v_response,
         metadata = metadata || jsonb_build_object('paymentIntentId', v_intent.id, 'paymentAttemptId', v_attempt.id)
   WHERE scope = v_scope
     AND idempotency_key = p_idempotency_key;

  RETURN v_response;
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
   OR p_outcome NOT IN ('captured','refused')
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
 retry_sequence integer; logical_cycle integer; retry_result jsonb; expiry_escalation boolean:=false; handoff jsonb;
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
  IF s.status IN ('cancelled','refunded','partially_refunded','disputed') OR i.status='cancelled' THEN
   RAISE EXCEPTION 'payment_control_result_terminal_intent' USING ERRCODE='22023'; END IF;
 ELSIF p_result_status IN ('failed','expired') THEN
  IF s.status IN ('succeeded','refunded','partially_refunded','disputed') THEN kind:='ignored_failure_after_success_or_terminal';
  ELSIF s.target_kind='subscription_cycle' AND EXISTS(SELECT 1 FROM public.subscription_cycles WHERE id=s.subscription_cycle_id AND status IN ('skipped','cancelled') FOR UPDATE) THEN
   UPDATE public.payment_provider_attempts SET status=p_result_status,failure_reason=COALESCE(p_failure_reason,p_result_status),updated_at=now() WHERE id=a.id;
   UPDATE public.payment_provider_states SET payment_status=p_result_status,metadata=metadata||jsonb_build_object('paymentStatus',p_result_status,'failureReason',COALESCE(p_failure_reason,p_result_status),'source','payment.control.v0'),updated_at=now() WHERE id=s.id;
   kind:='ignored_failure_terminalized_cycle';
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
   ELSE jsonb_build_object('sourceKind','accepted_event','sourceReference',e.id,'attemptRef',a.id,
    'observedStatus',p_result_status,'observedAt',p_occurred_at,'payloadFingerprint',COALESCE(e.event_fingerprint,encode(sha256(convert_to(e.payload::text,'UTF8')),'hex'))) END;
  PERFORM public.payment_provider_assert_truth(i.id,outcome,i.amount_minor,i.currency_code,p_occurred_at,evidence);
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
  IF NOT expiry_escalation AND NOT (p_result_status='succeeded' AND i.status='settled') THEN
   truth:=public.payment_truth_ingest_event('provider:'||COALESCE(e.id::text,p_idempotency_key),encode(sha256(convert_to(jsonb_build_object('eventId',e.id,'intentId',i.id,'attemptId',a.id,'outcome',outcome)::text,'UTF8')),'hex'),
    p_idempotency_key||':truth',i.id,outcome,i.amount_minor,i.currency_code,p_occurred_at,native_failure,p_failure_reason,evidence,p_dunning_template_slug,p_recovery_url_path,p_recovery_template_slug);
  END IF;
  UPDATE public.payment_provider_states SET status=p_result_status,payment_status=p_result_status,
   provider_payment_id=CASE WHEN p_result_status='succeeded' THEN COALESCE(e.provider_payment_id,provider_payment_id) ELSE provider_payment_id END,
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
 IF p_failure_class IS NOT NULL THEN
  UPDATE public.payment_provider_attempts SET failure_class=p_failure_class,response_payload=response_payload||
   CASE WHEN p_failure_class_decided_by IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('failureClassDecidedBy',p_failure_class_decided_by) END WHERE id=a.id;
 END IF;
 IF p_payment_event_id IS NOT NULL THEN
  UPDATE public.payment_provider_attempt_evidence SET processed_at=now(),processing_status=CASE WHEN kind LIKE 'ignored%' THEN 'ignored' ELSE 'processed' END WHERE id=e.id;
 END IF;
 INSERT INTO public.payment_provider_transitions(settlement_intent_id,payment_attempt_id,provider_event_id,transition_kind,from_status,to_status,reason,idempotency_key,occurred_at,payload)
 VALUES(i.id,a.id,p_payment_event_id,'business_result',from_status,p_result_status,kind,p_idempotency_key||':payment_result',p_occurred_at,jsonb_build_object('orderId',o.id,'resultStatus',p_result_status,'source','payment.control.v0')||
  CASE WHEN retry_result IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('retryObligationId',retry_result->>'id',
   'retryAttempt',retry_result->'retry_attempt','nextRetryAt',retry_result->'next_retry_at','retryFailureKey',p_idempotency_key||':truth') END);
 answer:=jsonb_build_object('contractVersion','commerce.v0','paymentResult',jsonb_build_object('paymentIntentId',i.id,'paymentAttemptId',a.id,'paymentId',s.payment_id,'orderId',o.id,'status',p_result_status,'kind',kind,'idempotencyKey',p_idempotency_key,'replayed',false));
 IF p_result_status='failed' AND p_payment_event_id IS NOT NULL
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
 VALUES('commerce.payment_result.apply',p_idempotency_key,fingerprint,'completed',answer,jsonb_build_object('paymentIntentId',i.id,'paymentAttemptId',a.id));
 RETURN answer;
END;
$$;

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
          WHEN (SELECT readback_reference_order FROM public.payment_provider_profile(a.provider)) = 'session-attempt-intent' THEN COALESCE(a.provider_session_id, a.provider_attempt_id, i.provider_payment_id)
          ELSE COALESCE(a.provider_attempt_id, i.provider_payment_id, a.provider_session_id)
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
        AND (
          a.provider_attempt_id IS NOT NULL
          OR a.provider_session_id IS NOT NULL
          OR i.provider_payment_id IS NOT NULL
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

CREATE OR REPLACE FUNCTION public.commerce_payment_reconciliation_claim_prepared_attempts(
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
    RAISE EXCEPTION 'payment_reconciliation_prepared_claim_invalid_input' USING ERRCODE = '22023';
  END IF;

  v_claim_key := COALESCE(
    NULLIF(btrim(p_claim_key), ''),
    'payment-provider-reconciliation:prepared:' || floor(extract(epoch FROM p_now) / 1800)::bigint::text
  );
  IF length(v_claim_key) < 8 THEN
    RAISE EXCEPTION 'payment_reconciliation_prepared_claim_invalid_key' USING ERRCODE = '22023';
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
        NULL::text AS provider_payment_id,
        a.provider_attempt_id,
        a.provider_session_id,
        a.status AS attempt_status,
        i.status AS intent_status,
        a.amount_minor AS amount_cents,
        a.currency,
        CASE WHEN o.subscription_cycle_id IS NULL THEN 'one_time' ELSE 'subscription_cycle' END AS order_mode,
        COALESCE(retry.retry_attempt, 0) AS cycle_retry_attempt,
        retry.next_retry_at AS cycle_next_retry_at,
        GREATEST(a.updated_at, i.updated_at) AS local_updated_at,
        a.request_payload
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
            AND c.status = 'payment_pending'
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
        AND a.status = 'created'
        AND (SELECT claim_prepared FROM public.payment_provider_profile(a.provider))
        AND a.provider_attempt_id IS NULL
        AND a.provider_session_id IS NULL
        AND i.provider_payment_id IS NULL
        AND GREATEST(a.updated_at, i.updated_at) <= v_cutoff
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
        NULL::text,
        candidates.payment_intent_id,
        candidates.payment_attempt_id,
        candidates.attempt_status,
        'prepared_attempt_claiming',
        'observed',
        v_claim_key || ':prepared:' || candidates.payment_attempt_id::text,
        p_now,
        jsonb_build_object(
          'source', 'payment-provider-reconciliation.prepared-claim.v0',
          'intentStatus', candidates.intent_status,
          'orderId', candidates.order_id,
          'subscriptionId', candidates.subscription_id,
          'subscriptionCycleId', candidates.subscription_cycle_id,
          'staleAfterSeconds', p_stale_after_seconds,
          'providerFlow', candidates.request_payload ->> 'providerFlow',
          'hasProviderIdempotencyKey', candidates.request_payload ? 'providerIdempotencyKey',
          'hasProviderRequestFingerprint', candidates.request_payload ? 'providerRequestFingerprint',
          'providerCallPlanned', true,
          'providerAcknowledged', false
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

CREATE OR REPLACE FUNCTION public.payment_refund_evidence_record(p_event_id uuid,p_reference text,p_amount bigint,p_currency text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE e public.payment_provider_attempt_evidence; a public.payment_provider_attempts;
 i public.commerce_settlement_intents; prior bigint; observation text; operation text; recorded public.payment_refund_evidence;
BEGIN
 SELECT * INTO e FROM public.payment_provider_attempt_evidence WHERE id=p_event_id;
 PERFORM public.payment_provider_lock_aggregate(e.settlement_intent_id);
 SELECT * INTO e FROM public.payment_provider_attempt_evidence WHERE id=p_event_id FOR UPDATE;
 SELECT * INTO i FROM public.commerce_settlement_intents WHERE id=e.settlement_intent_id;
 SELECT * INTO a FROM public.payment_provider_attempts WHERE id=e.payment_attempt_id AND settlement_intent_id=i.id FOR UPDATE;
 IF e.id IS NULL OR a.id IS NULL OR e.event_type IS DISTINCT FROM 'payment.refunded'
  OR e.signature_verified IS DISTINCT FROM true OR e.provider IS DISTINCT FROM a.provider
  OR e.provider_payment_id IS DISTINCT FROM a.provider_attempt_id
  OR p_reference IS DISTINCT FROM e.provider_payment_id OR p_currency IS DISTINCT FROM i.currency_code
  OR e.currency IS DISTINCT FROM i.currency_code OR p_amount IS NULL OR p_amount<1 THEN
  RAISE EXCEPTION 'payment_control_result_refund_snapshot_unproven' USING ERRCODE='22023'; END IF;
 IF (SELECT refund_kind FROM public.payment_provider_profile(e.provider))='cumulative-snapshot' THEN
  IF e.payload->>'eventType' IS DISTINCT FROM (SELECT refund_event_type FROM public.payment_provider_profile(e.provider))
   OR e.payload->>'providerPaymentId' IS DISTINCT FROM e.provider_payment_id
   OR NULLIF(btrim(e.payload#>>(SELECT refund_operation_path FROM public.payment_provider_profile(e.provider))),'') IS NULL
   OR jsonb_typeof(e.payload#>(SELECT refund_amount_path FROM public.payment_provider_profile(e.provider))) IS DISTINCT FROM 'number'
   OR COALESCE(e.payload#>>(SELECT refund_amount_path FROM public.payment_provider_profile(e.provider)),'') !~ '^[0-9]{1,10}$'
   OR e.amount_minor IS DISTINCT FROM i.amount_minor THEN
   RAISE EXCEPTION 'payment_control_result_refund_snapshot_unproven' USING ERRCODE='22023'; END IF;
  IF p_amount IS DISTINCT FROM (e.payload#>>(SELECT refund_amount_path FROM public.payment_provider_profile(e.provider)))::bigint OR p_amount>i.amount_minor THEN
   RAISE EXCEPTION 'payment_control_result_refund_snapshot_unproven' USING ERRCODE='22023'; END IF;
  observation:='cumulative-snapshot'; operation:=e.payload#>>(SELECT refund_operation_path FROM public.payment_provider_profile(e.provider));
 ELSE
  IF e.payload#>>'{openlupEvidence,refund,kind}'='event-delta' THEN
   IF jsonb_typeof(e.payload#>'{openlupEvidence,refund,refundedMoney,amountMinor}') IS DISTINCT FROM 'number'
    OR COALESCE(e.payload#>>'{openlupEvidence,refund,refundedMoney,amountMinor}','') !~ '^[0-9]{1,10}$'
    OR p_amount IS DISTINCT FROM (e.payload#>>'{openlupEvidence,refund,refundedMoney,amountMinor}')::bigint
    OR e.payload#>>'{openlupEvidence,refund,refundedMoney,currency}' IS DISTINCT FROM p_currency THEN
    RAISE EXCEPTION 'payment_control_result_refund_snapshot_unproven' USING ERRCODE='22023'; END IF;
  ELSIF p_amount IS DISTINCT FROM e.amount_minor THEN
   RAISE EXCEPTION 'payment_control_result_refund_snapshot_unproven' USING ERRCODE='22023'; END IF;
  observation:='event-delta'; operation:=e.provider_event_id;
 END IF;
 SELECT * INTO recorded FROM public.payment_refund_evidence WHERE source_evidence_id=e.id;
 IF FOUND THEN
  IF recorded.provider_reference IS DISTINCT FROM p_reference OR recorded.amount_minor IS DISTINCT FROM p_amount
   OR recorded.currency IS DISTINCT FROM p_currency THEN
   RAISE EXCEPTION 'payment_refund_evidence_conflict' USING ERRCODE='23505'; END IF;
  RETURN to_jsonb(recorded); END IF;
 SELECT max(amount_minor) INTO prior FROM public.payment_refund_evidence
  WHERE payment_intent_id=i.id AND payment_attempt_id=a.id AND operation_id=operation AND currency=p_currency AND status='accepted';
 INSERT INTO public.payment_refund_evidence(event_id,source_evidence_id,payment_intent_id,payment_attempt_id,
  provider_reference,operation_id,observation_kind,amount_minor,currency,status)
 VALUES((SELECT id FROM public.payment_truth_events WHERE settlement_intent_id=i.id AND outcome='captured' ORDER BY id LIMIT 1),
  e.id,i.id,a.id,p_reference,operation,observation,p_amount,p_currency,
  CASE WHEN observation='cumulative-snapshot' AND prior>=p_amount THEN 'ignored' ELSE 'accepted' END) RETURNING * INTO recorded;
 RETURN to_jsonb(recorded);
END;
$$;

CREATE OR REPLACE FUNCTION public.commerce_order_provider_refund_evidence(p_order_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
 SELECT public.payment_refund_readback(i.id) FROM public.commerce_settlement_intents i
 WHERE i.order_id=p_order_id AND EXISTS(SELECT 1 FROM public.payment_refund_evidence r
   JOIN public.payment_provider_attempt_evidence e ON e.id=r.source_evidence_id
   WHERE r.payment_intent_id=i.id AND r.status='accepted')
 AND NOT EXISTS(SELECT 1 FROM public.payment_refund_evidence r
   JOIN public.payment_provider_attempt_evidence e ON e.id=r.source_evidence_id
   WHERE r.payment_intent_id=i.id AND (SELECT refund_full_evidence FROM public.payment_provider_profile(e.provider)) AND r.status='accepted' AND r.amount_minor<i.amount_minor
   AND NOT EXISTS(SELECT 1 FROM public.payment_refund_evidence full_refund WHERE full_refund.payment_intent_id=r.payment_intent_id
    AND full_refund.payment_attempt_id=r.payment_attempt_id AND full_refund.operation_id=r.operation_id
    AND full_refund.currency=r.currency AND full_refund.status='accepted' AND full_refund.amount_minor=i.amount_minor));
$$;

CREATE OR REPLACE FUNCTION public.payment_refund_apply_result(
 p_idempotency_key text,p_payment_intent_id uuid,p_payment_event_id uuid,p_result_status text,
 p_occurred_at timestamptz,p_failure_reason text,p_failure_class text,p_failure_class_decided_by text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE i public.commerce_settlement_intents; s public.payment_provider_states; a public.payment_provider_attempts;
 e public.payment_provider_attempt_evidence; purchase public.commerce_orders; held record; accepted jsonb;
 amount bigint; fingerprint text; receipt public.payment_provider_receipts; kind text:='state_changed';
 target_status text; answer jsonb; financial jsonb;
BEGIN
 IF p_idempotency_key IS NULL OR length(p_idempotency_key)<8 OR btrim(p_idempotency_key)=''
  OR p_payment_intent_id IS NULL OR p_result_status IS NULL OR p_result_status NOT IN ('refunded','partially_refunded','disputed')
  OR p_occurred_at IS NULL THEN RAISE EXCEPTION 'payment_control_result_invalid_input' USING ERRCODE='22023'; END IF;
 PERFORM public.payment_provider_lock_aggregate(p_payment_intent_id);
 fingerprint:=md5(p_payment_intent_id::text||'|'||COALESCE(p_payment_event_id::text,'')||'|'||p_result_status||'|'||p_occurred_at::text||'|'||COALESCE(p_failure_reason,'')||CASE WHEN p_failure_class IS NULL THEN '' ELSE '|failure_class='||p_failure_class END);
 SELECT * INTO receipt FROM public.payment_provider_receipts WHERE scope='commerce.payment_result.apply' AND idempotency_key=p_idempotency_key FOR UPDATE;
 IF FOUND THEN
  IF receipt.status='completed' AND receipt.request_fingerprint=fingerprint AND receipt.response_payload IS NOT NULL THEN
   RETURN jsonb_set(receipt.response_payload,'{paymentResult,replayed}','true'::jsonb,false); END IF;
  RAISE EXCEPTION 'payment_control_result_idempotency_conflict' USING ERRCODE='23505'; END IF;
 SELECT * INTO i FROM public.commerce_settlement_intents WHERE id=p_payment_intent_id;
 SELECT * INTO s FROM public.payment_provider_states WHERE id=p_payment_intent_id FOR UPDATE;
 SELECT * INTO a FROM public.payment_provider_attempts WHERE id=s.active_attempt_id AND settlement_intent_id=i.id FOR UPDATE;
 IF a.id IS NULL THEN RAISE EXCEPTION 'payment_control_result_active_attempt_not_found' USING ERRCODE='22023'; END IF;
 IF s.status NOT IN ('succeeded','partially_refunded','refunded','disputed') THEN
  RAISE EXCEPTION 'payment_control_result_refund_or_dispute_requires_success' USING ERRCODE='22023'; END IF;
 SELECT * INTO purchase FROM public.commerce_orders WHERE id=i.order_id;
 IF p_payment_event_id IS NOT NULL THEN
  SELECT * INTO e FROM public.payment_provider_attempt_evidence WHERE id=p_payment_event_id FOR UPDATE;
  IF e.id IS NULL OR e.settlement_intent_id IS DISTINCT FROM i.id THEN
   RAISE EXCEPTION 'payment_control_result_event_mismatch' USING ERRCODE='22023'; END IF;
  IF e.payment_attempt_id IS NULL THEN RAISE EXCEPTION 'payment_control_result_attempt_unresolved' USING ERRCODE='22023'; END IF;
  IF e.payment_attempt_id IS DISTINCT FROM a.id THEN RAISE EXCEPTION 'payment_control_result_attempt_mismatch' USING ERRCODE='22023'; END IF;
  IF e.currency IS NOT NULL AND e.currency<>i.currency_code THEN
   RAISE EXCEPTION 'payment_control_result_currency_mismatch' USING ERRCODE='22023'; END IF;
  IF p_result_status IN ('refunded','partially_refunded') THEN
   amount:=CASE WHEN (SELECT refund_kind FROM public.payment_provider_profile(e.provider))='cumulative-snapshot' AND e.payload#>>(SELECT refund_amount_path FROM public.payment_provider_profile(e.provider)) ~ '^[0-9]{1,10}$'
    THEN (e.payload#>>(SELECT refund_amount_path FROM public.payment_provider_profile(e.provider)))::bigint
    WHEN e.payload#>>'{openlupEvidence,refund,kind}'='event-delta' THEN
     CASE WHEN e.payload#>>'{openlupEvidence,refund,refundedMoney,amountMinor}' ~ '^[0-9]{1,10}$'
      THEN (e.payload#>>'{openlupEvidence,refund,refundedMoney,amountMinor}')::bigint END
    ELSE e.amount_minor END;
   IF (SELECT refund_status_match FROM public.payment_provider_profile(e.provider)) AND ((p_result_status='refunded') IS DISTINCT FROM (amount=i.amount_minor)) THEN
    RAISE EXCEPTION 'payment_control_result_refund_snapshot_unproven' USING ERRCODE='22023'; END IF;
   accepted:=public.payment_refund_evidence_record(e.id,e.provider_payment_id,amount,e.currency);
   IF (SELECT refund_ignore_old FROM public.payment_provider_profile(e.provider)) AND (accepted->>'status'='ignored' OR (s.status='refunded' AND p_result_status='partially_refunded')) THEN
    kind:=(SELECT refund_ignored_kind FROM public.payment_provider_profile(e.provider)); END IF;
  END IF;
 END IF;
 target_status:=CASE WHEN kind LIKE 'ignored%' THEN s.status ELSE p_result_status END;
 IF kind='state_changed' THEN
  UPDATE public.payment_provider_states SET status=p_result_status,payment_status=p_result_status,
   metadata=metadata||jsonb_build_object('paymentStatus',p_result_status,'source','payment.control.v0'),updated_at=now() WHERE id=s.id;
  IF p_result_status='refunded' THEN
   IF e.id IS NOT NULL THEN UPDATE public.payment_provider_attempt_evidence SET processed_at=now(),processing_status='processed' WHERE id=e.id; END IF;
   UPDATE public.commerce_orders SET status='refunded',metadata=metadata||jsonb_build_object(
    'paymentStatus','refunded','source','payment.control.v0'),updated_at=now() WHERE id=purchase.id;
   IF purchase.subscription_cycle_id IS NULL OR EXISTS(SELECT 1 FROM public.subscription_activations activation
    JOIN public.subscriptions sub ON sub.id=activation.subscription_id
    WHERE activation.order_id=purchase.id AND sub.status IN ('active','pending_activation')) THEN
    FOR held IN SELECT id FROM public.fulfillment_inventory_reservations WHERE purchase_order_id=purchase.id AND status='held' ORDER BY id FOR UPDATE LOOP
     PERFORM public.fulfillment_release_purchase_reservation('payment-refund:'||held.id,held.id,
      CASE WHEN purchase.subscription_cycle_id IS NULL THEN 'one_time_order_refunded' ELSE 'subscription_activation_refunded' END,'{}'::jsonb,p_occurred_at);
    END LOOP;
   END IF;
   financial:=public.commerce_order_provider_refund_evidence(purchase.id);
   IF financial IS NOT NULL AND financial->>'currency'=purchase.currency_code AND purchase.metadata->>'source' IS DISTINCT FROM 'admin_manual_refund' THEN
    INSERT INTO public.outbox_events(aggregate_type,aggregate_id,event_type,idempotency_key,payload,metadata)
    VALUES('commerce_order',purchase.id,'commerce.order.refund_processed','order_refund_processed:'||purchase.id,
     financial||jsonb_build_object('orderId','order_'||purchase.id,'orderUuid',purchase.id,'occurredAt',p_occurred_at),
     jsonb_build_object('source','payment_refund_apply_result')) ON CONFLICT(event_type,idempotency_key) DO NOTHING;
   END IF;
  END IF;
 END IF;
 IF e.id IS NOT NULL THEN UPDATE public.payment_provider_attempt_evidence SET processed_at=now(),
  processing_status=CASE WHEN kind LIKE 'ignored%' THEN 'ignored' ELSE 'processed' END WHERE id=e.id; END IF;
 IF p_failure_class IS NOT NULL THEN UPDATE public.payment_provider_attempts SET failure_class=p_failure_class,
  response_payload=response_payload||CASE WHEN p_failure_class_decided_by IS NULL THEN '{}'::jsonb
   ELSE jsonb_build_object('failureClassDecidedBy',p_failure_class_decided_by) END WHERE id=a.id; END IF;
 INSERT INTO public.payment_provider_transitions(settlement_intent_id,payment_attempt_id,provider_event_id,transition_kind,
  from_status,to_status,reason,idempotency_key,occurred_at,payload)
 VALUES(i.id,a.id,e.id,CASE WHEN p_result_status='disputed' THEN 'dispute' ELSE 'refund' END,s.status,target_status,kind,
  p_idempotency_key||':payment_result',p_occurred_at,jsonb_build_object('orderId',purchase.id,'resultStatus',p_result_status,'source','payment.control.v0'));
 answer:=jsonb_build_object('contractVersion','commerce.v0','paymentResult',jsonb_build_object('paymentIntentId',i.id,
  'paymentAttemptId',a.id,'paymentId',s.payment_id,'orderId',purchase.id,'status',target_status,'kind',kind,'idempotencyKey',p_idempotency_key,'replayed',false));
 INSERT INTO public.payment_provider_receipts(scope,idempotency_key,request_fingerprint,status,response_payload,metadata)
 VALUES('commerce.payment_result.apply',p_idempotency_key,fingerprint,'completed',answer,jsonb_build_object('paymentIntentId',i.id,'paymentAttemptId',a.id));
 RETURN answer;
END;
$$;

CREATE OR REPLACE FUNCTION public.commerce_payment_control_reopen_prepared_attempt_after_absence(
  p_idempotency_key text,
  p_payment_attempt_id uuid,
  p_expected_payment_intent_id uuid,
  p_expected_subscription_cycle_id uuid,
  p_operator_ref text,
  p_absence_checked_at timestamptz,
  p_next_retry_at timestamptz,
  p_absence_evidence jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_scope constant text := 'commerce.payment_attempt.prepared_absence_reopen';
  v_min_stranded_age constant interval := interval '30 minutes';
  v_request_fingerprint text;
  v_existing public.payment_provider_receipts%ROWTYPE;
  v_attempt public.payment_provider_attempts%ROWTYPE;
  v_intent record;
  v_cycle record;
  v_order public.commerce_orders%ROWTYPE;
  v_latest_local_write timestamptz;
  v_from_attempt_status text;
  v_next_sequence integer;
  v_response jsonb;
  v_evidence jsonb;
BEGIN
  v_evidence := COALESCE(p_absence_evidence, '{}'::jsonb);

  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' OR length(p_idempotency_key) < 8
    OR p_payment_attempt_id IS NULL
    OR p_expected_payment_intent_id IS NULL
    OR p_expected_subscription_cycle_id IS NULL
    OR p_operator_ref IS NULL OR btrim(p_operator_ref) = '' OR length(btrim(p_operator_ref)) > 160
    OR p_absence_checked_at IS NULL
    OR p_next_retry_at IS NULL
    OR jsonb_typeof(v_evidence) <> 'object'
  THEN
    RAISE EXCEPTION 'prepared_attempt_absence_reopen_invalid_input' USING ERRCODE = '22023';
  END IF;

  IF p_absence_checked_at > now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'prepared_attempt_absence_reopen_absence_checked_at_in_future' USING ERRCODE = '22023';
  END IF;

  IF NOT (v_evidence @> '{"providerAbsenceConfirmed": true}'::jsonb) THEN
    RAISE EXCEPTION 'prepared_attempt_absence_reopen_requires_provider_absence_proof' USING ERRCODE = '22023';
  END IF;

  IF lower(v_evidence::text) ~ '(paymentmethodref|payment_method_ref|providermethodref|provider_method_ref|providercustomerref|provider_customer_ref|clientsecret|client_secret|recoverytoken|recovery_token|token_hash|blikcode|blik_code|payid|pay_id)' THEN
    RAISE EXCEPTION 'prepared_attempt_absence_reopen_sensitive_evidence' USING ERRCODE = '22023';
  END IF;

  v_request_fingerprint := md5(
    p_payment_attempt_id::text || '|' ||
    p_expected_payment_intent_id::text || '|' ||
    p_expected_subscription_cycle_id::text || '|' ||
    btrim(p_operator_ref) || '|' ||
    p_absence_checked_at::text || '|' ||
    p_next_retry_at::text || '|' ||
    v_evidence::text
  );

  SELECT *
    INTO v_existing
    FROM public.payment_provider_receipts
   WHERE scope = v_scope
     AND idempotency_key = p_idempotency_key
   FOR UPDATE;

  IF FOUND THEN
    IF v_existing.status = 'completed'
      AND v_existing.request_fingerprint = v_request_fingerprint
      AND v_existing.response_payload IS NOT NULL
    THEN
      RETURN jsonb_set(v_existing.response_payload, '{preparedAttemptReopen,replayed}', 'true'::jsonb, false);
    END IF;

    RAISE EXCEPTION 'prepared_attempt_absence_reopen_idempotency_conflict' USING ERRCODE = '23505';
  END IF;

  PERFORM public.payment_provider_lock_aggregate(p_expected_payment_intent_id);
  SELECT *
    INTO v_attempt
    FROM public.payment_provider_attempts
   WHERE id = p_payment_attempt_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'prepared_attempt_absence_reopen_attempt_not_found' USING ERRCODE = '22023';
  END IF;
  IF v_attempt.settlement_intent_id IS DISTINCT FROM p_expected_payment_intent_id THEN
    RAISE EXCEPTION 'prepared_attempt_absence_reopen_intent_mismatch' USING ERRCODE = '22023';
  END IF;
  IF v_attempt.status <> 'created' THEN
    RAISE EXCEPTION 'prepared_attempt_absence_reopen_attempt_not_prepared' USING ERRCODE = '22023';
  END IF;
  IF NOT (SELECT renewal_absence FROM public.payment_provider_profile(v_attempt.provider)) THEN
    RAISE EXCEPTION 'prepared_attempt_absence_reopen_provider_not_supported' USING ERRCODE = '22023';
  END IF;
  IF v_attempt.provider_attempt_id IS NOT NULL OR v_attempt.provider_session_id IS NOT NULL THEN
    RAISE EXCEPTION 'prepared_attempt_absence_reopen_provider_ref_exists' USING ERRCODE = '22023';
  END IF;
  IF v_attempt.response_payload @> '{"providerCall": true}'::jsonb THEN
    RAISE EXCEPTION 'prepared_attempt_absence_reopen_provider_call_recorded' USING ERRCODE = '22023';
  END IF;
  IF NOT (v_attempt.request_payload ? 'providerIdempotencyKey')
    OR NOT (v_attempt.request_payload ? 'providerRequestFingerprint')
    OR NOT (v_attempt.request_payload ? 'providerFlow')
  THEN
    RAISE EXCEPTION 'prepared_attempt_absence_reopen_missing_provider_identity' USING ERRCODE = '22023';
  END IF;

  SELECT *
    INTO v_intent
    FROM (SELECT state.*, intent.order_id FROM public.payment_provider_states state JOIN public.commerce_settlement_intents intent ON intent.id=state.id) state
   WHERE id = p_expected_payment_intent_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'prepared_attempt_absence_reopen_intent_not_found' USING ERRCODE = '22023';
  END IF;
  IF v_intent.active_attempt_id IS DISTINCT FROM v_attempt.id THEN
    RAISE EXCEPTION 'prepared_attempt_absence_reopen_active_attempt_mismatch' USING ERRCODE = '22023';
  END IF;
  IF v_intent.target_kind <> 'subscription_cycle'
    OR v_intent.subscription_cycle_id IS DISTINCT FROM p_expected_subscription_cycle_id
  THEN
    RAISE EXCEPTION 'prepared_attempt_absence_reopen_cycle_mismatch' USING ERRCODE = '22023';
  END IF;
  IF v_intent.status NOT IN ('requires_action', 'processing') THEN
    RAISE EXCEPTION 'prepared_attempt_absence_reopen_intent_not_active' USING ERRCODE = '22023';
  END IF;
  IF v_intent.provider_payment_id IS NOT NULL THEN
    RAISE EXCEPTION 'prepared_attempt_absence_reopen_intent_provider_ref_exists' USING ERRCODE = '22023';
  END IF;

  PERFORM 1 FROM public.subscription_cycles WHERE id=p_expected_subscription_cycle_id FOR UPDATE;
  SELECT *
    INTO v_cycle
    FROM (SELECT c.*,COALESCE(retry.retry_attempt,0) AS retry_attempt,state.provider_attempt_sequence FROM public.subscription_cycles c
    LEFT JOIN public.subscription_retry_obligations retry ON retry.cycle_id=c.id
    JOIN public.payment_provider_states state ON state.subscription_cycle_id=c.id AND state.id=p_expected_payment_intent_id) cycle
   WHERE id = p_expected_subscription_cycle_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'prepared_attempt_absence_reopen_cycle_not_found' USING ERRCODE = '22023';
  END IF;
  IF v_cycle.status <> 'payment_pending' THEN
    RAISE EXCEPTION 'prepared_attempt_absence_reopen_cycle_not_pending' USING ERRCODE = '22023';
  END IF;

  SELECT *
    INTO v_order
    FROM public.commerce_orders
   WHERE id = v_intent.order_id
   FOR UPDATE;
  IF NOT FOUND
    OR v_order.subscription_cycle_id IS NULL
    OR v_order.subscription_cycle_id IS DISTINCT FROM v_cycle.id
    OR v_intent.subscription_id IS DISTINCT FROM v_cycle.subscription_id
  THEN
    RAISE EXCEPTION 'prepared_attempt_absence_reopen_order_mismatch' USING ERRCODE = '22023';
  END IF;
  IF v_order.status <> 'pending_payment' THEN
    RAISE EXCEPTION 'prepared_attempt_absence_reopen_order_not_pending_payment' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.payment_provider_attempt_evidence AS e
     WHERE e.payment_attempt_id = v_attempt.id
        OR e.settlement_intent_id = v_intent.id
  ) THEN
    RAISE EXCEPTION 'prepared_attempt_absence_reopen_provider_event_exists' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.payment_provider_reconciliation_runs AS r
     WHERE r.payment_attempt_id = v_attempt.id
       AND r.correction_status = 'corrected'
       AND r.provider_status IN ('succeeded', 'failed')
  ) THEN
    RAISE EXCEPTION 'prepared_attempt_absence_reopen_terminal_reconciliation_exists' USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.payment_provider_reconciliation_runs AS r
     WHERE r.payment_attempt_id = v_attempt.id
       AND r.provider_status IN ('prepared_attempt_claiming', 'prepared_without_provider_ack')
       AND r.correction_status IN ('observed', 'failed')
  ) THEN
    RAISE EXCEPTION 'prepared_attempt_absence_reopen_watchdog_evidence_missing' USING ERRCODE = '22023';
  END IF;

  v_latest_local_write := GREATEST(
    v_attempt.created_at,
    v_attempt.updated_at,
    v_intent.created_at,
    v_intent.updated_at
  );
  IF p_absence_checked_at < v_latest_local_write + v_min_stranded_age THEN
    RAISE EXCEPTION 'prepared_attempt_absence_reopen_too_fresh' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.payment_provider_receipts (
    scope,
    idempotency_key,
    request_fingerprint,
    status,
    metadata
  )
  VALUES (
    v_scope,
    p_idempotency_key,
    v_request_fingerprint,
    'in_progress',
    jsonb_build_object('boundary', 'commerce_payment_control_reopen_prepared_attempt_after_absence')
  );

  v_from_attempt_status := v_attempt.status;
  v_next_sequence := v_cycle.provider_attempt_sequence + 1;

  UPDATE public.payment_provider_attempts
     SET status = 'cancelled',
         failure_reason = 'prepared_without_provider_ack_operator_cleared',
         response_payload = response_payload || jsonb_build_object(
           'providerCall', false,
           'providerAcknowledged', false,
           'operatorAbsenceClearedAt', p_absence_checked_at
         ),
         metadata = metadata || jsonb_build_object(
           'preparedAbsenceReopenedAt', p_absence_checked_at,
           'operatorRef', btrim(p_operator_ref),
           'providerAttemptSequence', v_next_sequence
         ),
         updated_at = now()
   WHERE id = v_attempt.id;

  UPDATE public.payment_provider_states SET provider_attempt_sequence=v_next_sequence,updated_at=now() WHERE id=v_intent.id;
  INSERT INTO public.payment_prepared_absence_reopens(payment_intent_id,payment_attempt_id,subscription_cycle_id,
   provider_attempt_sequence,next_retry_at,idempotency_key,evidence)
  VALUES(v_intent.id,v_attempt.id,v_cycle.id,v_next_sequence,p_next_retry_at,p_idempotency_key,v_evidence);

  PERFORM public.commerce_payment_control_record_reconciliation(
    p_idempotency_key || ':provider_absence',
    v_attempt.provider,
    NULL,
    v_intent.id,
    v_attempt.id,
    v_from_attempt_status,
    'prepared_attempt_provider_absent',
    'corrected',
    p_absence_checked_at,
    jsonb_build_object(
      'source', 'payment-provider-reconciliation.prepared-absence-reopen.v0',
      'subscriptionId', v_cycle.subscription_id,
      'subscriptionCycleId', v_cycle.id,
      'orderId', v_order.id,
      'providerAbsenceConfirmed', true,
      'operatorRef', btrim(p_operator_ref),
      'nextRetryAt', p_next_retry_at,
      'retryAttemptPreserved', v_cycle.retry_attempt,
      'providerAttemptSequence', v_next_sequence,
      'evidence', v_evidence
    )
  );

  INSERT INTO public.payment_provider_transitions (
    settlement_intent_id,
    payment_attempt_id,
    transition_kind,
    from_status,
    to_status,
    reason,
    idempotency_key,
    occurred_at,
    payload
  )
  VALUES (
    v_intent.id,
    v_attempt.id,
    'attempt',
    v_from_attempt_status,
    'cancelled',
    'prepared_without_provider_ack_operator_cleared',
    p_idempotency_key || ':attempt_cancelled',
    p_absence_checked_at,
    jsonb_build_object(
      'source', 'payment-provider-reconciliation.prepared-absence-reopen.v0',
      'providerAttemptSequence', v_next_sequence,
      'retryAttemptPreserved', v_cycle.retry_attempt
    )
  )
  ON CONFLICT (idempotency_key) DO NOTHING;

  INSERT INTO public.subscription_events (
    subscription_id,
    event_type,
    idempotency_key,
    payload,
    occurred_at
  )
  VALUES (
    v_cycle.subscription_id,
    'subscription.retry_scheduled',
    p_idempotency_key || ':subscription_retry_scheduled',
    jsonb_build_object(
      'paymentIntentId', v_intent.id,
      'paymentAttemptId', v_attempt.id,
      'orderId', v_order.id,
      'reason', 'prepared_without_provider_ack_operator_cleared',
      'nextRetryAt', p_next_retry_at,
      'retryAttemptPreserved', v_cycle.retry_attempt,
      'providerAttemptSequence', v_next_sequence,
      'source', 'payment-provider-reconciliation.prepared-absence-reopen.v0'
    ),
    p_absence_checked_at
  )
  ON CONFLICT (subscription_id,idempotency_key) DO NOTHING;

  v_response := jsonb_build_object(
    'contractVersion', 'commerce.v0',
    'preparedAttemptReopen', jsonb_build_object(
      'paymentAttemptId', v_attempt.id,
      'paymentIntentId', v_intent.id,
      'subscriptionCycleId', v_cycle.id,
      'subscriptionId', v_cycle.subscription_id,
      'orderId', v_order.id,
      'attemptStatus', 'cancelled',
      'cycleStatus', v_cycle.status,
      'retryAttempt', v_cycle.retry_attempt,
      'providerAttemptSequence', v_next_sequence,
      'nextRetryAt', p_next_retry_at,
      'idempotencyKey', p_idempotency_key,
      'replayed', false
    )
  );

  UPDATE public.payment_provider_receipts
     SET status = 'completed',
         response_payload = v_response,
         metadata = metadata || jsonb_build_object(
           'paymentIntentId', v_intent.id,
           'paymentAttemptId', v_attempt.id,
           'subscriptionCycleId', v_cycle.id,
           'providerAttemptSequence', v_next_sequence
         )
   WHERE scope = v_scope
     AND idempotency_key = p_idempotency_key;

  RETURN v_response;
END;
$$;

CREATE OR REPLACE FUNCTION public.commerce_payment_reopen_interactive_sealed_v1(
  p_idempotency_key text,
  p_payment_attempt_id uuid,
  p_expected_payment_intent_id uuid,
  p_expected_order_id uuid,
  p_expected_subscription_id uuid,
  p_expected_subscription_cycle_id uuid,
  p_reopen_mode text,
  p_dispatch_state text,
  p_phase text,
  p_reason_code text,
  p_operator_ref text,
  p_absence_checked_at timestamptz,
  p_absence_evidence jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_scope constant text := 'commerce.payment_attempt.interactive_prepared_reopen';
  v_min_stranded_age constant interval := interval '30 minutes';
  v_request_fingerprint text;
  v_existing public.payment_provider_receipts%ROWTYPE;
  v_attempt public.payment_provider_attempts%ROWTYPE;
  v_intent record;
  v_order public.commerce_orders%ROWTYPE;
  v_cycle public.subscription_cycles%ROWTYPE;
  v_subscription public.subscriptions%ROWTYPE;
  v_payment record;
  v_evidence jsonb := COALESCE(p_absence_evidence, '{}'::jsonb);
  v_occurred_at timestamptz;
  v_latest_local_write timestamptz;
  v_checkout_kind text;
  v_reconciliation_status text;
  v_audit_payload jsonb;
  v_response jsonb;
BEGIN
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' OR length(p_idempotency_key) < 8
    OR p_payment_attempt_id IS NULL
    OR p_expected_payment_intent_id IS NULL
    OR p_expected_order_id IS NULL
    OR p_reopen_mode IS NULL
    OR p_reopen_mode NOT IN ('trusted_pre_dispatch', 'trusted_provider_refusal', 'manual_provider_absence')
    OR p_dispatch_state IS NULL OR btrim(p_dispatch_state) = ''
    OR p_phase IS NULL OR btrim(p_phase) = ''
    OR p_reason_code IS NULL OR btrim(p_reason_code) = ''
    OR jsonb_typeof(v_evidence) <> 'object'
    OR (p_expected_subscription_id IS NULL) IS DISTINCT FROM (p_expected_subscription_cycle_id IS NULL)
  THEN
    RAISE EXCEPTION 'interactive_prepared_attempt_reopen_invalid_input' USING ERRCODE = '22023';
  END IF;

  IF lower(v_evidence::text) ~ '(paymentmethodref|payment_method_ref|providermethodref|provider_method_ref|providercustomerref|provider_customer_ref|clientsecret|client_secret|recoverytoken|recovery_token|token_hash|blikcode|blik_code|blik|payid|pay_id|providerpaymentid|provider_payment_id|providerattemptid|provider_attempt_id|providersessionid|provider_session_id)' THEN
    RAISE EXCEPTION 'interactive_prepared_attempt_reopen_sensitive_evidence' USING ERRCODE = '22023';
  END IF;

  IF p_reopen_mode = 'trusted_pre_dispatch' THEN
    IF p_dispatch_state <> 'not_dispatched'
      OR NOT (
        (
          p_phase = 'oauth'
          AND p_reason_code IN (SELECT unnest(policy.trusted_oauth_codes) FROM public.payment_provider_profile(NULL) policy)
        )
        OR (
          p_phase = 'transaction_dispatch'
          AND p_reason_code IN (SELECT unnest(policy.trusted_dispatch_codes) FROM public.payment_provider_profile(NULL) policy)
        )
      )
      OR p_operator_ref IS NOT NULL
      OR p_absence_checked_at IS NOT NULL
      OR v_evidence <> '{}'::jsonb
    THEN
      RAISE EXCEPTION 'interactive_prepared_attempt_reopen_invalid_trusted_pre_dispatch_evidence'
        USING ERRCODE = '22023';
    END IF;
    v_occurred_at := now();
    v_reconciliation_status := 'provider_dispatch_not_started';
  ELSIF p_reopen_mode = 'trusted_provider_refusal' THEN
    IF p_dispatch_state <> 'refused'
      OR p_phase <> 'response_decode'
      OR p_reason_code NOT IN (SELECT policy.trusted_refusal_code FROM public.payment_provider_profile(NULL) policy WHERE policy.trusted_refusal_code IS NOT NULL)
      OR p_operator_ref IS NOT NULL
      OR p_absence_checked_at IS NOT NULL
      OR v_evidence <> '{}'::jsonb
    THEN
      RAISE EXCEPTION 'interactive_prepared_attempt_reopen_invalid_provider_refusal_evidence'
        USING ERRCODE = '22023';
    END IF;
    v_occurred_at := now();
    v_reconciliation_status := 'provider_transaction_refused';
  ELSE
    IF p_dispatch_state <> 'provider_absence_confirmed'
      OR p_phase <> 'operator_reconciliation'
      OR p_reason_code NOT IN ('operator_verified_absence', 'operator_documented_absence')
      OR p_operator_ref IS NULL
      OR btrim(p_operator_ref) !~ '^[a-z0-9][a-z0-9._:-]{2,159}$'
      OR p_absence_checked_at IS NULL
      OR p_absence_checked_at > now() + interval '5 minutes'
      OR NOT (v_evidence @> '{"providerAbsenceConfirmed": true, "watchdogEvidence": true}'::jsonb)
      OR (v_evidence->>'evidenceCode') IS DISTINCT FROM p_reason_code
      OR EXISTS (
        SELECT 1
          FROM jsonb_object_keys(v_evidence) AS evidence_key(key)
         WHERE evidence_key.key NOT IN ('providerAbsenceConfirmed', 'watchdogEvidence', 'evidenceCode')
      )
    THEN
      RAISE EXCEPTION 'interactive_prepared_attempt_reopen_invalid_manual_absence_evidence'
        USING ERRCODE = '22023';
    END IF;
    v_occurred_at := p_absence_checked_at;
    v_reconciliation_status := 'prepared_attempt_provider_absent';
  END IF;

  v_request_fingerprint := md5(
    p_payment_attempt_id::text || '|' ||
    p_expected_payment_intent_id::text || '|' ||
    p_expected_order_id::text || '|' ||
    COALESCE(p_expected_subscription_id::text, '') || '|' ||
    COALESCE(p_expected_subscription_cycle_id::text, '') || '|' ||
    p_reopen_mode || '|' ||
    p_dispatch_state || '|' ||
    p_phase || '|' ||
    p_reason_code || '|' ||
    COALESCE(btrim(p_operator_ref), '') || '|' ||
    COALESCE(p_absence_checked_at::text, '') || '|' ||
    v_evidence::text
  );
  PERFORM pg_advisory_xact_lock(hashtextextended(v_scope || ':' || p_idempotency_key, 0));

  SELECT *
    INTO v_existing
    FROM public.payment_provider_receipts
   WHERE scope = v_scope
     AND idempotency_key = p_idempotency_key
   FOR UPDATE;

  IF FOUND THEN
    IF v_existing.status = 'completed'
      AND v_existing.request_fingerprint = v_request_fingerprint
      AND v_existing.response_payload IS NOT NULL
    THEN
      RETURN jsonb_set(
        v_existing.response_payload,
        '{interactivePreparedAttemptReopen,replayed}',
        'true'::jsonb,
        false
      );
    END IF;
    RAISE EXCEPTION 'interactive_prepared_attempt_reopen_idempotency_conflict' USING ERRCODE = '23505';
  END IF;
  IF p_expected_subscription_id IS NOT NULL THEN
    SELECT *
      INTO v_subscription
      FROM public.subscriptions
     WHERE id = p_expected_subscription_id
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'interactive_prepared_attempt_reopen_subscription_not_found'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  SELECT *
    INTO v_intent
    FROM (SELECT state.*, intent.order_id FROM public.payment_provider_states state JOIN public.commerce_settlement_intents intent ON intent.id=state.id) state
   WHERE id = p_expected_payment_intent_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'interactive_prepared_attempt_reopen_intent_not_found' USING ERRCODE = '22023';
  END IF;
  IF v_intent.active_attempt_id IS DISTINCT FROM p_payment_attempt_id THEN
    RAISE EXCEPTION 'interactive_prepared_attempt_reopen_active_attempt_mismatch' USING ERRCODE = '22023';
  END IF;
  IF v_intent.order_id IS DISTINCT FROM p_expected_order_id
    OR v_intent.subscription_id IS DISTINCT FROM p_expected_subscription_id
    OR v_intent.subscription_cycle_id IS DISTINCT FROM p_expected_subscription_cycle_id
  THEN
    RAISE EXCEPTION 'interactive_prepared_attempt_reopen_expected_ids_mismatch' USING ERRCODE = '22023';
  END IF;
  IF v_intent.status NOT IN ('requires_action', 'processing') THEN
    RAISE EXCEPTION 'interactive_prepared_attempt_reopen_intent_not_active' USING ERRCODE = '22023';
  END IF;
  IF v_intent.provider_payment_id IS NOT NULL THEN
    RAISE EXCEPTION 'interactive_prepared_attempt_reopen_intent_provider_ref_exists' USING ERRCODE = '22023';
  END IF;

  SELECT *
    INTO v_attempt
    FROM public.payment_provider_attempts
   WHERE id = p_payment_attempt_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'interactive_prepared_attempt_reopen_attempt_not_found' USING ERRCODE = '22023';
  END IF;
  IF v_attempt.settlement_intent_id IS DISTINCT FROM v_intent.id THEN
    RAISE EXCEPTION 'interactive_prepared_attempt_reopen_intent_mismatch' USING ERRCODE = '22023';
  END IF;
  IF v_intent.active_attempt_id IS DISTINCT FROM v_attempt.id THEN
    RAISE EXCEPTION 'interactive_prepared_attempt_reopen_active_attempt_mismatch' USING ERRCODE = '22023';
  END IF;
  IF v_attempt.status <> 'created' THEN
    RAISE EXCEPTION 'interactive_prepared_attempt_reopen_attempt_not_prepared' USING ERRCODE = '22023';
  END IF;
  IF NOT (SELECT interactive FROM public.payment_provider_profile(v_attempt.provider)) THEN
    RAISE EXCEPTION 'interactive_prepared_attempt_reopen_provider_not_supported' USING ERRCODE = '22023';
  END IF;
  IF v_attempt.provider_attempt_id IS NOT NULL OR v_attempt.provider_session_id IS NOT NULL THEN
    RAISE EXCEPTION 'interactive_prepared_attempt_reopen_provider_ref_exists' USING ERRCODE = '22023';
  END IF;
  IF v_attempt.response_payload @> '{"providerCall": true}'::jsonb THEN
    RAISE EXCEPTION 'interactive_prepared_attempt_reopen_provider_call_recorded' USING ERRCODE = '22023';
  END IF;
  IF v_attempt.request_payload->>'source' IS DISTINCT FROM 'commerce.runtime.provider-attempt.prepare.v0'
    OR NOT (v_attempt.request_payload ? 'providerIdempotencyKey')
    OR NOT (v_attempt.request_payload ? 'providerRequestFingerprint')
    OR NOT (v_attempt.request_payload ? 'providerFlow')
  THEN
    RAISE EXCEPTION 'interactive_prepared_attempt_reopen_not_interactive_prepare' USING ERRCODE = '22023';
  END IF;

  IF p_expected_subscription_cycle_id IS NOT NULL THEN
    SELECT *
      INTO v_cycle
      FROM public.subscription_cycles
     WHERE id = p_expected_subscription_cycle_id
     FOR UPDATE;
    IF NOT FOUND
      OR v_cycle.subscription_id IS DISTINCT FROM p_expected_subscription_id
      OR v_cycle.status <> 'payment_pending'
    THEN
      RAISE EXCEPTION 'interactive_prepared_attempt_reopen_cycle_not_payment_pending' USING ERRCODE = '22023';
    END IF;
    IF v_subscription.status <> 'pending_activation' THEN
      RAISE EXCEPTION 'interactive_prepared_attempt_reopen_subscription_not_pending_activation'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  SELECT *
    INTO v_order
    FROM public.commerce_orders
   WHERE id = p_expected_order_id
   FOR UPDATE;
  IF NOT FOUND OR v_order.status <> 'pending_payment' THEN
    RAISE EXCEPTION 'interactive_prepared_attempt_reopen_order_not_pending_payment' USING ERRCODE = '22023';
  END IF;

  IF p_expected_subscription_id IS NULL THEN
    v_checkout_kind := 'one_time';
    IF v_intent.target_kind <> 'one_time_order'
      OR v_order.subscription_cycle_id IS NOT NULL
      OR v_intent.subscription_id IS NOT NULL
      OR v_order.subscription_cycle_id IS NOT NULL
    THEN
      RAISE EXCEPTION 'interactive_prepared_attempt_reopen_one_time_context_mismatch' USING ERRCODE = '22023';
    END IF;
  ELSE
    v_checkout_kind := 'subscription_initial';
    IF v_intent.target_kind <> 'subscription_cycle'
      OR v_order.subscription_cycle_id IS NULL
      OR v_intent.subscription_id IS DISTINCT FROM p_expected_subscription_id
      OR v_order.subscription_cycle_id IS DISTINCT FROM p_expected_subscription_cycle_id
      OR v_order.subscription_cycle_id IS DISTINCT FROM v_cycle.id
    THEN
      RAISE EXCEPTION 'interactive_prepared_attempt_reopen_subscription_context_mismatch' USING ERRCODE = '22023';
    END IF;
  END IF;

  IF v_intent.metadata->>'checkoutKind' IS DISTINCT FROM v_checkout_kind
    OR v_order.metadata#>>'{runtimeFinalize,checkoutKind}' IS DISTINCT FROM v_checkout_kind
    OR v_order.metadata#>>'{runtimeFinalize,source}' IS DISTINCT FROM 'commerce.runtime.hidden.v0'
  THEN
    RAISE EXCEPTION 'interactive_prepared_attempt_reopen_checkout_source_mismatch' USING ERRCODE = '22023';
  END IF;

  SELECT *
    INTO v_payment
    FROM (SELECT state.payment_id AS id,state.payment_status AS status,state.provider_payment_id,intent.order_id FROM public.payment_provider_states state JOIN public.commerce_settlement_intents intent ON intent.id=state.id) payment
   WHERE id = v_intent.payment_id
   FOR UPDATE;
  IF NOT FOUND
    OR v_payment.order_id IS DISTINCT FROM v_order.id
    OR v_payment.status <> 'pending'
    OR v_payment.provider_payment_id IS NOT NULL
  THEN
    RAISE EXCEPTION 'interactive_prepared_attempt_reopen_payment_not_pending' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.payment_provider_attempt_evidence AS event
     WHERE event.payment_attempt_id = v_attempt.id
        OR event.settlement_intent_id = v_intent.id
  ) THEN
    RAISE EXCEPTION 'interactive_prepared_attempt_reopen_provider_event_exists' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.payment_provider_reconciliation_runs AS reconciliation
     WHERE reconciliation.payment_attempt_id = v_attempt.id
       AND reconciliation.correction_status = 'corrected'
       AND reconciliation.provider_status IN (
         'succeeded', 'failed', 'cancelled', 'canceled', 'refunded',
         'partially_refunded', 'disputed'
       )
  ) THEN
    RAISE EXCEPTION 'interactive_prepared_attempt_reopen_terminal_reconciliation_exists'
      USING ERRCODE = '22023';
  END IF;

  IF p_reopen_mode = 'manual_provider_absence' THEN
    IF NOT EXISTS (
      SELECT 1
        FROM public.payment_provider_reconciliation_runs AS reconciliation
       WHERE reconciliation.payment_attempt_id = v_attempt.id
         AND reconciliation.provider_status IN ('prepared_attempt_claiming', 'prepared_without_provider_ack')
         AND reconciliation.correction_status IN ('observed', 'failed')
    ) THEN
      RAISE EXCEPTION 'interactive_prepared_attempt_reopen_watchdog_evidence_missing'
        USING ERRCODE = '22023';
    END IF;

    v_latest_local_write := GREATEST(
      v_attempt.created_at,
      v_attempt.updated_at,
      v_intent.created_at,
      v_intent.updated_at
    );
    IF p_absence_checked_at < v_latest_local_write + v_min_stranded_age THEN
      RAISE EXCEPTION 'interactive_prepared_attempt_reopen_too_fresh' USING ERRCODE = '22023';
    END IF;
  END IF;

  INSERT INTO public.payment_provider_receipts (
    scope,
    idempotency_key,
    request_fingerprint,
    status,
    metadata
  )
  VALUES (
    v_scope,
    p_idempotency_key,
    v_request_fingerprint,
    'in_progress',
    jsonb_build_object(
      'boundary', 'commerce_payment_control_reopen_interactive_prepared_attempt',
      'reopenMode', p_reopen_mode,
      'phase', p_phase,
      'reasonCode', p_reason_code
    )
  );

  v_audit_payload := jsonb_build_object(
    'source', 'payment-control.interactive-prepared-attempt-reopen.v1',
    'reopenMode', p_reopen_mode,
    'dispatchState', p_dispatch_state,
    'phase', p_phase,
    'reasonCode', p_reason_code,
    'operatorRef', CASE WHEN p_reopen_mode = 'manual_provider_absence' THEN btrim(p_operator_ref) ELSE NULL END,
    'providerAbsenceConfirmed', p_reopen_mode = 'manual_provider_absence',
    'watchdogEvidence', p_reopen_mode = 'manual_provider_absence'
  );

  UPDATE public.payment_provider_attempts
     SET status = 'failed',
         failure_reason = 'interactive_prepared_attempt_reopened',
         response_payload = response_payload || jsonb_build_object(
           'providerCall', p_reopen_mode = 'trusted_provider_refusal',
           'providerAcknowledged', false,
           'interactiveReopenMode', p_reopen_mode
         ),
         metadata = metadata || jsonb_build_object(
           'interactivePreparedAttemptReopened', v_audit_payload
         ),
         updated_at = now()
   WHERE id = v_attempt.id;

  UPDATE public.payment_provider_states
     SET status = 'failed',
         failure_reason = 'interactive_prepared_attempt_reopened',
         metadata = metadata || jsonb_build_object(
           'interactivePreparedAttemptReopened', v_audit_payload
         ),
         updated_at = now()
   WHERE id = v_intent.id;

  UPDATE public.payment_provider_states
     SET payment_status = 'failed',
         metadata = metadata || jsonb_build_object(
           'interactivePreparedAttemptReopened', v_audit_payload
         ),
         updated_at = now()
   WHERE payment_id = v_payment.id;

  PERFORM public.commerce_payment_control_record_reconciliation(
    p_idempotency_key || ':reconciliation',
    v_attempt.provider,
    NULL,
    v_intent.id,
    v_attempt.id,
    'created',
    v_reconciliation_status,
    'corrected',
    v_occurred_at,
    v_audit_payload
  );

  INSERT INTO public.payment_provider_transitions (
    settlement_intent_id,
    payment_attempt_id,
    transition_kind,
    from_status,
    to_status,
    reason,
    idempotency_key,
    occurred_at,
    payload
  )
  VALUES
    (
      v_intent.id,
      v_attempt.id,
      'attempt',
      'created',
      'failed',
      'interactive_prepared_attempt_reopened',
      p_idempotency_key || ':attempt_failed',
      v_occurred_at,
      v_audit_payload
    ),
    (
      v_intent.id,
      v_attempt.id,
      'intent',
      v_intent.status,
      'failed',
      'interactive_prepared_attempt_reopened',
      p_idempotency_key || ':intent_failed',
      v_occurred_at,
      v_audit_payload
    )
  ON CONFLICT (idempotency_key) DO NOTHING;

  v_response := jsonb_build_object(
    'contractVersion', 'commerce.v0',
    'interactivePreparedAttemptReopen', jsonb_build_object(
      'paymentAttemptId', v_attempt.id,
      'paymentIntentId', v_intent.id,
      'paymentAttemptStatus', 'failed',
      'paymentIntentStatus', 'failed',
      'replayed', false
    )
  );

  UPDATE public.payment_provider_receipts
     SET status = 'completed',
         response_payload = v_response,
         metadata = metadata || jsonb_build_object(
           'paymentIntentId', v_intent.id,
           'paymentAttemptId', v_attempt.id,
           'reopenMode', p_reopen_mode
         )
   WHERE scope = v_scope
     AND idempotency_key = p_idempotency_key;

  RETURN v_response;
END;
$$;

-- Replacing existing functions retains their ACLs, including the sealed body.
REVOKE ALL ON FUNCTION public.payment_provider_profile(text) FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
 EXECUTE 'REVOKE ALL ON FUNCTION public.payment_provider_profile(text) FROM anon';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
 EXECUTE 'REVOKE ALL ON FUNCTION public.payment_provider_profile(text) FROM authenticated';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
 EXECUTE 'GRANT EXECUTE ON FUNCTION public.payment_provider_profile(text) TO service_role';
END IF; END; $$;
