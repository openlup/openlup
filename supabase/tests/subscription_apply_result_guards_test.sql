-- pgTAP: Model B — apply_result initial-cycle guards (20260611190000 + 20260709120000).
--   A2a declined first charge ('failed') is RECOVERABLE: order stays pending_payment,
--      subscription stays pending_activation, the checkout hold is RETAINED, NO
--      activation_failed event — and a fresh attempt then settles the order to paid.
--   A2b EXPIRED first charge stays TERMINAL: fails the order, releases inventory,
--      sweeps the sub -> activation_failed, emits the activation_failed event.
--   A3 refund of cycle #1: reverses activation (cycle + subscription cancelled, inventory released).
--   Regression: an active renewal (cycle #2) failure still schedules dunning (byte-identical).
--   CJ01-P: a cron-recovered renewal cycle closes its OPEN dunning case (recovered +
--      recovered_at, next_retry_at cleared) and skips the queued payment_failed
--      notification so the dispatcher cannot send a spurious decline email.
--   W10 (20260729190408): that same skip also reaches an already-LEASED ('sending')
--      notification despite the writer setting no claim-token GUC, both when the
--      row has no provider_error and when an earlier transient error is preserved.
--
-- Run via: supabase test db

BEGIN;
SELECT plan(85);

-- ---- Shared catalog fixture -----------------------------------------------
INSERT INTO public.clients (id, email)
VALUES ('11111111-1111-1111-1111-111111111111', 'modelb-guards@example.invalid');
INSERT INTO public.pets (id, client_id, pet_type)
VALUES ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'dog');
INSERT INTO public.addresses (id, client_id, kind, line1, city, postal_code)
VALUES ('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', 'shipping', 'Testowa 1', 'Warszawa', '00-001');
INSERT INTO public.catalog_products (id, slug, name, status)
VALUES ('44444444-4444-4444-4444-444444444444', 'modelb-guards-prod', 'Guards Prod', 'active');
INSERT INTO public.catalog_skus (id, product_id, sku, title, pet_type, net_weight_g, kcal_per_unit, status)
VALUES ('55555555-5555-5555-5555-555555555555', '44444444-4444-4444-4444-444444444444', 'GRD-SKU-1', 'Grd SKU 1', 'dog', 400, 350, 'active');
INSERT INTO public.inventory_locations (id, code, display_name, kind, status, fulfillable)
VALUES ('66666666-6666-6666-6666-666666666666', 'grd-loc', 'Guards Loc', 'virtual', 'active', true);

-- ===========================================================================
-- A2a — declined FIRST charge is RECOVERABLE (does NOT terminalize)
-- ===========================================================================
INSERT INTO public.commerce_orders (id, client_id, currency, region_code, size_constraint, status, total_cents, subtotal_cents)
VALUES ('a0000000-0000-0000-0000-0000000000a2', '11111111-1111-1111-1111-111111111111', 'PLN', 'PL', '{"kind":"feeding_days","value":21}'::jsonb, 'draft', 2680, 2680);
INSERT INTO public.commerce_order_items (id, order_id, sku_id, quantity, unit_price_cents, total_cents, discount_allocated_cents, effective_total_cents, effective_net_cents, product_snapshot)
VALUES ('a1000000-0000-0000-0000-0000000000a2', 'a0000000-0000-0000-0000-0000000000a2', '55555555-5555-5555-5555-555555555555', 2, 1340, 2680, 0, 2680, round((2680)::numeric * 10000 / (10000 + (800)::integer))::integer, '{"sku":"GRD-SKU-1"}'::jsonb);

CREATE TEMP TABLE _a2 AS
SELECT
  (r->>'subscriptionId')::uuid AS subscription_id,
  (r->>'subscriptionCycleId')::uuid AS cycle_id
FROM (SELECT public.subscription_create_provisional_for_checkout(
  'a0000000-0000-0000-0000-0000000000a2','11111111-1111-1111-1111-111111111111',
  '22222222-2222-2222-2222-222222222222','33333333-3333-3333-3333-333333333333',
  '{"quote":{"context":{"mode":"subscription","cadenceDays":21}}}'::jsonb) AS r) s;

UPDATE public.commerce_orders
   SET mode='subscription_cycle',
       subscription_id=(SELECT subscription_id FROM _a2),
       subscription_cycle_id=(SELECT cycle_id FROM _a2)
 WHERE id='a0000000-0000-0000-0000-0000000000a2';

CREATE TEMP TABLE _a2i AS
SELECT (public.commerce_payment_control_create_intent(
  'a2-intent-key-0001', 'subscription_cycle', 'a0000000-0000-0000-0000-0000000000a2',
  (SELECT subscription_id FROM _a2), (SELECT cycle_id FROM _a2), 2680, 'PLN', '{}'::jsonb
) -> 'paymentIntent' ->> 'id')::uuid AS intent_id;

SELECT public.commerce_payment_control_record_attempt(
  'a2-attempt-key-0001', (SELECT intent_id FROM _a2i), 'stripe', 'pa_a2', 'ps_a2',
  'processing', NULL, '{}'::jsonb, '{}'::jsonb);

INSERT INTO public.inventory_reservations (id, idempotency_key, order_id, sku_id, location_id, quantity, status, kind)
VALUES ('a2e50000-0000-0000-0000-0000000000a2', 'a2-resv-key', 'a0000000-0000-0000-0000-0000000000a2',
        '55555555-5555-5555-5555-555555555555', '66666666-6666-6666-6666-666666666666', 36, 'reserved', 'checkout_payment_window');

CREATE TEMP TABLE _a2res AS
SELECT (public.commerce_payment_control_apply_result(
  'a2-apply-key-0001', (SELECT intent_id FROM _a2i), NULL, 'failed', '2026-06-10T12:00:00Z'::timestamptz, 'card_declined'
) -> 'paymentResult' ->> 'kind') AS kind;

SELECT is((SELECT kind FROM _a2res),
  'recoverable_decline', 'A2a: a declined first charge is classified recoverable_decline');
SELECT is((SELECT status FROM public.commerce_orders WHERE id='a0000000-0000-0000-0000-0000000000a2'),
  'pending_payment', 'A2a: order stays pending_payment (re-payable)');
SELECT is((SELECT status FROM public.subscriptions WHERE id=(SELECT subscription_id FROM _a2)),
  'pending_activation', 'A2a: provisional subscription stays pending_activation');
SELECT is((SELECT status FROM public.inventory_reservations WHERE id='a2e50000-0000-0000-0000-0000000000a2'),
  'reserved', 'A2a: checkout inventory hold is RETAINED, not released');
SELECT is((SELECT count(*)::int FROM public.subscription_events
            WHERE subscription_id=(SELECT subscription_id FROM _a2) AND event_type='subscription.activation_failed'),
  0, 'A2a: NO activation_failed event on a recoverable decline');

-- Retry on the SAME intent: a fresh attempt re-arms it, then settles the order.
SELECT public.commerce_payment_control_record_attempt(
  'a2-attempt-key-0002', (SELECT intent_id FROM _a2i), 'stripe', 'pa_a2b', 'ps_a2b',
  'processing', NULL, '{}'::jsonb, '{}'::jsonb);
SELECT public.commerce_payment_control_apply_result(
  'a2-apply-key-0002', (SELECT intent_id FROM _a2i), NULL, 'succeeded', '2026-06-10T12:30:00Z'::timestamptz, NULL);

SELECT is((SELECT status FROM public.commerce_orders WHERE id='a0000000-0000-0000-0000-0000000000a2'),
  'paid', 'A2a: a retry on the same order settles it to paid');
SELECT is((SELECT status FROM public.subscription_cycles WHERE id=(SELECT cycle_id FROM _a2)),
  'paid', 'A2a: the activation cycle is paid after the retry');

-- ===========================================================================
-- A2b — EXPIRED first charge stays TERMINAL (window/session lapse)
-- ===========================================================================
INSERT INTO public.commerce_orders (id, client_id, currency, region_code, size_constraint, status, total_cents, subtotal_cents)
VALUES ('a0000000-0000-0000-0000-0000000000a5', '11111111-1111-1111-1111-111111111111', 'PLN', 'PL', '{"kind":"feeding_days","value":21}'::jsonb, 'draft', 2680, 2680);
INSERT INTO public.commerce_order_items (id, order_id, sku_id, quantity, unit_price_cents, total_cents, discount_allocated_cents, effective_total_cents, effective_net_cents, product_snapshot)
VALUES ('a1000000-0000-0000-0000-0000000000a5', 'a0000000-0000-0000-0000-0000000000a5', '55555555-5555-5555-5555-555555555555', 2, 1340, 2680, 0, 2680, round((2680)::numeric * 10000 / (10000 + (800)::integer))::integer, '{"sku":"GRD-SKU-1"}'::jsonb);

