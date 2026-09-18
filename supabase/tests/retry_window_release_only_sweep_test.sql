-- pgTAP: release-only sweep for expired subscription retry-window holds.
--
-- Run via: supabase db reset && supabase test db

BEGIN;
SELECT plan(12);

INSERT INTO public.clients (id, email)
VALUES ('a1111111-1111-4111-8111-111111111111', 'retry-hold-sweep@example.invalid');

INSERT INTO public.catalog_products (id, slug, name, status)
VALUES ('a2222222-2222-4222-8222-222222222221', 'generic-retry', 'Generic Retry', 'active');

INSERT INTO public.catalog_skus (id, product_id, sku, title, pet_type, status, net_weight_g, kcal_per_unit)
VALUES ('a3333333-3333-4333-8333-333333333331', 'a2222222-2222-4222-8222-222222222221', 'GENERIC-RETRY', 'Generic Retry', 'other', 'active', 1, 1);

INSERT INTO public.inventory_locations (id, code, display_name, kind, status, fulfillable)
VALUES ('a4444444-4444-4444-8444-444444444444', 'generic-retry-sweep', 'Generic retry sweep', 'virtual', 'active', true);

INSERT INTO public.inventory_balances (id, sku_id, location_id, on_hand, reserved)
VALUES ('a5555555-5555-4555-8555-555555555551', 'a3333333-3333-4333-8333-333333333331', 'a4444444-4444-4444-8444-444444444444', 20, 12);

INSERT INTO public.subscriptions (id, client_id, cadence_days, currency, status, next_cycle_at)
VALUES ('a6666666-6666-4666-8666-666666666660', 'a1111111-1111-4111-8111-111111111111', 30, 'PLN', 'active', now());

INSERT INTO public.subscription_cycles (id, subscription_id, cycle_number, scheduled_at, status, engine_idempotency_key, retry_attempt)
VALUES ('a6666666-6666-4666-8666-666666666661', 'a6666666-6666-4666-8666-666666666660', 2, now() - interval '2 days', 'retry_scheduled', 'retry-hold-sweep-cycle-1', 1);

-- A: cycle order in retry with an EXPIRED retry hold (the sweep target).
INSERT INTO public.commerce_orders (id, client_id, status, currency, region_code, mode, subscription_id, subscription_cycle_id, size_constraint, total_cents, subtotal_cents)
VALUES ('a7777777-7777-4777-8777-777777777771', 'a1111111-1111-4111-8111-111111111111',
        'pending_payment', 'PLN', 'PL', 'subscription_cycle',
        'a6666666-6666-4666-8666-666666666660', 'a6666666-6666-4666-8666-666666666661',
        '{"kind":"unit_count","value":5}'::jsonb, 5000, 5000);
INSERT INTO public.inventory_reservations (
  id, idempotency_key, order_id, sku_id, location_id, quantity, status, kind, subscription_cycle_id, expires_at
) VALUES (
  'a8888888-8888-4888-8888-888888888881', 'retry-hold-sweep-a',
  'a7777777-7777-4777-8777-777777777771', 'a3333333-3333-4333-8333-333333333331',
  'a4444444-4444-4444-8444-444444444444', 5, 'reserved', 'subscription_retry_window',
  'a6666666-6666-4666-8666-666666666661', '2026-06-16T08:00:00Z'
);

-- B: PAID cycle order with an anomalous expired retry hold — must be skipped.
INSERT INTO public.subscription_cycles (id, subscription_id, cycle_number, scheduled_at, status, engine_idempotency_key, retry_attempt)
VALUES ('a6666666-6666-4666-8666-666666666662', 'a6666666-6666-4666-8666-666666666660', 3, now() - interval '1 day', 'paid', 'retry-hold-sweep-cycle-2', 0);
INSERT INTO public.commerce_orders (id, client_id, status, currency, region_code, mode, subscription_id, subscription_cycle_id, size_constraint, total_cents, subtotal_cents)
VALUES ('a7777777-7777-4777-8777-777777777772', 'a1111111-1111-4111-8111-111111111111',
        'paid', 'PLN', 'PL', 'subscription_cycle',
        'a6666666-6666-4666-8666-666666666660', 'a6666666-6666-4666-8666-666666666662',
        '{"kind":"unit_count","value":4}'::jsonb, 4000, 4000);
