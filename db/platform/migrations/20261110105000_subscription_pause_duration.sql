-- A finite pause shifts the stored cycle by its actual duration.
-- Preserve all admission guards, manual resume, ownership and execution privileges.

CREATE OR REPLACE FUNCTION public.subscription_auto_resume_due(
  p_limit integer,
  p_now timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
 v_row record; v_subscription public.subscriptions; v_next_cycle_at timestamptz;
 v_event_id uuid; v_scanned integer:=0; v_resumed integer:=0;
 v_skipped integer:=0; v_failed integer:=0;
BEGIN
 FOR v_row IN
  SELECT w.id AS pause_window_id,w.subscription_id,w.pause_preset,w.starts_at,w.ends_at
  FROM public.subscription_pause_windows w JOIN public.subscriptions s ON s.id=w.subscription_id
  WHERE s.status='paused' AND w.resumed_at IS NULL AND w.ends_at IS NOT NULL AND w.ends_at<=p_now
  ORDER BY w.ends_at,w.id
  LIMIT LEAST(GREATEST(COALESCE(p_limit,100),1),500)
  FOR UPDATE OF s,w SKIP LOCKED
 LOOP
  v_scanned:=v_scanned+1;
  BEGIN
   SELECT * INTO v_subscription FROM public.subscriptions WHERE id=v_row.subscription_id FOR UPDATE;
   IF NOT FOUND OR v_subscription.status<>'paused'
    OR NOT EXISTS(SELECT 1 FROM public.subscription_method_states m
      WHERE m.subscription_id=v_row.subscription_id AND m.health_state='healthy')
    OR v_subscription.next_cycle_at IS NULL OR coalesce(v_subscription.cadence_days,0)<=0
    OR NOT EXISTS(SELECT 1 FROM public.subscription_lines l WHERE l.subscription_id=v_row.subscription_id)
    OR EXISTS(SELECT 1 FROM public.subscription_dunning_cases c WHERE c.subscription_id=v_row.subscription_id AND c.status='open')
    OR EXISTS(SELECT 1 FROM public.subscription_cycles c WHERE c.subscription_id=v_row.subscription_id
      AND c.status='paid' AND c.scheduled_at=v_subscription.next_cycle_at)
    -- The native obligation keeps retry/failed state on a payment_pending cycle.
    OR EXISTS(SELECT 1 FROM public.subscription_cycles c WHERE c.subscription_id=v_row.subscription_id AND c.status='payment_pending')
    OR EXISTS(SELECT 1 FROM public.commerce_orders o LEFT JOIN public.subscription_cycles c ON c.id=o.subscription_cycle_id
      WHERE (c.subscription_id=v_row.subscription_id
       OR EXISTS(SELECT 1 FROM public.subscription_renewal_operations op WHERE op.id=o.renewal_operation_id AND op.subscription_id=v_row.subscription_id)
       OR EXISTS(SELECT 1 FROM public.subscription_activations a WHERE a.order_id=o.id AND a.subscription_id=v_row.subscription_id))
       AND o.status IN ('paid','fulfillment_pending','fulfilled')
       AND ((c.subscription_id=v_row.subscription_id AND c.scheduled_at=v_subscription.next_cycle_at)
        OR (o.subscription_cycle_id IS NULL AND (
         EXISTS(SELECT 1 FROM public.subscription_renewal_operations op WHERE op.id=o.renewal_operation_id
          AND op.state NOT IN ('succeeded','refused'))
         OR EXISTS(SELECT 1 FROM public.subscription_activations a WHERE a.order_id=o.id
          AND a.state NOT IN ('active','compensated'))))))
   THEN
    v_skipped:=v_skipped+1;
    CONTINUE;
   END IF;
   v_next_cycle_at:=GREATEST(v_subscription.next_cycle_at+(v_row.ends_at-v_row.starts_at),p_now);
   INSERT INTO public.subscription_events(subscription_id,event_type,idempotency_key,payload,occurred_at)
   VALUES(v_row.subscription_id,'subscription.system.auto_resume','subscription_auto_resume:'||v_row.pause_window_id::text,
    jsonb_build_object('action','auto_resume','pauseWindowId',v_row.pause_window_id,'pausePreset',v_row.pause_preset,
     'resumeAt',v_row.ends_at,'nextCycleAt',v_next_cycle_at,'policy',jsonb_build_object(
      'requiresPaymentMethod',true,'blocksOpenDunning',true,'blocksLockedUpcomingCycle',true)),p_now)
   ON CONFLICT(subscription_id,idempotency_key) DO NOTHING RETURNING id INTO v_event_id;
   UPDATE public.subscriptions SET status='active',next_cycle_at=v_next_cycle_at,updated_at=p_now WHERE id=v_row.subscription_id;
   UPDATE public.subscription_pause_windows SET resumed_at=p_now,updated_at=p_now,event_id=coalesce(v_event_id,event_id)
    WHERE id=v_row.pause_window_id AND resumed_at IS NULL;
   v_resumed:=v_resumed+1;
  EXCEPTION WHEN OTHERS THEN
   v_failed:=v_failed+1;
  END;
 END LOOP;
 RETURN jsonb_build_object('ok',v_failed=0,'scanned',v_scanned,'resumed',v_resumed,'skippedRows',v_skipped,'failed',v_failed);
END;
$$;

CREATE FUNCTION public.subscription_pause_reminder_facts(p_window_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
 SELECT jsonb_build_object('pauseWindowId',w.id,'pausePreset',w.pause_preset,'pauseEndsAt',w.ends_at,
   'nextDeliveryAt',d.delivery_at,'resumeAt',d.delivery_at)
 FROM public.subscription_pause_windows w JOIN public.subscriptions s ON s.id=w.subscription_id
 CROSS JOIN LATERAL(SELECT GREATEST(s.next_cycle_at+(w.ends_at-w.starts_at),w.ends_at) AS delivery_at) d
 WHERE w.id=p_window_id;
$$;
REVOKE ALL ON FUNCTION public.subscription_pause_reminder_facts(uuid) FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.subscription_pause_reminder_facts(uuid) TO service_role';
 END IF;
END; $$;

CREATE OR REPLACE FUNCTION public.dunning_lifecycle_pause_reminder_dispatch(p_limit integer,p_pause_window_seconds integer)
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE v_scanned integer; v_queued integer;
BEGIN
  IF p_pause_window_seconds IS NULL OR p_pause_window_seconds<=0 THEN RAISE EXCEPTION 'subscription_notice_options_invalid'; END IF;
  WITH due AS (
    SELECT w.id,w.subscription_id,w.ends_at,public.subscription_pause_reminder_facts(w.id) AS facts
    FROM public.subscription_pause_windows w JOIN public.subscriptions s ON s.id=w.subscription_id
    WHERE w.resumed_at IS NULL AND s.status='paused' AND w.ends_at>now()
      AND w.ends_at<=now()+make_interval(secs=>p_pause_window_seconds)
    ORDER BY w.ends_at,w.id LIMIT greatest(coalesce(p_limit,0),0)
  ), written AS (
    INSERT INTO public.outbox_events(aggregate_type,aggregate_id,event_type,idempotency_key,payload)
    SELECT 'subscription_notice',subscription_id,'subscription.pause_reminder_due','subscription_pause_reminder:'||id::text,
      facts
    FROM due WHERE NOT EXISTS(SELECT 1 FROM public.subscription_events legacy
      WHERE legacy.subscription_id=due.subscription_id AND legacy.event_type='subscription.pause_reminder_due'
        AND legacy.idempotency_key='pause-reminder:'||due.id::text)
      AND NOT EXISTS(SELECT 1 FROM public.subscription_reminder_ledger legacy
        WHERE legacy.subscription_id=due.subscription_id AND legacy.reminder_kind='pause_ending'
          AND legacy.reminder_day=(due.ends_at AT TIME ZONE 'UTC')::date)
    ON CONFLICT(event_type,idempotency_key) DO NOTHING RETURNING id
  ) SELECT (SELECT count(*)::integer FROM due),(SELECT count(*)::integer FROM written) INTO v_scanned,v_queued;
  RETURN jsonb_build_object('ok',true,'scanned',v_scanned,'queued',v_queued,'sent',0,'skipped',v_scanned-v_queued,'failed',0);
END;
$$;
