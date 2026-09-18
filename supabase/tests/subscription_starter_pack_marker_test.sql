-- pgTAP: the starter-pack acquisition marker is written once, server-derived,
-- fail-closed, and thereafter immutable.
--
-- Pins the three halves of 20260802140000:
--   * subscription_create_provisional_for_checkout writes a validated marker
--     when the quote context carries one, with basisTemplateVersion taken from
--     the server's own template_version and cadence_days taken from the
--     starter (delivery-2) interval rather than the steady cadence;
--   * the same RPC with NO starterPack in the quote behaves exactly as it did
--     before this migration -- this is the load-bearing regression pin, because
--     the migration is a full-body replace of a paid-checkout critical-path RPC;
--   * every fail-closed validation branch raises BEFORE any row is written, and
--     trg subscriptions_starter_pack_immutable admits only a clear to NULL.
--
-- Fixture rule: subscriptions.is_test_fixture stays false (the default). The
-- 20260724194500 constraint only admits true for legacy_frozen rows, and these
-- fixtures are created through the acquisition RPC, which leaves them
-- pending_acquisition.
--
-- Run via: npm run test:db:local (the guarded local database lane)

BEGIN;
SELECT plan(28);

SELECT has_column('public', 'subscriptions', 'starter_pack',
  'starter pack: the marker column exists');

SELECT has_function(
  'public', 'subscription_prevent_starter_pack_update',
  'starter pack: the immutability trigger function exists');

SELECT is(
  (SELECT count(*)::int
     FROM pg_trigger t
     JOIN pg_class c ON c.oid = t.tgrelid
    WHERE c.relname = 'subscriptions'
      AND t.tgname = 'subscriptions_starter_pack_immutable'
      AND NOT t.tgisinternal),
  1,
  'starter pack: the immutability trigger is attached to public.subscriptions');

-- ---- Shared catalog fixture ----------------------------------------------
INSERT INTO public.clients (id, email) VALUES
  ('c1000000-0000-0000-0000-000000000001', 'starter-with-marker@example.invalid'),
  ('c1000000-0000-0000-0000-000000000002', 'starter-no-marker@example.invalid'),
  ('c1000000-0000-0000-0000-000000000003', 'starter-malformed@example.invalid');

INSERT INTO public.pets (id, client_id, pet_type, name) VALUES
  ('c1100000-0000-0000-0000-000000000001', 'c1000000-0000-0000-0000-000000000001', 'dog', 'Starter'),
  ('c1100000-0000-0000-0000-000000000002', 'c1000000-0000-0000-0000-000000000002', 'dog', 'Plain'),
  ('c1100000-0000-0000-0000-000000000003', 'c1000000-0000-0000-0000-000000000003', 'dog', 'Bad');

INSERT INTO public.addresses (id, client_id, kind, line1, city, postal_code) VALUES
  ('c1200000-0000-0000-0000-000000000001', 'c1000000-0000-0000-0000-000000000001', 'shipping', 'Testowa 1', 'Warszawa', '00-001'),
  ('c1200000-0000-0000-0000-000000000002', 'c1000000-0000-0000-0000-000000000002', 'shipping', 'Testowa 2', 'Warszawa', '00-001'),
  ('c1200000-0000-0000-0000-000000000003', 'c1000000-0000-0000-0000-000000000003', 'shipping', 'Testowa 3', 'Warszawa', '00-001');

INSERT INTO public.catalog_products (id, slug, name, status)
VALUES ('c1300000-0000-0000-0000-000000000001', 'starter-product', 'Starter Product', 'active');

INSERT INTO public.catalog_skus (id, product_id, sku, title, pet_type, status, net_weight_g, kcal_per_unit)
VALUES ('c1400000-0000-0000-0000-000000000001', 'c1300000-0000-0000-0000-000000000001', 'STARTER-SKU-1', 'Starter SKU 1', 'dog', 'active', 400, 350);