INSERT INTO public.inventory_reservations (
  id, idempotency_key, order_id, sku_id, location_id, quantity, status, kind, expires_at
) VALUES (
  'a8888888-8888-4888-8888-888888888882', 'retry-hold-sweep-b',
  'a7777777-7777-4777-8777-777777777772', 'a3333333-3333-4333-8333-333333333331',
  'a4444444-4444-4444-8444-444444444444', 4, 'reserved', 'subscription_retry_window', '2026-06-16T08:00:00Z'
);

-- C: live pinned hold (expires_at NULL) — never selected.
INSERT INTO public.inventory_reservations (
  id, idempotency_key, order_id, sku_id, location_id, quantity, status, kind, expires_at
) VALUES (
  'a8888888-8888-4888-8888-888888888883', 'retry-hold-sweep-c',
  'a7777777-7777-4777-8777-777777777771', 'a3333333-3333-4333-8333-333333333331',
  'a4444444-4444-4444-8444-444444444444', 3, 'reserved', 'subscription_retry_window', NULL
);

CREATE TEMP TABLE _sweep AS
SELECT public.commerce_sweep_expired_retry_holds('2026-06-17T00:00:00Z'::timestamptz, 50) AS result;

SELECT is(
  (SELECT (result -> 'retrySweep' ->> 'holdsChecked')::integer FROM _sweep),
  2,
  'both expired retry holds are examined'
);
SELECT is(
  (SELECT (result -> 'retrySweep' ->> 'holdsReleased')::integer FROM _sweep),
  1,
  'only the non-paid order''s expired hold is released'
);
SELECT is(
  (SELECT (result -> 'retrySweep' ->> 'skippedPaid')::integer FROM _sweep),
  1,
  'the paid order''s anomalous hold is skipped, not released'
);

SELECT is(
  (SELECT status FROM public.inventory_reservations WHERE id = 'a8888888-8888-4888-8888-888888888881'),
  'released',
  'expired retry hold is released'
);
SELECT is(
  (SELECT status FROM public.inventory_reservations WHERE id = 'a8888888-8888-4888-8888-888888888882'),
  'reserved',
  'paid-order hold stays reserved (operator territory)'
);
SELECT is(
  (SELECT status FROM public.inventory_reservations WHERE id = 'a8888888-8888-4888-8888-888888888883'),
  'reserved',
  'pinned NULL-expiry hold is untouched'
);

-- The release heals the materialized balance (12 - 5 = 7).
SELECT is(
  (SELECT reserved FROM public.inventory_balances WHERE id = 'a5555555-5555-4555-8555-555555555551'),
  7,
  'inventory_balances.reserved is decremented by the released quantity'
);

-- Release-only invariant: nothing else moved.
SELECT is(
  (SELECT status FROM public.subscriptions WHERE id = 'a6666666-6666-4666-8666-666666666660'),
  'active',
  'subscription stays active'
);
SELECT is(
  (SELECT status FROM public.subscription_cycles WHERE id = 'a6666666-6666-4666-8666-666666666661'),
  'retry_scheduled',
  'cycle stays retry_scheduled'
);
SELECT is(
  (SELECT status FROM public.commerce_orders WHERE id = 'a7777777-7777-4777-8777-777777777771'),
  'pending_payment',
  'cycle order status is untouched'
);

-- Idempotent rerun: released rows no longer match; the skipped paid row is
-- re-examined but still skipped.
CREATE TEMP TABLE _sweep2 AS
SELECT public.commerce_sweep_expired_retry_holds('2026-06-17T00:00:00Z'::timestamptz, 50) AS result;
SELECT is(
  (SELECT (result -> 'retrySweep' ->> 'holdsReleased')::integer FROM _sweep2),
  0,
  'rerun releases nothing'
);
SELECT is(
  (SELECT (result -> 'retrySweep' ->> 'skippedPaid')::integer FROM _sweep2),
  1,
  'rerun still skips the paid-order anomaly'
);

SELECT * FROM finish();
ROLLBACK;
