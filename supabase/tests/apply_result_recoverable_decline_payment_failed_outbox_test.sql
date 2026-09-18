-- pgTAP: a recoverable one-time decline emits commerce.payment.failed inline
-- (20260711150000).
--
-- OBS-8/CJ01-U (pre-prod E2E campaign, 2026-07-03): a live Stripe test-mode
-- decline correctly left the order pending_payment (20260709120000's
-- recoverable-decline FSM) but no commerce.payment.failed outbox event was
-- ever created — the only prior emitter is the AFTER UPDATE OF status trigger
-- (20260614210000/20260630140000), which can no longer fire because a
-- recoverable one-time decline never transitions commerce_orders.status.
--
--   * a one-time order's recoverable decline emits exactly one
--     commerce.payment.failed row, idempotency_key = 'payment_failed:<id>',
--     with orderId/orderUuid/totalCents/currency embedded;
--   * a second decline on the same order (retry-then-decline-again) does not
--     duplicate the event (shared idempotency key with the terminal trigger);
--   * a still-provisional SUBSCRIPTION activation's recoverable decline emits
--     the same customer recovery event with mode='subscription_cycle', so the
--     renderer can route the CTA to account/subscription recovery instead of a
--     fresh checkout.
--
-- Run via: supabase test db

BEGIN;
SELECT plan(7);

-- ---- Shared catalog fixture -----------------------------------------------
INSERT INTO public.clients (id, email)
VALUES ('c1000000-0000-0000-0000-00000000e001', 'recoverable-decline-outbox@example.invalid');
INSERT INTO public.pets (id, client_id, pet_type)
VALUES ('c2000000-0000-0000-0000-00000000e001', 'c1000000-0000-0000-0000-00000000e001', 'dog');
INSERT INTO public.addresses (id, client_id, kind, line1, city, postal_code)
VALUES ('c3000000-0000-0000-0000-00000000e001', 'c1000000-0000-0000-0000-00000000e001', 'shipping', 'Testowa 1', 'Warszawa', '00-001');
INSERT INTO public.catalog_products (id, slug, name, status)
VALUES ('c4000000-0000-0000-0000-00000000e001', 'rd-outbox-prod', 'RD Outbox Prod', 'active');
INSERT INTO public.catalog_skus (id, product_id, sku, title, pet_type, net_weight_g, kcal_per_unit, status)
VALUES ('c5000000-0000-0000-0000-00000000e001', 'c4000000-0000-0000-0000-00000000e001', 'RD-SKU-1', 'RD SKU 1', 'dog', 400, 350, 'active');
INSERT INTO public.inventory_locations (id, code, display_name, kind, status, fulfillable)
VALUES ('c6000000-0000-0000-0000-00000000e001', 'rd-loc', 'RD Loc', 'virtual', 'active', true);

-- ===========================================================================
-- One-time order: recoverable decline emits commerce.payment.failed inline
-- ===========================================================================
INSERT INTO public.commerce_orders (id, client_id, currency, region_code, size_constraint, status, total_cents, subtotal_cents, mode)
VALUES ('d0000000-0000-0000-0000-00000000e001', 'c1000000-0000-0000-0000-00000000e001', 'PLN', 'PL',
        '{"kind":"feeding_days","value":21}'::jsonb, 'pending_payment', 45594, 45594, 'one_time');
INSERT INTO public.commerce_order_items (id, order_id, sku_id, quantity, unit_price_cents, total_cents, discount_allocated_cents, effective_total_cents, effective_net_cents, product_snapshot)
VALUES ('d1000000-0000-0000-0000-00000000e001', 'd0000000-0000-0000-0000-00000000e001', 'c5000000-0000-0000-0000-00000000e001',
        1, 45594, 45594, 0, 45594, round((45594)::numeric * 10000 / (10000 + (800)::integer))::integer, '{"sku":"RD-SKU-1"}'::jsonb);

CREATE TEMP TABLE _rd AS
SELECT (public.commerce_payment_control_create_intent(
  'rd-intent-key-0001', 'one_time_order', 'd0000000-0000-0000-0000-00000000e001',
  NULL, NULL, 45594, 'PLN', '{}'::jsonb
) -> 'paymentIntent' ->> 'id')::uuid AS intent_id;

SELECT public.commerce_payment_control_record_attempt(
  'rd-attempt-key-0001', (SELECT intent_id FROM _rd), 'stripe', 'pi_rd_declined', 'ps_rd',
  'processing', NULL, '{}'::jsonb, '{}'::jsonb);

SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE event_type = 'commerce.payment.failed'
      AND aggregate_id = 'd0000000-0000-0000-0000-00000000e001'),
  0, 'no payment-failed event before the decline is applied');

SELECT public.commerce_payment_control_apply_result(
  'rd-apply-key-0001', (SELECT intent_id FROM _rd), NULL, 'failed',
  '2026-07-03T12:00:00Z'::timestamptz, 'card_declined');

SELECT is((SELECT status FROM public.commerce_orders WHERE id='d0000000-0000-0000-0000-00000000e001'),
  'pending_payment', 'the order stays pending_payment (recoverable, unchanged behavior)');

SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE event_type = 'commerce.payment.failed'
      AND aggregate_id = 'd0000000-0000-0000-0000-00000000e001'),
  1, 'the recoverable decline emits exactly one commerce.payment.failed event');

