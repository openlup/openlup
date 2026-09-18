-- pgTAP: reservation lease semantics do not depend on a sweep cron.
--
-- Run via: supabase db reset && supabase test db

BEGIN;
SELECT plan(6);

INSERT INTO public.providers (kind, capability, display_name, status)
VALUES ('omnipack', 'fulfillment', 'OmniPack Fulfillment', 'experimental')
ON CONFLICT (kind) DO NOTHING;

INSERT INTO public.clients (id, email, first_name, last_name, lifecycle_stage)
VALUES (
  '10101010-1010-4010-8010-101010101010',
  'no-cron-leases@example.test',
  'NoCron',
  'Lease',
  'customer'
);

INSERT INTO public.addresses (id, client_id, kind, label, line1, city, postal_code, country, is_default)
VALUES (
  '20202020-2020-4020-8020-202020202020',
  '10101010-1010-4010-8010-101010101010',
  'shipping',
  'Lease',
  'Prosta 1',
  'Warszawa',
  '00-001',
  'PL',
  true
);

INSERT INTO public.catalog_products (id, slug, status, name)
VALUES
  ('30303030-3030-4030-8030-303030303031', 'no-cron-lease-alpha', 'active', 'No Cron Lease Alpha'),
  ('30303030-3030-4030-8030-303030303032', 'no-cron-lease-beta', 'active', 'No Cron Lease Beta');

INSERT INTO public.catalog_skus (id, product_id, sku, title, pet_type, status, net_weight_g, kcal_per_unit)
VALUES
  (
    '40404040-4040-4040-8040-404040404041',
    '30303030-3030-4030-8030-303030303031',
    'OPENLUP-NO-CRON-LEASE-A',
    'No Cron Lease Alpha 400g',
    'dog',
    'active',
    400,
    420
  ),
  (
    '40404040-4040-4040-8040-404040404042',
    '30303030-3030-4030-8030-303030303032',
    'OPENLUP-NO-CRON-LEASE-B',
    'No Cron Lease Beta 400g',
    'dog',
    'active',
    400,
    420
  );

SELECT public.fulfillment_provider_upsert_stock_current(
  'no-cron-lease-provider-a',
  'omnipack',
  'OPENLUP-NO-CRON-LEASE-A',
  5,
  5,
  0,
  now(),
  now() + interval '6 hours',
  'no-cron-lease-run',
  '{"source":"pgtap"}'::jsonb
);

INSERT INTO public.commerce_orders (id, client_id, status, currency, subtotal_cents, total_cents, mode, shipping_address_id, region_code)
VALUES (
  '50505050-5050-4050-8050-505050505051',
  '10101010-1010-4010-8010-101010101010',
  'pending_payment',
  'PLN',
  5000,
  5000,
  'one_time',
  '20202020-2020-4020-8020-202020202020',
  'PL'
);
INSERT INTO public.commerce_order_items (id, order_id, sku_id, quantity, unit_price_cents, total_cents, discount_allocated_cents, effective_total_cents, effective_net_cents, product_snapshot)
VALUES (
  '60606060-6060-4060-8060-606060606061',
  '50505050-5050-4050-8050-505050505051',
  '40404040-4040-4040-8040-404040404041',
  5,
  1000,
  5000, 0, 5000, round((5000)::numeric * 10000 / (10000 + (800)::integer))::integer,
  '{"sku":"OPENLUP-NO-CRON-LEASE-A"}'::jsonb
);

INSERT INTO public.inventory_reservations (
  id,
  idempotency_key,
  order_id,
  order_item_id,
  sku_id,
  location_id,
  quantity,
  status,
  kind,
  expires_at,
  metadata
) VALUES (
  '70707070-7070-4070-8070-707070707071',
  'no-cron-lease-expired-a',
  '50505050-5050-4050-8050-505050505051',
  '60606060-6060-4060-8060-606060606061',
  '40404040-4040-4040-8040-404040404041',
  (SELECT id FROM public.inventory_locations WHERE code = 'omnipack-stock-master'),
  5,
  'reserved',
  'checkout_payment_window',
  now() - interval '10 minutes',
  '{"providerKind":"omnipack"}'::jsonb
);

UPDATE public.inventory_balances
   SET reserved = 5
 WHERE sku_id = '40404040-4040-4040-8040-404040404041'
   AND location_id = (SELECT id FROM public.inventory_locations WHERE code = 'omnipack-stock-master');

