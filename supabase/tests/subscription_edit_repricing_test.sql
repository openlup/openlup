-- pgTAP: Self-service C3 — edit re-pricing locks fresh band prices on edit (20260612130000).
--   * swap_recipe writes the re-priced quoteLine onto the swapped line (keyed by subscription_lines.id),
--     preserving other line_metadata / productSnapshot fields (jsonb merge)
--   * add_addon writes the re-priced quoteLine onto the freshly-inserted line (NULL lineId -> RETURNING id),
--     even though its line_metadata started empty
--   * the edit branch now refuses to mutate a locked/in-flight upcoming cycle (cycle-lock fix)
--
-- The RPC stores the BFF-supplied quoteLine verbatim; real band pricing is the BFF's job, so these
-- fixtures use opaque quoteLine objects.
--
-- Run via: supabase db reset && supabase test db

BEGIN;
SELECT plan(9);

INSERT INTO public.catalog_products (id, slug, name, status) VALUES
  ('44440000-0000-0000-0000-000000000001', 'c3-lamb', 'Lamb', 'active'),
  ('44440000-0000-0000-0000-000000000002', 'c3-beef', 'Beef', 'active'),
  ('44440000-0000-0000-0000-000000000003', 'c3-salmon', 'Salmon', 'active');
INSERT INTO public.catalog_skus (id, product_id, sku, title, pet_type, net_weight_g, kcal_per_unit, status) VALUES
  ('55550000-0000-0000-0000-000000000001', '44440000-0000-0000-0000-000000000001', 'C3-LAMB', 'Lamb', 'dog', 400, 492, 'active'),
  ('55550000-0000-0000-0000-000000000002', '44440000-0000-0000-0000-000000000002', 'C3-BEEF', 'Beef', 'dog', 400, 492, 'active'),
  ('55550000-0000-0000-0000-000000000003', '44440000-0000-0000-0000-000000000003', 'C3-SALMON', 'Salmon', 'dog', 400, 492, 'active');

INSERT INTO auth.users (id) VALUES ('a0000000-0000-0000-0000-0000000000c3');
INSERT INTO public.clients (id, email, auth_user_id)
VALUES ('c0000000-0000-0000-0000-0000000000c3', 'c3@example.invalid', 'a0000000-0000-0000-0000-0000000000c3');

-- Active sub, far-future next cycle so the 24h edit window is open.
INSERT INTO public.subscriptions (id, client_id, cadence_days, currency, status, next_cycle_at, template_version, edit_window_hours, payment_method_ref)
VALUES ('5b000000-0000-0000-0000-0000000000c3', 'c0000000-0000-0000-0000-0000000000c3', 30, 'PLN', 'active',
        '2026-09-01T00:00:00Z', 1, 24, 'pm_test_c3');

-- Base line with an OLD frozen quoteLine + extra metadata to prove the merge preserves it.
INSERT INTO public.subscription_lines (id, subscription_id, variant_id, qty, sort_order, is_addon, template_version, line_metadata)
VALUES ('51110000-0000-0000-0000-0000000000c3', '5b000000-0000-0000-0000-0000000000c3',
        '55550000-0000-0000-0000-000000000001', 2, 1, false, 1,
        '{"toplevel":"keep","productSnapshot":{"other":"keep","quoteLine":{"sku":"C3-LAMB","quantity":2}}}'::jsonb);

