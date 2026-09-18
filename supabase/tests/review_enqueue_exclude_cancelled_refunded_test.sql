-- pgTAP: enqueue_review_requests / enqueue_review_effects skip orders whose parent
-- commerce_orders is cancelled or refunded (20260704100000).
--   * a paid, in-window delivered order IS enqueued;
--   * a refunded parent (fulfillment still 'delivered') is NOT enqueued;
--   * a cancelled parent is NOT enqueued;
--   * the same exclusion holds for the effects (second touchpoint) scan.
--
-- Run via: supabase db reset && supabase test db

BEGIN;
SELECT plan(6);

INSERT INTO public.clients (id, email, first_name, last_name)
VALUES ('21000000-0000-0000-0000-0000000000a0', 'review-status@example.invalid', 'Rev', 'Status');

INSERT INTO public.addresses (id, client_id, kind, line1, city, postal_code, country)
VALUES ('21000000-0000-0000-0000-0000000000d0', '21000000-0000-0000-0000-0000000000a0',
        'shipping', 'ul. Testowa 3', 'Warszawa', '00-003', 'PL');

INSERT INTO public.providers (kind, capability, display_name, status)
VALUES ('test_carrier', 'fulfillment', 'Test Carrier', 'experimental')
ON CONFLICT (kind) DO NOTHING;

-- A: paid + delivered 10d ago -> eligible.
-- B: refunded + delivered 10d ago -> excluded.
-- C: cancelled + delivered 10d ago -> excluded.
INSERT INTO public.commerce_orders (id, client_id, order_number, status, mode, currency, total_cents, subtotal_cents)
VALUES
  ('21000000-0000-0000-0000-0000000000a1', '21000000-0000-0000-0000-0000000000a0', 'REVIEW-STATUS-A', 'paid',      'one_time', 'PLN', 12999, 12999),
  ('21000000-0000-0000-0000-0000000000a2', '21000000-0000-0000-0000-0000000000a0', 'REVIEW-STATUS-B', 'refunded',  'one_time', 'PLN', 12999, 12999),
  ('21000000-0000-0000-0000-0000000000a3', '21000000-0000-0000-0000-0000000000a0', 'REVIEW-STATUS-C', 'cancelled', 'one_time', 'PLN', 12999, 12999);

INSERT INTO public.commerce_fulfillment_orders (
  id, order_id, client_id, shipping_address_id, create_idempotency_key,
  status, provider_kind, shipping_address_snapshot, delivered_at)
VALUES
  ('21000000-0000-0000-0000-0000000000f1', '21000000-0000-0000-0000-0000000000a1', '21000000-0000-0000-0000-0000000000a0', '21000000-0000-0000-0000-0000000000d0', 'review-fo-status-a', 'delivered', 'test_carrier', '{}'::jsonb, now() - interval '10 days'),
  ('21000000-0000-0000-0000-0000000000f2', '21000000-0000-0000-0000-0000000000a2', '21000000-0000-0000-0000-0000000000a0', '21000000-0000-0000-0000-0000000000d0', 'review-fo-status-b', 'delivered', 'test_carrier', '{}'::jsonb, now() - interval '10 days'),
  ('21000000-0000-0000-0000-0000000000f3', '21000000-0000-0000-0000-0000000000a3', '21000000-0000-0000-0000-0000000000a0', '21000000-0000-0000-0000-0000000000d0', 'review-fo-status-c', 'delivered', 'test_carrier', '{}'::jsonb, now() - interval '10 days');

INSERT INTO public.commerce_fulfillment_operations (
  fulfillment_order_id, order_id, operation_type, idempotency_key, actor_user_id, payload)
VALUES
  ('21000000-0000-0000-0000-0000000000f1', '21000000-0000-0000-0000-0000000000a1', 'tracking_event_recorded', 'review-status-op-a', NULL, jsonb_build_object('status', 'delivered')),
  ('21000000-0000-0000-0000-0000000000f2', '21000000-0000-0000-0000-0000000000a2', 'tracking_event_recorded', 'review-status-op-b', NULL, jsonb_build_object('status', 'delivered')),
  ('21000000-0000-0000-0000-0000000000f3', '21000000-0000-0000-0000-0000000000a3', 'tracking_event_recorded', 'review-status-op-c', NULL, jsonb_build_object('status', 'delivered'));

-- Request scan: only the paid order A is enqueued.
SELECT is(public.enqueue_review_requests(100), 1,
  'review_request: only the paid order (A) is enqueued; refunded (B) + cancelled (C) are skipped');

SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE event_type = 'commerce.order.review_request'
      AND aggregate_id IN ('21000000-0000-0000-0000-0000000000a2','21000000-0000-0000-0000-0000000000a3')),
  0, 'no review_request event for the refunded/cancelled orders');

SELECT is(
  (SELECT count(*)::int FROM public.commerce_order_feedback
    WHERE order_id = '21000000-0000-0000-0000-0000000000a1'),
  1, 'paid order A has a feedback row (the effects scan can attach to it)');

-- Effects scan needs deliveries in [now()-60d, now()-14d] WITH a feedback row.
-- Re-stamp the deliveries to 30 days ago and mint feedback rows for B + C too, so
-- the ONLY thing keeping them out of the effects scan is the parent status guard.
UPDATE public.commerce_fulfillment_orders
   SET delivered_at = now() - interval '30 days'
 WHERE order_id IN ('21000000-0000-0000-0000-0000000000a1','21000000-0000-0000-0000-0000000000a2','21000000-0000-0000-0000-0000000000a3');

INSERT INTO public.commerce_order_feedback (order_id, token)
VALUES
  ('21000000-0000-0000-0000-0000000000a2', 'tok-b-effects'),
  ('21000000-0000-0000-0000-0000000000a3', 'tok-c-effects')
ON CONFLICT (order_id) DO NOTHING;

SELECT is(public.enqueue_review_effects(100), 1,
  'review_effects: only the paid order (A) is enqueued; refunded (B) + cancelled (C) are skipped');

SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE event_type = 'commerce.order.review_effects'
      AND aggregate_id = '21000000-0000-0000-0000-0000000000a1'),
  1, 'paid order A gets a commerce.order.review_effects event');

SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE event_type = 'commerce.order.review_effects'
      AND aggregate_id IN ('21000000-0000-0000-0000-0000000000a2','21000000-0000-0000-0000-0000000000a3')),
  0, 'no review_effects event for the refunded/cancelled orders');

SELECT * FROM finish();
ROLLBACK;
