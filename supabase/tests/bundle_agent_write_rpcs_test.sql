-- pgTAP: bundle agent write RPCs (20260812203000).
--   The durable transcription of the wave A3 container assertion set: the checks
--   were proved once on a disposable container and would otherwise have left no
--   artifact in the repository. This file is that artifact, so a change to any of
--   the seven routines is caught by the ordinary local lane rather than by
--   remembering to re-run a one-off script.
--
--   Covered here (the core of the set, not all of it):
--     * actor guards        - a null and an unknown actor are both 42501;
--     * publish gate        - a machine actor cannot activate or deactivate;
--     * composition refusal - empty, duplicated, add-ons-only, unknown unit,
--                             unsellable unit, and the whole-set replace itself;
--     * append-only price   - a second price closes the first and rewrites nothing,
--                             and the two allocator refusals are enforced here too;
--     * idempotent replay   - a reused key returns the original outcome and
--                             creates no second bundle.
--
--   Vocabulary-neutral fixtures: XTS (ISO 4217 test currency), neutral slugs and
--   the neutral pet_type value; the two remaining category words are NOT NULL
--   column names, which no fixture can rename.
-- Run via: supabase test db
BEGIN;
SELECT plan(26);

-- Fixtures -------------------------------------------------------------------
INSERT INTO public.admin_users (id, email, role, is_machine_actor) VALUES
  ('b1111111-1111-1111-1111-111111111111', 'operator@example.invalid', 'admin', false),
  ('b2222222-2222-2222-2222-222222222222', 'agent@example.invalid', 'admin', true);

INSERT INTO public.price_lists (id, name, region_code, currency, status)
  VALUES ('b3333333-3333-3333-3333-333333333333', 'bundle_test_list', 'XT', 'XTS', 'active');

INSERT INTO public.catalog_products (id, slug, name, status)
VALUES ('b4444444-4444-4444-4444-444444444444', 'bundle-unit-product', 'Bundle unit product', 'active');

INSERT INTO public.catalog_skus (id, product_id, sku, title, pet_type, status, net_weight_g, kcal_per_unit, sellable_standalone)
VALUES
  ('b5555555-5555-5555-5555-555555555551', 'b4444444-4444-4444-4444-444444444444',
   'UNIT-ALPHA', 'Unit alpha', 'other', 'active', 400, 480, true),
  ('b5555555-5555-5555-5555-555555555552', 'b4444444-4444-4444-4444-444444444444',
   'UNIT-BETA', 'Unit beta', 'other', 'active', 400, 480, true),
  ('b5555555-5555-5555-5555-555555555553', 'b4444444-4444-4444-4444-444444444444',
   'UNIT-DRAFT', 'Unit draft', 'other', 'draft', 400, 480, true);

INSERT INTO public.price_entries (price_list_id, variant_id, mode, unit_price_minor, active)
VALUES
  ('b3333333-3333-3333-3333-333333333333', 'b5555555-5555-5555-5555-555555555551', 'any', 1000, true),
  ('b3333333-3333-3333-3333-333333333333', 'b5555555-5555-5555-5555-555555555552', 'any', 700, true);

-- 1. actor guards ------------------------------------------------------------
SELECT throws_ok(
  $$ SELECT public.admin_upsert_bundle_draft(NULL, 'starter-set', 'Starter set') $$,
  '42501', 'actor_required', 'a null actor is refused before anything is read');

SELECT throws_ok(
  $$ SELECT public.admin_upsert_bundle_draft(
       'b9999999-9999-9999-9999-999999999999', 'starter-set', 'Starter set') $$,
  '42501', 'actor_unknown', 'an actor absent from the registry is refused');

-- 2. draft upsert ------------------------------------------------------------
SELECT lives_ok(
  $$ SELECT public.admin_upsert_bundle_draft(
       'b1111111-1111-1111-1111-111111111111', 'starter-set', 'Starter set') $$,
  'an operator creates a draft bundle');

SELECT is((SELECT status FROM public.catalog_bundles WHERE code = 'starter-set'), 'draft',
  'a bundle is born draft, never active');

-- An agent may edit a draft: only publishing is human-gated.
SELECT lives_ok(
  $$ SELECT public.admin_upsert_bundle_draft(
       'b2222222-2222-2222-2222-222222222222', 'starter-set', 'Starter set renamed') $$,
  'a machine actor may edit a draft');

-- 3. composition refusals ----------------------------------------------------
SELECT throws_ok(
  $$ SELECT public.admin_set_bundle_composition(
       'b1111111-1111-1111-1111-111111111111', 'starter-set', '[]'::jsonb) $$,
  'P0001', 'min_components', 'an empty set is refused');

SELECT throws_ok(
  $$ SELECT public.admin_set_bundle_composition(
       'b1111111-1111-1111-1111-111111111111', 'starter-set',
       '[{"sku":"UNIT-ALPHA","quantity":1},{"sku":"UNIT-ALPHA","quantity":2}]'::jsonb) $$,
  'P0001', 'duplicate_component', 'the same unit twice is refused: quantity is the multiplicity');

SELECT throws_ok(
  $$ SELECT public.admin_set_bundle_composition(
       'b1111111-1111-1111-1111-111111111111', 'starter-set',
       '[{"sku":"UNIT-ALPHA","quantity":1,"is_addon":true}]'::jsonb) $$,
  'P0001', 'addon_only_composition', 'an add-ons-only set is refused');

