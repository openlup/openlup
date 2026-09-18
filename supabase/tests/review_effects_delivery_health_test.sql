-- pgTAP: review-effects requires provider delivery and no open return/support case.
--
-- Run via: supabase db reset && supabase test db

BEGIN;
SELECT plan(7);

INSERT INTO auth.users (id)
VALUES ('a6000000-0000-0000-0000-000000000001');

INSERT INTO public.clients (id, email, first_name, last_name)
VALUES
  ('26000000-0000-0000-0000-0000000000a1', 'effects-ok@example.invalid', 'Effects', 'Ok'),
  ('26000000-0000-0000-0000-0000000000a2', 'effects-admin@example.invalid', 'Effects', 'Admin'),
  ('26000000-0000-0000-0000-0000000000a3', 'effects-return@example.invalid', 'Effects', 'Return'),
  ('26000000-0000-0000-0000-0000000000a4', 'effects-hold@example.invalid', 'Effects', 'Hold'),
  ('26000000-0000-0000-0000-0000000000a5', 'effects-boundary@example.invalid', 'Effects', 'Boundary'),
  ('26000000-0000-0000-0000-0000000000a6', 'effects-too-young@example.invalid', 'Effects', 'Young');

INSERT INTO public.addresses (id, client_id, kind, line1, city, postal_code, country)
VALUES
  ('26000000-0000-0000-0000-0000000000d1', '26000000-0000-0000-0000-0000000000a1', 'shipping', 'ul. Testowa 1', 'Warszawa', '00-001', 'PL'),
  ('26000000-0000-0000-0000-0000000000d2', '26000000-0000-0000-0000-0000000000a2', 'shipping', 'ul. Testowa 2', 'Warszawa', '00-002', 'PL'),
  ('26000000-0000-0000-0000-0000000000d3', '26000000-0000-0000-0000-0000000000a3', 'shipping', 'ul. Testowa 3', 'Warszawa', '00-003', 'PL'),
  ('26000000-0000-0000-0000-0000000000d4', '26000000-0000-0000-0000-0000000000a4', 'shipping', 'ul. Testowa 4', 'Warszawa', '00-004', 'PL');

-- Derive boundary-only locality fields from an established row in a later
-- statement so the fixture adds no deployment-specific country literal.
INSERT INTO public.addresses (id, client_id, kind, line1, city, postal_code, country)
SELECT input.*, template.value
FROM (VALUES
  ('26000000-0000-0000-0000-0000000000d5'::uuid, '26000000-0000-0000-0000-0000000000a5'::uuid, 'shipping', 'ul. Testowa 5', 'Warszawa', '00-005'),
  ('26000000-0000-0000-0000-0000000000d6'::uuid, '26000000-0000-0000-0000-0000000000a6'::uuid, 'shipping', 'ul. Testowa 6', 'Warszawa', '00-006')
) AS input(id, client_id, kind, line1, city, postal_code)
CROSS JOIN (SELECT country AS value FROM public.addresses WHERE id = '26000000-0000-0000-0000-0000000000d1') AS template;

INSERT INTO public.providers (kind, capability, display_name, status)
VALUES ('test_carrier', 'fulfillment', 'Test Carrier', 'experimental')
ON CONFLICT (kind) DO NOTHING;

INSERT INTO public.commerce_orders (id, client_id, order_number, status, mode, currency, total_cents, subtotal_cents)
VALUES
  ('26000000-0000-0000-0000-0000000000b1', '26000000-0000-0000-0000-0000000000a1', 'EFFECTS-PROV-A', 'paid', 'one_time', 'PLN', 12999, 12999),
  ('26000000-0000-0000-0000-0000000000b2', '26000000-0000-0000-0000-0000000000a2', 'EFFECTS-PROV-B', 'paid', 'one_time', 'PLN', 12999, 12999),
  ('26000000-0000-0000-0000-0000000000b3', '26000000-0000-0000-0000-0000000000a3', 'EFFECTS-PROV-C', 'paid', 'one_time', 'PLN', 12999, 12999),
  ('26000000-0000-0000-0000-0000000000b4', '26000000-0000-0000-0000-0000000000a4', 'EFFECTS-PROV-D', 'paid', 'one_time', 'PLN', 12999, 12999);

