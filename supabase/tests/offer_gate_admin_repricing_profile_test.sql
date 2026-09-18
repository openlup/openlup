-- pgTAP: W3c-a fences the two legacy repricers while retaining the existing
-- settlement-profile proof for promotion creation and offer-policy readiness.
--
-- `admin_set_subscription_band_percent` and `admin_set_catalog_price` no
-- longer inspect the profile or mutate prices. The legal promotion and
-- readiness paths below remain deliberately unchanged in behaviour.

BEGIN;
SELECT plan(19);

-- ---- Fixtures ---------------------------------------------------------------
INSERT INTO public.admin_users (id, email, role, is_machine_actor) VALUES
  ('c3100000-0000-4000-8000-000000000001', 'profile-admin@example.invalid', 'admin', false);
INSERT INTO public.catalog_products (id, slug, name, status) VALUES
  ('c3200000-0000-4000-8000-000000000001', 'profile-fixture', 'Profile Fixture', 'active');
INSERT INTO public.catalog_skus (id, product_id, sku, title, pet_type, net_weight_g, kcal_per_unit, status) VALUES
  ('c3300000-0000-4000-8000-000000000001', 'c3200000-0000-4000-8000-000000000001',
   'PROFILE-FIXTURE-400G', 'Profile Fixture', 'other', 400, 480, 'active');
INSERT INTO public.price_lists (id, name, region_code, currency, status)
VALUES (
  'c3400000-0000-4000-8000-000000000001', 'profile_fixture_list',
  public.platform_region_code(), public.platform_settlement_currency(), 'active'
);
INSERT INTO public.price_entries (
  price_list_id, variant_id, mode, min_qty, unit_price_minor, amount_kind, active
) VALUES
  ('c3400000-0000-4000-8000-000000000001', 'c3300000-0000-4000-8000-000000000001', 'one_time', 1, 1000, 'gross', true),
  ('c3400000-0000-4000-8000-000000000001', 'c3300000-0000-4000-8000-000000000001', 'subscription', 1, 950, 'gross', true);
SELECT set_config('request.jwt.claims',
  '{"sub":"c3100000-0000-4000-8000-000000000001","role":"authenticated"}', true);

-- ---- The reach question, asked of the privilege system directly ---------------
-- Fenced functions retain their existing execute/definer boundary so callers
-- receive the stable refusal rather than a missing-function or ACL surprise.
SELECT ok(
  (SELECT bool_and(has_function_privilege('service_role', p.oid, 'execute'))
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname IN (
      'commerce_offer_policy_v2_readiness', 'admin_set_subscription_band_percent',
      'admin_set_catalog_price', 'admin_promotion_code_create')),
  'service_role may execute the two fenced identities and the two live profile readers');

SELECT ok(
  (SELECT bool_and(p.prosecdef)
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname IN (
      'commerce_offer_policy_v2_readiness', 'admin_set_subscription_band_percent',
      'admin_set_catalog_price', 'admin_promotion_code_create')),
  'all four functions retain their definer-rights boundary');

-- =============================================================================
-- 1. admin_set_subscription_band_percent and admin_set_catalog_price
-- =============================================================================
CREATE TEMP TABLE _before_repricing AS
SELECT jsonb_agg(to_jsonb(price) ORDER BY price.id) AS prices
  FROM public.price_entries AS price
 WHERE price.price_list_id = 'c3400000-0000-4000-8000-000000000001';

SET LOCAL ROLE service_role;
SELECT throws_ok(
  $$ SELECT public.admin_set_subscription_band_percent(10) $$,
  '42501', 'legacy_catalog_mutation_fenced',
  'a service_role call to the legacy subscription-band repricer is fenced before profile lookup');
RESET ROLE;

SELECT throws_ok(
  $$ SELECT public.admin_set_catalog_price(
       'c3100000-0000-4000-8000-000000000001', 'PROFILE-FIXTURE-400G', 'one_time',
       1200, (SELECT list.currency FROM public.price_lists AS list
                WHERE list.id = 'c3400000-0000-4000-8000-000000000001'), 'commit',
       'f3c-price-key-0001', NULL, 'agent_catalog') $$,
  '42501', 'legacy_catalog_mutation_fenced',
  'the legacy catalog-price writer is fenced before profile lookup');

