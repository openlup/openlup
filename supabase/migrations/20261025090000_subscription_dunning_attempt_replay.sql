-- M10-9 inert approval fixture: attributed dunning attempt replay.
-- Ported without routine changes from the donor adopter at 3f525051e:
-- supabase/migrations/20261024195559_subscription_dunning_attempt_replay.sql
-- Control preparation only; no installation or runtime activation.
-- Existing adopter history requires explicit schema/backfill mapping, never raw replay.
-- Rollback uses a compensating forward and preserves attribution and revocations.

ALTER TABLE public.subscription_dunning_cases
  ADD COLUMN failed_payment_attempt_id uuid,
  ADD COLUMN failure_observation_result jsonb;

ALTER TABLE public.subscription_dunning_cases
  ADD CONSTRAINT subscription_dunning_cases_failed_attempt_fkey
  FOREIGN KEY (failed_payment_attempt_id) REFERENCES public.commerce_payment_attempts(id) NOT VALID;

WITH candidates AS (
  SELECT d.id, min(event.payload ->> 'paymentAttemptId')::uuid AS attempt_id
    FROM public.subscription_dunning_cases d
    JOIN public.subscription_events event
      ON event.subscription_id = d.subscription_id AND event.cycle_id = d.cycle_id
    JOIN public.commerce_payment_attempts attempt
      ON attempt.id::text = event.payload ->> 'paymentAttemptId'
     AND attempt.payment_intent_id = d.payment_intent_id
   WHERE d.status = 'open'
     AND event.event_type IN ('subscription.retry_scheduled', 'subscription.payment_failed')
     AND event.payload ->> 'source' = 'payment.control.v0'
     AND event.payload ->> 'paymentIntentId' = d.payment_intent_id::text
     AND event.payload ->> 'retryAttempt' = d.retry_attempt::text
   GROUP BY d.id HAVING count(DISTINCT attempt.id) = 1
), attributed AS (
  SELECT c.*, receipt.response_payload
    FROM candidates c
    JOIN public.subscription_dunning_cases d ON d.id = c.id
    LEFT JOIN LATERAL (
      SELECT k.response_payload FROM public.commerce_idempotency_keys k
       WHERE k.scope = 'subscription.dunning.failure' AND k.status = 'completed'
         AND k.response_payload #>> '{subscriptionDunning,caseId}' = c.id::text
         AND k.response_payload #>> '{subscriptionDunning,retryAttempt}' = d.retry_attempt::text
         AND k.response_payload #>> '{subscriptionDunning,paymentIntentId}' = d.payment_intent_id::text
         AND EXISTS (SELECT 1 FROM public.subscription_payment_recovery_tokens token
           WHERE token.case_id = d.id AND token.revoked_at IS NULL
             AND token.token_hash = encode(sha256(convert_to(split_part(
               k.response_payload #>> '{subscriptionDunning,recoveryUrlPath}', 'token=', 2), 'UTF8')), 'hex'))
       ORDER BY k.created_at, k.idempotency_key LIMIT 1
    ) receipt ON true
)
UPDATE public.subscription_dunning_cases d
   SET failed_payment_attempt_id = a.attempt_id,
       failure_observation_result = a.response_payload
  FROM attributed a WHERE d.id = a.id;

WITH receipt_attempts AS (
  SELECT receipt.idempotency_key, min(attempt.id::text)::uuid AS attempt_id
    FROM public.commerce_idempotency_keys receipt
    JOIN public.subscription_dunning_cases d
      ON d.id::text = receipt.response_payload #>> '{subscriptionDunning,caseId}'
    JOIN public.subscription_events event
      ON event.subscription_id = d.subscription_id AND event.cycle_id = d.cycle_id
    JOIN public.commerce_payment_attempts attempt
      ON attempt.id::text = event.payload ->> 'paymentAttemptId'
     AND attempt.payment_intent_id::text = receipt.response_payload #>> '{subscriptionDunning,paymentIntentId}'
   WHERE d.status = 'open' AND receipt.scope = 'subscription.dunning.failure' AND receipt.status = 'completed'
     AND event.event_type IN ('subscription.retry_scheduled', 'subscription.payment_failed')
     AND event.payload ->> 'source' = 'payment.control.v0'
     AND event.payload ->> 'paymentIntentId' = receipt.response_payload #>> '{subscriptionDunning,paymentIntentId}'
     AND event.payload ->> 'retryAttempt' = receipt.response_payload #>> '{subscriptionDunning,retryAttempt}'
   GROUP BY receipt.idempotency_key HAVING count(DISTINCT attempt.id) = 1
)
UPDATE public.commerce_idempotency_keys receipt
   SET metadata = receipt.metadata || jsonb_build_object('failedPaymentAttemptId', a.attempt_id)
  FROM receipt_attempts a
 WHERE receipt.scope = 'subscription.dunning.failure' AND receipt.idempotency_key = a.idempotency_key;

CREATE OR REPLACE FUNCTION public.subscription_handle_payment_failure_dunning_before_cancel_fence(
  p_idempotency_key text,
  p_cycle_id uuid,
  p_subscription_id uuid,
  p_order_id uuid,
  p_payment_intent_id uuid,
  p_retry_attempt integer,
  p_next_retry_at timestamptz,
  p_failure_reason text,
  p_occurred_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  RETURN public.subscription_handle_payment_failure_dunning_before_cancel_fence(p_idempotency_key, p_cycle_id, p_subscription_id, p_order_id, p_payment_intent_id, p_retry_attempt, p_next_retry_at, p_failure_reason, p_occurred_at, NULL::uuid);
END;
$$;

CREATE OR REPLACE FUNCTION public.subscription_handle_payment_failure_dunning(
  p_idempotency_key text,
  p_cycle_id uuid,
  p_subscription_id uuid,
  p_order_id uuid,
  p_payment_intent_id uuid,
  p_retry_attempt integer,
  p_next_retry_at timestamptz,
  p_failure_reason text,
  p_occurred_at timestamptz,
  p_failure_class text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  RETURN public.subscription_handle_payment_failure_dunning(p_idempotency_key, p_cycle_id, p_subscription_id, p_order_id, p_payment_intent_id, p_retry_attempt, p_next_retry_at, p_failure_reason, p_occurred_at, p_failure_class, NULL::uuid);
END;
$$;

CREATE OR REPLACE FUNCTION public.subscription_open_dunning_before_sub_lock(
  p_idempotency_key text,
  p_payment_intent_id uuid,
  p_provider_event_id text DEFAULT NULL,
  p_failure_reason text DEFAULT NULL,
  p_occurred_at timestamptz DEFAULT now(),
  p_failure_class text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  RETURN public.subscription_open_dunning_before_sub_lock(p_idempotency_key, p_payment_intent_id, p_provider_event_id, p_failure_reason, p_occurred_at, p_failure_class, NULL::uuid);
END;
$$;

CREATE OR REPLACE FUNCTION public.subscription_open_dunning_from_failed_payment_result(
  p_idempotency_key text,
  p_payment_intent_id uuid,
  p_provider_event_id text DEFAULT NULL,
  p_failure_reason text DEFAULT NULL,
  p_occurred_at timestamptz DEFAULT now(),
  p_failure_class text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  RETURN public.subscription_open_dunning_from_failed_payment_result(p_idempotency_key, p_payment_intent_id, p_provider_event_id, p_failure_reason, p_occurred_at, p_failure_class, NULL::uuid);
END;
$$;

CREATE OR REPLACE FUNCTION public.subscription_handle_payment_failure_dunning_before_cancel_fence(
  p_idempotency_key text,
  p_cycle_id uuid,
  p_subscription_id uuid,
  p_order_id uuid,
  p_payment_intent_id uuid,
  p_retry_attempt integer,
  p_next_retry_at timestamptz,
  p_failure_reason text,
  p_occurred_at timestamptz,
  p_failed_payment_attempt_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_failure_rung integer;
  v_failure_rung_count integer;
  v_scope constant text := 'subscription.dunning.failure';
  -- The first rung the ladder runs with nothing scheduled after it. The ladder
  -- itself lives in commerce_payment_control_apply_before_sub_lock and is not
  -- touched here; this constant is the boundary that body's CASE already draws.
  v_ladder_exhausted_from constant integer := 4;
  v_request_fingerprint text;
  v_legacy_request_fingerprint text;
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

  v_legacy_request_fingerprint := md5(
    p_cycle_id::text || '|' ||
    p_subscription_id::text || '|' ||
    p_order_id::text || '|' ||
    p_payment_intent_id::text || '|' ||
    p_retry_attempt::text || '|' ||
    COALESCE(p_next_retry_at::text, '') || '|' ||
    COALESCE(p_failure_reason, '') || '|' ||
    p_occurred_at::text
  );
  v_request_fingerprint := CASE WHEN p_failed_payment_attempt_id IS NULL
    THEN v_legacy_request_fingerprint
    ELSE md5(v_legacy_request_fingerprint || '|failedPaymentAttemptId=' || p_failed_payment_attempt_id::text) END;

  SELECT *
    INTO v_existing
    FROM public.commerce_idempotency_keys
   WHERE scope = v_scope
     AND idempotency_key = p_idempotency_key
   FOR UPDATE;

  IF FOUND THEN
    IF v_existing.status = 'completed'
      AND (v_existing.request_fingerprint = v_request_fingerprint OR (
        v_existing.request_fingerprint = v_legacy_request_fingerprint
        AND p_failed_payment_attempt_id IS NOT NULL
        AND v_existing.metadata ->> 'failedPaymentAttemptId' = p_failed_payment_attempt_id::text))
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

  -- The applied event is the attribution authority; the active attempt and
  -- incoming current-state snapshot cannot identify a delayed observation.
  SELECT min((event.payload ->> 'retryAttempt')::integer),
         count(DISTINCT event.payload ->> 'retryAttempt')
    INTO v_failure_rung, v_failure_rung_count
    FROM public.subscription_events event
    JOIN public.commerce_payment_attempts attempt
      ON attempt.id = p_failed_payment_attempt_id
     AND attempt.payment_intent_id = p_payment_intent_id
   WHERE event.subscription_id = p_subscription_id AND event.cycle_id = p_cycle_id
     AND event.event_type IN ('subscription.retry_scheduled', 'subscription.payment_failed')
     AND event.payload ->> 'source' = 'payment.control.v0'
     AND event.payload ->> 'paymentIntentId' = p_payment_intent_id::text
     AND event.payload ->> 'paymentAttemptId' = p_failed_payment_attempt_id::text
     AND event.payload ->> 'retryAttempt' ~ '^[1-9][0-9]{0,8}$';

  IF p_failed_payment_attempt_id IS NULL OR v_failure_rung_count <> 1 THEN
    RAISE EXCEPTION 'subscription_dunning_failed_attempt_unattributed' USING ERRCODE = '55000';
  END IF;

  SELECT * INTO v_case FROM public.subscription_dunning_cases
   WHERE cycle_id = p_cycle_id FOR UPDATE;
  IF FOUND THEN
    IF v_case.failed_payment_attempt_id IS NULL OR v_case.failure_observation_result IS NULL THEN
      RAISE EXCEPTION 'subscription_dunning_case_unattributed' USING ERRCODE = '55000';
    END IF;
    IF v_case.failed_payment_attempt_id = p_failed_payment_attempt_id
       OR v_failure_rung < v_case.retry_attempt THEN
      v_response := jsonb_set(v_case.failure_observation_result,
        '{subscriptionDunning,replayed}', 'true'::jsonb, false);
      INSERT INTO public.commerce_idempotency_keys
        (scope, idempotency_key, request_fingerprint, status, response_payload, metadata)
      VALUES (v_scope, p_idempotency_key, v_request_fingerprint, 'completed', v_response,
        jsonb_build_object('boundary', 'subscription_handle_payment_failure_dunning',
          'caseId', v_case.id, 'failedPaymentAttemptId', p_failed_payment_attempt_id,
          'canonicalFailedPaymentAttemptId', v_case.failed_payment_attempt_id,
          'observation', CASE WHEN v_failure_rung < v_case.retry_attempt THEN 'stale_replay' ELSE 'attempt_replay' END));
      RETURN v_response;
    END IF;
    -- Equal rung with different identities is conflicting durable evidence.
    IF v_failure_rung = v_case.retry_attempt THEN
      RAISE EXCEPTION 'subscription_dunning_failed_attempt_ambiguous' USING ERRCODE = '55000';
    END IF;
  END IF;

  IF v_failure_rung IS DISTINCT FROM p_retry_attempt THEN
    RAISE EXCEPTION 'subscription_dunning_failed_attempt_rung_mismatch' USING ERRCODE = '55000';
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
    jsonb_build_object('boundary', 'subscription_handle_payment_failure_dunning',
      'failedPaymentAttemptId', p_failed_payment_attempt_id, 'observation', 'fresh')
  );

  INSERT INTO public.subscription_dunning_cases (
    subscription_id,
    cycle_id,
    order_id,
    payment_intent_id,
    failed_payment_attempt_id,
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
    p_failed_payment_attempt_id,
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
        failed_payment_attempt_id = EXCLUDED.failed_payment_attempt_id,
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

  UPDATE public.subscription_dunning_cases
     SET failure_observation_result = v_response
   WHERE id = v_case.id;
  RETURN v_response;
END;
$$;

CREATE OR REPLACE FUNCTION public.subscription_handle_payment_failure_dunning(
  p_idempotency_key text,
  p_cycle_id uuid,
  p_subscription_id uuid,
  p_order_id uuid,
  p_payment_intent_id uuid,
  p_retry_attempt integer,
  p_next_retry_at timestamptz,
  p_failure_reason text,
  p_occurred_at timestamptz,
  p_failure_class text,
  p_failed_payment_attempt_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_subscription_status text;
  v_result jsonb;
BEGIN
  SELECT s.status
    INTO v_subscription_status
    FROM public.subscriptions s
   WHERE s.id = p_subscription_id
   FOR UPDATE;

  IF FOUND AND v_subscription_status = 'cancelled' THEN
    RAISE EXCEPTION 'subscription_dunning_subscription_cancelled'
      USING ERRCODE = '55000';
  END IF;

  v_result := public.subscription_handle_payment_failure_dunning_before_cancel_fence(
    p_idempotency_key,
    p_cycle_id,
    p_subscription_id,
    p_order_id,
    p_payment_intent_id,
    p_retry_attempt,
    p_next_retry_at,
    p_failure_reason,
    p_occurred_at,
    p_failed_payment_attempt_id
  );

  -- The inner receipt is authoritative on replay; do not restamp a case that
  -- may now carry a classification from a later failure.
  IF COALESCE((v_result #>> '{subscriptionDunning,replayed}')::boolean, false) THEN
    RETURN v_result;
  END IF;

  -- Fresh results retain the existing class stamp; NULL still stamps nothing.
  -- One case per cycle is guaranteed by the canonical body's UNIQUE (cycle_id).
  IF p_failure_class IS NOT NULL THEN
    UPDATE public.subscription_dunning_cases dunning_case
       SET failure_class = p_failure_class
     WHERE dunning_case.cycle_id = p_cycle_id;
  END IF;

  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.subscription_open_dunning_before_sub_lock(
  p_idempotency_key text,
  p_payment_intent_id uuid,
  p_provider_event_id text,
  p_failure_reason text,
  p_occurred_at timestamptz,
  p_failure_class text,
  p_failed_payment_attempt_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_intent public.commerce_payment_intents%ROWTYPE;
  v_order public.commerce_orders%ROWTYPE;
  v_cycle public.subscription_cycles%ROWTYPE;
  v_subscription public.subscriptions%ROWTYPE;
  v_response jsonb;
BEGIN
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' OR p_payment_intent_id IS NULL THEN
    RAISE EXCEPTION 'subscription_webhook_dunning_invalid_input' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_intent
    FROM public.commerce_payment_intents
   WHERE id = p_payment_intent_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'subscription_webhook_dunning_intent_not_found' USING ERRCODE = '22023';
  END IF;

  IF v_intent.subscription_id IS NULL OR v_intent.subscription_cycle_id IS NULL THEN
    RETURN jsonb_build_object('subscriptionWebhookDunning', jsonb_build_object('opened', false, 'replayed', false, 'reason', 'not_subscription_cycle'));
  END IF;

  SELECT * INTO v_order FROM public.commerce_orders WHERE id = v_intent.order_id FOR UPDATE;
  IF NOT FOUND OR v_order.subscription_id IS DISTINCT FROM v_intent.subscription_id THEN
    RAISE EXCEPTION 'subscription_webhook_dunning_order_mismatch' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_cycle FROM public.subscription_cycles WHERE id = v_intent.subscription_cycle_id FOR UPDATE;
  IF NOT FOUND OR v_cycle.subscription_id IS DISTINCT FROM v_intent.subscription_id THEN
    RAISE EXCEPTION 'subscription_webhook_dunning_cycle_mismatch' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_subscription FROM public.subscriptions WHERE id = v_intent.subscription_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'subscription_webhook_dunning_subscription_not_found' USING ERRCODE = '22023';
  END IF;

  IF v_subscription.status NOT IN ('active', 'paused')
    OR v_cycle.status NOT IN ('retry_scheduled', 'payment_failed')
    OR COALESCE(v_cycle.retry_attempt, 0) < 1
  THEN
    RETURN jsonb_build_object('subscriptionWebhookDunning', jsonb_build_object('opened', false, 'replayed', false, 'reason', 'not_dunning_eligible'));
  END IF;

  -- Carry the observed durable attempt through the existing locked handoff.
  v_response := public.subscription_handle_payment_failure_dunning(
    p_idempotency_key,
    v_cycle.id,
    v_subscription.id,
    v_order.id,
    v_intent.id,
    v_cycle.retry_attempt,
    CASE WHEN v_cycle.status = 'payment_failed' THEN NULL ELSE v_cycle.next_retry_at END,
    COALESCE(p_failure_reason, v_intent.failure_reason, 'provider_webhook_failed'),
    COALESCE(p_occurred_at, now()),
    p_failure_class,
    p_failed_payment_attempt_id
  );

  RETURN jsonb_build_object(
    'subscriptionWebhookDunning',
    jsonb_build_object(
      'opened', true,
      'replayed', COALESCE((v_response #>> '{subscriptionDunning,replayed}')::boolean, false),
      'caseId', v_response #>> '{subscriptionDunning,caseId}',
      'subscriptionId', v_subscription.id,
      'cycleId', v_cycle.id,
      'orderId', v_order.id,
      'paymentIntentId', v_intent.id,
      'retryAttempt', v_cycle.retry_attempt,
      'nextRetryAt', v_cycle.next_retry_at
    )
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.subscription_open_dunning_from_failed_payment_result(
  p_idempotency_key text,
  p_payment_intent_id uuid,
  p_provider_event_id text,
  p_failure_reason text,
  p_occurred_at timestamptz,
  p_failure_class text,
  p_failed_payment_attempt_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_intent_hint record;
  v_intent public.commerce_payment_intents%ROWTYPE;
  v_order public.commerce_orders%ROWTYPE;
  v_cycle public.subscription_cycles%ROWTYPE;
  v_subscription public.subscriptions%ROWTYPE;
BEGIN
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' OR p_payment_intent_id IS NULL THEN
    RETURN public.subscription_open_dunning_before_sub_lock(
      p_idempotency_key, p_payment_intent_id, p_provider_event_id,
      p_failure_reason, p_occurred_at, p_failure_class, p_failed_payment_attempt_id
    );
  END IF;

  SELECT payment_intent.subscription_id
    INTO v_intent_hint
    FROM public.commerce_payment_intents payment_intent
   WHERE payment_intent.id = p_payment_intent_id;

  IF NOT FOUND OR v_intent_hint.subscription_id IS NULL THEN
    RETURN public.subscription_open_dunning_before_sub_lock(
      p_idempotency_key, p_payment_intent_id, p_provider_event_id,
      p_failure_reason, p_occurred_at, p_failure_class, p_failed_payment_attempt_id
    );
  END IF;

  SELECT *
    INTO v_subscription
    FROM public.subscriptions subscription
   WHERE subscription.id = v_intent_hint.subscription_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'subscription_webhook_dunning_subscription_not_found'
      USING ERRCODE = '22023';
  END IF;

  SELECT *
    INTO v_intent
    FROM public.commerce_payment_intents payment_intent
   WHERE payment_intent.id = p_payment_intent_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'subscription_webhook_dunning_intent_not_found'
      USING ERRCODE = '22023';
  END IF;
  IF v_intent.subscription_id IS DISTINCT FROM v_subscription.id THEN
    RAISE EXCEPTION 'subscription_webhook_dunning_subscription_mismatch'
      USING ERRCODE = '22023';
  END IF;
  IF v_intent.subscription_cycle_id IS NULL THEN
    RETURN jsonb_build_object(
      'subscriptionWebhookDunning',
      jsonb_build_object('opened', false, 'replayed', false, 'reason', 'not_subscription_cycle')
    );
  END IF;

  SELECT *
    INTO v_order
    FROM public.commerce_orders order_row
   WHERE order_row.id = v_intent.order_id
   FOR UPDATE;
  IF NOT FOUND OR v_order.subscription_id IS DISTINCT FROM v_intent.subscription_id THEN
    RAISE EXCEPTION 'subscription_webhook_dunning_order_mismatch'
      USING ERRCODE = '22023';
  END IF;

  SELECT *
    INTO v_cycle
    FROM public.subscription_cycles cycle
   WHERE cycle.id = v_intent.subscription_cycle_id
   FOR UPDATE;
  IF NOT FOUND OR v_cycle.subscription_id IS DISTINCT FROM v_intent.subscription_id THEN
    RAISE EXCEPTION 'subscription_webhook_dunning_cycle_mismatch'
      USING ERRCODE = '22023';
  END IF;

  RETURN public.subscription_open_dunning_before_sub_lock(
    p_idempotency_key, p_payment_intent_id, p_provider_event_id,
    p_failure_reason, p_occurred_at, p_failure_class, p_failed_payment_attempt_id
  );
END;
$$;

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
  p_failure_class_decided_by text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_apply jsonb;
  v_payment_result jsonb;
  v_evidence jsonb;
  v_dunning jsonb;
  v_dunning_refusal text;
  v_existing_evidence public.commerce_payment_reconciliation_runs%ROWTYPE;
  v_has_existing_evidence boolean := false;
  v_evidence_key text;
  v_evidence_payload jsonb;
  v_kind text;
  v_correction_status text;
  v_applied boolean;
  v_apply_replayed boolean;
  v_evidence_replayed boolean := false;
  v_dunning_replayed boolean := false;
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

  -- Named notation, not positional: this RPC carried six parameters until
  -- 20260806120000 appended two more, and the class must land in the parameter
  -- that bears its name rather than in whatever slot counting happens to reach.
  v_apply := public.commerce_payment_control_apply_result(
    p_idempotency_key => p_idempotency_key,
    p_payment_intent_id => p_expected_payment_intent_id,
    p_payment_event_id => NULL,
    p_result_status => p_result_status,
    p_occurred_at => p_occurred_at,
    p_failure_reason => p_failure_reason,
    p_failure_class => p_failure_class,
    p_failure_class_decided_by => p_failure_class_decided_by
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
    FROM public.commerce_payment_reconciliation_runs
   WHERE idempotency_key = v_evidence_key
   FOR UPDATE;
  v_has_existing_evidence := FOUND;

  IF v_has_existing_evidence AND v_existing_evidence.payload ->> 'dunningObservationRefusal' IN (
    'subscription_dunning_failed_attempt_unattributed',
    'subscription_dunning_case_unattributed',
    'subscription_dunning_failed_attempt_ambiguous',
    'subscription_dunning_failed_attempt_rung_mismatch'
  ) THEN
    -- An exact key retains its recorded refusal even after case eligibility changes.
    -- The full evidence claim/payload comparison below still rejects key conflicts.
    v_dunning_refusal := v_existing_evidence.payload ->> 'dunningObservationRefusal';
    v_dunning := jsonb_build_object('subscriptionWebhookDunning',
      jsonb_build_object('opened', false, 'replayed', true,
        'reason', v_dunning_refusal,
        'failedPaymentAttemptId', p_expected_payment_attempt_id));
    v_dunning_replayed := true;
  ELSIF p_result_status = 'failed' AND v_kind NOT LIKE 'ignored%' THEN
    -- Reconciliation already checked this exact applied attempt above.
    -- Attribution refusal must preserve the already-applied payment truth.
    -- Only this handoff is a subtransaction; unrelated failures still abort.
    BEGIN
      v_dunning := public.subscription_open_dunning_from_failed_payment_result(
        p_idempotency_key || ':dunning',
        p_expected_payment_intent_id,
        NULL,
        p_failure_reason,
        p_occurred_at,
        p_failure_class,
        p_expected_payment_attempt_id
      );
    EXCEPTION WHEN SQLSTATE '55000' THEN
      IF SQLERRM NOT IN (
        'subscription_dunning_failed_attempt_unattributed',
        'subscription_dunning_case_unattributed',
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

REVOKE ALL ON FUNCTION public.subscription_handle_payment_failure_dunning_before_cancel_fence(text,uuid,uuid,uuid,uuid,integer,timestamptz,text,timestamptz,uuid) FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.subscription_open_dunning_before_sub_lock(text,uuid,text,text,timestamptz,text,uuid) FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.subscription_handle_payment_failure_dunning(text,uuid,uuid,uuid,uuid,integer,timestamptz,text,timestamptz,text,uuid) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.subscription_handle_payment_failure_dunning(text,uuid,uuid,uuid,uuid,integer,timestamptz,text,timestamptz,text,uuid) TO service_role;

REVOKE ALL ON FUNCTION public.subscription_open_dunning_from_failed_payment_result(text,uuid,text,text,timestamptz,text,uuid) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.subscription_open_dunning_from_failed_payment_result(text,uuid,text,text,timestamptz,text,uuid) TO service_role;
