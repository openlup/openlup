-- Portable checkout-recovery tail: bounded abandoned/recovery reminder
-- intents, send-time authorization and terminal outbox compaction.
--
-- This forward is authored against the public platform tables. It does not copy
-- the private checkout saga, email-delivery ledger, provider attempt model or
-- deployment-identity guard. The public runtime already owns order drafts,
-- settlement truth, customer communication consent and the outbox state
-- machine; this delta only composes those neutral facts. Expired replacement
-- stays managed-only because the public order rail does not own the address,
-- reservation or provider-authoritative payment facts needed to recreate it.
--
-- All functions are invoker-rights and fully qualify durable objects. The
-- node-postgres capability lane runs as the database owner; no browser role,
-- service role, SECURITY DEFINER routine or table grant is introduced.

-- squawk-ignore require-concurrent-index-creation
CREATE INDEX commerce_orders_pending_recovery_scan
  ON public.commerce_orders (created_at, id)
  WHERE status = 'pending_payment' AND client_id IS NOT NULL;

-- squawk-ignore require-concurrent-index-creation
CREATE INDEX outbox_events_terminal_retention_scan
  ON public.outbox_events (status, processed_at, created_at, id)
  WHERE status IN ('processed', 'discarded');

CREATE FUNCTION public.commerce_enqueue_abandoned_cart_reminders(p_limit integer DEFAULT 200)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 200), 1), 1000);
  v_1h integer := 0;
  v_24h integer := 0;
  v_72h integer := 0;
