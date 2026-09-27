-- pgTAP: the database-side settlement mirror added by
-- 20260816152909_commerce_settings_settlement_profile.
--
-- Two things are under test and only one of them is the happy path.
--
--   1. The three key-scoped CHECKs hold the shape of each new setting, and hold it for that key
--      only. A rule that leaked onto the other keys would break the shipping and offer-layout
--      rows the table already carries.
--   2. platform_settlement_currency() and platform_region_code() refuse to answer when the row
--      they read is missing or carries no value. This is the case that matters: the failure this
--      wave exists to prevent is a money function that returns a plausible default instead of
--      raising, so the absence of a fallback is asserted rather than read.
--
-- This file names no currency and no country. It asserts the seeded values' shape and their
-- agreement with the functions, and uses the ISO 4217 code reserved for testing (XTS) and a
-- user-assigned ISO 3166-1 code (ZZ) wherever a concrete code is needed. That keeps the proof
-- honest about what it is proving: the mirror is correct for whatever this deployment settles
-- in, not correct for one particular answer.
--
-- Run via: npm run test:db:local

BEGIN;
SELECT plan(17);

-- ---- The migration seeded all three rows, in the right lanes ---------------
SELECT is(
  (SELECT count(*)::int FROM public.commerce_settings
    WHERE key IN ('settlement_currency', 'settlement_region', 'min_product_payable_minor')),
  3, 'the migration seeded all three settlement rows');

SELECT matches(
  (SELECT value_text FROM public.commerce_settings WHERE key = 'settlement_currency'),
  '^[A-Z]{3}$', 'the seeded settlement currency is a well-formed ISO 4217 code');

SELECT matches(
  (SELECT value_text FROM public.commerce_settings WHERE key = 'settlement_region'),
  '^[A-Z]{2}$', 'the seeded settlement region is a well-formed ISO 3166-1 alpha-2 code');

SELECT ok(
  (SELECT value_minor >= 1 FROM public.commerce_settings WHERE key = 'min_product_payable_minor'),
  'the seeded payable floor is at least one minor unit');

-- ---- The readers return exactly what is stored -----------------------------
SELECT is(
  public.platform_settlement_currency(),
  (SELECT value_text FROM public.commerce_settings WHERE key = 'settlement_currency'),
  'platform_settlement_currency returns the stored code');

SELECT is(
  public.platform_region_code(),
  (SELECT value_text FROM public.commerce_settings WHERE key = 'settlement_region'),
  'platform_region_code returns the stored code');

-- The readers follow the row rather than a compiled-in answer: change the row inside this
-- transaction and the function must change with it.
UPDATE public.commerce_settings SET value_text = 'XTS' WHERE key = 'settlement_currency';
SELECT is(public.platform_settlement_currency(), 'XTS',
  'platform_settlement_currency follows the row, not a compiled-in answer');

UPDATE public.commerce_settings SET value_text = 'ZZ' WHERE key = 'settlement_region';
SELECT is(public.platform_region_code(), 'ZZ',
  'platform_region_code follows the row, not a compiled-in answer');

-- ---- Fail-closed: no row, no answer ----------------------------------------
DELETE FROM public.commerce_settings WHERE key = 'settlement_currency';
SELECT throws_ok(
  $$ SELECT public.platform_settlement_currency() $$,
  '55000', NULL, 'platform_settlement_currency raises when its row is absent');

DELETE FROM public.commerce_settings WHERE key = 'settlement_region';
SELECT throws_ok(
  $$ SELECT public.platform_region_code() $$,
  '55000', NULL, 'platform_region_code raises when its row is absent');

-- ---- The key-scoped CHECKs -------------------------------------------------
SELECT throws_ok(
  $$ INSERT INTO public.commerce_settings (key, value_text)
       VALUES ('settlement_currency', 'xts') $$,
  '23514', NULL, 'rejects a settlement currency that is not three uppercase letters');

-- The CHECK spells `value_text IS NOT NULL AND ...` rather than the pattern alone, because a
-- pattern applied to NULL is unknown and a CHECK rejects only what is false. Without the
-- conjunct this row would be legal: the key present, the code absent.
SELECT throws_ok(
  $$ INSERT INTO public.commerce_settings (key, value_minor)
       VALUES ('settlement_currency', 1) $$,
  '23514', NULL, 'rejects a settlement currency row that carries no code');

SELECT throws_ok(
  $$ INSERT INTO public.commerce_settings (key, value_text)
       VALUES ('settlement_region', 'ZZZ') $$,
  '23514', NULL, 'rejects a settlement region that is not two uppercase letters');

-- The floor is expressed in minor units, so its correct value depends on the currency's
-- exponent. One minor unit must be legal: in a zero-exponent currency that is the whole floor.
-- Zero must not be, because a floor of nothing is not a floor.
SELECT throws_ok(
  $$ UPDATE public.commerce_settings SET value_minor = 0
       WHERE key = 'min_product_payable_minor' $$,
  '23514', NULL, 'rejects a payable floor of zero minor units');

SELECT lives_ok(
  $$ UPDATE public.commerce_settings SET value_minor = 1
       WHERE key = 'min_product_payable_minor' $$,
  'accepts a payable floor of one minor unit, as a zero-exponent currency requires');

-- Scoped by key: the rows the table already carried are untouched by all three rules, and a
-- future text-valued setting is not accidentally forced into a currency or region shape.
SELECT lives_ok(
  $$ INSERT INTO public.commerce_settings (key, value_text)
       VALUES ('settlement_profile_test_other_key', 'some_future_vocabulary') $$,
  'the three settlement CHECKs constrain no other key');

-- ---- Defence in depth, checked last because it removes a constraint --------
-- The CHECK above makes a key-present/code-absent row unrepresentable, so the function's own
-- NULL guard is unreachable through the supported path. Drop the constraint inside this
-- transaction to reach it anyway: the two protections must be independent, or the guard is only
-- as good as the constraint that hides it.
ALTER TABLE public.commerce_settings
  DROP CONSTRAINT commerce_settings_settlement_currency_value;
INSERT INTO public.commerce_settings (key, value_minor) VALUES ('settlement_currency', 1);
SELECT throws_ok(
  $$ SELECT public.platform_settlement_currency() $$,
  '55000', NULL, 'platform_settlement_currency raises on a row that carries no code');

SELECT * FROM finish();
ROLLBACK;
