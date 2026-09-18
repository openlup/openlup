-- pgTAP: subscription_apply_starter_graduation turns an acquisition-terms
-- subscription into an ordinary steady one, exactly once, without ever
-- rewriting a package that has a live charge against it.
--
-- Pins 20260802140100:
--   * mode 'full' rewrites the non-addon template from the marker, preserves
--     addons, flips cadence to the steady value, bumps template_version on the
--     subscription AND its new lines, and records a price agreement plus one
--     subscription_events row;
--   * re-driving is a returned no-op, not an error and not a second rewrite --
--     the precondition self-falsifies, which is the whole idempotency design;
--   * an open payment_pending / retry_scheduled cycle RAISES instead;
--   * an unknown SKU RAISES instead of silently shrinking the order;
--   * mode 'cadence_only' moves cadence and nothing else;
--   * a subscription with no marker is a no-op in both modes.
--
-- The last two assertions are the PR 2365 compatibility pin: the renewal engine
-- re-parses line_metadata.productSnapshot.quoteLine and fails closed without
-- valid money on it, and the cycle-order RPC is handed exactly what
-- subscription_current_template_snapshot returns. Both are checked against the
-- POST-graduation rows, because that is the state the next renewal reads.
--
-- Fixtures are inserted directly (is_test_fixture stays false, the default):
-- the marker column is immutable on UPDATE but freely writable on INSERT, and
-- driving the acquisition RPC here would leave a payment_pending cycle #1 that
-- the open-cycle fence would then -- correctly -- refuse to graduate.
--
-- Run via: npm run test:db:local (the guarded local database lane)

BEGIN;
SELECT plan(26);

SELECT has_function(
  'public', 'subscription_apply_starter_graduation',
  'graduation: the RPC exists');

-- ---- Shared catalog fixture ----------------------------------------------
INSERT INTO public.clients (id, email) VALUES
  ('d1000000-0000-0000-0000-000000000001', 'grad-full@example.invalid'),
  ('d1000000-0000-0000-0000-000000000002', 'grad-open-cycle@example.invalid'),
  ('d1000000-0000-0000-0000-000000000003', 'grad-unknown-sku@example.invalid'),
  ('d1000000-0000-0000-0000-000000000004', 'grad-cadence-only@example.invalid'),
  ('d1000000-0000-0000-0000-000000000005', 'grad-no-marker@example.invalid');

INSERT INTO public.catalog_products (id, slug, name, status)
VALUES ('d1300000-0000-0000-0000-000000000001', 'grad-product', 'Graduation Product', 'active');

INSERT INTO public.catalog_skus (id, product_id, sku, title, pet_type, status, net_weight_g, kcal_per_unit) VALUES
  ('d1400000-0000-0000-0000-000000000001', 'd1300000-0000-0000-0000-000000000001', 'GRAD-ACQUISITION', 'Acquisition mix', 'dog', 'active', 400, 350),
  ('d1400000-0000-0000-0000-000000000002', 'd1300000-0000-0000-0000-000000000001', 'GRAD-STEADY', 'Steady mix', 'dog', 'active', 400, 350),
  ('d1400000-0000-0000-0000-000000000003', 'd1300000-0000-0000-0000-000000000001', 'GRAD-ADDON', 'Addon', 'dog', 'active', 100, 90);

-- The marker every fixture below carries: 17-day acquisition interval, steady
-- cadence 28, and a single graduated line at 8 x 1340 with its frozen quoteLine.
CREATE TEMP TABLE _marker AS SELECT '{
  "schemaVersion":"1",
  "starterIntervalDays":17,
  "basisTemplateVersion":1,
  "delivery2":{"discountBps":3500,"discountMinor":6566,"basisSubtotalMinor":18760},
  "graduation":{"cadenceDays":28,"sizeConstraint":{"kind":"feeding_days","value":28},
    "lines":[{"sku":"GRAD-STEADY","qty":8,"sortOrder":0,"isAddon":false,
      "quoteLine":{"sku":"GRAD-STEADY","productSlug":"grad-product","quantity":8,
        "unitPriceGross":{"amountMinor":1340,"currency":"PLN"},
        "lineSubtotalGross":{"amountMinor":10720,"currency":"PLN"},
        "tax":{"included":true,"country":"PL","category":"pet_food","vatRateBps":800,
          "legalBasis":"PL VAT Annex 3 item 10c",
          "netAmount":{"amountMinor":9926,"currency":"PLN"},
          "vatAmount":{"amountMinor":794,"currency":"PLN"},
          "grossAmount":{"amountMinor":10720,"currency":"PLN"}}}}]}}'::jsonb AS m;