CREATE TEMP TABLE _a2b AS
SELECT
  (r->>'subscriptionId')::uuid AS subscription_id,
  (r->>'subscriptionCycleId')::uuid AS cycle_id
FROM (SELECT public.subscription_create_provisional_for_checkout(
  'a0000000-0000-0000-0000-0000000000a5','11111111-1111-1111-1111-111111111111',
  '22222222-2222-2222-2222-222222222222','33333333-3333-3333-3333-333333333333',
  '{"quote":{"context":{"mode":"subscription","cadenceDays":21}}}'::jsonb) AS r) s;

UPDATE public.commerce_orders
   SET mode='subscription_cycle',
       subscription_id=(SELECT subscription_id FROM _a2b),
       subscription_cycle_id=(SELECT cycle_id FROM _a2b)
 WHERE id='a0000000-0000-0000-0000-0000000000a5';

CREATE TEMP TABLE _a2bi AS
SELECT (public.commerce_payment_control_create_intent(
  'a2b-intent-key-0001', 'subscription_cycle', 'a0000000-0000-0000-0000-0000000000a5',
  (SELECT subscription_id FROM _a2b), (SELECT cycle_id FROM _a2b), 2680, 'PLN', '{}'::jsonb
) -> 'paymentIntent' ->> 'id')::uuid AS intent_id;

SELECT public.commerce_payment_control_record_attempt(
  'a2b-attempt-key-0001', (SELECT intent_id FROM _a2bi), 'stripe', 'pa_a2b1', 'ps_a2b1',
  'processing', NULL, '{}'::jsonb, '{}'::jsonb);

INSERT INTO public.inventory_reservations (id, idempotency_key, order_id, sku_id, location_id, quantity, status, kind)
VALUES ('a2e50000-0000-0000-0000-0000000000a5', 'a2b-resv-key', 'a0000000-0000-0000-0000-0000000000a5',
        '55555555-5555-5555-5555-555555555555', '66666666-6666-6666-6666-666666666666', 36, 'reserved', 'checkout_payment_window');

SELECT public.commerce_payment_control_apply_result(
  'a2b-apply-key-0001', (SELECT intent_id FROM _a2bi), NULL, 'expired', '2026-06-10T12:00:00Z'::timestamptz, 'simulator_expired');

SELECT is((SELECT status FROM public.commerce_orders WHERE id='a0000000-0000-0000-0000-0000000000a5'),
  'expired', 'A2b: an expired first charge fails the order');
SELECT is((SELECT status FROM public.subscriptions WHERE id=(SELECT subscription_id FROM _a2b)),
  'activation_failed', 'A2b: expiry sweeps the provisional to activation_failed');
SELECT is((SELECT status FROM public.inventory_reservations WHERE id='a2e50000-0000-0000-0000-0000000000a5'),
  'released', 'A2b: expiry releases the checkout inventory hold');
SELECT is((SELECT count(*)::int FROM public.subscription_events
            WHERE subscription_id=(SELECT subscription_id FROM _a2b) AND event_type='subscription.activation_failed'),
  1, 'A2b: activation_failed event emitted on expiry');

-- ===========================================================================
-- A3 — refund of cycle #1 reverses activation
-- ===========================================================================
INSERT INTO public.commerce_orders (id, client_id, currency, region_code, size_constraint, status, total_cents, subtotal_cents)
VALUES ('a0000000-0000-0000-0000-0000000000a3', '11111111-1111-1111-1111-111111111111', 'PLN', 'PL', '{"kind":"feeding_days","value":21}'::jsonb, 'draft', 2680, 2680);
INSERT INTO public.commerce_order_items (id, order_id, sku_id, quantity, unit_price_cents, total_cents, discount_allocated_cents, effective_total_cents, effective_net_cents, product_snapshot)
VALUES ('a1000000-0000-0000-0000-0000000000a3', 'a0000000-0000-0000-0000-0000000000a3', '55555555-5555-5555-5555-555555555555', 2, 1340, 2680, 0, 2680, round((2680)::numeric * 10000 / (10000 + (800)::integer))::integer, '{"sku":"GRD-SKU-1"}'::jsonb);

CREATE TEMP TABLE _a3 AS
SELECT
  (r->>'subscriptionId')::uuid AS subscription_id,
  (r->>'subscriptionCycleId')::uuid AS cycle_id
FROM (SELECT public.subscription_create_provisional_for_checkout(
  'a0000000-0000-0000-0000-0000000000a3','11111111-1111-1111-1111-111111111111',
  '22222222-2222-2222-2222-222222222222','33333333-3333-3333-3333-333333333333',
  '{"quote":{"context":{"mode":"subscription","cadenceDays":21}}}'::jsonb) AS r) s;

UPDATE public.commerce_orders
   SET mode='subscription_cycle',
       subscription_id=(SELECT subscription_id FROM _a3),
       subscription_cycle_id=(SELECT cycle_id FROM _a3)
 WHERE id='a0000000-0000-0000-0000-0000000000a3';

CREATE TEMP TABLE _a3i AS
SELECT (public.commerce_payment_control_create_intent(
  'a3-intent-key-0001', 'subscription_cycle', 'a0000000-0000-0000-0000-0000000000a3',
  (SELECT subscription_id FROM _a3), (SELECT cycle_id FROM _a3), 2680, 'PLN', '{}'::jsonb
) -> 'paymentIntent' ->> 'id')::uuid AS intent_id;

SELECT public.commerce_payment_control_record_attempt(
  'a3-attempt-key-0001', (SELECT intent_id FROM _a3i), 'stripe', 'pa_a3', 'ps_a3',
  'processing', NULL, '{}'::jsonb, '{}'::jsonb);

INSERT INTO public.inventory_reservations (id, idempotency_key, order_id, sku_id, location_id, quantity, status, kind)
VALUES ('a3e50000-0000-0000-0000-0000000000a3', 'a3-resv-key', 'a0000000-0000-0000-0000-0000000000a3',
        '55555555-5555-5555-5555-555555555555', '66666666-6666-6666-6666-666666666666', 36, 'reserved', 'checkout_payment_window');

-- Pay + confirm (sub -> active), then full refund.
SELECT public.commerce_payment_control_apply_result(
  'a3-apply-paid-0001', (SELECT intent_id FROM _a3i), NULL, 'succeeded', '2026-06-10T12:00:00Z'::timestamptz, NULL);
SELECT public.subscription_confirm_provisional_from_paid_cycle(
  'a3-confirm-key-0001', 'a0000000-0000-0000-0000-0000000000a3', (SELECT intent_id FROM _a3i),
  'pm_a3', 'card', '2026-06-10T12:00:00Z'::timestamptz);
SELECT public.commerce_payment_control_apply_result(
  'a3-apply-refund-0001', (SELECT intent_id FROM _a3i), NULL, 'refunded', '2026-06-11T12:00:00Z'::timestamptz, NULL);

SELECT is((SELECT status FROM public.subscriptions WHERE id=(SELECT subscription_id FROM _a3)),
  'cancelled', 'A3: refund reverses activation (subscription cancelled)');
SELECT is((SELECT status FROM public.subscription_cycles WHERE id=(SELECT cycle_id FROM _a3)),
  'cancelled', 'A3: activating cycle cancelled');
SELECT is((SELECT paid_at FROM public.subscription_cycles WHERE id=(SELECT cycle_id FROM _a3)),
  NULL, 'A3: cancelled cycle paid_at cleared (constraint-safe)');
SELECT is((SELECT status FROM public.inventory_reservations WHERE id='a3e50000-0000-0000-0000-0000000000a3'),
  'released', 'A3: inventory released on reversal');

-- ===========================================================================
-- A4 — re-delivered initial-cycle succeeded apply is idempotent (webhook re-delivery)
--   Pins the contract the Tpay webhook handler relies on: an IDENTICAL re-apply of a
--   subscription_cycle succeeded result replays cleanly (no throw, no double-activation),
--   while a drifted re-delivery (same key, different occurred_at) raises a 23505 the
--   handler must absorb. This is the live Model B awaiting-mandate defect's root contract.
-- ===========================================================================
INSERT INTO public.commerce_orders (id, client_id, currency, region_code, size_constraint, status, total_cents, subtotal_cents)
VALUES ('a0000000-0000-0000-0000-0000000000a4', '11111111-1111-1111-1111-111111111111', 'PLN', 'PL', '{"kind":"feeding_days","value":21}'::jsonb, 'draft', 2680, 2680);
INSERT INTO public.commerce_order_items (id, order_id, sku_id, quantity, unit_price_cents, total_cents, discount_allocated_cents, effective_total_cents, effective_net_cents, product_snapshot)
VALUES ('a1000000-0000-0000-0000-0000000000a4', 'a0000000-0000-0000-0000-0000000000a4', '55555555-5555-5555-5555-555555555555', 2, 1340, 2680, 0, 2680, round((2680)::numeric * 10000 / (10000 + (800)::integer))::integer, '{"sku":"GRD-SKU-1"}'::jsonb);

