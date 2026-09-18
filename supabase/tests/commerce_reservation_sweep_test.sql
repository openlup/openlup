-- pgTAP: product-agnostic expired reservation sweep.
--
-- Run via: supabase db reset && supabase test db

BEGIN;
SELECT plan(15);

INSERT INTO public.clients (id, email)
VALUES ('11111111-1111-4111-8111-111111111111', 'reservation-sweep@example.invalid');

INSERT INTO public.catalog_products (id, slug, name, status)
VALUES
  ('22222222-2222-4222-8222-222222222221', 'generic-alpha', 'Generic Alpha', 'active'),
  ('22222222-2222-4222-8222-222222222222', 'generic-beta', 'Generic Beta', 'active');

INSERT INTO public.catalog_skus (id, product_id, sku, title, pet_type, status, net_weight_g, kcal_per_unit)
VALUES
  ('33333333-3333-4333-8333-333333333331', '22222222-2222-4222-8222-222222222221', 'GENERIC-ALPHA', 'Generic Alpha', 'other', 'active', 1, 1),
  ('33333333-3333-4333-8333-333333333332', '22222222-2222-4222-8222-222222222222', 'GENERIC-BETA', 'Generic Beta', 'other', 'active', 1, 1);

INSERT INTO public.inventory_locations (id, code, display_name, kind, status, fulfillable)
VALUES ('44444444-4444-4444-8444-444444444444', 'generic-reservation-sweep', 'Generic reservation sweep', 'virtual', 'active', true);

INSERT INTO public.inventory_balances (id, sku_id, location_id, on_hand, reserved)
VALUES
  ('55555555-5555-4555-8555-555555555551', '33333333-3333-4333-8333-333333333331', '44444444-4444-4444-8444-444444444444', 10, 1),
  ('55555555-5555-4555-8555-555555555552', '33333333-3333-4333-8333-333333333332', '44444444-4444-4444-8444-444444444444', 10, 2);

-- A: expired unpaid one-time checkout hold.
INSERT INTO public.commerce_orders (id, client_id, status, currency, region_code, mode, size_constraint, total_cents, subtotal_cents)
VALUES ('66666666-6666-4666-8666-666666666661', '11111111-1111-4111-8111-111111111111',
        'draft', 'PLN', 'PL', 'one_time', '{"kind":"unit_count","value":1}'::jsonb, 1000, 1000);
INSERT INTO public.commerce_order_items (id, order_id, sku_id, quantity, unit_price_cents, total_cents, discount_allocated_cents, effective_total_cents, effective_net_cents, product_snapshot)
VALUES ('77777777-7777-4777-8777-777777777771', '66666666-6666-4666-8666-666666666661',
        '33333333-3333-4333-8333-333333333331', 1, 1000, 1000, 0, 1000, round((1000)::numeric * 10000 / (10000 + (800)::integer))::integer, '{"sku":"GENERIC-ALPHA"}'::jsonb);
CREATE TEMP TABLE _a_intent AS
SELECT (public.commerce_payment_control_create_intent(
  'reservation-sweep-a-intent', 'one_time_order', '66666666-6666-4666-8666-666666666661',
  NULL, NULL, 1000, 'PLN', '{}'::jsonb
) -> 'paymentIntent' ->> 'id')::uuid AS intent_id;
SELECT public.commerce_payment_control_record_attempt(
  'reservation-sweep-a-attempt', (SELECT intent_id FROM _a_intent),
  'stripe', 'provider-a', 'session-a', 'processing', NULL, '{}'::jsonb, '{}'::jsonb);
INSERT INTO public.inventory_reservations (
  id, idempotency_key, order_id, order_item_id, sku_id, location_id, quantity, status, kind, expires_at
) VALUES (
  '88888888-8888-4888-8888-888888888881', 'reservation-sweep-a-reservation',
  '66666666-6666-4666-8666-666666666661', '77777777-7777-4777-8777-777777777771',
  '33333333-3333-4333-8333-333333333331', '44444444-4444-4444-8444-444444444444',
  1, 'reserved', 'checkout_payment_window', '2026-06-16T08:00:00Z'
);

-- B: paid order with an old expiry must stay pinned/untouched.
INSERT INTO public.commerce_orders (id, client_id, status, currency, region_code, mode, size_constraint, total_cents, subtotal_cents)
VALUES ('66666666-6666-4666-8666-666666666662', '11111111-1111-4111-8111-111111111111',
        'paid', 'PLN', 'PL', 'one_time', '{"kind":"unit_count","value":2}'::jsonb, 2000, 2000);