INSERT INTO public.commerce_orders (id, client_id, pet_id, shipping_address_id, currency, region_code, size_constraint, status, metadata) VALUES
  ('c2000000-0000-0000-0000-000000000001', 'c1000000-0000-0000-0000-000000000001', 'c1100000-0000-0000-0000-000000000001', 'c1200000-0000-0000-0000-000000000001', 'PLN', 'PL', '{"kind":"feeding_days","value":21}'::jsonb, 'draft', '{}'::jsonb),
  ('c2000000-0000-0000-0000-000000000002', 'c1000000-0000-0000-0000-000000000002', 'c1100000-0000-0000-0000-000000000002', 'c1200000-0000-0000-0000-000000000002', 'PLN', 'PL', '{"kind":"feeding_days","value":21}'::jsonb, 'draft', '{}'::jsonb),
  ('c2000000-0000-0000-0000-000000000003', 'c1000000-0000-0000-0000-000000000003', 'c1100000-0000-0000-0000-000000000003', 'c1200000-0000-0000-0000-000000000003', 'PLN', 'PL', '{"kind":"feeding_days","value":21}'::jsonb, 'draft', '{}'::jsonb);

INSERT INTO public.commerce_order_items (id, order_id, sku_id, quantity, unit_price_cents, total_cents, discount_allocated_cents, effective_total_cents, effective_net_cents, product_snapshot) VALUES
  ('c2100000-0000-0000-0000-000000000001', 'c2000000-0000-0000-0000-000000000001', 'c1400000-0000-0000-0000-000000000001', 14, 1340, 18760, 0, 18760, round((18760)::numeric * 10000 / (10000 + 800))::integer, '{"sku":"STARTER-SKU-1"}'::jsonb),
  ('c2100000-0000-0000-0000-000000000002', 'c2000000-0000-0000-0000-000000000002', 'c1400000-0000-0000-0000-000000000001', 14, 1340, 18760, 0, 18760, round((18760)::numeric * 10000 / (10000 + 800))::integer, '{"sku":"STARTER-SKU-1"}'::jsonb),
  ('c2100000-0000-0000-0000-000000000003', 'c2000000-0000-0000-0000-000000000003', 'c1400000-0000-0000-0000-000000000001', 14, 1340, 18760, 0, 18760, round((18760)::numeric * 10000 / (10000 + 800))::integer, '{"sku":"STARTER-SKU-1"}'::jsonb);

-- ---- Creation WITH a marker ----------------------------------------------
-- The client deliberately declares basisTemplateVersion 99 and an unknown key.
-- Both must be discarded: the marker is rebuilt from validated fields only.
CREATE TEMP TABLE _starter AS
SELECT public.subscription_create_provisional_for_checkout(
  'c2000000-0000-0000-0000-000000000001', 'c1000000-0000-0000-0000-000000000001',
  'c1100000-0000-0000-0000-000000000001', 'c1200000-0000-0000-0000-000000000001',
  '{"quote":{"context":{"mode":"subscription","cadenceDays":28,"starterPack":{
      "schemaVersion":"1",
      "starterIntervalDays":17,
      "basisTemplateVersion":99,
      "attackerKey":"ignored",
      "delivery2":{"discountBps":3500,"discountMinor":6566,"basisSubtotalMinor":18760},
      "graduation":{"cadenceDays":28,"sizeConstraint":{"kind":"feeding_days","value":28},
        "lines":[{"sku":"STARTER-SKU-1","qty":8,"sortOrder":0,"isAddon":false,
          "quoteLine":{"sku":"STARTER-SKU-1","productSlug":"starter-product","quantity":8,
            "unitPriceGross":{"amountMinor":1340,"currency":"PLN"},
            "lineSubtotalGross":{"amountMinor":10720,"currency":"PLN"}}}]}}}}}'::jsonb) AS r;

SELECT is(
  (SELECT (starter_pack->>'schemaVersion')
     FROM public.subscriptions WHERE id = (SELECT (r->>'subscriptionId')::uuid FROM _starter)),
  '1',
  'marker: the stored marker declares schemaVersion 1');

