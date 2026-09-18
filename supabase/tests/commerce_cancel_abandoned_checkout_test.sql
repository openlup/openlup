-- pgTAP: commerce_cancel_abandoned_checkout (20260711170200).
--
--   * a stock-conflict 409 on subscription-mode checkout leaves a finalized
--     draft order + pending_activation subscription behind (finalize runs
--     before the stock reserve that fails) — this RPC is the synchronous,
--     single-order compensation the checkout handler calls right after
--     deciding the 409, so the customer is never left with a phantom
--     subscription: order -> cancelled, subscription + its cycle -> cancelled,
--     the checkout inventory hold is released (via the existing
--     commerce_release_reservations_on_cancel trigger), and the same
--     subscription.activation_abandoned event the age-based sweep emits fires
--     once.
--   * an order that already reached a terminal/paid state is never touched
--     (money was taken — cancelling here would be wrong).
--
-- Run via: supabase db reset && supabase test db

BEGIN;
SELECT plan(6);

-- ---- Shared catalog fixture -----------------------------------------------
INSERT INTO public.clients (id, email)
VALUES ('11111111-1111-1111-1111-111111111112', 'checkout-cancel-abandoned@example.invalid');
INSERT INTO public.pets (id, client_id, pet_type) VALUES
  ('22222222-2222-2222-2222-222222220a0a', '11111111-1111-1111-1111-111111111112', 'dog'),
  ('22222222-2222-2222-2222-222222220b0b', '11111111-1111-1111-1111-111111111112', 'dog');
INSERT INTO public.addresses (id, client_id, kind, line1, city, postal_code)
VALUES ('33333333-3333-3333-3333-333333333334', '11111111-1111-1111-1111-111111111112', 'shipping', 'Testowa 2', 'Warszawa', '00-002');
INSERT INTO public.catalog_products (id, slug, name, status)
VALUES ('44444444-4444-4444-4444-444444444445', 'cancel-abandoned-prod', 'Cancel Abandoned Prod', 'active');
INSERT INTO public.catalog_skus (id, product_id, sku, title, pet_type, net_weight_g, kcal_per_unit, status)
VALUES ('55555555-5555-5555-5555-555555555556', '44444444-4444-4444-4444-444444444445', 'CAB-SKU-1', 'Cab SKU 1', 'dog', 400, 350, 'active');
INSERT INTO public.inventory_locations (id, code, display_name, kind, status, fulfillable)
VALUES ('66666666-6666-6666-6666-666666666667', 'cab-loc', 'Cab Loc', 'virtual', 'active', true);

-- ===== Scenario A — stock-conflict 409: order finalized, reserve never succeeded =====
INSERT INTO public.commerce_orders (id, client_id, currency, region_code, size_constraint, status, total_cents, subtotal_cents)
VALUES ('a0000000-0000-0000-0000-0000000000aa', '11111111-1111-1111-1111-111111111112', 'PLN', 'PL', '{"kind":"feeding_days","value":21}'::jsonb, 'draft', 2680, 2680);
INSERT INTO public.commerce_order_items (id, order_id, sku_id, quantity, unit_price_cents, total_cents, discount_allocated_cents, effective_total_cents, effective_net_cents, product_snapshot)
VALUES ('a1000000-0000-0000-0000-0000000000aa', 'a0000000-0000-0000-0000-0000000000aa', '55555555-5555-5555-5555-555555555556', 2, 1340, 2680, 0, 2680, round((2680)::numeric * 10000 / (10000 + (800)::integer))::integer, '{"sku":"CAB-SKU-1"}'::jsonb);
CREATE TEMP TABLE _a AS
SELECT (r->>'subscriptionId')::uuid AS sub_id, (r->>'subscriptionCycleId')::uuid AS cyc_id
FROM (SELECT public.subscription_create_provisional_for_checkout(
  'a0000000-0000-0000-0000-0000000000aa','11111111-1111-1111-1111-111111111112',
  '22222222-2222-2222-2222-222222220a0a','33333333-3333-3333-3333-333333333334',
  '{"quote":{"context":{"mode":"subscription","cadenceDays":21}}}'::jsonb) AS r) s;
UPDATE public.commerce_orders SET mode='subscription_cycle',
       subscription_id=(SELECT sub_id FROM _a), subscription_cycle_id=(SELECT cyc_id FROM _a)
 WHERE id='a0000000-0000-0000-0000-0000000000aa';