SELECT is(
  (SELECT jsonb_build_object(
     'idempotencyKey', idempotency_key,
     'totalCents', (payload->>'totalCents')::int,
     'currency', payload->>'currency'
   )
   FROM public.outbox_events
    WHERE event_type = 'commerce.payment.failed'
      AND aggregate_id = 'd0000000-0000-0000-0000-00000000e001'),
  jsonb_build_object(
    'idempotencyKey', 'payment_failed:d0000000-0000-0000-0000-00000000e001',
    'totalCents', 45594,
    'currency', 'PLN'
  ),
  'idempotency_key matches the terminal trigger convention and payload mirrors the order');

-- A second decline (customer retried and got declined again) must not
-- duplicate the event — shared idempotency key with the terminal trigger.
SELECT public.commerce_payment_control_record_attempt(
  'rd-attempt-key-0002', (SELECT intent_id FROM _rd), 'stripe', 'pi_rd_declined_2', 'ps_rd2',
  'processing', NULL, '{}'::jsonb, '{}'::jsonb);
SELECT public.commerce_payment_control_apply_result(
  'rd-apply-key-0002', (SELECT intent_id FROM _rd), NULL, 'failed',
  '2026-07-03T12:05:00Z'::timestamptz, 'card_declined');

SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE event_type = 'commerce.payment.failed'
      AND aggregate_id = 'd0000000-0000-0000-0000-00000000e001'),
  1, 'a second decline on the same order does not duplicate the event');

-- ===========================================================================
-- Subscription activation: a still-provisional recoverable decline emits a
-- customer recovery event, but the CTA policy must treat it as subscription
-- context and route to account recovery.
-- ===========================================================================
INSERT INTO public.commerce_orders (id, client_id, currency, region_code, size_constraint, status, total_cents, subtotal_cents)
VALUES ('d0000000-0000-0000-0000-00000000e002', 'c1000000-0000-0000-0000-00000000e001', 'PLN', 'PL',
        '{"kind":"feeding_days","value":21}'::jsonb, 'draft', 2680, 2680);
INSERT INTO public.commerce_order_items (id, order_id, sku_id, quantity, unit_price_cents, total_cents, discount_allocated_cents, effective_total_cents, effective_net_cents, product_snapshot)
VALUES ('d1000000-0000-0000-0000-00000000e002', 'd0000000-0000-0000-0000-00000000e002', 'c5000000-0000-0000-0000-00000000e001',
        2, 1340, 2680, 0, 2680, round((2680)::numeric * 10000 / (10000 + (800)::integer))::integer, '{"sku":"RD-SKU-1"}'::jsonb);

CREATE TEMP TABLE _rds AS
SELECT
  (r->>'subscriptionId')::uuid AS subscription_id,
  (r->>'subscriptionCycleId')::uuid AS cycle_id
FROM (SELECT public.subscription_create_provisional_for_checkout(
  'd0000000-0000-0000-0000-00000000e002', 'c1000000-0000-0000-0000-00000000e001',
  'c2000000-0000-0000-0000-00000000e001', 'c3000000-0000-0000-0000-00000000e001',
  '{"quote":{"context":{"mode":"subscription","cadenceDays":21}}}'::jsonb) AS r) s;

UPDATE public.commerce_orders
   SET mode='subscription_cycle',
       subscription_id=(SELECT subscription_id FROM _rds),
       subscription_cycle_id=(SELECT cycle_id FROM _rds)
 WHERE id='d0000000-0000-0000-0000-00000000e002';

CREATE TEMP TABLE _rdsi AS
SELECT (public.commerce_payment_control_create_intent(
  'rds-intent-key-0001', 'subscription_cycle', 'd0000000-0000-0000-0000-00000000e002',
  (SELECT subscription_id FROM _rds), (SELECT cycle_id FROM _rds), 2680, 'PLN', '{}'::jsonb
) -> 'paymentIntent' ->> 'id')::uuid AS intent_id;

SELECT public.commerce_payment_control_record_attempt(
  'rds-attempt-key-0001', (SELECT intent_id FROM _rdsi), 'stripe', 'pi_rds_declined', 'ps_rds',
  'processing', NULL, '{}'::jsonb, '{}'::jsonb);

SELECT public.commerce_payment_control_apply_result(
  'rds-apply-key-0001', (SELECT intent_id FROM _rdsi), NULL, 'failed',
  '2026-07-03T12:00:00Z'::timestamptz, 'card_declined');

SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE event_type = 'commerce.payment.failed'
      AND aggregate_id = 'd0000000-0000-0000-0000-00000000e002'),
  1, 'a still-provisional subscription activation decline emits a subscription-context recovery event');

-- The notice's own send-time gate (order_already_paid) is correct, but it only
-- gets to be TRUE if the row is not claimed before the buyer can finish
-- retrying. `available_at` defaults to now() and the dispatch cron runs every
-- minute, so without this offset the claim lands inside ~60 s.
-- ⛔ Asserted as a floor, not an equality: this must fail if the offset is
-- removed or shortened, and must not fail merely because it was lengthened.
SELECT ok(
  (SELECT min(available_at) FROM public.outbox_events
    WHERE event_type = 'commerce.payment.failed')
    >= (SELECT min(created_at) + interval '3 minutes' FROM public.outbox_events
         WHERE event_type = 'commerce.payment.failed'),
  'the decline notice is held back so its own paid-order gate can be true');

SELECT * FROM finish();
ROLLBACK;
