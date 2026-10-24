-- Migration: customer-cancelled subscriptions become winback-eligible immediately,
-- within the existing 120-day window and current-cancellation-episode dedupe.
-- Add stock-wait lifecycle message mappings; no scheduler is activated.

CREATE OR REPLACE FUNCTION private.outbox_resend_event_types() RETURNS text[]
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'pg_catalog'
    AS $$
  SELECT ARRAY[
    'commerce.order_draft.created',
    'commerce.order.paid.email',
    'commerce.payment.failed',
    'commerce.checkout.expired',
    'commerce.order.canceled',
    'commerce.order.refunded',
    'commerce.shipment.dispatched',
    'commerce.shipment.delivered',
    'commerce.shipment.exception',
    'commerce.return.approved',
    'commerce.return.rejected',
    'commerce.order.review_request',
    'commerce.order.review_effects',
    'commerce.product.back_in_stock',
    'commerce.order_draft.abandoned.1h',
    'commerce.order_draft.abandoned.24h',
    'commerce.order_draft.abandoned.72h',
    'commerce.order.reorder_reminder',
    'commerce.checkout_recovery',
    'subscription.cancelled',
    'subscription.created',
    'subscription.activation_action_required',
    'subscription.pause_reminder_due',
    'subscription.paused',
    'subscription.resumed',
    'subscription.delivery_rescheduled',
    'subscription.cycle_skipped',
    'subscription.address_changed',
    'subscription.package_changed',
    'subscription.renewal_upcoming',
    'subscription_stock_wait.started',
    'subscription_stock_wait.resumed',
    'tester.feedback.reward_confirmation'
  ]::text[];
$$;

CREATE OR REPLACE FUNCTION public.communication_email_delivery_template_for_event(p_event_type text) RETURNS text
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'pg_catalog', 'public'
    AS $$
  SELECT CASE p_event_type
    WHEN 'commerce.order_draft.created' THEN 'commerce-order-confirmation'
    WHEN 'commerce.order.paid.email' THEN 'commerce-order-paid'
    WHEN 'commerce.payment.failed' THEN 'commerce-payment-failed'
    WHEN 'commerce.checkout.expired' THEN 'commerce-checkout-expired'
    WHEN 'commerce.order.canceled' THEN 'commerce-order-canceled'
    WHEN 'commerce.order.refunded' THEN 'commerce-order-refunded'
    WHEN 'commerce.shipment.dispatched' THEN 'commerce-shipment-dispatched'
    WHEN 'commerce.shipment.delivered' THEN 'commerce-shipment-delivered'
    WHEN 'commerce.shipment.exception' THEN 'commerce-shipment-exception'
    WHEN 'commerce.checkout_recovery' THEN 'commerce-checkout-recovery'
    WHEN 'commerce.order.review_request' THEN 'commerce-order-review-request'
    WHEN 'commerce.order.review_effects' THEN 'commerce-order-review-effects'
    WHEN 'commerce.product.back_in_stock' THEN 'commerce-back-in-stock'
    WHEN 'commerce.order_draft.abandoned.1h' THEN 'commerce-abandoned-cart-1h'
    WHEN 'commerce.order_draft.abandoned.24h' THEN 'commerce-abandoned-cart-24h'
    WHEN 'commerce.order_draft.abandoned.72h' THEN 'commerce-abandoned-cart-72h'
    WHEN 'commerce.order.reorder_reminder' THEN 'commerce-reorder-reminder'
    WHEN 'subscription.cancelled' THEN 'subscription-cancelled'
    WHEN 'subscription.created' THEN 'subscription-welcome'
    WHEN 'subscription.pause_reminder_due' THEN 'subscription-pause-reminder'
    WHEN 'subscription.paused' THEN 'subscription-paused'
    WHEN 'subscription.resumed' THEN 'subscription-resumed'
    WHEN 'subscription.delivery_rescheduled' THEN 'subscription-delivery-rescheduled'
    WHEN 'subscription.cycle_skipped' THEN 'subscription-cycle-skipped'
    WHEN 'subscription.address_changed' THEN 'subscription-address-changed'
    WHEN 'subscription.package_changed' THEN 'subscription-package-changed'
    WHEN 'subscription.renewal_upcoming' THEN 'subscription-renewal-upcoming'
    WHEN 'tester.feedback.reward_confirmation' THEN 'reward-confirmation'
    WHEN 'subscription_stock_wait.started' THEN 'subscription-stock-wait-started'
    WHEN 'subscription_stock_wait.resumed' THEN 'subscription-stock-wait-resumed'
    ELSE NULL
  END;
$$;

CREATE OR REPLACE FUNCTION public.subscription_list_due_for_winback(p_limit integer DEFAULT 50) RETURNS TABLE(subscription_id uuid, client_id uuid, ended_at timestamp with time zone, pet_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
BEGIN
  IF p_limit IS NULL OR p_limit <= 0 OR p_limit > 500 THEN
    RAISE EXCEPTION 'subscription_list_due_for_winback: p_limit must be between 1 and 500'
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
    SELECT
      s.id        AS subscription_id,
      s.client_id AS client_id,
      s.ended_at,
      s.pet_id
    FROM public.subscriptions s
    WHERE s.status = 'cancelled'
      AND s.cancellation_source = 'customer_self_service'
      AND s.ended_at IS NOT NULL
      AND s.ended_at > now() - interval '120 days'
      AND NOT EXISTS (
        SELECT 1
        FROM public.subscription_events e
        WHERE e.subscription_id = s.id
          AND e.event_type = 'subscription.winback.email_sent'
          AND e.created_at >= s.ended_at
      )
    ORDER BY s.ended_at ASC, s.id ASC
    LIMIT p_limit
    FOR UPDATE OF s SKIP LOCKED;
END;
$$;

-- Enable the mapped transactional templates without overriding local controls.
INSERT INTO public.comms_notification_controls(slug,enabled) VALUES
 ('subscription-stock-wait-started',true),('subscription-stock-wait-resumed',true) ON CONFLICT(slug) DO NOTHING;
