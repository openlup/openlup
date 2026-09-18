-- pgTAP: Subscription self-service 2.0 durable pause windows + price agreements.
--
-- Run via: supabase db reset && supabase test db

BEGIN;
SELECT plan(13);

SELECT has_table('public', 'subscription_price_agreements', 'SS2: price agreement table exists');
SELECT has_table('public', 'subscription_pause_windows', 'SS2: pause window table exists');

INSERT INTO public.catalog_products (id, slug, name, status) VALUES
  ('44442000-0000-0000-0000-000000000001', 'ss2-base', 'SS2 Base', 'active'),
  ('44442000-0000-0000-0000-000000000002', 'ss2-addon', 'SS2 Addon', 'active');
INSERT INTO public.catalog_skus (id, product_id, sku, title, pet_type, net_weight_g, kcal_per_unit, status) VALUES
  ('55552000-0000-0000-0000-000000000001', '44442000-0000-0000-0000-000000000001', 'SS2-BASE', 'Base', 'dog', 400, 492, 'active'),
  ('55552000-0000-0000-0000-000000000002', '44442000-0000-0000-0000-000000000002', 'SS2-ADDON', 'Addon', 'dog', 80, 120, 'active');

INSERT INTO auth.users (id) VALUES ('a2000000-0000-0000-0000-000000000001');
INSERT INTO public.clients (id, email, auth_user_id)
VALUES ('c2000000-0000-0000-0000-000000000001', 'ss2@example.invalid', 'a2000000-0000-0000-0000-000000000001');

INSERT INTO public.subscriptions (id, client_id, cadence_days, currency, status, started_at, next_cycle_at, template_version, edit_window_hours, payment_method_ref, size_constraint)
VALUES ('5b200000-0000-0000-0000-000000000001', 'c2000000-0000-0000-0000-000000000001', 28, 'PLN', 'active',
        '2026-06-01T00:00:00Z', '2026-09-01T00:00:00Z', 1, 24, 'pm_test_ss2', '{"kind":"feeding_days","value":28}'::jsonb);
INSERT INTO public.subscription_lines (id, subscription_id, variant_id, qty, sort_order, is_addon, template_version, line_metadata) VALUES
  ('51200000-0000-0000-0000-000000000001', '5b200000-0000-0000-0000-000000000001', '55552000-0000-0000-0000-000000000001', 8, 1, false, 1, '{}'::jsonb),
  ('51200000-0000-0000-0000-000000000002', '5b200000-0000-0000-0000-000000000001', '55552000-0000-0000-0000-000000000002', 1, 2, true, 1, '{}'::jsonb);

SELECT public.customer_self_service_apply_subscription_action(
  'a2000000-0000-0000-0000-000000000001', 'ss2-pause-idem-1', '5b200000-0000-0000-0000-000000000001', 'pause',
  '{"pausePreset":"2_weeks","reason":"vacation"}'::jsonb,
  '2026-06-16T10:00:00Z'::timestamptz);

SELECT is((SELECT pause_preset FROM public.subscription_pause_windows WHERE idempotency_key='ss2-pause-idem-1'),
  '2_weeks', 'SS2: timed pause records its preset');
SELECT is((SELECT ends_at FROM public.subscription_pause_windows WHERE idempotency_key='ss2-pause-idem-1'),
  '2026-06-30T10:00:00Z'::timestamptz, 'SS2: two-week pause records an end timestamp');

SELECT public.customer_self_service_apply_subscription_action(
  'a2000000-0000-0000-0000-000000000001', 'ss2-resume-idem-1', '5b200000-0000-0000-0000-000000000001', 'resume',
  '{}'::jsonb, '2026-06-20T10:00:00Z'::timestamptz);

SELECT ok((SELECT resumed_at IS NOT NULL FROM public.subscription_pause_windows WHERE idempotency_key='ss2-pause-idem-1'),
  'SS2: resume closes the open pause window');