BEGIN
  WITH candidates AS (
    SELECT order_row.id, order_row.created_at
      FROM public.commerce_orders AS order_row
      JOIN public.clients AS client ON client.id = order_row.client_id
      JOIN public.customer_communication_preferences AS preference
        ON preference.principal_id = client.principal_id
       AND preference.marketing_newsletter_consent
     WHERE order_row.status = 'pending_payment'
       AND order_row.subscription_cycle_id IS NULL
       AND EXISTS (
         SELECT 1 FROM public.commerce_order_draft_receipts receipt
          WHERE receipt.order_id = order_row.id AND receipt.invalidated_at IS NULL
       )
       AND order_row.created_at < now() - interval '1 hour'
       AND order_row.created_at >= now() - interval '24 hours'
       AND NOT EXISTS (SELECT 1 FROM public.commerce_settlement_intents intent WHERE intent.order_id = order_row.id)
     ORDER BY order_row.created_at, order_row.id LIMIT v_limit
  ), inserted AS (
    INSERT INTO public.outbox_events
      (aggregate_type, aggregate_id, event_type, idempotency_key, payload, metadata)
    SELECT 'commerce_order', candidate.id, 'commerce.order_draft.abandoned.1h',
      'abandoned_1h:' || candidate.id,
      jsonb_build_object(
        'orderId', 'order_' || candidate.id,
        'orderUuid', candidate.id,
        'reminderHours', 1,
        'createdAt', candidate.created_at
      ),
      jsonb_build_object('source', 'checkout_recovery_lifecycle')
    FROM candidates AS candidate
    ON CONFLICT (event_type, idempotency_key) DO NOTHING RETURNING 1
  ) SELECT count(*)::integer INTO v_1h FROM inserted;

  WITH candidates AS (
    SELECT order_row.id, order_row.created_at
      FROM public.commerce_orders AS order_row
      JOIN public.clients AS client ON client.id = order_row.client_id
      JOIN public.customer_communication_preferences AS preference
        ON preference.principal_id = client.principal_id
       AND preference.marketing_newsletter_consent
     WHERE order_row.status = 'pending_payment'
       AND order_row.subscription_cycle_id IS NULL
       AND EXISTS (
         SELECT 1 FROM public.commerce_order_draft_receipts receipt
          WHERE receipt.order_id = order_row.id AND receipt.invalidated_at IS NULL
       )
       AND order_row.created_at < now() - interval '24 hours'
       AND order_row.created_at >= now() - interval '72 hours'
       AND NOT EXISTS (SELECT 1 FROM public.commerce_settlement_intents intent WHERE intent.order_id = order_row.id)
     ORDER BY order_row.created_at, order_row.id LIMIT v_limit
  ), inserted AS (
    INSERT INTO public.outbox_events
      (aggregate_type, aggregate_id, event_type, idempotency_key, payload, metadata)
    SELECT 'commerce_order', candidate.id, 'commerce.order_draft.abandoned.24h',
      'abandoned_24h:' || candidate.id,
      jsonb_build_object(
        'orderId', 'order_' || candidate.id,
        'orderUuid', candidate.id,
        'reminderHours', 24,
        'createdAt', candidate.created_at
      ),
      jsonb_build_object('source', 'checkout_recovery_lifecycle')
    FROM candidates AS candidate
    ON CONFLICT (event_type, idempotency_key) DO NOTHING RETURNING 1
  ) SELECT count(*)::integer INTO v_24h FROM inserted;

  WITH candidates AS (
    SELECT order_row.id, order_row.created_at
      FROM public.commerce_orders AS order_row
      JOIN public.clients AS client ON client.id = order_row.client_id
      JOIN public.customer_communication_preferences AS preference
        ON preference.principal_id = client.principal_id
       AND preference.marketing_newsletter_consent
     WHERE order_row.status = 'pending_payment'
       AND order_row.subscription_cycle_id IS NULL
       AND EXISTS (
         SELECT 1 FROM public.commerce_order_draft_receipts receipt
          WHERE receipt.order_id = order_row.id AND receipt.invalidated_at IS NULL
       )
       AND order_row.created_at < now() - interval '72 hours'
       AND NOT EXISTS (SELECT 1 FROM public.commerce_settlement_intents intent WHERE intent.order_id = order_row.id)
       AND EXISTS (
         SELECT 1 FROM public.outbox_events prior
          WHERE prior.aggregate_id = order_row.id
            AND prior.event_type = 'commerce.order_draft.abandoned.24h'
            AND prior.status = 'processed'
       )
     ORDER BY order_row.created_at, order_row.id LIMIT v_limit
  ), inserted AS (
    INSERT INTO public.outbox_events
      (aggregate_type, aggregate_id, event_type, idempotency_key, payload, metadata)
    SELECT 'commerce_order', candidate.id, 'commerce.order_draft.abandoned.72h',
      'abandoned_72h:' || candidate.id,
      jsonb_build_object(
        'orderId', 'order_' || candidate.id,
        'orderUuid', candidate.id,
        'reminderHours', 72,
        'createdAt', candidate.created_at
      ),
      jsonb_build_object('source', 'checkout_recovery_lifecycle')
    FROM candidates AS candidate
    ON CONFLICT (event_type, idempotency_key) DO NOTHING RETURNING 1
  ) SELECT count(*)::integer INTO v_72h FROM inserted;

  RETURN jsonb_build_object('enqueued_1h', v_1h, 'enqueued_24h', v_24h, 'enqueued_72h', v_72h);
END;
$$;

CREATE FUNCTION public.commerce_enqueue_checkout_recovery_reminders(p_limit integer DEFAULT 200)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 200), 1), 1000);
  v_1h integer := 0;
  v_20h integer := 0;
  v_candidate record;
  v_event_id uuid;
