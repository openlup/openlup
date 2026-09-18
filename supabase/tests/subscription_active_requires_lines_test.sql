-- pgTAP: an ACTIVE subscription must have at least one subscription_lines row.
--
-- Pins the two halves of the zero-line invariant:
--   * 20260801120000 — subscription_auto_resume_due skips a due, otherwise
--     eligible paused subscription that has no lines, and still resumes an
--     identical one that has them;
--   * 20260801120100 — trg_subscription_guard_active_requires_lines rejects any
--     UPDATE that moves a line-less subscription into 'active'
--     (paused -> active and pending_activation -> active), while leaving
--     line-bearing activations, non-status updates on an already-active row,
--     and both production creation paths untouched.
--
-- The creation-path cases are the load-bearing ones: the trigger is UPDATE-only
-- precisely because subscription_activate_from_paid_checkout_order INSERTs
-- status='active' before its own guarded line loop, so it must be driven end to
-- end here rather than reasoned about.
--
-- Run via: supabase db reset && supabase test db

BEGIN;
SELECT plan(18);

SELECT has_function(
  'public', 'subscription_guard_active_requires_lines',
  'zero-line guard: trigger function exists');

SELECT is(
  (SELECT count(*)::int
     FROM pg_trigger t
     JOIN pg_class c ON c.oid = t.tgrelid
    WHERE c.relname = 'subscriptions'
      AND t.tgname = 'trg_subscription_guard_active_requires_lines'
      AND NOT t.tgisinternal),
  1,
  'zero-line guard: trigger is attached to public.subscriptions');

-- ---- Shared catalog fixture ----------------------------------------------
INSERT INTO public.clients (id, email) VALUES
  ('b1000000-0000-0000-0000-000000000001', 'zeroline-lines@example.invalid'),
  ('b1000000-0000-0000-0000-000000000002', 'zeroline-nolines@example.invalid'),
  ('b1000000-0000-0000-0000-000000000003', 'zeroline-provisional@example.invalid'),
  ('b1000000-0000-0000-0000-000000000004', 'zeroline-creation@example.invalid');

INSERT INTO public.pets (id, client_id, pet_type, name)
VALUES ('b1100000-0000-0000-0000-000000000004', 'b1000000-0000-0000-0000-000000000004', 'dog', 'Zeroline');

INSERT INTO public.addresses (id, client_id, kind, line1, city, postal_code)
VALUES ('b1200000-0000-0000-0000-000000000004', 'b1000000-0000-0000-0000-000000000004', 'shipping', 'Testowa 1', 'Warszawa', '00-001');

INSERT INTO public.catalog_products (id, slug, name, status)
VALUES ('b1300000-0000-0000-0000-000000000001', 'zeroline-product', 'Zeroline Product', 'active');

INSERT INTO public.catalog_skus (id, product_id, sku, title, pet_type, status, net_weight_g, kcal_per_unit)
VALUES ('b1400000-0000-0000-0000-000000000001', 'b1300000-0000-0000-0000-000000000001', 'ZEROLINE-SKU-1', 'Zeroline SKU 1', 'dog', 'active', 400, 350);

-- ---- Auto-resume: two identical due pauses, one with lines, one without ---
INSERT INTO public.subscriptions (
  id, client_id, cadence_days, currency, status, next_cycle_at, template_version,
  payment_method_kind, payment_method_ref
) VALUES
  ('b2000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000001', 28, 'PLN', 'paused', '2026-06-01T00:00:00Z', 1, 'card', 'pm_zeroline_lines'),
  ('b2000000-0000-0000-0000-000000000002', 'b1000000-0000-0000-0000-000000000002', 28, 'PLN', 'paused', '2026-06-01T00:00:00Z', 1, 'card', 'pm_zeroline_nolines');

INSERT INTO public.subscription_lines (id, subscription_id, variant_id, qty, sort_order, is_addon, template_version)
VALUES ('b2100000-0000-0000-0000-000000000001', 'b2000000-0000-0000-0000-000000000001', 'b1400000-0000-0000-0000-000000000001', 2, 0, false, 1);

INSERT INTO public.subscription_pause_windows (
  id, subscription_id, pause_preset, starts_at, ends_at, reason, idempotency_key
) VALUES
  ('b2200000-0000-0000-0000-000000000001', 'b2000000-0000-0000-0000-000000000001', '2_weeks', '2026-06-01T10:00:00Z', '2026-06-16T10:00:00Z', 'zeroline-with-lines', 'zeroline-with-lines-pause'),
  ('b2200000-0000-0000-0000-000000000002', 'b2000000-0000-0000-0000-000000000002', '2_weeks', '2026-06-01T10:00:00Z', '2026-06-16T10:00:00Z', 'zeroline-no-lines', 'zeroline-no-lines-pause');

CREATE TEMP TABLE _resume AS
SELECT public.subscription_auto_resume_due(100, '2026-06-16T10:00:00Z'::timestamptz) AS r;

