-- Native paid-mail projection. The existing paid event remains unchanged.
-- Mail capture is bounded and best effort inside settlement: contention or a
-- mail-only insertion failure cannot undo paid truth. The retained paid event
-- and order remain available for operator repair if mail capture fails.
CREATE OR REPLACE FUNCTION public.commerce_order_emit_paid_notification()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_lock_timeout text := current_setting('lock_timeout');
BEGIN
  INSERT INTO public.outbox_events
    (aggregate_type, aggregate_id, event_type, idempotency_key, payload, metadata)
  VALUES ('commerce_order', NEW.id, 'commerce.order.paid', 'order_paid:' || NEW.id::text,
          jsonb_build_object('orderUuid', NEW.id, 'occurredAt', NEW.paid_at),
          jsonb_build_object('source', 'commerce_order_emit_paid_notification'))
  ON CONFLICT (event_type, idempotency_key) DO NOTHING;

  BEGIN
    PERFORM set_config('lock_timeout', '100ms', true);
    INSERT INTO public.outbox_events
      (aggregate_type, aggregate_id, event_type, idempotency_key, payload, metadata)
    VALUES ('commerce_order', NEW.id, 'commerce.order.paid.email', 'order_paid_email:' || NEW.id::text,
            jsonb_build_object('orderUuid', NEW.id, 'orderId', 'order_' || NEW.id::text,
              'mode', CASE WHEN NEW.subscription_cycle_id IS NOT NULL THEN 'subscription_cycle'
                ELSE COALESCE(NEW.metadata #>> '{orderDraftSnapshot,context,mode}', 'one_time') END,
              'occurredAt', NEW.paid_at),
            jsonb_build_object('source', 'commerce_order_emit_paid_notification'))
    ON CONFLICT (event_type, idempotency_key) DO NOTHING;
    PERFORM set_config('lock_timeout', v_lock_timeout, true);
  EXCEPTION WHEN OTHERS OR query_canceled THEN
    PERFORM set_config('lock_timeout', v_lock_timeout, true);
  END;
  RETURN NULL;
END;
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.subscription_dunning_claim_batch(integer,integer,integer), public.subscription_dunning_mark_sent(uuid,uuid,text), public.subscription_dunning_mark_result(uuid,uuid,text,text,timestamptz), public.dunning_lifecycle_recipient(uuid), public.communications_notification_control_enabled(text[]), public.communications_recipient_consent_state(text,text[]), public.dunning_lifecycle_renewal_reminder_enqueue(integer), public.dunning_lifecycle_pause_reminder_dispatch(integer) TO service_role';
  END IF;
END;
$$;