INSERT INTO public.subscriptions (
  id, client_id, cadence_days, currency, region_code, status, next_cycle_at,
  template_version, payment_method_kind, payment_method_ref, size_constraint, starter_pack
)
SELECT * FROM (VALUES
  ('d2000000-0000-0000-0000-000000000001'::uuid, 'd1000000-0000-0000-0000-000000000001'::uuid, 17, 'PLN', 'PL', 'active', '2026-06-01T00:00:00Z'::timestamptz, 1, 'card', 'pm_grad_full', '{"kind":"feeding_days","value":14}'::jsonb),
  ('d2000000-0000-0000-0000-000000000002'::uuid, 'd1000000-0000-0000-0000-000000000002'::uuid, 17, 'PLN', 'PL', 'active', '2026-06-01T00:00:00Z'::timestamptz, 1, 'card', 'pm_grad_open', '{"kind":"feeding_days","value":14}'::jsonb),
  ('d2000000-0000-0000-0000-000000000004'::uuid, 'd1000000-0000-0000-0000-000000000004'::uuid, 17, 'PLN', 'PL', 'active', '2026-06-01T00:00:00Z'::timestamptz, 3, 'card', 'pm_grad_cadence', '{"kind":"feeding_days","value":14}'::jsonb)
) AS v, _marker;

INSERT INTO public.subscriptions (
  id, client_id, cadence_days, currency, region_code, status, next_cycle_at,
  template_version, payment_method_kind, payment_method_ref, starter_pack
)
SELECT 'd2000000-0000-0000-0000-000000000003', 'd1000000-0000-0000-0000-000000000003', 17, 'PLN', 'PL',
       'active', '2026-06-01T00:00:00Z', 1, 'card', 'pm_grad_unknown',
       jsonb_set(m, '{graduation,lines,0,sku}', '"GRAD-DOES-NOT-EXIST"'::jsonb)
  FROM _marker;

INSERT INTO public.subscriptions (
  id, client_id, cadence_days, currency, region_code, status, next_cycle_at,
  template_version, payment_method_kind, payment_method_ref
) VALUES
  ('d2000000-0000-0000-0000-000000000005', 'd1000000-0000-0000-0000-000000000005', 28, 'PLN', 'PL', 'active', '2026-06-01T00:00:00Z', 1, 'card', 'pm_grad_none');

INSERT INTO public.subscription_lines (id, subscription_id, variant_id, qty, sort_order, is_addon, template_version, line_metadata) VALUES
  ('d2100000-0000-0000-0000-000000000001', 'd2000000-0000-0000-0000-000000000001', 'd1400000-0000-0000-0000-000000000001', 14, 0, false, 1, '{"productSnapshot":{"quoteLine":{"sku":"GRAD-ACQUISITION"}}}'::jsonb),
  ('d2100000-0000-0000-0000-000000000002', 'd2000000-0000-0000-0000-000000000001', 'd1400000-0000-0000-0000-000000000003', 1, 1, true, 1, '{"productSnapshot":{"quoteLine":{"sku":"GRAD-ADDON"}}}'::jsonb),
  ('d2100000-0000-0000-0000-000000000003', 'd2000000-0000-0000-0000-000000000002', 'd1400000-0000-0000-0000-000000000001', 14, 0, false, 1, '{"productSnapshot":{"quoteLine":{"sku":"GRAD-ACQUISITION"}}}'::jsonb),
  ('d2100000-0000-0000-0000-000000000004', 'd2000000-0000-0000-0000-000000000003', 'd1400000-0000-0000-0000-000000000001', 14, 0, false, 1, '{"productSnapshot":{"quoteLine":{"sku":"GRAD-ACQUISITION"}}}'::jsonb),
  ('d2100000-0000-0000-0000-000000000005', 'd2000000-0000-0000-0000-000000000004', 'd1400000-0000-0000-0000-000000000001', 14, 0, false, 3, '{"productSnapshot":{"quoteLine":{"sku":"GRAD-ACQUISITION"}}}'::jsonb),
  ('d2100000-0000-0000-0000-000000000006', 'd2000000-0000-0000-0000-000000000005', 'd1400000-0000-0000-0000-000000000001', 14, 0, false, 1, '{"productSnapshot":{"quoteLine":{"sku":"GRAD-ACQUISITION"}}}'::jsonb);