SELECT is((SELECT r ->> 'resumed' FROM _resume), '1', 'auto-resume: exactly one of the two due pauses resumes');
SELECT is((SELECT r ->> 'skipped' FROM _resume), '1', 'auto-resume: the line-less pause is a graceful skip');
SELECT is((SELECT r ->> 'failed' FROM _resume), '0', 'auto-resume: the skip is not counted as a failure');
SELECT is((SELECT r ->> 'ok' FROM _resume), 'true', 'auto-resume: a line-less subscription does not turn the job red');

SELECT is(
  (SELECT status FROM public.subscriptions WHERE id = 'b2000000-0000-0000-0000-000000000001'),
  'active',
  'auto-resume: a due pause WITH lines still resumes');
SELECT is(
  (SELECT status FROM public.subscriptions WHERE id = 'b2000000-0000-0000-0000-000000000002'),
  'paused',
  'auto-resume: a due pause WITHOUT lines stays paused');
SELECT is(
  (SELECT resumed_at FROM public.subscription_pause_windows WHERE id = 'b2200000-0000-0000-0000-000000000002'),
  NULL,
  'auto-resume: the skipped pause window stays open for remediation');

-- ---- Trigger: paused -> active ------------------------------------------
SELECT throws_ok(
  $$UPDATE public.subscriptions SET status = 'active' WHERE id = 'b2000000-0000-0000-0000-000000000002'$$,
  '22023',
  'subscription_active_requires_lines',
  'trigger: paused -> active with zero lines is rejected');

-- Same row, now with a line: the identical UPDATE succeeds.
INSERT INTO public.subscription_lines (id, subscription_id, variant_id, qty, sort_order, is_addon, template_version)
VALUES ('b2100000-0000-0000-0000-000000000002', 'b2000000-0000-0000-0000-000000000002', 'b1400000-0000-0000-0000-000000000001', 1, 0, false, 1);

UPDATE public.subscriptions SET status = 'active' WHERE id = 'b2000000-0000-0000-0000-000000000002';
SELECT is(
  (SELECT status FROM public.subscriptions WHERE id = 'b2000000-0000-0000-0000-000000000002'),
  'active',
  'trigger: paused -> active WITH lines succeeds');

-- ---- Trigger: an already-active row is untouched --------------------------
UPDATE public.subscriptions
   SET next_cycle_at = '2026-08-01T00:00:00Z', updated_at = now()
 WHERE id = 'b2000000-0000-0000-0000-000000000001';
SELECT is(
  (SELECT next_cycle_at FROM public.subscriptions WHERE id = 'b2000000-0000-0000-0000-000000000001'),
  '2026-08-01T00:00:00Z'::timestamptz,
  'trigger: a non-status update on an active subscription is unaffected');

-- Deleting every line of an ALREADY active subscription and re-writing
-- status='active' must not be rejected: the trigger fires on the transition
-- edge only, so it can never wedge an existing row.
DELETE FROM public.subscription_lines WHERE subscription_id = 'b2000000-0000-0000-0000-000000000001';
UPDATE public.subscriptions SET status = 'active' WHERE id = 'b2000000-0000-0000-0000-000000000001';
SELECT is(
  (SELECT status FROM public.subscriptions WHERE id = 'b2000000-0000-0000-0000-000000000001'),
  'active',
  'trigger: re-writing active -> active is not a guarded transition');

-- ---- Trigger: pending_activation -> active -------------------------------
INSERT INTO public.subscriptions (
  id, client_id, cadence_days, currency, status, next_cycle_at, template_version
) VALUES
  ('b2000000-0000-0000-0000-000000000003', 'b1000000-0000-0000-0000-000000000003', 28, 'PLN', 'pending_activation', '2026-06-01T00:00:00Z', 1);

SELECT throws_ok(
  $$UPDATE public.subscriptions SET status = 'active' WHERE id = 'b2000000-0000-0000-0000-000000000003'$$,
  '22023',
  'subscription_active_requires_lines',
  'trigger: pending_activation -> active with zero lines is rejected');

-- ---- Creation path A: provisional create + confirm ------------------------
INSERT INTO public.commerce_orders (id, client_id, pet_id, shipping_address_id, currency, region_code, size_constraint, status, metadata)
VALUES ('b3000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000004',
        'b1100000-0000-0000-0000-000000000004', 'b1200000-0000-0000-0000-000000000004',
        'PLN', 'PL', '{"kind":"feeding_days","value":21}'::jsonb, 'draft', '{}'::jsonb);
INSERT INTO public.commerce_order_items (id, order_id, sku_id, quantity, unit_price_cents, total_cents, discount_allocated_cents, effective_total_cents, effective_net_cents, product_snapshot)
VALUES ('b3100000-0000-0000-0000-000000000001', 'b3000000-0000-0000-0000-000000000001', 'b1400000-0000-0000-0000-000000000001',
        2, 1340, 2680, 0, 2680, round((2680)::numeric * 10000 / (10000 + 800))::integer, '{"sku":"ZEROLINE-SKU-1"}'::jsonb);

