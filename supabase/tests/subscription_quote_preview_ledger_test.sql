-- pgTAP: Self-service quote-preview ledger.
--
-- Run via: supabase db reset && supabase test db

BEGIN;
SELECT plan(18);

SELECT has_table('public', 'subscription_quote_previews', 'Quote ledger: preview table exists');

INSERT INTO public.catalog_products (id, slug, name, status) VALUES
  ('44446000-0000-0000-0000-000000000001', 'ledger-base', 'Ledger Base', 'active'),
  ('44446000-0000-0000-0000-000000000002', 'ledger-addon', 'Ledger Addon', 'active');
INSERT INTO public.catalog_skus (id, product_id, sku, title, pet_type, net_weight_g, kcal_per_unit, status) VALUES
  ('55556000-0000-0000-0000-000000000001', '44446000-0000-0000-0000-000000000001', 'LEDGER-BASE', 'Base', 'dog', 400, 492, 'active'),
  ('55556000-0000-0000-0000-000000000002', '44446000-0000-0000-0000-000000000002', 'LEDGER-ADDON', 'Addon', 'dog', 80, 120, 'active');

INSERT INTO auth.users (id) VALUES
  ('a6000000-0000-0000-0000-000000000001'),
  ('a6000000-0000-0000-0000-000000000002');
INSERT INTO public.clients (id, email, auth_user_id) VALUES
  ('c6000000-0000-0000-0000-000000000001', 'ledger-1@example.invalid', 'a6000000-0000-0000-0000-000000000001'),
  ('c6000000-0000-0000-0000-000000000002', 'ledger-2@example.invalid', 'a6000000-0000-0000-0000-000000000002');

INSERT INTO public.subscriptions (id, client_id, cadence_days, currency, status, next_cycle_at, template_version, edit_window_hours, payment_method_ref, size_constraint)
VALUES
  ('5b600000-0000-0000-0000-000000000001', 'c6000000-0000-0000-0000-000000000001', 28, 'PLN', 'active',
   '2026-09-01T00:00:00Z', 1, 24, 'pm_ledger_1', '{"kind":"feeding_days","value":28}'::jsonb),
  ('5b600000-0000-0000-0000-000000000002', 'c6000000-0000-0000-0000-000000000002', 28, 'PLN', 'active',
   '2026-09-01T00:00:00Z', 1, 24, 'pm_ledger_2', '{"kind":"feeding_days","value":28}'::jsonb);

INSERT INTO public.subscription_lines (id, subscription_id, variant_id, qty, sort_order, is_addon, template_version, line_metadata) VALUES
  ('51600000-0000-0000-0000-000000000001', '5b600000-0000-0000-0000-000000000001', '55556000-0000-0000-0000-000000000001', 4, 1, false, 1, '{}'::jsonb),
  ('51600000-0000-0000-0000-000000000002', '5b600000-0000-0000-0000-000000000001', '55556000-0000-0000-0000-000000000002', 1, 2, true, 1, '{}'::jsonb),
  ('51600000-0000-0000-0000-000000000003', '5b600000-0000-0000-0000-000000000002', '55556000-0000-0000-0000-000000000001', 4, 1, false, 1, '{}'::jsonb),
  ('51600000-0000-0000-0000-000000000004', '5b600000-0000-0000-0000-000000000002', '55556000-0000-0000-0000-000000000002', 1, 2, true, 1, '{}'::jsonb);

SELECT throws_ok(
  $q$ SELECT public.customer_self_service_apply_subscription_action(
    'a6000000-0000-0000-0000-000000000001', 'ledger-no-row-1', '5b600000-0000-0000-0000-000000000001', 'update_addon_quantity',
    jsonb_build_object('acceptedQuoteHash', repeat('c', 64), 'expectedTemplateVersion', 1, 'variantId', '55556000-0000-0000-0000-000000000002', 'qty', 2),
    '2026-07-10T10:00:00Z'::timestamptz) $q$,
  'customer_self_service_quote_not_accepted',
  'Quote ledger: direct apply with a shaped but unrecorded hash fails closed');

