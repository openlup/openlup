-- pgTAP: enqueue_review_requests honours BOTH window bounds (20260630120000).
--   * a delivery inside [now()-30d, now()-3d] is enqueued exactly once;
--   * a delivery older than the 30d upper bound is NOT enqueued (no
--     full-history flood on first enablement);
--   * the in-window order gets a commerce_order_feedback row + a
--     commerce.order.review_request outbox event; the stale one gets neither.
--
-- Run via: supabase db reset && supabase test db

BEGIN;
SELECT plan(4);

INSERT INTO public.clients (id, email, first_name, last_name)
VALUES ('20000000-0000-0000-0000-0000000000a0', 'review-window@example.invalid', 'Rev', 'Window');

INSERT INTO public.addresses (id, client_id, kind, line1, city, postal_code, country)
VALUES ('20000000-0000-0000-0000-0000000000d0', '20000000-0000-0000-0000-0000000000a0',
        'shipping', 'ul. Testowa 2', 'Warszawa', '00-002', 'PL');

INSERT INTO public.providers (kind, capability, display_name, status)
VALUES ('test_carrier', 'fulfillment', 'Test Carrier', 'experimental')
ON CONFLICT (kind) DO NOTHING;

-- Order A: delivered 10 days ago -> inside the window -> eligible.
INSERT INTO public.commerce_orders (id, client_id, order_number, status, mode, currency, total_cents, subtotal_cents)
VALUES ('20000000-0000-0000-0000-0000000000a1', '20000000-0000-0000-0000-0000000000a0',
        'REVIEW-WINDOW-A', 'paid', 'one_time', 'PLN', 12999, 12999);
INSERT INTO public.commerce_fulfillment_orders (
  id, order_id, client_id, shipping_address_id, create_idempotency_key,
  status, provider_kind, shipping_address_snapshot, delivered_at)
VALUES (
  '20000000-0000-0000-0000-0000000000f1', '20000000-0000-0000-0000-0000000000a1',
  '20000000-0000-0000-0000-0000000000a0', '20000000-0000-0000-0000-0000000000d0',
  'review-fo-a', 'delivered', 'test_carrier', '{}'::jsonb, now() - interval '10 days');

-- Order B: delivered 45 days ago -> past the 30d upper bound -> NOT eligible.
INSERT INTO public.commerce_orders (id, client_id, order_number, status, mode, currency, total_cents, subtotal_cents)
VALUES ('20000000-0000-0000-0000-0000000000a2', '20000000-0000-0000-0000-0000000000a0',
        'REVIEW-WINDOW-B', 'paid', 'one_time', 'PLN', 12999, 12999);
INSERT INTO public.commerce_fulfillment_orders (
  id, order_id, client_id, shipping_address_id, create_idempotency_key,
  status, provider_kind, shipping_address_snapshot, delivered_at)
VALUES (
  '20000000-0000-0000-0000-0000000000f2', '20000000-0000-0000-0000-0000000000a2',
  '20000000-0000-0000-0000-0000000000a0', '20000000-0000-0000-0000-0000000000d0',
  'review-fo-b', 'delivered', 'test_carrier', '{}'::jsonb, now() - interval '45 days');

INSERT INTO public.commerce_fulfillment_operations (
  fulfillment_order_id, order_id, operation_type, idempotency_key, actor_user_id, payload)
VALUES
  ('20000000-0000-0000-0000-0000000000f1', '20000000-0000-0000-0000-0000000000a1', 'tracking_event_recorded', 'review-window-op-a', NULL, jsonb_build_object('status', 'delivered')),
  ('20000000-0000-0000-0000-0000000000f2', '20000000-0000-0000-0000-0000000000a2', 'tracking_event_recorded', 'review-window-op-b', NULL, jsonb_build_object('status', 'delivered'));

-- Scan: only the in-window delivery is enqueued.
SELECT is(public.enqueue_review_requests(100), 1,
  'only the in-window delivery (A) is enqueued; the 45d-old one (B) is skipped');

SELECT is(
  (SELECT count(*)::int FROM public.commerce_order_feedback
    WHERE order_id = '20000000-0000-0000-0000-0000000000a1'),
  1, 'in-window order A gets a feedback row');

SELECT is(
  (SELECT count(*)::int FROM public.commerce_order_feedback
    WHERE order_id = '20000000-0000-0000-0000-0000000000a2'),
  0, 'stale order B (delivered 45d ago) gets NO feedback row');

SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE event_type = 'commerce.order.review_request'
      AND aggregate_id = '20000000-0000-0000-0000-0000000000a1'),
  1, 'in-window order A gets a commerce.order.review_request outbox event');

SELECT * FROM finish();
ROLLBACK;
