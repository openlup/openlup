-- pgTAP: Model B — commerce_webhook_confirm_subscription_from_intent (20260611180000).
--   * for a subscription_cycle intent it confirms (activates) the provisional sub
--   * for a one-time intent it no-ops (confirmed=false)
--   * it is an idempotent replay
--
-- Run via: supabase test db

BEGIN;
SELECT plan(4);

-- ---- Shared fixture -------------------------------------------------------
INSERT INTO public.clients (id, email)
VALUES ('11111111-1111-1111-1111-111111111111', 'modelb-webhook@example.invalid');
INSERT INTO public.pets (id, client_id, pet_type)
VALUES ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'dog');
INSERT INTO public.addresses (id, client_id, kind, line1, city, postal_code)
VALUES ('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', 'shipping', 'Testowa 1', 'Warszawa', '00-001');
INSERT INTO public.catalog_products (id, slug, name, status)
VALUES ('44444444-4444-4444-4444-444444444444', 'modelb-webhook-prod', 'Webhook Prod', 'active');
INSERT INTO public.catalog_skus (id, product_id, sku, title, pet_type, net_weight_g, kcal_per_unit, status)
VALUES ('55555555-5555-5555-5555-555555555555', '44444444-4444-4444-4444-444444444444', 'WHK-SKU-1', 'Whk SKU 1', 'dog', 400, 350, 'active');

-- ---- Subscription_cycle paid order + intent -------------------------------
INSERT INTO public.commerce_orders (id, client_id, currency, region_code, size_constraint, status)
VALUES ('77777777-7777-7777-7777-777777777777', '11111111-1111-1111-1111-111111111111', 'PLN', 'PL', '{"kind":"feeding_days","value":21}'::jsonb, 'draft');
INSERT INTO public.commerce_order_items (id, order_id, sku_id, quantity, unit_price_cents, total_cents, discount_allocated_cents, effective_total_cents, effective_net_cents, product_snapshot)
VALUES ('88888888-8888-8888-8888-888888888888', '77777777-7777-7777-7777-777777777777', '55555555-5555-5555-5555-555555555555', 2, 1340, 2680, 0, 2680, round((2680)::numeric * 10000 / (10000 + (800)::integer))::integer, '{"sku":"WHK-SKU-1"}'::jsonb);

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

-- ---- One-time paid order + intent (no-op target) --------------------------
INSERT INTO public.commerce_orders (id, client_id, currency, region_code, status, mode)
VALUES ('cccccccc-cccc-cccc-cccc-cccccccccccc', '11111111-1111-1111-1111-111111111111', 'PLN', 'PL', 'paid', 'one_time');
INSERT INTO public.commerce_payments (id, order_id, provider, amount_cents, currency, status)
VALUES ('dddddddd-dddd-dddd-dddd-dddddddddddd', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'stripe', 1340, 'PLN', 'succeeded');
INSERT INTO public.commerce_payment_intents (id, target_kind, order_id, payment_id, amount_cents, currency, status)
VALUES ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'one_time_order', 'cccccccc-cccc-cccc-cccc-cccccccccccc',
        'dddddddd-dddd-dddd-dddd-dddddddddddd', 1340, 'PLN', 'succeeded');

-- ---- Assertions -----------------------------------------------------------
SELECT is(
  (SELECT (public.commerce_webhook_confirm_subscription_from_intent(
     'whk-confirm-idem-a', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'pm_test_a', 'card', '2026-06-10T12:00:00Z'::timestamptz))
     #>> '{webhookSubscriptionConfirm,confirmed}'),
  'true', 'subscription_cycle intent -> confirmed');

SELECT is(
  (SELECT status FROM public.subscriptions WHERE id=(SELECT (r->>'subscriptionId')::uuid FROM _a)),
  'active', 'subscription activated via the webhook wrapper');

SELECT is(
  (SELECT (public.commerce_webhook_confirm_subscription_from_intent(
     'whk-confirm-idem-b', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', NULL, NULL, '2026-06-10T12:00:00Z'::timestamptz))
     #>> '{webhookSubscriptionConfirm,confirmed}'),
  'false', 'one-time intent -> no-op (confirmed=false)');

SELECT is(
  (SELECT (public.commerce_webhook_confirm_subscription_from_intent(
     'whk-confirm-idem-a', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'pm_test_a', 'card', '2026-06-10T12:00:00Z'::timestamptz))
     #>> '{webhookSubscriptionConfirm,confirmation,replayed}'),
  'true', 'replay confirms idempotently');

SELECT * FROM finish();
ROLLBACK;
