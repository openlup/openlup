CREATE TABLE public.commerce_reminder_episodes (
  order_id uuid NOT NULL REFERENCES public.commerce_orders(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('checkout_recovery','abandoned_cart')),
  schedule jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (order_id,kind)
);
ALTER TABLE public.commerce_reminder_episodes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.commerce_reminder_episodes FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'REVOKE ALL ON TABLE public.commerce_reminder_episodes FROM anon;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'REVOKE ALL ON TABLE public.commerce_reminder_episodes FROM authenticated;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'REVOKE ALL ON TABLE public.commerce_reminder_episodes FROM service_role;'; END IF; END; $$;

CREATE OR REPLACE FUNCTION public.commerce_checkout_recovery_schedule_change_guard(p_before jsonb, p_after jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE blocking_orders bigint;
BEGIN
  IF p_before IS NOT DISTINCT FROM p_after THEN RETURN; END IF;
  IF current_setting('transaction_isolation') IN ('repeatable read', 'serializable') THEN
    RAISE EXCEPTION 'checkout_recovery_schedule_isolation_unsupported' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('checkout_recovery_reminders', 0));
  SELECT count(DISTINCT o.id) INTO blocking_orders
  FROM public.commerce_orders o JOIN public.outbox_events e ON e.aggregate_type='commerce_order' AND e.aggregate_id=o.id
  LEFT JOIN public.commerce_reminder_episodes pin ON pin.order_id=o.id
    AND pin.kind=CASE WHEN e.event_type='commerce.checkout_recovery' THEN 'checkout_recovery' ELSE 'abandoned_cart' END
  WHERE o.status='pending_payment' AND pin.order_id IS NULL AND (
    (e.event_type='commerce.checkout_recovery' AND public.commerce_checkout_recovery_event_stage(e,true) IS NOT NULL)
    OR (e.event_type IN ('commerce.order_draft.abandoned.1h','commerce.order_draft.abandoned.24h','commerce.order_draft.abandoned.72h')
      AND EXISTS (SELECT 1 FROM public.commerce_order_draft_receipts r WHERE r.order_id=o.id AND r.invalidated_at IS NULL)
      AND NOT EXISTS (SELECT 1 FROM public.commerce_settlement_intents i WHERE i.order_id=o.id)));
  IF blocking_orders > 0 THEN
    RAISE EXCEPTION 'checkout_recovery_schedule_change_blocked_open_episodes (% blocking orders)',
      blocking_orders USING ERRCODE = '55000',
      HINT = 'The current schedule stays in effect. Retry after the blocking orders are paid, cancelled, or their carts are no longer eligible.';
  END IF;
END; $$;

