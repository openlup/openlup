-- pgTAP: Self-service RPC guard rails for quote/version and charge timing evidence.
--
-- The BFF normally injects acceptedQuoteHash/expectedTemplateVersion after preview
-- and requires confirmedChargeTiming in the request schema. These tests bypass the
-- BFF and call the service-role RPC shape directly, proving the database mutation
-- boundary fails closed too.
--
-- Run via: supabase db reset && supabase test db

BEGIN;
SELECT plan(21);

INSERT INTO public.catalog_products (id, slug, name, status) VALUES
  ('44445000-0000-0000-0000-000000000001', 'guard-base', 'Guard Base', 'active'),
  ('44445000-0000-0000-0000-000000000002', 'guard-alt', 'Guard Alt', 'active'),
  ('44445000-0000-0000-0000-000000000003', 'guard-addon', 'Guard Addon', 'active');
INSERT INTO public.catalog_skus (id, product_id, sku, title, pet_type, net_weight_g, kcal_per_unit, status) VALUES
  ('55555000-0000-0000-0000-000000000001', '44445000-0000-0000-0000-000000000001', 'GUARD-BASE', 'Base', 'dog', 400, 492, 'active'),
  ('55555000-0000-0000-0000-000000000002', '44445000-0000-0000-0000-000000000002', 'GUARD-ALT', 'Alt', 'dog', 400, 492, 'active'),
  ('55555000-0000-0000-0000-000000000003', '44445000-0000-0000-0000-000000000003', 'GUARD-ADDON', 'Addon', 'dog', 80, 120, 'active');

INSERT INTO auth.users (id) VALUES ('a5000000-0000-0000-0000-000000000001');
INSERT INTO public.clients (id, email, auth_user_id)
VALUES ('c5000000-0000-0000-0000-000000000001', 'guards@example.invalid', 'a5000000-0000-0000-0000-000000000001');

INSERT INTO public.subscriptions (id, client_id, cadence_days, currency, status, next_cycle_at, template_version, edit_window_hours, payment_method_ref, size_constraint)
VALUES
  ('5b500000-0000-0000-0000-000000000001', 'c5000000-0000-0000-0000-000000000001', 28, 'PLN', 'active',
   '2026-09-01T00:00:00Z', 1, 24, 'pm_guard_active', '{"kind":"feeding_days","value":28}'::jsonb),
  ('5b500000-0000-0000-0000-000000000002', 'c5000000-0000-0000-0000-000000000001', 28, 'PLN', 'cancelled',
   '2026-03-01T00:00:00Z', 1, 24, 'pm_guard_cancelled', '{"kind":"feeding_days","value":28}'::jsonb);

INSERT INTO public.subscription_lines (id, subscription_id, variant_id, qty, sort_order, is_addon, template_version, line_metadata) VALUES
  ('51500000-0000-0000-0000-000000000001', '5b500000-0000-0000-0000-000000000001', '55555000-0000-0000-0000-000000000001', 4, 1, false, 1, '{}'::jsonb),
  ('51500000-0000-0000-0000-000000000002', '5b500000-0000-0000-0000-000000000001', '55555000-0000-0000-0000-000000000003', 1, 2, true, 1, '{}'::jsonb);

SELECT throws_ok(
  $q$ SELECT public.customer_self_service_apply_subscription_action(
    'a5000000-0000-0000-0000-000000000001', 'guard-swap-no-quote', '5b500000-0000-0000-0000-000000000001', 'swap_recipe',
    jsonb_build_object('expectedTemplateVersion', 1, 'fromVariantId', '55555000-0000-0000-0000-000000000001', 'toVariantId', '55555000-0000-0000-0000-000000000002'),
    '2026-07-10T10:00:00Z'::timestamptz) $q$,
  'customer_self_service_quote_not_accepted',
  'RPC guard: swap_recipe requires accepted quote');

SELECT throws_ok(
  $q$ SELECT public.customer_self_service_apply_subscription_action(
    'a5000000-0000-0000-0000-000000000001', 'guard-add-no-quote', '5b500000-0000-0000-0000-000000000001', 'add_addon',
    jsonb_build_object('expectedTemplateVersion', 1, 'variantId', '55555000-0000-0000-0000-000000000003', 'qty', 1),
    '2026-07-10T10:00:00Z'::timestamptz) $q$,
  'customer_self_service_quote_not_accepted',
  'RPC guard: add_addon requires accepted quote');

