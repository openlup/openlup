-- pgTAP: the watchdog probe view for active subscriptions with zero lines.
--
-- Pins public.subscription_zero_line_active (20260801130000), the detector
-- behind the p1 `subscription_active_zero_lines` alert.
--
-- Why this file exists at all: the view predicate IS the detector. A predicate
-- that is one word wrong returns nothing forever, and "nothing" is exactly what
-- a healthy estate looks like, so the alert would read green while blind. A
-- fresh-DB apply only proves the view compiles; these cases prove it selects.
--
-- The positive case is INSERTed with status='active' directly rather than
-- transitioned into it. That is deliberate and is the whole point of the probe:
-- trg_subscription_guard_active_requires_lines (20260801120100) is BEFORE
-- UPDATE OF status, so an UPDATE into this state is rejected and could not
-- build the fixture. A direct INSERT is precisely the door the trigger cannot
-- close -- service-role writers and ops SQL -- and therefore the state the view
-- has to catch.
--
-- Run via the repo's local pgTAP lane: npm run test:db:local (fresh apply).

BEGIN;
SELECT plan(9);

SELECT has_view(
  'public', 'subscription_zero_line_active',
  'zero-line probe: the view exists');

-- Browser roles must never read it; the watchdog evidence port is service_role.
SELECT ok(
  NOT has_table_privilege('anon', 'public.subscription_zero_line_active', 'SELECT')
  AND NOT has_table_privilege('authenticated', 'public.subscription_zero_line_active', 'SELECT'),
  'zero-line probe: anon and authenticated cannot read the view');
SELECT ok(
  has_table_privilege('service_role', 'public.subscription_zero_line_active', 'SELECT'),
  'zero-line probe: service_role can read the view');

-- ---- Fixture --------------------------------------------------------------
INSERT INTO public.clients (id, email) VALUES
  ('c1000000-0000-0000-0000-000000000001', 'zerolineprobe-bypassed@example.invalid'),
  ('c1000000-0000-0000-0000-000000000002', 'zerolineprobe-healthy@example.invalid'),
  ('c1000000-0000-0000-0000-000000000003', 'zerolineprobe-paused@example.invalid'),
  ('c1000000-0000-0000-0000-000000000004', 'zerolineprobe-stripped@example.invalid');

INSERT INTO public.catalog_products (id, slug, name, status)
VALUES ('c1300000-0000-0000-0000-000000000001', 'zerolineprobe-product', 'Zeroline Probe Product', 'active');

-- The species column is NOT NULL and CHECK-constrained; 'other' satisfies it
-- without spending a species literal the neutrality ratchet counts. The two
-- weight/energy columns were SET NOT NULL by 20260603124032 and 20260603133359;
-- their values are arbitrary, this fixture never reads them.
INSERT INTO public.catalog_skus (id, product_id, sku, title, pet_type, status, net_weight_g, kcal_per_unit)
VALUES ('c1400000-0000-0000-0000-000000000001', 'c1300000-0000-0000-0000-000000000001',
        'ZEROLINEPROBE-SKU-1', 'Zeroline Probe SKU 1', 'other', 'active', 400, 350);

-- The four rows differ only in id, owner, and status, so cadence, currency,
-- cycle date and template version are written once rather than four times. The
-- fixture never reads any of them.
INSERT INTO public.subscriptions (
  id, client_id, cadence_days, currency, status, next_cycle_at, template_version
)
SELECT seed.id, seed.client_id, 28, 'PLN', seed.status, '2026-06-01T00:00:00Z'::timestamptz, 1
FROM (VALUES
  -- (1) the guard bypass: active, no lines, written by a direct INSERT.
  ('c2000000-0000-0000-0000-000000000001'::uuid, 'c1000000-0000-0000-0000-000000000001'::uuid, 'active'),
  -- (2) healthy: active and line-bearing.
  ('c2000000-0000-0000-0000-000000000002'::uuid, 'c1000000-0000-0000-0000-000000000002'::uuid, 'active'),
  -- (3) out of scope by design: paused with no lines.
  ('c2000000-0000-0000-0000-000000000003'::uuid, 'c1000000-0000-0000-0000-000000000003'::uuid, 'paused'),
  -- (4) second bypass door: activated legitimately, lines deleted afterwards.
  ('c2000000-0000-0000-0000-000000000004'::uuid, 'c1000000-0000-0000-0000-000000000004'::uuid, 'active')
) AS seed(id, client_id, status);

INSERT INTO public.subscription_lines (id, subscription_id, variant_id, qty, sort_order, is_addon, template_version)
VALUES
  ('c2100000-0000-0000-0000-000000000002', 'c2000000-0000-0000-0000-000000000002', 'c1400000-0000-0000-0000-000000000001', 2, 0, false, 1),
  ('c2100000-0000-0000-0000-000000000004', 'c2000000-0000-0000-0000-000000000004', 'c1400000-0000-0000-0000-000000000001', 1, 0, false, 1);

-- ---- The three required pins ---------------------------------------------
SELECT ok(
  EXISTS (SELECT 1 FROM public.subscription_zero_line_active
           WHERE subscription_id = 'c2000000-0000-0000-0000-000000000001'),
  'zero-line probe: an INSERTed active zero-line subscription IS detected');

SELECT ok(
  NOT EXISTS (SELECT 1 FROM public.subscription_zero_line_active
               WHERE subscription_id = 'c2000000-0000-0000-0000-000000000002'),
  'zero-line probe: an active subscription WITH lines is not detected');

-- Active-only is a scope decision, not an oversight: paused zero-line rows are
-- inert (20260801120000 makes auto-resume skip them) and staging carries dozens
-- as fixture debris. Pinned so widening the predicate later is a conscious act.
SELECT ok(
  NOT EXISTS (SELECT 1 FROM public.subscription_zero_line_active
               WHERE subscription_id = 'c2000000-0000-0000-0000-000000000003'),
  'zero-line probe: a paused zero-line subscription is not detected');

-- ---- Second bypass door: lines removed from an already-active row ---------
SELECT ok(
  NOT EXISTS (SELECT 1 FROM public.subscription_zero_line_active
               WHERE subscription_id = 'c2000000-0000-0000-0000-000000000004'),
  'zero-line probe: a line-bearing active subscription starts undetected');

DELETE FROM public.subscription_lines
 WHERE subscription_id = 'c2000000-0000-0000-0000-000000000004';

SELECT ok(
  EXISTS (SELECT 1 FROM public.subscription_zero_line_active
           WHERE subscription_id = 'c2000000-0000-0000-0000-000000000004'),
  'zero-line probe: deleting every line of an active subscription IS detected');

-- The watchdog reads this view head-only, so the count is the alert payload.
SELECT is(
  (SELECT count(*)::int FROM public.subscription_zero_line_active
    WHERE client_id IN ('c1000000-0000-0000-0000-000000000001',
                        'c1000000-0000-0000-0000-000000000002',
                        'c1000000-0000-0000-0000-000000000003',
                        'c1000000-0000-0000-0000-000000000004')),
  2,
  'zero-line probe: exactly the two bypassed rows are counted');

SELECT * FROM finish();
ROLLBACK;