CREATE TEMP TABLE _a4 AS
SELECT
  (r->>'subscriptionId')::uuid AS subscription_id,
  (r->>'subscriptionCycleId')::uuid AS cycle_id
FROM (SELECT public.subscription_create_provisional_for_checkout(
  'a0000000-0000-0000-0000-0000000000a4','11111111-1111-1111-1111-111111111111',
  '22222222-2222-2222-2222-222222222222','33333333-3333-3333-3333-333333333333',
  '{"quote":{"context":{"mode":"subscription","cadenceDays":21}}}'::jsonb) AS r) s;

UPDATE public.commerce_orders
   SET mode='subscription_cycle',
       subscription_id=(SELECT subscription_id FROM _a4),
       subscription_cycle_id=(SELECT cycle_id FROM _a4)
 WHERE id='a0000000-0000-0000-0000-0000000000a4';

CREATE TEMP TABLE _a4i AS
SELECT (public.commerce_payment_control_create_intent(
  'a4-intent-key-0001', 'subscription_cycle', 'a0000000-0000-0000-0000-0000000000a4',
  (SELECT subscription_id FROM _a4), (SELECT cycle_id FROM _a4), 2680, 'PLN', '{}'::jsonb
) -> 'paymentIntent' ->> 'id')::uuid AS intent_id;

SELECT public.commerce_payment_control_record_attempt(
  'a4-attempt-key-0001', (SELECT intent_id FROM _a4i), 'tpay', 'pa_a4', 'ps_a4',
  'processing', NULL, '{}'::jsonb, '{}'::jsonb);

-- First charge succeeds.
SELECT public.commerce_payment_control_apply_result(
  'a4-apply-key-0001', (SELECT intent_id FROM _a4i), NULL, 'succeeded', '2026-06-10T12:00:00Z'::timestamptz, NULL);

-- Re-delivery with IDENTICAL args (same key + fingerprint) -> clean replay, never throws.
SELECT is(
  (public.commerce_payment_control_apply_result(
     'a4-apply-key-0001', (SELECT intent_id FROM _a4i), NULL, 'succeeded',
     '2026-06-10T12:00:00Z'::timestamptz, NULL) -> 'paymentResult' ->> 'replayed'),
  'true', 'A4: identical re-apply of a subscription_cycle succeeded result replays cleanly');
SELECT is((SELECT status FROM public.subscription_cycles WHERE id=(SELECT cycle_id FROM _a4)),
  'paid', 'A4: cycle stays paid across the replay');
SELECT is((SELECT status FROM public.subscriptions WHERE id=(SELECT subscription_id FROM _a4)),
  'pending_activation', 'A4: a succeeded apply never self-activates (confirm owns activation)');

-- Drifted re-delivery (same key, different occurred_at) raises the 23505 the webhook absorbs.
SELECT throws_ok(
  $$ SELECT public.commerce_payment_control_apply_result(
       'a4-apply-key-0001', (SELECT intent_id FROM _a4i), NULL, 'succeeded',
       '2026-06-10T13:00:00Z'::timestamptz, NULL) $$,
  '23505', NULL,
  'A4: a drifted re-delivery (same key, different occurred_at) raises a 23505 conflict');

