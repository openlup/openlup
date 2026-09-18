-- pgTAP: Model B Phase 0a — subscriptions provisional-activation status + transition guard.
-- Verifies migration 20260610140000:
--   * the status CHECK admits 'pending_activation' + 'activation_failed'
--   * subscription_guard_status_transition allows the provisional edges
--     (pending_activation -> active/activation_failed/cancelled)
--   * pending_activation -> paused/completed remain illegal
--   * the pre-existing matrix is preserved, with cancelled -> active allowed for
--     customer-initiated reactivation
--
-- Run via: supabase test db

BEGIN;
SELECT plan(10);

-- Fixture: one client (only email is NOT NULL without a default).
INSERT INTO public.clients (id, email)
VALUES ('00000000-0000-0000-0000-0000000000c1', 'modelb-phase0@example.invalid');

-- CHECK constraint admits the two new states on INSERT (the transition trigger
-- fires only on UPDATE OF status, so a direct provisional INSERT is the path the
-- Model B finalize RPC will use).
SELECT lives_ok(
  $$INSERT INTO public.subscriptions (id, client_id, cadence_days, currency, status)
    VALUES ('00000000-0000-0000-0000-0000000000a9','00000000-0000-0000-0000-0000000000c1',21,'PLN','pending_activation')$$,
  'status CHECK admits pending_activation on insert'
);
SELECT lives_ok(
  $$INSERT INTO public.subscriptions (id, client_id, cadence_days, currency, status)
    VALUES ('00000000-0000-0000-0000-0000000000b0','00000000-0000-0000-0000-0000000000c1',21,'PLN','activation_failed')$$,
  'status CHECK admits activation_failed on insert'
);

-- Seed rows for the transition matrix (insert at the desired start status; the
-- trigger only guards UPDATEs).
INSERT INTO public.subscriptions (id, client_id, cadence_days, currency, status) VALUES
  ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000c1',21,'PLN','pending_activation'),
  ('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-0000000000c1',21,'PLN','pending_activation'),
  ('00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-0000000000c1',21,'PLN','pending_activation'),
  ('00000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-0000000000c1',21,'PLN','pending_activation'),
  ('00000000-0000-0000-0000-000000000005','00000000-0000-0000-0000-0000000000c1',21,'PLN','pending_activation'),
  ('00000000-0000-0000-0000-000000000006','00000000-0000-0000-0000-0000000000c1',21,'PLN','active'),
  ('00000000-0000-0000-0000-000000000007','00000000-0000-0000-0000-0000000000c1',21,'PLN','paused'),
  ('00000000-0000-0000-0000-000000000008','00000000-0000-0000-0000-0000000000c1',21,'PLN','cancelled');

-- Every row this test transitions INTO 'active' needs at least one template line:
-- trg_subscription_guard_active_requires_lines (20260801120100) rejects an
-- activation of a line-less subscription, and a fixture without lines would model
-- a state production forbids. Rows that only move to paused/cancelled/failed are
-- left bare on purpose, so the guard's edge remains visible in this fixture.
INSERT INTO public.catalog_products (id, slug, name, status)
VALUES ('00000000-0000-0000-0000-0000000000d1', 'modelb-phase0-product', 'Model B Phase0 Product', 'active');
INSERT INTO public.catalog_skus (id, product_id, sku, title, pet_type, status, net_weight_g, kcal_per_unit)
VALUES ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000d1', 'MODELB-P0-SKU', 'Model B Phase0 SKU', 'dog', 'active', 400, 350);
INSERT INTO public.subscription_lines (subscription_id, variant_id, qty, sort_order, is_addon, template_version)
VALUES
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000d2', 1, 0, false, 1),
  ('00000000-0000-0000-0000-000000000007', '00000000-0000-0000-0000-0000000000d2', 1, 0, false, 1),
  ('00000000-0000-0000-0000-000000000008', '00000000-0000-0000-0000-0000000000d2', 1, 0, false, 1);

-- Legal provisional + preserved transitions.
SELECT lives_ok($$UPDATE public.subscriptions SET status='active' WHERE id='00000000-0000-0000-0000-000000000001'$$,
  'pending_activation -> active is legal (confirm)');
SELECT lives_ok($$UPDATE public.subscriptions SET status='activation_failed' WHERE id='00000000-0000-0000-0000-000000000002'$$,
  'pending_activation -> activation_failed is legal (declined/abandon)');
SELECT lives_ok($$UPDATE public.subscriptions SET status='cancelled' WHERE id='00000000-0000-0000-0000-000000000003'$$,
  'pending_activation -> cancelled is legal (sweep)');
SELECT lives_ok($$UPDATE public.subscriptions SET status='paused' WHERE id='00000000-0000-0000-0000-000000000006'$$,
  'active -> paused still legal (regression)');
SELECT lives_ok($$UPDATE public.subscriptions SET status='active' WHERE id='00000000-0000-0000-0000-000000000007'$$,
  'paused -> active still legal (regression)');

-- Illegal transitions (guard raises ERRCODE 22023).
SELECT throws_ok($$UPDATE public.subscriptions SET status='paused' WHERE id='00000000-0000-0000-0000-000000000004'$$,
  '22023', NULL, 'pending_activation -> paused is rejected');
SELECT throws_ok($$UPDATE public.subscriptions SET status='completed' WHERE id='00000000-0000-0000-0000-000000000005'$$,
  '22023', NULL, 'pending_activation -> completed is rejected');
SELECT lives_ok($$UPDATE public.subscriptions SET status='active' WHERE id='00000000-0000-0000-0000-000000000008'$$,
  'cancelled -> active is legal for customer reactivation');

SELECT * FROM finish();
ROLLBACK;
