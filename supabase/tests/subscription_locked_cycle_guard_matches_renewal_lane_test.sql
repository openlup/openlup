-- pgTAP: the subscriber cannot move the next delivery off a refused charge.
--
-- `subscription_list_due_for_renewal` (20260805090000, line 1031) hides a
-- subscription for as long as ANY of its cycles sits in
-- ('payment_pending', 'retry_scheduled', 'payment_failed'), while
-- `customer_self_service_assert_no_locked_cycle` (20260608190000, line 338)
-- refuses only ('payment_pending', 'paid'). Before 20260826160000 that gap let
-- `skip_next_cycle`, `slide_next_cycle` and `order_now` move `next_cycle_at`
-- forward and strand the uncollected cycle at a date nothing points at.
--
-- The fence added there is on the anchor movement, not on the edit, and this
-- suite is built to prove both halves of that choice. The refusal arms show the
-- three anchor-moving actions being turned away; the control arms show the
-- actions and the cycle positions that must NOT be affected -- above all
-- `change_shipping_address`, the one self-service action deliberately left open
-- during dunning, which a widening of the shared guard would have withdrawn from
-- every subscriber whose renewal charge failed.
--
-- No fixture here carries a dunning case, so the delegate's open-case fence
-- cannot be mistaken for the fence under test.
--
-- Run via: supabase db reset && supabase test db

BEGIN;
SELECT plan(16);

SELECT has_function(
  'public', 'customer_self_service_apply_subscription_action',
  ARRAY['uuid', 'text', 'uuid', 'text', 'jsonb', 'timestamp with time zone'],
  'anchor fence: the exported RPC keeps the signature every caller already calls');

-- This repository has a live browser-role EXECUTE escalation of the definer-
-- rights class, and this chain reached seven renames; ACL inherited across a
-- rename is exactly how that escalation happened, so both names are asserted.
SELECT ok(
  has_function_privilege(
    'service_role',
    'public.customer_self_service_apply_subscription_action(uuid,text,uuid,text,jsonb,timestamp with time zone)',
    'EXECUTE')
  AND NOT has_function_privilege(
    'anon',
    'public.customer_self_service_apply_subscription_action(uuid,text,uuid,text,jsonb,timestamp with time zone)',
    'EXECUTE')
  AND NOT has_function_privilege(
    'authenticated',
    'public.customer_self_service_apply_subscription_action(uuid,text,uuid,text,jsonb,timestamp with time zone)',
    'EXECUTE'),
  'anchor fence: the wrapper is service-role only');

SELECT ok(
  has_function_privilege(
    'service_role',
    'public.customer_self_service_apply_action_before_anchor_fence(uuid,text,uuid,text,jsonb,timestamp with time zone)',
    'EXECUTE')
  AND NOT has_function_privilege(
    'anon',
    'public.customer_self_service_apply_action_before_anchor_fence(uuid,text,uuid,text,jsonb,timestamp with time zone)',
    'EXECUTE')
  AND NOT has_function_privilege(
    'authenticated',
    'public.customer_self_service_apply_action_before_anchor_fence(uuid,text,uuid,text,jsonb,timestamp with time zone)',
    'EXECUTE'),
  'anchor fence: the renamed delegate is service-role only');

-- ---- Shared fixture --------------------------------------------------------
INSERT INTO public.catalog_products (id, slug, name, status)
VALUES ('7c400000-0000-4000-8000-000000000001', 'anchor-fence-product', 'Anchor Fence Product', 'active');

INSERT INTO public.catalog_skus (id, product_id, sku, title, pet_type, status, net_weight_g, kcal_per_unit)
VALUES ('7c500000-0000-4000-8000-000000000001', '7c400000-0000-4000-8000-000000000001',
        'ANCHOR-FENCE', 'Anchor Fence', 'dog', 'active', 400, 492);

INSERT INTO auth.users (id) VALUES ('7c000000-0000-4000-8000-000000000001');
INSERT INTO public.clients (id, auth_user_id, email)
VALUES ('7c100000-0000-4000-8000-000000000001',
        '7c000000-0000-4000-8000-000000000001',
        'anchor-fence@example.invalid');