CREATE TEMP TABLE _prov AS
SELECT public.subscription_create_provisional_for_checkout(
  'b3000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000004',
  'b1100000-0000-0000-0000-000000000004', 'b1200000-0000-0000-0000-000000000004',
  '{"quote":{"context":{"mode":"subscription","cadenceDays":21}}}'::jsonb) AS r;

UPDATE public.commerce_orders
   SET mode = 'subscription_cycle', status = 'paid',
       subscription_id = (SELECT (r->>'subscriptionId')::uuid FROM _prov),
       subscription_cycle_id = (SELECT (r->>'subscriptionCycleId')::uuid FROM _prov)
 WHERE id = 'b3000000-0000-0000-0000-000000000001';

INSERT INTO public.commerce_payments (id, order_id, provider, amount_cents, currency, status)
VALUES ('b3200000-0000-0000-0000-000000000001', 'b3000000-0000-0000-0000-000000000001', 'stripe', 2680, 'PLN', 'succeeded');
INSERT INTO public.commerce_payment_intents (id, target_kind, order_id, subscription_id, subscription_cycle_id, payment_id, amount_cents, currency, status)
VALUES ('b3300000-0000-0000-0000-000000000001', 'subscription_cycle', 'b3000000-0000-0000-0000-000000000001',
        (SELECT (r->>'subscriptionId')::uuid FROM _prov), (SELECT (r->>'subscriptionCycleId')::uuid FROM _prov),
        'b3200000-0000-0000-0000-000000000001', 2680, 'PLN', 'succeeded');

SELECT is(
  (SELECT (public.subscription_confirm_provisional_from_paid_cycle(
     'zeroline-confirm-idem-key', 'b3000000-0000-0000-0000-000000000001', 'b3300000-0000-0000-0000-000000000001',
     'pm_zeroline_confirm', 'card', '2026-06-10T12:00:00Z'::timestamptz)) #>> '{subscriptionConfirmation,status}'),
  'active',
  'creation path: provisional create + confirm still activates through the trigger');

SELECT is(
  (SELECT status FROM public.subscriptions WHERE id = (SELECT (r->>'subscriptionId')::uuid FROM _prov)),
  'active',
  'creation path: the confirmed subscription is active');

-- ---- Creation path B: legacy paid-checkout activation (INSERT active) -----
INSERT INTO public.commerce_orders (id, client_id, pet_id, shipping_address_id, currency, region_code, size_constraint, status, metadata)
VALUES ('b4000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000004',
        'b1100000-0000-0000-0000-000000000004', 'b1200000-0000-0000-0000-000000000004',
        'PLN', 'PL', '{"kind":"feeding_days","value":21}'::jsonb, 'paid',
        '{"quoteSnapshot":{"quote":{"context":{"mode":"subscription","cadenceDays":21}}}}'::jsonb);
INSERT INTO public.commerce_order_items (id, order_id, sku_id, quantity, unit_price_cents, total_cents, discount_allocated_cents, effective_total_cents, effective_net_cents, product_snapshot)
VALUES ('b4100000-0000-0000-0000-000000000001', 'b4000000-0000-0000-0000-000000000001', 'b1400000-0000-0000-0000-000000000001',
        1, 1340, 1340, 0, 1340, round((1340)::numeric * 10000 / (10000 + 800))::integer, '{"sku":"ZEROLINE-SKU-1"}'::jsonb);
INSERT INTO public.commerce_payments (id, order_id, provider, amount_cents, currency, status)
VALUES ('b4200000-0000-0000-0000-000000000001', 'b4000000-0000-0000-0000-000000000001', 'tpay', 1340, 'PLN', 'succeeded');
INSERT INTO public.commerce_payment_intents (id, target_kind, order_id, payment_id, amount_cents, currency, status)
VALUES ('b4300000-0000-0000-0000-000000000001', 'one_time_order', 'b4000000-0000-0000-0000-000000000001',
        'b4200000-0000-0000-0000-000000000001', 1340, 'PLN', 'succeeded');

CREATE TEMP TABLE _legacy AS
SELECT public.subscription_activate_from_paid_checkout_order(
  'zeroline-legacy-idem-key', 'b4000000-0000-0000-0000-000000000001', 'b4300000-0000-0000-0000-000000000001',
  'pm_zeroline_legacy', 'blik', '2026-06-10T12:00:00Z'::timestamptz) AS r;

SELECT is(
  (SELECT status FROM public.subscriptions
    WHERE id = (SELECT (r #>> '{subscriptionActivation,subscriptionId}')::uuid FROM _legacy)),
  'active',
  'creation path: legacy paid-checkout activation still inserts an active subscription');

SELECT is(
  (SELECT count(*)::int FROM public.subscription_lines
    WHERE subscription_id = (SELECT (r #>> '{subscriptionActivation,subscriptionId}')::uuid FROM _legacy)),
  1,
  'creation path: legacy activation wrote its template line');

SELECT * FROM finish();
ROLLBACK;