SELECT throws_ok(
  $q$ SELECT public.customer_self_service_apply_subscription_action(
    'a5000000-0000-0000-0000-000000000001', 'guard-remove-no-quote', '5b500000-0000-0000-0000-000000000001', 'remove_addon',
    jsonb_build_object('expectedTemplateVersion', 1, 'variantId', '55555000-0000-0000-0000-000000000003'),
    '2026-07-10T10:00:00Z'::timestamptz) $q$,
  'customer_self_service_quote_not_accepted',
  'RPC guard: remove_addon requires accepted quote');

SELECT throws_ok(
  $q$ SELECT public.customer_self_service_apply_subscription_action(
    'a5000000-0000-0000-0000-000000000001', 'guard-qty-no-quote', '5b500000-0000-0000-0000-000000000001', 'update_addon_quantity',
    jsonb_build_object('expectedTemplateVersion', 1, 'variantId', '55555000-0000-0000-0000-000000000003', 'qty', 2),
    '2026-07-10T10:00:00Z'::timestamptz) $q$,
  'customer_self_service_quote_not_accepted',
  'RPC guard: update_addon_quantity requires accepted quote');

SELECT throws_ok(
  $q$ SELECT public.customer_self_service_apply_subscription_action(
    'a5000000-0000-0000-0000-000000000001', 'guard-plan-no-quote', '5b500000-0000-0000-0000-000000000001', 'update_plan_length',
    jsonb_build_object('expectedTemplateVersion', 1, 'planDays', 14, 'recipeLines', jsonb_build_array(jsonb_build_object('variantId', '55555000-0000-0000-0000-000000000001', 'qty', 2))),
    '2026-07-10T10:00:00Z'::timestamptz) $q$,
  'customer_self_service_quote_not_accepted',
  'RPC guard: update_plan_length requires accepted quote');

SELECT throws_ok(
  $q$ SELECT public.customer_self_service_apply_subscription_action(
    'a5000000-0000-0000-0000-000000000001', 'guard-mix-no-quote', '5b500000-0000-0000-0000-000000000001', 'update_recipe_mix',
    jsonb_build_object('expectedTemplateVersion', 1, 'recipeLines', jsonb_build_array(jsonb_build_object('variantId', '55555000-0000-0000-0000-000000000001', 'qty', 4))),
    '2026-07-10T10:00:00Z'::timestamptz) $q$,
  'customer_self_service_quote_not_accepted',
  'RPC guard: update_recipe_mix requires accepted quote');

SELECT throws_ok(
  $q$ SELECT public.customer_self_service_apply_subscription_action(
    'a5000000-0000-0000-0000-000000000001', 'guard-portion-no-quote', '5b500000-0000-0000-0000-000000000001', 'set_portion_mode',
    jsonb_build_object('expectedTemplateVersion', 1, 'portionMode', 'topper', 'recipeLines', jsonb_build_array(jsonb_build_object('variantId', '55555000-0000-0000-0000-000000000001', 'qty', 2))),
    '2026-07-10T10:00:00Z'::timestamptz) $q$,
  'customer_self_service_quote_not_accepted',
  'RPC guard: set_portion_mode requires accepted quote');

SELECT throws_ok(
  $q$ SELECT public.customer_self_service_apply_subscription_action(
    'a5000000-0000-0000-0000-000000000001', 'guard-package-no-quote', '5b500000-0000-0000-0000-000000000001', 'update_package_template',
    jsonb_build_object('expectedTemplateVersion', 1, 'planDays', 28, 'recipeLines', jsonb_build_array(jsonb_build_object('variantId', '55555000-0000-0000-0000-000000000001', 'qty', 14)), 'addonLines', jsonb_build_array()),
    '2026-07-10T10:00:00Z'::timestamptz) $q$,
  'customer_self_service_quote_not_accepted',
  'RPC guard: update_package_template requires accepted quote');