SELECT is(
  (SELECT (starter_pack->>'basisTemplateVersion')::int
     FROM public.subscriptions WHERE id = (SELECT (r->>'subscriptionId')::uuid FROM _starter)),
  1,
  'marker: basisTemplateVersion is the server template_version, not the client claim of 99');

SELECT is(
  (SELECT template_version
     FROM public.subscriptions WHERE id = (SELECT (r->>'subscriptionId')::uuid FROM _starter)),
  1,
  'marker: the subscription itself still starts at template_version 1');

SELECT ok(
  (SELECT NOT (starter_pack ? 'attackerKey')
     FROM public.subscriptions WHERE id = (SELECT (r->>'subscriptionId')::uuid FROM _starter)),
  'marker: unvalidated client keys are dropped');

SELECT is(
  (SELECT cadence_days
     FROM public.subscriptions WHERE id = (SELECT (r->>'subscriptionId')::uuid FROM _starter)),
  17,
  'marker: cadence_days is the starter (delivery-2) interval, not the quote cadence of 28');

SELECT is(
  (SELECT (starter_pack #>> '{graduation,cadenceDays}')::int
     FROM public.subscriptions WHERE id = (SELECT (r->>'subscriptionId')::uuid FROM _starter)),
  28,
  'marker: the steady cadence rides in the marker for graduation');

SELECT is(
  (SELECT (starter_pack #>> '{graduation,sizeConstraint,value}')::int
     FROM public.subscriptions WHERE id = (SELECT (r->>'subscriptionId')::uuid FROM _starter)),
  28,
  'marker: an optional graduation sizeConstraint is preserved');

SELECT is(
  (SELECT (starter_pack #>> '{delivery2,discountMinor}')::int
     FROM public.subscriptions WHERE id = (SELECT (r->>'subscriptionId')::uuid FROM _starter)),
  6566,
  'marker: the frozen delivery-2 discount is preserved');

SELECT is(
  (SELECT count(*)::int FROM public.subscription_lines
    WHERE subscription_id = (SELECT (r->>'subscriptionId')::uuid FROM _starter)),
  1,
  'marker: line seeding from the order items is unchanged');

-- ---- Creation WITHOUT a marker (regression pin) ---------------------------
CREATE TEMP TABLE _plain AS
SELECT public.subscription_create_provisional_for_checkout(
  'c2000000-0000-0000-0000-000000000002', 'c1000000-0000-0000-0000-000000000002',
  'c1100000-0000-0000-0000-000000000002', 'c1200000-0000-0000-0000-000000000002',
  '{"quote":{"context":{"mode":"subscription","cadenceDays":28}}}'::jsonb) AS r;

SELECT is(
  (SELECT starter_pack FROM public.subscriptions
    WHERE id = (SELECT (r->>'subscriptionId')::uuid FROM _plain)),
  NULL::jsonb,
  'no marker: starter_pack stays NULL');

SELECT is(
  (SELECT cadence_days FROM public.subscriptions
    WHERE id = (SELECT (r->>'subscriptionId')::uuid FROM _plain)),
  28,
  'no marker: cadence still comes from quote.context.cadenceDays');

SELECT is(
  (SELECT status FROM public.subscriptions
    WHERE id = (SELECT (r->>'subscriptionId')::uuid FROM _plain)),
  'pending_activation',
  'no marker: the provisional status is unchanged');

SELECT is(
  (SELECT engine_idempotency_key FROM public.subscription_cycles
    WHERE id = (SELECT (r->>'subscriptionCycleId')::uuid FROM _plain)),
  'checkout-initial-cycle:c2000000-0000-0000-0000-000000000002',
  'no marker: the cycle-1 idempotency key namespace is unchanged');

SELECT throws_ok(
  $$SELECT public.subscription_create_provisional_for_checkout(
      'c2000000-0000-0000-0000-000000000003', 'c1000000-0000-0000-0000-000000000003',
      'c1100000-0000-0000-0000-000000000003', 'c1200000-0000-0000-0000-000000000003',
      '{"quote":{"context":{"mode":"subscription"}}}'::jsonb)$$,
  '22023',
  'subscription_provisional_invalid_cadence',
  'no marker: a missing cadence still raises the original error');

-- ---- Fail-closed validation ----------------------------------------------
SELECT throws_ok(
  $$SELECT public.subscription_create_provisional_for_checkout(
      'c2000000-0000-0000-0000-000000000003', 'c1000000-0000-0000-0000-000000000003',
      'c1100000-0000-0000-0000-000000000003', 'c1200000-0000-0000-0000-000000000003',
      '{"quote":{"context":{"mode":"subscription","cadenceDays":28,"starterPack":{
        "schemaVersion":"1","starterIntervalDays":3,
        "delivery2":{"discountBps":3500,"discountMinor":100,"basisSubtotalMinor":18760},
        "graduation":{"cadenceDays":28,"lines":[{"sku":"STARTER-SKU-1","qty":8,"sortOrder":0,"isAddon":false,
          "quoteLine":{"unitPriceGross":{"amountMinor":1340},"lineSubtotalGross":{"amountMinor":10720}}}]}}}}}'::jsonb)$$,
  '22023',
  'subscription_starter_pack_invalid_interval',
  'validation: an out-of-range starter interval is rejected');