SELECT is(
  (SELECT prices::text FROM _before_repricing),
  (SELECT jsonb_agg(to_jsonb(price) ORDER BY price.id)::text
     FROM public.price_entries AS price
    WHERE price.price_list_id = 'c3400000-0000-4000-8000-000000000001'),
  'both fenced repricers leave active and historical price entries unchanged');

-- =============================================================================
-- 3. admin_promotion_code_create
-- =============================================================================
SET LOCAL ROLE service_role;

SELECT lives_ok(
  $$ SELECT public.admin_promotion_code_create(
       'c3100000-0000-4000-8000-000000000001', 'f3c-first', 'F3c First', NULL::text,
       ARRAY['one_time'], now() - interval '1 hour', NULL::timestamptz,
       0, NULL::integer, NULL::integer, 'draft',
       '[{"lane":"product","kind":"fixed_amount","valueMinor":250}]'::jsonb,
       'f3c-code-key-0001', 'f3c-fingerprint-a', 'admin_console') $$,
  'a service_role caller reaches the revoked region reader through the definer-rights code RPC');

RESET ROLE;

-- Asserted after RESET ROLE on purpose: service_role holds no EXECUTE on the readers, so
-- the expected value has to be produced by a principal that does. That asymmetry is the
-- point of the assertion above - the RPC reached what its caller cannot.
SELECT is(
  (SELECT p.region_availability FROM public.promotions p
     JOIN public.promotion_code_bindings pcb ON pcb.promotion_id = p.id
     JOIN public.promotion_codes pc ON pc.id = pcb.promotion_code_id
    WHERE pc.code_normalized = 'F3C-FIRST'),
  ARRAY[public.platform_region_code()],
  'the per-lane evaluator row is scoped to the market the mirror names');

UPDATE public.commerce_settings SET value_text = 'ZZ' WHERE key = 'settlement_region';
SELECT lives_ok(
  $$ SELECT public.admin_promotion_code_create(
       'c3100000-0000-4000-8000-000000000001', 'f3c-second', 'F3c Second', NULL::text,
       ARRAY['one_time'], now() - interval '1 hour', NULL::timestamptz,
       0, NULL::integer, NULL::integer, 'draft',
       '[{"lane":"product","kind":"fixed_amount","valueMinor":250}]'::jsonb,
       'f3c-code-key-0002', 'f3c-fingerprint-b', 'admin_console') $$,
  'a code created after the mirror moves is accepted');
SELECT is(
  (SELECT p.region_availability FROM public.promotions p
     JOIN public.promotion_code_bindings pcb ON pcb.promotion_id = p.id
     JOIN public.promotion_codes pc ON pc.id = pcb.promotion_code_id
    WHERE pc.code_normalized = 'F3C-SECOND'),
  ARRAY['ZZ'],
  'and it is scoped to the new market, so the value is read per call and not compiled in');
UPDATE public.commerce_settings AS settings SET value_text = (
  SELECT list.region_code FROM public.price_lists AS list
   WHERE list.id = 'c3400000-0000-4000-8000-000000000001')
 WHERE settings.key = 'settlement_region';

DELETE FROM public.commerce_settings WHERE key = 'settlement_region';
SELECT throws_ok(
  $$ SELECT public.admin_promotion_code_create(
       'c3100000-0000-4000-8000-000000000001', 'f3c-third', 'F3c Third', NULL::text,
       ARRAY['one_time'], now() - interval '1 hour', NULL::timestamptz,
       0, NULL::integer, NULL::integer, 'draft',
       '[{"lane":"product","kind":"fixed_amount","valueMinor":250}]'::jsonb,
       'f3c-code-key-0003', 'f3c-fingerprint-c', 'admin_console') $$,
  '55000', NULL,
  'with no settlement region a new code refuses rather than shipping an unscoped benefit');

