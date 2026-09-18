-- pgTAP: review requests require provider/reconciliation delivery evidence.
--
-- Run via: supabase db reset && supabase test db

BEGIN;
SELECT plan(4);

INSERT INTO auth.users (id)
VALUES ('a5000000-0000-0000-0000-000000000001');

INSERT INTO public.clients (id, email, first_name, last_name)
VALUES
  ('25000000-0000-0000-0000-0000000000a1', 'review-ok@example.invalid', 'Review', 'Ok'),
  ('25000000-0000-0000-0000-0000000000a2', 'review-admin@example.invalid', 'Review', 'Admin'),
  ('25000000-0000-0000-0000-0000000000a3', 'review-none@example.invalid', 'Review', 'None');

INSERT INTO public.addresses (id, client_id, kind, line1, city, postal_code, country)
VALUES
  ('25000000-0000-0000-0000-0000000000d1', '25000000-0000-0000-0000-0000000000a1', 'shipping', 'ul. Testowa 1', 'Warszawa', '00-001', 'PL'),
  ('25000000-0000-0000-0000-0000000000d2', '25000000-0000-0000-0000-0000000000a2', 'shipping', 'ul. Testowa 2', 'Warszawa', '00-002', 'PL'),
  ('25000000-0000-0000-0000-0000000000d3', '25000000-0000-0000-0000-0000000000a3', 'shipping', 'ul. Testowa 3', 'Warszawa', '00-003', 'PL');

INSERT INTO public.providers (kind, capability, display_name, status)
VALUES ('test_carrier', 'fulfillment', 'Test Carrier', 'experimental')
ON CONFLICT (kind) DO NOTHING;

INSERT INTO public.commerce_orders (id, client_id, order_number, status, mode, currency, total_cents, subtotal_cents)
VALUES
  ('25000000-0000-0000-0000-0000000000b1', '25000000-0000-0000-0000-0000000000a1', 'REVIEW-PROV-A', 'paid', 'one_time', 'PLN', 12999, 12999),
  ('25000000-0000-0000-0000-0000000000b2', '25000000-0000-0000-0000-0000000000a2', 'REVIEW-PROV-B', 'paid', 'one_time', 'PLN', 12999, 12999),
  ('25000000-0000-0000-0000-0000000000b3', '25000000-0000-0000-0000-0000000000a3', 'REVIEW-PROV-C', 'paid', 'one_time', 'PLN', 12999, 12999);

INSERT INTO public.commerce_fulfillment_orders (
  id, order_id, client_id, shipping_address_id, create_idempotency_key,
  status, provider_kind, shipping_address_snapshot, delivered_at)
VALUES
  ('25000000-0000-0000-0000-0000000000f1', '25000000-0000-0000-0000-0000000000b1', '25000000-0000-0000-0000-0000000000a1', '25000000-0000-0000-0000-0000000000d1', 'review-prov-fo-a', 'delivered', 'test_carrier', '{}'::jsonb, now() - interval '10 days'),
  ('25000000-0000-0000-0000-0000000000f2', '25000000-0000-0000-0000-0000000000b2', '25000000-0000-0000-0000-0000000000a2', '25000000-0000-0000-0000-0000000000d2', 'review-prov-fo-b', 'delivered', 'test_carrier', '{}'::jsonb, now() - interval '10 days'),
  ('25000000-0000-0000-0000-0000000000f3', '25000000-0000-0000-0000-0000000000b3', '25000000-0000-0000-0000-0000000000a3', '25000000-0000-0000-0000-0000000000d3', 'review-prov-fo-c', 'delivered', 'test_carrier', '{}'::jsonb, now() - interval '10 days');

INSERT INTO public.commerce_fulfillment_operations (
  fulfillment_order_id, order_id, operation_type, idempotency_key, actor_user_id, payload)
VALUES
  ('25000000-0000-0000-0000-0000000000f1', '25000000-0000-0000-0000-0000000000b1', 'tracking_event_recorded', 'review-prov-op-a', NULL, jsonb_build_object('status', 'delivered')),
  ('25000000-0000-0000-0000-0000000000f2', '25000000-0000-0000-0000-0000000000b2', 'tracking_event_recorded', 'review-prov-op-b', 'a5000000-0000-0000-0000-000000000001', jsonb_build_object('status', 'delivered'));

SELECT is(public.enqueue_review_requests(100), 1,
  'only the provider/reconciliation delivered order is enqueued');

SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE event_type = 'commerce.order.review_request'
      AND aggregate_id = '25000000-0000-0000-0000-0000000000b1'),
  1, 'provider/reconciliation delivery keeps the old true-positive path');

SELECT is(
  (SELECT count(*)::int FROM public.commerce_order_feedback
    WHERE order_id = '25000000-0000-0000-0000-0000000000b2'),
  0, 'admin-delivered fulfillment does not consume a review token');

SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE event_type = 'commerce.order.review_request'
      AND aggregate_id = '25000000-0000-0000-0000-0000000000b3'),
  0, 'bare delivered status without tracking evidence does not enqueue review_request');

SELECT * FROM finish();
ROLLBACK;