-- Keep the boundary rows in a later statement: a scalar subquery in the same
-- multi-row INSERT cannot see B1 under PostgreSQL statement-snapshot semantics.
INSERT INTO public.commerce_orders (id, client_id, order_number, status, mode, currency, total_cents, subtotal_cents)
SELECT input.id, input.client_id, input.order_number, input.status, input.mode,
  template.value, input.total_cents, input.subtotal_cents
FROM (VALUES
  ('26000000-0000-0000-0000-0000000000b5'::uuid, '26000000-0000-0000-0000-0000000000a5'::uuid, 'EFFECTS-PROV-E', 'paid', 'one_time', 12999, 12999),
  ('26000000-0000-0000-0000-0000000000b6'::uuid, '26000000-0000-0000-0000-0000000000a6'::uuid, 'EFFECTS-PROV-F', 'paid', 'one_time', 12999, 12999)
) AS input(id, client_id, order_number, status, mode, total_cents, subtotal_cents)
CROSS JOIN (SELECT currency AS value FROM public.commerce_orders WHERE id = '26000000-0000-0000-0000-0000000000b1') AS template;

INSERT INTO public.commerce_fulfillment_orders (
  id, order_id, client_id, shipping_address_id, create_idempotency_key,
  status, provider_kind, shipping_address_snapshot, delivered_at)
VALUES
  ('26000000-0000-0000-0000-0000000000f1', '26000000-0000-0000-0000-0000000000b1', '26000000-0000-0000-0000-0000000000a1', '26000000-0000-0000-0000-0000000000d1', 'effects-prov-fo-a', 'delivered', 'test_carrier', '{}'::jsonb, now() - interval '30 days'),
  ('26000000-0000-0000-0000-0000000000f2', '26000000-0000-0000-0000-0000000000b2', '26000000-0000-0000-0000-0000000000a2', '26000000-0000-0000-0000-0000000000d2', 'effects-prov-fo-b', 'delivered', 'test_carrier', '{}'::jsonb, now() - interval '30 days'),
  ('26000000-0000-0000-0000-0000000000f3', '26000000-0000-0000-0000-0000000000b3', '26000000-0000-0000-0000-0000000000a3', '26000000-0000-0000-0000-0000000000d3', 'effects-prov-fo-c', 'delivered', 'test_carrier', '{}'::jsonb, now() - interval '30 days'),
  ('26000000-0000-0000-0000-0000000000f4', '26000000-0000-0000-0000-0000000000b4', '26000000-0000-0000-0000-0000000000a4', '26000000-0000-0000-0000-0000000000d4', 'effects-prov-fo-d', 'delivered', 'test_carrier', '{}'::jsonb, now() - interval '30 days'),
  ('26000000-0000-0000-0000-0000000000f5', '26000000-0000-0000-0000-0000000000b5', '26000000-0000-0000-0000-0000000000a5', '26000000-0000-0000-0000-0000000000d5', 'effects-prov-fo-e', 'delivered', 'test_carrier', '{}'::jsonb, now() - interval '14 days'),
  ('26000000-0000-0000-0000-0000000000f6', '26000000-0000-0000-0000-0000000000b6', '26000000-0000-0000-0000-0000000000a6', '26000000-0000-0000-0000-0000000000d6', 'effects-prov-fo-f', 'delivered', 'test_carrier', '{}'::jsonb, now() - interval '13 days 23 hours');

INSERT INTO public.commerce_fulfillment_operations (
  fulfillment_order_id, order_id, operation_type, idempotency_key, actor_user_id, payload)