CREATE OR REPLACE FUNCTION pg_temp.seed_subscription_quote_preview(
  p_action text,
  p_quote_hash text,
  p_template_version integer,
  p_request_payload jsonb,
  p_quote_snapshot jsonb
) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO public.subscription_quote_previews (
    subscription_id, client_id, created_by_auth_user_id, action, quote_hash, template_version,
    expires_at, request_payload, quote_snapshot, totals, metadata, created_at, updated_at
  ) VALUES (
    '5b000000-0000-0000-0000-0000000000c3', 'c0000000-0000-0000-0000-0000000000c3',
    'a0000000-0000-0000-0000-0000000000c3', p_action, p_quote_hash, p_template_version,
    '2026-06-12T00:30:00Z'::timestamptz, p_request_payload, p_quote_snapshot, '{}'::jsonb,
    '{"source":"pgtap"}'::jsonb, '2026-06-11T23:55:00Z'::timestamptz, '2026-06-11T23:55:00Z'::timestamptz
  )
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- ===== swap_recipe drift: accepted hash must not unlock a different target variant =====
SELECT pg_temp.seed_subscription_quote_preview(
  'swap_recipe',
  repeat('c', 64),
  1,
  jsonb_build_object(
    'action', 'swap_recipe',
    'fromVariantId', '55550000-0000-0000-0000-000000000001',
    'toVariantId', '55550000-0000-0000-0000-000000000002'
  ),
  jsonb_build_object('repricedLines', jsonb_build_array(jsonb_build_object(
    'lineId', '51110000-0000-0000-0000-0000000000c3',
    'quoteLine', jsonb_build_object('sku', 'C3-BEEF', 'quantity', 2, 'unitPriceGross', jsonb_build_object('amountMinor', 1340))
  )))
);
SELECT throws_ok(
  $q$ SELECT public.customer_self_service_apply_subscription_action(
    'a0000000-0000-0000-0000-0000000000c3', 'c3-swap-drift-1', '5b000000-0000-0000-0000-0000000000c3', 'swap_recipe',
    jsonb_build_object(
      'acceptedQuoteHash', repeat('c', 64),
      'expectedTemplateVersion', 1,
      'fromVariantId', '55550000-0000-0000-0000-000000000001',
      'toVariantId', '55550000-0000-0000-0000-000000000003',
      'repricedLines', jsonb_build_array(jsonb_build_object(
        'lineId', '51110000-0000-0000-0000-0000000000c3',
        'quoteLine', jsonb_build_object('sku', 'C3-BEEF', 'quantity', 2, 'unitPriceGross', jsonb_build_object('amountMinor', 1340))
      ))
    ),
    '2026-06-12T00:00:00Z'::timestamptz) $q$,
  'customer_self_service_quote_drift',
  'C3: swap_recipe quote hash rejects a tampered target variant');
SELECT is((SELECT variant_id::text FROM public.subscription_lines WHERE id='51110000-0000-0000-0000-0000000000c3'),
  '55550000-0000-0000-0000-000000000001', 'C3: swap_recipe drift leaves the original variant unchanged');

-- ===== swap_recipe lamb -> beef WITH the re-priced quoteLine =====
SELECT pg_temp.seed_subscription_quote_preview(
  'swap_recipe',
  repeat('a', 64),
  1,
  jsonb_build_object(
    'action', 'swap_recipe',
    'fromVariantId', '55550000-0000-0000-0000-000000000001',
    'toVariantId', '55550000-0000-0000-0000-000000000002'
  ),
  jsonb_build_object('repricedLines', jsonb_build_array(jsonb_build_object(
    'lineId', '51110000-0000-0000-0000-0000000000c3',
    'quoteLine', jsonb_build_object('sku', 'C3-BEEF', 'quantity', 2, 'unitPriceGross', jsonb_build_object('amountMinor', 1340))
  )))
);
SELECT public.customer_self_service_apply_subscription_action(
  'a0000000-0000-0000-0000-0000000000c3', 'c3-swap-idem-0001', '5b000000-0000-0000-0000-0000000000c3', 'swap_recipe',
  jsonb_build_object(
    'acceptedQuoteHash', repeat('a', 64),
    'expectedTemplateVersion', 1,
    'fromVariantId', '55550000-0000-0000-0000-000000000001',
    'toVariantId', '55550000-0000-0000-0000-000000000002',
    'repricedLines', jsonb_build_array(jsonb_build_object(
      'lineId', '51110000-0000-0000-0000-0000000000c3',
      'quoteLine', jsonb_build_object('sku', 'C3-BEEF', 'quantity', 2, 'unitPriceGross', jsonb_build_object('amountMinor', 1340))
    ))
  ),
  '2026-06-12T00:00:00Z'::timestamptz);

SELECT is((SELECT variant_id::text FROM public.subscription_lines WHERE id='51110000-0000-0000-0000-0000000000c3'),
  '55550000-0000-0000-0000-000000000002', 'C3: swap_recipe updated variant');
