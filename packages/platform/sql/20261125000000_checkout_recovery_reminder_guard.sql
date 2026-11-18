-- Keep each reminder stage final and serialize schedule installation with both wave producers.
CREATE FUNCTION public.commerce_checkout_recovery_event_stage(p_event public.outbox_events, p_schedule_installed boolean)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE
    WHEN p_event.event_type <> 'commerce.checkout_recovery'
      OR p_event.idempotency_key LIKE 'checkout_recovery:operator:%'
      OR p_event.idempotency_key LIKE 'checkout_recovery:buyer:%' THEN NULL
    WHEN p_schedule_installed AND p_event.metadata ? 'retentionCompactedAt' THEN 'both'
    WHEN p_event.payload->>'stage' IS NOT NULL THEN p_event.payload->>'stage'
    WHEN p_event.idempotency_key LIKE 'checkout_recovery:1h:%' THEN 'first'
    WHEN p_event.idempotency_key LIKE 'checkout_recovery:20h:%' THEN 'last'
    WHEN p_event.idempotency_key ~ '^checkout_recovery:[0-9]+h:' THEN 'both'
    WHEN p_event.payload->>'reminderHours' = '1' THEN 'first'
    WHEN p_event.payload->>'reminderHours' = '20' THEN 'last'
    WHEN p_event.payload->>'reminderHours' IS NOT NULL THEN 'both'
  END;
$$;

CREATE FUNCTION public.commerce_checkout_recovery_schedule_change_guard(p_before jsonb, p_after jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  blocking_orders bigint;
BEGIN
  IF p_before IS NOT DISTINCT FROM p_after THEN RETURN; END IF;
  -- A snapshot taken before the lock must be able to see the previous holder's commit.
  IF current_setting('transaction_isolation') IN ('repeatable read', 'serializable') THEN
    RAISE EXCEPTION 'checkout_recovery_schedule_isolation_unsupported' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('checkout_recovery_reminders', 0));

  WITH open_waves AS (
    SELECT o.id
    FROM public.commerce_orders o
    WHERE o.status = 'pending_payment'
      AND EXISTS (
        SELECT 1 FROM public.commerce_order_draft_receipts r
        WHERE r.order_id = o.id AND r.invalidated_at IS NULL
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.commerce_settlement_intents i WHERE i.order_id = o.id
      )
      AND EXISTS (
        SELECT 1 FROM public.outbox_events e
        WHERE e.aggregate_type = 'commerce_order' AND e.aggregate_id = o.id
          AND e.event_type IN ('commerce.order_draft.abandoned.1h', 'commerce.order_draft.abandoned.24h',
                               'commerce.order_draft.abandoned.72h')
      )
    UNION ALL
    SELECT o.id
    FROM public.commerce_orders o
    WHERE o.status = 'pending_payment'
      AND EXISTS (
        SELECT 1 FROM public.outbox_events e
        WHERE e.aggregate_type = 'commerce_order' AND e.aggregate_id = o.id
          AND e.event_type = 'commerce.checkout_recovery'
          -- A compacted checkout wave still blocks, regardless of schedule presence.
          AND public.commerce_checkout_recovery_event_stage(e, true) IS NOT NULL
      )
  )
  SELECT count(DISTINCT id) INTO blocking_orders FROM open_waves;

  IF blocking_orders > 0 THEN
    RAISE EXCEPTION 'checkout_recovery_schedule_change_blocked_open_episodes (% blocking orders)',
      blocking_orders USING ERRCODE = '55000';
  END IF;
END;
$$;

CREATE FUNCTION public.commerce_install_checkout_recovery_reminder_schedule(p_key text, p_schedule jsonb)
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE previous_schedule jsonb;
BEGIN
  IF p_key IS DISTINCT FROM 'checkout_recovery_reminders' OR p_schedule IS NULL THEN
    RAISE EXCEPTION 'checkout_recovery_reminder_schedule_invalid' USING ERRCODE = '22023';
  END IF;
  -- Lock before reading the previous state, including when no row exists yet.
  PERFORM pg_advisory_xact_lock(hashtextextended('checkout_recovery_reminders', 0));
  SELECT CASE WHEN pg_input_is_valid(value_text, 'jsonb') THEN value_text::jsonb ELSE 'null'::jsonb END
  INTO previous_schedule
  FROM public.commerce_settings WHERE key = p_key;

  PERFORM public.commerce_checkout_recovery_schedule_change_guard(previous_schedule, p_schedule);

  -- Identical replay never writes, including under snapshot isolation.
  IF previous_schedule IS NOT DISTINCT FROM p_schedule THEN
    PERFORM public.commerce_checkout_recovery_reminder_schedule();
    RETURN;
  END IF;

  INSERT INTO public.commerce_settings(key, value_text)
  VALUES (p_key, p_schedule::text)
  ON CONFLICT (key) DO UPDATE SET value_text = EXCLUDED.value_text;

  -- Reuse the schedule validator so direct SQL calls also roll back malformed input.
  PERFORM public.commerce_checkout_recovery_reminder_schedule();
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_checkout_recovery_event_stage(public.outbox_events,boolean), public.commerce_checkout_recovery_schedule_change_guard(jsonb,jsonb), public.commerce_install_checkout_recovery_reminder_schedule(text,jsonb) FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.commerce_checkout_recovery_event_stage(public.outbox_events,boolean), public.commerce_checkout_recovery_schedule_change_guard(jsonb,jsonb), public.commerce_install_checkout_recovery_reminder_schedule(text,jsonb) FROM anon;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.commerce_checkout_recovery_event_stage(public.outbox_events,boolean), public.commerce_checkout_recovery_schedule_change_guard(jsonb,jsonb), public.commerce_install_checkout_recovery_reminder_schedule(text,jsonb) FROM authenticated;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.commerce_checkout_recovery_event_stage(public.outbox_events,boolean), public.commerce_checkout_recovery_schedule_change_guard(jsonb,jsonb), public.commerce_install_checkout_recovery_reminder_schedule(text,jsonb) FROM service_role;'; END IF; END; $$;