-- ---- mode 'full' ---------------------------------------------------------
CREATE TEMP TABLE _full AS
SELECT public.subscription_apply_starter_graduation(
  'd2000000-0000-0000-0000-000000000001', 'grad-full-idem-key', 'full') AS r;

SELECT is((SELECT r #>> '{starterGraduation,applied}' FROM _full), 'true',
  'full: the graduation applied');
SELECT is((SELECT r #>> '{starterGraduation,reason}' FROM _full), 'graduated',
  'full: the reason names the graduation');

SELECT is(
  (SELECT cadence_days FROM public.subscriptions WHERE id = 'd2000000-0000-0000-0000-000000000001'),
  28,
  'full: cadence flips from the 17-day acquisition interval to the steady 28');
SELECT is(
  (SELECT template_version FROM public.subscriptions WHERE id = 'd2000000-0000-0000-0000-000000000001'),
  2,
  'full: the subscription template_version is bumped');
SELECT is(
  (SELECT size_constraint ->> 'value' FROM public.subscriptions WHERE id = 'd2000000-0000-0000-0000-000000000001'),
  '28',
  'full: the marker size constraint is applied');

SELECT is(
  (SELECT count(*)::int FROM public.subscription_lines sl
     JOIN public.catalog_skus cs ON cs.id = sl.variant_id
    WHERE sl.subscription_id = 'd2000000-0000-0000-0000-000000000001'
      AND sl.is_addon = false
      AND cs.sku = 'GRAD-STEADY'
      AND sl.qty = 8
      AND sl.template_version = 2),
  1,
  'full: the non-addon template is the marker line at the new template_version');
SELECT is(
  (SELECT count(*)::int FROM public.subscription_lines sl
     JOIN public.catalog_skus cs ON cs.id = sl.variant_id
    WHERE sl.subscription_id = 'd2000000-0000-0000-0000-000000000001'
      AND cs.sku = 'GRAD-ACQUISITION'),
  0,
  'full: the acquisition line is gone');
SELECT is(
  (SELECT count(*)::int FROM public.subscription_lines
    WHERE subscription_id = 'd2000000-0000-0000-0000-000000000001' AND is_addon = true),
  1,
  'full: the addon line is preserved');

SELECT is(
  (SELECT count(*)::int FROM public.subscription_price_agreements
    WHERE subscription_id = 'd2000000-0000-0000-0000-000000000001'
      AND source_action = 'starter_graduation'
      AND idempotency_key = 'grad-full-idem-key'
      AND unit_price_gross_minor = 1340
      AND template_version = 2),
  1,
  'full: one price agreement per graduated line, at the frozen unit price');
SELECT ok(
  (SELECT bool_and(event_id IS NOT NULL) FROM public.subscription_price_agreements
    WHERE subscription_id = 'd2000000-0000-0000-0000-000000000001'
      AND idempotency_key = 'grad-full-idem-key'),
  'full: the price agreement is back-filled with the event id');

SELECT is(
  (SELECT count(*)::int FROM public.subscription_events
    WHERE subscription_id = 'd2000000-0000-0000-0000-000000000001'
      AND event_type = 'subscription.starter_graduated'
      AND idempotency_key = 'grad-full-idem-key'),
  1,
  'full: exactly one graduation event is recorded');

-- PR 2365 compatibility: the renewal engine re-parses this frozen quoteLine and
-- fails closed without its money, so the graduated line must carry it.
SELECT is(
  (SELECT (line_metadata #>> '{productSnapshot,quoteLine,lineSubtotalGross,amountMinor}')::int
     FROM public.subscription_lines
    WHERE subscription_id = 'd2000000-0000-0000-0000-000000000001' AND is_addon = false),
  10720,
  'full: the graduated line carries a valid quoteLine.lineSubtotalGross.amountMinor');
SELECT is(
  (SELECT line_metadata ->> 'source' FROM public.subscription_lines
    WHERE subscription_id = 'd2000000-0000-0000-0000-000000000001' AND is_addon = false),
  'starter_graduation',
  'full: the graduated line records its provenance');

-- What the cycle-order RPC will be handed on the next renewal.
SELECT is(
  (public.subscription_current_template_snapshot('d2000000-0000-0000-0000-000000000001') ->> 'cadence_days')::int,
  28,
  'full: the canonical template snapshot reports the graduated cadence');
SELECT is(
  (SELECT count(*)::int
     FROM jsonb_array_elements(
       public.subscription_current_template_snapshot('d2000000-0000-0000-0000-000000000001') -> 'lines') AS line
    WHERE line ->> 'variant_id' = 'GRAD-STEADY' AND (line ->> 'qty')::int = 8),
  1,
  'full: the canonical template snapshot reports the graduated line');

-- ---- re-drive is a no-op --------------------------------------------------
CREATE TEMP TABLE _replay AS
SELECT public.subscription_apply_starter_graduation(
  'd2000000-0000-0000-0000-000000000001', 'grad-full-idem-key-2', 'full') AS r;

SELECT is((SELECT r #>> '{starterGraduation,applied}' FROM _replay), 'false',
  'replay: a second full graduation does not apply');
SELECT is((SELECT r #>> '{starterGraduation,reason}' FROM _replay), 'template_version_moved',
  'replay: the no-op names the self-falsified precondition');
SELECT is(
  (SELECT template_version FROM public.subscriptions WHERE id = 'd2000000-0000-0000-0000-000000000001'),
  2,
  'replay: the template_version does not move again');

-- ---- open payment cycle ---------------------------------------------------
INSERT INTO public.subscription_cycles (
  subscription_id, cycle_number, scheduled_at, status, template_version,
  template_snapshot, pricing_snapshot, engine_idempotency_key, retry_attempt
)
VALUES (
  'd2000000-0000-0000-0000-000000000002', 1, '2026-06-01T00:00:00Z', 'payment_pending', 1,
  public.subscription_current_template_snapshot('d2000000-0000-0000-0000-000000000002'),
  '{}'::jsonb, 'grad-open-cycle-key', 0
);

SELECT throws_ok(
  $$SELECT public.subscription_apply_starter_graduation(
      'd2000000-0000-0000-0000-000000000002', 'grad-open-idem-key', 'full')$$,
  '22023',
  'subscription_starter_graduation_open_cycle',
  'open cycle: graduating underneath a live payment attempt is refused');

-- ---- unknown SKU ----------------------------------------------------------
SELECT throws_ok(
  $$SELECT public.subscription_apply_starter_graduation(
      'd2000000-0000-0000-0000-000000000003', 'grad-unknown-idem-key', 'full')$$,
  '22023',
  'subscription_starter_graduation_unknown_sku: GRAD-DOES-NOT-EXIST',
  'unknown sku: a graduation line that resolves to nothing is refused');

-- ---- mode 'cadence_only' --------------------------------------------------
CREATE TEMP TABLE _cadence AS
SELECT public.subscription_apply_starter_graduation(
  'd2000000-0000-0000-0000-000000000004', 'grad-cadence-idem-key', 'cadence_only') AS r;

SELECT is((SELECT r #>> '{starterGraduation,reason}' FROM _cadence), 'cadence_normalized',
  'cadence only: the acquisition interval is normalized');
SELECT is(
  (SELECT cadence_days FROM public.subscriptions WHERE id = 'd2000000-0000-0000-0000-000000000004'),
  28,
  'cadence only: cadence moves to the steady value');
SELECT is(
  (SELECT count(*)::int FROM public.subscription_lines sl
     JOIN public.catalog_skus cs ON cs.id = sl.variant_id
    WHERE sl.subscription_id = 'd2000000-0000-0000-0000-000000000004'
      AND cs.sku = 'GRAD-ACQUISITION'),
  1,
  'cadence only: the customer-owned template is left untouched');

CREATE TEMP TABLE _cadence_replay AS
SELECT public.subscription_apply_starter_graduation(
  'd2000000-0000-0000-0000-000000000004', 'grad-cadence-idem-key-2', 'cadence_only') AS r;
SELECT is((SELECT r #>> '{starterGraduation,reason}' FROM _cadence_replay), 'cadence_already_normal',
  'cadence only: re-driving is a no-op once the cadence is normal');

-- ---- no marker ------------------------------------------------------------
SELECT is(
  (public.subscription_apply_starter_graduation(
     'd2000000-0000-0000-0000-000000000005', 'grad-none-idem-key', 'full')
   #>> '{starterGraduation,reason}'),
  'not_a_starter_subscription',
  'no marker: an ordinary subscription is an explicit no-op, not an error');

SELECT * FROM finish();
ROLLBACK;