SELECT public.customer_self_service_record_subscription_quote_preview(
  'a6000000-0000-0000-0000-000000000001',
  '5b600000-0000-0000-0000-000000000001',
  'update_addon_quantity',
  repeat('a', 64),
  1,
  '2026-07-10T10:30:00Z'::timestamptz,
  jsonb_build_object('action', 'update_addon_quantity', 'variantId', '55556000-0000-0000-0000-000000000002', 'qty', 2),
  jsonb_build_object('repricedLines', jsonb_build_array(jsonb_build_object(
    'lineId', '51600000-0000-0000-0000-000000000002',
    'quoteLine', jsonb_build_object('sku', 'LEDGER-ADDON', 'quantity', 2)
  ))),
  jsonb_build_object('newTotal', jsonb_build_object('amountMinor', 777, 'currency', 'PLN')),
  jsonb_build_object('source', 'pgtap'),
  '2026-07-10T09:55:00Z'::timestamptz
);

SELECT public.customer_self_service_record_subscription_quote_preview(
  'a6000000-0000-0000-0000-000000000001',
  '5b600000-0000-0000-0000-000000000001',
  'update_addon_quantity',
  repeat('a', 64),
  1,
  '2026-07-10T10:45:00Z'::timestamptz,
  jsonb_build_object('action', 'update_addon_quantity', 'variantId', '55556000-0000-0000-0000-000000000002', 'qty', 2, 'dedup', true),
  jsonb_build_object('repricedLines', jsonb_build_array(jsonb_build_object(
    'lineId', '51600000-0000-0000-0000-000000000002',
    'quoteLine', jsonb_build_object('sku', 'LEDGER-ADDON', 'quantity', 2)
  ))),
  jsonb_build_object('newTotal', jsonb_build_object('amountMinor', 888, 'currency', 'PLN')),
  jsonb_build_object('source', 'pgtap', 'dedup', true),
  '2026-07-10T10:05:00Z'::timestamptz
);

SELECT is((SELECT count(*)::integer FROM public.subscription_quote_previews WHERE quote_hash = repeat('a', 64)),
  1, 'Quote ledger: repeated preview for the same quote deduplicates to one open row');
SELECT is((SELECT expires_at FROM public.subscription_quote_previews WHERE quote_hash = repeat('a', 64)),
  '2026-07-10T10:45:00Z'::timestamptz,
  'Quote ledger: repeated preview refreshes the retained open row TTL');

SELECT is((SELECT status FROM public.subscription_quote_previews WHERE quote_hash = repeat('a', 64)),
  'previewed', 'Quote ledger: preview RPC stores a previewed quote row');

INSERT INTO public.subscription_quote_previews (
  subscription_id, client_id, created_by_auth_user_id, action, quote_hash, template_version,
  expires_at, request_payload, quote_snapshot, totals, metadata, created_at, updated_at
) VALUES (
  '5b600000-0000-0000-0000-000000000001', 'c6000000-0000-0000-0000-000000000001',
  'a6000000-0000-0000-0000-000000000001', 'update_addon_quantity', repeat('1', 64), 1,
  '2026-07-10T10:30:00Z'::timestamptz,
  jsonb_build_object('action', 'update_addon_quantity', 'variantId', '55556000-0000-0000-0000-000000000002', 'qty', 2),
  jsonb_build_object('repricedLines', jsonb_build_array(jsonb_build_object(
    'lineId', '51600000-0000-0000-0000-000000000002',
    'quoteLine', jsonb_build_object('sku', 'LEDGER-ADDON', 'quantity', 2)
  ))),
  '{}'::jsonb, '{"source":"pgtap"}'::jsonb,
  '2026-07-10T09:55:00Z'::timestamptz, '2026-07-10T09:55:00Z'::timestamptz
);

SELECT throws_ok(
  $q$ SELECT public.customer_self_service_apply_subscription_action(
    'a6000000-0000-0000-0000-000000000001', 'ledger-drift-qty-1', '5b600000-0000-0000-0000-000000000001', 'update_addon_quantity',
    jsonb_build_object(
      'acceptedQuoteHash', repeat('1', 64),
      'expectedTemplateVersion', 1,
      'variantId', '55556000-0000-0000-0000-000000000002',
      'qty', 3,
      'repricedLines', jsonb_build_array(jsonb_build_object('lineId', '51600000-0000-0000-0000-000000000002', 'quoteLine', jsonb_build_object('sku', 'LEDGER-ADDON', 'quantity', 2)))
    ),
    '2026-07-10T10:00:00Z'::timestamptz) $q$,
  'customer_self_service_quote_drift',
  'Quote ledger: accepted hash does not unlock a different addon quantity');
