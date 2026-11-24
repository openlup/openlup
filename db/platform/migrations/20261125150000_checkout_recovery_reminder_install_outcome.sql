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
      DETAIL = 'openlup:reminder_schedule:blocking_orders=' || blocking_orders::text,
      HINT = 'The current schedule stays in effect. Retry after the blocking orders are paid, cancelled, or their carts are no longer eligible.';
  END IF;
END; $$;
