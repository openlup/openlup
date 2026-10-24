-- Keep exhausted subscriptions active and authorize repair of the same unpaid cycle.
-- Existing function attributes, ACLs, quarantine and lock lanes are preserved.

CREATE OR REPLACE FUNCTION public.subscription_handle_payment_failure_dunning_before_cancel_fence(p_idempotency_key text, p_cycle_id uuid, p_subscription_id uuid, p_order_id uuid, p_payment_intent_id uuid, p_retry_attempt integer, p_next_retry_at timestamp with time zone, p_failure_reason text, p_occurred_at timestamp with time zone) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_catalog'
    AS $$
DECLARE
  v_scope constant text := 'subscription.dunning.failure';
  -- The first rung the ladder runs with nothing scheduled after it. The ladder
  -- itself lives in commerce_payment_control_apply_before_sub_lock and is not
  -- touched here; this constant is the boundary that body's CASE already draws.
  v_ladder_exhausted_from constant integer := 4;
  v_request_fingerprint text;
  v_existing public.commerce_idempotency_keys%ROWTYPE;
  v_subscription public.subscriptions%ROWTYPE;
  v_cycle public.subscription_cycles%ROWTYPE;
  v_order public.commerce_orders%ROWTYPE;
  v_intent public.commerce_payment_intents%ROWTYPE;
  v_client public.clients%ROWTYPE;
  v_case public.subscription_dunning_cases%ROWTYPE;
  v_case_status text;
  v_exhausted boolean;
  v_notification_kind text;
  v_customer_slug text;
  v_admin_slug text;
  v_token text;
  v_token_hash text;
  v_token_purpose text;
  v_token_expires_at timestamptz;
  v_recovery_url_path text;
  v_admin_count integer := 0;
  v_customer_inserted integer := 0;
  v_response jsonb;
  v_recipient record;