SELECT is((SELECT status FROM public.subscription_quote_previews WHERE quote_hash = repeat('1', 64)),
  'previewed', 'Quote ledger: drifted apply leaves the preview row reusable for the original payload');

SELECT public.customer_self_service_apply_subscription_action(
  'a6000000-0000-0000-0000-000000000001', 'ledger-apply-1', '5b600000-0000-0000-0000-000000000001', 'update_addon_quantity',
  jsonb_build_object(
    'acceptedQuoteHash', repeat('a', 64),
    'expectedTemplateVersion', 1,
    'variantId', '55556000-0000-0000-0000-000000000002',
    'qty', 2,
    'repricedLines', jsonb_build_array(jsonb_build_object('lineId', '51600000-0000-0000-0000-000000000002', 'quoteLine', jsonb_build_object('sku', 'LEDGER-ADDON', 'quantity', 2)))
  ),
  '2026-07-10T10:00:00Z'::timestamptz);

SELECT is((SELECT status FROM public.subscription_quote_previews WHERE quote_hash = repeat('a', 64)),
  'accepted', 'Quote ledger: matching apply atomically accepts the preview row');
SELECT ok((SELECT payload->>'quotePreviewId' IS NOT NULL FROM public.subscription_events WHERE idempotency_key = 'ledger-apply-1'),
  'Quote ledger: self-service event records quote preview id evidence');

INSERT INTO public.subscription_quote_previews (
  subscription_id, client_id, created_by_auth_user_id, action, quote_hash, template_version,
  expires_at, request_payload, quote_snapshot, totals, metadata, created_at, updated_at
) VALUES (
  '5b600000-0000-0000-0000-000000000001', 'c6000000-0000-0000-0000-000000000001',
  'a6000000-0000-0000-0000-000000000001', 'update_addon_quantity', repeat('2', 64), 2,
  '2026-07-10T10:30:00Z'::timestamptz,
  jsonb_build_object('action', 'update_addon_quantity', 'variantId', '55556000-0000-0000-0000-000000000002', 'qty', 3),
  jsonb_build_object('repricedLines', jsonb_build_array(jsonb_build_object(
    'lineId', '51600000-0000-0000-0000-000000000002',
    'quoteLine', jsonb_build_object('sku', 'LEDGER-ADDON', 'quantity', 3, 'unitPriceGross', jsonb_build_object('amountMinor', 777))
  ))),
  '{}'::jsonb, '{"source":"pgtap"}'::jsonb,
  '2026-07-10T09:55:00Z'::timestamptz, '2026-07-10T09:55:00Z'::timestamptz
);

SELECT throws_ok(
  $q$ SELECT public.customer_self_service_apply_subscription_action(
    'a6000000-0000-0000-0000-000000000001', 'ledger-drift-quote-line-1', '5b600000-0000-0000-0000-000000000001', 'update_addon_quantity',
    jsonb_build_object(
      'acceptedQuoteHash', repeat('2', 64),
      'expectedTemplateVersion', 2,
      'variantId', '55556000-0000-0000-0000-000000000002',
      'qty', 3,
      'repricedLines', jsonb_build_array(jsonb_build_object('lineId', '51600000-0000-0000-0000-000000000002', 'quoteLine', jsonb_build_object('sku', 'LEDGER-ADDON', 'quantity', 3, 'unitPriceGross', jsonb_build_object('amountMinor', 888))))
    ),
    '2026-07-10T10:00:00Z'::timestamptz) $q$,
  'customer_self_service_quote_drift',
  'Quote ledger: accepted hash does not unlock a different quoteLine snapshot');
SELECT is((SELECT qty FROM public.subscription_lines WHERE id = '51600000-0000-0000-0000-000000000002'),
  2, 'Quote ledger: quoteLine drift leaves the subscription line unchanged');