BEGIN
  FOR v_candidate IN
    SELECT order_row.id, order_row.client_id, order_row.created_at,
      order_row.subscription_cycle_id
      FROM public.commerce_orders AS order_row
      JOIN public.commerce_settlement_intents AS intent ON intent.order_id = order_row.id
     WHERE order_row.status = 'pending_payment' AND order_row.client_id IS NOT NULL
       AND order_row.subscription_cycle_id IS NULL
       AND intent.status = 'failed'
       AND order_row.created_at < now() - interval '1 hour'
       AND order_row.created_at > now() - interval '24 hours'
     ORDER BY order_row.created_at, order_row.id LIMIT v_limit
  LOOP
    v_event_id := NULL;
    INSERT INTO public.outbox_events
      (aggregate_type, aggregate_id, event_type, idempotency_key, payload, metadata)
    VALUES (
      'commerce_order', v_candidate.id, 'commerce.checkout_recovery',
      'checkout_recovery:1h:' || v_candidate.id,
      jsonb_build_object(
        'orderId', v_candidate.id,
        'mode', CASE WHEN v_candidate.subscription_cycle_id IS NULL THEN 'one_time' ELSE 'subscription_cycle' END,
        'reminderHours', 1,
        'expiresAt', v_candidate.created_at + interval '24 hours'
      ),
      jsonb_build_object('source', 'checkout_recovery_lifecycle')
    )
    ON CONFLICT (event_type, idempotency_key) DO NOTHING
    RETURNING id INTO v_event_id;
    IF v_event_id IS NULL THEN CONTINUE; END IF;

    v_1h := v_1h + 1;
  END LOOP;

  FOR v_candidate IN
    SELECT order_row.id, order_row.client_id, order_row.created_at,
      order_row.subscription_cycle_id
      FROM public.commerce_orders AS order_row
      JOIN public.commerce_settlement_intents AS intent ON intent.order_id = order_row.id
     WHERE order_row.status = 'pending_payment' AND order_row.client_id IS NOT NULL
       AND order_row.subscription_cycle_id IS NULL
       AND intent.status = 'failed'
       AND order_row.created_at < now() - interval '20 hours'
       AND order_row.created_at > now() - interval '24 hours'
       AND EXISTS (
         SELECT 1 FROM public.outbox_events prior
          WHERE prior.aggregate_id = order_row.id
            AND prior.event_type = 'commerce.checkout_recovery'
            AND prior.idempotency_key = 'checkout_recovery:1h:' || order_row.id
            AND prior.status = 'processed'
            AND EXISTS (
              SELECT 1 FROM public.transactional_delivery_receipts receipt
               WHERE receipt.idempotency_key = 'checkout-reminder:' || prior.id
                 AND receipt.state = 'accepted'
            )
       )
     ORDER BY order_row.created_at, order_row.id LIMIT v_limit
  LOOP
    v_event_id := NULL;
    INSERT INTO public.outbox_events
      (aggregate_type, aggregate_id, event_type, idempotency_key, payload, metadata)
    VALUES (
      'commerce_order', v_candidate.id, 'commerce.checkout_recovery',
      'checkout_recovery:20h:' || v_candidate.id,
      jsonb_build_object(
        'orderId', v_candidate.id,
        'mode', CASE WHEN v_candidate.subscription_cycle_id IS NULL THEN 'one_time' ELSE 'subscription_cycle' END,
        'reminderHours', 20,
        'expiresAt', v_candidate.created_at + interval '24 hours'
      ),
      jsonb_build_object('source', 'checkout_recovery_lifecycle')
    )
    ON CONFLICT (event_type, idempotency_key) DO NOTHING
    RETURNING id INTO v_event_id;
    IF v_event_id IS NULL THEN CONTINUE; END IF;

    v_20h := v_20h + 1;
  END LOOP;

  RETURN jsonb_build_object('enqueued_1h', v_1h, 'enqueued_20h', v_20h);
END;
$$;