CREATE OR REPLACE FUNCTION public.commerce_enqueue_abandoned_cart_reminders(p_limit integer DEFAULT 200)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 200), 1), 1000);
  schedule jsonb;
  wave jsonb; hours integer; next_hours integer; prior_type text; v_event_type text; inserted integer;
  counts jsonb := '{"enqueued_1h":0,"enqueued_24h":0,"enqueued_72h":0}'::jsonb;
  stage_hour integer;
BEGIN
  IF current_setting('transaction_isolation') IN ('repeatable read', 'serializable') THEN
    RAISE EXCEPTION 'checkout_recovery_schedule_isolation_unsupported' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('checkout_recovery_reminders', 0));
  schedule := public.commerce_checkout_recovery_reminder_schedule()->'abandonedCart';
  FOR position IN 0..jsonb_array_length(schedule)-1 LOOP
    wave:=schedule->position; hours:=(wave->>'afterHours')::numeric::integer;
    next_hours:=(schedule->(position+1)->>'afterHours')::numeric::integer;
    stage_hour:=CASE wave->>'stage' WHEN 'first' THEN 1 WHEN 'gentle' THEN 24 ELSE 72 END;
    v_event_type:='commerce.order_draft.abandoned.'||stage_hour||'h';
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
         AND order_row.created_at < now() - make_interval(hours=>hours)
         AND (next_hours IS NULL OR order_row.created_at >= now() - make_interval(hours=>next_hours))
         AND NOT EXISTS (SELECT 1 FROM public.commerce_settlement_intents intent WHERE intent.order_id = order_row.id)
         AND (wave->>'stage'<>'last' OR prior_type IS NULL OR EXISTS (
           SELECT 1 FROM public.outbox_events prior
            WHERE prior.aggregate_id = order_row.id AND prior.event_type = prior_type AND prior.status = 'processed'
         ))
       ORDER BY order_row.created_at, order_row.id LIMIT v_limit
    ), inserted_rows AS (
      INSERT INTO public.outbox_events
        (aggregate_type, aggregate_id, event_type, idempotency_key, payload, metadata)
      SELECT 'commerce_order', candidate.id, v_event_type, 'abandoned_' || hours || 'h:' || candidate.id,
        jsonb_build_object('orderId', 'order_' || candidate.id, 'orderUuid', candidate.id,
          'reminderHours', hours, 'stage', wave->>'stage', 'createdAt', candidate.created_at),
        jsonb_build_object('source', 'checkout_recovery_lifecycle')
      FROM candidates AS candidate
      WHERE NOT EXISTS (
        SELECT 1 FROM public.outbox_events prior
         WHERE prior.aggregate_type = 'commerce_order' AND prior.aggregate_id = candidate.id
           AND prior.event_type = v_event_type
      )
      ON CONFLICT (event_type, idempotency_key) DO NOTHING RETURNING 1
    ) SELECT count(*)::integer INTO inserted FROM inserted_rows;
    counts:=jsonb_set(counts,ARRAY['enqueued_'||stage_hour||'h'],to_jsonb(inserted));
    prior_type:=v_event_type;
  END LOOP;
  RETURN counts;
END;
$$;