INSERT INTO public.commerce_order_items (id, order_id, sku_id, quantity, unit_price_cents, total_cents, discount_allocated_cents, effective_total_cents, effective_net_cents, product_snapshot)
VALUES ('77777777-7777-4777-8777-777777777772', '66666666-6666-4666-8666-666666666662',
        '33333333-3333-4333-8333-333333333332', 2, 1000, 2000, 0, 2000, round((2000)::numeric * 10000 / (10000 + (800)::integer))::integer, '{"sku":"GENERIC-BETA"}'::jsonb);
INSERT INTO public.inventory_reservations (
  id, idempotency_key, order_id, order_item_id, sku_id, location_id, quantity, status, kind, expires_at
) VALUES (
  '88888888-8888-4888-8888-888888888882', 'reservation-sweep-b-reservation',
  '66666666-6666-4666-8666-666666666662', '77777777-7777-4777-8777-777777777772',
  '33333333-3333-4333-8333-333333333332', '44444444-4444-4444-8444-444444444444',
  1, 'reserved', 'checkout_payment_window', '2026-06-16T08:00:00Z'
);

-- C: consumed reservation is ignored even if it has an old expiry.
INSERT INTO public.commerce_orders (id, client_id, status, currency, region_code, mode, size_constraint, total_cents, subtotal_cents)
VALUES ('66666666-6666-4666-8666-666666666663', '11111111-1111-4111-8111-111111111111',
        'fulfilled', 'PLN', 'PL', 'one_time', '{"kind":"unit_count","value":1}'::jsonb, 1000, 1000);
INSERT INTO public.commerce_order_items (id, order_id, sku_id, quantity, unit_price_cents, total_cents, discount_allocated_cents, effective_total_cents, effective_net_cents, product_snapshot)
VALUES ('77777777-7777-4777-8777-777777777773', '66666666-6666-4666-8666-666666666663',
        '33333333-3333-4333-8333-333333333331', 1, 1000, 1000, 0, 1000, round((1000)::numeric * 10000 / (10000 + (800)::integer))::integer, '{"sku":"GENERIC-ALPHA"}'::jsonb);
INSERT INTO public.inventory_reservations (
  id, idempotency_key, order_id, order_item_id, sku_id, location_id, quantity, status, kind, expires_at, consumed_at
) VALUES (
  '88888888-8888-4888-8888-888888888883', 'reservation-sweep-c-reservation',
  '66666666-6666-4666-8666-666666666663', '77777777-7777-4777-8777-777777777773',
  '33333333-3333-4333-8333-333333333331', '44444444-4444-4444-8444-444444444444',
  1, 'consumed', 'checkout_payment_window', '2026-06-16T08:00:00Z', '2026-06-16T09:00:00Z'
);

-- D: pending provisional subscription is left to subscription_sweep_unpaid_provisional.
INSERT INTO public.pets (id, client_id, pet_type)
VALUES ('99999999-9999-4999-8999-999999999991', '11111111-1111-4111-8111-111111111111', 'dog');
INSERT INTO public.addresses (id, client_id, kind, line1, city, postal_code)
VALUES ('99999999-9999-4999-8999-999999999992', '11111111-1111-4111-8111-111111111111', 'shipping', 'Testowa 1', 'Warszawa', '00-001');
INSERT INTO public.commerce_orders (id, client_id, status, currency, region_code, mode, size_constraint, total_cents, subtotal_cents)
VALUES ('66666666-6666-4666-8666-666666666664', '11111111-1111-4111-8111-111111111111',
        'draft', 'PLN', 'PL', 'one_time', '{"kind":"feeding_days","value":14}'::jsonb, 1000, 1000);
INSERT INTO public.commerce_order_items (id, order_id, sku_id, quantity, unit_price_cents, total_cents, discount_allocated_cents, effective_total_cents, effective_net_cents, product_snapshot)
VALUES ('77777777-7777-4777-8777-777777777774', '66666666-6666-4666-8666-666666666664',
        '33333333-3333-4333-8333-333333333331', 1, 1000, 1000, 0, 1000, round((1000)::numeric * 10000 / (10000 + (800)::integer))::integer, '{"sku":"GENERIC-ALPHA"}'::jsonb);