BEGIN
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' OR length(p_idempotency_key) < 8
    OR p_cycle_id IS NULL
    OR p_subscription_id IS NULL
    OR p_order_id IS NULL
    OR p_payment_intent_id IS NULL
    OR p_retry_attempt IS NULL OR p_retry_attempt < 1
    OR p_occurred_at IS NULL
  THEN
    RAISE EXCEPTION 'subscription_dunning_invalid_input' USING ERRCODE = '22023';
  END IF;

  v_request_fingerprint := md5(
    p_cycle_id::text || '|' ||
    p_subscription_id::text || '|' ||
    p_order_id::text || '|' ||
    p_payment_intent_id::text || '|' ||
    p_retry_attempt::text || '|' ||
    COALESCE(p_next_retry_at::text, '') || '|' ||
    COALESCE(p_failure_reason, '') || '|' ||
    p_occurred_at::text
  );

  SELECT *
    INTO v_existing
    FROM public.commerce_idempotency_keys
   WHERE scope = v_scope
     AND idempotency_key = p_idempotency_key
   FOR UPDATE;

  IF FOUND THEN
    IF v_existing.status = 'completed'
      AND v_existing.request_fingerprint = v_request_fingerprint
      AND v_existing.response_payload IS NOT NULL
    THEN
      RETURN jsonb_set(v_existing.response_payload, '{subscriptionDunning,replayed}', 'true'::jsonb, false);
    END IF;

    RAISE EXCEPTION 'subscription_dunning_idempotency_conflict' USING ERRCODE = '23505';
  END IF;

  SELECT *
    INTO v_subscription
    FROM public.subscriptions
   WHERE id = p_subscription_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'subscription_dunning_subscription_not_found' USING ERRCODE = '22023';
  END IF;

  SELECT *
    INTO v_cycle
    FROM public.subscription_cycles
   WHERE id = p_cycle_id
   FOR UPDATE;
  IF NOT FOUND OR v_cycle.subscription_id IS DISTINCT FROM p_subscription_id THEN
    RAISE EXCEPTION 'subscription_dunning_cycle_mismatch' USING ERRCODE = '22023';
  END IF;

  SELECT *
    INTO v_order
    FROM public.commerce_orders
   WHERE id = p_order_id
   FOR UPDATE;
  IF NOT FOUND
    OR v_order.subscription_id IS DISTINCT FROM p_subscription_id
    OR v_order.subscription_cycle_id IS DISTINCT FROM p_cycle_id
  THEN
    RAISE EXCEPTION 'subscription_dunning_order_mismatch' USING ERRCODE = '22023';
  END IF;

  SELECT *
    INTO v_intent
    FROM public.commerce_payment_intents
   WHERE id = p_payment_intent_id
   FOR UPDATE;
  IF NOT FOUND
    OR v_intent.order_id IS DISTINCT FROM p_order_id
    OR v_intent.subscription_id IS DISTINCT FROM p_subscription_id
    OR v_intent.subscription_cycle_id IS DISTINCT FROM p_cycle_id
  THEN
    RAISE EXCEPTION 'subscription_dunning_payment_intent_mismatch' USING ERRCODE = '22023';
  END IF;

  SELECT *
    INTO v_client
    FROM public.clients
   WHERE id = v_order.client_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'subscription_dunning_client_not_found' USING ERRCODE = '22023';
  END IF;

  IF p_retry_attempt IS DISTINCT FROM v_cycle.retry_attempt THEN
    RAISE EXCEPTION 'subscription_dunning_retry_attempt_stale' USING ERRCODE = '22023';
  END IF;

  v_exhausted := p_next_retry_at IS NULL AND p_retry_attempt >= v_ladder_exhausted_from;
  v_case_status := 'open';
  v_notification_kind := CASE WHEN v_exhausted THEN 'payment_expired' ELSE 'payment_failed' END;
  v_customer_slug := CASE
    WHEN v_exhausted THEN 'subscription-payment-expired'
    WHEN p_retry_attempt = 1 THEN 'subscription-payment-failed-1'
    WHEN p_retry_attempt = 2 THEN 'subscription-payment-failed-2'
    ELSE 'subscription-payment-failed-3'
  END;
  v_admin_slug := CASE
    WHEN v_exhausted THEN 'subscription-payment-expired-admin'
    ELSE 'subscription-payment-failed-admin'
  END;
  v_token_purpose := 'repair_payment';
  -- The COALESCE was already here and already does the right thing for an open
  -- case with no schedule: the repair window starts from the refusal itself.
  v_token_expires_at := CASE
    WHEN v_exhausted THEN p_occurred_at + interval '30 days'
    ELSE COALESCE(p_next_retry_at, p_occurred_at) + interval '14 days'
  END;
  -- QP-safe sentinel prefix (see 20260709130000): 'rcv_' leads with a non-hex
  -- char so the recovery deep-link's "?token=" separator + the first token char
  -- can never form a valid quoted-printable "=<2 hex>" escape. The whole prefixed
  -- token is hashed below and on the validate side, so the prefix round-trips.
  v_token := 'rcv_' || replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  v_token_hash := encode(sha256(convert_to(v_token, 'UTF8')), 'hex');
  v_recovery_url_path := '/konto/platnosc/napraw?token=' || v_token;

  INSERT INTO public.commerce_idempotency_keys (
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
    jsonb_build_object('boundary', 'subscription_handle_payment_failure_dunning')
  );

  INSERT INTO public.subscription_dunning_cases (
    subscription_id,
    cycle_id,
    order_id,
    payment_intent_id,
    client_id,
    pet_id,
    status,
    retry_attempt,
    next_retry_at,
    failure_reason,
    opened_at,
    expired_at,
    last_event_at,
    metadata
  )
  VALUES (
    p_subscription_id,
    p_cycle_id,
    p_order_id,
    p_payment_intent_id,
    v_order.client_id,
    v_order.pet_id,
    v_case_status,
    p_retry_attempt,
    p_next_retry_at,
    COALESCE(p_failure_reason, 'payment_failed'),
    p_occurred_at,
    NULL,
    p_occurred_at,
    jsonb_build_object('source', 'subscription.dunning.hidden.v0')
  )
  ON CONFLICT (cycle_id) DO UPDATE
    SET payment_intent_id = EXCLUDED.payment_intent_id,
        status = CASE
          WHEN public.subscription_dunning_cases.status = 'recovered' THEN public.subscription_dunning_cases.status
          ELSE EXCLUDED.status
        END,
        retry_attempt = GREATEST(public.subscription_dunning_cases.retry_attempt, EXCLUDED.retry_attempt),
        next_retry_at = EXCLUDED.next_retry_at,
        failure_reason = EXCLUDED.failure_reason,
        expired_at = CASE
          WHEN EXCLUDED.status = 'expired' THEN COALESCE(public.subscription_dunning_cases.expired_at, EXCLUDED.expired_at)
          ELSE public.subscription_dunning_cases.expired_at
        END,
        last_event_at = EXCLUDED.last_event_at,
        updated_at = now(),
        metadata = public.subscription_dunning_cases.metadata || jsonb_build_object('lastPaymentIntentId', p_payment_intent_id)
  RETURNING * INTO v_case;

  IF v_case.status = 'recovered' THEN
    RAISE EXCEPTION 'subscription_dunning_case_already_recovered' USING ERRCODE = '22023';
  END IF;

  -- A later failure invalidates every previous authorization, including a used
  -- token whose webhook may still be replayed after the authorized charge failed.
  UPDATE public.subscription_payment_recovery_tokens
     SET revoked_at = COALESCE(revoked_at, p_occurred_at), updated_at = now()
   WHERE case_id = v_case.id AND revoked_at IS NULL;

  INSERT INTO public.subscription_payment_recovery_tokens (
    case_id,
    subscription_id,
    cycle_id,
    order_id,
    client_id,
    token_hash,
    purpose,
    expires_at,
    metadata
  )
  VALUES (
    v_case.id,
    p_subscription_id,
    p_cycle_id,
    p_order_id,
    v_order.client_id,
    v_token_hash,
    v_token_purpose,
    v_token_expires_at,
    jsonb_build_object('source', 'subscription.dunning.hidden.v0')
  );

  INSERT INTO public.subscription_dunning_notifications (
    case_id,
    subscription_id,
    cycle_id,
    order_id,
    payment_intent_id,
    recipient_kind,
    recipient_ref,
    notification_kind,
    template_slug,
    retry_attempt,
    idempotency_key,
    status,
    scheduled_at,
    recovery_url_path,
    payload
  )
  VALUES (
    v_case.id,
    p_subscription_id,
    p_cycle_id,
    p_order_id,
    p_payment_intent_id,
    'customer',
    v_order.client_id,
    v_notification_kind,
    v_customer_slug,
    p_retry_attempt,
    v_case.id::text || ':customer:' || v_customer_slug || ':' || p_retry_attempt::text,
    'queued',
    now(),
    v_recovery_url_path,
    jsonb_build_object(
      'clientId', v_order.client_id,
      'clientEmail', v_client.email,
      'clientPhonePresent', v_client.phone IS NOT NULL,
      'orderId', p_order_id,
      'subscriptionId', p_subscription_id,
      'cycleId', p_cycle_id,
      'paymentIntentId', p_payment_intent_id,
      'amountMinor', v_order.total_cents,
      'currency', v_order.currency,
      'retryAttempt', p_retry_attempt,
      'nextRetryAt', p_next_retry_at,
      'failureReason', COALESCE(p_failure_reason, 'payment_failed'),
      'source', 'subscription.dunning.hidden.v0'
    )
  )
  ON CONFLICT (idempotency_key) DO NOTHING;
  GET DIAGNOSTICS v_customer_inserted = ROW_COUNT;

  FOR v_recipient IN
    SELECT id
    FROM public.notification_recipients
    WHERE notification_type = 'commerce_payment_critical'
      AND active = true
    ORDER BY created_at, id
  LOOP
    INSERT INTO public.subscription_dunning_notifications (
      case_id,
      subscription_id,
      cycle_id,
      order_id,
      payment_intent_id,
      recipient_kind,
      recipient_ref,
      notification_kind,
      template_slug,
      retry_attempt,
      idempotency_key,
      status,
      scheduled_at,
      recovery_url_path,
      payload
    )
    VALUES (
      v_case.id,
      p_subscription_id,
      p_cycle_id,
      p_order_id,
      p_payment_intent_id,
      'admin',
      v_recipient.id,
      v_notification_kind,
      v_admin_slug,
      p_retry_attempt,
      v_case.id::text || ':admin:' || v_admin_slug || ':' || p_retry_attempt::text || ':' || v_recipient.id::text,
      'queued',
      now(),
      v_recovery_url_path,
      jsonb_build_object(
        'clientId', v_order.client_id,
        'clientEmail', v_client.email,
        'clientPhonePresent', v_client.phone IS NOT NULL,
        'orderId', p_order_id,
        'subscriptionId', p_subscription_id,
        'cycleId', p_cycle_id,
        'paymentIntentId', p_payment_intent_id,
        'amountMinor', v_order.total_cents,
        'currency', v_order.currency,
        'retryAttempt', p_retry_attempt,
        'nextRetryAt', p_next_retry_at,
        'state', v_case_status,
        'recommendedAction', CASE
          WHEN v_exhausted THEN 'Help the customer authorize payment repair for this same unpaid cycle.'
          ELSE 'Call the customer before the next retry if this account is high value.'
        END,
        'source', 'subscription.dunning.hidden.v0'
      )
    )
    ON CONFLICT (idempotency_key) DO NOTHING;
    v_admin_count := v_admin_count + 1;
  END LOOP;

  IF v_admin_count = 0 THEN
    INSERT INTO public.subscription_dunning_notifications (
      case_id,
      subscription_id,
      cycle_id,
      order_id,
      payment_intent_id,
      recipient_kind,
      recipient_ref,
      notification_kind,
      template_slug,
      retry_attempt,
      idempotency_key,
      status,
      scheduled_at,
      provider_error,
      payload
    )
    VALUES (
      v_case.id,
      p_subscription_id,
      p_cycle_id,
      p_order_id,
      p_payment_intent_id,
      'admin',
      NULL,
      v_notification_kind,
      v_admin_slug,
      p_retry_attempt,
      v_case.id::text || ':admin:' || v_admin_slug || ':' || p_retry_attempt::text || ':missing-recipient',
      'skipped',
      now(),
      'missing_commerce_payment_critical_recipient',
      jsonb_build_object(
        'reason', 'missing_commerce_payment_critical_recipient',
        'subscriptionId', p_subscription_id,
        'cycleId', p_cycle_id,
        'orderId', p_order_id,
        'source', 'subscription.dunning.hidden.v0'
      )
    )
    ON CONFLICT (idempotency_key) DO NOTHING;
  END IF;

  v_response := jsonb_build_object(
    'contractVersion', 'commerce.v0',
    'subscriptionDunning', jsonb_build_object(
      'caseId', v_case.id,
      'subscriptionId', p_subscription_id,
      'cycleId', p_cycle_id,
      'orderId', p_order_id,
      'paymentIntentId', p_payment_intent_id,
      'status', v_case_status,
      'retryAttempt', p_retry_attempt,
      'nextRetryAt', p_next_retry_at,
      'customerNotificationQueued', v_customer_inserted = 1,
      'adminNotificationCount', v_admin_count,
      'recoveryTokenPurpose', v_token_purpose,
      'recoveryUrlPath', v_recovery_url_path,
      'replayed', false
    )
  );

  UPDATE public.commerce_idempotency_keys
     SET status = 'completed',
         response_payload = v_response,
         metadata = metadata || jsonb_build_object(
           'caseId', v_case.id,
           'subscriptionId', p_subscription_id,
           'cycleId', p_cycle_id,
           'orderId', p_order_id
         )
   WHERE scope = v_scope
     AND idempotency_key = p_idempotency_key;

  RETURN v_response;