CREATE FUNCTION public.commerce_checkout_reminder_delivery_authorize(
  p_event_id uuid,
  p_claim_token text
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog
AS $$
DECLARE
  v_event public.outbox_events%ROWTYPE;
  v_order public.commerce_orders%ROWTYPE;
  v_reason text;
  v_template text;
BEGIN
  SELECT * INTO v_event FROM public.outbox_events
   WHERE id = p_event_id AND status = 'processing'
     AND metadata->>'claimToken' = p_claim_token;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('authorized', false, 'reason', 'claim_not_active');
  END IF;
  IF v_event.event_type NOT IN (
    'commerce.order_draft.abandoned.1h',
    'commerce.order_draft.abandoned.24h',
    'commerce.order_draft.abandoned.72h',
    'commerce.checkout_recovery'
  ) THEN
    RETURN jsonb_build_object('authorized', false, 'reason', 'event_type_not_supported');
  END IF;
  SELECT * INTO v_order FROM public.commerce_orders WHERE id = v_event.aggregate_id;
  IF NOT FOUND OR v_order.status <> 'pending_payment' OR v_order.client_id IS NULL THEN
    RETURN jsonb_build_object('authorized', false, 'reason', 'order_not_recoverable');
  END IF;

  IF v_event.event_type LIKE 'commerce.order_draft.abandoned.%' THEN
    IF EXISTS (SELECT 1 FROM public.commerce_settlement_intents WHERE order_id = v_order.id)
       OR NOT EXISTS (
         SELECT 1 FROM public.commerce_order_draft_receipts AS receipt
          WHERE receipt.order_id = v_order.id AND receipt.invalidated_at IS NULL
       )
       OR NOT EXISTS (
         SELECT 1 FROM public.clients AS client
         JOIN public.customer_communication_preferences AS preference
           ON preference.principal_id = client.principal_id
          AND preference.marketing_newsletter_consent
         WHERE client.id = v_order.client_id
       ) THEN
      v_reason := 'abandoned_reminder_no_longer_allowed';
    END IF;
    v_template := replace(v_event.event_type, '.', '-');
  ELSE
    IF v_order.subscription_cycle_id IS NOT NULL OR NOT EXISTS (
      SELECT 1 FROM public.commerce_settlement_intents
       WHERE order_id = v_order.id AND status = 'failed'
    ) THEN
      v_reason := 'checkout_recovery_no_longer_allowed';
    END IF;
    v_template := 'commerce-checkout-recovery';
  END IF;
  IF v_reason IS NOT NULL THEN
    RETURN jsonb_build_object('authorized', false, 'reason', v_reason);
  END IF;
  RETURN jsonb_build_object(
    'authorized', true,
    'idempotencyKey', 'checkout-reminder:' || v_event.id,
    'recipientReference', v_order.client_id,
    'templateReference', v_template
  );
END;
$$;

CREATE FUNCTION public.commerce_checkout_recovery_try_timestamptz(p_value text)
RETURNS timestamptz
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RETURN p_value::timestamptz;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$$;

CREATE FUNCTION public.commerce_outbox_compact_terminal(
  p_limit integer DEFAULT 500,
  p_now timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 500), 1), 5000);
  v_processed integer := 0;
  v_discarded integer := 0;
BEGIN
  WITH target AS (
    SELECT event.id, event.status
      FROM public.outbox_events AS event
     WHERE event.metadata->>'retentionCompactedAt' IS NULL
       AND (
         (event.status = 'processed' AND COALESCE(event.processed_at, event.created_at) < p_now - interval '30 days')
         OR (
           event.status = 'discarded'
           AND public.commerce_checkout_recovery_try_timestamptz(
             event.metadata->>'discardedAt'
           ) < p_now - interval '90 days'
         )
       )
     ORDER BY event.created_at, event.id
     LIMIT v_limit FOR UPDATE SKIP LOCKED
  ), compacted AS (
    UPDATE public.outbox_events AS event
       SET payload = '{}'::jsonb,
           error = NULL,
           metadata = event.metadata || jsonb_build_object(
             'retentionCompactedAt', p_now,
             'retentionCompactedBy', 'commerce_outbox_compact_terminal',
             'retentionCompactedStatus', event.status
           )
      FROM target WHERE event.id = target.id
    RETURNING target.status
  )
  SELECT count(*) FILTER (WHERE status = 'processed')::integer,
         count(*) FILTER (WHERE status = 'discarded')::integer
    INTO v_processed, v_discarded FROM compacted;
  RETURN jsonb_build_object(
    'compacted', v_processed + v_discarded,
    'processed', v_processed,
    'discarded', v_discarded
  );
END;
$$;
