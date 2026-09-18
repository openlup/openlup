-- pgTAP: Model B — subscription_confirm_provisional_from_paid_cycle (20260610160000,
-- extended by 20260711144000 for the OBS-1 / CJ01-T payment-method-ref mirror).
--   * confirm flips pending_activation -> active, binds the mandate, sets
--     next_cycle_at = paid_at + cadence (paid-time basis), emits an event
--   * a second confirm is an idempotent replay (status active, replayed=true)
--   * a NULL mandate returns 'awaiting_mandate' and leaves the subscription provisional
--   * confirming a terminal (cancelled) subscription is rejected
--   * a pre-existing client-scoped commerce_payment_method_refs row matching the
--     bound provider_method_ref/method_kind is mirrored onto subscription scope
--     on activation (20260711144000 — this is the actual CJ01-T fix)
--   * activation succeeds even when no matching payment_method_refs row exists
--     (the mirror is best-effort, never blocks activation)
--
-- Run via: supabase test db

BEGIN;
SELECT plan(12);

-- ---- Shared fixture -------------------------------------------------------
INSERT INTO public.clients (id, email)
VALUES ('11111111-1111-1111-1111-111111111111', 'modelb-confirm@example.invalid');
INSERT INTO public.pets (id, client_id, pet_type)
VALUES ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'dog');
INSERT INTO public.addresses (id, client_id, kind, line1, city, postal_code)
VALUES ('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', 'shipping', 'Testowa 1', 'Warszawa', '00-001');
INSERT INTO public.catalog_products (id, slug, name, status)
VALUES ('44444444-4444-4444-4444-444444444444', 'modelb-confirm-prod', 'Confirm Prod', 'active');
INSERT INTO public.catalog_skus (id, product_id, sku, title, pet_type, net_weight_g, kcal_per_unit, status)
VALUES ('55555555-5555-5555-5555-555555555555', '44444444-4444-4444-4444-444444444444', 'CONF-SKU-1', 'Conf SKU 1', 'dog', 400, 350, 'active');

-- ---- Build a paid subscription_cycle order via the provisional helper ------
-- Subscription A (happy path).
INSERT INTO public.commerce_orders (id, client_id, currency, region_code, size_constraint, status)
VALUES ('77777777-7777-7777-7777-777777777777', '11111111-1111-1111-1111-111111111111', 'PLN', 'PL', '{"kind":"feeding_days","value":21}'::jsonb, 'draft');
INSERT INTO public.commerce_order_items (id, order_id, sku_id, quantity, unit_price_cents, total_cents, discount_allocated_cents, effective_total_cents, effective_net_cents, product_snapshot)
VALUES ('88888888-8888-8888-8888-888888888888', '77777777-7777-7777-7777-777777777777', '55555555-5555-5555-5555-555555555555', 2, 1340, 2680, 0, 2680, round((2680)::numeric * 10000 / (10000 + (800)::integer))::integer, '{"sku":"CONF-SKU-1"}'::jsonb);

CREATE TEMP TABLE _a AS
SELECT public.subscription_create_provisional_for_checkout(
  '77777777-7777-7777-7777-777777777777','11111111-1111-1111-1111-111111111111',
  '22222222-2222-2222-2222-222222222222','33333333-3333-3333-3333-333333333333',
  '{"quote":{"context":{"mode":"subscription","cadenceDays":21}}}'::jsonb) AS r;

UPDATE public.commerce_orders
   SET mode='subscription_cycle', status='paid',
       subscription_id=(SELECT (r->>'subscriptionId')::uuid FROM _a),
       subscription_cycle_id=(SELECT (r->>'subscriptionCycleId')::uuid FROM _a)
 WHERE id='77777777-7777-7777-7777-777777777777';

INSERT INTO public.commerce_payments (id, order_id, provider, amount_cents, currency, status)
VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '77777777-7777-7777-7777-777777777777', 'stripe', 2680, 'PLN', 'succeeded');
INSERT INTO public.commerce_payment_intents (id, target_kind, order_id, subscription_id, subscription_cycle_id, payment_id, amount_cents, currency, status)
VALUES ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'subscription_cycle', '77777777-7777-7777-7777-777777777777',
        (SELECT (r->>'subscriptionId')::uuid FROM _a), (SELECT (r->>'subscriptionCycleId')::uuid FROM _a),
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 2680, 'PLN', 'succeeded');

