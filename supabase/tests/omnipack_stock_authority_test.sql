-- pgTAP: OmniPack external stock-master reservation lifecycle.
--
-- Run via: supabase db reset && supabase test db

BEGIN;
SELECT plan(17);

INSERT INTO public.providers (kind, capability, display_name, status)
VALUES ('omnipack', 'fulfillment', 'OmniPack Fulfillment', 'experimental')
ON CONFLICT (kind) DO NOTHING;

INSERT INTO public.clients (id, email, first_name, last_name, lifecycle_stage)
VALUES (
  '11111111-1111-4111-8111-111111111111',
  'omnipack-stock-authority@example.test',
  'OmniPack',
  'Stock',
  'customer'
);

INSERT INTO public.addresses (id, client_id, kind, label, line1, city, postal_code, country, is_default)
VALUES (
  '22222222-2222-4222-8222-222222222222',
  '11111111-1111-4111-8111-111111111111',
  'shipping',
  'Probe',
  'Prosta 1',
  'Warszawa',
  '00-001',
  'PL',
  true
);

INSERT INTO public.catalog_products (id, slug, status, name)
VALUES ('33333333-3333-4333-8333-333333333333', 'omnipack-stock-authority-food', 'active', 'OmniPack Stock Authority Food');

INSERT INTO public.catalog_skus (id, product_id, sku, title, pet_type, status, net_weight_g, kcal_per_unit)
VALUES (
  '44444444-4444-4444-8444-444444444444',
  '33333333-3333-4333-8333-333333333333',
  'OPENLUP-OMNI-STOCK-AUTHORITY',
  'OmniPack Stock Authority 400g',
  'dog',
  'active',
  400,
  420
);

CREATE TEMP TABLE _stock_sync AS
SELECT public.fulfillment_provider_upsert_stock_current(
  'omnipack-stock-authority-current-1',
  'omnipack',
  'OPENLUP-OMNI-STOCK-AUTHORITY',
  7,
  5,
  2,
  now(),
  now() + interval '6 hours',
  'omnipack-stock-authority-run-1',
  '{"source":"pgtap"}'::jsonb
) AS result;

UPDATE public.inventory_balances
   SET safety_stock = 1
 WHERE sku_id = '44444444-4444-4444-8444-444444444444'
   AND location_id = (SELECT id FROM public.inventory_locations WHERE code = 'omnipack-stock-master');

SELECT is(
  (SELECT provider_for_sale_quantity FROM public.fulfillment_provider_stock_current WHERE provider_kind = 'omnipack' AND sku = 'OPENLUP-OMNI-STOCK-AUTHORITY'),
  5,
  'stock sync writes provider-current forSale quantity'
);
SELECT is(
  (SELECT result->>'replayed' FROM _stock_sync),
  'false',
  'first provider-current stock write is not a replay'
);
SELECT is(
  (SELECT provider_kind FROM public.inventory_locations WHERE code = 'omnipack-stock-master'),
  'omnipack',
  'stock-master mirror location is tied to OmniPack provider kind'
);

INSERT INTO public.commerce_orders (id, client_id, status, currency, subtotal_cents, total_cents, mode, shipping_address_id, region_code)
VALUES (
  '55555555-5555-4555-8555-555555555551',
  '11111111-1111-4111-8111-111111111111',
  'paid',
  'PLN',
  3000,
  3000,
  'one_time',
  '22222222-2222-4222-8222-222222222222',
  'PL'
);
INSERT INTO public.commerce_order_items (id, order_id, sku_id, quantity, unit_price_cents, total_cents, discount_allocated_cents, effective_total_cents, effective_net_cents, product_snapshot)
VALUES (
  '66666666-6666-4666-8666-666666666661',
  '55555555-5555-4555-8555-555555555551',
  '44444444-4444-4444-8444-444444444444',
  3,
  1000,
  3000, 0, 3000, round((3000)::numeric * 10000 / (10000 + (800)::integer))::integer,
  '{"sku":"OPENLUP-OMNI-STOCK-AUTHORITY"}'::jsonb
);

CREATE TEMP TABLE _reserve AS
SELECT public.inventory_reserve_order(
  'omnipack-stock-authority-reserve-1',
  '55555555-5555-4555-8555-555555555551',
  '66666666-6666-4666-8666-666666666661',
  NULL,
  '44444444-4444-4444-8444-444444444444',
  3,
  'checkout_payment_window',
  'succeeded',
  now() + interval '30 minutes',
  '{"source":"pgtap"}'::jsonb,
  'omnipack'
) AS result;

SELECT is(
  (SELECT result->>'stockAuthority' FROM _reserve),
  'external_stock_master_with_local_reservations',
  'OmniPack reservation reports external stock-master authority'
);
SELECT is(
  (SELECT status FROM public.inventory_reservations WHERE id = (SELECT (result->>'reservationId')::uuid FROM _reserve)),
  'reserved',
  'OmniPack reservation is created locally'
);
SELECT is(
  (SELECT metadata->>'stockAuthority' FROM public.inventory_reservations WHERE id = (SELECT (result->>'reservationId')::uuid FROM _reserve)),
  'external_stock_master_with_local_reservations',
  'reservation stores stock authority evidence'
);
SELECT is(
  (SELECT reserved FROM public.inventory_balances WHERE sku_id = '44444444-4444-4444-8444-444444444444' AND location_id = (SELECT id FROM public.inventory_locations WHERE code = 'omnipack-stock-master')),
  3,
  'local reservation overlays the OmniPack stock-master mirror'
);