SELECT throws_ok(
  $$ SELECT public.admin_set_bundle_composition(
       'b1111111-1111-1111-1111-111111111111', 'starter-set',
       '[{"sku":"UNIT-ABSENT","quantity":1}]'::jsonb) $$,
  'P0002', 'component_not_found', 'an unknown unit is refused');

SELECT throws_ok(
  $$ SELECT public.admin_set_bundle_composition(
       'b1111111-1111-1111-1111-111111111111', 'starter-set',
       '[{"sku":"UNIT-DRAFT","quantity":1}]'::jsonb) $$,
  'P0001', 'component_not_sellable',
  'a bundle must not become the only way an unsellable unit reaches a customer');

-- 4. activation preconditions ------------------------------------------------
SELECT throws_ok(
  $$ SELECT public.admin_activate_bundle(
       'b1111111-1111-1111-1111-111111111111', 'starter-set') $$,
  'P0001', 'composition_required_to_sell', 'an empty bundle cannot be published');

-- 5. whole-set composition replace -------------------------------------------
SELECT lives_ok(
  $$ SELECT public.admin_set_bundle_composition(
       'b1111111-1111-1111-1111-111111111111', 'starter-set',
       '[{"sku":"UNIT-ALPHA","quantity":3},{"sku":"UNIT-BETA","quantity":2}]'::jsonb) $$,
  'an operator composes the bundle');

-- Two writes in ONE transaction: the first draft of this routine staged the set in
-- a temp table whose ON COMMIT DROP lifetime survived the call and collided here.
SELECT lives_ok(
  $$ SELECT public.admin_set_bundle_composition(
       'b1111111-1111-1111-1111-111111111111', 'starter-set',
       '[{"sku":"UNIT-ALPHA","quantity":3},{"sku":"UNIT-BETA","quantity":2}]'::jsonb) $$,
  'a second composition write in the same transaction is accepted');

SELECT is(
  (SELECT count(*)::int FROM public.catalog_bundle_components AS component
     JOIN public.catalog_bundles AS bundle ON bundle.id = component.bundle_id
    WHERE bundle.code = 'starter-set'),
  2, 'the replace is whole-set: two rows, not four');

-- 6. target price ------------------------------------------------------------
SELECT throws_ok(
  $$ SELECT public.admin_set_bundle_target_price(
       'b1111111-1111-1111-1111-111111111111', 'starter-set', 'one_time', 99000, 'XTS') $$,
  'P0001', 'target_above_component_sum', 'a bundle is never priced above its parts');

SELECT throws_ok(
  $$ SELECT public.admin_set_bundle_target_price(
       'b1111111-1111-1111-1111-111111111111', 'starter-set', 'one_time', 1, 'XTS') $$,
  'P0001', 'target_below_floor', 'the target must cover every unit''s minimum payable');

SELECT lives_ok(
  $$ SELECT public.admin_set_bundle_target_price(
       'b1111111-1111-1111-1111-111111111111', 'starter-set', 'one_time', 3333, 'XTS') $$,
  'an operator sets the target price');

SELECT lives_ok(
  $$ SELECT public.admin_set_bundle_target_price(
       'b1111111-1111-1111-1111-111111111111', 'starter-set', 'one_time', 3000, 'XTS') $$,
  'an operator reprices the bundle');

-- APPEND-ONLY: the superseded amount is still readable, closed rather than rewritten.
SELECT is(
  (SELECT count(*)::int FROM public.catalog_bundle_prices AS price
     JOIN public.catalog_bundles AS bundle ON bundle.id = price.bundle_id
    WHERE bundle.code = 'starter-set'),
  2, 'repricing appends a row rather than rewriting the stored amount');

SELECT is(
  (SELECT target_price_minor FROM public.catalog_bundle_prices AS price
     JOIN public.catalog_bundles AS bundle ON bundle.id = price.bundle_id
    WHERE bundle.code = 'starter-set' AND price.active),
  3000, 'exactly the newest amount is active');

-- 7. publish gate ------------------------------------------------------------
SELECT throws_ok(
  $$ SELECT public.admin_activate_bundle(
       'b2222222-2222-2222-2222-222222222222', 'starter-set') $$,
  '42501', 'publish_requires_human', 'a machine actor cannot publish a bundle');

SELECT lives_ok(
  $$ SELECT public.admin_activate_bundle(
       'b1111111-1111-1111-1111-111111111111', 'starter-set') $$,
  'an operator publishes the composed, priced bundle');

SELECT throws_ok(
  $$ SELECT public.admin_deactivate_bundle(
       'b2222222-2222-2222-2222-222222222222', 'starter-set') $$,
  '42501', 'publish_requires_human', 'a machine actor cannot unpublish a bundle either');

-- 8. idempotent replay -------------------------------------------------------
SELECT lives_ok(
  $$ SELECT public.admin_upsert_bundle_draft(
       'b1111111-1111-1111-1111-111111111111', 'replayed-set', 'Replayed set',
       NULL, NULL, NULL, NULL, 'commit', 'replay-key-1') $$,
  'a keyed write lands once');

SELECT is(
  (public.admin_upsert_bundle_draft(
     'b1111111-1111-1111-1111-111111111111', 'replayed-set-other', 'Other title',
     NULL, NULL, NULL, NULL, 'commit', 'replay-key-1') ->> 'idempotent')::boolean,
  true, 'the same key short-circuits and writes nothing new');

SELECT is(
  (SELECT count(*)::int FROM public.catalog_bundles WHERE code = 'replayed-set-other'),
  0, 'a replayed key creates no second bundle');

SELECT finish();
ROLLBACK;