INSERT INTO public.subscription_quote_previews (
  subscription_id, client_id, created_by_auth_user_id, action, quote_hash, template_version,
  expires_at, request_payload, quote_snapshot, totals, metadata, created_at, updated_at
) VALUES (
  '5b600000-0000-0000-0000-000000000001', 'c6000000-0000-0000-0000-000000000001',
  'a6000000-0000-0000-0000-000000000001', 'update_addon_quantity', repeat('b', 64), 2,
  '2026-07-10T09:00:00Z'::timestamptz, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
  '{"source":"pgtap"}'::jsonb, '2026-07-10T08:55:00Z'::timestamptz, '2026-07-10T08:55:00Z'::timestamptz
);

SELECT throws_ok(
  $q$ SELECT public.customer_self_service_apply_subscription_action(
    'a6000000-0000-0000-0000-000000000001', 'ledger-expired-1', '5b600000-0000-0000-0000-000000000001', 'update_addon_quantity',
    jsonb_build_object('acceptedQuoteHash', repeat('b', 64), 'expectedTemplateVersion', 2, 'variantId', '55556000-0000-0000-0000-000000000002', 'qty', 3),
    '2026-07-10T10:00:00Z'::timestamptz) $q$,
  'customer_self_service_quote_expired',
  'Quote ledger: expired quote row is rejected before mutation');

INSERT INTO public.subscription_quote_previews (
  subscription_id, client_id, created_by_auth_user_id, action, quote_hash, template_version,
  expires_at, request_payload, quote_snapshot, totals, metadata, created_at, updated_at
) VALUES (
  '5b600000-0000-0000-0000-000000000001', 'c6000000-0000-0000-0000-000000000001',
  'a6000000-0000-0000-0000-000000000001', 'add_addon', repeat('d', 64), 2,
  '2026-07-10T10:30:00Z'::timestamptz, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
  '{"source":"pgtap"}'::jsonb, '2026-07-10T09:55:00Z'::timestamptz, '2026-07-10T09:55:00Z'::timestamptz
);

SELECT throws_ok(
  $q$ SELECT public.customer_self_service_apply_subscription_action(
    'a6000000-0000-0000-0000-000000000001', 'ledger-wrong-action-1', '5b600000-0000-0000-0000-000000000001', 'update_addon_quantity',
    jsonb_build_object('acceptedQuoteHash', repeat('d', 64), 'expectedTemplateVersion', 2, 'variantId', '55556000-0000-0000-0000-000000000002', 'qty', 3),
    '2026-07-10T10:00:00Z'::timestamptz) $q$,
  'customer_self_service_quote_not_accepted',
  'Quote ledger: quote recorded for a different action does not unlock apply');

INSERT INTO public.subscription_quote_previews (
  id, subscription_id, client_id, created_by_auth_user_id, action, quote_hash, template_version,
  expires_at, request_payload, quote_snapshot, totals, metadata, created_at, updated_at
) VALUES (
  '64600000-0000-0000-0000-000000000001',
  '5b600000-0000-0000-0000-000000000002', 'c6000000-0000-0000-0000-000000000002',
  'a6000000-0000-0000-0000-000000000002', 'update_addon_quantity', repeat('e', 64), 1,
  '2026-07-10T10:30:00Z'::timestamptz,
  jsonb_build_object('action', 'update_addon_quantity', 'variantId', '55556000-0000-0000-0000-000000000002', 'qty', 2),
  jsonb_build_object('repricedLines', jsonb_build_array(jsonb_build_object(
    'lineId', '51600000-0000-0000-0000-000000000004',
    'quoteLine', jsonb_build_object('sku', 'LEDGER-ADDON', 'quantity', 2)
  ))),
  '{}'::jsonb,
  '{"source":"pgtap"}'::jsonb, '2026-07-10T09:55:00Z'::timestamptz, '2026-07-10T09:55:00Z'::timestamptz
);