SELECT throws_ok(
  $$ SELECT public.admin_promotion_code_create(
       'c3100000-0000-4000-8000-000000000001', 'f3c-fourth', 'F3c Fourth', NULL::text,
       ARRAY['one_time'], now() - interval '1 hour', NULL::timestamptz,
       0, NULL::integer, NULL::integer, 'archived',
       '[{"lane":"product","kind":"fixed_amount","valueMinor":250}]'::jsonb,
       'f3c-code-key-0004', 'f3c-fingerprint-d', 'admin_console') $$,
  '22023', 'promotion_code_invalid_definition',
  'a malformed definition is still refused as malformed, not as a configuration fault');

SELECT is(
  (SELECT count(*)::int FROM public.promotion_codes
    WHERE code_normalized IN ('F3C-THIRD', 'F3C-FOURTH')),
  0,
  'neither refusal left a half-written code behind');

INSERT INTO public.commerce_settings (key, value_text)
SELECT 'settlement_region', list.region_code FROM public.price_lists AS list
 WHERE list.id = 'c3400000-0000-4000-8000-000000000001';

-- =============================================================================
-- 4. commerce_offer_policy_v2_readiness
-- =============================================================================
SET LOCAL ROLE service_role;

SELECT is(
  (SELECT public.commerce_offer_policy_v2_readiness()->>'contractVersion'),
  'commerce-offer-policy-v2-readiness.v1',
  'a service_role caller reaches both readers through the gate, and its contract is unmoved');

SELECT is(
  (SELECT public.commerce_offer_policy_v2_readiness()#>>'{evidence,activePriceListCount}'),
  '1',
  'with the mirror matching, the gate counts this deployment''s own active price list');

RESET ROLE;

UPDATE public.commerce_settings SET value_text = 'XTS' WHERE key = 'settlement_currency';
SELECT is(
  (SELECT public.commerce_offer_policy_v2_readiness()#>>'{evidence,activePriceListCount}'),
  '0',
  'point the mirror at another currency and the same catalog counts as zero lists');
SELECT ok(
  (SELECT public.commerce_offer_policy_v2_readiness()->'reasons')
    @> '["catalog_1490_legacy_1340_invalid"]'::jsonb,
  'which the gate reports as a catalog reason rather than silently passing');
UPDATE public.commerce_settings AS settings SET value_text = (
  SELECT list.currency FROM public.price_lists AS list
   WHERE list.id = 'c3400000-0000-4000-8000-000000000001')
 WHERE settings.key = 'settlement_currency';

UPDATE public.commerce_settings SET value_text = 'ZZ' WHERE key = 'settlement_region';
SELECT is(
  (SELECT public.commerce_offer_policy_v2_readiness()#>>'{evidence,activePriceListCount}'),
  '0',
  'and the region axis moves the gate the same way');
UPDATE public.commerce_settings AS settings SET value_text = (
  SELECT list.region_code FROM public.price_lists AS list
   WHERE list.id = 'c3400000-0000-4000-8000-000000000001')
 WHERE settings.key = 'settlement_region';

-- Fail-closed. The gate is a STABLE reader with nothing to roll back, so the whole
-- question is whether it answers. It must not: an unconfigured deployment is one the
-- gate cannot describe, and its caller already converts a failed read into "not ready".
DELETE FROM public.commerce_settings WHERE key = 'settlement_currency';
SELECT throws_ok(
  $$ SELECT public.commerce_offer_policy_v2_readiness() $$,
  '55000', NULL,
  'with no settlement currency the gate refuses to answer instead of reporting an empty catalog');

DELETE FROM public.commerce_settings WHERE key = 'settlement_region';
INSERT INTO public.commerce_settings (key, value_text)
SELECT 'settlement_currency', list.currency FROM public.price_lists AS list
 WHERE list.id = 'c3400000-0000-4000-8000-000000000001';
SELECT throws_ok(
  $$ SELECT public.commerce_offer_policy_v2_readiness() $$,
  '55000', NULL,
  'and the region row is just as mandatory - neither reader has a default to fall back on');

SELECT * FROM finish();
ROLLBACK;
