-- pgTAP: releasing inventory reservations on order cancellation (20260711144001).
--   * a paid -> cancelled transition releases the order's pinned reservation and
--     decrements the reserved balance exactly once;
--   * an un-cancelled paid order keeps its reservation reserved;
--   * re-cancelling (idempotent replay) does not decrement the balance twice;
--   * cancelling an order whose reservation was already CONSUMED (fulfilled) leaves
--     the consumed row untouched — no double-release, no balance change (E3): the
--     release wrapper only iterates status='reserved' rows, so a consumed hold is
--     skipped. This is the fulfil-then-cancel safety case that avoids negative stock.
--
-- Run via: supabase db reset && supabase test db

BEGIN;
SELECT plan(9);

INSERT INTO public.clients (id, email)
VALUES ('a1000000-0000-4000-8000-000000000001', 'order-cancel-release@example.invalid');

INSERT INTO public.catalog_products (id, slug, name, status)
VALUES
  ('a2000000-0000-4000-8000-000000000001', 'cancel-alpha', 'Cancel Alpha', 'active'),
  ('a2000000-0000-4000-8000-000000000002', 'cancel-beta', 'Cancel Beta', 'active'),
  ('a2000000-0000-4000-8000-000000000003', 'cancel-gamma', 'Cancel Gamma', 'active');

INSERT INTO public.catalog_skus (id, product_id, sku, title, pet_type, status, net_weight_g, kcal_per_unit)
VALUES
  ('a3000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000001', 'CANCEL-ALPHA', 'Cancel Alpha', 'other', 'active', 1, 1),
  ('a3000000-0000-4000-8000-000000000002', 'a2000000-0000-4000-8000-000000000002', 'CANCEL-BETA', 'Cancel Beta', 'other', 'active', 1, 1),
  ('a3000000-0000-4000-8000-000000000003', 'a2000000-0000-4000-8000-000000000003', 'CANCEL-GAMMA', 'Cancel Gamma', 'other', 'active', 1, 1);

INSERT INTO public.inventory_locations (id, code, display_name, kind, status, fulfillable)
VALUES ('a4000000-0000-4000-8000-000000000001', 'cancel-release', 'Cancel release', 'virtual', 'active', true);

INSERT INTO public.inventory_balances (id, sku_id, location_id, on_hand, reserved)
VALUES
  ('a5000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000001', 'a4000000-0000-4000-8000-000000000001', 10, 1),
  ('a5000000-0000-4000-8000-000000000002', 'a3000000-0000-4000-8000-000000000002', 'a4000000-0000-4000-8000-000000000001', 10, 1),
  -- Gamma mirrors a post-consume balance: the 1-unit hold was already consumed at
  -- fulfilment (on_hand 10->9, reserved back to 0), so a later cancel must be a no-op.
  ('a5000000-0000-4000-8000-000000000003', 'a3000000-0000-4000-8000-000000000003', 'a4000000-0000-4000-8000-000000000001', 9, 0);

-- Order X: paid, pinned reservation (expires_at NULL). Cancelling it must release.
INSERT INTO public.commerce_orders (id, client_id, status, currency, region_code, mode, size_constraint, total_cents, subtotal_cents)
VALUES ('a6000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001',
        'paid', 'PLN', 'PL', 'one_time', '{"kind":"unit_count","value":1}'::jsonb, 1000, 1000);
INSERT INTO public.inventory_reservations (
  id, idempotency_key, order_id, sku_id, location_id, quantity, status, kind, expires_at
) VALUES (
  'a7000000-0000-4000-8000-000000000001', 'order-cancel-x-reservation',
  'a6000000-0000-4000-8000-000000000001',
  'a3000000-0000-4000-8000-000000000001', 'a4000000-0000-4000-8000-000000000001',
  1, 'reserved', 'checkout_payment_window', NULL
);

-- Order Y: paid control that stays paid — its reservation must remain reserved.
INSERT INTO public.commerce_orders (id, client_id, status, currency, region_code, mode, size_constraint, total_cents, subtotal_cents)
VALUES ('a6000000-0000-4000-8000-000000000002', 'a1000000-0000-4000-8000-000000000001',
        'paid', 'PLN', 'PL', 'one_time', '{"kind":"unit_count","value":1}'::jsonb, 1000, 1000);