SELECT is(public.customer_self_service_accept_subscription_quote_preview(
    'a6000000-0000-0000-0000-000000000002', '5b600000-0000-0000-0000-000000000002',
    'update_addon_quantity', repeat('e', 64), 1, 'ledger-helper-idem', '2026-07-10T10:00:00Z'::timestamptz,
    jsonb_build_object(
      'variantId', '55556000-0000-0000-0000-000000000002',
      'qty', 2,
      'repricedLines', jsonb_build_array(jsonb_build_object('lineId', '51600000-0000-0000-0000-000000000004', 'quoteLine', jsonb_build_object('sku', 'LEDGER-ADDON', 'quantity', 2)))
    )
  )::text,
  '64600000-0000-0000-0000-000000000001',
  'Quote ledger: helper accepts a preview row for the first idempotency key');

SELECT is(public.customer_self_service_accept_subscription_quote_preview(
    'a6000000-0000-0000-0000-000000000002', '5b600000-0000-0000-0000-000000000002',
    'update_addon_quantity', repeat('e', 64), 1, 'ledger-helper-idem', '2026-07-10T10:00:00Z'::timestamptz,
    jsonb_build_object(
      'variantId', '55556000-0000-0000-0000-000000000002',
      'qty', 2,
      'repricedLines', jsonb_build_array(jsonb_build_object('lineId', '51600000-0000-0000-0000-000000000004', 'quoteLine', jsonb_build_object('sku', 'LEDGER-ADDON', 'quantity', 2)))
    )
  )::text,
  '64600000-0000-0000-0000-000000000001',
  'Quote ledger: helper replays the same idempotency key safely');

SELECT throws_ok(
  $q$ SELECT public.customer_self_service_accept_subscription_quote_preview(
    'a6000000-0000-0000-0000-000000000002', '5b600000-0000-0000-0000-000000000002',
    'update_addon_quantity', repeat('e', 64), 1, 'ledger-helper-other-idem', '2026-07-10T10:00:00Z'::timestamptz,
    jsonb_build_object(
      'variantId', '55556000-0000-0000-0000-000000000002',
      'qty', 2,
      'repricedLines', jsonb_build_array(jsonb_build_object('lineId', '51600000-0000-0000-0000-000000000004', 'quoteLine', jsonb_build_object('sku', 'LEDGER-ADDON', 'quantity', 2)))
    )
  ) $q$,
  'customer_self_service_quote_already_used',
  'Quote ledger: helper rejects reuse by a different idempotency key');

INSERT INTO public.subscription_quote_previews (
  subscription_id, client_id, created_by_auth_user_id, action, quote_hash, template_version,
  expires_at, request_payload, quote_snapshot, totals, metadata, created_at, updated_at
) VALUES (
  '5b600000-0000-0000-0000-000000000002', 'c6000000-0000-0000-0000-000000000002',
  'a6000000-0000-0000-0000-000000000002', 'update_addon_quantity', repeat('f', 64), 1,
  '2026-06-30T10:00:00Z'::timestamptz, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
  '{"source":"old-preview"}'::jsonb, '2026-06-30T09:55:00Z'::timestamptz, '2026-06-30T09:55:00Z'::timestamptz
), (
  '5b600000-0000-0000-0000-000000000002', 'c6000000-0000-0000-0000-000000000002',
  'a6000000-0000-0000-0000-000000000002', 'update_addon_quantity', repeat('0', 64), 1,
  '2026-06-30T10:00:00Z'::timestamptz, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
  '{"source":"accepted-audit"}'::jsonb, '2026-06-30T09:55:00Z'::timestamptz, '2026-06-30T09:55:00Z'::timestamptz
);
UPDATE public.subscription_quote_previews
   SET status = 'accepted',
       accepted_at = '2026-06-30T10:00:00Z'::timestamptz,
       accepted_idempotency_key = 'old-accepted'
 WHERE quote_hash = repeat('0', 64);

SELECT is(public.customer_self_service_prune_subscription_quote_previews(
    '7 days'::interval,
    100,
    '2026-07-10T10:00:00Z'::timestamptz
  ),
  1,
  'Quote ledger: prune deletes old unaccepted previews within the bounded limit');
SELECT is((SELECT count(*)::integer FROM public.subscription_quote_previews WHERE quote_hash IN (repeat('f', 64), repeat('0', 64))),
  1,
  'Quote ledger: prune retains accepted audit rows while removing old preview spam');

SELECT * FROM finish();
ROLLBACK;
