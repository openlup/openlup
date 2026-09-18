-- pgTAP: W3c-a fences the legacy subscription-band repricer.
-- W3d owns any replacement price-policy authority; this test only proves that
-- the retired writer cannot alter active price entries or audit history.

BEGIN;
SELECT plan(3);

INSERT INTO public.admin_users (id, email, role) VALUES
  ('a3111111-1111-1111-1111-111111111111', 'admin@example.invalid', 'admin');
INSERT INTO public.catalog_products (id, slug, name, status) VALUES
  ('a3000000-0000-4000-8000-000000000001', 'fence-band-product', 'Fence band product', 'active');
INSERT INTO public.catalog_skus (id, product_id, sku, title, pet_type, net_weight_g, kcal_per_unit, status) VALUES
  ('a3000000-0000-4000-8000-000000000002', 'a3000000-0000-4000-8000-000000000001',
   'FENCE-BAND-SKU', 'Fence band SKU', 'dog', 400, 480, 'active');
INSERT INTO public.price_lists (id, name, region_code, currency, status) VALUES
  ('a3000000-0000-4000-8000-000000000003', 'fence_band_prices', 'PL', 'PLN', 'active');
INSERT INTO public.price_entries (price_list_id, variant_id, mode, min_qty, unit_price_minor, amount_kind, active) VALUES
  ('a3000000-0000-4000-8000-000000000003', 'a3000000-0000-4000-8000-000000000002', 'one_time', 1, 1490, 'gross', true),
  ('a3000000-0000-4000-8000-000000000003', 'a3000000-0000-4000-8000-000000000002', 'subscription', 1, 1340, 'gross', true);
SELECT set_config('request.jwt.claims',
  '{"sub":"a3111111-1111-1111-1111-111111111111","role":"authenticated"}', true);

CREATE TEMP TABLE _before AS
SELECT jsonb_agg(to_jsonb(price) ORDER BY price.id) AS prices
  FROM public.price_entries AS price
 WHERE price.price_list_id = 'a3000000-0000-4000-8000-000000000003';

SELECT throws_ok(
  $$ SELECT public.admin_set_subscription_band_percent(12) $$,
  '42501', 'legacy_catalog_mutation_fenced', 'subscription-band repricer is fenced');
SELECT is(
  (SELECT prices::text FROM _before),
  (SELECT jsonb_agg(to_jsonb(price) ORDER BY price.id)::text
     FROM public.price_entries AS price
    WHERE price.price_list_id = 'a3000000-0000-4000-8000-000000000003'),
  'fenced band reprice leaves all active and historical price entries unchanged');
SELECT is(
  (SELECT count(*)::int FROM public.admin_audit_events WHERE action = 'subscription_band_update'),
  0,
  'fenced band reprice writes no audit event');

SELECT * FROM finish();
ROLLBACK;