INSERT INTO public.inventory_reservations (
  id, idempotency_key, order_id, sku_id, location_id, quantity, status, kind, expires_at
) VALUES (
  'a7000000-0000-4000-8000-000000000002', 'order-cancel-y-reservation',
  'a6000000-0000-4000-8000-000000000002',
  'a3000000-0000-4000-8000-000000000002', 'a4000000-0000-4000-8000-000000000001',
  1, 'reserved', 'checkout_payment_window', NULL
);

UPDATE public.commerce_orders SET status = 'cancelled'
 WHERE id = 'a6000000-0000-4000-8000-000000000001';

SELECT is((SELECT status FROM public.inventory_reservations WHERE id='a7000000-0000-4000-8000-000000000001'),
  'released', 'paid -> cancelled releases the order reservation');
SELECT isnt((SELECT released_at FROM public.inventory_reservations WHERE id='a7000000-0000-4000-8000-000000000001'),
  NULL, 'released reservation records released_at');
SELECT is((SELECT reserved FROM public.inventory_balances WHERE id='a5000000-0000-4000-8000-000000000001'),
  0, 'release decrements the reserved balance exactly once');

SELECT is((SELECT status FROM public.inventory_reservations WHERE id='a7000000-0000-4000-8000-000000000002'),
  'reserved', 'un-cancelled paid order keeps its reservation reserved');
SELECT is((SELECT reserved FROM public.inventory_balances WHERE id='a5000000-0000-4000-8000-000000000002'),
  1, 'un-cancelled order reserved balance is untouched');

-- Idempotent replay: writing 'cancelled' again must not double-release.
UPDATE public.commerce_orders SET status = 'cancelled', updated_at = now()
 WHERE id = 'a6000000-0000-4000-8000-000000000001';
SELECT is((SELECT reserved FROM public.inventory_balances WHERE id='a5000000-0000-4000-8000-000000000001'),
  0, 're-cancel does not decrement the reserved balance twice');

-- Order Z (E3): paid order whose reservation was already CONSUMED at fulfilment.
-- Cancelling it must NOT release the consumed hold (that would double-count/undercount
-- physically-shipped stock) — the release wrapper only touches status='reserved'.
INSERT INTO public.commerce_orders (id, client_id, status, currency, region_code, mode, size_constraint, total_cents, subtotal_cents)
VALUES ('a6000000-0000-4000-8000-000000000003', 'a1000000-0000-4000-8000-000000000001',
        'paid', 'PLN', 'PL', 'one_time', '{"kind":"unit_count","value":1}'::jsonb, 1000, 1000);
INSERT INTO public.inventory_reservations (
  id, idempotency_key, order_id, sku_id, location_id, quantity, status, kind, expires_at, consumed_at
) VALUES (
  'a7000000-0000-4000-8000-000000000003', 'order-cancel-z-reservation',
  'a6000000-0000-4000-8000-000000000003',
  'a3000000-0000-4000-8000-000000000003', 'a4000000-0000-4000-8000-000000000001',
  1, 'consumed', 'checkout_payment_window', NULL, now()
);

UPDATE public.commerce_orders SET status = 'cancelled'
 WHERE id = 'a6000000-0000-4000-8000-000000000003';

SELECT is((SELECT status FROM public.inventory_reservations WHERE id='a7000000-0000-4000-8000-000000000003'),
  'consumed', 'cancel-after-consume leaves the consumed reservation consumed (not released)');
SELECT ok((SELECT released_at FROM public.inventory_reservations WHERE id='a7000000-0000-4000-8000-000000000003') IS NULL,
  'consumed reservation is not stamped released_at by a later cancel');
SELECT is((SELECT reserved FROM public.inventory_balances WHERE id='a5000000-0000-4000-8000-000000000003'),
  0, 'cancel-after-consume does not mutate the (already-decremented) reserved balance');

SELECT * FROM finish();
ROLLBACK;