SELECT throws_ok(
  $$SELECT public.subscription_create_provisional_for_checkout(
      'c2000000-0000-0000-0000-000000000003', 'c1000000-0000-0000-0000-000000000003',
      'c1100000-0000-0000-0000-000000000003', 'c1200000-0000-0000-0000-000000000003',
      '{"quote":{"context":{"mode":"subscription","cadenceDays":28,"starterPack":{
        "schemaVersion":"1","starterIntervalDays":17,
        "delivery2":{"discountBps":3500,"discountMinor":18761,"basisSubtotalMinor":18760},
        "graduation":{"cadenceDays":28,"lines":[{"sku":"STARTER-SKU-1","qty":8,"sortOrder":0,"isAddon":false,
          "quoteLine":{"unitPriceGross":{"amountMinor":1340},"lineSubtotalGross":{"amountMinor":10720}}}]}}}}}'::jsonb)$$,
  '22023',
  'subscription_starter_pack_discount_out_of_range',
  'validation: a discount larger than its own basis is rejected');

SELECT throws_ok(
  $$SELECT public.subscription_create_provisional_for_checkout(
      'c2000000-0000-0000-0000-000000000003', 'c1000000-0000-0000-0000-000000000003',
      'c1100000-0000-0000-0000-000000000003', 'c1200000-0000-0000-0000-000000000003',
      '{"quote":{"context":{"mode":"subscription","cadenceDays":28,"starterPack":{
        "schemaVersion":"1","starterIntervalDays":17,
        "delivery2":{"discountBps":9999,"discountMinor":18700,"basisSubtotalMinor":18760},
        "graduation":{"cadenceDays":28,"lines":[{"sku":"STARTER-SKU-1","qty":8,"sortOrder":0,"isAddon":false,
          "quoteLine":{"unitPriceGross":{"amountMinor":1340},"lineSubtotalGross":{"amountMinor":10720}}}]}}}}}'::jsonb)$$,
  '22023',
  'subscription_starter_pack_payable_below_floor',
  'validation: a delivery-2 payable under 100 minor units is rejected');

SELECT throws_ok(
  $$SELECT public.subscription_create_provisional_for_checkout(
      'c2000000-0000-0000-0000-000000000003', 'c1000000-0000-0000-0000-000000000003',
      'c1100000-0000-0000-0000-000000000003', 'c1200000-0000-0000-0000-000000000003',
      '{"quote":{"context":{"mode":"subscription","cadenceDays":28,"starterPack":{
        "schemaVersion":"1","starterIntervalDays":17,
        "delivery2":{"discountBps":3500,"discountMinor":6566,"basisSubtotalMinor":18760},
        "graduation":{"cadenceDays":28,"lines":[]}}}}}'::jsonb)$$,
  '22023',
  'subscription_starter_pack_invalid_graduation_lines',
  'validation: an empty graduation line set is rejected');

