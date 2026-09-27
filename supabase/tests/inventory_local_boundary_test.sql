-- Executed by the published-tree pgTAP job against the shipped managed chain.
-- Local physical-stock ATP only: no provider stock, network, activation or grants.
-- Replay means unchanged same-input rows here; changed-input replay admission and
-- complete multi-lot replay receipts remain raw in the replay characterization.
BEGIN;
\ir fixtures/settlement.inc
SELECT plan(35);

INSERT INTO public.clients (id, email)
VALUES ('d1111111-1111-4111-8111-111111111111', 'local-inventory@example.invalid');
INSERT INTO public.catalog_products (id, slug, name, status)
VALUES ('d2222222-2222-4222-8222-222222222222', 'local-inventory-fixture', 'Local inventory fixture', 'active');
INSERT INTO public.catalog_skus (id, product_id, sku, title, pet_type, status, net_weight_g, kcal_per_unit)
VALUES ('d3333333-3333-4333-8333-333333333333', 'd2222222-2222-4222-8222-222222222222',
        'LOCAL-INVENTORY-FIXTURE', 'Local inventory fixture', 'other', 'active', 1, 1);
INSERT INTO public.commerce_orders (id, client_id, status, currency, region_code, mode, total_cents, subtotal_cents)
VALUES ('d4444444-4444-4444-8444-444444444444', 'd1111111-1111-4111-8111-111111111111',
        'pending_payment', public.platform_settlement_currency(), public.platform_region_code(), 'one_time', 3000, 3000);
INSERT INTO public.inventory_locations (id, code, display_name, kind, status, fulfillable, region)
VALUES ('d5555555-5555-4555-8555-555555555555', 'local-inventory-fixture', 'Local inventory fixture',
        'internal_warehouse', 'active', true, public.platform_region_code());
INSERT INTO public.inventory_lots (id, sku_id, lot_code, expires_at)
VALUES ('d6666666-6666-4666-8666-666666666666', 'd3333333-3333-4333-8333-333333333333',
        'local-inventory-lot', now() + interval '30 days');

-- Explicit inventory RPC set prevents an empty catalogue query passing vacuously.
SELECT is((SELECT count(*)::integer FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname IN (
    'inventory_adjust_stock', 'inventory_available_quantity',
    'inventory_consume_reservation_for_fulfillment', 'inventory_expire_reservations',
    'inventory_invalidate_lot', 'inventory_recount_reserved_balances',
    'inventory_release_reservation', 'inventory_reserve_order', 'inventory_reserve_order_items'
  )), 9, 'all nine declared non-trigger inventory RPCs exist');

-- Try each actual function under both browser roles. Typed nulls select the
-- shipped signature; if a grant leaks, a body error/success cannot masquerade as
-- the expected function permission denial. No grant fixture changes access.
SET LOCAL ROLE anon;
SELECT throws_ok(format('SELECT public.%I(%s)', p.proname,
  (SELECT string_agg('NULL::' || format_type(arg, NULL), ', ' ORDER BY ord)
   FROM unnest(p.proargtypes::oid[]) WITH ORDINALITY AS args(arg, ord))),
  '42501', 'permission denied for function ' || p.proname,
  'anon execute denied: ' || p.proname)
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname IN (
  'inventory_adjust_stock', 'inventory_available_quantity',
  'inventory_consume_reservation_for_fulfillment', 'inventory_expire_reservations',
  'inventory_invalidate_lot', 'inventory_recount_reserved_balances',
  'inventory_release_reservation', 'inventory_reserve_order', 'inventory_reserve_order_items'
) ORDER BY p.proname;
RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT throws_ok(format('SELECT public.%I(%s)', p.proname,
  (SELECT string_agg('NULL::' || format_type(arg, NULL), ', ' ORDER BY ord)
   FROM unnest(p.proargtypes::oid[]) WITH ORDINALITY AS args(arg, ord))),
  '42501', 'permission denied for function ' || p.proname,
  'authenticated execute denied: ' || p.proname)
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname IN (
  'inventory_adjust_stock', 'inventory_available_quantity',
  'inventory_consume_reservation_for_fulfillment', 'inventory_expire_reservations',
  'inventory_invalidate_lot', 'inventory_recount_reserved_balances',
  'inventory_release_reservation', 'inventory_reserve_order', 'inventory_reserve_order_items'
) ORDER BY p.proname;
RESET ROLE;

SET LOCAL ROLE service_role;
SELECT is(public.inventory_adjust_stock('local-boundary-receipt',
  'd3333333-3333-4333-8333-333333333333', 'd5555555-5555-4555-8555-555555555555',
  'd6666666-6666-4666-8666-666666666666', 5, 'synthetic_fixture')->>'replayed',
  'false', 'service role accepts stock operation with shipped grants');