-- ---- A: confirm activates ------------------------------------------------
CREATE TEMP TABLE _ca AS
SELECT public.subscription_confirm_provisional_from_paid_cycle(
  'confirm-a-idem-key', '77777777-7777-7777-7777-777777777777', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  'pm_test_a', 'card', '2026-06-10T12:00:00Z'::timestamptz) AS r;

SELECT is((SELECT r#>>'{subscriptionConfirmation,status}' FROM _ca), 'active', 'confirm returns active');
SELECT is(
  (SELECT status FROM public.subscriptions WHERE id=(SELECT (r->>'subscriptionId')::uuid FROM _a)),
  'active', 'subscription flipped to active');
SELECT is(
  (SELECT next_cycle_at FROM public.subscriptions WHERE id=(SELECT (r->>'subscriptionId')::uuid FROM _a)),
  '2026-07-01T12:00:00Z'::timestamptz, 'next_cycle_at = paid_at + 21 days (paid-time basis)');
SELECT is(
  (SELECT payment_method_ref FROM public.subscriptions WHERE id=(SELECT (r->>'subscriptionId')::uuid FROM _a)),
  'pm_test_a', 'mandate bound onto the subscription');

-- A: replay is idempotent.
SELECT is(
  (SELECT (public.subscription_confirm_provisional_from_paid_cycle(
     'confirm-a-idem-key', '77777777-7777-7777-7777-777777777777', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
     'pm_test_a', 'card', '2026-06-10T12:00:00Z'::timestamptz)) #>> '{subscriptionConfirmation,replayed}'),
  'true', 'second confirm is an idempotent replay');

-- ---- B: awaiting_mandate when method_ref is null --------------------------
INSERT INTO public.commerce_orders (id, client_id, currency, region_code, size_constraint, status)
VALUES ('cccccccc-cccc-cccc-cccc-cccccccccccc', '11111111-1111-1111-1111-111111111111', 'PLN', 'PL', '{"kind":"feeding_days","value":21}'::jsonb, 'draft');
INSERT INTO public.commerce_order_items (id, order_id, sku_id, quantity, unit_price_cents, total_cents, discount_allocated_cents, effective_total_cents, effective_net_cents, product_snapshot)
VALUES ('dddddddd-dddd-dddd-dddd-dddddddddddd', 'cccccccc-cccc-cccc-cccc-cccccccccccc', '55555555-5555-5555-5555-555555555555', 1, 1340, 1340, 0, 1340, round((1340)::numeric * 10000 / (10000 + (800)::integer))::integer, '{"sku":"CONF-SKU-1"}'::jsonb);

CREATE TEMP TABLE _b AS
SELECT public.subscription_create_provisional_for_checkout(
  'cccccccc-cccc-cccc-cccc-cccccccccccc','11111111-1111-1111-1111-111111111111',
  '22222222-2222-2222-2222-222222222222','33333333-3333-3333-3333-333333333333',
  '{"quote":{"context":{"mode":"subscription","cadenceDays":21}}}'::jsonb) AS r;

UPDATE public.commerce_orders
   SET mode='subscription_cycle', status='paid',
       subscription_id=(SELECT (r->>'subscriptionId')::uuid FROM _b),
       subscription_cycle_id=(SELECT (r->>'subscriptionCycleId')::uuid FROM _b)
 WHERE id='cccccccc-cccc-cccc-cccc-cccccccccccc';
INSERT INTO public.commerce_payments (id, order_id, provider, amount_cents, currency, status)
VALUES ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'tpay', 1340, 'PLN', 'succeeded');
INSERT INTO public.commerce_payment_intents (id, target_kind, order_id, subscription_id, subscription_cycle_id, payment_id, amount_cents, currency, status)
VALUES ('ffffffff-ffff-ffff-ffff-ffffffffffff', 'subscription_cycle', 'cccccccc-cccc-cccc-cccc-cccccccccccc',
        (SELECT (r->>'subscriptionId')::uuid FROM _b), (SELECT (r->>'subscriptionCycleId')::uuid FROM _b),
        'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 1340, 'PLN', 'succeeded');

SELECT is(
  (SELECT (public.subscription_confirm_provisional_from_paid_cycle(
     'confirm-b-idem-key', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'ffffffff-ffff-ffff-ffff-ffffffffffff',
     NULL, NULL, '2026-06-10T12:00:00Z'::timestamptz)) #>> '{subscriptionConfirmation,status}'),
  'awaiting_mandate', 'null mandate -> awaiting_mandate (not activated)');
SELECT is(
  (SELECT status FROM public.subscriptions WHERE id=(SELECT (r->>'subscriptionId')::uuid FROM _b)),
  'pending_activation', 'subscription stays provisional while awaiting mandate');

-- B: a terminal (cancelled) subscription cannot be confirmed.
UPDATE public.subscriptions SET status='cancelled' WHERE id=(SELECT (r->>'subscriptionId')::uuid FROM _b);
SELECT throws_ok(
  $$SELECT public.subscription_confirm_provisional_from_paid_cycle(
     'confirm-b-idem-key', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'ffffffff-ffff-ffff-ffff-ffffffffffff',
     'pm_test_b', 'blik', '2026-06-10T12:00:00Z'::timestamptz)$$,
  '22023', NULL, 'confirming a terminal subscription is rejected');

-- ---- C: activation mirrors a pre-existing client-scoped payment_method_ref ------
-- This reproduces the OBS-1 / CJ01-T shape: Stripe's webhook method-ref upsert
-- writes a CLIENT-scoped row (subscription_id NULL) before confirm ever runs,
-- because Stripe metadata never carries subscriptionId on initial activation.
INSERT INTO public.commerce_orders (id, client_id, currency, region_code, size_constraint, status)
VALUES ('99999999-9999-9999-9999-999999999999', '11111111-1111-1111-1111-111111111111', 'PLN', 'PL', '{"kind":"feeding_days","value":21}'::jsonb, 'draft');
INSERT INTO public.commerce_order_items (id, order_id, sku_id, quantity, unit_price_cents, total_cents, discount_allocated_cents, effective_total_cents, effective_net_cents, product_snapshot)
VALUES ('10101010-1010-1010-1010-101010101010', '99999999-9999-9999-9999-999999999999', '55555555-5555-5555-5555-555555555555', 1, 1340, 1340, 0, 1340, round((1340)::numeric * 10000 / (10000 + (800)::integer))::integer, '{"sku":"CONF-SKU-1"}'::jsonb);

CREATE TEMP TABLE _c AS
SELECT public.subscription_create_provisional_for_checkout(
  '99999999-9999-9999-9999-999999999999','11111111-1111-1111-1111-111111111111',
  '22222222-2222-2222-2222-222222222222','33333333-3333-3333-3333-333333333333',
  '{"quote":{"context":{"mode":"subscription","cadenceDays":21}}}'::jsonb) AS r;

UPDATE public.commerce_orders
   SET mode='subscription_cycle', status='paid',
       subscription_id=(SELECT (r->>'subscriptionId')::uuid FROM _c),
       subscription_cycle_id=(SELECT (r->>'subscriptionCycleId')::uuid FROM _c)
 WHERE id='99999999-9999-9999-9999-999999999999';

INSERT INTO public.commerce_payments (id, order_id, provider, amount_cents, currency, status)
VALUES ('20202020-2020-2020-2020-202020202020', '99999999-9999-9999-9999-999999999999', 'stripe', 1340, 'PLN', 'succeeded');
INSERT INTO public.commerce_payment_intents (id, target_kind, order_id, subscription_id, subscription_cycle_id, payment_id, amount_cents, currency, status)
VALUES ('30303030-3030-3030-3030-303030303030', 'subscription_cycle', '99999999-9999-9999-9999-999999999999',
        (SELECT (r->>'subscriptionId')::uuid FROM _c), (SELECT (r->>'subscriptionCycleId')::uuid FROM _c),
        '20202020-2020-2020-2020-202020202020', 1340, 'PLN', 'succeeded');

INSERT INTO public.commerce_payment_method_refs (
  id, client_id, subscription_id, provider_kind, method_kind, provider_method_ref, status, active
) VALUES (
  '40404040-4040-4040-4040-404040404040', '11111111-1111-1111-1111-111111111111', NULL,
  'stripe', 'card', 'pm_test_c', 'active', true
);

SELECT is(
  (SELECT (public.subscription_confirm_provisional_from_paid_cycle(
     'confirm-c-idem-key', '99999999-9999-9999-9999-999999999999', '30303030-3030-3030-3030-303030303030',
     'pm_test_c', 'card', '2026-06-10T12:00:00Z'::timestamptz)) #>> '{subscriptionConfirmation,status}'),
  'active', 'C: confirm activates with a pre-existing client-scoped ref present');
SELECT is(
  (SELECT subscription_id FROM public.commerce_payment_method_refs WHERE id = '40404040-4040-4040-4040-404040404040'),
  (SELECT (r->>'subscriptionId')::uuid FROM _c),
  'C: client-scoped payment_method_ref is mirrored onto subscription scope on activation');
SELECT is(
  (SELECT active FROM public.commerce_payment_method_refs WHERE id = '40404040-4040-4040-4040-404040404040'),
  true, 'C: mirrored ref stays active');

-- ---- D: activation succeeds even when no matching payment_method_ref exists -----
INSERT INTO public.commerce_orders (id, client_id, currency, region_code, size_constraint, status)
VALUES ('50505050-5050-5050-5050-505050505050', '11111111-1111-1111-1111-111111111111', 'PLN', 'PL', '{"kind":"feeding_days","value":21}'::jsonb, 'draft');
INSERT INTO public.commerce_order_items (id, order_id, sku_id, quantity, unit_price_cents, total_cents, discount_allocated_cents, effective_total_cents, effective_net_cents, product_snapshot)
VALUES ('60606060-6060-6060-6060-606060606060', '50505050-5050-5050-5050-505050505050', '55555555-5555-5555-5555-555555555555', 1, 1340, 1340, 0, 1340, round((1340)::numeric * 10000 / (10000 + (800)::integer))::integer, '{"sku":"CONF-SKU-1"}'::jsonb);

CREATE TEMP TABLE _d AS
SELECT public.subscription_create_provisional_for_checkout(
  '50505050-5050-5050-5050-505050505050','11111111-1111-1111-1111-111111111111',
  '22222222-2222-2222-2222-222222222222','33333333-3333-3333-3333-333333333333',
  '{"quote":{"context":{"mode":"subscription","cadenceDays":21}}}'::jsonb) AS r;

UPDATE public.commerce_orders
   SET mode='subscription_cycle', status='paid',
       subscription_id=(SELECT (r->>'subscriptionId')::uuid FROM _d),
       subscription_cycle_id=(SELECT (r->>'subscriptionCycleId')::uuid FROM _d)
 WHERE id='50505050-5050-5050-5050-505050505050';

INSERT INTO public.commerce_payments (id, order_id, provider, amount_cents, currency, status)
VALUES ('70707070-7070-7070-7070-707070707070', '50505050-5050-5050-5050-505050505050', 'stripe', 1340, 'PLN', 'succeeded');
INSERT INTO public.commerce_payment_intents (id, target_kind, order_id, subscription_id, subscription_cycle_id, payment_id, amount_cents, currency, status)
VALUES ('80808080-8080-8080-8080-808080808080', 'subscription_cycle', '50505050-5050-5050-5050-505050505050',
        (SELECT (r->>'subscriptionId')::uuid FROM _d), (SELECT (r->>'subscriptionCycleId')::uuid FROM _d),
        '70707070-7070-7070-7070-707070707070', 1340, 'PLN', 'succeeded');

SELECT is(
  (SELECT (public.subscription_confirm_provisional_from_paid_cycle(
     'confirm-d-idem-key', '50505050-5050-5050-5050-505050505050', '80808080-8080-8080-8080-808080808080',
     'pm_test_d_no_ref', 'card', '2026-06-10T12:00:00Z'::timestamptz)) #>> '{subscriptionConfirmation,status}'),
  'active', 'D: confirm activates fine when no matching payment_method_ref row exists');

SELECT * FROM finish();
ROLLBACK;
