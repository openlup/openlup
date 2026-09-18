-- pgTAP: W3c-a fences the legacy catalog writer RPCs.
-- The fixture is deliberately inserted directly: these tests must no longer
-- depend on a writer whose only supported result is the named refusal.

BEGIN;
SELECT plan(5);

INSERT INTO public.admin_users (id, email, role, is_machine_actor) VALUES
  ('a1111111-1111-1111-1111-111111111111', 'human@example.invalid', 'admin', false);
INSERT INTO public.catalog_products (id, slug, name, status) VALUES
  ('a1000000-0000-4000-8000-000000000001', 'fence-write-product', 'Fence write product', 'active');
INSERT INTO public.catalog_skus (id, product_id, sku, title, pet_type, net_weight_g, kcal_per_unit, status) VALUES
  ('a1000000-0000-4000-8000-000000000002', 'a1000000-0000-4000-8000-000000000001',
   'FENCE-WRITE-SKU', 'Fence write SKU', 'dog', 400, 480, 'active');
INSERT INTO public.price_lists (id, name, region_code, currency, status) VALUES
  ('a1000000-0000-4000-8000-000000000003', 'fence_write_prices', 'PL', 'PLN', 'active');
INSERT INTO public.price_entries (price_list_id, variant_id, mode, min_qty, unit_price_minor, amount_kind, active) VALUES
  ('a1000000-0000-4000-8000-000000000003', 'a1000000-0000-4000-8000-000000000002',
   'one_time', 1, 1490, 'gross', true);

CREATE TEMP TABLE _before AS
SELECT jsonb_build_object(
  'products', (SELECT jsonb_agg(to_jsonb(product) ORDER BY product.id)
                 FROM public.catalog_products AS product
                WHERE product.slug IN ('fence-write-product', 'fence-write-new')),
  'skus', (SELECT jsonb_agg(to_jsonb(sku) ORDER BY sku.id)
             FROM public.catalog_skus AS sku WHERE sku.sku = 'FENCE-WRITE-SKU'),
  'prices', (SELECT jsonb_agg(to_jsonb(price) ORDER BY price.id)
               FROM public.price_entries AS price
              WHERE price.price_list_id = 'a1000000-0000-4000-8000-000000000003')
) AS snapshot;

SELECT throws_ok(
  $$ SELECT public.admin_upsert_catalog_draft(
       'a1111111-1111-1111-1111-111111111111', 'fence-write-new', 'Fence write new',
       'dog', 'can', 'FENCE-WRITE-NEW-SKU', 400, 480, ARRAY[]::text[],
       'commit', 'fence-write-upsert', NULL, 'agent_catalog') $$,
  '42501', 'legacy_catalog_mutation_fenced', 'draft upsert is fenced');
SELECT throws_ok(
  $$ SELECT public.admin_set_catalog_price(
       'a1111111-1111-1111-1111-111111111111', 'FENCE-WRITE-SKU', 'one_time',
       1590, 'PLN', 'commit', 'fence-write-price', NULL, 'agent_catalog') $$,
  '42501', 'legacy_catalog_mutation_fenced', 'catalog price write is fenced');
SELECT throws_ok(
  $$ SELECT public.admin_archive_catalog_sku(
       'a1111111-1111-1111-1111-111111111111', 'FENCE-WRITE-SKU',
       'commit', 'fence-write-archive-sku', NULL, 'agent_catalog') $$,
  '42501', 'legacy_catalog_mutation_fenced', 'SKU archive is fenced');
SELECT throws_ok(
  $$ SELECT public.admin_activate_catalog_product(
       'a1111111-1111-1111-1111-111111111111', 'fence-write-product',
       'commit', 'fence-write-activate', NULL, 'agent_catalog') $$,
  '42501', 'legacy_catalog_mutation_fenced', 'product activation is fenced');

SELECT is(
  (SELECT snapshot::text FROM _before),
  (SELECT jsonb_build_object(
    'products', (SELECT jsonb_agg(to_jsonb(product) ORDER BY product.id)
                   FROM public.catalog_products AS product
                  WHERE product.slug IN ('fence-write-product', 'fence-write-new')),
    'skus', (SELECT jsonb_agg(to_jsonb(sku) ORDER BY sku.id)
               FROM public.catalog_skus AS sku WHERE sku.sku = 'FENCE-WRITE-SKU'),
    'prices', (SELECT jsonb_agg(to_jsonb(price) ORDER BY price.id)
                 FROM public.price_entries AS price
                WHERE price.price_list_id = 'a1000000-0000-4000-8000-000000000003')
  )::text),
  'all fenced legacy writes leave their catalog rows unchanged');

SELECT * FROM finish();
ROLLBACK;
