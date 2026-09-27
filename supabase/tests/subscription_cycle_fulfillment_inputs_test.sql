-- pgTAP: subscription_cycle renewal orders carry OMS/fulfillment inputs and
-- reserve inventory before payment success/outbox fulfillment.
--
-- Run via: supabase db reset && supabase test db

BEGIN;
SELECT plan(5);

INSERT INTO public.clients (id, email)
VALUES ('a9100000-0000-0000-0000-000000000001', 'cycle-fulfillment@example.invalid');

INSERT INTO public.pets (id, client_id, pet_type, name)
VALUES ('a9200000-0000-0000-0000-000000000001', 'a9100000-0000-0000-0000-000000000001', 'dog', 'Fulfill');

INSERT INTO public.addresses (id, client_id, kind, line1, city, postal_code)
VALUES ('a9300000-0000-0000-0000-000000000001', 'a9100000-0000-0000-0000-000000000001', 'shipping', 'Testowa 1', 'Warszawa', '00-001');

INSERT INTO public.catalog_products (id, slug, name, status)
VALUES ('a9400000-0000-0000-0000-000000000001', 'cycle-fulfillment-product', 'Cycle Fulfillment Product', 'active');

INSERT INTO public.catalog_skus (id, product_id, sku, title, pet_type, status, net_weight_g, kcal_per_unit)
VALUES ('a9500000-0000-0000-0000-000000000001', 'a9400000-0000-0000-0000-000000000001', 'CYCLE-FULFILLMENT', 'Cycle Fulfillment', 'dog', 'active', 400, 500);

-- Renewal now reserves via the Omnipack ORACLE path, so seed the oracle
-- (fulfillment_provider_upsert_stock_current) instead of a local balance. It
-- auto-creates the lot_id=NULL mirror balance at the omnipack-stock-master
-- location (from the fulfillment_provider_stock_authority migration).
SELECT public.fulfillment_provider_upsert_stock_current(
  'cycle-fulfillment-oracle-1',
  'omnipack',
  'CYCLE-FULFILLMENT',
  10, 10, 0,
  now(),
  now() + interval '6 hours',
  'cycle-fulfillment-oracle-run-1',
  '{"source":"pgtap"}'::jsonb
);

INSERT INTO public.subscriptions (
  id, client_id, pet_id, shipping_address_id, cadence_days, currency, status, next_cycle_at, payment_method_ref, size_constraint
)
VALUES (
  'a9800000-0000-0000-0000-000000000001',
  'a9100000-0000-0000-0000-000000000001',
  'a9200000-0000-0000-0000-000000000001',
  'a9300000-0000-0000-0000-000000000001',
  28,
  'PLN',
  'active',
  '2026-07-20T08:00:00Z',
  'pm_cycle_fulfillment',
  '{"kind":"feeding_days","value":28}'::jsonb
);

INSERT INTO public.subscription_lines (
  id, subscription_id, variant_id, qty, sort_order, is_addon, template_version, line_metadata
)
VALUES (
  'a9810000-0000-0000-0000-000000000001',
  'a9800000-0000-0000-0000-000000000001',
  'a9500000-0000-0000-0000-000000000001',
  2,
  1,
  false,
  1,
  '{"productSnapshot":{"quoteLine":{"sku":"CYCLE-FULFILLMENT"}}}'::jsonb
);

INSERT INTO public.subscription_cycles (id, subscription_id, cycle_number, scheduled_at, status, engine_idempotency_key)
VALUES ('a9900000-0000-0000-0000-000000000001', 'a9800000-0000-0000-0000-000000000001', 1,
        '2026-07-20T08:00:00Z', 'planned', 'cycle-fulfillment-1');

INSERT INTO public.commerce_orders (
  id, client_id, status, mode, currency, subscription_id, subscription_cycle_id, metadata
)
VALUES (
  'aa000000-0000-0000-0000-000000000001',
  'a9100000-0000-0000-0000-000000000001',
  'pending_payment',
  'subscription_cycle',
  'PLN',
  'a9800000-0000-0000-0000-000000000001',
  'a9900000-0000-0000-0000-000000000001',
  '{"paymentStatus":"pending","source":"subscription.own_engine.v0"}'::jsonb
);

