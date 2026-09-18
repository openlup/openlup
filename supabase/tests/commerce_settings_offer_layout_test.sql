-- pgTAP: commerce_settings text value lane + configurator_offer_layout key
-- (20260804065531_commerce_settings_offer_layout).
--   * the three allowed layout names are accepted for the key;
--   * a fourth layout name is rejected by the key-scoped CHECK;
--   * a row with neither value_minor nor value_text is rejected by the value-present CHECK
--     (the invariant that replaced value_minor's NOT NULL);
--   * the migration seeded configurator_offer_layout = starter_first.
--
-- Also covers the key-scoped money guard added by
-- 20260804122501_commerce_settings_shipping_value_guard:
--   * shipping_flat_minor cannot lose its amount, even with value_text set (a NULL amount
--     reads as 0 in the quote port, i.e. silent free shipping);
--   * value_minor = 0 stays legal, so deliberate free shipping is still expressible;
--   * a text-only row for another key is unaffected by that guard.
--
-- Run via: supabase test db

BEGIN;
SELECT plan(10);

-- ---- Seed shipped by the migration -----------------------------------------
SELECT is(
  (SELECT value_text FROM public.commerce_settings WHERE key = 'configurator_offer_layout'),
  'starter_first', 'migration seeded configurator_offer_layout = starter_first');

SELECT ok(
  (SELECT value_minor IS NULL FROM public.commerce_settings WHERE key = 'configurator_offer_layout'),
  'the seeded layout row carries no minor-unit amount');

-- ---- The closed vocabulary is accepted -------------------------------------
SELECT lives_ok(
  $$ UPDATE public.commerce_settings SET value_text = 'subscription_first'
       WHERE key = 'configurator_offer_layout' $$,
  'accepts subscription_first');

SELECT lives_ok(
  $$ UPDATE public.commerce_settings SET value_text = 'one_time_first'
       WHERE key = 'configurator_offer_layout' $$,
  'accepts one_time_first');

SELECT lives_ok(
  $$ UPDATE public.commerce_settings SET value_text = 'starter_first'
       WHERE key = 'configurator_offer_layout' $$,
  'accepts starter_first');

-- ---- Anything outside it is rejected ---------------------------------------
SELECT throws_ok(
  $$ UPDATE public.commerce_settings SET value_text = 'bundle_first'
       WHERE key = 'configurator_offer_layout' $$,
  '23514', NULL, 'rejects a layout name outside the closed vocabulary');

-- ---- A value-less row stays impossible after DROP NOT NULL -----------------
SELECT throws_ok(
  $$ INSERT INTO public.commerce_settings (key, value_minor, value_text)
       VALUES ('offer_layout_test_empty', NULL, NULL) $$,
  '23514', NULL, 'rejects a row with neither value_minor nor value_text');

-- ---- shipping_flat_minor keeps a per-key NOT NULL-equivalent guard ---------
-- The value-present CHECK alone would accept a text-only shipping row, and the quote port
-- reads a NULL amount as 0 — free shipping, silently. The key-scoped CHECK closes that.
SELECT throws_ok(
  $$ UPDATE public.commerce_settings SET value_minor = NULL, value_text = 'free'
       WHERE key = 'shipping_flat_minor' $$,
  '23514', NULL, 'rejects moving shipping_flat_minor to the text lane');

-- Deliberate free shipping is still expressible as an explicit zero amount.
SELECT lives_ok(
  $$ UPDATE public.commerce_settings SET value_minor = 0
       WHERE key = 'shipping_flat_minor' $$,
  'accepts an explicit zero shipping amount');

-- The guard is scoped to one key: other text-valued settings stay legal, so the
-- next offer-layout wave can add one without tripping it.
SELECT lives_ok(
  $$ INSERT INTO public.commerce_settings (key, value_text)
       VALUES ('offer_layout_test_text_only', 'some_future_vocabulary') $$,
  'accepts a text-only row for a key other than shipping_flat_minor');

SELECT * FROM finish();
ROLLBACK;
