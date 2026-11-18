-- Installed native reminder schedule. No seed or rewrite of pending outbox rows.
-- Hours retain the historical dedup-key spelling, including for custom schedules.
CREATE FUNCTION public.commerce_checkout_recovery_reminder_schedule()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE raw_schedule text; schedule jsonb; domain text; wave jsonb; previous_hours numeric; hours numeric; stages text[];
BEGIN
 SELECT value_text INTO raw_schedule FROM public.commerce_settings WHERE key='checkout_recovery_reminders';
 IF NOT FOUND THEN RETURN '{"revision":"default","abandonedCart":[{"stage":"first","afterHours":1},{"stage":"gentle","afterHours":24},{"stage":"last","afterHours":72}],"checkoutRecovery":[{"stage":"first","afterHours":1},{"stage":"last","afterHours":20}]}'::jsonb; END IF;
 BEGIN
  schedule:=raw_schedule::jsonb;
  IF jsonb_typeof(schedule) IS DISTINCT FROM 'object' THEN
   RAISE EXCEPTION 'checkout_recovery_reminder_schedule_invalid' USING ERRCODE='22023'; END IF;
  IF NOT (schedule ?& ARRAY['revision','abandonedCart','checkoutRecovery'])
   OR EXISTS(SELECT 1 FROM jsonb_object_keys(schedule) k WHERE k NOT IN ('revision','abandonedCart','checkoutRecovery'))
   OR jsonb_typeof(schedule->'revision') IS DISTINCT FROM 'string' OR (schedule->>'revision') !~ '[^[:space:]]' THEN
   RAISE EXCEPTION 'checkout_recovery_reminder_schedule_invalid' USING ERRCODE='22023'; END IF;
  FOREACH domain IN ARRAY ARRAY['abandonedCart','checkoutRecovery'] LOOP
   IF jsonb_typeof(schedule->domain) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'checkout_recovery_reminder_schedule_invalid' USING ERRCODE='22023'; END IF;
   IF jsonb_array_length(schedule->domain)=0 THEN
    RAISE EXCEPTION 'checkout_recovery_reminder_schedule_invalid' USING ERRCODE='22023'; END IF;
   previous_hours:=0; stages:=ARRAY[]::text[];
   FOR wave IN SELECT value FROM jsonb_array_elements(schedule->domain) LOOP
    IF jsonb_typeof(wave) IS DISTINCT FROM 'object' THEN
     RAISE EXCEPTION 'checkout_recovery_reminder_schedule_invalid' USING ERRCODE='22023'; END IF;
    IF NOT (wave ?& ARRAY['stage','afterHours'])
     OR EXISTS(SELECT 1 FROM jsonb_object_keys(wave) k WHERE k NOT IN ('stage','afterHours'))
     OR jsonb_typeof(wave->'stage') IS DISTINCT FROM 'string'
     OR NOT ((wave->>'stage') IN ('first','last') OR (domain='abandonedCart' AND wave->>'stage'='gentle'))
     OR (wave->>'stage')=ANY(stages) OR jsonb_typeof(wave->'afterHours') IS DISTINCT FROM 'number' THEN
     RAISE EXCEPTION 'checkout_recovery_reminder_schedule_invalid' USING ERRCODE='22023'; END IF;
    hours:=(wave->>'afterHours')::numeric;
    IF hours<>trunc(hours) OR hours<=previous_hours OR hours>2147483647 THEN
     RAISE EXCEPTION 'checkout_recovery_reminder_schedule_invalid' USING ERRCODE='22023'; END IF;
    previous_hours:=hours; stages:=array_append(stages,wave->>'stage');
   END LOOP;
   IF wave->>'stage'<>'last' THEN
    RAISE EXCEPTION 'checkout_recovery_reminder_schedule_invalid' USING ERRCODE='22023'; END IF;
  END LOOP;
 EXCEPTION WHEN data_exception THEN
  RAISE EXCEPTION 'checkout_recovery_reminder_schedule_invalid' USING ERRCODE='22023';
 END;
 RETURN schedule;
END;
$$;
REVOKE ALL ON FUNCTION public.commerce_checkout_recovery_reminder_schedule() FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.commerce_checkout_recovery_reminder_schedule() FROM anon;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.commerce_checkout_recovery_reminder_schedule() FROM authenticated;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'GRANT EXECUTE ON FUNCTION public.commerce_checkout_recovery_reminder_schedule() TO service_role;'; END IF; END; $$;

CREATE OR REPLACE FUNCTION public.commerce_enqueue_abandoned_cart_reminders(p_limit integer DEFAULT 200)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 200), 1), 1000);
  schedule jsonb := public.commerce_checkout_recovery_reminder_schedule()->'abandonedCart';
  wave jsonb; hours integer; next_hours integer; prior_type text; v_event_type text; inserted integer;
  counts jsonb := '{"enqueued_1h":0,"enqueued_24h":0,"enqueued_72h":0}'::jsonb;
  stage_hour integer;
BEGIN
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
   FROM candidates c ON CONFLICT(event_type,idempotency_key) DO NOTHING RETURNING aggregate_id,payload
  ), tokens AS (
   INSERT INTO public.commerce_checkout_recovery_tokens(order_id,client_id,token_hash,expires_at)
   SELECT e.aggregate_id,o.client_id,encode(sha256(convert_to(e.payload->>'recoveryToken','UTF8')),'hex'),
    (e.payload->>'expiresAt')::timestamptz FROM events e JOIN public.commerce_orders o ON o.id=e.aggregate_id RETURNING 1
  ) SELECT count(*)::integer INTO inserted FROM tokens;
  IF stage='first' THEN first_count:=inserted; ELSE final_count:=inserted; END IF;
 END LOOP;
 RETURN jsonb_build_object('enqueued_1h',first_count,'enqueued_20h',final_count);
END; $$;