SELECT throws_ok(
  $$SELECT public.subscription_create_provisional_for_checkout(
      'c2000000-0000-0000-0000-000000000003', 'c1000000-0000-0000-0000-000000000003',
      'c1100000-0000-0000-0000-000000000003', 'c1200000-0000-0000-0000-000000000003',
      '{"quote":{"context":{"mode":"subscription","cadenceDays":28,"starterPack":{
        "schemaVersion":"1","starterIntervalDays":17,
        "delivery2":{"discountBps":3500,"discountMinor":6566,"basisSubtotalMinor":18760},
        "graduation":{"cadenceDays":28,"lines":[{"sku":"STARTER-SKU-1","qty":8,"sortOrder":0,"isAddon":false,
          "quoteLine":{"productSlug":"starter-product"}}]}}}}}'::jsonb)$$,
  '22023',
  'subscription_starter_pack_invalid_graduation_quote_line',
  'validation: a graduation line whose frozen quoteLine carries no money is rejected');

SELECT throws_ok(
  $$SELECT public.subscription_create_provisional_for_checkout(
      'c2000000-0000-0000-0000-000000000003', 'c1000000-0000-0000-0000-000000000003',
      'c1100000-0000-0000-0000-000000000003', 'c1200000-0000-0000-0000-000000000003',
      '{"quote":{"context":{"mode":"subscription","cadenceDays":28,"starterPack":{
        "schemaVersion":"1","starterIntervalDays":17,
        "delivery2":{"discountBps":3500,"discountMinor":6566,"basisSubtotalMinor":18760},
        "graduation":{"cadenceDays":21,"lines":[{"sku":"STARTER-SKU-1","qty":8,"sortOrder":0,"isAddon":false,
          "quoteLine":{"unitPriceGross":{"amountMinor":1340},"lineSubtotalGross":{"amountMinor":10720}}}]}}}}}'::jsonb)$$,
  '22023',
  'subscription_starter_pack_invalid_graduation_cadence',
  'validation: a graduation cadence outside the steady set is rejected');

SELECT is(
  (SELECT count(*)::int FROM public.subscriptions
    WHERE client_id = 'c1000000-0000-0000-0000-000000000003'),
  0,
  'validation: no subscription row survives any rejected acquisition');

-- ---- Immutability ---------------------------------------------------------
SELECT throws_ok(
  $$UPDATE public.subscriptions
       SET starter_pack = jsonb_set(starter_pack, '{delivery2,discountMinor}', '18000'::jsonb)
     WHERE starter_pack IS NOT NULL$$,
  '22023',
  'subscription_starter_pack_immutable',
  'immutability: rewriting a stored marker is rejected');

SELECT throws_ok(
  $$UPDATE public.subscriptions
       SET starter_pack = '{"schemaVersion":"1"}'::jsonb
     WHERE starter_pack IS NULL$$,
  '22023',
  'subscription_starter_pack_immutable',
  'immutability: minting a marker on an existing subscription is rejected');

UPDATE public.subscriptions
   SET next_cycle_at = '2026-09-01T00:00:00Z'
 WHERE id = (SELECT (r->>'subscriptionId')::uuid FROM _starter);
SELECT is(
  (SELECT (starter_pack->>'starterIntervalDays')::int FROM public.subscriptions
    WHERE id = (SELECT (r->>'subscriptionId')::uuid FROM _starter)),
  17,
  'immutability: a non-marker update on a starter subscription is unaffected');

UPDATE public.subscriptions SET starter_pack = NULL
 WHERE id = (SELECT (r->>'subscriptionId')::uuid FROM _starter);
SELECT is(
  (SELECT starter_pack FROM public.subscriptions
    WHERE id = (SELECT (r->>'subscriptionId')::uuid FROM _starter)),
  NULL::jsonb,
  'immutability: clearing the marker to NULL is the one admitted transition');

SELECT * FROM finish();
ROLLBACK;