CREATE TEMP TABLE _fresh_reserve AS
SELECT public.inventory_reserve_order(
  'no-cron-lease-reserve-a',
  '50505050-5050-4050-8050-505050505051',
  '60606060-6060-4060-8060-606060606061',
  NULL,
  '40404040-4040-4040-8040-404040404041',
  5,
  'checkout_payment_window',
  'processing',
  now() + interval '30 minutes',
  '{"source":"pgtap"}'::jsonb,
  'omnipack'
) AS result;

SELECT is(
  (SELECT result->>'status' FROM _fresh_reserve),
  'reserved',
  'expired reserved rows do not block a fresh reservation even before cleanup'
);

CREATE TEMP TABLE _oversell_probe (blocked boolean NOT NULL);
DO $$
BEGIN
  PERFORM public.inventory_reserve_order(
    'no-cron-lease-oversell-a',
    '50505050-5050-4050-8050-505050505051',
    '60606060-6060-4060-8060-606060606061',
    NULL,
    '40404040-4040-4040-8040-404040404041',
    1,
    'checkout_payment_window',
    'processing',
    now() + interval '30 minutes',
    '{"source":"pgtap"}'::jsonb,
    'omnipack'
  );
  INSERT INTO _oversell_probe VALUES (false);
EXCEPTION WHEN check_violation THEN
  IF SQLERRM NOT LIKE '%inventory_external_provider_insufficient_available_stock%' THEN
    RAISE;
  END IF;
  INSERT INTO _oversell_probe VALUES (true);
END;
$$;

SELECT ok((SELECT blocked FROM _oversell_probe), 'active lease reservations still block oversell');

SELECT public.fulfillment_provider_upsert_stock_current(
  'no-cron-lease-provider-b',
  'omnipack',
  'OPENLUP-NO-CRON-LEASE-B',
  2,
  2,
  0,
  now(),
  now() + interval '6 hours',
  'no-cron-lease-run',
  '{"source":"pgtap"}'::jsonb
);

INSERT INTO public.commerce_orders (
  id,
  client_id,
  status,
  currency,
  subtotal_cents,
  total_cents,
  mode,
  shipping_address_id,
  region_code,
  metadata
)
VALUES (
  '50505050-5050-4050-8050-505050505052',
  '10101010-1010-4010-8010-101010101010',
  'pending_payment',
  'PLN',
  2000,
  2000,
  'one_time',
  '20202020-2020-4020-8020-202020202020',
  'PL',
  '{"runtimeFinalize":{"selectedDelivery":{"providerKind":"omnipack"}}}'::jsonb
);
INSERT INTO public.commerce_order_items (id, order_id, sku_id, quantity, unit_price_cents, total_cents, discount_allocated_cents, effective_total_cents, effective_net_cents, product_snapshot)
VALUES (
  '60606060-6060-4060-8060-606060606062',
  '50505050-5050-4050-8050-505050505052',
  '40404040-4040-4040-8040-404040404042',
  2,
  1000,
  2000, 0, 2000, round((2000)::numeric * 10000 / (10000 + (800)::integer))::integer,
  '{"sku":"OPENLUP-NO-CRON-LEASE-B"}'::jsonb
);

INSERT INTO public.inventory_reservations (
  id,
  idempotency_key,
  order_id,
  order_item_id,
  sku_id,
  location_id,
  quantity,
  status,
  kind,
  expires_at,
  metadata
) VALUES (
  '70707070-7070-4070-8070-707070707072',
  'no-cron-lease-expired-b',
  '50505050-5050-4050-8050-505050505052',
  '60606060-6060-4060-8060-606060606062',
  '40404040-4040-4040-8040-404040404042',
  (SELECT id FROM public.inventory_locations WHERE code = 'omnipack-stock-master'),
  2,
  'reserved',
  'checkout_payment_window',
  now() - interval '10 minutes',
  '{"providerKind":"omnipack"}'::jsonb
);

UPDATE public.inventory_balances
   SET reserved = 2
 WHERE sku_id = '40404040-4040-4040-8040-404040404042'
   AND location_id = (SELECT id FROM public.inventory_locations WHERE code = 'omnipack-stock-master');

UPDATE public.commerce_orders
   SET status = 'paid'
 WHERE id = '50505050-5050-4050-8050-505050505052';

SELECT is(
  (SELECT coalesce(sum(quantity), 0)::integer
     FROM public.inventory_reservations
    WHERE order_id = '50505050-5050-4050-8050-505050505052'
      AND status = 'reserved'
      AND expires_at IS NULL),
  2,
  'late payment success reacquires and pins a fresh reservation'
);

SELECT is(
  (SELECT count(*)::integer
     FROM public.inventory_reservations
    WHERE id = '70707070-7070-4070-8070-707070707072'
      AND expires_at <= now()),
  1,
  'expired audit reservation is not repinned by paid-order trigger'
);

