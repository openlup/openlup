-- pgTAP: reorder reminders require provider/reconciliation delivery evidence.
--
-- Run via: supabase db reset && supabase test db

BEGIN;
SELECT plan(4);

INSERT INTO auth.users (id)
VALUES ('a4000000-0000-0000-0000-000000000001');

INSERT INTO public.clients (id, email, first_name, last_name)
VALUES
  ('24000000-0000-0000-0000-0000000000a1', 'reorder-ok@example.invalid', 'Reorder', 'Ok'),
  ('24000000-0000-0000-0000-0000000000a2', 'reorder-admin@example.invalid', 'Reorder', 'Admin'),
  ('24000000-0000-0000-0000-0000000000a3', 'reorder-none@example.invalid', 'Reorder', 'None');

INSERT INTO public.addresses (id, client_id, kind, line1, city, postal_code, country)
VALUES
  ('24000000-0000-0000-0000-0000000000d1', '24000000-0000-0000-0000-0000000000a1', 'shipping', 'ul. Testowa 1', 'Warszawa', '00-001', 'PL'),
  ('24000000-0000-0000-0000-0000000000d2', '24000000-0000-0000-0000-0000000000a2', 'shipping', 'ul. Testowa 2', 'Warszawa', '00-002', 'PL'),
  ('24000000-0000-0000-0000-0000000000d3', '24000000-0000-0000-0000-0000000000a3', 'shipping', 'ul. Testowa 3', 'Warszawa', '00-003', 'PL');

INSERT INTO public.providers (kind, capability, display_name, status)
VALUES ('test_carrier', 'fulfillment', 'Test Carrier', 'experimental')
ON CONFLICT (kind) DO NOTHING;

INSERT INTO public.commerce_orders (id, client_id, order_number, status, mode, currency, total_cents, subtotal_cents)
VALUES
  ('24000000-0000-0000-0000-0000000000b1', '24000000-0000-0000-0000-0000000000a1', 'REORDER-PROV-A', 'paid', 'one_time', 'PLN', 12999, 12999),
  ('24000000-0000-0000-0000-0000000000b2', '24000000-0000-0000-0000-0000000000a2', 'REORDER-PROV-B', 'paid', 'one_time', 'PLN', 12999, 12999),
  ('24000000-0000-0000-0000-0000000000b3', '24000000-0000-0000-0000-0000000000a3', 'REORDER-PROV-C', 'paid', 'one_time', 'PLN', 12999, 12999);

INSERT INTO public.commerce_fulfillment_orders (
  id, order_id, client_id, shipping_address_id, create_idempotency_key,
  status, provider_kind, shipping_address_snapshot, delivered_at)
VALUES
  ('24000000-0000-0000-0000-0000000000f1', '24000000-0000-0000-0000-0000000000b1', '24000000-0000-0000-0000-0000000000a1', '24000000-0000-0000-0000-0000000000d1', 'reorder-prov-fo-a', 'delivered', 'test_carrier', '{}'::jsonb, now() - interval '35 days'),
  ('24000000-0000-0000-0000-0000000000f2', '24000000-0000-0000-0000-0000000000b2', '24000000-0000-0000-0000-0000000000a2', '24000000-0000-0000-0000-0000000000d2', 'reorder-prov-fo-b', 'delivered', 'test_carrier', '{}'::jsonb, now() - interval '35 days'),
  ('24000000-0000-0000-0000-0000000000f3', '24000000-0000-0000-0000-0000000000b3', '24000000-0000-0000-0000-0000000000a3', '24000000-0000-0000-0000-0000000000d3', 'reorder-prov-fo-c', 'delivered', 'test_carrier', '{}'::jsonb, now() - interval '35 days');

INSERT INTO public.commerce_fulfillment_operations (
  fulfillment_order_id, order_id, operation_type, idempotency_key, actor_user_id, payload)
VALUES
  ('24000000-0000-0000-0000-0000000000f1', '24000000-0000-0000-0000-0000000000b1', 'tracking_event_recorded', 'reorder-prov-op-a', NULL, jsonb_build_object('status', 'delivered')),
  ('24000000-0000-0000-0000-0000000000f2', '24000000-0000-0000-0000-0000000000b2', 'tracking_event_recorded', 'reorder-prov-op-b', 'a4000000-0000-0000-0000-000000000001', jsonb_build_object('status', 'delivered'));

SELECT is(public.enqueue_reorder_reminders(100)->>'enqueued', '1',
  'only the provider/reconciliation delivered order is enqueued');

SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE event_type = 'commerce.order.reorder_reminder'
      AND aggregate_id = '24000000-0000-0000-0000-0000000000b1'),
  1, 'provider/reconciliation delivery keeps the old true-positive path');

SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE event_type = 'commerce.order.reorder_reminder'
      AND aggregate_id = '24000000-0000-0000-0000-0000000000b2'),
  0, 'admin-delivered fulfillment does not enqueue reorder');

SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE event_type = 'commerce.order.reorder_reminder'
      AND aggregate_id = '24000000-0000-0000-0000-0000000000b3'),
  0, 'bare delivered status without tracking evidence does not enqueue reorder');

SELECT * FROM finish();
ROLLBACK;