INSERT INTO public.addresses (id, client_id, kind, label, line1, city, postal_code, country)
VALUES
  ('7c700000-0000-4000-8000-000000000001', '7c100000-0000-4000-8000-000000000001',
   'shipping', 'Anchor fence old', 'Old 1', 'Testville', 'ZZ-001', 'ZZ'),
  ('7c700000-0000-4000-8000-000000000002', '7c100000-0000-4000-8000-000000000001',
   'shipping', 'Anchor fence new', 'New 2', 'Testville', 'ZZ-002', 'ZZ');

-- Four subscriptions that differ ONLY in cycle state: same client, same cadence,
-- same anchor, same stored method, same lines, no dunning case anywhere.
INSERT INTO public.subscriptions (
  id, client_id, cadence_days, currency, status, started_at, next_cycle_at,
  template_version, edit_window_hours, payment_method_ref, payment_method_kind,
  shipping_address_id, size_constraint
)
SELECT
  subscription_id,
  '7c100000-0000-4000-8000-000000000001',
  28, 'XTS', 'active',
  '2026-07-01T00:00:00Z'::timestamptz,
  '2026-09-01T00:00:00Z'::timestamptz,
  1, 24, 'pm_anchor_fence', 'card',
  '7c700000-0000-4000-8000-000000000001',
  '{"kind":"units","value":30}'::jsonb
FROM unnest(ARRAY[
  '7c200000-0000-4000-8000-000000000001',
  '7c200000-0000-4000-8000-000000000002',
  '7c200000-0000-4000-8000-000000000003',
  '7c200000-0000-4000-8000-000000000004'
]::uuid[]) AS subscription_id;

INSERT INTO public.subscription_lines (
  subscription_id, variant_id, qty, sort_order, is_addon, template_version
)
SELECT subscription.id, '7c500000-0000-4000-8000-000000000001', 4, 1, false, 1
  FROM public.subscriptions AS subscription
 WHERE subscription.client_id = '7c100000-0000-4000-8000-000000000001';

INSERT INTO public.subscription_cycles (
  id, subscription_id, cycle_number, scheduled_at, status, engine_idempotency_key
)
VALUES
  -- (1) the charge was refused, at the anchor itself.
  ('7c300000-0000-4000-8000-000000000001', '7c200000-0000-4000-8000-000000000001',
   2, '2026-09-01T00:00:00Z'::timestamptz, 'payment_failed', 'anchor-fence-failed'),
  -- (2) the retry ladder still owns it, at the anchor itself.
  ('7c300000-0000-4000-8000-000000000002', '7c200000-0000-4000-8000-000000000002',
   2, '2026-09-01T00:00:00Z'::timestamptz, 'retry_scheduled', 'anchor-fence-retry'),
  -- (3) subscription three has no cycle at all: the clean control.
  -- (4) refused, but at an OLDER date the customer can neither see nor clear.
  ('7c300000-0000-4000-8000-000000000004', '7c200000-0000-4000-8000-000000000004',
   1, '2026-08-04T00:00:00Z'::timestamptz, 'payment_failed', 'anchor-fence-stale');

-- ---- The refusals ----------------------------------------------------------

SELECT throws_ok(
  $q$ SELECT public.customer_self_service_apply_subscription_action(
    '7c000000-0000-4000-8000-000000000001', 'anchor-fence-skip-failed',
    '7c200000-0000-4000-8000-000000000001', 'skip_next_cycle',
    '{}'::jsonb, '2026-08-01T10:00:00Z'::timestamptz) $q$,
  'customer_self_service_payment_blocked',
  'anchor fence: skip is refused while the cycle at the anchor is payment_failed');

SELECT is(
  (SELECT next_cycle_at FROM public.subscriptions WHERE id = '7c200000-0000-4000-8000-000000000001'),
  '2026-09-01T00:00:00Z'::timestamptz,
  'anchor fence: the refused skip leaves the anchor on the uncollected cycle');

SELECT is(
  (SELECT count(*)::int FROM public.subscription_events
    WHERE idempotency_key = 'anchor-fence-skip-failed'),
  0,
  'anchor fence: the refusal rolls the delegate write back, so no event claims a skip');

