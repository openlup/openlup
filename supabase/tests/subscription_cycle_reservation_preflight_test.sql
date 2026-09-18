-- pgTAP: pre-PSP-charge renewal reservation preflight (fail-closed).
--
-- Run via: supabase db reset && supabase test db

BEGIN;
SELECT plan(10);

INSERT INTO public.clients (id, email)
VALUES ('b1111111-1111-4111-8111-111111111111', 'renewal-preflight@example.invalid');

INSERT INTO public.catalog_products (id, slug, name, status)
VALUES ('b2222222-2222-4222-8222-222222222221', 'generic-preflight', 'Generic Preflight', 'active');

INSERT INTO public.catalog_skus (id, product_id, sku, title, pet_type, status, net_weight_g, kcal_per_unit)
VALUES ('b3333333-3333-4333-8333-333333333331', 'b2222222-2222-4222-8222-222222222221', 'GENERIC-PREFLT', 'Generic Preflight', 'other', 'active', 1, 1);

-- OmniPack provider stock oracle: 8 sellable.
SELECT public.fulfillment_provider_upsert_stock_current(
  'renewal-preflight-stock-1', 'omnipack', 'GENERIC-PREFLT', 10, 8, 0,
  now(), now() + interval '6 hours', 'renewal-preflight-run-1', '{"source":"pgtap"}'::jsonb
);

INSERT INTO public.subscriptions (id, client_id, cadence_days, currency, status, next_cycle_at)
VALUES ('b6666666-6666-4666-8666-666666666660', 'b1111111-1111-4111-8111-111111111111', 30, 'PLN', 'active', now());

INSERT INTO public.subscription_cycles (id, subscription_id, cycle_number, scheduled_at, status, engine_idempotency_key, retry_attempt)
VALUES ('b6666666-6666-4666-8666-666666666661', 'b6666666-6666-4666-8666-666666666660', 2, now() - interval '1 day', 'retry_scheduled', 'renewal-preflight-cycle-1', 1);

INSERT INTO public.commerce_orders (id, client_id, status, currency, region_code, mode, subscription_id, subscription_cycle_id, size_constraint, total_cents, subtotal_cents)
VALUES ('b7777777-7777-4777-8777-777777777771', 'b1111111-1111-4111-8111-111111111111',
        'pending_payment', 'PLN', 'PL', 'subscription_cycle',
        'b6666666-6666-4666-8666-666666666660', 'b6666666-6666-4666-8666-666666666661',
        '{"kind":"unit_count","value":3}'::jsonb, 3000, 3000);

-- Item insert fires subscription_cycle_order_item_reserve_inventory → a live
-- 72h subscription_retry_window hold via the OmniPack oracle.
INSERT INTO public.commerce_order_items (id, order_id, sku_id, quantity, unit_price_cents, total_cents, discount_allocated_cents, effective_total_cents, effective_net_cents, product_snapshot)
VALUES ('b8888888-8888-4888-8888-888888888881', 'b7777777-7777-4777-8777-777777777771',
        'b3333333-3333-4333-8333-333333333331', 3, 1000, 3000, 0, 3000, round((3000)::numeric * 10000 / (10000 + (800)::integer))::integer, '{"sku":"GENERIC-PREFLT"}'::jsonb);

SELECT is(
  (SELECT count(*)::integer FROM public.inventory_reservations
    WHERE order_id = 'b7777777-7777-4777-8777-777777777771' AND status = 'reserved' AND kind = 'subscription_retry_window'),
  1,
  'item insert reserves a live retry hold'
);

-- Case 1: live hold → preflight passes without re-acquiring.
CREATE TEMP TABLE _pf1 AS
SELECT public.subscription_cycle_reservation_preflight('b7777777-7777-4777-8777-777777777771', now()) AS result;
SELECT is((SELECT (result->>'ok')::boolean FROM _pf1), true, 'live hold: preflight ok');
SELECT is((SELECT (result->>'reacquired')::integer FROM _pf1), 0, 'live hold: nothing re-acquired');

-- Case 2: hold expires and the release-only sweep frees it (W3a integration);
-- preflight must re-acquire before any charge.
UPDATE public.inventory_reservations
   SET expires_at = now() - interval '2 hours'
 WHERE order_id = 'b7777777-7777-4777-8777-777777777771' AND status = 'reserved';
SELECT public.commerce_sweep_expired_retry_holds(now(), 50);
SELECT is(
  (SELECT count(*)::integer FROM public.inventory_reservations
    WHERE order_id = 'b7777777-7777-4777-8777-777777777771' AND status = 'reserved'),
  0,
  'sweep released the expired hold'
);

CREATE TEMP TABLE _pf2 AS
SELECT public.subscription_cycle_reservation_preflight('b7777777-7777-4777-8777-777777777771', now()) AS result;
SELECT is((SELECT (result->>'ok')::boolean FROM _pf2), true, 'expired+released hold: preflight re-acquires');
SELECT is((SELECT (result->>'reacquired')::integer FROM _pf2), 1, 'one item re-acquired');
SELECT is(
  (SELECT count(*)::integer FROM public.inventory_reservations
    WHERE order_id = 'b7777777-7777-4777-8777-777777777771' AND status = 'reserved'
      AND idempotency_key LIKE 'renewal-preflight-reacquire:%'),
  1,
  're-acquired hold carries the preflight idempotency key'
);

-- Case 3: stock drained at the provider → fail closed, NO charge, nothing reserved.
UPDATE public.inventory_reservations
   SET expires_at = now() - interval '2 hours'
 WHERE order_id = 'b7777777-7777-4777-8777-777777777771' AND status = 'reserved';
SELECT public.commerce_sweep_expired_retry_holds(now(), 50);
SELECT public.fulfillment_provider_upsert_stock_current(
  'renewal-preflight-stock-2', 'omnipack', 'GENERIC-PREFLT', 10, 0, 0,
  now(), now() + interval '6 hours', 'renewal-preflight-run-2', '{"source":"pgtap"}'::jsonb
);

CREATE TEMP TABLE _pf3 AS
SELECT public.subscription_cycle_reservation_preflight('b7777777-7777-4777-8777-777777777771', now() + interval '2 hours') AS result;
SELECT is((SELECT (result->>'ok')::boolean FROM _pf3), false, 'drained stock: preflight fails closed');
SELECT is((SELECT result->>'reason' FROM _pf3), 'reservation_preflight_blocked', 'blocked reason surfaces for the job ledger');
SELECT is(
  (SELECT count(*)::integer FROM public.inventory_reservations
    WHERE order_id = 'b7777777-7777-4777-8777-777777777771' AND status = 'reserved'),
  0,
  'fail-closed preflight reserves nothing'
);

SELECT * FROM finish();
ROLLBACK;