SELECT throws_ok(
  $q$ SELECT public.customer_self_service_apply_subscription_action(
    'a5000000-0000-0000-0000-000000000001', 'guard-update-bundle-no-quote', '5b500000-0000-0000-0000-000000000001', 'update_bundle',
    jsonb_build_object(
      'expectedTemplateVersion', 1,
      'compositionConstraint', jsonb_build_object('kind', 'feeding_days', 'value', 28),
      'coreLines', jsonb_build_array(jsonb_build_object('variantId', '55555000-0000-0000-0000-000000000001', 'qty', 4))
    ),
    '2026-07-10T10:00:00Z'::timestamptz) $q$,
  'customer_self_service_quote_not_accepted',
  'RPC guard: update_bundle requires accepted quote');

SELECT throws_ok(
  $q$ SELECT public.customer_self_service_apply_subscription_action(
    'a5000000-0000-0000-0000-000000000001', 'guard-resize-bundle-no-quote', '5b500000-0000-0000-0000-000000000001', 'resize_bundle',
    jsonb_build_object(
      'expectedTemplateVersion', 1,
      'resizeLever', jsonb_build_object('kind', 'planLength', 'value', 14),
      'compositionConstraint', jsonb_build_object('kind', 'feeding_days', 'value', 14),
      'coreLines', jsonb_build_array(jsonb_build_object('variantId', '55555000-0000-0000-0000-000000000001', 'qty', 2))
    ),
    '2026-07-10T10:00:00Z'::timestamptz) $q$,
  'customer_self_service_quote_not_accepted',
  'RPC guard: resize_bundle requires accepted quote');

SELECT throws_ok(
  $q$ SELECT public.customer_self_service_apply_subscription_action(
    'a5000000-0000-0000-0000-000000000001', 'guard-qty-bad-quote', '5b500000-0000-0000-0000-000000000001', 'update_addon_quantity',
    jsonb_build_object('acceptedQuoteHash', 'not-a-hash', 'expectedTemplateVersion', 1, 'variantId', '55555000-0000-0000-0000-000000000003', 'qty', 2),
    '2026-07-10T10:00:00Z'::timestamptz) $q$,
  'customer_self_service_quote_not_accepted',
  'RPC guard: accepted quote hash must be the quote hash shape');

SELECT throws_ok(
  $q$ SELECT public.customer_self_service_apply_subscription_action(
    'a5000000-0000-0000-0000-000000000001', 'guard-qty-no-version', '5b500000-0000-0000-0000-000000000001', 'update_addon_quantity',
    jsonb_build_object('acceptedQuoteHash', repeat('a', 64), 'variantId', '55555000-0000-0000-0000-000000000003', 'qty', 2),
    '2026-07-10T10:00:00Z'::timestamptz) $q$,
  'customer_self_service_stale_edit',
  'RPC guard: price edits require expectedTemplateVersion');

SELECT throws_ok(
  $q$ SELECT public.customer_self_service_apply_subscription_action(
    'a5000000-0000-0000-0000-000000000001', 'guard-qty-bad-version', '5b500000-0000-0000-0000-000000000001', 'update_addon_quantity',
    jsonb_build_object('acceptedQuoteHash', repeat('a', 64), 'expectedTemplateVersion', 'bad', 'variantId', '55555000-0000-0000-0000-000000000003', 'qty', 2),
    '2026-07-10T10:00:00Z'::timestamptz) $q$,
  'customer_self_service_stale_edit',
  'RPC guard: malformed expectedTemplateVersion fails closed as stale');

SELECT throws_ok(
  $q$ SELECT public.customer_self_service_apply_subscription_action(
    'a5000000-0000-0000-0000-000000000001', 'guard-qty-stale-version', '5b500000-0000-0000-0000-000000000001', 'update_addon_quantity',
    jsonb_build_object('acceptedQuoteHash', repeat('a', 64), 'expectedTemplateVersion', 99, 'variantId', '55555000-0000-0000-0000-000000000003', 'qty', 2),
    '2026-07-10T10:00:00Z'::timestamptz) $q$,
  'customer_self_service_stale_edit',
  'RPC guard: price edits reject stale template versions');

SELECT is((SELECT qty FROM public.subscription_lines WHERE id = '51500000-0000-0000-0000-000000000002'),
  1, 'RPC guard: rejected price edits leave subscription lines unchanged');