RESET ROLE;
UPDATE public.inventory_balances SET safety_stock = 1
WHERE sku_id = 'd3333333-3333-4333-8333-333333333333';
SET LOCAL ROLE service_role;
SELECT public.inventory_reserve_order('local-boundary-hold',
  'd4444444-4444-4444-8444-444444444444', NULL, NULL,
  'd3333333-3333-4333-8333-333333333333', 3, 'checkout_payment_window', 'processing',
  now() + interval '30 minutes', '{}', NULL) AS reserved_result \gset
SELECT is(:'reserved_result'::jsonb->>'status', 'reserved', 'service role accepts local reservation');
SELECT is(:'reserved_result'::jsonb->>'replayed', 'false', 'first reserve is not a replay');
RESET ROLE;
SELECT is((SELECT count(*)::integer FROM public.inventory_balances
  WHERE sku_id = 'd3333333-3333-4333-8333-333333333333'), 1, 'nonempty physical balance witness');
SELECT is((SELECT count(*)::integer FROM public.inventory_reservations
  WHERE sku_id = 'd3333333-3333-4333-8333-333333333333'), 1, 'nonempty reservation witness');
SELECT is((SELECT count(*)::integer FROM public.inventory_stock_movements
  WHERE sku_id = 'd3333333-3333-4333-8333-333333333333'), 2, 'stock and reservation movements both exist');

-- Compare complete rows, including metadata/timestamps/identities, after refusal
-- and same-input replay. No empty or selected-counter comparison stands in for it.
CREATE TEMP VIEW local_boundary_state AS
SELECT jsonb_build_object(
  'balances', (SELECT jsonb_agg(to_jsonb(b) ORDER BY id) FROM public.inventory_balances b
    WHERE sku_id = 'd3333333-3333-4333-8333-333333333333'),
  'reservations', (SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM public.inventory_reservations r
    WHERE sku_id = 'd3333333-3333-4333-8333-333333333333'),
  'movements', (SELECT jsonb_agg(to_jsonb(m) ORDER BY id) FROM public.inventory_stock_movements m
    WHERE sku_id = 'd3333333-3333-4333-8333-333333333333')
) AS state;
CREATE TEMP TABLE local_boundary_before AS SELECT state FROM local_boundary_state;
SET LOCAL ROLE service_role;
SELECT throws_ok($$SELECT public.inventory_reserve_order('local-boundary-oversell',
  'd4444444-4444-4444-8444-444444444444', NULL, NULL,
  'd3333333-3333-4333-8333-333333333333', 2, 'checkout_payment_window', 'processing',
  now() + interval '30 minutes', '{}', NULL)$$,
  '23514', 'inventory_reservation_insufficient_available_stock',
  'local ATP refuses 2 when stock 5 minus safety 1 minus active hold 3 leaves 1');
RESET ROLE;
SELECT is((SELECT state FROM local_boundary_state), (SELECT state FROM local_boundary_before),
  'oversell refusal leaves all balance, reservation and movement rows unchanged');
SET LOCAL ROLE service_role;
SELECT is(public.inventory_reserve_order('local-boundary-hold',
  'd4444444-4444-4444-8444-444444444444', NULL, NULL,
  'd3333333-3333-4333-8333-333333333333', 3, 'checkout_payment_window', 'processing',
  now() + interval '30 minutes', '{}', NULL)->>'replayed', 'true', 'same-input reservation replays');
RESET ROLE;
SELECT is((SELECT state FROM local_boundary_state), (SELECT state FROM local_boundary_before),
  'same-input replay leaves complete nonempty state unchanged');

SELECT id AS reservation_id FROM public.inventory_reservations
WHERE idempotency_key = 'local-boundary-hold' \gset
SET LOCAL ROLE service_role;
SELECT is(public.inventory_consume_reservation_for_fulfillment('local-boundary-consume',
  :'reservation_id'::uuid)->>'status', 'consumed', 'service role consumes the local hold');
RESET ROLE;
SELECT is((SELECT on_hand FROM public.inventory_balances WHERE sku_id = 'd3333333-3333-4333-8333-333333333333'),
  2, 'consume subtracts physical stock exactly once');
SELECT is((SELECT reserved FROM public.inventory_balances WHERE sku_id = 'd3333333-3333-4333-8333-333333333333'),
  0, 'consume clears reserved counter');
CREATE TEMP TABLE local_boundary_consumed AS SELECT state FROM local_boundary_state;
SET LOCAL ROLE service_role;
SELECT is(public.inventory_consume_reservation_for_fulfillment('local-boundary-consume',
  :'reservation_id'::uuid)->>'replayed', 'true', 'same reservation consumption replays');
RESET ROLE;
SELECT is((SELECT state FROM local_boundary_state), (SELECT state FROM local_boundary_consumed),
  'consume replay leaves all complete state unchanged');
SELECT is((SELECT count(*)::integer FROM public.inventory_stock_movements
  WHERE sku_id = 'd3333333-3333-4333-8333-333333333333' AND movement_type = 'reservation_consumed'),
  1, 'consume and replay produce exactly one consumption movement');
SELECT * FROM finish();
ROLLBACK;