END;
$$;

CREATE OR REPLACE FUNCTION public.subscription_record_payment_recovery_before_expired_resume(p_idempotency_key text, p_recovery_token text, p_payment_method_ref text, p_payment_method_kind text, p_requested_at timestamp with time zone) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_catalog'
    AS $$
DECLARE
  v_scope constant text := 'subscription.payment_recovery.request';
  v_request_fingerprint text;
  v_existing public.commerce_idempotency_keys%ROWTYPE;
  v_token_hint record;
  v_token public.subscription_payment_recovery_tokens%ROWTYPE;
  v_case public.subscription_dunning_cases%ROWTYPE;
  v_subscription_status text;
  v_retry_attempt integer;
  v_next_action text;
  v_response jsonb;
BEGIN
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' OR length(p_idempotency_key) < 8
    OR p_recovery_token IS NULL OR btrim(p_recovery_token) = ''
    OR p_payment_method_ref IS NULL OR btrim(p_payment_method_ref) = ''
    OR p_payment_method_kind IS NULL OR btrim(p_payment_method_kind) = ''
    OR p_requested_at IS NULL
  THEN
    RAISE EXCEPTION 'subscription_payment_recovery_invalid_input' USING ERRCODE = '22023';
  END IF;

  v_request_fingerprint := md5(
    md5(p_recovery_token) || '|' || p_payment_method_ref || '|' ||
    p_payment_method_kind || '|' || p_requested_at::text
  );

  -- Exact replay is read-only and cannot schedule or mutate a cancelled journey.
  SELECT *
    INTO v_existing
    FROM public.commerce_idempotency_keys
   WHERE scope = v_scope
     AND idempotency_key = p_idempotency_key
   FOR UPDATE;
  IF FOUND THEN
    IF v_existing.status = 'completed'
      AND v_existing.request_fingerprint = v_request_fingerprint
      AND v_existing.response_payload IS NOT NULL
    THEN
      RETURN jsonb_set(v_existing.response_payload, '{subscriptionPaymentRecovery,replayed}', 'true'::jsonb, false);
    END IF;
    RAISE EXCEPTION 'subscription_payment_recovery_idempotency_conflict' USING ERRCODE = '23505';
  END IF;

  SELECT token.id, token.subscription_id
    INTO v_token_hint
    FROM public.subscription_payment_recovery_tokens token
   WHERE token.token_hash = encode(sha256(convert_to(p_recovery_token, 'UTF8')), 'hex');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'subscription_payment_recovery_token_invalid' USING ERRCODE = '22023';
  END IF;

  SELECT subscription.status
    INTO v_subscription_status
    FROM public.subscriptions subscription
   WHERE subscription.id = v_token_hint.subscription_id
   FOR UPDATE;

  SELECT *
    INTO v_token
    FROM public.subscription_payment_recovery_tokens token
   WHERE token.id = v_token_hint.id
   FOR UPDATE;
  IF NOT FOUND
    OR v_token.used_at IS NOT NULL
    OR v_token.revoked_at IS NOT NULL
    OR v_token.expires_at <= p_requested_at
  THEN
    RAISE EXCEPTION 'subscription_payment_recovery_token_invalid' USING ERRCODE = '22023';
  END IF;

  SELECT *
    INTO v_case
    FROM public.subscription_dunning_cases dunning_case
   WHERE dunning_case.id = v_token.case_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'subscription_payment_recovery_case_not_found' USING ERRCODE = '22023';
  END IF;

  IF v_case.subscription_id IS DISTINCT FROM v_token.subscription_id
    OR v_subscription_status = 'cancelled'
    OR (v_token.purpose = 'repair_payment' AND v_case.status <> 'open')
    OR (v_token.purpose = 'resume_subscription' AND v_case.status <> 'expired')
  THEN
    RAISE EXCEPTION 'subscription_payment_recovery_case_state_mismatch' USING ERRCODE = '22023';
  END IF;

  -- Expired-dunning resume requires fresh pricing, ATP, template and order
  -- snapshots through subscription_resume_from_dunning_with_cycle_order. This
  -- generic payment-method redeem boundary has none of them and its historical
  -- resume_requested outbox command has no runtime handler. Fail closed instead
  -- of consuming the token and emitting a false subscription.resumed event.
  IF v_token.purpose = 'resume_subscription' THEN
    RAISE EXCEPTION 'subscription_payment_recovery_resume_not_available'
      USING ERRCODE = '55000';
  END IF;

  INSERT INTO public.commerce_idempotency_keys (
    scope, idempotency_key, request_fingerprint, status, metadata
  )
  VALUES (
    v_scope, p_idempotency_key, v_request_fingerprint, 'in_progress',
    jsonb_build_object('boundary', 'subscription_record_payment_recovery_request')
  );

  UPDATE public.subscriptions
     SET payment_method_ref = p_payment_method_ref,
         payment_method_kind = p_payment_method_kind,
         updated_at = now()
   WHERE id = v_case.subscription_id;

  SELECT retry_attempt INTO v_retry_attempt FROM public.subscription_cycles
   WHERE id = v_case.cycle_id AND subscription_id = v_case.subscription_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'subscription_payment_recovery_case_state_mismatch' USING ERRCODE = '22023';
  END IF;

  UPDATE public.subscription_payment_recovery_tokens
     SET used_at = p_requested_at,
         metadata = metadata || jsonb_build_object('authorizedRetryAttempt', v_retry_attempt,
           'authorizedMethodRef', btrim(p_payment_method_ref)),
         updated_at = now()
   WHERE id = v_token.id;

  v_next_action := 'retry_existing_cycle';

  INSERT INTO public.outbox_events (
    aggregate_type, aggregate_id, event_type, idempotency_key, payload, metadata
  )
  VALUES (
    'subscription', v_case.subscription_id, 'commerce.subscription_payment.retry_requested', p_idempotency_key,
    jsonb_build_object(
      'caseId', v_case.id,
      'subscriptionId', v_case.subscription_id,
      'cycleId', v_case.cycle_id,
      'orderId', v_case.order_id,
      'paymentIntentId', v_case.payment_intent_id,
      'paymentMethodKind', p_payment_method_kind,
      'nextAction', v_next_action,
      'source', 'subscription.recovery.hidden.v0'
    ),
    jsonb_build_object('boundary', 'subscription_record_payment_recovery_request')
  )
  ON CONFLICT (event_type, idempotency_key) DO NOTHING;

  -- A repair is not a recovered payment. The retry event is emitted only by
  -- subscription_try_schedule_recovery_retry after both redeem and the canonical
  -- method-ref webhook are durable. Actual recovery remains owned by apply_result.
  PERFORM public.subscription_try_schedule_recovery_retry(
    v_case.id, p_payment_method_ref, p_requested_at
  );

  v_response := jsonb_build_object(
    'contractVersion', 'commerce.v0',
    'subscriptionPaymentRecovery', jsonb_build_object(
      'caseId', v_case.id,
      'subscriptionId', v_case.subscription_id,
      'cycleId', v_case.cycle_id,
      'orderId', v_case.order_id,
      'purpose', v_token.purpose,
      'nextAction', v_next_action,
      'replayed', false
    )
  );

  UPDATE public.commerce_idempotency_keys
     SET status = 'completed',
         response_payload = v_response,
         metadata = metadata || jsonb_build_object('caseId', v_case.id, 'nextAction', v_next_action)
   WHERE scope = v_scope
     AND idempotency_key = p_idempotency_key;

  RETURN v_response;