SELECT is(
  (SELECT shipping_address_id FROM public.commerce_orders WHERE id = 'aa000000-0000-0000-0000-000000000001'),
  'a9300000-0000-0000-0000-000000000001'::uuid,
  'subscription_cycle order inherits shipping_address_id from subscription');

SELECT is(
  (SELECT pet_id FROM public.commerce_orders WHERE id = 'aa000000-0000-0000-0000-000000000001'),
  'a9200000-0000-0000-0000-000000000001'::uuid,
  'subscription_cycle order inherits pet_id from subscription');

INSERT INTO public.commerce_order_items (
  id, order_id, sku_id, quantity, unit_price_cents, total_cents, discount_allocated_cents, effective_total_cents, effective_net_cents, product_snapshot
)
VALUES (
  'aa100000-0000-0000-0000-000000000001',
  'aa000000-0000-0000-0000-000000000001',
  'a9500000-0000-0000-0000-000000000001',
  2,
  1000,
  2000, 0, 2000, round((2000)::numeric * 10000 / (10000 + (800)::integer))::integer,
  '{"sku":"CYCLE-FULFILLMENT"}'::jsonb
);

SELECT is(
  (SELECT count(*)::int FROM public.inventory_reservations
    WHERE order_id = 'aa000000-0000-0000-0000-000000000001'
      AND order_item_id = 'aa100000-0000-0000-0000-000000000001'
      AND status = 'reserved'),
  1,
  'subscription_cycle order item reserves inventory');

SELECT is(
  (SELECT count(*)::int FROM public.inventory_reservations r
     JOIN public.inventory_locations l ON l.id = r.location_id
    WHERE r.order_item_id = 'aa100000-0000-0000-0000-000000000001'
      AND r.status = 'reserved'
      AND l.code = 'omnipack-stock-master'
      AND r.metadata ->> 'providerKind' = 'omnipack'),
  1,
  'subscription_cycle renewal reserves via the Omnipack oracle path (omnipack-stock-master)');

INSERT INTO public.subscription_cycles (id, subscription_id, cycle_number, scheduled_at, status, engine_idempotency_key)
VALUES ('a9900000-0000-0000-0000-000000000002', 'a9800000-0000-0000-0000-000000000001', 2,
        '2026-08-20T08:00:00Z', 'planned', 'cycle-fulfillment-2');

INSERT INTO public.commerce_orders (
  id, client_id, status, mode, currency, subscription_id, subscription_cycle_id, metadata
)
VALUES (
  'aa000000-0000-0000-0000-000000000002',
  'a9100000-0000-0000-0000-000000000001',
  'pending_payment',
  'subscription_cycle',
  'PLN',
  'a9800000-0000-0000-0000-000000000001',
  'a9900000-0000-0000-0000-000000000002',
  '{"paymentStatus":"pending","source":"subscription.own_engine.v0","selectedDelivery":{"providerKind":"dhl"}}'::jsonb
);

CREATE TEMP TABLE _non_omnipack_renewal_probe (blocked boolean NOT NULL);
DO $$
BEGIN
  INSERT INTO public.commerce_order_items (
    id, order_id, sku_id, quantity, unit_price_cents, total_cents, discount_allocated_cents, effective_total_cents, effective_net_cents, product_snapshot
  )
  VALUES (
    'aa100000-0000-0000-0000-000000000002',
    'aa000000-0000-0000-0000-000000000002',
    'a9500000-0000-0000-0000-000000000001',
    1,
    1000,
    1000, 0, 1000, round((1000)::numeric * 10000 / (10000 + (800)::integer))::integer,
    '{"sku":"CYCLE-FULFILLMENT"}'::jsonb
  );
  INSERT INTO _non_omnipack_renewal_probe VALUES (false);
EXCEPTION WHEN check_violation THEN
  IF SQLERRM NOT LIKE '%inventory_external_provider_stock_missing%' THEN
    RAISE;
  END IF;
  INSERT INTO _non_omnipack_renewal_probe VALUES (true);
END;
$$;

SELECT ok(
  (SELECT blocked FROM _non_omnipack_renewal_probe),
  'subscription_cycle renewal with explicit non-Omnipack provider fails closed before local ATP');

SELECT * FROM finish();
ROLLBACK;
