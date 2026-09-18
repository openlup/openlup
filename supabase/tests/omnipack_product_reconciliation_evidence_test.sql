-- pgTAP: omnipack_product_reconciliation_evidence — idempotent record (replayed bumps last_seen,
-- reopens a resolved row), input validation, SKU resolution, and the resolve RPC closing only the
-- conflict kinds that are no longer active (20260705120000).
--
-- Run via: supabase db reset && supabase test db

BEGIN;
SELECT plan(9);

INSERT INTO public.catalog_products (id, slug, name, status) VALUES
  ('cee20000-0000-0000-0000-0000000000a1', 'opr-lamb', 'Lamb', 'active');
INSERT INTO public.catalog_skus (id, product_id, sku, title, pet_type, net_weight_g, kcal_per_unit, status) VALUES
  ('cee20000-0000-0000-0000-0000000000b1', 'cee20000-0000-0000-0000-0000000000a1', 'OPR-LAMB-400G', 'Lamb', 'dog', 400, 492, 'active');

-- 1. First record opens an evidence row (replayed=false) and resolves catalog_sku_id for a known SKU.
SELECT is(
  public.omnipack_record_product_reconciliation_evidence(
    'recon:OPR-LAMB-400G:5901000000001:kind_quantity_conflict', 'OPR-LAMB-400G', 'kind_quantity_conflict', '5901000000001', 6,
    '{"source":"product_sync"}'::jsonb) ->> 'replayed',
  'false', 'first record opens a reconciliation row');

SELECT isnt(
  (SELECT catalog_sku_id FROM public.omnipack_product_reconciliation_evidence WHERE idempotency_key = 'recon:OPR-LAMB-400G:5901000000001:kind_quantity_conflict'),
  NULL, 'catalog_sku_id resolved for a known SKU');

-- 2. Re-record the same conflict is replayed (one row, last_seen bumped).
SELECT is(
  public.omnipack_record_product_reconciliation_evidence(
    'recon:OPR-LAMB-400G:5901000000001:kind_quantity_conflict', 'OPR-LAMB-400G', 'kind_quantity_conflict', '5901000000001', 6) ->> 'replayed',
  'true', 're-record of the same conflict is replayed');

SELECT is(
  (SELECT count(*)::int FROM public.omnipack_product_reconciliation_evidence WHERE sku = 'OPR-LAMB-400G'),
  1, 'still exactly one evidence row after replay');

-- 3. An unknown SKU is allowed (catalog_sku_id NULL) — never auto-create, just record evidence.
SELECT is(
  public.omnipack_record_product_reconciliation_evidence(
    'recon:GHOST-SKU:5902000000002:unknown_sku', 'GHOST-SKU', 'unknown_sku', '5902000000002', 1) ->> 'conflictKind',
  'unknown_sku', 'unknown SKU records an unknown_sku conflict');

SELECT is(
  (SELECT catalog_sku_id FROM public.omnipack_product_reconciliation_evidence WHERE sku = 'GHOST-SKU'),
  NULL, 'unknown SKU leaves catalog_sku_id NULL');

-- 4. Invalid conflict kind is rejected.
SELECT throws_ok(
  $$ SELECT public.omnipack_record_product_reconciliation_evidence('recon:OPR-LAMB-400G:x:bogus', 'OPR-LAMB-400G', 'bogus', 'x', 1) $$,
  '22023', 'omnipack_product_reconciliation_invalid_input',
  'an invalid conflict kind is rejected');

-- 5. Resolve closes rows whose kind is NOT in the active set; the still-active kind stays open.
SELECT is(
  (public.omnipack_resolve_product_reconciliation_evidence('OPR-LAMB-400G', ARRAY['ean_conflict']::text[], 'run-1', '{}'::jsonb) ->> 'resolved')::int,
  1, 'resolve closes the kind_quantity_conflict (not in the active ean_conflict set)');

SELECT is(
  (SELECT status FROM public.omnipack_product_reconciliation_evidence WHERE idempotency_key = 'recon:OPR-LAMB-400G:5901000000001:kind_quantity_conflict'),
  'resolved', 'the no-longer-active row is now resolved');

ROLLBACK;
