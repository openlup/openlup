-- IL-P2 characterization: these assertions pin known gaps, not safe admission.
-- A future repair must enumerate changed expectations rather than silently rebase them.
BEGIN;
SELECT plan(10);

INSERT INTO public.clients (id, email)
VALUES ('c4111111-1111-4111-8111-111111111111', 'replay-characterization@example.invalid');
INSERT INTO public.catalog_products (id, slug, name, status)
VALUES ('c4222222-2222-4222-8222-222222222222', 'replay-characterization', 'Replay fixture', 'active');
INSERT INTO public.catalog_skus (id, product_id, sku, title, pet_type, status, net_weight_g, kcal_per_unit)
VALUES ('c4333333-3333-4333-8333-333333333333', 'c4222222-2222-4222-8222-222222222222',
        'REPLAY-FIXTURE', 'Replay fixture', 'other', 'active', 1, 1);
INSERT INTO public.commerce_orders (id, client_id, status, currency, region_code, mode, total_cents, subtotal_cents)
VALUES ('c4444444-4444-4444-8444-444444444444', 'c4111111-1111-4111-8111-111111111111',
        'pending_payment', public.platform_settlement_currency(), public.platform_region_code(), 'one_time', 3000, 3000);
INSERT INTO public.commerce_order_items
  (id, order_id, sku_id, quantity, unit_price_cents, total_cents,
   discount_allocated_cents, effective_total_cents, effective_net_cents, product_snapshot)
VALUES ('c4555555-5555-4555-8555-555555555555', 'c4444444-4444-4444-8444-444444444444',
        'c4333333-3333-4333-8333-333333333333', 3, 1000, 3000, 0, 3000,
        round(3000::numeric * 10000 / 10800)::integer, '{"sku":"REPLAY-FIXTURE"}');
INSERT INTO public.inventory_locations (id, code, display_name, kind)
VALUES ('c4666666-6666-4666-8666-666666666666', 'replay-fixture', 'Replay fixture', 'internal_warehouse');
INSERT INTO public.inventory_lots (id, sku_id, lot_code)
VALUES ('c4777777-7777-4777-8777-777777777771', 'c4333333-3333-4333-8333-333333333333', 'replay-lot-1'),
       ('c4777777-7777-4777-8777-777777777772', 'c4333333-3333-4333-8333-333333333333', 'replay-lot-2');

-- Synthetic historical multi-lot rows lack a canonical generation receipt.
-- No stock availability or provider access is involved in these early replays.
INSERT INTO public.inventory_reservations
  (id, idempotency_key, order_id, order_item_id, sku_id, location_id, lot_id,
   quantity, status, kind, expires_at)
SELECT reservation_id, 'replay-fixture:c4555555-5555-4555-8555-555555555555',
       'c4444444-4444-4444-8444-444444444444', 'c4555555-5555-4555-8555-555555555555',
       'c4333333-3333-4333-8333-333333333333', 'c4666666-6666-4666-8666-666666666666',
       lot_id, quantity, 'reserved', 'checkout_payment_window', now() + interval '30 minutes'
FROM (VALUES
  ('c4888888-8888-4888-8888-888888888881'::uuid, 'c4777777-7777-4777-8777-777777777771'::uuid, 1),
  ('c4888888-8888-4888-8888-888888888882'::uuid, 'c4777777-7777-4777-8777-777777777772'::uuid, 2)
) AS historical(reservation_id, lot_id, quantity);

CREATE TEMP TABLE replay_before AS
SELECT jsonb_agg(to_jsonb(r) ORDER BY id) AS rows FROM public.inventory_reservations r
WHERE order_id = 'c4444444-4444-4444-8444-444444444444';
CREATE TEMP TABLE replay_result AS
SELECT public.inventory_reserve_order(
  'replay-fixture:c4555555-5555-4555-8555-555555555555',
  'c4444444-4444-4444-8444-444444444444', 'c4555555-5555-4555-8555-555555555555', NULL,
  'c4333333-3333-4333-8333-333333333333', 99, 'manual_ops', 'processing',
  now() + interval '2 days', '{}', NULL
) AS result;
SELECT is((SELECT result->>'replayed' FROM replay_result), 'true',
  'KNOWN GAP: changed quantity/kind/expiry accepted as replay');
SELECT ok((SELECT result->>'reservationId' IN (
  'c4888888-8888-4888-8888-888888888881', 'c4888888-8888-4888-8888-888888888882'
) FROM replay_result), 'legacy replay returns one member of two-lot generation');
SELECT ok((SELECT NOT (result ? 'reservationIds') FROM replay_result),
  'KNOWN GAP: replay omits complete allocation ID list');
SELECT is((SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM public.inventory_reservations r
  WHERE order_id = 'c4444444-4444-4444-8444-444444444444'),
  (SELECT rows FROM replay_before), 'replay does not modify rows or renew expiry');

UPDATE public.inventory_reservations SET status = 'released', released_at = now()
WHERE order_id = 'c4444444-4444-4444-8444-444444444444';
CREATE TEMP TABLE released_before AS
SELECT jsonb_agg(to_jsonb(r) ORDER BY id) AS rows FROM public.inventory_reservations r
WHERE order_id = 'c4444444-4444-4444-8444-444444444444';
CREATE TEMP TABLE batch_result AS
SELECT public.inventory_reserve_order_items(
  'replay-fixture', 'c4444444-4444-4444-8444-444444444444', NULL,
  '[{"orderItemId":"c4555555-5555-4555-8555-555555555555","skuId":"c4333333-3333-4333-8333-333333333333","quantity":3}]',
  'checkout_payment_window', 'processing', now() + interval '30 minutes', '{}', NULL
) AS result;
SELECT is((SELECT result->>'status' FROM batch_result), 'reserved',
  'KNOWN GAP: batch claims reserved when child is released');
SELECT is((SELECT result#>>'{reservations,0,status}' FROM batch_result), 'released',
  'child preserves historical released state');
SELECT is((SELECT result#>>'{reservations,0,replayed}' FROM batch_result), 'true',
  'existing child-key bytes address historical generation');
SELECT is((SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM public.inventory_reservations r
  WHERE order_id = 'c4444444-4444-4444-8444-444444444444'),
  (SELECT rows FROM released_before), 'batch replay leaves released rows unchanged');
SELECT is((SELECT count(*)::integer FROM public.inventory_stock_movements
  WHERE sku_id = 'c4333333-3333-4333-8333-333333333333'), 0, 'neither replay creates movements');
SELECT is((SELECT count(*)::integer FROM public.inventory_balances
  WHERE sku_id = 'c4333333-3333-4333-8333-333333333333'), 0, 'neither replay creates balances');
SELECT * FROM finish();
ROLLBACK;