INSERT INTO public.commerce_orders (id, client_id, status, currency, subtotal_cents, total_cents, mode, shipping_address_id, region_code)
VALUES (
  '55555555-5555-4555-8555-555555555552',
  '11111111-1111-4111-8111-111111111111',
  'paid',
  'PLN',
  2000,
  2000,
  'one_time',
  '22222222-2222-4222-8222-222222222222',
  'PL'
);
INSERT INTO public.commerce_order_items (id, order_id, sku_id, quantity, unit_price_cents, total_cents, discount_allocated_cents, effective_total_cents, effective_net_cents, product_snapshot)
VALUES (
  '66666666-6666-4666-8666-666666666662',
  '55555555-5555-4555-8555-555555555552',
  '44444444-4444-4444-8444-444444444444',
  2,
  1000,
  2000, 0, 2000, round((2000)::numeric * 10000 / (10000 + (800)::integer))::integer,
  '{"sku":"OPENLUP-OMNI-STOCK-AUTHORITY"}'::jsonb
);

CREATE TEMP TABLE _oversell_probe (blocked boolean NOT NULL);
DO $$
BEGIN
  PERFORM public.inventory_reserve_order(
    'omnipack-stock-authority-reserve-oversell',
    '55555555-5555-4555-8555-555555555552',
    '66666666-6666-4666-8666-666666666662',
    NULL,
    '44444444-4444-4444-8444-444444444444',
    2,
    'checkout_payment_window',
    'succeeded',
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
SELECT ok((SELECT blocked FROM _oversell_probe), 'provider forSale minus open reservations and safety stock blocks oversell');

INSERT INTO public.commerce_fulfillment_orders (
  id,
  order_id,
  client_id,
  shipping_address_id,
  create_idempotency_key,
  status,
  provider_kind,
  shipping_address_snapshot,
  metadata
)
VALUES (
  '77777777-7777-4777-8777-777777777771',
  '55555555-5555-4555-8555-555555555551',
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  'omnipack-stock-authority-fulfillment-1',
  'label_created',
  'omnipack',
  '{"city":"Warszawa"}'::jsonb,
  '{"source":"pgtap"}'::jsonb
);
INSERT INTO public.commerce_fulfillment_order_lines (
  id,
  fulfillment_order_id,
  order_id,
  order_item_id,
  sku_id,
  sku,
  title,
  quantity,
  inventory_reservation_ids,
  product_snapshot
)
VALUES (
  '88888888-8888-4888-8888-888888888881',
  '77777777-7777-4777-8777-777777777771',
  '55555555-5555-4555-8555-555555555551',
  '66666666-6666-4666-8666-666666666661',
  '44444444-4444-4444-8444-444444444444',
  'OPENLUP-OMNI-STOCK-AUTHORITY',
  'OmniPack Stock Authority 400g',
  3,
  ARRAY[(SELECT (result->>'reservationId')::uuid FROM _reserve)],
  '{"sku":"OPENLUP-OMNI-STOCK-AUTHORITY"}'::jsonb
);

CREATE TEMP TABLE _picked AS
SELECT public.commerce_fulfillment_mark_provider_stock_consumed(
  'omnipack-stock-authority-picked-1',
  '77777777-7777-4777-8777-777777777771',
  NULL,
  '{"source":"pgtap","providerEvent":"finished_picking"}'::jsonb
) AS result;

SELECT is((SELECT result->>'status' FROM _picked), 'packed', 'finished picking advances fulfillment to packed');
SELECT is((SELECT (result->>'consumedCount')::integer FROM _picked), 1, 'finished picking consumes one reservation');
SELECT is(
  (SELECT status FROM public.inventory_reservations WHERE id = (SELECT (result->>'reservationId')::uuid FROM _reserve)),
  'consumed',
  'finished picking consumes the local reservation'
);
SELECT is(
  (SELECT reserved FROM public.inventory_balances WHERE sku_id = '44444444-4444-4444-8444-444444444444' AND location_id = (SELECT id FROM public.inventory_locations WHERE code = 'omnipack-stock-master')),
  0,
  'finished picking releases the local reservation overlay'
);
SELECT is(
  (SELECT count(*)::integer FROM public.inventory_stock_movements WHERE movement_type = 'reservation_consumed' AND reservation_id = (SELECT (result->>'reservationId')::uuid FROM _reserve)),
  1,
  'finished picking writes exactly one reservation-consumed movement'
);

CREATE TEMP TABLE _picked_replay AS
SELECT public.commerce_fulfillment_mark_provider_stock_consumed(
  'omnipack-stock-authority-picked-1',
  '77777777-7777-4777-8777-777777777771',
  NULL,
  '{"source":"pgtap","providerEvent":"finished_picking"}'::jsonb
) AS result;
SELECT is((SELECT result->>'replayed' FROM _picked_replay), 'true', 'finished picking replay is idempotent');

CREATE TEMP TABLE _handoff AS
SELECT public.commerce_fulfillment_mark_handed_over(
  'omnipack-stock-authority-shipped-1',
  '77777777-7777-4777-8777-777777777771',
  NULL,
  '{"source":"pgtap","providerEvent":"order.shipped"}'::jsonb
) AS result;

SELECT is((SELECT result->>'status' FROM _handoff), 'handed_over', 'shipped/handoff can follow packed state');
SELECT is(
  (SELECT count(*)::integer FROM public.inventory_stock_movements WHERE movement_type = 'reservation_consumed' AND reservation_id = (SELECT (result->>'reservationId')::uuid FROM _reserve)),
  1,
  'shipped/handoff after picked does not double-consume inventory'
);
SELECT is(
  (SELECT count(*)::integer FROM public.commerce_fulfillment_operations WHERE fulfillment_order_id = '77777777-7777-4777-8777-777777777771' AND operation_type = 'tracking_event_recorded'),
  0,
  'finished picking itself records no tracking event'
);

SELECT * FROM finish();
ROLLBACK;