-- ===========================================================================
-- Regression — active renewal (cycle #2) failure still schedules dunning
-- ===========================================================================
INSERT INTO public.subscriptions (id, client_id, cadence_days, currency, status, started_at, next_cycle_at)
VALUES ('5b000000-0000-0000-0000-0000000000c3', '11111111-1111-1111-1111-111111111111', 30, 'PLN', 'active',
        '2026-05-01T00:00:00Z', '2026-06-01T00:00:00Z');
INSERT INTO public.subscription_cycles (id, subscription_id, cycle_number, scheduled_at, status, engine_idempotency_key, retry_attempt)
VALUES ('5c000000-0000-0000-0000-0000000000c3', '5b000000-0000-0000-0000-0000000000c3', 2, '2026-06-01T00:00:00Z', 'planned', 'renewal-c3', 0);
INSERT INTO public.commerce_orders (id, client_id, currency, region_code, size_constraint, status, total_cents, subtotal_cents, mode, subscription_id, subscription_cycle_id)
VALUES ('a0000000-0000-0000-0000-0000000000c3', '11111111-1111-1111-1111-111111111111', 'PLN', 'PL', '{"kind":"feeding_days","value":21}'::jsonb, 'draft', 2680, 2680, 'subscription_cycle',
        '5b000000-0000-0000-0000-0000000000c3', '5c000000-0000-0000-0000-0000000000c3');

CREATE TEMP TABLE _c3i AS
SELECT (public.commerce_payment_control_create_intent(
  'c3-intent-key-0001', 'subscription_cycle', 'a0000000-0000-0000-0000-0000000000c3',
  '5b000000-0000-0000-0000-0000000000c3', '5c000000-0000-0000-0000-0000000000c3', 2680, 'PLN', '{}'::jsonb
) -> 'paymentIntent' ->> 'id')::uuid AS intent_id;

SELECT public.commerce_payment_control_record_attempt(
  'c3-attempt-key-0001', (SELECT intent_id FROM _c3i), 'stripe', 'pa_c3', 'ps_c3',
  'processing', NULL, '{}'::jsonb, '{}'::jsonb);

SELECT public.commerce_payment_control_apply_result(
  'c3-apply-key-0001', (SELECT intent_id FROM _c3i), NULL, 'failed', '2026-06-01T12:00:00Z'::timestamptz, 'card_declined');

SELECT is((SELECT status FROM public.subscription_cycles WHERE id='5c000000-0000-0000-0000-0000000000c3'),
  'retry_scheduled', 'Regression: active renewal still schedules a dunning retry');
SELECT isnt((SELECT next_retry_at FROM public.subscription_cycles WHERE id='5c000000-0000-0000-0000-0000000000c3'),
  NULL, 'Regression: renewal retry has a next_retry_at');

-- ===========================================================================
-- R6 - exhausted renewal retry lands terminal and never re-enters due claim
-- ===========================================================================
INSERT INTO public.subscriptions (id, client_id, cadence_days, currency, status, started_at, next_cycle_at)
VALUES ('5b000000-0000-0000-0000-0000000000d4', '11111111-1111-1111-1111-111111111111', 30, 'PLN', 'active',
        '2026-05-01T00:00:00Z', '2026-06-01T00:00:00Z');
INSERT INTO public.subscription_cycles (id, subscription_id, cycle_number, scheduled_at, status, engine_idempotency_key, retry_attempt, next_retry_at)
VALUES ('5c000000-0000-0000-0000-0000000000d4', '5b000000-0000-0000-0000-0000000000d4', 2, '2026-06-01T00:00:00Z',
        'retry_scheduled', 'renewal-d4', 3, '2026-06-08T12:00:00Z'::timestamptz);
INSERT INTO public.commerce_orders (id, client_id, currency, region_code, size_constraint, status, total_cents, subtotal_cents, mode, subscription_id, subscription_cycle_id)
VALUES ('a0000000-0000-0000-0000-0000000000d4', '11111111-1111-1111-1111-111111111111', 'PLN', 'PL', '{"kind":"feeding_days","value":21}'::jsonb, 'draft', 2680, 2680, 'subscription_cycle',
        '5b000000-0000-0000-0000-0000000000d4', '5c000000-0000-0000-0000-0000000000d4');

CREATE TEMP TABLE _d4i AS
SELECT (public.commerce_payment_control_create_intent(
  'd4-intent-key-0001', 'subscription_cycle', 'a0000000-0000-0000-0000-0000000000d4',
  '5b000000-0000-0000-0000-0000000000d4', '5c000000-0000-0000-0000-0000000000d4', 2680, 'PLN', '{}'::jsonb
) -> 'paymentIntent' ->> 'id')::uuid AS intent_id;

SELECT public.commerce_payment_control_record_attempt(
  'd4-attempt-key-0001', (SELECT intent_id FROM _d4i), 'stripe', 'pa_d4', 'ps_d4',
  'processing', NULL, '{}'::jsonb, '{}'::jsonb);

SELECT public.commerce_payment_control_apply_result(
  'd4-apply-key-0001', (SELECT intent_id FROM _d4i), NULL, 'failed', '2026-06-08T12:00:00Z'::timestamptz, 'card_declined');

SELECT is((SELECT status FROM public.subscription_cycles WHERE id='5c000000-0000-0000-0000-0000000000d4'),
  'payment_failed', 'R6: fourth renewal failure lands on terminal payment_failed');
SELECT is((SELECT retry_attempt FROM public.subscription_cycles WHERE id='5c000000-0000-0000-0000-0000000000d4'),
  4, 'R6: fourth renewal failure records retry_attempt=4');
SELECT is((SELECT next_retry_at FROM public.subscription_cycles WHERE id='5c000000-0000-0000-0000-0000000000d4'),
  NULL, 'R6: fourth renewal failure clears next_retry_at');
SELECT is((SELECT count(*)::int FROM public.subscription_events
            WHERE cycle_id='5c000000-0000-0000-0000-0000000000d4'
              AND event_type='subscription.payment_failed'),
  1, 'R6: exhausted retry emits a terminal subscription.payment_failed event');
SELECT is((SELECT count(*)::int FROM public.subscription_events
            WHERE cycle_id='5c000000-0000-0000-0000-0000000000d4'
              AND event_type='subscription.retry_scheduled'),
  0, 'R6: exhausted retry does not emit another retry_scheduled event');
SELECT is((SELECT count(*)::int FROM public.subscription_list_due_for_renewal(50)
            WHERE subscription_id='5b000000-0000-0000-0000-0000000000d4'),
  0, 'R6: terminal payment_failed cycle is not re-claimed through normal due renewal');

SELECT public.subscription_handle_payment_failure_dunning(
  'd4-dunning-key-0001',
  '5c000000-0000-0000-0000-0000000000d4',
  '5b000000-0000-0000-0000-0000000000d4',
  'a0000000-0000-0000-0000-0000000000d4',
  (SELECT intent_id FROM _d4i),
  4,
  (SELECT next_retry_at FROM public.subscription_cycles WHERE id='5c000000-0000-0000-0000-0000000000d4'),
  'card_declined', '2026-06-08T12:00:00Z'::timestamptz);

SELECT is((SELECT status FROM public.subscription_dunning_cases WHERE cycle_id='5c000000-0000-0000-0000-0000000000d4'),
  'expired', 'R6: final dunning case is expired');
SELECT is((SELECT next_retry_at FROM public.subscription_dunning_cases WHERE cycle_id='5c000000-0000-0000-0000-0000000000d4'),
  NULL, 'R6: expired dunning has no next retry timestamp');
SELECT isnt((SELECT expired_at FROM public.subscription_dunning_cases WHERE cycle_id='5c000000-0000-0000-0000-0000000000d4'),
  NULL, 'R6: expired dunning stamps expired_at');
SELECT is((SELECT status FROM public.subscriptions WHERE id='5b000000-0000-0000-0000-0000000000d4'),
  'paused', 'R6: expired dunning pauses the subscription');
SELECT is((SELECT count(*)::int FROM public.subscription_events
            WHERE cycle_id='5c000000-0000-0000-0000-0000000000d4'
              AND event_type='subscription.paused'),
  1, 'R6: expired dunning emits subscription.paused');
SELECT is((SELECT notification_kind || '|' || template_slug || '|' || status
             FROM public.subscription_dunning_notifications
            WHERE cycle_id='5c000000-0000-0000-0000-0000000000d4'
              AND recipient_kind='customer'),
  'payment_expired|subscription-payment-expired|queued',
  'R6: customer gets the final expired-payment communication, not another retry mail');
SELECT is((SELECT purpose FROM public.subscription_payment_recovery_tokens
            WHERE cycle_id='5c000000-0000-0000-0000-0000000000d4'),
  'resume_subscription', 'R6: expired dunning recovery token resumes subscription after customer action');
SELECT is((SELECT count(*)::int FROM public.subscription_list_due_for_renewal(50)
            WHERE subscription_id='5b000000-0000-0000-0000-0000000000d4'),
  0, 'R6: paused expired subscription stays out of due renewal');

-- Keep this fixture from being claimed by the legacy global claim_batch
-- assertion below; the R6 test already proved the final notification shape.
UPDATE public.subscription_dunning_notifications
   SET scheduled_at = now() + interval '1 hour'
 WHERE cycle_id='5c000000-0000-0000-0000-0000000000d4'
   AND recipient_kind='customer';

-- ===========================================================================
-- CJ01-P follow-up — a CRON-recovered renewal cycle closes its open dunning case
--   The c3 decline above scheduled dunning. The renewal cron then opens the case +
--   queues a customer payment_failed notification, re-binds the card, and the next
--   pass charges it: apply_result('succeeded') settles the cycle. That success must
--   ALSO close the dunning case (recovered + recovered_at, next_retry_at cleared) and
--   skip the still-queued notification, so the dispatcher — whose claim filter does
--   NOT join case status — cannot send a spurious "payment failed" email for a cycle
--   that is already paid.
-- ===========================================================================
-- Open the case + queue the customer notification for the declined c3 cycle. The
-- cycle's retry_attempt is now 1 (bumped by the failed apply above); pass it through
-- so the dunning RPC's stale-attempt guard is satisfied.
SELECT public.subscription_handle_payment_failure_dunning(
  'c3-dunning-key-0001',
  '5c000000-0000-0000-0000-0000000000c3',
  '5b000000-0000-0000-0000-0000000000c3',
  'a0000000-0000-0000-0000-0000000000c3',
  (SELECT intent_id FROM _c3i),
  1,
  (SELECT next_retry_at FROM public.subscription_cycles WHERE id='5c000000-0000-0000-0000-0000000000c3'),
  'card_declined', '2026-06-01T12:00:00Z'::timestamptz);

SELECT is((SELECT status FROM public.subscription_dunning_cases WHERE cycle_id='5c000000-0000-0000-0000-0000000000c3'),
  'open', 'CJ01-P: dunning case opens for the declined renewal cycle');

-- W10: the recovery skip must also reach a notification the dispatcher has
-- already LEASED. The claim-token lease fence returns OLD for any status change
-- on a 'sending' row unless the session GUC carries that row's token, and this
-- bulk skip is a system writer that never sets it. Before the fix the skip was
-- swallowed, the row stayed leased, the lease expired, the next claim retook it
-- and the dispatcher mailed "payment failed" to a customer whose cycle was
-- already PAID. Two siblings cover both provider_error shapes, because the
-- writer's COALESCE PRESERVES an error an earlier send attempt recorded.
CREATE TEMP TABLE _c3n AS
SELECT id FROM public.subscription_dunning_notifications
 WHERE cycle_id = '5c000000-0000-0000-0000-0000000000c3'
   AND recipient_kind = 'customer';

-- Keep the RPC-minted row queued so the original queued-path assertion below
-- keeps proving exactly what it proved before; only the copies get leased.
UPDATE public.subscription_dunning_notifications
   SET scheduled_at = now() + interval '1 hour'
 WHERE id = (SELECT id FROM _c3n);

INSERT INTO public.subscription_dunning_notifications (
  id, case_id, subscription_id, cycle_id, order_id, payment_intent_id,
  recipient_kind, recipient_ref, notification_kind, template_slug, retry_attempt,
  idempotency_key, status, scheduled_at, recovery_url_path, payload,
  created_at, updated_at, send_attempts
)
SELECT
  copy.new_id,
  case_id, subscription_id, cycle_id, order_id, payment_intent_id,
  recipient_kind, recipient_ref, notification_kind, template_slug, retry_attempt,
  copy.new_key, 'queued', now() - interval '1 second', recovery_url_path,
  coalesce(payload, '{}'::jsonb) - 'claimToken',
  now(), now(), 0
FROM public.subscription_dunning_notifications
CROSS JOIN (VALUES
  ('d5000000-0000-0000-0000-0000000000c3'::uuid, 'c3-dunning-leased-clean'),
  ('d5000000-0000-0000-0000-0000000000c4'::uuid, 'c3-dunning-leased-prior-error')
) AS copy(new_id, new_key)
WHERE id = (SELECT id FROM _c3n);

CREATE TEMP TABLE _c3claim AS
SELECT * FROM public.subscription_dunning_claim_batch(25, 300, 6);
SELECT is(
  (SELECT string_agg(status, ',' ORDER BY id)
     FROM public.subscription_dunning_notifications
    WHERE id IN ('d5000000-0000-0000-0000-0000000000c3'::uuid,
                 'd5000000-0000-0000-0000-0000000000c4'::uuid)),
  'sending,sending', 'W10: both sibling notifications hold a real dispatcher lease');

-- A transient send failure requeues one sibling WITH an error through the real
-- token-fenced RPC, and the next claim re-leases it, so it re-enters 'sending'
-- with provider_error already set - the shape a literal whitelist would miss.
SELECT public.subscription_dunning_mark_result(
  'd5000000-0000-0000-0000-0000000000c4'::uuid,
  (SELECT payload->>'claimToken' FROM public.subscription_dunning_notifications
    WHERE id = 'd5000000-0000-0000-0000-0000000000c4'::uuid),
  'queued',
  'transient_send_failure',
  NULL
);
CREATE TEMP TABLE _c3reclaim AS
SELECT * FROM public.subscription_dunning_claim_batch(25, 300, 6);
SELECT is(
  (SELECT status || '|' || provider_error
     FROM public.subscription_dunning_notifications
    WHERE id = 'd5000000-0000-0000-0000-0000000000c4'::uuid),
  'sending|transient_send_failure',
  'W10: the sibling is re-leased still carrying its earlier transient error');

-- The cron re-binds the card and re-charges on the same intent: a fresh attempt
-- re-arms active_attempt_id, then apply_result('succeeded') settles the cycle.
SELECT public.commerce_payment_control_record_attempt(
  'c3-attempt-key-0002', (SELECT intent_id FROM _c3i), 'stripe', 'pa_c3b', 'ps_c3b',
  'processing', NULL, '{}'::jsonb, '{}'::jsonb);
SELECT public.commerce_payment_control_apply_result(
  'c3-apply-key-0002', (SELECT intent_id FROM _c3i), NULL, 'succeeded', '2026-06-02T12:00:00Z'::timestamptz, NULL);

SELECT is((SELECT status FROM public.subscription_dunning_cases WHERE cycle_id='5c000000-0000-0000-0000-0000000000c3'),
  'recovered', 'CJ01-P: a cron-recovered cycle closes its dunning case to recovered');
SELECT isnt((SELECT recovered_at FROM public.subscription_dunning_cases WHERE cycle_id='5c000000-0000-0000-0000-0000000000c3'),
  NULL, 'CJ01-P: recovered_at is stamped on the closed case');
SELECT is((SELECT next_retry_at FROM public.subscription_dunning_cases WHERE cycle_id='5c000000-0000-0000-0000-0000000000c3'),
  NULL, 'CJ01-P: next_retry_at is cleared so no further escalation is scheduled');
-- The still-queued customer notification is skipped so the dispatcher can't send it.
SELECT is((SELECT status FROM public.subscription_dunning_notifications
            WHERE id = (SELECT id FROM _c3n)),
  'skipped', 'CJ01-P: the queued payment_failed notification is skipped, not sent');
-- W10: and so are the two LEASED siblings, despite the writer holding no claim
-- token - one with no prior error, one whose earlier error must be preserved.
SELECT is(
  (SELECT status || '|' || provider_error
     FROM public.subscription_dunning_notifications
    WHERE id = 'd5000000-0000-0000-0000-0000000000c3'::uuid),
  'skipped|cycle_recovered',
  'W10: recovery skips a leased notification that carries no prior error');
SELECT is(
  (SELECT status || '|' || provider_error
     FROM public.subscription_dunning_notifications
    WHERE id = 'd5000000-0000-0000-0000-0000000000c4'::uuid),
  'skipped|transient_send_failure',
  'W10: recovery skips a leased notification and preserves its earlier error');
-- Belt-and-suspenders: the dispatcher claim now leases nothing for this cycle.
SELECT is((SELECT count(*)::int FROM public.subscription_dunning_claim_batch(25, 300, 6)),
  0, 'CJ01-P: no due notification remains to claim after recovery');


-- ===========================================================================
-- W0 DUNNING CHARACTERIZATION PINS (PR-0a of the dunning-hardening program)
-- Folded into this suite instead of a standalone file: the OSS readiness
-- receipt freezes this surface family's provider-token count at its exact
-- current value, and the neutrality scanner charges one token for the PATH
-- of every new file in this directory tree — so a new standalone test file
-- cannot land without a control-plane receipt amendment. Header follows.
-- ===========================================================================
-- pgTAP: dunning W0 characterization pins (PR-0a of the dunning-hardening program).
--
-- CHARACTERIZATION ONLY. Every assertion below pins behavior EXACTLY AS IT IS on
-- main today, including behavior the program has already judged wrong. A later
-- wave that changes any of it must enumerate the flipped expectation in its PR
-- body (repo rule: no silent re-baselining of a characterization test).
--
-- W0-A  Retry ladder EXACT values. `commerce_payment_control_apply_result`'s
--       active-renewal branch (20260711150000:471-480) computes
--         retry_attempt 1 -> p_occurred_at + 24h
--         retry_attempt 2 -> p_occurred_at + 72h
--         retry_attempt 3 -> p_occurred_at + 168h
--         retry_attempt 4 -> NULL (terminal 'payment_failed')
--       Today NOTHING pins those constants as values.
--       `subscription_apply_result_guards_test.sql:293` only asserts
--       `next_retry_at IS NOT NULL`, so any of 24/72/168 could be changed to any
--       other positive interval with the whole suite still green. These
--       assertions compare against literal timestamps derived from a fixed
--       p_occurred_at, so the interval constants are pinned as data.
--
-- W0-B  apply_result idempotency semantics on the DUNNING path (the poison-pill
--       mechanism). The request fingerprint (20260711150000:83-106) hashes
--       intent + event + status + occurred_at + failure_reason:
--         (a) a byte-identical replay returns `replayed=true` from the stored
--             response and does NOT advance the retry ladder;
--         (b) the same key with a DRIFTED p_occurred_at raises
--             `payment_control_result_idempotency_conflict` (ERRCODE 23505) and
--             leaves the ladder untouched, so a renewal whose caller re-derives
--             a slightly different timestamp can never make progress.
--       `subscription_apply_result_guards_test.sql:248-264` pins the same
--       contract for a SUCCEEDED initial-cycle re-delivery and does not pin the
--       error name; this file pins it on the failed/renewal path with the exact
--       error identity, because that is the path PR-0c changes.
--
-- Entry point: 20260721200003:227-229 renamed the 20260711150000 body to
-- `commerce_payment_control_apply_before_sub_lock` and put a lock-ordering
-- wrapper behind the public `commerce_payment_control_apply_result` name. The
-- ladder and fingerprint logic cited above is unchanged by that rename; this
-- file deliberately calls the PUBLIC name, so the wrapper is pinned too.
--
-- The terminal attempt-4 transition (cycle payment_failed + next_retry_at NULL +
-- dunning case expired + subscription paused) is ALREADY pinned end to end at
-- subscription_apply_result_guards_test.sql:296-373 (R6) and is deliberately NOT
-- duplicated here; W0-A only adds the timestamp values R6 does not assert.
--
-- Fixture literals are deliberately neutral: the ladder and the fingerprint are
-- computed from `retry_attempt` and `p_occurred_at` alone, so the attempt's
-- provider and the order's currency are inputs neither branch reads. A neutral
-- provider ('simulator', the value the delivery-preferences CHECK already
-- names) and the ISO 4217 test currency ('XTS') keep this proof honest about
-- what it actually depends on.
--


-- ---- Fixture: an ACTIVE subscription on renewal cycle #2 ------------------
-- The renewal ladder branch requires mode='subscription_cycle' AND a
-- subscription that is past 'pending_activation' (20260711150000:350-356).
INSERT INTO public.clients (id, email)
VALUES ('7a000000-0000-4000-8000-00000000d001', 'dunning-w0-pins@example.invalid');

INSERT INTO public.subscriptions (id, client_id, cadence_days, currency, status, started_at, next_cycle_at)
VALUES ('7b000000-0000-4000-8000-00000000d001', '7a000000-0000-4000-8000-00000000d001', 30, 'XTS', 'active',
        '2026-05-01T00:00:00Z', '2026-06-01T00:00:00Z');

INSERT INTO public.subscription_cycles (id, subscription_id, cycle_number, scheduled_at, status, engine_idempotency_key, retry_attempt)
VALUES ('7c000000-0000-4000-8000-00000000d001', '7b000000-0000-4000-8000-00000000d001', 2, '2026-06-01T00:00:00Z',
        'planned', 'dunning-w0-pins-renewal', 0);

INSERT INTO public.commerce_orders (id, client_id, currency, region_code, size_constraint, status, total_cents, subtotal_cents, mode, subscription_id, subscription_cycle_id)
VALUES ('7d000000-0000-4000-8000-00000000d001', '7a000000-0000-4000-8000-00000000d001', 'XTS', 'PL',
        '{"kind":"unit_count","value":2}'::jsonb, 'draft', 2680, 2680, 'subscription_cycle',
        '7b000000-0000-4000-8000-00000000d001', '7c000000-0000-4000-8000-00000000d001');

CREATE TEMP TABLE _w0i AS
SELECT (public.commerce_payment_control_create_intent(
  'w0-intent-key-0001', 'subscription_cycle', '7d000000-0000-4000-8000-00000000d001',
  '7b000000-0000-4000-8000-00000000d001', '7c000000-0000-4000-8000-00000000d001', 2680, 'XTS', '{}'::jsonb
) -> 'paymentIntent' ->> 'id')::uuid AS intent_id;

-- ===========================================================================
-- W0-A/1 — first renewal decline: retry_attempt 1 -> occurred_at + 24 HOURS
-- ===========================================================================
SELECT public.commerce_payment_control_record_attempt(
  'w0-attempt-key-0001', (SELECT intent_id FROM _w0i), 'simulator', 'pa_w0_1', 'ps_w0_1',
  'processing', NULL, '{}'::jsonb, '{}'::jsonb);

SELECT public.commerce_payment_control_apply_result(
  'w0-apply-key-0001', (SELECT intent_id FROM _w0i), NULL, 'failed',
  '2026-06-01T12:00:00Z'::timestamptz, 'card_declined',
  'soft_retryable', 'neutral_hint');

SELECT is(
  (SELECT next_retry_at FROM public.subscription_cycles WHERE id = '7c000000-0000-4000-8000-00000000d001'),
  '2026-06-02T12:00:00Z'::timestamptz,
  'W0-A1: decline #1 schedules the next retry EXACTLY 24h after p_occurred_at');
SELECT is(
  (SELECT retry_attempt FROM public.subscription_cycles WHERE id = '7c000000-0000-4000-8000-00000000d001'),
  1,
  'W0-A1: decline #1 records retry_attempt=1');
SELECT is(
  (SELECT status FROM public.subscription_cycles WHERE id = '7c000000-0000-4000-8000-00000000d001'),
  'retry_scheduled',
  'W0-A1: decline #1 leaves the cycle retry_scheduled');

-- ===========================================================================
-- W0-B/a — byte-identical replay: replayed=true, ladder NOT advanced
-- ===========================================================================
SELECT is(
  (public.commerce_payment_control_apply_result(
     'w0-apply-key-0001', (SELECT intent_id FROM _w0i), NULL, 'failed',
     '2026-06-01T12:00:00Z'::timestamptz, 'card_declined',
     'soft_retryable', 'neutral_hint') -> 'paymentResult' ->> 'replayed'),
  'true',
  'W0-Ba: a byte-identical decline replay returns replayed=true instead of throwing');
SELECT is(
  (SELECT retry_attempt FROM public.subscription_cycles WHERE id = '7c000000-0000-4000-8000-00000000d001'),
  1,
  'W0-Ba: the replay does NOT advance the retry ladder');
SELECT is(
  (SELECT next_retry_at FROM public.subscription_cycles WHERE id = '7c000000-0000-4000-8000-00000000d001'),
  '2026-06-02T12:00:00Z'::timestamptz,
  'W0-Ba: the replay leaves next_retry_at at the originally scheduled instant');
SELECT is(
  (SELECT failure_class || '|' || (response_payload ->> 'failureClassDecidedBy')
     FROM public.commerce_payment_attempts
    WHERE id = (SELECT active_attempt_id FROM public.commerce_payment_intents WHERE id = (SELECT intent_id FROM _w0i))),
  'soft_retryable|neutral_hint',
  'W0-Ba: the first decision persists its failure class and provenance');

-- Simulate a completed key written after the eight-argument wrapper started
-- stamping failure_class but before the delegated body fingerprinted it.
UPDATE public.commerce_idempotency_keys
   SET request_fingerprint = md5(
     (SELECT intent_id::text FROM _w0i) || '||failed|'
     || '2026-06-01 12:00:00+00' || '|card_declined'
   )
 WHERE scope = 'commerce.payment_result.apply'
   AND idempotency_key = 'w0-apply-key-0001';

SELECT is(
  (public.commerce_payment_control_apply_result(
     'w0-apply-key-0001', (SELECT intent_id FROM _w0i), NULL, 'failed',
     '2026-06-01T12:00:00Z'::timestamptz, 'card_declined',
     'soft_retryable', 'advice_code') -> 'paymentResult' ->> 'replayed'),
  'true',
  'W0-Ba: a legacy classified fingerprint replays when its durable class matches');

SELECT is(
  (public.commerce_payment_control_apply_result(
     'w0-apply-key-0001', (SELECT intent_id FROM _w0i), NULL, 'failed',
     '2026-06-01T12:00:00Z'::timestamptz, 'card_declined',
     'soft_retryable', 'advice_code') -> 'paymentResult' ->> 'replayed'),
  'true',
  'W0-Ba: same-key same-class replay returns the first decision');
SELECT is(
  (SELECT response_payload ->> 'failureClassDecidedBy'
     FROM public.commerce_payment_attempts
    WHERE id = (SELECT active_attempt_id FROM public.commerce_payment_intents WHERE id = (SELECT intent_id FROM _w0i))),
  'neutral_hint',
  'W0-Ba: replay cannot rewrite the first classification provenance');

SELECT throws_ok(
  $$ SELECT public.commerce_payment_control_apply_result(
       'w0-apply-key-0001', (SELECT intent_id FROM _w0i), NULL, 'failed',
       '2026-06-01T12:00:00Z'::timestamptz, 'card_declined',
       'hard_do_not_retry', 'neutral_hint') $$,
  '23505', 'payment_control_result_idempotency_conflict',
  'W0-Ba: same key with a different failure class conflicts');
SELECT is(
  (SELECT failure_class || '|' || (response_payload ->> 'failureClassDecidedBy')
     FROM public.commerce_payment_attempts
    WHERE id = (SELECT active_attempt_id FROM public.commerce_payment_intents WHERE id = (SELECT intent_id FROM _w0i))),
  'soft_retryable|neutral_hint',
  'W0-Ba: conflicting reclassification leaves the first evidence intact');

-- ===========================================================================
-- W0-B/b — POISON PILL: same key, drifted p_occurred_at -> named 23505 conflict
--   The fingerprint hashes p_occurred_at, so a caller that re-derives the
--   timestamp (clock skew, `now()` instead of the provider instant) can never
--   re-apply this result. The renewal makes no progress and no further dunning
--   is scheduled. Pinned AS-IS; PR-0c changes the fingerprint + quarantines.
-- ===========================================================================
SELECT throws_ok(
  $$ SELECT public.commerce_payment_control_apply_result(
       'w0-apply-key-0001', (SELECT intent_id FROM _w0i), NULL, 'failed',
       '2026-06-01T12:00:01Z'::timestamptz, 'card_declined') $$,
  '23505', 'payment_control_result_idempotency_conflict',
  'W0-Bb: same key + drifted p_occurred_at raises the named idempotency conflict');
SELECT is(
  (SELECT retry_attempt FROM public.subscription_cycles WHERE id = '7c000000-0000-4000-8000-00000000d001'),
  1,
  'W0-Bb: the rejected drifted re-apply leaves the ladder stuck at attempt 1');

-- ===========================================================================
-- W0-A/2 — second decline: retry_attempt 2 -> occurred_at + 72 HOURS
-- ===========================================================================
SELECT public.commerce_payment_control_record_attempt(
  'w0-attempt-key-0002', (SELECT intent_id FROM _w0i), 'simulator', 'pa_w0_2', 'ps_w0_2',
  'processing', NULL, '{}'::jsonb, '{}'::jsonb);
SELECT public.commerce_payment_control_apply_result(
  'w0-apply-key-0002', (SELECT intent_id FROM _w0i), NULL, 'failed',
  '2026-06-02T12:00:00Z'::timestamptz, 'card_declined');

SELECT is(
  (SELECT next_retry_at FROM public.subscription_cycles WHERE id = '7c000000-0000-4000-8000-00000000d001'),
  '2026-06-05T12:00:00Z'::timestamptz,
  'W0-A2: decline #2 schedules the next retry EXACTLY 72h after p_occurred_at');
SELECT is(
  (SELECT retry_attempt::text || '|' || status
     FROM public.subscription_cycles WHERE id = '7c000000-0000-4000-8000-00000000d001'),
  '2|retry_scheduled',
  'W0-A2: decline #2 records retry_attempt=2 and stays retry_scheduled');

-- ===========================================================================
-- W0-A/3 — third decline: retry_attempt 3 -> occurred_at + 168 HOURS (7 days)
-- ===========================================================================
SELECT public.commerce_payment_control_record_attempt(
  'w0-attempt-key-0003', (SELECT intent_id FROM _w0i), 'simulator', 'pa_w0_3', 'ps_w0_3',
  'processing', NULL, '{}'::jsonb, '{}'::jsonb);
SELECT public.commerce_payment_control_apply_result(
  'w0-apply-key-0003', (SELECT intent_id FROM _w0i), NULL, 'failed',
  '2026-06-05T12:00:00Z'::timestamptz, 'card_declined');

SELECT is(
  (SELECT next_retry_at FROM public.subscription_cycles WHERE id = '7c000000-0000-4000-8000-00000000d001'),
  '2026-06-12T12:00:00Z'::timestamptz,
  'W0-A3: decline #3 schedules the next retry EXACTLY 168h after p_occurred_at');
SELECT is(
  (SELECT retry_attempt::text || '|' || status
     FROM public.subscription_cycles WHERE id = '7c000000-0000-4000-8000-00000000d001'),
  '3|retry_scheduled',
  'W0-A3: decline #3 records retry_attempt=3 and stays retry_scheduled');

-- ===========================================================================
-- W0-A/4 — fourth decline: ladder exhausted -> next_retry_at NULL, terminal
--   (R6 in subscription_apply_result_guards_test.sql:296-373 pins the dunning
--   case + subscription-pause side of this transition; here it closes the
--   ladder-value sequence so the whole 24/72/168/NULL shape is one proof.)
-- ===========================================================================
SELECT public.commerce_payment_control_record_attempt(
  'w0-attempt-key-0004', (SELECT intent_id FROM _w0i), 'simulator', 'pa_w0_4', 'ps_w0_4',
  'processing', NULL, '{}'::jsonb, '{}'::jsonb);
SELECT public.commerce_payment_control_apply_result(
  'w0-apply-key-0004', (SELECT intent_id FROM _w0i), NULL, 'failed',
  '2026-06-12T12:00:00Z'::timestamptz, 'card_declined');

SELECT is(
  (SELECT next_retry_at FROM public.subscription_cycles WHERE id = '7c000000-0000-4000-8000-00000000d001'),
  NULL::timestamptz,
  'W0-A4: decline #4 exhausts the ladder and clears next_retry_at');
SELECT is(
  (SELECT retry_attempt::text || '|' || status
     FROM public.subscription_cycles WHERE id = '7c000000-0000-4000-8000-00000000d001'),
  '4|payment_failed',
  'W0-A4: decline #4 records retry_attempt=4 and lands terminal payment_failed');


-- ===========================================================================
-- W0-C — PR-0c: a duplicate terminal failure is absorbed, not re-applied.
--
--   The cycle above is now terminal (`payment_failed`, retry_attempt=4,
--   next_retry_at NULL), the intent is `failed`, and its ACTIVE attempt
--   ('w0-attempt-key-0004') already carries status='failed' with
--   failure_reason='card_declined'. That is exactly the shape a re-delivered
--   terminal signal arrives in: a NEW idempotency key (so the fingerprint guard
--   never sees it) presenting an outcome that has already been applied, with NO
--   new attempt recorded in between.
--
--   Before PR-0c that call fell straight through to the normal failure branch
--   and applied the same decline a second time — a second retry_attempt bump, a
--   recomputed next_retry_at off the later instant, and another rung of the
--   customer's dunning ladder for one decline. The new branch absorbs it.
--
--   The guard keys on the ACTIVE ATTEMPT, not on the intent alone, which is why
--   W0-A/2..4 above still advance the ladder normally: each of those records a
--   FRESH attempt before applying, so none of them can reach this branch. That
--   asymmetry is the whole safety argument and is asserted below in both
--   directions.
--
--   It compares STATUS only, never the failure reason — W0-C2 is the case that
--   forces that and W0-C3 is the escalation that proves it is still safe.
-- ===========================================================================
SELECT is(
  (public.commerce_payment_control_apply_result(
     'w0-apply-key-0005', (SELECT intent_id FROM _w0i), NULL, 'failed',
     '2026-06-20T12:00:00Z'::timestamptz, 'card_declined') -> 'paymentResult' ->> 'kind'),
  'ignored_duplicate_terminal_failure',
  'W0-C1: a duplicate terminal failure under a new key returns the duplicate marker');
SELECT is(
  (SELECT retry_attempt::text || '|' || status || '|' || COALESCE(next_retry_at::text, 'null')
     FROM public.subscription_cycles WHERE id = '7c000000-0000-4000-8000-00000000d001'),
  '4|payment_failed|null',
  'W0-C1: the absorbed duplicate leaves the cycle ladder untouched');
SELECT is(
  (SELECT count(*)::int FROM public.subscription_events
    WHERE idempotency_key = 'w0-apply-key-0005:subscription_event'),
  0,
  'W0-C1: the absorbed duplicate emits no subscription event');
SELECT is(
  (SELECT reason FROM public.commerce_payment_state_transitions
    WHERE idempotency_key = 'w0-apply-key-0005:payment_result'),
  'ignored_duplicate_terminal_failure',
  'W0-C1: the absorbed duplicate still leaves a truthful state-transition record');

-- W0-C2 — the CROSS-WRITER duplicate, which is the one that actually happens.
--   The writers disagree about wording for one identical provider event: the
--   renewal cron records its own decline classification
--   ('provider_declined', 'blik_recurring_unsupported_bank',
--   'off_session_sca_required'), the payment webhook applies a generic
--   'provider_failed' (server/domains/payment/paymentWebhookHandler.ts:95-103),
--   and reconciliation writes 'provider_reconciliation_*'. A guard that also
--   required the REASON to match would let every one of those through and
--   absorb only the case that barely occurs, so one decline would still bump the
--   ladder twice. Status equality is what makes the guard do its job.
SELECT is(
  (public.commerce_payment_control_apply_result(
     'w0-apply-key-0006', (SELECT intent_id FROM _w0i), NULL, 'failed',
     '2026-06-21T12:00:00Z'::timestamptz, 'provider_failed') -> 'paymentResult' ->> 'kind'),
  'ignored_duplicate_terminal_failure',
  'W0-C2: a duplicate written by a DIFFERENT writer''s vocabulary is still absorbed');
SELECT is(
  (SELECT retry_attempt::text || '|' || status || '|' || COALESCE(next_retry_at::text, 'null')
     FROM public.subscription_cycles WHERE id = '7c000000-0000-4000-8000-00000000d001'),
  '4|payment_failed|null',
  'W0-C2: the cross-writer duplicate leaves the cycle ladder untouched');

-- W0-C3 — the fall-through that keeps the guard honest. A genuinely NEW terminal
--   status is not a duplicate: an expiry arriving after a decline is an
--   escalation and must still be applied, ladder and all. This is the assertion
--   that would fail if the predicate were ever widened past status equality.
SELECT public.commerce_payment_control_apply_result(
  'w0-apply-key-0007', (SELECT intent_id FROM _w0i), NULL, 'expired',
  '2026-06-22T12:00:00Z'::timestamptz, 'window_expired');
SELECT is(
  (SELECT retry_attempt::text || '|' || status
     FROM public.subscription_cycles WHERE id = '7c000000-0000-4000-8000-00000000d001'),
  '5|payment_failed',
  'W0-C3: a DIFFERENT terminal status after a failure still falls through and applies');
SELECT is(
  (SELECT status FROM public.commerce_payment_intents WHERE id = (SELECT intent_id FROM _w0i)),
  'expired',
  'W0-C3: the escalation is recorded on the intent');


-- ===========================================================================
-- W1-CLASS — PR-1b: the refusal's class is PERSISTED, and only when supplied.
--
--   Three properties, all of them about the additive parameters and none about
--   cadence: this delta changes no retry decision anywhere.
--
--   W1-1  a classified decline stamps commerce_payment_attempts.failure_class
--         and merges the deciding rule into the attempt's response payload,
--         and stamps subscription_dunning_cases.failure_class on the case.
--   W1-2  the OLD call shape — the same RPCs invoked with their pre-migration
--         argument list — is still valid and leaves both columns NULL. This is
--         the assertion that would fail if the parameters had been added in a
--         way that broke the still-deployed application.
--   W1-3  the NOT VALID CHECK still rejects an invalid class on a NEW row.
--         NOT VALID declines to scan pre-existing rows; it does not decline to
--         enforce, and that distinction is what this case pins.
--
--   W8b-1/W8b-2 were added to this same fixture by 20260826180000, which DOES
--         reach the cadence: it threads the class into the apply body and gives
--         the ladder a guard that consults it. They reuse this fixture rather
--         than build another because the strongest class in the taxonomy is
--         already applied here, which was precisely the input a later wave would
--         make terminating. 20260829120000 is that wave. The two arms now pin
--         the guard's ASYMMETRY on this exact walk: the classified refusal above
--         gets no rung at all, while the unclassified one below still takes rung
--         two at the interval W0-A pins. W8b-2 staying byte-identical across that
--         activation is the fail-open proof.
--
--   Fixture literals stay neutral for the same reason the W0 block's do, and one
--   step further: the stamping writes read neither the attempt's provider, nor
--   the order's currency, nor its region, so all three use the user-assigned
--   codes ('simulator', 'XTS', 'ZZ') rather than claiming a dependency that is
--   not there. region_code is only length-constrained, so 'ZZ' is as valid as
--   any real code and says out loud that no region rule is involved.
-- ===========================================================================
INSERT INTO public.clients (id, email)
VALUES ('7a000000-0000-4000-8000-00000000e001', 'dunning-w1-class@example.invalid');

INSERT INTO public.subscriptions (id, client_id, cadence_days, currency, status, started_at, next_cycle_at)
VALUES ('7b000000-0000-4000-8000-00000000e001', '7a000000-0000-4000-8000-00000000e001', 30, 'XTS', 'active',
        '2026-05-01T00:00:00Z', '2026-06-01T00:00:00Z');

INSERT INTO public.subscription_cycles (id, subscription_id, cycle_number, scheduled_at, status, engine_idempotency_key, retry_attempt)
VALUES ('7c000000-0000-4000-8000-00000000e001', '7b000000-0000-4000-8000-00000000e001', 2, '2026-06-01T00:00:00Z',
        'planned', 'dunning-w1-class-renewal', 0);

INSERT INTO public.commerce_orders (id, client_id, currency, region_code, size_constraint, status, total_cents, subtotal_cents, mode, subscription_id, subscription_cycle_id)
VALUES ('7d000000-0000-4000-8000-00000000e001', '7a000000-0000-4000-8000-00000000e001', 'XTS', 'ZZ',
        '{"kind":"unit_count","value":2}'::jsonb, 'draft', 2680, 2680, 'subscription_cycle',
        '7b000000-0000-4000-8000-00000000e001', '7c000000-0000-4000-8000-00000000e001');

CREATE TEMP TABLE _w1i AS
SELECT (public.commerce_payment_control_create_intent(
  'w1-intent-key-0001', 'subscription_cycle', '7d000000-0000-4000-8000-00000000e001',
  '7b000000-0000-4000-8000-00000000e001', '7c000000-0000-4000-8000-00000000e001', 2680, 'XTS', '{}'::jsonb
) -> 'paymentIntent' ->> 'id')::uuid AS intent_id;

-- W1-1 — a classified decline persists the class on the attempt and the case.
SELECT public.commerce_payment_control_record_attempt(
  'w1-attempt-key-0001', (SELECT intent_id FROM _w1i), 'simulator', 'pa_w1_1', 'ps_w1_1',
  'processing', NULL, '{}'::jsonb, '{}'::jsonb);

CREATE TEMP TABLE _w1a AS
SELECT (public.commerce_payment_control_apply_result(
  'w1-apply-key-0001', (SELECT intent_id FROM _w1i), NULL, 'failed',
  '2026-06-01T12:00:00Z'::timestamptz, 'provider_declined',
  'hard_do_not_retry', 'advice_code'
) -> 'paymentResult' ->> 'paymentAttemptId')::uuid AS attempt_id;

SELECT is(
  (SELECT failure_class FROM public.commerce_payment_attempts WHERE id = (SELECT attempt_id FROM _w1a)),
  'hard_do_not_retry',
  'W1-1: a classified decline stamps failure_class on the attempt it applied to');
SELECT is(
  (SELECT response_payload ->> 'failureClassDecidedBy'
     FROM public.commerce_payment_attempts WHERE id = (SELECT attempt_id FROM _w1a)),
  'advice_code',
  'W1-1: the deciding rule is merged into the attempt response payload, not a column');

SELECT public.subscription_handle_payment_failure_dunning(
  'w1-dunning-key-0001', '7c000000-0000-4000-8000-00000000e001',
  '7b000000-0000-4000-8000-00000000e001', '7d000000-0000-4000-8000-00000000e001',
  (SELECT intent_id FROM _w1i), 1, '2026-06-02T12:00:00Z'::timestamptz,
  'provider_declined', '2026-06-01T12:00:00Z'::timestamptz,
  'hard_do_not_retry');

SELECT is(
  (SELECT failure_class FROM public.subscription_dunning_cases
    WHERE cycle_id = '7c000000-0000-4000-8000-00000000e001'),
  'hard_do_not_retry',
  'W1-1: the dunning case carries the same class the attempt was stamped with');

-- W8b-1 — THE ACTIVATION PIN. It was written as a delta-zero pin against the
--   EMPTY terminating set 20260826180000 shipped, and named in that comment as
--   the assertion the wave that FILLS the set has to flip, deliberately and by
--   name. 20260829120000 filled it with `hard_do_not_retry`, so both halves are
--   flipped here: no schedule at all, and a cycle that lands payment_failed.
--   The attempt number does NOT move — the refusal still happened and still
--   counts — which is what separates terminating from never having tried.
--   Its fail-open control W8b-2 below is unchanged, and the end-to-end behaviour
--   this now describes is proved in
--   subscription_hard_do_not_retry_terminates_test.sql.
SELECT is(
  (SELECT next_retry_at FROM public.subscription_cycles
    WHERE id = '7c000000-0000-4000-8000-00000000e001'),
  NULL::timestamptz,
  'W8b-1: a hard_do_not_retry refusal is given no next charge, because its class is listed as terminating');
SELECT is(
  (SELECT retry_attempt::text || '|' || status
     FROM public.subscription_cycles WHERE id = '7c000000-0000-4000-8000-00000000e001'),
  '1|payment_failed',
  'W8b-1: the classified refusal still records retry_attempt=1, and the cycle lands payment_failed');

-- W1-2 — the pre-migration call shape still applies and classifies NOTHING.
SELECT public.commerce_payment_control_record_attempt(
  'w1-attempt-key-0002', (SELECT intent_id FROM _w1i), 'simulator', 'pa_w1_2', 'ps_w1_2',
  'processing', NULL, '{}'::jsonb, '{}'::jsonb);

CREATE TEMP TABLE _w1b AS
SELECT (public.commerce_payment_control_apply_result(
  'w1-apply-key-0002', (SELECT intent_id FROM _w1i), NULL, 'failed',
  '2026-06-02T12:00:00Z'::timestamptz, 'provider_declined'
) -> 'paymentResult' ->> 'paymentAttemptId')::uuid AS attempt_id;

SELECT is(
  (SELECT failure_class FROM public.commerce_payment_attempts WHERE id = (SELECT attempt_id FROM _w1b)),
  NULL::text,
  'W1-2: an unclassified apply under the old argument list leaves failure_class NULL');
SELECT is(
  (SELECT (response_payload ? 'failureClassDecidedBy')::text
     FROM public.commerce_payment_attempts WHERE id = (SELECT attempt_id FROM _w1b)),
  'false',
  'W1-2: an unclassified apply adds no deciding-rule key to the response payload');

-- W8b-2 — the fail-open control for W8b-1. An apply that supplies NO class at all
--   must reach exactly the same ladder, from the rung the classified call left it
--   on. Together the two pin that the guard added by 20260826180000 is inert in
--   BOTH directions: it neither shortens a classified ladder nor lengthens an
--   unclassified one.
SELECT is(
  (SELECT next_retry_at FROM public.subscription_cycles
    WHERE id = '7c000000-0000-4000-8000-00000000e001'),
  '2026-06-05T12:00:00Z'::timestamptz,
  'W8b-2: an unclassified refusal walks on to rung two 72h out, unchanged by the class guard');
SELECT is(
  (SELECT retry_attempt::text || '|' || status
     FROM public.subscription_cycles WHERE id = '7c000000-0000-4000-8000-00000000e001'),
  '2|retry_scheduled',
  'W8b-2: the unclassified refusal records retry_attempt=2 and stays retry_scheduled');

SELECT public.subscription_handle_payment_failure_dunning(
  'w1-dunning-key-0002', '7c000000-0000-4000-8000-00000000e001',
  '7b000000-0000-4000-8000-00000000e001', '7d000000-0000-4000-8000-00000000e001',
  (SELECT intent_id FROM _w1i), 2, '2026-06-05T12:00:00Z'::timestamptz,
  'provider_declined', '2026-06-02T12:00:00Z'::timestamptz);

SELECT is(
  (SELECT failure_class FROM public.subscription_dunning_cases
    WHERE cycle_id = '7c000000-0000-4000-8000-00000000e001'),
  'hard_do_not_retry',
  'W1-2: an unclassified dunning call under the old argument list overwrites nothing');

-- W1-3 — the NOT VALID CHECK still enforces the vocabulary on a NEW write.
SELECT throws_ok(
  $$ UPDATE public.commerce_payment_attempts
        SET failure_class = 'definitely_not_a_class'
      WHERE id = (SELECT attempt_id FROM _w1b) $$,
  '23514',
  NULL::text,
  'W1-3: the NOT VALID CHECK rejects a class outside the taxonomy on a new write');
SELECT is(
  (SELECT failure_class FROM public.commerce_payment_attempts WHERE id = (SELECT attempt_id FROM _w1b)),
  NULL::text,
  'W1-3: the rejected write leaves the column untouched');

SELECT * FROM finish();
ROLLBACK;