CREATE OR REPLACE FUNCTION public.commerce_enqueue_checkout_recovery_reminders(p_limit integer,p_policy jsonb,p_now timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE policy jsonb:=public.commerce_checkout_recovery_policy(p_policy);
 schedule jsonb; installed boolean;
 entry jsonb; wave integer; stage text; first_hours integer; offset_seconds double precision; inserted integer; first_count integer:=0; final_count integer:=0;
BEGIN
 IF current_setting('transaction_isolation') IN ('repeatable read', 'serializable') THEN
  RAISE EXCEPTION 'checkout_recovery_schedule_isolation_unsupported' USING ERRCODE = '22023';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('checkout_recovery_reminders', 0));
 -- One statement snapshot keeps presence and the validated schedule coherent.
 SELECT public.commerce_checkout_recovery_reminder_schedule()->'checkoutRecovery',
  EXISTS(SELECT 1 FROM public.commerce_settings WHERE key='checkout_recovery_reminders') INTO schedule,installed;
 IF p_now IS NULL OR NOT isfinite(p_now) THEN RAISE EXCEPTION 'checkout_recovery_time_invalid' USING ERRCODE='22023'; END IF;
 first_hours:=(schedule->0->>'afterHours')::numeric::integer;
 FOR entry IN SELECT value FROM jsonb_array_elements(schedule) LOOP
  wave:=(entry->>'afterHours')::numeric::integer; stage:=entry->>'stage';
  -- Legacy request offsets remain effective only while the installed key is absent.
  offset_seconds:=CASE WHEN installed THEN wave::double precision*3600
   ELSE (policy->>CASE WHEN stage='first' THEN 'firstOffsetSeconds' ELSE 'finalOffsetSeconds' END)::integer END;
  WITH candidates AS MATERIALIZED (
   SELECT o.id,o.client_id,o.created_at,
    CASE WHEN EXISTS(SELECT 1 FROM public.subscription_activations a WHERE a.order_id=o.id)
     OR COALESCE(o.metadata#>>'{orderDraftSnapshot,context,mode}',o.metadata#>>'{quoteSnapshot,quote,context,mode}')='subscription'
     THEN 'subscription_cycle' ELSE 'one_time' END AS mode,
    'rcv_'||replace(gen_random_uuid()::text,'-','')||replace(gen_random_uuid()::text,'-','') AS raw_token
   FROM public.commerce_orders o WHERE o.status='pending_payment' AND o.client_id IS NOT NULL
    AND o.subscription_cycle_id IS NULL
    AND NOT EXISTS(SELECT 1 FROM public.subscription_activations a WHERE a.order_id=o.id AND a.state<>'provisional')
    AND o.created_at<p_now-make_interval(secs=>offset_seconds)
    AND o.created_at>p_now-make_interval(secs=>(policy->>'checkoutSeconds')::integer)
    AND NOT public.commerce_checkout_recovery_payment_blocked(o.id,(policy->>'activitySeconds')::integer,p_now)
    AND (wave=first_hours OR EXISTS(SELECT 1 FROM public.outbox_events prior JOIN public.transactional_delivery_receipts r
     ON r.idempotency_key='checkout-reminder:'||prior.id
     AND r.state='accepted' AND r.command_fingerprint=public.commerce_checkout_recovery_receipt_fingerprint(prior.id)
     WHERE prior.aggregate_id=o.id AND prior.event_type='commerce.checkout_recovery'
      AND prior.idempotency_key='checkout_recovery:'||first_hours||'h:'||o.id
      AND prior.metadata->>'deliveryProfile'=policy->>'profile'))
   ORDER BY o.created_at,o.id LIMIT LEAST(GREATEST(COALESCE(p_limit,200),1),1000)
  ), events AS (
   INSERT INTO public.outbox_events(aggregate_type,aggregate_id,event_type,idempotency_key,payload,metadata)
   SELECT 'commerce_order',c.id,'commerce.checkout_recovery','checkout_recovery:'||wave||'h:'||c.id,
    jsonb_build_object('orderId',c.id,'mode',c.mode,'reminderHours',wave,'stage',stage,'recoveryToken',c.raw_token,
     'expiresAt',c.created_at+make_interval(secs=>(policy->>'checkoutSeconds')::integer)),
    jsonb_build_object('source','checkout_recovery_waves','deliveryProfile',policy->>'profile','activitySeconds',(policy->>'activitySeconds')::integer)
   FROM candidates c
   WHERE NOT EXISTS (
    SELECT 1 FROM public.outbox_events prior
    WHERE prior.aggregate_type = 'commerce_order' AND prior.aggregate_id = c.id
      AND prior.event_type = 'commerce.checkout_recovery'
      AND public.commerce_checkout_recovery_event_stage(prior, installed) IN (stage, 'both')
   )
   ON CONFLICT(event_type,idempotency_key) DO NOTHING RETURNING aggregate_id,payload
  ), tokens AS (
   INSERT INTO public.commerce_checkout_recovery_tokens(order_id,client_id,token_hash,expires_at)
   SELECT e.aggregate_id,o.client_id,encode(sha256(convert_to(e.payload->>'recoveryToken','UTF8')),'hex'),
    (e.payload->>'expiresAt')::timestamptz FROM events e JOIN public.commerce_orders o ON o.id=e.aggregate_id RETURNING 1
  ) SELECT count(*)::integer INTO inserted FROM tokens;
  IF stage='first' THEN first_count:=inserted; ELSE final_count:=inserted; END IF;
 END LOOP;
 RETURN jsonb_build_object('enqueued_1h',first_count,'enqueued_20h',final_count);
END; $$;