END;
$$;

CREATE OR REPLACE FUNCTION public.subscription_try_schedule_recovery_retry(p_case_id uuid, p_payment_method_ref text, p_requested_at timestamp with time zone DEFAULT now(), p_entry text DEFAULT 'recovery_redeem'::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_catalog'
    AS $$
DECLARE
  v_case public.subscription_dunning_cases%ROWTYPE;
  v_cycle public.subscription_cycles%ROWTYPE;
  v_method public.commerce_payment_method_refs%ROWTYPE;
  v_token public.subscription_payment_recovery_tokens%ROWTYPE;
  v_subscription public.subscriptions%ROWTYPE;
  v_hint uuid;
  v_event_key text;
  v_inserted boolean;
BEGIN
  IF p_case_id IS NULL OR NULLIF(btrim(p_payment_method_ref), '') IS NULL
     OR p_requested_at IS NULL OR p_entry IS NULL
     OR p_entry NOT IN ('recovery_redeem', 'method_ref_webhook') THEN
    RAISE EXCEPTION 'subscription_recovery_retry_invalid_input' USING ERRCODE = '22023';
  END IF;
  SELECT subscription_id INTO v_hint FROM public.subscription_dunning_cases WHERE id=p_case_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('scheduled', false, 'reason', 'case_not_found'); END IF;
  SELECT * INTO v_subscription FROM public.subscriptions WHERE id=v_hint FOR UPDATE;
  SELECT * INTO v_case FROM public.subscription_dunning_cases WHERE id=p_case_id FOR UPDATE;
  IF v_case.status <> 'open' OR v_subscription.status <> 'active' THEN
    RETURN jsonb_build_object('scheduled', false, 'reason', 'recovery_not_ready');
  END IF;
  SELECT * INTO v_cycle FROM public.subscription_cycles
   WHERE id=v_case.cycle_id AND subscription_id=v_subscription.id FOR UPDATE;
  IF NOT FOUND OR v_cycle.status NOT IN ('retry_scheduled','payment_failed') THEN
    RETURN jsonb_build_object('scheduled', false, 'reason', 'cycle_not_retryable');
  END IF;
  SELECT * INTO v_method FROM public.commerce_payment_method_refs
   WHERE subscription_id=v_subscription.id AND client_id=v_subscription.client_id
     AND provider_method_ref=btrim(p_payment_method_ref) AND active AND status='active'
     AND (expires_at IS NULL OR expires_at > now()) ORDER BY updated_at DESC LIMIT 1;
  IF NOT FOUND THEN RETURN jsonb_build_object('scheduled', false, 'reason', 'recovery_not_ready'); END IF;

  SELECT * INTO v_token FROM public.subscription_payment_recovery_tokens
   WHERE case_id=v_case.id AND subscription_id=v_subscription.id AND client_id=v_subscription.client_id
     AND cycle_id=v_cycle.id AND purpose='repair_payment' AND used_at IS NOT NULL
     AND revoked_at IS NULL AND expires_at > p_requested_at
     AND metadata->>'authorizedRetryAttempt'=v_cycle.retry_attempt::text
     AND metadata->>'authorizedMethodRef'=v_method.provider_method_ref
   ORDER BY used_at DESC, id DESC LIMIT 1 FOR UPDATE;
  -- A bare method observation can accelerate an existing automatic slot only.
  -- It cannot reopen an exhausted or deliberately terminated payment_failed cycle.
  IF v_token.id IS NULL THEN
    IF p_entry <> 'method_ref_webhook' OR v_cycle.status <> 'retry_scheduled'
       OR v_cycle.retry_attempt >= 4 OR v_method.updated_at < v_case.opened_at THEN
      RETURN jsonb_build_object('scheduled', false, 'reason', 'recovery_not_ready');
    END IF;
  ELSE
    IF v_method.consent_snapshot->>'recoveryCaseId' IS DISTINCT FROM v_case.id::text
       OR v_token.metadata ? 'scheduledAt' THEN
      RETURN jsonb_build_object('scheduled', false, 'reason', 'recovery_not_ready');
    END IF;
  END IF;
  v_event_key := 'payment-recovery-retry:' || v_case.id::text;
  IF v_cycle.status='payment_failed' OR v_cycle.retry_attempt >= 4 THEN
    v_event_key := v_event_key || ':token:' || v_token.id::text;
  END IF;
  -- Receipt precedes every mutation. A replay cannot pull a later failure forward.
  INSERT INTO public.subscription_events(subscription_id,cycle_id,event_type,idempotency_key,payload,occurred_at)
  VALUES(v_subscription.id,v_cycle.id,'subscription.retry_scheduled',v_event_key,
    jsonb_build_object('caseId',v_case.id,'source','subscription.payment_recovery',
      'reason','payment_method_recovered','entry',p_entry,'recoveryTokenId',v_token.id),p_requested_at)
  ON CONFLICT(idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING;
  v_inserted := FOUND;
  IF NOT v_inserted THEN RETURN jsonb_build_object('scheduled',false,'reason','already_scheduled'); END IF;
  IF v_token.id IS NOT NULL THEN
    UPDATE public.subscription_payment_recovery_tokens SET metadata=metadata ||
      jsonb_build_object('scheduledAt',now(),'authorizedMethodId',v_method.id),updated_at=now() WHERE id=v_token.id;
    UPDATE public.subscription_dunning_cases SET metadata=metadata || jsonb_build_object(
      'recoveryTokenId',v_token.id,'recoveryMethodId',v_method.id,
      'recoveryRetryAttempt',v_cycle.retry_attempt),updated_at=now() WHERE id=v_case.id;
  END IF;
  UPDATE public.subscriptions SET payment_method_ref=v_method.provider_method_ref,
    payment_method_kind=v_method.method_kind,updated_at=now() WHERE id=v_subscription.id;
  UPDATE public.subscription_cycles SET status='retry_scheduled',next_retry_at=now(),updated_at=now() WHERE id=v_cycle.id;
  UPDATE public.subscription_dunning_cases SET next_retry_at=now(),updated_at=now() WHERE id=v_case.id;
  RETURN jsonb_build_object('scheduled',true,'entry',p_entry,'reason','ready');
END; $$;

CREATE OR REPLACE FUNCTION public.subscription_list_due_for_renewal(p_limit integer DEFAULT 50, p_as_of timestamp with time zone DEFAULT now()) RETURNS TABLE(subscription_id uuid, client_id uuid, next_cycle_at timestamp with time zone, cadence_days integer, template_version integer, currency text, region_code text, provider_kind text, provider_customer_ref text, provider_method_ref text, method_kind text, status text, payer_email text, payer_name text, method_status text, method_active boolean, method_expires_at timestamp with time zone, method_client_id uuid)
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
BEGIN
  IF p_limit IS NULL OR p_limit <= 0 OR p_limit > 500 THEN
    RAISE EXCEPTION 'subscription_list_due_for_renewal: p_limit must be between 1 and 500'
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
    WITH retry_due AS (
      SELECT
        s.id          AS subscription_id,
        s.client_id   AS client_id,
        c.scheduled_at AS next_cycle_at,
        s.cadence_days,
        s.template_version,
        s.currency,
        s.region_code,
        m.provider_kind,
        CASE
          WHEN m.client_id = s.client_id AND m.active = true AND m.status = 'active'
          THEN m.provider_customer_ref
          ELSE NULL
        END AS provider_customer_ref,
        CASE
          WHEN m.client_id = s.client_id AND m.active = true AND m.status = 'active'
          THEN m.provider_method_ref
          ELSE NULL
        END AS provider_method_ref,
        COALESCE(m.method_kind, s.payment_method_kind, '') AS method_kind,
        m.status,
        cl.email AS payer_email,
        NULLIF(btrim(concat_ws(' ', cl.first_name, cl.last_name)), '') AS payer_name,
        m.status AS method_status,
        m.active AS method_active,
        m.expires_at AS method_expires_at,
        m.client_id AS method_client_id
      FROM public.subscriptions s
      JOIN public.clients cl
        ON cl.id = s.client_id
      JOIN public.subscription_cycles c
        ON c.subscription_id = s.id
       AND c.status = 'retry_scheduled'
       AND c.next_retry_at IS NOT NULL
       AND c.next_retry_at <= p_as_of
       AND (c.retry_attempt < 4 OR EXISTS (
         SELECT 1 FROM public.subscription_dunning_cases dc
         JOIN public.subscription_payment_recovery_tokens rt ON rt.id::text=dc.metadata->>'recoveryTokenId'
         WHERE dc.cycle_id=c.id AND dc.status='open'
           AND dc.metadata->>'recoveryRetryAttempt'=c.retry_attempt::text
           AND rt.used_at IS NOT NULL AND rt.revoked_at IS NULL AND rt.expires_at > p_as_of))
       -- Quarantine skip (retry lane). A bare timestamp comparison, never a
       -- status: an elapsed value re-admits the row on the very next pass with
       -- no unquarantine write required, so a lost clear cannot strand anyone.
       AND (c.renewal_quarantined_until IS NULL OR c.renewal_quarantined_until <= p_as_of)
      LEFT JOIN LATERAL (
        SELECT pm.provider_kind, pm.provider_customer_ref, pm.provider_method_ref,
               pm.method_kind, pm.status, pm.active, pm.expires_at, pm.client_id,
               pm.updated_at, pm.created_at
          FROM public.commerce_payment_method_refs pm
         WHERE pm.subscription_id = s.id
           AND (NOT EXISTS (SELECT 1 FROM public.subscription_dunning_cases dc
                  WHERE dc.cycle_id=c.id AND dc.metadata->>'recoveryRetryAttempt'=c.retry_attempt::text)
             OR EXISTS (SELECT 1 FROM public.subscription_dunning_cases dc
                JOIN public.subscription_payment_recovery_tokens rt ON rt.id::text=dc.metadata->>'recoveryTokenId'
               WHERE dc.cycle_id=c.id AND dc.status='open'
                 AND dc.metadata->>'recoveryRetryAttempt'=c.retry_attempt::text
                 AND dc.metadata->>'recoveryMethodId'=pm.id::text
                 AND rt.revoked_at IS NULL AND rt.used_at IS NOT NULL AND rt.expires_at > p_as_of))
         ORDER BY
           (pm.active = true AND pm.status = 'active') DESC,
           pm.active DESC,
           pm.updated_at DESC,
           pm.created_at DESC
         LIMIT 1
      ) m ON true
      WHERE s.status = 'active'
      ORDER BY c.next_retry_at ASC, s.id ASC
      LIMIT p_limit
      FOR UPDATE OF s SKIP LOCKED
    ),
    normal_due AS (
      SELECT
        s.id          AS subscription_id,
        s.client_id   AS client_id,
        s.next_cycle_at,
        s.cadence_days,
        s.template_version,
        s.currency,
        s.region_code,
        m.provider_kind,
        CASE
          WHEN m.client_id = s.client_id AND m.active = true AND m.status = 'active'
          THEN m.provider_customer_ref
          ELSE NULL
        END,
        CASE
          WHEN m.client_id = s.client_id AND m.active = true AND m.status = 'active'
          THEN m.provider_method_ref
          ELSE NULL
        END AS provider_method_ref,
        COALESCE(m.method_kind, s.payment_method_kind, '') AS method_kind,
        m.status,
        cl.email AS payer_email,
        NULLIF(btrim(concat_ws(' ', cl.first_name, cl.last_name)), '') AS payer_name,
        m.status AS method_status,
        m.active AS method_active,
        m.expires_at AS method_expires_at,
        m.client_id AS method_client_id
      FROM public.subscriptions s
      JOIN public.clients cl
        ON cl.id = s.client_id
      LEFT JOIN LATERAL (
        SELECT pm.provider_kind, pm.provider_customer_ref, pm.provider_method_ref,
               pm.method_kind, pm.status, pm.active, pm.expires_at, pm.client_id,
               pm.updated_at, pm.created_at
          FROM public.commerce_payment_method_refs pm
         WHERE pm.subscription_id = s.id
         ORDER BY
           (pm.active = true AND pm.status = 'active') DESC,
           pm.active DESC,
           pm.updated_at DESC,
           pm.created_at DESC
         LIMIT 1
      ) m ON true
      WHERE s.status = 'active'
        AND s.next_cycle_at IS NOT NULL
        AND s.next_cycle_at <= p_as_of
        AND NOT EXISTS (
          SELECT 1
            FROM public.subscription_cycles c
           WHERE c.subscription_id = s.id
             AND c.status IN ('payment_pending', 'retry_scheduled', 'payment_failed')
        )
        -- Quarantine skip (normal lane). The open-cycle guard above already
        -- hides the common case, so this covers the row whose cycle left those
        -- statuses while still quarantined; without it the same failing row
        -- would come straight back through the other lane.
        AND NOT EXISTS (
          SELECT 1
            FROM public.subscription_cycles c
           WHERE c.subscription_id = s.id
             AND c.renewal_quarantined_until > p_as_of
        )
      ORDER BY s.next_cycle_at ASC, s.id ASC
      LIMIT p_limit
      FOR UPDATE OF s SKIP LOCKED
    )
    SELECT *
      FROM (
        SELECT * FROM retry_due
        UNION ALL
        SELECT * FROM normal_due
      ) due
     ORDER BY due.next_cycle_at ASC, due.subscription_id ASC
     LIMIT p_limit;
END;
$$;

CREATE OR REPLACE FUNCTION public.commerce_payment_control_prepare_provider_attempt(p_idempotency_key text, p_payment_intent_id uuid, p_provider text, p_provider_idempotency_key text, p_provider_request_fingerprint text, p_provider_flow text, p_payment_method_ref text, p_request_payload jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_catalog'
    AS $_$
DECLARE
  v_scope constant text := 'commerce.payment_attempt.prepare_provider';
  v_intent_hint record;
  v_intent_hint_found boolean := false;
  v_intent public.commerce_payment_intents%ROWTYPE;
  v_order public.commerce_orders%ROWTYPE;
  v_active_attempt public.commerce_payment_attempts%ROWTYPE;
  v_observed_success_attempt public.commerce_payment_attempts%ROWTYPE;
  v_subscription_status text;
  v_recovery_case public.subscription_dunning_cases%ROWTYPE;
  v_recovery_cycle public.subscription_cycles%ROWTYPE;
  v_recovery_token public.subscription_payment_recovery_tokens%ROWTYPE;
  v_recovery_method public.commerce_payment_method_refs%ROWTYPE;
  v_inline_retry boolean := COALESCE(p_request_payload->>'source', '') =
    'commerce.checkout-inline-recovery.prepare.v1';
  v_expected_attempt_id uuid;
  v_inline_purchase_context text;
BEGIN
  IF v_inline_retry THEN
    IF COALESCE(p_request_payload->>'expectedPaymentAttemptId', '') !~
         '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
      OR COALESCE(p_request_payload->>'retryRequestId', '') !~
         '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
      OR COALESCE(p_request_payload->>'purchaseContext', '') NOT IN ('one_time', 'subscription_initial')
    THEN
      RAISE EXCEPTION 'payment_control_inline_retry_invalid_context'
        USING ERRCODE = '22023';
    END IF;
    v_expected_attempt_id := (p_request_payload->>'expectedPaymentAttemptId')::uuid;
    v_inline_purchase_context := p_request_payload->>'purchaseContext';
  END IF;

  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' OR length(p_idempotency_key) < 8
    OR p_payment_intent_id IS NULL
    OR p_provider IS NULL OR btrim(p_provider) = ''
    OR p_provider_idempotency_key IS NULL OR btrim(p_provider_idempotency_key) = ''
    OR p_provider_request_fingerprint IS NULL OR btrim(p_provider_request_fingerprint) = ''
    OR p_provider_flow IS NULL OR btrim(p_provider_flow) = ''
    OR p_provider_flow NOT IN (
      'one_time_payment', 'setup_reusable_method', 'off_session_payment',
      'blik_one_time', 'blik_one_click', 'pbl_one_time',
      'blik_recurring_activation', 'recurring_charge'
    )
  THEN
    RETURN public.commerce_payment_control_prepare_attempt_unguarded(
      p_idempotency_key, p_payment_intent_id, p_provider,
      p_provider_idempotency_key, p_provider_request_fingerprint,
      p_provider_flow, p_payment_method_ref, p_request_payload
    );
  END IF;

  -- Resolve the aggregate without a row lock, then acquire the aggregate root
  -- before any payment row. The intent is re-read under lock below.
  SELECT payment_intent.target_kind, payment_intent.subscription_id,
         payment_intent.order_id
    INTO v_intent_hint
   FROM public.commerce_payment_intents payment_intent
   WHERE payment_intent.id = p_payment_intent_id;
  v_intent_hint_found := FOUND;

  IF v_intent_hint_found AND v_intent_hint.subscription_id IS NOT NULL THEN
    SELECT subscription.status
      INTO v_subscription_status
      FROM public.subscriptions subscription
     WHERE subscription.id = v_intent_hint.subscription_id
     FOR UPDATE;
  END IF;

  -- Inline admission must prove the order is still payable in the same locked
  -- decision as the predecessor CAS. Acquire it before the intent/attempt so
  -- order-first cancellation cannot form an ABBA cycle with this route.
  IF v_intent_hint_found AND v_intent_hint.order_id IS NOT NULL THEN
    SELECT *
      INTO v_order
      FROM public.commerce_orders checkout_order
     WHERE checkout_order.id = v_intent_hint.order_id
     FOR UPDATE;
  END IF;

  SELECT *
    INTO v_intent
    FROM public.commerce_payment_intents payment_intent
   WHERE payment_intent.id = p_payment_intent_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN public.commerce_payment_control_prepare_attempt_unguarded(
      p_idempotency_key, p_payment_intent_id, p_provider,
      p_provider_idempotency_key, p_provider_request_fingerprint,
      p_provider_flow, p_payment_method_ref, p_request_payload
    );
  END IF;

  IF v_intent_hint.target_kind IS DISTINCT FROM v_intent.target_kind
    OR v_intent_hint.subscription_id IS DISTINCT FROM v_intent.subscription_id
    OR v_intent_hint.order_id IS DISTINCT FROM v_intent.order_id
  THEN
    RAISE EXCEPTION 'payment_control_intent_aggregate_changed'
      USING ERRCODE = '55000';
  END IF;

  -- Inline cancellation races have a stable winner contract: once the order
  -- root is no longer payable, do not delegate through the legacy terminal-
  -- intent branch and never mint a post-cancel attempt.
  IF v_inline_retry AND (
    v_order.id IS NULL
    OR v_order.status <> 'pending_payment'
    OR COALESCE(v_order.metadata->>'paymentStatus', '') = 'expired'
  ) THEN
    RAISE EXCEPTION 'payment_control_inline_retry_order_not_payable'
      USING ERRCODE = '55000';
  END IF;

  IF v_intent.status IN (
    'succeeded', 'cancelled', 'refunded', 'partially_refunded', 'disputed'
  ) THEN
    RETURN public.commerce_payment_control_prepare_attempt_unguarded(
      p_idempotency_key, p_payment_intent_id, p_provider,
      p_provider_idempotency_key, p_provider_request_fingerprint,
      p_provider_flow, p_payment_method_ref, p_request_payload
    );
  END IF;

  -- Preserve exact replay/fingerprint behavior after the aggregate fence.
  IF EXISTS (
    SELECT 1
      FROM public.commerce_idempotency_keys
     WHERE scope = v_scope
       AND idempotency_key = p_idempotency_key
  ) THEN
    RETURN public.commerce_payment_control_prepare_attempt_unguarded(
      p_idempotency_key, p_payment_intent_id, p_provider,
      p_provider_idempotency_key, p_provider_request_fingerprint,
      p_provider_flow, p_payment_method_ref, p_request_payload
    );
  END IF;

  -- Exhausted repair is admitted only for the method authorized by the token.
  -- Root/order/intent locks above serialize this decision with cancellation.
  SELECT * INTO v_recovery_cycle FROM public.subscription_cycles WHERE id=v_intent.subscription_cycle_id;
  SELECT * INTO v_recovery_case FROM public.subscription_dunning_cases WHERE cycle_id=v_recovery_cycle.id;
  IF v_recovery_case.status='open' AND (v_recovery_cycle.retry_attempt >= 4
      OR v_recovery_case.metadata->>'recoveryRetryAttempt'=v_recovery_cycle.retry_attempt::text) THEN
    SELECT * INTO v_recovery_token FROM public.subscription_payment_recovery_tokens
     WHERE id::text=v_recovery_case.metadata->>'recoveryTokenId' FOR UPDATE;
    -- Keep this exact method usable until admission commits. Canonical method
    -- rotation writes this row without the subscription lock, so an unlocked
    -- observation could become stale while we wait for a predecessor attempt.
    SELECT pm.* INTO v_recovery_method FROM public.commerce_payment_method_refs pm
     WHERE pm.id::text=v_recovery_case.metadata->>'recoveryMethodId' FOR SHARE;
    IF v_recovery_cycle.status <> 'retry_scheduled' OR v_recovery_cycle.next_retry_at IS NULL
       OR v_recovery_token.id IS NULL OR v_recovery_token.revoked_at IS NOT NULL
       OR v_recovery_token.expires_at <= now() OR v_recovery_token.used_at IS NULL
       OR v_recovery_token.case_id IS DISTINCT FROM v_recovery_case.id
       OR v_recovery_token.subscription_id IS DISTINCT FROM v_intent.subscription_id
       OR v_recovery_token.cycle_id IS DISTINCT FROM v_recovery_cycle.id
       OR v_recovery_token.client_id IS DISTINCT FROM v_order.client_id
       OR v_recovery_token.order_id IS DISTINCT FROM v_order.id
       OR v_recovery_token.metadata->>'authorizedRetryAttempt' IS DISTINCT FROM v_recovery_cycle.retry_attempt::text
       OR (v_recovery_token.metadata ? 'dispatchKey' AND v_recovery_token.metadata->>'dispatchKey' <> p_idempotency_key)
       OR v_recovery_method.id IS NULL
       OR v_recovery_method.provider_kind IS DISTINCT FROM p_provider
       OR v_recovery_method.provider_method_ref IS DISTINCT FROM p_payment_method_ref
       OR v_recovery_method.subscription_id IS DISTINCT FROM v_intent.subscription_id
       OR v_recovery_method.client_id IS DISTINCT FROM v_order.client_id
       OR v_recovery_method.active IS DISTINCT FROM true OR v_recovery_method.status <> 'active'
       OR (v_recovery_method.expires_at IS NOT NULL AND v_recovery_method.expires_at<=now()) THEN
      RAISE EXCEPTION 'payment_control_recovery_authority_invalid' USING ERRCODE='55000';
    END IF;
    UPDATE public.subscription_payment_recovery_tokens SET metadata=metadata ||
      jsonb_build_object('dispatchKey',p_idempotency_key),updated_at=now() WHERE id=v_recovery_token.id;
  END IF;

  -- A verified provider success can be durable before local result application
  -- converges the attempt and intent. Returning that exact attempt as a replay
  -- keeps every caller behind the existing provider_attempt_in_flight boundary
  -- and prevents not-chargeable cleanup from cancelling an already-paid order.
  SELECT payment_attempt.*
    INTO v_observed_success_attempt
    FROM public.commerce_payment_attempts payment_attempt
   WHERE payment_attempt.payment_intent_id = v_intent.id
     AND payment_attempt.payment_id = v_intent.payment_id
     AND (
       EXISTS (
         SELECT 1
           FROM public.inbound_provider_events provider_event
          WHERE provider_event.payment_intent_id = payment_attempt.payment_intent_id
            AND provider_event.payment_attempt_id = payment_attempt.id
            AND provider_event.provider = payment_attempt.provider
            AND provider_event.provider_payment_id = payment_attempt.provider_attempt_id
            AND provider_event.signature_verified IS TRUE
            AND provider_event.event_type = 'payment.succeeded'
       )
       OR EXISTS (
         SELECT 1
           FROM public.commerce_payment_reconciliation_runs reconciliation
          WHERE reconciliation.payment_intent_id = payment_attempt.payment_intent_id
            AND reconciliation.payment_attempt_id = payment_attempt.id
            AND reconciliation.provider = payment_attempt.provider
            AND reconciliation.provider_payment_id = CASE
              WHEN payment_attempt.provider = 'tpay'
                THEN payment_attempt.provider_session_id
              ELSE payment_attempt.provider_attempt_id
            END
            AND reconciliation.payload->>'normalizedStatus' = 'succeeded'
       )
     )
   ORDER BY payment_attempt.created_at DESC, payment_attempt.id DESC
   LIMIT 1
   FOR UPDATE;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'contractVersion', 'commerce.v0',
      'paymentAttempt', jsonb_build_object(
        'id', v_observed_success_attempt.id,
        'paymentIntentId', v_observed_success_attempt.payment_intent_id,
        'status', v_observed_success_attempt.status,
        'provider', v_observed_success_attempt.provider,
        'providerAttemptId', v_observed_success_attempt.provider_attempt_id,
        'providerSessionId', v_observed_success_attempt.provider_session_id,
        'nextActionKind', v_observed_success_attempt.next_action_kind,
        'idempotencyKey', v_observed_success_attempt.idempotency_key,
        'replayed', true
      )
    );
  END IF;

  IF v_inline_retry THEN
    IF v_intent.status <> 'failed'
      OR v_intent.active_attempt_id IS DISTINCT FROM v_expected_attempt_id
      OR v_intent.order_id IS DISTINCT FROM v_intent_hint.order_id
    THEN
      RAISE EXCEPTION 'payment_control_inline_retry_predecessor_mismatch'
        USING ERRCODE = '55000';
    END IF;

    SELECT *
      INTO v_active_attempt
      FROM public.commerce_payment_attempts payment_attempt
     WHERE payment_attempt.id = v_expected_attempt_id
       AND payment_attempt.payment_intent_id = v_intent.id
       AND payment_attempt.payment_id = v_intent.payment_id
     FOR UPDATE;

    IF NOT FOUND OR v_active_attempt.status <> 'failed' THEN
      RAISE EXCEPTION 'payment_control_inline_retry_predecessor_mismatch'
        USING ERRCODE = '55000';
    END IF;

    IF v_inline_purchase_context = 'subscription_initial' THEN
      IF v_intent.target_kind <> 'subscription_cycle'
        OR v_subscription_status IS DISTINCT FROM 'pending_activation'
        OR NOT (
          (p_provider = 'stripe' AND p_provider_flow = 'one_time_payment')
          OR (p_provider = 'tpay' AND p_provider_flow = 'blik_recurring_activation')
        )
      THEN
        RAISE EXCEPTION 'payment_control_inline_retry_context_mismatch'
          USING ERRCODE = '55000';
      END IF;
    ELSIF v_intent.target_kind <> 'one_time_order'
      OR NOT (
        (p_provider = 'stripe' AND p_provider_flow = 'one_time_payment')
        OR (p_provider = 'tpay' AND p_provider_flow = 'blik_one_time')
      )
    THEN
      RAISE EXCEPTION 'payment_control_inline_retry_context_mismatch'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  IF v_intent.target_kind = 'subscription_cycle'
    AND (v_subscription_status IS NULL OR v_subscription_status NOT IN ('pending_activation', 'active'))
  THEN
    -- A pause can win after the cron created local artifacts but before the PSP
    -- boundary. Persist a truthful terminal cleanup, then return a typed marker;
    -- raising would roll the cleanup back. Customer cancellation performs the
    -- same cleanup in its own transaction.
    IF NOT EXISTS (
      SELECT 1
        FROM public.commerce_payment_attempts payment_attempt
       WHERE payment_attempt.payment_intent_id = v_intent.id
         AND payment_attempt.status NOT IN (
           'blocked_preflight', 'failed', 'cancelled', 'expired'
         )
    ) THEN
      UPDATE public.commerce_payment_intents
         SET status = 'cancelled',
             failure_reason = 'subscription_not_chargeable',
             updated_at = now()
       WHERE id = v_intent.id
         AND status IN ('created', 'failed');

      UPDATE public.subscription_cycles
         SET status = 'cancelled',
             next_retry_at = NULL,
             failure_reason = 'subscription_not_chargeable',
             updated_at = now()
       WHERE id = v_intent.subscription_cycle_id
         AND subscription_id = v_intent.subscription_id
         AND status IN ('payment_pending', 'retry_scheduled');

      -- The existing order-cancel trigger releases every reserved hold.
      UPDATE public.commerce_orders
         SET status = 'cancelled',
             metadata = metadata || jsonb_build_object(
               'paymentStatus', 'cancelled',
               'cancelReason', 'subscription_not_chargeable',
               'source', 'payment.control.prepare'
             ),
             updated_at = now()
       WHERE id = v_intent.order_id
         AND status = 'pending_payment';
    END IF;

    RETURN jsonb_build_object(
      'contractVersion', 'commerce.v0',
      'paymentAttemptAdmission', jsonb_build_object(
        'status', 'skipped_not_chargeable',
        'reason', 'payment_control_subscription_not_chargeable',
        'paymentIntentId', v_intent.id
      )
    );
  END IF;

  IF v_intent.active_attempt_id IS NOT NULL THEN
    SELECT *
      INTO v_active_attempt
      FROM public.commerce_payment_attempts payment_attempt
     WHERE payment_attempt.id = v_intent.active_attempt_id
     FOR UPDATE;

    IF FOUND AND v_active_attempt.status NOT IN (
      'blocked_preflight', 'failed', 'cancelled', 'expired'
    ) THEN
      RETURN jsonb_build_object(
        'contractVersion', 'commerce.v0',
        'paymentAttempt', jsonb_build_object(
          'id', v_active_attempt.id,
          'paymentIntentId', v_active_attempt.payment_intent_id,
          'status', v_active_attempt.status,
          'provider', v_active_attempt.provider,
          'providerAttemptId', v_active_attempt.provider_attempt_id,
          'providerSessionId', v_active_attempt.provider_session_id,
          'nextActionKind', v_active_attempt.next_action_kind,
          'idempotencyKey', v_active_attempt.idempotency_key,
          'replayed', true
        )
      );
    END IF;
  END IF;

  RETURN public.commerce_payment_control_prepare_attempt_unguarded(
    p_idempotency_key, p_payment_intent_id, p_provider,
    p_provider_idempotency_key, p_provider_request_fingerprint,
    p_provider_flow, p_payment_method_ref, p_request_payload
  );
END;
$_$;

-- Recovery selection needs only these additional cycle identity fields.
GRANT SELECT (id, retry_attempt) ON public.subscription_cycles TO service_role;
