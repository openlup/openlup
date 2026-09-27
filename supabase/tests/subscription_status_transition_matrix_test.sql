-- pgTAP: the subscription status matrix the core engine mirrors.
--
-- The core package publishes SUBSCRIPTION_STATUS_TRANSITIONS as the managed
-- guard public.subscription_guard_status_transition restricted to the engine's
-- four statuses (active, paused, cancelled, completed). This suite drives every
-- ordered pair of those four through the guard and asserts the same verdict the
-- core contract test (packages/core/test/subscriptionStatusTransitions.test.ts)
-- asserts in TypeScript:
--
--   allowed  active    -> paused, cancelled, completed
--            paused    -> active, cancelled
--            cancelled -> active            (owner win-back)
--   refused  everything else; completed is terminal
--
-- The activation-flow edges (pending_activation -> active / activation_failed /
-- cancelled, and the audited cancelled -> pending_activation reopen) are outside
-- the engine and pinned by subscription_provisional_status_test.sql and
-- expired_checkout_recovery_test.sql.
--
-- Every row carries a template line, so trg_subscription_guard_active_requires_lines
-- can never be the trigger that refuses a move into active: each refusal below
-- is asserted by the status guard's own message.
--
-- Run via: supabase test db

BEGIN;
SELECT plan(13);

SELECT has_trigger(
  'public', 'subscriptions', 'trg_subscription_guard_status_transition',
  'the status guard fires on subscriptions');

INSERT INTO public.clients (id, email)
VALUES ('5a700000-0000-4000-8000-0000000000c1', 'status-matrix@example.invalid');

INSERT INTO public.catalog_products (id, slug, name, status)
VALUES ('5a700000-0000-4000-8000-0000000000d1', 'status-matrix-product', 'Status Matrix Product', 'active');
INSERT INTO public.catalog_skus (id, product_id, sku, title, pet_type, status, net_weight_g, kcal_per_unit)
VALUES ('5a700000-0000-4000-8000-0000000000d2', '5a700000-0000-4000-8000-0000000000d1',
        'STATUS-MATRIX-SKU', 'Status Matrix SKU', 'dog', 'active', 400, 350);

-- One row per ordered pair, seeded at its FROM status (the guard fires only on
-- UPDATE OF status, so an INSERT places a row at any status the CHECK admits).
-- The last two digits name the pair: <from><to> with 1=active 2=paused
-- 3=cancelled 4=completed.
INSERT INTO public.subscriptions (id, client_id, cadence_days, currency, status) VALUES
  ('5a700000-0000-4000-8000-000000000012', '5a700000-0000-4000-8000-0000000000c1', 21, 'XTS', 'active'),
  ('5a700000-0000-4000-8000-000000000013', '5a700000-0000-4000-8000-0000000000c1', 21, 'XTS', 'active'),
  ('5a700000-0000-4000-8000-000000000014', '5a700000-0000-4000-8000-0000000000c1', 21, 'XTS', 'active'),
  ('5a700000-0000-4000-8000-000000000021', '5a700000-0000-4000-8000-0000000000c1', 21, 'XTS', 'paused'),
  ('5a700000-0000-4000-8000-000000000023', '5a700000-0000-4000-8000-0000000000c1', 21, 'XTS', 'paused'),
  ('5a700000-0000-4000-8000-000000000024', '5a700000-0000-4000-8000-0000000000c1', 21, 'XTS', 'paused'),
  ('5a700000-0000-4000-8000-000000000031', '5a700000-0000-4000-8000-0000000000c1', 21, 'XTS', 'cancelled'),
  ('5a700000-0000-4000-8000-000000000032', '5a700000-0000-4000-8000-0000000000c1', 21, 'XTS', 'cancelled'),
  ('5a700000-0000-4000-8000-000000000034', '5a700000-0000-4000-8000-0000000000c1', 21, 'XTS', 'cancelled'),
  ('5a700000-0000-4000-8000-000000000041', '5a700000-0000-4000-8000-0000000000c1', 21, 'XTS', 'completed'),
  ('5a700000-0000-4000-8000-000000000042', '5a700000-0000-4000-8000-0000000000c1', 21, 'XTS', 'completed'),
  ('5a700000-0000-4000-8000-000000000043', '5a700000-0000-4000-8000-0000000000c1', 21, 'XTS', 'completed');

INSERT INTO public.subscription_lines (subscription_id, variant_id, qty, sort_order, is_addon, template_version)
SELECT subscription.id, '5a700000-0000-4000-8000-0000000000d2', 1, 0, false, 1
  FROM public.subscriptions subscription
 WHERE subscription.client_id = '5a700000-0000-4000-8000-0000000000c1';

-- ---- Allowed: exactly the six edges of the core matrix ---------------------
SELECT lives_ok($$UPDATE public.subscriptions SET status = 'paused'    WHERE id = '5a700000-0000-4000-8000-000000000012'$$,
  'active -> paused is allowed');
SELECT lives_ok($$UPDATE public.subscriptions SET status = 'cancelled' WHERE id = '5a700000-0000-4000-8000-000000000013'$$,
  'active -> cancelled is allowed');
SELECT lives_ok($$UPDATE public.subscriptions SET status = 'completed' WHERE id = '5a700000-0000-4000-8000-000000000014'$$,
  'active -> completed is allowed');
SELECT lives_ok($$UPDATE public.subscriptions SET status = 'active'    WHERE id = '5a700000-0000-4000-8000-000000000021'$$,
  'paused -> active is allowed');
SELECT lives_ok($$UPDATE public.subscriptions SET status = 'cancelled' WHERE id = '5a700000-0000-4000-8000-000000000023'$$,
  'paused -> cancelled is allowed');
SELECT lives_ok($$UPDATE public.subscriptions SET status = 'active'    WHERE id = '5a700000-0000-4000-8000-000000000031'$$,
  'cancelled -> active is allowed (owner win-back)');

-- ---- Refused: the other six, each by the status guard itself ---------------
SELECT throws_ok($$UPDATE public.subscriptions SET status = 'completed' WHERE id = '5a700000-0000-4000-8000-000000000024'$$,
  '22023', 'subscription_invalid_status_transition', 'paused -> completed is refused');
SELECT throws_ok($$UPDATE public.subscriptions SET status = 'paused'    WHERE id = '5a700000-0000-4000-8000-000000000032'$$,
  '22023', 'subscription_invalid_status_transition', 'cancelled -> paused is refused');
SELECT throws_ok($$UPDATE public.subscriptions SET status = 'completed' WHERE id = '5a700000-0000-4000-8000-000000000034'$$,
  '22023', 'subscription_invalid_status_transition', 'cancelled -> completed is refused');
SELECT throws_ok($$UPDATE public.subscriptions SET status = 'active'    WHERE id = '5a700000-0000-4000-8000-000000000041'$$,
  '22023', 'subscription_invalid_status_transition', 'completed -> active is refused (terminal)');
SELECT throws_ok($$UPDATE public.subscriptions SET status = 'paused'    WHERE id = '5a700000-0000-4000-8000-000000000042'$$,
  '22023', 'subscription_invalid_status_transition', 'completed -> paused is refused (terminal)');
SELECT throws_ok($$UPDATE public.subscriptions SET status = 'cancelled' WHERE id = '5a700000-0000-4000-8000-000000000043'$$,
  '22023', 'subscription_invalid_status_transition', 'completed -> cancelled is refused (terminal)');

SELECT * FROM finish();
ROLLBACK;