-- The reserve step ran but hit a conflict on the LAST item — an earlier item's
-- reservation can still land before the conflicting one fails, so compensation
-- must cover a reservation that DID land, not just the all-or-nothing case.
INSERT INTO public.inventory_reservations (id, idempotency_key, order_id, sku_id, location_id, quantity, status, kind)
VALUES ('a2e50000-0000-0000-0000-0000000000aa','cab-a-resv','a0000000-0000-0000-0000-0000000000aa',
        '55555555-5555-5555-5555-555555555556','66666666-6666-6666-6666-666666666667',2,'reserved','checkout_payment_window');

SELECT public.commerce_cancel_abandoned_checkout(
  'checkout-cancel-test-a', 'a0000000-0000-0000-0000-0000000000aa', 'checkout_stock_unavailable');

-- ===== Scenario B — order already paid: must never be touched =====
INSERT INTO public.commerce_orders (id, client_id, currency, region_code, size_constraint, status, total_cents, subtotal_cents)
VALUES ('a0000000-0000-0000-0000-0000000000bb', '11111111-1111-1111-1111-111111111112', 'PLN', 'PL', '{"kind":"feeding_days","value":21}'::jsonb, 'draft', 2680, 2680);
INSERT INTO public.commerce_order_items (id, order_id, sku_id, quantity, unit_price_cents, total_cents, discount_allocated_cents, effective_total_cents, effective_net_cents, product_snapshot)
VALUES ('a1000000-0000-0000-0000-0000000000bb', 'a0000000-0000-0000-0000-0000000000bb', '55555555-5555-5555-5555-555555555556', 2, 1340, 2680, 0, 2680, round((2680)::numeric * 10000 / (10000 + (800)::integer))::integer, '{"sku":"CAB-SKU-1"}'::jsonb);
CREATE TEMP TABLE _b AS
SELECT (r->>'subscriptionId')::uuid AS sub_id, (r->>'subscriptionCycleId')::uuid AS cyc_id
FROM (SELECT public.subscription_create_provisional_for_checkout(
  'a0000000-0000-0000-0000-0000000000bb','11111111-1111-1111-1111-111111111112',
  '22222222-2222-2222-2222-222222220b0b','33333333-3333-3333-3333-333333333334',
  '{"quote":{"context":{"mode":"subscription","cadenceDays":21}}}'::jsonb) AS r) s;
UPDATE public.commerce_orders SET mode='subscription_cycle', status='paid',
       subscription_id=(SELECT sub_id FROM _b), subscription_cycle_id=(SELECT cyc_id FROM _b)
 WHERE id='a0000000-0000-0000-0000-0000000000bb';

CREATE TEMP TABLE _res_b AS
SELECT public.commerce_cancel_abandoned_checkout(
  'checkout-cancel-test-b', 'a0000000-0000-0000-0000-0000000000bb', 'checkout_stock_unavailable') AS result;

-- ---- Assertions -----------------------------------------------------------
SELECT is((SELECT status FROM public.commerce_orders WHERE id='a0000000-0000-0000-0000-0000000000aa'),
  'cancelled', 'A: abandoned order cancelled');
SELECT is((SELECT status FROM public.subscriptions WHERE id=(SELECT sub_id FROM _a)),
  'cancelled', 'A: provisional subscription cancelled');
SELECT is((SELECT status FROM public.subscription_cycles WHERE id=(SELECT cyc_id FROM _a)),
  'cancelled', 'A: provisional cycle cancelled');
SELECT is((SELECT status FROM public.inventory_reservations WHERE id='a2e50000-0000-0000-0000-0000000000aa'),
  'released', 'A: checkout inventory hold released via cancel trigger');
SELECT is((SELECT count(*)::int FROM public.subscription_events
            WHERE subscription_id=(SELECT sub_id FROM _a) AND event_type='subscription.activation_abandoned'),
  1, 'A: activation_abandoned event emitted');

SELECT is((SELECT status FROM public.commerce_orders WHERE id='a0000000-0000-0000-0000-0000000000bb'),
  'paid', 'B: paid order untouched (never cancel a paid order)');

SELECT * FROM finish();
ROLLBACK;
