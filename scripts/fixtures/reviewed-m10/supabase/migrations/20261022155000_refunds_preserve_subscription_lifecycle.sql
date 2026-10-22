-- Full refunds settle the order without cancelling the subscription or its paid cycle.
-- Preserve the existing first-cycle stock-reservation release and all other payment behavior.

CREATE OR REPLACE FUNCTION public.commerce_payment_control_apply_before_sub_lock(p_idempotency_key text, p_payment_intent_id uuid, p_payment_event_id uuid, p_result_status text, p_occurred_at timestamp with time zone, p_failure_reason text, p_failure_class text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_catalog'
    AS $$
DECLARE
  v_scope constant text := 'commerce.payment_result.apply';
  -- The classes for which this deployment publishes no ladder at all. FILLED by
  -- this migration, with one member. An issuer that answered hard_do_not_retry
  -- refused the INSTRUMENT, not this charge, so the three rungs below cannot
  -- change the answer -- they only spend eleven days telling the customer that
  -- another attempt is coming. Every other class keeps the full cadence:
  -- unlisted, unrecognised, and unclassified NULL alike. Its TypeScript twin is
  -- the terminatingFailureClasses of DEFAULT_CYCLE_RETRY_CADENCE in
  -- packages/core/src/subscription/cycleHardening.ts;
  -- scripts/retry-ladder-terminating-classes.test.ts reads this literal out of
  -- this file and fails if the two sets ever differ.
  v_terminating_classes constant text[] := '{hard_do_not_retry}';
  v_request_fingerprint text;
  v_legacy_request_fingerprint text;
  v_existing_failure_class text;
  v_existing public.commerce_idempotency_keys%ROWTYPE;
  v_intent public.commerce_payment_intents%ROWTYPE;
  v_attempt public.commerce_payment_attempts%ROWTYPE;
  v_event public.inbound_provider_events%ROWTYPE;
  v_order public.commerce_orders%ROWTYPE;
  v_cycle public.subscription_cycles%ROWTYPE;
  v_subscription public.subscriptions%ROWTYPE;
  v_next_cycle_at timestamptz;
  v_lateness_days integer;
  v_retry_attempt integer;
  v_next_retry_at timestamptz;
  v_cycle_status text;
  v_recoverable boolean := false;
  v_response jsonb;
  v_business_kind text := 'state_changed';
BEGIN
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' OR length(p_idempotency_key) < 8
    OR p_payment_intent_id IS NULL
    OR p_result_status NOT IN ('succeeded', 'failed', 'expired', 'refunded', 'partially_refunded', 'disputed')
    OR p_occurred_at IS NULL
  THEN
    RAISE EXCEPTION 'payment_control_result_invalid_input' USING ERRCODE = '22023';
  END IF;

  v_legacy_request_fingerprint := md5(
    p_payment_intent_id::text || '|' ||
    COALESCE(p_payment_event_id::text, '') || '|' ||
    p_result_status || '|' ||
    p_occurred_at::text || '|' ||
    COALESCE(p_failure_reason, '')
  );
  v_request_fingerprint := md5(
    p_payment_intent_id::text || '|' ||
    COALESCE(p_payment_event_id::text, '') || '|' ||
    p_result_status || '|' ||
    p_occurred_at::text || '|' ||
    COALESCE(p_failure_reason, '') ||
    CASE WHEN p_failure_class IS NULL THEN '' ELSE '|failure_class=' || p_failure_class END
  );

  SELECT *
    INTO v_existing
    FROM public.commerce_idempotency_keys
   WHERE scope = v_scope
     AND idempotency_key = p_idempotency_key
   FOR UPDATE;

  IF FOUND THEN
    IF v_existing.status = 'completed' AND v_existing.response_payload IS NOT NULL THEN
      IF v_existing.request_fingerprint = v_request_fingerprint THEN
        RETURN jsonb_set(v_existing.response_payload, '{paymentResult,replayed}', 'true'::jsonb, false);
      END IF;

      -- From 20260806120000 until this migration, the wrapper persisted a
      -- non-NULL failure_class on the attempt but the delegated six-argument
      -- body fingerprinted no class. Admit that exact historical replay only
      -- when the old fingerprint and the durable attempt class both match.
      -- New decisions never enter this branch because their stored fingerprint
      -- includes the class suffix; a different class therefore still conflicts.
      IF p_failure_class IS NOT NULL
        AND v_existing.request_fingerprint = v_legacy_request_fingerprint
      THEN
        SELECT attempt.failure_class
          INTO v_existing_failure_class
          FROM public.commerce_payment_attempts attempt
         WHERE attempt.id = NULLIF(v_existing.metadata ->> 'paymentAttemptId', '')::uuid;
        IF FOUND AND v_existing_failure_class IS NOT DISTINCT FROM p_failure_class THEN
          RETURN jsonb_set(v_existing.response_payload, '{paymentResult,replayed}', 'true'::jsonb, false);
        END IF;
      END IF;
    END IF;

    RAISE EXCEPTION 'payment_control_result_idempotency_conflict' USING ERRCODE = '23505';
  END IF;

  SELECT *
    INTO v_intent
    FROM public.commerce_payment_intents
   WHERE id = p_payment_intent_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'payment_control_result_intent_not_found' USING ERRCODE = '22023';
  END IF;

  SELECT *
    INTO v_attempt
    FROM public.commerce_payment_attempts
   WHERE id = v_intent.active_attempt_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'payment_control_result_active_attempt_not_found' USING ERRCODE = '22023';
  END IF;

  IF p_payment_event_id IS NOT NULL THEN
    SELECT *
      INTO v_event
      FROM public.inbound_provider_events
     WHERE id = p_payment_event_id
     FOR UPDATE;
    IF NOT FOUND OR v_event.payment_intent_id IS DISTINCT FROM v_intent.id THEN
      RAISE EXCEPTION 'payment_control_result_event_mismatch' USING ERRCODE = '22023';
    END IF;
    -- The event names its own attempt, and that name wins. `ingest_event`
    -- correlated this row to an attempt by `(provider, provider_attempt_id)`,
    -- so a populated `payment_attempt_id` is the provider's own statement of
    -- which charge this verdict describes. `active_attempt_id` is only the
    -- LATEST charge on the intent, and a delivery that is merely slow is enough
    -- to make the two disagree: attempt one's refusal or capture arriving after
    -- attempt two was recorded would otherwise settle attempt two, silently and
    -- with no anomaly anywhere. A NULL means the correlation found nothing, and
    -- that is left exactly as permissive as it was -- this guard only refuses a
    -- statement the event actually made.
    IF v_event.payment_attempt_id IS NOT NULL
      AND v_event.payment_attempt_id IS DISTINCT FROM v_intent.active_attempt_id
    THEN
      RAISE EXCEPTION 'payment_control_result_attempt_mismatch' USING ERRCODE = '22023';
    END IF;
    -- A provider amount of 0 (or NULL) means "amount not asserted" — most often a
    -- declined/canceled PaymentIntent whose `amount_received` is 0 — and must NOT
    -- be read as a mismatch against the order total, or terminal failures can
    -- never reconcile. Only a POSITIVE provider amount is held to parity.
    IF v_event.amount_cents IS NOT NULL AND v_event.amount_cents > 0
      AND p_result_status NOT IN ('refunded', 'partially_refunded')
      AND v_event.amount_cents <> v_intent.amount_cents
    THEN
      RAISE EXCEPTION 'payment_control_result_amount_mismatch' USING ERRCODE = '22023';
    END IF;
    IF v_event.currency IS NOT NULL AND v_event.currency <> v_intent.currency THEN
      RAISE EXCEPTION 'payment_control_result_currency_mismatch' USING ERRCODE = '22023';
    END IF;
  END IF;

  SELECT *
    INTO v_order
    FROM public.commerce_orders
   WHERE id = v_intent.order_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'payment_control_result_order_not_found' USING ERRCODE = '22023';
  END IF;

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
    jsonb_build_object('boundary', 'commerce_payment_control_apply_result')
  );

  IF p_result_status = 'succeeded' THEN
    IF v_intent.status IN ('cancelled', 'refunded', 'partially_refunded', 'disputed') THEN
      RAISE EXCEPTION 'payment_control_result_terminal_intent' USING ERRCODE = '22023';
    END IF;

    UPDATE public.commerce_payment_intents
       SET status = 'succeeded',
           provider_payment_id = COALESCE(v_event.provider_payment_id, provider_payment_id),
           failure_reason = NULL,
           updated_at = now()
     WHERE id = v_intent.id;

    UPDATE public.commerce_payment_attempts
       SET status = 'succeeded',
           failure_reason = NULL,
           updated_at = now()
     WHERE id = v_attempt.id;

    UPDATE public.commerce_payments
       SET status = 'succeeded',
           provider_payment_id = COALESCE(v_event.provider_payment_id, provider_payment_id),
           metadata = metadata || jsonb_build_object('paymentStatus', 'succeeded', 'source', 'payment.control.v0'),
           updated_at = now()
     WHERE id = v_intent.payment_id;

    UPDATE public.commerce_orders
       SET status = 'paid',
           metadata = metadata || jsonb_build_object('paymentStatus', 'succeeded', 'paidAt', p_occurred_at, 'source', 'payment.control.v0'),
           updated_at = now()
     WHERE id = v_order.id;

    IF v_order.mode = 'subscription_cycle' THEN
      SELECT *
        INTO v_cycle
        FROM public.subscription_cycles
       WHERE id = v_order.subscription_cycle_id
       FOR UPDATE;
      SELECT *
        INTO v_subscription
        FROM public.subscriptions
       WHERE id = v_order.subscription_id
       FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'payment_control_result_subscription_not_found' USING ERRCODE = '22023';
      END IF;

      -- Whole days of PAYMENT LATENESS, then one cadence, then clamped so the anchor can
      -- only ever move later. See this migration's header for why each clamp is here.
      v_lateness_days := GREATEST(0, floor(extract(epoch FROM
        (LEAST(p_occurred_at, now()) - v_cycle.scheduled_at)) / 86400.0)::int);
      v_next_cycle_at := GREATEST(
        v_subscription.next_cycle_at,
        v_cycle.scheduled_at + make_interval(days => v_lateness_days + v_subscription.cadence_days)
      );

      UPDATE public.subscription_cycles
         SET status = 'paid',
             paid_at = p_occurred_at,
             payment_id = v_intent.payment_id,
             next_retry_at = NULL,
             failure_reason = NULL,
             updated_at = now()
       WHERE id = v_cycle.id;

      UPDATE public.subscriptions
         SET next_cycle_at = v_next_cycle_at,
             updated_at = now()
       WHERE id = v_subscription.id;

      -- CJ01-P follow-up: a declined renewal cycle can recover via the renewal CRON
      -- retry path (card re-bound, next cron pass charges it) rather than the customer
      -- redeem path. That success lands here; close any OPEN dunning case for the cycle
      -- at the payment terminal — the single source of truth — so it does not linger
      -- `open` with a stale `next_retry_at`. Only 'open' cases transition ('expired' is
      -- terminal, owned by the customer resume flow). Idempotent: a replayed succeeded
      -- apply finds the case already 'recovered' and no-ops.
      UPDATE public.subscription_dunning_cases
         SET status = 'recovered',
             recovered_at = p_occurred_at,
             next_retry_at = NULL,
             last_event_at = p_occurred_at,
             updated_at = now(),
             metadata = metadata || jsonb_build_object(
               'recoveredVia', 'payment.control.apply_result',
               'recoveredPaymentIntentId', v_intent.id
             )
       WHERE cycle_id = v_cycle.id
         AND status = 'open';

      -- The dispatch claim (subscription_dunning_claim_batch) filters only on the
      -- notification's own status + scheduled_at and does NOT join case/cycle status,
      -- so a still-queued or in-flight `payment_failed` notification would be delivered
      -- for the now-paid cycle. Skip it so no spurious decline email is sent post-recovery.
      UPDATE public.subscription_dunning_notifications
         SET status = 'skipped',
             provider_error = COALESCE(provider_error, 'cycle_recovered'),
             updated_at = now()
       WHERE cycle_id = v_cycle.id
         AND status IN ('queued', 'sending');

      INSERT INTO public.subscription_events (
        subscription_id,
        cycle_id,
        event_type,
        idempotency_key,
        payload,
        occurred_at
      )
      VALUES (
        v_subscription.id,
        v_cycle.id,
        'subscription.cycle_paid',
        p_idempotency_key || ':subscription_event',
        jsonb_build_object(
          'paymentIntentId', v_intent.id,
          'paymentAttemptId', v_attempt.id,
          'paymentId', v_intent.payment_id,
          'orderId', v_order.id,
          'nextCycleAt', v_next_cycle_at,
          'basedOnScheduledAt', v_cycle.scheduled_at,
          'basedOnPaidAt', p_occurred_at,
          'shiftedByDays', v_lateness_days,
          'source', 'payment.control.v0'
        ),
        p_occurred_at
      )
      ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING;
    END IF;
  ELSIF p_result_status IN ('failed', 'expired') THEN
    IF v_intent.status IN ('succeeded', 'refunded', 'partially_refunded', 'disputed') THEN
      v_business_kind := 'ignored_failure_after_success_or_terminal';
    ELSIF v_intent.status = p_result_status
      AND v_attempt.status = p_result_status
    THEN
      -- Duplicate terminal failure. The intent AND its still-active attempt
      -- already sit at this status, which means nothing has been attempted since
      -- it was recorded: every legitimate ladder step records a FRESH attempt
      -- (that is what stamps active_attempt_id) before applying, so a real retry
      -- can never reach this branch. What does reach it is a second delivery of
      -- the same terminal signal under a different key. Applying it again would
      -- bump retry_attempt a second time for one decline, recompute
      -- next_retry_at off the later instant, and advance the customer's dunning
      -- ladder for an event that already happened. Absorb it exactly the way an
      -- after-success failure is absorbed above: no cycle, dunning, order or
      -- reservation mutation, an 'ignored' stamp on the inbound event, and a
      -- duplicate-marked response the caller can distinguish from a state change.
      --
      -- Deliberately NOT also requiring the failure REASON to match. The whole
      -- point is the cross-writer duplicate, and the writers disagree about
      -- wording for one identical provider event: the renewal cron records its
      -- own classification, the payment webhook applies a generic failed reason,
      -- and reconciliation writes a third. Keying on the reason would let every
      -- real duplicate through and absorb only the case that barely happens.
      -- Status equality is the honest predicate, and it is exactly as safe: a
      -- genuine escalation carries a DIFFERENT status (expired after failed) and
      -- still falls through to be applied.
      v_business_kind := 'ignored_duplicate_terminal_failure';
    ELSE
      -- The provider attempt itself is over either way — record it truthfully on
      -- the attempt, intent, and payment. Whether the ORDER terminalizes is decided
      -- separately below (recoverable decline vs. terminal expiry/renewal-dunning).
      UPDATE public.commerce_payment_intents
         SET status = p_result_status,
             failure_reason = COALESCE(p_failure_reason, p_result_status),
             updated_at = now()
       WHERE id = v_intent.id;

      UPDATE public.commerce_payment_attempts
         SET status = p_result_status,
             failure_reason = COALESCE(p_failure_reason, p_result_status),
             updated_at = now()
       WHERE id = v_attempt.id;

      UPDATE public.commerce_payments
         SET status = CASE WHEN p_result_status = 'expired' THEN 'expired' ELSE 'failed' END,
             metadata = metadata || jsonb_build_object(
               'paymentStatus', p_result_status,
               'failureReason', COALESCE(p_failure_reason, p_result_status),
               'source', 'payment.control.v0'
             ),
             updated_at = now()
       WHERE id = v_intent.payment_id;

      -- Load subscription context up front; recoverability classification needs it,
      -- and both the recoverable and terminal subscription branches reuse it.
      IF v_order.mode = 'subscription_cycle' THEN
        SELECT *
          INTO v_cycle
          FROM public.subscription_cycles
         WHERE id = v_order.subscription_cycle_id
         FOR UPDATE;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'payment_control_result_cycle_not_found' USING ERRCODE = '22023';
        END IF;

        SELECT *
          INTO v_subscription
          FROM public.subscriptions
         WHERE id = v_order.subscription_id
         FOR UPDATE;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'payment_control_result_subscription_not_found' USING ERRCODE = '22023';
        END IF;
      END IF;

      -- A declined ('failed') INTERACTIVE attempt is recoverable: a one-time order,
      -- or a subscription activation while still provisional. Window 'expired' never
      -- is, and active renewals (subscription already past pending_activation) keep
      -- their dunning path. plpgsql short-circuits the OR, so v_subscription is
      -- only read when the order is a subscription_cycle (where it was loaded above).
      v_recoverable := (
        p_result_status = 'failed'
        AND (
          v_order.mode <> 'subscription_cycle'
          OR v_subscription.status = 'pending_activation'
        )
      );

      IF v_recoverable THEN
        -- Keep the order RE-PAYABLE: status stays pending_payment, the checkout
        -- inventory hold is RETAINED, and (for subscriptions) the provisional stays
        -- pending_activation with its activation cycle re-attemptable. No terminal
        -- transition, no reservation release, and no subscription_events row — there
        -- must be no "activation failed" notification for a retryable decline.
        UPDATE public.commerce_orders
           SET metadata = metadata || jsonb_build_object(
                 'paymentStatus', 'declined',
                 'failureReason', COALESCE(p_failure_reason, p_result_status),
                 'lastDeclineAt', p_occurred_at,
                 'recoverable', true,
                 'source', 'payment.control.v0'
               ),
               updated_at = now()
         WHERE id = v_order.id;

        IF v_order.mode = 'subscription_cycle' THEN
          UPDATE public.subscription_cycles
             SET retry_attempt = v_cycle.retry_attempt + 1,
                 next_retry_at = NULL,
                 failure_reason = COALESCE(p_failure_reason, p_result_status),
                 updated_at = now()
           WHERE id = v_cycle.id;
        ELSE
          -- One-time order: the pre-20260709120000 trigger used to fire here (the
          -- order transitioned straight to 'failed'). It structurally cannot fire
          -- any more since the order stays pending_payment, so emit the same
          -- commerce.payment.failed event/idempotency-key inline instead — the
          -- customer still gets the "retry your payment" nudge immediately, and a
          -- later genuine expiry replays harmlessly onto the same key.
          INSERT INTO public.outbox_events (
            aggregate_type,
            aggregate_id,
            event_type,
            idempotency_key,
            payload,
            metadata
          )
          VALUES (
            'commerce_order',
            v_order.id,
            'commerce.payment.failed',
            'payment_failed:' || v_order.id::text,
            jsonb_build_object(
              'orderId', 'order_' || v_order.id::text,
              'orderUuid', v_order.id,
              'totalCents', v_order.total_cents,
              'currency', v_order.currency,
              'occurredAt', p_occurred_at
            ),
            jsonb_build_object('source', 'commerce_payment_control_apply_result_recoverable_decline')
          )
          ON CONFLICT (event_type, idempotency_key) DO NOTHING;
        END IF;

        v_business_kind := 'recoverable_decline';
      ELSIF v_order.mode = 'subscription_cycle' THEN
        IF v_subscription.status = 'pending_activation' THEN
          -- A2 (terminal): an EXPIRED first charge. The provisional subscription
          -- never activated, so there is nothing to renew. Fail the order, release
          -- the checkout inventory hold, terminalize the provisional, and emit NO
          -- dunning/retry (the active-renewal branch below is left untouched).
          UPDATE public.subscription_cycles
             SET status = 'payment_failed',
                 retry_attempt = v_cycle.retry_attempt + 1,
                 next_retry_at = NULL,
                 failure_reason = COALESCE(p_failure_reason, p_result_status),
                 updated_at = now()
           WHERE id = v_cycle.id;

          UPDATE public.subscriptions
             SET status = 'activation_failed',
                 updated_at = now()
           WHERE id = v_subscription.id;

          UPDATE public.commerce_orders
             SET status = p_result_status,
                 metadata = metadata || jsonb_build_object(
                   'paymentStatus', p_result_status,
                   'failureReason', COALESCE(p_failure_reason, p_result_status),
                   'subscriptionActivation', 'activation_failed',
                   'source', 'payment.control.v0'
                 ),
                 updated_at = now()
           WHERE id = v_order.id;

          PERFORM public.commerce_release_order_reservations(v_order.id, 'subscription_activation_failed');

          INSERT INTO public.subscription_events (
            subscription_id,
            cycle_id,
            event_type,
            idempotency_key,
            payload,
            occurred_at
          )
          VALUES (
            v_subscription.id,
            v_cycle.id,
            'subscription.activation_failed',
            p_idempotency_key || ':subscription_event',
            jsonb_build_object(
              'paymentIntentId', v_intent.id,
              'paymentAttemptId', v_attempt.id,
              'paymentId', v_intent.payment_id,
              'orderId', v_order.id,
              'failureReason', COALESCE(p_failure_reason, p_result_status),
              'source', 'payment.control.v0'
            ),
            p_occurred_at
          )
          ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING;
        ELSE
          -- Active renewal (cycle #2+): the dunning/retry ladder. A refusal whose
          -- class this deployment lists as terminating is given no next charge at
          -- all; every other refusal - an unlisted class, an unrecognised one, and
          -- an unclassified NULL alike - walks exactly the rungs it walked before.
          -- The guard fails OPEN by construction: only an explicit membership can
          -- shorten the ladder, so no absent or unknown class can silently do it.
          v_retry_attempt := v_cycle.retry_attempt + 1;
          v_next_retry_at := CASE
            WHEN p_failure_class IS NOT NULL
              AND p_failure_class = ANY (v_terminating_classes) THEN NULL
            WHEN v_retry_attempt = 1 THEN p_occurred_at + interval '24 hours'
            WHEN v_retry_attempt = 2 THEN p_occurred_at + interval '72 hours'
            WHEN v_retry_attempt = 3 THEN p_occurred_at + interval '168 hours'
            ELSE NULL
          END;
          v_cycle_status := CASE WHEN v_next_retry_at IS NULL THEN 'payment_failed' ELSE 'retry_scheduled' END;

          UPDATE public.subscription_cycles
             SET status = v_cycle_status,
                 retry_attempt = v_retry_attempt,
                 next_retry_at = v_next_retry_at,
                 failure_reason = COALESCE(p_failure_reason, p_result_status),
                 updated_at = now()
           WHERE id = v_cycle.id;

          INSERT INTO public.subscription_events (
            subscription_id,
            cycle_id,
            event_type,
            idempotency_key,
            payload,
            occurred_at
          )
          VALUES (
            v_cycle.subscription_id,
            v_cycle.id,
            CASE WHEN v_next_retry_at IS NULL THEN 'subscription.payment_failed' ELSE 'subscription.retry_scheduled' END,
            p_idempotency_key || ':subscription_event',
            jsonb_build_object(
              'paymentIntentId', v_intent.id,
              'paymentAttemptId', v_attempt.id,
              'paymentId', v_intent.payment_id,
              'failureReason', COALESCE(p_failure_reason, p_result_status),
              'retryAttempt', v_retry_attempt,
              'nextRetryAt', v_next_retry_at,
              'source', 'payment.control.v0'
            ),
            p_occurred_at
          )
          ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING;
        END IF;
      ELSE
        -- One-time terminal (EXPIRED session). Fail the order and release the
        -- checkout inventory hold inline so stock is not stranded until the expiry
        -- sweep. Idempotent — replays and redeliveries no-op once rows leave
        -- 'reserved'. (A declined one-time order took the recoverable branch above.)
        UPDATE public.commerce_orders
           SET status = p_result_status,
               metadata = metadata || jsonb_build_object(
                 'paymentStatus', p_result_status,
                 'failureReason', COALESCE(p_failure_reason, p_result_status),
                 'source', 'payment.control.v0'
               ),
               updated_at = now()
         WHERE id = v_order.id;

        PERFORM public.commerce_release_order_reservations(v_order.id, 'payment_' || p_result_status);
      END IF;
    END IF;
  ELSIF p_result_status IN ('refunded', 'partially_refunded', 'disputed') THEN
    IF v_intent.status NOT IN ('succeeded', 'partially_refunded', 'refunded', 'disputed') THEN
      RAISE EXCEPTION 'payment_control_result_refund_or_dispute_requires_success' USING ERRCODE = '22023';
    END IF;

    UPDATE public.commerce_payment_intents
       SET status = p_result_status,
           updated_at = now()
     WHERE id = v_intent.id;

    UPDATE public.commerce_payments
       SET status = p_result_status,
           metadata = metadata || jsonb_build_object('paymentStatus', p_result_status, 'source', 'payment.control.v0'),
           updated_at = now()
     WHERE id = v_intent.payment_id;

    IF p_result_status = 'refunded' THEN
      UPDATE public.commerce_orders
         SET status = 'refunded',
             metadata = metadata || jsonb_build_object('paymentStatus', 'refunded', 'source', 'payment.control.v0'),
             updated_at = now()
       WHERE id = v_order.id;

      -- A first-cycle full refund releases its existing stock hold independently
      -- of subscription lifecycle and paid-cycle history.
      IF v_order.mode = 'subscription_cycle'
         AND v_order.subscription_cycle_id IS NOT NULL
         AND v_order.subscription_id IS NOT NULL THEN
        SELECT *
          INTO v_cycle
          FROM public.subscription_cycles
         WHERE id = v_order.subscription_cycle_id
         FOR UPDATE;
        SELECT *
          INTO v_subscription
          FROM public.subscriptions
         WHERE id = v_order.subscription_id
         FOR UPDATE;

        IF v_cycle.cycle_number = 1 AND v_subscription.status IN ('active', 'pending_activation') THEN
          PERFORM public.commerce_release_order_reservations(v_order.id, 'subscription_activation_refunded');
        END IF;
      END IF;
    END IF;
  END IF;

  IF p_payment_event_id IS NOT NULL THEN
    UPDATE public.inbound_provider_events
       SET processed_at = now(),
           processing_status = CASE WHEN v_business_kind LIKE 'ignored%' THEN 'ignored' ELSE 'processed' END
     WHERE id = p_payment_event_id;
  END IF;

  INSERT INTO public.commerce_payment_state_transitions (
    payment_intent_id,
    payment_attempt_id,
    provider_event_id,
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
    p_payment_event_id,
    CASE
      WHEN p_result_status IN ('refunded', 'partially_refunded') THEN 'refund'
      WHEN p_result_status = 'disputed' THEN 'dispute'
      ELSE 'business_result'
    END,
    v_intent.status,
    p_result_status,
    v_business_kind,
    p_idempotency_key || ':payment_result',
    p_occurred_at,
    jsonb_build_object('orderId', v_order.id, 'resultStatus', p_result_status, 'source', 'payment.control.v0')
  );

  v_response := jsonb_build_object(
    'contractVersion', 'commerce.v0',
    'paymentResult', jsonb_build_object(
      'paymentIntentId', v_intent.id,
      'paymentAttemptId', v_attempt.id,
      'paymentId', v_intent.payment_id,
      'orderId', v_order.id,
      'status', p_result_status,
      'kind', v_business_kind,
      'idempotencyKey', p_idempotency_key,
      'replayed', false
    )
  );

  UPDATE public.commerce_idempotency_keys
     SET status = 'completed',
         response_payload = v_response,
         metadata = metadata || jsonb_build_object('paymentIntentId', v_intent.id, 'paymentAttemptId', v_attempt.id)
   WHERE scope = v_scope
     AND idempotency_key = p_idempotency_key;

  RETURN v_response;
END;
$$;