SELECT is(
  (SELECT coalesce(sum(quantity), 0)::integer
     FROM public.inventory_reservations
    WHERE sku_id = '40404040-4040-4040-8040-404040404042'
      AND status = 'reserved'
      AND (expires_at IS NULL OR expires_at > now())),
  2,
  'active reservation predicate counts only pinned or unexpired leases'
);

INSERT INTO public.catalog_skus (id, product_id, sku, title, pet_type, status, net_weight_g, kcal_per_unit)
VALUES
  (
    '40404040-4040-4040-8040-404040404043',
    '30303030-3030-4030-8030-303030303031',
    'OPENLUP-NO-CRON-LEASE-C',
    'No Cron Lease Gamma 400g',
    'dog',
    'active',
    400,
    420
  ),
  (
    '40404040-4040-4040-8040-404040404044',
    '30303030-3030-4030-8030-303030303032',
    'OPENLUP-NO-CRON-LEASE-D',
    'No Cron Lease Delta 400g',
    'dog',
    'active',
    400,
    420
  );

SELECT public.fulfillment_provider_upsert_stock_current(
  'no-cron-lease-provider-c',
  'omnipack',
  'OPENLUP-NO-CRON-LEASE-C',
  1,
  1,
  0,
  now(),
  now() + interval '6 hours',
  'no-cron-lease-run',
  '{"source":"pgtap"}'::jsonb
);
SELECT public.fulfillment_provider_upsert_stock_current(
  'no-cron-lease-provider-d',
  'omnipack',
  'OPENLUP-NO-CRON-LEASE-D',
  0,
  0,
  0,
  now(),
  now() + interval '6 hours',
  'no-cron-lease-run',
  '{"source":"pgtap"}'::jsonb
);

INSERT INTO public.commerce_orders (id, client_id, status, currency, subtotal_cents, total_cents, mode, shipping_address_id, region_code)
VALUES (
  '50505050-5050-4050-8050-505050505053',
  '10101010-1010-4010-8010-101010101010',
  'pending_payment',
  'PLN',
  2000,
  2000,
  'one_time',
  '20202020-2020-4020-8020-202020202020',
  'PL'
);
INSERT INTO public.commerce_order_items (id, order_id, sku_id, quantity, unit_price_cents, total_cents, discount_allocated_cents, effective_total_cents, effective_net_cents, product_snapshot)
VALUES
  (
    '60606060-6060-4060-8060-606060606063',
    '50505050-5050-4050-8050-505050505053',
    '40404040-4040-4040-8040-404040404043',
    1,
    1000,
    1000, 0, 1000, round((1000)::numeric * 10000 / (10000 + (800)::integer))::integer,
    '{"sku":"OPENLUP-NO-CRON-LEASE-C"}'::jsonb
  ),
  (
    '60606060-6060-4060-8060-606060606064',
    '50505050-5050-4050-8050-505050505053',
    '40404040-4040-4040-8040-404040404044',
    1,
    1000,
    1000, 0, 1000, round((1000)::numeric * 10000 / (10000 + (800)::integer))::integer,
    '{"sku":"OPENLUP-NO-CRON-LEASE-D"}'::jsonb
  );

DO $$
BEGIN
  PERFORM public.inventory_reserve_order_items(
    'no-cron-lease-batch-atomic',
    '50505050-5050-4050-8050-505050505053',
    NULL,
    jsonb_build_array(
      jsonb_build_object(
        'orderItemId', '60606060-6060-4060-8060-606060606063',
        'skuId', '40404040-4040-4040-8040-404040404043',
        'quantity', 1
      ),
      jsonb_build_object(
        'orderItemId', '60606060-6060-4060-8060-606060606064',
        'skuId', '40404040-4040-4040-8040-404040404044',
        'quantity', 1
      )
    ),
    'checkout_payment_window',
    'processing',
    now() + interval '30 minutes',
    '{"source":"pgtap"}'::jsonb,
    'omnipack'
  );
EXCEPTION WHEN check_violation THEN
  IF SQLERRM NOT LIKE '%inventory_external_provider_insufficient_available_stock%' THEN
    RAISE;
  END IF;
END;
$$;

SELECT is(
  (SELECT count(*)::integer
     FROM public.inventory_reservations
    WHERE idempotency_key LIKE 'no-cron-lease-batch-atomic:%'),
  0,
  'order-item batch reservation is atomic: one failed line rolls back earlier lines'
);

SELECT * FROM finish();
ROLLBACK;