INSERT INTO public.subscription_quote_previews (
  subscription_id, client_id, created_by_auth_user_id, action, quote_hash, template_version,
  expires_at, request_payload, quote_snapshot, totals, metadata, created_at, updated_at
) VALUES (
  '5b200000-0000-0000-0000-000000000001', 'c2000000-0000-0000-0000-000000000001',
  'a2000000-0000-0000-0000-000000000001', 'update_addon_quantity', repeat('a', 64), 1,
  '2026-06-21T10:30:00Z'::timestamptz,
  jsonb_build_object('action', 'update_addon_quantity', 'variantId', '55552000-0000-0000-0000-000000000002', 'qty', 3),
  jsonb_build_object('repricedLines', jsonb_build_array(jsonb_build_object(
    'lineId', '51200000-0000-0000-0000-000000000002',
    'quoteLine', jsonb_build_object('sku','SS2-ADDON','quantity',3,'unitPriceGross',jsonb_build_object('amountMinor',777))
  ))),
  '{}'::jsonb,
  '{"source":"pgtap"}'::jsonb, '2026-06-21T09:55:00Z'::timestamptz, '2026-06-21T09:55:00Z'::timestamptz
);

SELECT public.customer_self_service_apply_subscription_action(
  'a2000000-0000-0000-0000-000000000001', 'ss2-addon-idem-1', '5b200000-0000-0000-0000-000000000001', 'update_addon_quantity',
  jsonb_build_object(
    'acceptedQuoteHash', repeat('a', 64),
    'expectedTemplateVersion', 1,
    'variantId', '55552000-0000-0000-0000-000000000002',
    'qty', 3,
    'repricedLines', jsonb_build_array(jsonb_build_object(
      'lineId', '51200000-0000-0000-0000-000000000002',
      'quoteLine', jsonb_build_object('sku','SS2-ADDON','quantity',3,'unitPriceGross',jsonb_build_object('amountMinor',777))
    ))
  ),
  '2026-06-21T10:00:00Z'::timestamptz);

SELECT is((SELECT qty FROM public.subscription_lines WHERE id='51200000-0000-0000-0000-000000000002'),
  3, 'SS2: update_addon_quantity changes only the addon quantity');
SELECT is((SELECT agreement_kind FROM public.subscription_price_agreements WHERE idempotency_key='ss2-addon-idem-1'),
  'lock_until_edit', 'SS2: addon quantity edit records lock-until-edit agreement');
SELECT is((SELECT proration_policy FROM public.subscription_price_agreements WHERE idempotency_key='ss2-addon-idem-1'),
  'none', 'SS2: price agreement records no mid-cycle proration');
SELECT is((SELECT cycle_effect FROM public.subscription_price_agreements WHERE idempotency_key='ss2-addon-idem-1'),
  'future_unlocked_cycles_only', 'SS2: price agreement is future-cycle-only');
SELECT is((SELECT unit_price_gross_minor FROM public.subscription_price_agreements WHERE idempotency_key='ss2-addon-idem-1'),
  777, 'SS2: price agreement captures the repriced unit amount');

SELECT throws_ok(
  $q$ SELECT public.customer_self_service_apply_subscription_action(
    'a2000000-0000-0000-0000-000000000001', 'ss2-cadence-idem-1', '5b200000-0000-0000-0000-000000000001', 'update_cadence',
    '{"cadenceDays":21}'::jsonb, '2026-06-21T10:00:00Z'::timestamptz) $q$,
  'customer_self_service_unsupported_action',
  'SS2: legacy update_cadence fails closed');

SELECT public.customer_self_service_apply_subscription_action(
  'a2000000-0000-0000-0000-000000000001', 'ss2-cancel-idem-1', '5b200000-0000-0000-0000-000000000001', 'cancel',
  jsonb_build_object(
    'survey', jsonb_build_object('reasonCode', 'delivery_issue', 'comment', 'too late'),
    'saveOffer', jsonb_build_object('offerId', 'save-support', 'kind', 'support_callback', 'accepted', false)
  ),
  '2026-06-22T10:00:00Z'::timestamptz);

SELECT is((SELECT cancellation_reason FROM public.subscriptions WHERE id='5b200000-0000-0000-0000-000000000001'),
  'delivery_issue', 'SS2: structured cancel maps the survey reason onto the subscription');
SELECT is((SELECT payload #>> '{payload,saveOffer,offerId}' FROM public.subscription_events WHERE idempotency_key='ss2-cancel-idem-1'),
  'save-support', 'SS2: structured cancel keeps save-offer evidence in the audit payload');

SELECT * FROM finish();
ROLLBACK;