SELECT throws_ok(
  $q$ SELECT public.customer_self_service_apply_subscription_action(
    'a5000000-0000-0000-0000-000000000001', 'guard-qty-no-ledger', '5b500000-0000-0000-0000-000000000001', 'update_addon_quantity',
    jsonb_build_object('acceptedQuoteHash', repeat('b', 64), 'expectedTemplateVersion', 1, 'variantId', '55555000-0000-0000-0000-000000000003', 'qty', 2),
    '2026-07-10T10:00:00Z'::timestamptz) $q$,
  'customer_self_service_quote_not_accepted',
  'RPC guard: shaped quote hash without a preview ledger row is rejected');

INSERT INTO public.subscription_quote_previews (
  subscription_id, client_id, created_by_auth_user_id, action, quote_hash, template_version,
  expires_at, request_payload, quote_snapshot, totals, metadata, created_at, updated_at
) VALUES (
  '5b500000-0000-0000-0000-000000000001', 'c5000000-0000-0000-0000-000000000001',
  'a5000000-0000-0000-0000-000000000001', 'update_addon_quantity', repeat('b', 64), 1,
  '2026-07-10T10:30:00Z'::timestamptz,
  jsonb_build_object('action', 'update_addon_quantity', 'variantId', '55555000-0000-0000-0000-000000000003', 'qty', 2),
  jsonb_build_object('repricedLines', jsonb_build_array(jsonb_build_object(
    'lineId', '51500000-0000-0000-0000-000000000002',
    'quoteLine', jsonb_build_object('sku', 'GUARD-ADDON', 'quantity', 2)
  ))),
  '{}'::jsonb,
  '{"source":"pgtap"}'::jsonb, '2026-07-10T09:55:00Z'::timestamptz, '2026-07-10T09:55:00Z'::timestamptz
);

SELECT public.customer_self_service_apply_subscription_action(
  'a5000000-0000-0000-0000-000000000001', 'guard-qty-valid', '5b500000-0000-0000-0000-000000000001', 'update_addon_quantity',
  jsonb_build_object(
    'acceptedQuoteHash', repeat('b', 64),
    'expectedTemplateVersion', 1,
    'variantId', '55555000-0000-0000-0000-000000000003',
    'qty', 2,
    'repricedLines', jsonb_build_array(jsonb_build_object('lineId', '51500000-0000-0000-0000-000000000002', 'quoteLine', jsonb_build_object('sku', 'GUARD-ADDON', 'quantity', 2)))
  ),
  '2026-07-10T10:00:00Z'::timestamptz);

SELECT is((SELECT qty FROM public.subscription_lines WHERE id = '51500000-0000-0000-0000-000000000002'),
  2, 'RPC guard: valid BFF-shaped addon edit still applies');
SELECT is((SELECT template_version FROM public.subscriptions WHERE id = '5b500000-0000-0000-0000-000000000001'),
  2, 'RPC guard: valid addon edit increments template version');

SELECT throws_ok(
  $q$ SELECT public.customer_self_service_apply_subscription_action(
    'a5000000-0000-0000-0000-000000000001', 'guard-order-no-confirm', '5b500000-0000-0000-0000-000000000001', 'order_now',
    '{}'::jsonb,
    '2026-07-10T10:00:00Z'::timestamptz) $q$,
  'customer_self_service_charge_timing_not_confirmed',
  'RPC guard: order_now requires explicit charge timing confirmation');

SELECT public.customer_self_service_apply_subscription_action(
  'a5000000-0000-0000-0000-000000000001', 'guard-order-confirmed', '5b500000-0000-0000-0000-000000000001', 'order_now',
  '{"confirmedChargeTiming":true}'::jsonb,
  '2026-07-10T10:00:00Z'::timestamptz);

SELECT is((SELECT next_cycle_at FROM public.subscriptions WHERE id = '5b500000-0000-0000-0000-000000000001'),
  '2026-07-10T10:05:00Z'::timestamptz, 'RPC guard: confirmed order_now still soft-advances next cycle');

SELECT throws_ok(
  $q$ SELECT public.customer_self_service_apply_subscription_action(
    'a5000000-0000-0000-0000-000000000001', 'guard-reactivate-no-confirm', '5b500000-0000-0000-0000-000000000002', 'reactivate',
    '{}'::jsonb,
    '2026-07-10T10:00:00Z'::timestamptz) $q$,
  'customer_self_service_charge_timing_not_confirmed',
  'RPC guard: reactivate requires explicit charge timing confirmation');

SELECT * FROM finish();
ROLLBACK;