SELECT is((SELECT line_metadata #>> '{productSnapshot,quoteLine,sku}' FROM public.subscription_lines WHERE id='51110000-0000-0000-0000-0000000000c3'),
  'C3-BEEF', 'C3: swapped line quoteLine re-priced (locked at edit)');
SELECT is((SELECT line_metadata #>> '{productSnapshot,quoteLine,unitPriceGross,amountMinor}' FROM public.subscription_lines WHERE id='51110000-0000-0000-0000-0000000000c3'),
  '1340', 'C3: new band price locked onto the line');
SELECT is((SELECT line_metadata->>'toplevel' FROM public.subscription_lines WHERE id='51110000-0000-0000-0000-0000000000c3'),
  'keep', 'C3: merge preserved other top-level line_metadata');
SELECT is((SELECT line_metadata #>> '{productSnapshot,other}' FROM public.subscription_lines WHERE id='51110000-0000-0000-0000-0000000000c3'),
  'keep', 'C3: merge preserved other productSnapshot fields');

-- ===== add_addon with a NULL-lineId repriced entry (matched to the inserted line) =====
SELECT pg_temp.seed_subscription_quote_preview(
  'add_addon',
  repeat('b', 64),
  2,
  jsonb_build_object(
    'action', 'add_addon',
    'variantId', '55550000-0000-0000-0000-000000000003',
    'qty', 1
  ),
  jsonb_build_object('repricedLines', jsonb_build_array(jsonb_build_object(
    'lineId', NULL,
    'quoteLine', jsonb_build_object('sku', 'C3-SALMON', 'quantity', 1)
  )))
);
SELECT public.customer_self_service_apply_subscription_action(
  'a0000000-0000-0000-0000-0000000000c3', 'c3-add-idem-0001', '5b000000-0000-0000-0000-0000000000c3', 'add_addon',
  jsonb_build_object(
    'acceptedQuoteHash', repeat('b', 64),
    'expectedTemplateVersion', 2,
    'variantId', '55550000-0000-0000-0000-000000000003', 'qty', 1,
    'repricedLines', jsonb_build_array(jsonb_build_object('lineId', NULL, 'quoteLine', jsonb_build_object('sku', 'C3-SALMON', 'quantity', 1)))
  ),
  '2026-06-12T00:00:00Z'::timestamptz);

SELECT is((SELECT line_metadata #>> '{productSnapshot,quoteLine,sku}' FROM public.subscription_lines
            WHERE subscription_id='5b000000-0000-0000-0000-0000000000c3'
              AND variant_id='55550000-0000-0000-0000-000000000003' AND is_addon=true),
  'C3-SALMON', 'C3: new addon quoteLine written via RETURNING id (null lineId, empty start metadata)');

-- ===== edit-branch cycle-lock: edit blocked when the upcoming cycle is payment_pending =====
-- 'paid' (not 'payment_pending') so the fixture insert doesn't trip the payment-pending
-- template-snapshot guard; assert_no_locked_cycle matches 'paid' too.
INSERT INTO public.subscription_cycles (id, subscription_id, cycle_number, scheduled_at, status, paid_at, engine_idempotency_key)
VALUES ('5c000000-0000-0000-0000-0000000000c3', '5b000000-0000-0000-0000-0000000000c3', 2, '2026-09-01T00:00:00Z', 'paid', '2026-08-15T00:00:00Z', 'c3-cyc');
SELECT throws_ok(
  $q$ SELECT public.customer_self_service_apply_subscription_action(
    'a0000000-0000-0000-0000-0000000000c3', 'c3-blocked-idem-1', '5b000000-0000-0000-0000-0000000000c3', 'update_package',
    jsonb_build_object('sizeConstraint', jsonb_build_object('kind','feeding_days','value',21)),
    '2026-06-12T00:00:00Z'::timestamptz) $q$,
  'customer_self_service_payment_blocked',
  'C3: edit branch now refuses a locked/in-flight upcoming cycle');

SELECT * FROM finish();
ROLLBACK;
