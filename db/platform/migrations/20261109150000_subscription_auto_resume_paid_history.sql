-- Historical paid orders do not keep a timed pause open after completed work.
-- Keep the customer resume guard for the next cycle and unfinished unlinked work.
-- All other guards, header attributes, ownership and ACLs are retained.

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
  SELECT w.id AS pause_window_id,w.subscription_id,w.pause_preset,w.ends_at
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
   v_next_cycle_at:=v_subscription.next_cycle_at;
   IF v_next_cycle_at<=p_now THEN
    v_next_cycle_at:=v_next_cycle_at+((floor(extract(epoch FROM(p_now-v_next_cycle_at))
     /(v_subscription.cadence_days*86400.0))::bigint+1)*v_subscription.cadence_days||' days')::interval;
   END IF;
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
