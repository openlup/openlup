-- pgTAP: subscription.package_changed no-op saves do not emit a customer email,
-- while a real package edit still follows the legacy true-positive path.

BEGIN;
SELECT plan(8);

INSERT INTO public.catalog_products (id, slug, name, status) VALUES
  ('6a100000-0000-0000-0000-000000000001', 'noop-base', 'Noop Base', 'active'),
  ('6a100000-0000-0000-0000-000000000002', 'noop-addon', 'Noop Addon', 'active');

INSERT INTO public.catalog_skus (id, product_id, sku, title, pet_type, net_weight_g, kcal_per_unit, status) VALUES
  ('6a200000-0000-0000-0000-000000000001', '6a100000-0000-0000-0000-000000000001', 'NOOP-BASE', 'Base', 'dog', 400, 492, 'active'),
  ('6a200000-0000-0000-0000-000000000002', '6a100000-0000-0000-0000-000000000002', 'NOOP-ADDON', 'Addon', 'dog', 80, 120, 'active');

INSERT INTO auth.users (id) VALUES ('6a300000-0000-0000-0000-000000000001');

INSERT INTO public.clients (id, email, auth_user_id)
VALUES ('6a400000-0000-0000-0000-000000000001', 'package-noop@example.invalid', '6a300000-0000-0000-0000-000000000001');

INSERT INTO public.subscriptions (
  id, client_id, cadence_days, currency, status, next_cycle_at,
  template_version, edit_window_hours, payment_method_ref, size_constraint
) VALUES (
  '6a500000-0000-0000-0000-000000000001',
  '6a400000-0000-0000-0000-000000000001',
  28, 'PLN', 'active', '2026-09-01T00:00:00Z',
  1, 24, 'pm_package_noop', '{"kind":"feeding_days","value":28,"mode":"full","portionFactor":1}'::jsonb
);

INSERT INTO public.subscription_lines (
  id, subscription_id, variant_id, qty, sort_order, is_addon, template_version, line_metadata
) VALUES
  ('6a600000-0000-0000-0000-000000000001', '6a500000-0000-0000-0000-000000000001', '6a200000-0000-0000-0000-000000000001', 4, 1, false, 1, '{}'::jsonb),
  ('6a600000-0000-0000-0000-000000000002', '6a500000-0000-0000-0000-000000000001', '6a200000-0000-0000-0000-000000000002', 1, 2, true, 1, '{}'::jsonb);

SELECT is(
  public.customer_self_service_apply_subscription_action(
    '6a300000-0000-0000-0000-000000000001',
    'package-noop-qty',
    '6a500000-0000-0000-0000-000000000001',
    'update_addon_quantity',
    jsonb_build_object(
      'acceptedQuoteHash', repeat('c', 64),
      'expectedTemplateVersion', 1,
      'variantId', '6a200000-0000-0000-0000-000000000002',
      'qty', 1,
      'repricedLines', jsonb_build_array(jsonb_build_object('lineId', '6a600000-0000-0000-0000-000000000002', 'quoteLine', jsonb_build_object('sku', 'NOOP-ADDON', 'quantity', 1)))
    ),
    '2026-07-10T10:00:00Z'::timestamptz
  ) #>> '{subscriptionAction,status}',
  'noop',
  'semantic no-op package edit returns a noop response'
);

SELECT is((SELECT template_version FROM public.subscriptions WHERE id = '6a500000-0000-0000-0000-000000000001'),
  1, 'semantic no-op does not bump template_version');

SELECT is((SELECT count(*)::int FROM public.subscription_events WHERE idempotency_key = 'package-noop-qty'),
  0, 'semantic no-op does not write a subscription event');

SELECT is((SELECT count(*)::int FROM public.outbox_events WHERE event_type = 'subscription.package_changed'),
  0, 'semantic no-op does not emit package_changed outbox email');

INSERT INTO public.subscription_quote_previews (
  subscription_id, client_id, created_by_auth_user_id, action, quote_hash, template_version,
  expires_at, request_payload, quote_snapshot, totals, metadata, created_at, updated_at
) VALUES (
  '6a500000-0000-0000-0000-000000000001',
  '6a400000-0000-0000-0000-000000000001',
  '6a300000-0000-0000-0000-000000000001',
  'update_addon_quantity',
  repeat('d', 64),
  1,
  '2026-07-10T11:00:00Z'::timestamptz,
  jsonb_build_object(
    'variantId', '6a200000-0000-0000-0000-000000000002',
    'qty', 2
  ),
  jsonb_build_object(
    'repricedLines',
    jsonb_build_array(jsonb_build_object(
      'lineId', '6a600000-0000-0000-0000-000000000002',
      'quoteLine', jsonb_build_object('sku', 'NOOP-ADDON', 'quantity', 2)
    ))
  ),
  '{}'::jsonb,
  '{"source":"pgtap"}'::jsonb,
  '2026-07-10T09:55:00Z'::timestamptz,
  '2026-07-10T09:55:00Z'::timestamptz
);

SELECT is(
  public.customer_self_service_apply_subscription_action(
    '6a300000-0000-0000-0000-000000000001',
    'package-real-qty',
    '6a500000-0000-0000-0000-000000000001',
    'update_addon_quantity',
    jsonb_build_object(
      'acceptedQuoteHash', repeat('d', 64),
      'expectedTemplateVersion', 1,
      'variantId', '6a200000-0000-0000-0000-000000000002',
      'qty', 2,
      'repricedLines', jsonb_build_array(jsonb_build_object('lineId', '6a600000-0000-0000-0000-000000000002', 'quoteLine', jsonb_build_object('sku', 'NOOP-ADDON', 'quantity', 2)))
    ),
    '2026-07-10T10:05:00Z'::timestamptz
  ) #>> '{subscriptionAction,status}',
  'applied',
  'real package edit still applies through the legacy mutation path'
);

SELECT is((SELECT qty FROM public.subscription_lines WHERE id = '6a600000-0000-0000-0000-000000000002'),
  2, 'real package edit updates the addon quantity');

SELECT is((SELECT count(*)::int FROM public.subscription_events WHERE idempotency_key = 'package-real-qty'),
  1, 'real package edit writes one subscription event');

SELECT is((SELECT count(*)::int FROM public.outbox_events WHERE event_type = 'subscription.package_changed'),
  1, 'real package edit emits one package_changed email event');

SELECT * FROM finish();
ROLLBACK;