CREATE TEMP TABLE _sub AS
SELECT (r->>'subscriptionId')::uuid AS sub_id, (r->>'subscriptionCycleId')::uuid AS cycle_id
FROM (SELECT public.subscription_create_provisional_for_checkout(
  '66666666-6666-4666-8666-666666666664',
  '11111111-1111-4111-8111-111111111111',
  '99999999-9999-4999-8999-999999999991',
  '99999999-9999-4999-8999-999999999992',
  '{"quote":{"context":{"mode":"subscription","cadenceDays":14}}}'::jsonb
) AS r) created;
UPDATE public.commerce_orders
   SET mode = 'subscription_cycle',
       subscription_id = (SELECT sub_id FROM _sub),
       subscription_cycle_id = (SELECT cycle_id FROM _sub),
       status = 'pending_payment'
 WHERE id = '66666666-6666-4666-8666-666666666664';
INSERT INTO public.inventory_reservations (
  id, idempotency_key, order_id, order_item_id, subscription_cycle_id, sku_id, location_id, quantity, status, kind, expires_at
) VALUES (
  '88888888-8888-4888-8888-888888888884', 'reservation-sweep-d-reservation',
  '66666666-6666-4666-8666-666666666664', '77777777-7777-4777-8777-777777777774', (SELECT cycle_id FROM _sub),
  '33333333-3333-4333-8333-333333333331', '44444444-4444-4444-8444-444444444444',
  1, 'reserved', 'checkout_payment_window', '2026-06-16T08:00:00Z'
);

CREATE TEMP TABLE _sweep AS
SELECT public.commerce_sweep_expired_reservation_holds(
  'reservation-sweep-test',
  '2026-06-16T10:00:00Z'::timestamptz,
  50
) AS result;

SELECT is((SELECT status FROM public.commerce_orders WHERE id='66666666-6666-4666-8666-666666666661'),
  'expired', 'expired unpaid order is marked expired');
SELECT is((SELECT status FROM public.commerce_payment_intents WHERE id=(SELECT intent_id FROM _a_intent)),
  'cancelled', 'expired unpaid intent is terminally cancelled to close late-success race');
SELECT is((SELECT status FROM public.commerce_payment_attempts WHERE payment_intent_id=(SELECT intent_id FROM _a_intent)),
  'expired', 'expired unpaid attempt is marked expired');
SELECT is((SELECT status FROM public.commerce_payments WHERE order_id='66666666-6666-4666-8666-666666666661'),
  'expired', 'expired unpaid payment is marked expired');
SELECT is((SELECT status FROM public.inventory_reservations WHERE id='88888888-8888-4888-8888-888888888881'),
  'released', 'expired unpaid reservation is released');
SELECT is((SELECT count(*)::int FROM public.outbox_events
            WHERE event_type='commerce.payment.failed'
              AND aggregate_id='66666666-6666-4666-8666-666666666661'),
  0, 'expired unpaid order does not emit commerce.payment.failed event');
SELECT is((SELECT idempotency_key FROM public.outbox_events
            WHERE event_type='commerce.checkout.expired'
              AND aggregate_id='66666666-6666-4666-8666-666666666661'),
  'checkout_expired:66666666-6666-4666-8666-666666666661',
  'expired unpaid order uses checkout_expired:<order id> idempotency');
SELECT is((SELECT reserved FROM public.inventory_balances WHERE id='55555555-5555-4555-8555-555555555551'),
  0, 'released reservation decrements reserved balance exactly once');

SELECT is((SELECT status FROM public.commerce_orders WHERE id='66666666-6666-4666-8666-666666666662'),
  'paid', 'paid order with old reservation expiry is untouched');
SELECT is((SELECT status FROM public.inventory_reservations WHERE id='88888888-8888-4888-8888-888888888882'),
  'reserved', 'paid order reservation remains reserved');
SELECT is((SELECT status FROM public.inventory_reservations WHERE id='88888888-8888-4888-8888-888888888883'),
  'consumed', 'consumed reservation is ignored');
SELECT is((SELECT status FROM public.inventory_reservations WHERE id='88888888-8888-4888-8888-888888888884'),
  'reserved', 'pending provisional subscription reservation is left to subscription sweep');

SELECT is((SELECT (result #>> '{sweep,ordersExpired}')::int FROM _sweep), 1, 'sweep expires exactly one order');
SELECT is((SELECT (result #>> '{sweep,reservationsReleased}')::int FROM _sweep), 1, 'sweep releases exactly one reservation');

CREATE TEMP TABLE _replay AS
SELECT public.commerce_sweep_expired_reservation_holds(
  'reservation-sweep-test',
  '2026-06-16T10:00:00Z'::timestamptz,
  50
) AS result;
SELECT is((SELECT reserved FROM public.inventory_balances WHERE id='55555555-5555-4555-8555-555555555551'),
  0, 'replay does not decrement reserved balance twice');

SELECT * FROM finish();
ROLLBACK;