VALUES
  ('26000000-0000-0000-0000-0000000000f1', '26000000-0000-0000-0000-0000000000b1', 'tracking_event_recorded', 'effects-prov-op-a', NULL, jsonb_build_object('status', 'delivered')),
  ('26000000-0000-0000-0000-0000000000f2', '26000000-0000-0000-0000-0000000000b2', 'tracking_event_recorded', 'effects-prov-op-b', 'a6000000-0000-0000-0000-000000000001', jsonb_build_object('status', 'delivered')),
  ('26000000-0000-0000-0000-0000000000f3', '26000000-0000-0000-0000-0000000000b3', 'tracking_event_recorded', 'effects-prov-op-c', NULL, jsonb_build_object('status', 'delivered')),
  ('26000000-0000-0000-0000-0000000000f4', '26000000-0000-0000-0000-0000000000b4', 'tracking_event_recorded', 'effects-prov-op-d', NULL, jsonb_build_object('status', 'delivered')),
  ('26000000-0000-0000-0000-0000000000f5', '26000000-0000-0000-0000-0000000000b5', 'tracking_event_recorded', 'effects-prov-op-e', NULL, jsonb_build_object('status', 'delivered')),
  ('26000000-0000-0000-0000-0000000000f6', '26000000-0000-0000-0000-0000000000b6', 'tracking_event_recorded', 'effects-prov-op-f', NULL, jsonb_build_object('status', 'delivered'));

INSERT INTO public.commerce_order_feedback (order_id, token)
VALUES
  ('26000000-0000-0000-0000-0000000000b1', 'tok-effects-a'),
  ('26000000-0000-0000-0000-0000000000b2', 'tok-effects-b'),
  ('26000000-0000-0000-0000-0000000000b3', 'tok-effects-c'),
  ('26000000-0000-0000-0000-0000000000b4', 'tok-effects-d'),
  ('26000000-0000-0000-0000-0000000000b5', 'tok-effects-e'),
  ('26000000-0000-0000-0000-0000000000b6', 'tok-effects-f');

INSERT INTO public.commerce_return_requests (id, order_id, fulfillment_order_id, status, reason_code, idempotency_key)
VALUES ('26000000-0000-0000-0000-0000000000c3', '26000000-0000-0000-0000-0000000000b3', '26000000-0000-0000-0000-0000000000f3', 'requested', 'pet_refused', 'effects-return-open');

INSERT INTO public.commerce_order_holds (order_id, status, reason, note, idempotency_key)
VALUES ('26000000-0000-0000-0000-0000000000b4', 'active', 'manual_support', 'customer reported a problem', 'effects-hold-open');

SELECT is(public.enqueue_review_effects(100), 2,
  'only provider-delivered healthy orders at least 14 days old are enqueued');

SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE event_type = 'commerce.order.review_effects'
      AND aggregate_id = '26000000-0000-0000-0000-0000000000b1'),
  1, 'provider/reconciliation delivery keeps the old true-positive path');

SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE event_type = 'commerce.order.review_effects'
      AND aggregate_id = '26000000-0000-0000-0000-0000000000b2'),
  0, 'admin-delivered fulfillment does not enqueue review_effects');

SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE event_type = 'commerce.order.review_effects'
      AND aggregate_id = '26000000-0000-0000-0000-0000000000b3'),
  0, 'open return suppresses the effects ask');

SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE event_type = 'commerce.order.review_effects'
      AND aggregate_id = '26000000-0000-0000-0000-0000000000b4'),
  0, 'active support hold suppresses the effects ask');

SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE event_type = 'commerce.order.review_effects'
      AND aggregate_id = '26000000-0000-0000-0000-0000000000b5'),
  1, 'a provider-confirmed delivery exactly 14 days old is eligible');

SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE event_type = 'commerce.order.review_effects'
      AND aggregate_id = '26000000-0000-0000-0000-0000000000b6'),
  0, 'a provider-confirmed delivery just below 14 days old is not eligible');

SELECT * FROM finish();
ROLLBACK;