-- Keep the existing invoker entry point. Only its owner operation can write cart pins.
CREATE OR REPLACE FUNCTION public.commerce_enqueue_abandoned_cart_reminders(p_limit integer DEFAULT 200)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF NOT has_function_privilege(current_user, 'public.commerce_enqueue_abandoned_cart_reminder_episodes(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'checkout_recovery_cart_runtime_grant_required' USING ERRCODE = '42501',
      HINT = format('GRANT EXECUTE ON FUNCTION public.commerce_enqueue_abandoned_cart_reminder_episodes(integer) TO %I;', current_user);
  END IF;
  RETURN public.commerce_enqueue_abandoned_cart_reminder_episodes(p_limit);
END; $$;

CREATE FUNCTION public.commerce_enqueue_abandoned_cart_reminder_episodes(p_limit integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  live jsonb; v_stage text; route text; inserted integer;
  counts jsonb := '{"enqueued_1h":0,"enqueued_24h":0,"enqueued_72h":0}'::jsonb;
BEGIN
  IF current_setting('transaction_isolation') IN ('repeatable read', 'serializable') THEN
    RAISE EXCEPTION 'checkout_recovery_schedule_isolation_unsupported' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('checkout_recovery_reminders', 0));
  SELECT jsonb_agg(wave || jsonb_build_object('offsetSeconds',(wave->>'afterHours')::numeric::bigint*3600) ORDER BY position) INTO live
    FROM jsonb_array_elements(public.commerce_checkout_recovery_reminder_schedule()->'abandonedCart') WITH ORDINALITY s(wave,position);
  FOR v_stage,route IN VALUES ('first','1h'),('gentle','24h'),('last','72h') LOOP
    WITH candidates AS MATERIALIZED (
      SELECT o.id,o.created_at,pin.order_id IS NULL AS unpinned,(w.wave->>'afterHours')::numeric::integer AS hours
      FROM public.commerce_orders o JOIN public.clients c ON c.id=o.client_id
      JOIN public.customer_communication_preferences p ON p.principal_id=c.principal_id AND p.marketing_newsletter_consent
      LEFT JOIN public.commerce_reminder_episodes pin ON pin.order_id=o.id AND pin.kind='abandoned_cart'
      CROSS JOIN LATERAL (SELECT COALESCE(pin.schedule,live) AS schedule) s
      CROSS JOIN LATERAL jsonb_array_elements(s.schedule) WITH ORDINALITY w(wave,position)
      WHERE w.wave->>'stage'=v_stage AND o.status='pending_payment' AND o.subscription_cycle_id IS NULL
        AND EXISTS (SELECT 1 FROM public.commerce_order_draft_receipts r WHERE r.order_id=o.id AND r.invalidated_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM public.commerce_settlement_intents i WHERE i.order_id=o.id)
        AND o.created_at<now()-make_interval(secs=>(w.wave->>'offsetSeconds')::double precision)
        AND (s.schedule->w.position::integer IS NULL OR o.created_at>=now()-make_interval(secs=>(s.schedule->w.position::integer->>'offsetSeconds')::double precision))
        AND (v_stage<>'last' OR w.position=1 OR EXISTS (SELECT 1 FROM public.outbox_events prior
          WHERE prior.aggregate_id=o.id AND prior.status='processed' AND prior.event_type='commerce.order_draft.abandoned.'||
            CASE s.schedule->(w.position::integer-2)->>'stage' WHEN 'first' THEN '1h' ELSE '24h' END))
      ORDER BY o.created_at,o.id LIMIT LEAST(GREATEST(COALESCE(p_limit,200),1),1000)
    ), events AS (
      INSERT INTO public.outbox_events(aggregate_type,aggregate_id,event_type,idempotency_key,payload,metadata)
      SELECT 'commerce_order',c.id,'commerce.order_draft.abandoned.'||route,'abandoned_'||c.hours||'h:'||c.id,
        jsonb_build_object('orderId','order_'||c.id,'orderUuid',c.id,'reminderHours',c.hours,'stage',v_stage,'createdAt',c.created_at),
        jsonb_build_object('source','checkout_recovery_lifecycle') FROM candidates c
      WHERE NOT EXISTS (SELECT 1 FROM public.outbox_events prior WHERE prior.aggregate_type='commerce_order'
        AND prior.aggregate_id=c.id AND prior.event_type='commerce.order_draft.abandoned.'||route)
      ON CONFLICT (event_type,idempotency_key) DO NOTHING RETURNING aggregate_id
    ), pins AS (
      INSERT INTO public.commerce_reminder_episodes(order_id,kind,schedule)
      SELECT c.id,'abandoned_cart',live FROM events e JOIN candidates c ON c.id=e.aggregate_id
      WHERE c.unpinned AND NOT EXISTS (SELECT 1 FROM public.outbox_events prior WHERE prior.aggregate_type='commerce_order'
        AND prior.aggregate_id=c.id AND prior.event_type IN ('commerce.order_draft.abandoned.1h','commerce.order_draft.abandoned.24h','commerce.order_draft.abandoned.72h'))
    ) SELECT count(*)::integer INTO inserted FROM events;
    counts:=jsonb_set(counts,ARRAY['enqueued_'||route],to_jsonb(inserted));
  END LOOP;
  RETURN counts;
END; $$;
REVOKE ALL ON FUNCTION public.commerce_enqueue_abandoned_cart_reminder_episodes(integer) FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.commerce_enqueue_abandoned_cart_reminder_episodes(integer) FROM anon;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.commerce_enqueue_abandoned_cart_reminder_episodes(integer) FROM authenticated;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'GRANT EXECUTE ON FUNCTION public.commerce_enqueue_abandoned_cart_reminder_episodes(integer) TO service_role;'; END IF; END; $$;

CREATE OR REPLACE FUNCTION public.commerce_enqueue_checkout_recovery_reminders(p_limit integer,p_policy jsonb,p_now timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  policy jsonb:=public.commerce_checkout_recovery_policy(p_policy);
  live jsonb; installed boolean; v_stage text; inserted integer; first_count integer:=0; final_count integer:=0;
BEGIN
  IF current_setting('transaction_isolation') IN ('repeatable read', 'serializable') THEN
    RAISE EXCEPTION 'checkout_recovery_schedule_isolation_unsupported' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('checkout_recovery_reminders', 0));
  SELECT present,jsonb_agg(wave || jsonb_build_object('offsetSeconds',CASE WHEN present THEN (wave->>'afterHours')::numeric::bigint*3600
      ELSE (policy->>CASE WHEN wave->>'stage'='first' THEN 'firstOffsetSeconds' ELSE 'finalOffsetSeconds' END)::integer END) ORDER BY position)
    INTO installed,live FROM (SELECT EXISTS(SELECT 1 FROM public.commerce_settings WHERE key='checkout_recovery_reminders') AS present) setting
    CROSS JOIN jsonb_array_elements(public.commerce_checkout_recovery_reminder_schedule()->'checkoutRecovery') WITH ORDINALITY s(wave,position) GROUP BY present;
  IF p_now IS NULL OR NOT isfinite(p_now) THEN RAISE EXCEPTION 'checkout_recovery_time_invalid' USING ERRCODE='22023'; END IF;
  FOREACH v_stage IN ARRAY ARRAY['first','last'] LOOP
    WITH candidates AS MATERIALIZED (
      SELECT o.id,o.client_id,o.created_at,pin.order_id IS NULL AS unpinned,(w.wave->>'afterHours')::numeric::integer AS hours,
        CASE WHEN EXISTS(SELECT 1 FROM public.subscription_activations a WHERE a.order_id=o.id)
          OR COALESCE(o.metadata#>>'{orderDraftSnapshot,context,mode}',o.metadata#>>'{quoteSnapshot,quote,context,mode}')='subscription'
          THEN 'subscription_cycle' ELSE 'one_time' END AS mode,
        'rcv_'||replace(gen_random_uuid()::text,'-','')||replace(gen_random_uuid()::text,'-','') AS raw_token
      FROM public.commerce_orders o LEFT JOIN public.commerce_reminder_episodes pin ON pin.order_id=o.id AND pin.kind='checkout_recovery'
      CROSS JOIN LATERAL (SELECT COALESCE(pin.schedule,live) AS schedule) s
      CROSS JOIN LATERAL jsonb_array_elements(s.schedule) WITH ORDINALITY w(wave,position)
      WHERE w.wave->>'stage'=v_stage AND o.status='pending_payment' AND o.client_id IS NOT NULL AND o.subscription_cycle_id IS NULL
        AND NOT EXISTS(SELECT 1 FROM public.subscription_activations a WHERE a.order_id=o.id AND a.state<>'provisional')
        AND o.created_at<p_now-make_interval(secs=>(w.wave->>'offsetSeconds')::double precision)
        AND o.created_at>p_now-make_interval(secs=>(policy->>'checkoutSeconds')::integer)
        AND NOT public.commerce_checkout_recovery_payment_blocked(o.id,(policy->>'activitySeconds')::integer,p_now)
        AND (w.position=1 OR EXISTS(SELECT 1 FROM public.outbox_events prior JOIN public.transactional_delivery_receipts r
          ON r.idempotency_key='checkout-reminder:'||prior.id AND r.state='accepted'
          AND r.command_fingerprint=public.commerce_checkout_recovery_receipt_fingerprint(prior.id)
          WHERE prior.aggregate_id=o.id AND prior.event_type='commerce.checkout_recovery'
            AND prior.idempotency_key='checkout_recovery:'||(s.schedule->0->>'afterHours')::numeric::integer||'h:'||o.id
            AND prior.metadata->>'deliveryProfile'=policy->>'profile'))
      ORDER BY o.created_at,o.id LIMIT LEAST(GREATEST(COALESCE(p_limit,200),1),1000)
    ), events AS (
      INSERT INTO public.outbox_events(aggregate_type,aggregate_id,event_type,idempotency_key,payload,metadata)
      SELECT 'commerce_order',c.id,'commerce.checkout_recovery','checkout_recovery:'||c.hours||'h:'||c.id,
        jsonb_build_object('orderId',c.id,'mode',c.mode,'reminderHours',c.hours,'stage',v_stage,'recoveryToken',c.raw_token,
          'expiresAt',c.created_at+make_interval(secs=>(policy->>'checkoutSeconds')::integer)),
        jsonb_build_object('source','checkout_recovery_waves','deliveryProfile',policy->>'profile','activitySeconds',(policy->>'activitySeconds')::integer)
      FROM candidates c WHERE NOT EXISTS (SELECT 1 FROM public.outbox_events prior WHERE prior.aggregate_type='commerce_order'
        AND prior.aggregate_id=c.id AND prior.event_type='commerce.checkout_recovery'
        AND public.commerce_checkout_recovery_event_stage(prior,installed) IN (v_stage,'both'))
      ON CONFLICT (event_type,idempotency_key) DO NOTHING RETURNING aggregate_id,payload
    ), pins AS (
      -- The statement snapshot sees prior events and the RETURNING clause sees the inserted wave.
      INSERT INTO public.commerce_reminder_episodes(order_id,kind,schedule)
      SELECT c.id,'checkout_recovery',live FROM events e JOIN candidates c ON c.id=e.aggregate_id
      WHERE c.unpinned AND NOT EXISTS (SELECT 1 FROM public.outbox_events prior WHERE prior.aggregate_type='commerce_order'
        AND prior.aggregate_id=c.id AND prior.event_type='commerce.checkout_recovery'
        AND public.commerce_checkout_recovery_event_stage(prior,true) IS NOT NULL)
    ), tokens AS (
      INSERT INTO public.commerce_checkout_recovery_tokens(order_id,client_id,token_hash,expires_at)
      SELECT e.aggregate_id,c.client_id,encode(sha256(convert_to(e.payload->>'recoveryToken','UTF8')),'hex'),
        (e.payload->>'expiresAt')::timestamptz FROM events e JOIN candidates c ON c.id=e.aggregate_id RETURNING 1
    ) SELECT count(*)::integer INTO inserted FROM tokens;
    IF v_stage='first' THEN first_count:=inserted; ELSE final_count:=inserted; END IF;
  END LOOP;
  RETURN jsonb_build_object('enqueued_1h',first_count,'enqueued_20h',final_count);
END; $$;