SELECT throws_ok(
  $q$ SELECT public.customer_self_service_apply_subscription_action(
    '7c000000-0000-4000-8000-000000000001', 'anchor-fence-slide-retry',
    '7c200000-0000-4000-8000-000000000002', 'slide_next_cycle',
    '{"newNextCycleAt":"2026-08-20T00:00:00Z"}'::jsonb,
    '2026-08-01T10:00:00Z'::timestamptz) $q$,
  'customer_self_service_payment_blocked',
  'anchor fence: slide is refused while the cycle at the anchor is retry_scheduled');

SELECT is(
  (SELECT next_cycle_at FROM public.subscriptions WHERE id = '7c200000-0000-4000-8000-000000000002'),
  '2026-09-01T00:00:00Z'::timestamptz,
  'anchor fence: the refused slide leaves the anchor on the uncollected cycle');

SELECT throws_ok(
  $q$ SELECT public.customer_self_service_apply_subscription_action(
    '7c000000-0000-4000-8000-000000000001', 'anchor-fence-order-now-failed',
    '7c200000-0000-4000-8000-000000000001', 'order_now',
    '{"confirmedChargeTiming":true}'::jsonb, '2026-08-01T10:00:00Z'::timestamptz) $q$,
  'customer_self_service_payment_blocked',
  'anchor fence: order_now cannot pull the anchor off the uncollected cycle either');

-- ---- The controls ----------------------------------------------------------
-- A fence that over-matched would lock a paying subscriber out of their own
-- account, which is worse than the bleed being stopped.

SELECT is(
  public.customer_self_service_apply_subscription_action(
    '7c000000-0000-4000-8000-000000000001', 'anchor-fence-address-failed',
    '7c200000-0000-4000-8000-000000000001', 'change_shipping_address',
    '{"shippingAddressId":"7c700000-0000-4000-8000-000000000002"}'::jsonb,
    '2026-08-01T10:00:00Z'::timestamptz
  )->'subscriptionAction'->>'status',
  'applied',
  'anchor fence: the address change stays open to a subscriber whose charge failed');

SELECT is(
  (SELECT shipping_address_id FROM public.subscriptions WHERE id = '7c200000-0000-4000-8000-000000000001'),
  '7c700000-0000-4000-8000-000000000002'::uuid,
  'anchor fence: that address change really wrote, so the arm above is not vacuous');

SELECT is(
  public.customer_self_service_apply_subscription_action(
    '7c000000-0000-4000-8000-000000000001', 'anchor-fence-skip-clean',
    '7c200000-0000-4000-8000-000000000003', 'skip_next_cycle',
    '{}'::jsonb, '2026-08-01T10:00:00Z'::timestamptz
  )->'subscriptionAction'->>'status',
  'applied',
  'anchor fence: a subscription with no cycle at the anchor still skips');

SELECT is(
  (SELECT next_cycle_at FROM public.subscriptions WHERE id = '7c200000-0000-4000-8000-000000000003'),
  '2026-09-29T00:00:00Z'::timestamptz,
  'anchor fence: the clean skip still rolls the anchor forward by one cadence');

SELECT is(
  public.customer_self_service_apply_subscription_action(
    '7c000000-0000-4000-8000-000000000001', 'anchor-fence-skip-stale',
    '7c200000-0000-4000-8000-000000000004', 'skip_next_cycle',
    '{}'::jsonb, '2026-08-01T10:00:00Z'::timestamptz
  )->'subscriptionAction'->>'status',
  'applied',
  'anchor fence: an uncollected cycle at an OLDER date does not block the customer');

SELECT is(
  (SELECT next_cycle_at FROM public.subscriptions WHERE id = '7c200000-0000-4000-8000-000000000004'),
  '2026-09-29T00:00:00Z'::timestamptz,
  'anchor fence: that skip rolls the anchor forward exactly as before');

SELECT is(
  (SELECT status FROM public.subscription_cycles WHERE id = '7c300000-0000-4000-8000-000000000004'),
  'payment_failed',
  'anchor fence: this wave refuses and terminalizes nothing');

SELECT * FROM finish();
ROLLBACK;
