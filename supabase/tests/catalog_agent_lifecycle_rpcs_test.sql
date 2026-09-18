-- pgTAP: W3c-a fences legacy catalog lifecycle RPCs before they inspect state.

BEGIN;
SELECT plan(4);

INSERT INTO public.admin_users (id, email, role, is_machine_actor) VALUES
  ('a2111111-1111-1111-1111-111111111111', 'human@example.invalid', 'admin', false);
INSERT INTO public.catalog_products (id, slug, name, status) VALUES
  ('a2000000-0000-4000-8000-000000000001', 'fence-lifecycle-archive', 'Fence archive', 'active'),
  ('a2000000-0000-4000-8000-000000000002', 'fence-lifecycle-restore', 'Fence restore', 'archived'),
  ('a2000000-0000-4000-8000-000000000003', 'fence-lifecycle-deactivate', 'Fence deactivate', 'active');
INSERT INTO public.catalog_skus (id, product_id, sku, title, pet_type, net_weight_g, kcal_per_unit, status) VALUES
  ('a2000000-0000-4000-8000-000000000011', 'a2000000-0000-4000-8000-000000000001', 'FENCE-LIFECYCLE-ARCHIVE', 'Fence archive', 'dog', 400, 480, 'active'),
  ('a2000000-0000-4000-8000-000000000012', 'a2000000-0000-4000-8000-000000000002', 'FENCE-LIFECYCLE-RESTORE', 'Fence restore', 'dog', 400, 480, 'archived'),
  ('a2000000-0000-4000-8000-000000000013', 'a2000000-0000-4000-8000-000000000003', 'FENCE-LIFECYCLE-DEACTIVATE', 'Fence deactivate', 'dog', 400, 480, 'active');

CREATE TEMP TABLE _before AS
SELECT jsonb_build_object(
  'products', (SELECT jsonb_agg(to_jsonb(product) ORDER BY product.id)
                 FROM public.catalog_products AS product
                WHERE product.slug LIKE 'fence-lifecycle-%'),
  'skus', (SELECT jsonb_agg(to_jsonb(sku) ORDER BY sku.id)
             FROM public.catalog_skus AS sku WHERE sku.sku LIKE 'FENCE-LIFECYCLE-%')
) AS snapshot;

SELECT throws_ok(
  $$ SELECT public.admin_archive_catalog_product(
       'a2111111-1111-1111-1111-111111111111', 'fence-lifecycle-archive',
       'commit', 'fence-lifecycle-archive', NULL, 'agent_catalog') $$,
  '42501', 'legacy_catalog_mutation_fenced', 'product archive is fenced');
SELECT throws_ok(
  $$ SELECT public.admin_restore_catalog_product(
       'a2111111-1111-1111-1111-111111111111', 'fence-lifecycle-restore',
       'commit', 'fence-lifecycle-restore', NULL, 'agent_catalog') $$,
  '42501', 'legacy_catalog_mutation_fenced', 'product restore is fenced');
SELECT throws_ok(
  $$ SELECT public.admin_deactivate_catalog_product(
       'a2111111-1111-1111-1111-111111111111', 'fence-lifecycle-deactivate',
       'commit', 'fence-lifecycle-deactivate', NULL, 'agent_catalog') $$,
  '42501', 'legacy_catalog_mutation_fenced', 'product deactivation is fenced');

SELECT is(
  (SELECT snapshot::text FROM _before),
  (SELECT jsonb_build_object(
    'products', (SELECT jsonb_agg(to_jsonb(product) ORDER BY product.id)
                   FROM public.catalog_products AS product
                  WHERE product.slug LIKE 'fence-lifecycle-%'),
    'skus', (SELECT jsonb_agg(to_jsonb(sku) ORDER BY sku.id)
               FROM public.catalog_skus AS sku WHERE sku.sku LIKE 'FENCE-LIFECYCLE-%')
  )::text),
  'all fenced lifecycle calls leave product and SKU lifecycle state unchanged');

SELECT * FROM finish();
ROLLBACK;
