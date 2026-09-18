-- pgTAP: historical payment-method-ref scope repair for renewal readiness.
--
-- The repair must promote only existing, unambiguous, same-client active method
-- refs to subscription scope. It must not broaden due-renewal charging, steal
-- cross-client refs, revive unusable refs, or create duplicate active refs.
--
-- Run via: supabase test db

BEGIN;
SELECT plan(24);

-- ---- Function surface / grants ------------------------------------------
SELECT has_function(
  'public',
  'commerce_payment_method_ref_repair_subscription_scope',
  ARRAY['text', 'uuid', 'timestamp with time zone', 'text'],
  'single subscription scope repair RPC exists');

SELECT has_function(
  'public',
  'commerce_payment_method_ref_repair_subscription_scope_batch',
  ARRAY['integer', 'boolean', 'text'],
  'batch subscription scope repair RPC exists');

SELECT ok(
  has_function_privilege(
    'service_role',
    'public.commerce_payment_method_ref_repair_subscription_scope(text,uuid,timestamp with time zone,text)',
    'EXECUTE'),
  'service_role can execute single scope repair');

SELECT ok(
  NOT has_function_privilege(
    'anon',
    'public.commerce_payment_method_ref_repair_subscription_scope(text,uuid,timestamp with time zone,text)',
    'EXECUTE')
  AND NOT has_function_privilege(
    'authenticated',
    'public.commerce_payment_method_ref_repair_subscription_scope(text,uuid,timestamp with time zone,text)',
    'EXECUTE'),
  'anon/authenticated cannot execute single scope repair');

-- ---- Shared fixtures -----------------------------------------------------
INSERT INTO public.clients (id, email) VALUES
  ('e1000000-0000-4000-8000-000000000001', 'scope-safe@example.invalid'),
  ('e1000000-0000-4000-8000-000000000002', 'scope-stale@example.invalid'),
  ('e1000000-0000-4000-8000-000000000003', 'scope-already@example.invalid'),
  ('e1000000-0000-4000-8000-000000000004', 'scope-cross-owner@example.invalid'),
  ('e1000000-0000-4000-8000-000000000005', 'scope-cross-target@example.invalid'),
  ('e1000000-0000-4000-8000-000000000006', 'scope-revoked@example.invalid'),
  ('e1000000-0000-4000-8000-000000000007', 'scope-pending@example.invalid'),
  ('e1000000-0000-4000-8000-000000000008', 'scope-expired@example.invalid'),
  ('e1000000-0000-4000-8000-000000000009', 'scope-wrong-owner@example.invalid'),
  ('e1000000-0000-4000-8000-000000000010', 'scope-ambiguous@example.invalid'),
  ('e1000000-0000-4000-8000-000000000011', 'scope-wrong-owner-holder@example.invalid');

INSERT INTO public.subscriptions (
  id, client_id, cadence_days, currency, status, next_cycle_at, payment_method_kind, payment_method_ref
) VALUES
  ('e2000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000001', 28, 'PLN', 'active', '2026-06-01T00:00:00Z', 'card', 'pm_scope_safe'),
  ('e2000000-0000-4000-8000-000000000002', 'e1000000-0000-4000-8000-000000000002', 28, 'PLN', 'active', '2026-06-01T00:00:00Z', 'card', 'pm_scope_new'),
  ('e2000000-0000-4000-8000-000000000003', 'e1000000-0000-4000-8000-000000000003', 28, 'PLN', 'active', '2026-06-01T00:00:00Z', 'card', 'pm_scope_already'),
  ('e2000000-0000-4000-8000-000000000004', 'e1000000-0000-4000-8000-000000000004', 28, 'PLN', 'active', '2026-06-01T00:00:00Z', 'card', 'pm_scope_cross'),
  ('e2000000-0000-4000-8000-000000000006', 'e1000000-0000-4000-8000-000000000006', 28, 'PLN', 'active', '2026-06-01T00:00:00Z', 'card', 'pm_scope_revoked'),
  ('e2000000-0000-4000-8000-000000000007', 'e1000000-0000-4000-8000-000000000007', 28, 'PLN', 'active', '2026-06-01T00:00:00Z', 'card', 'pm_scope_pending'),
  ('e2000000-0000-4000-8000-000000000008', 'e1000000-0000-4000-8000-000000000008', 28, 'PLN', 'active', '2026-06-01T00:00:00Z', 'card', 'pm_scope_expired'),
  ('e2000000-0000-4000-8000-000000000009', 'e1000000-0000-4000-8000-000000000009', 28, 'PLN', 'active', '2026-06-01T00:00:00Z', 'card', 'pm_scope_wrong_owner'),
  ('e2000000-0000-4000-8000-000000000010', 'e1000000-0000-4000-8000-000000000010', 28, 'PLN', 'active', '2026-06-01T00:00:00Z', 'card', 'pm_scope_ambiguous'),
  ('e2000000-0000-4000-8000-000000000011', 'e1000000-0000-4000-8000-000000000011', 28, 'PLN', 'active', '2026-06-01T00:00:00Z', 'card', 'pm_scope_wrong_owner');

INSERT INTO public.commerce_payment_method_refs (
  id, client_id, subscription_id, provider_kind, method_kind, provider_customer_ref,
  provider_method_ref, status, active, expires_at
) VALUES
  ('e3000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000001', NULL, 'stripe', 'card', 'cus_scope_safe', 'pm_scope_safe', 'active', true, NULL),
  ('e3000000-0000-4000-8000-000000000002', 'e1000000-0000-4000-8000-000000000002', 'e2000000-0000-4000-8000-000000000002', 'stripe', 'card', 'cus_scope_stale', 'pm_scope_old', 'active', true, NULL),
  ('e3000000-0000-4000-8000-000000000003', 'e1000000-0000-4000-8000-000000000002', NULL, 'stripe', 'card', 'cus_scope_stale', 'pm_scope_new', 'active', true, NULL),
  ('e3000000-0000-4000-8000-000000000004', 'e1000000-0000-4000-8000-000000000003', 'e2000000-0000-4000-8000-000000000003', 'stripe', 'card', 'cus_scope_already', 'pm_scope_already', 'active', true, NULL),
  ('e3000000-0000-4000-8000-000000000005', 'e1000000-0000-4000-8000-000000000005', NULL, 'stripe', 'card', 'cus_scope_cross', 'pm_scope_cross', 'active', true, NULL),
  ('e3000000-0000-4000-8000-000000000006', 'e1000000-0000-4000-8000-000000000006', NULL, 'stripe', 'card', 'cus_scope_revoked', 'pm_scope_revoked', 'revoked', false, NULL),
  ('e3000000-0000-4000-8000-000000000007', 'e1000000-0000-4000-8000-000000000007', NULL, 'stripe', 'card', 'cus_scope_pending', 'pm_scope_pending', 'pending_verification', false, NULL),
  ('e3000000-0000-4000-8000-000000000008', 'e1000000-0000-4000-8000-000000000008', NULL, 'stripe', 'card', 'cus_scope_expired', 'pm_scope_expired', 'active', true, '2020-01-01T00:00:00Z'),
  ('e3000000-0000-4000-8000-000000000009', 'e1000000-0000-4000-8000-000000000009', 'e2000000-0000-4000-8000-000000000011', 'stripe', 'card', 'cus_scope_wrong', 'pm_scope_wrong_owner', 'active', true, NULL),
  ('e3000000-0000-4000-8000-000000000010', 'e1000000-0000-4000-8000-000000000010', NULL, 'stripe', 'card', 'cus_scope_ambig_a', 'pm_scope_ambiguous', 'active', true, NULL),
  ('e3000000-0000-4000-8000-000000000011', 'e1000000-0000-4000-8000-000000000010', NULL, 'tpay', 'card', 'cus_scope_ambig_b', 'pm_scope_ambiguous', 'active', true, NULL);

-- ---- Safe client-scoped repair ------------------------------------------
CREATE TEMP TABLE _safe AS
SELECT public.commerce_payment_method_ref_repair_subscription_scope(
  'scope-repair-safe-0001',
  'e2000000-0000-4000-8000-000000000001',
  '2026-07-04T10:00:00Z'::timestamptz,
  'pgtap.safe'
) AS r;

SELECT is((SELECT r #>> '{paymentMethodRefScopeRepair,status}' FROM _safe), 'repaired', 'client-scoped active ref is repaired');
SELECT is(
  (SELECT subscription_id FROM public.commerce_payment_method_refs WHERE id = 'e3000000-0000-4000-8000-000000000001'),
  'e2000000-0000-4000-8000-000000000001'::uuid,
  'safe ref is promoted to subscription scope');
SELECT is(
  (SELECT count(*)::int FROM public.subscription_events
    WHERE subscription_id = 'e2000000-0000-4000-8000-000000000001'
      AND event_type = 'subscription.payment_method_ref_scope_repaired'),
  1,
  'repair emits one internal subscription event');
SELECT is(
  (SELECT provider_method_ref
     FROM public.subscription_list_due_for_renewal(50)
    WHERE subscription_id = 'e2000000-0000-4000-8000-000000000001'),
  'pm_scope_safe',
  'due RPC returns the promoted provider ref');

-- ---- Stale old subscription ref is deactivated first ---------------------
CREATE TEMP TABLE _stale AS
SELECT public.commerce_payment_method_ref_repair_subscription_scope(
  'scope-repair-stale-0001',
  'e2000000-0000-4000-8000-000000000002',
  '2026-07-04T10:01:00Z'::timestamptz,
  'pgtap.stale'
) AS r;

SELECT is((SELECT r #>> '{paymentMethodRefScopeRepair,status}' FROM _stale), 'repaired', 'stale old active ref can be replaced');
SELECT is(
  (SELECT active FROM public.commerce_payment_method_refs WHERE id = 'e3000000-0000-4000-8000-000000000002'),
  false,
  'old subscription-scoped ref is deactivated');
SELECT is(
  (SELECT subscription_id FROM public.commerce_payment_method_refs WHERE id = 'e3000000-0000-4000-8000-000000000003'),
  'e2000000-0000-4000-8000-000000000002'::uuid,
  'new client-scoped ref is promoted');
SELECT is(
  (SELECT count(*)::int FROM public.commerce_payment_method_refs
    WHERE subscription_id = 'e2000000-0000-4000-8000-000000000002' AND active),
  1,
  'exactly one active method ref remains for the subscription');
SELECT is(
  (SELECT provider_method_ref
     FROM public.subscription_list_due_for_renewal(50)
    WHERE subscription_id = 'e2000000-0000-4000-8000-000000000002'),
  'pm_scope_new',
  'due RPC targets the new ref after repair');

-- ---- No-op / replay / conflict ------------------------------------------
CREATE TEMP TABLE _already AS
SELECT public.commerce_payment_method_ref_repair_subscription_scope(
  'scope-repair-already-0001',
  'e2000000-0000-4000-8000-000000000003',
  '2026-07-04T10:02:00Z'::timestamptz,
  'pgtap.already'
) AS r;

SELECT is((SELECT r #>> '{paymentMethodRefScopeRepair,status}' FROM _already), 'no_op', 'already subscription-scoped ref is no-op');

CREATE TEMP TABLE _safe_replay AS
SELECT public.commerce_payment_method_ref_repair_subscription_scope(
  'scope-repair-safe-0001',
  'e2000000-0000-4000-8000-000000000001',
  '2026-07-04T10:05:00Z'::timestamptz,
  'pgtap.safe'
) AS r;

SELECT is((SELECT r #>> '{paymentMethodRefScopeRepair,replayed}' FROM _safe_replay), 'true', 'same idempotency key replays');

SELECT throws_ok(
  $$ SELECT public.commerce_payment_method_ref_repair_subscription_scope(
       'scope-repair-safe-0001',
       'e2000000-0000-4000-8000-000000000002',
       '2026-07-04T10:06:00Z'::timestamptz,
       'pgtap.safe'
     ) $$,
  '23505',
  'payment_method_ref_scope_repair_idempotency_conflict',
  'same idempotency key with different subscription conflicts');

-- ---- Unsafe rows remain skipped / untouched ------------------------------
SELECT is(
  (public.commerce_payment_method_ref_repair_subscription_scope(
    'scope-repair-cross-0001',
    'e2000000-0000-4000-8000-000000000004',
    '2026-07-04T10:07:00Z'::timestamptz,
    'pgtap.cross'
  ) #>> '{paymentMethodRefScopeRepair,reason}'),
  'cross_client_candidate',
  'cross-client candidate is skipped');

SELECT is(
  (public.commerce_payment_method_ref_repair_subscription_scope(
    'scope-repair-revoked-0001',
    'e2000000-0000-4000-8000-000000000006',
    '2026-07-04T10:08:00Z'::timestamptz,
    'pgtap.revoked'
  ) #>> '{paymentMethodRefScopeRepair,reason}'),
  'unusable_candidate',
  'revoked ref is skipped as unusable');

SELECT is(
  (public.commerce_payment_method_ref_repair_subscription_scope(
    'scope-repair-pending-0001',
    'e2000000-0000-4000-8000-000000000007',
    '2026-07-04T10:09:00Z'::timestamptz,
    'pgtap.pending'
  ) #>> '{paymentMethodRefScopeRepair,reason}'),
  'unusable_candidate',
  'pending ref is skipped as unusable');

SELECT is(
  (public.commerce_payment_method_ref_repair_subscription_scope(
    'scope-repair-expired-0001',
    'e2000000-0000-4000-8000-000000000008',
    '2026-07-04T10:10:00Z'::timestamptz,
    'pgtap.expired'
  ) #>> '{paymentMethodRefScopeRepair,reason}'),
  'unusable_candidate',
  'expired active ref is skipped as unusable');

SELECT is(
  (public.commerce_payment_method_ref_repair_subscription_scope(
    'scope-repair-wrong-owner-0001',
    'e2000000-0000-4000-8000-000000000009',
    '2026-07-04T10:11:00Z'::timestamptz,
    'pgtap.wrong-owner'
  ) #>> '{paymentMethodRefScopeRepair,reason}'),
  'wrong_subscription_owner',
  'method ref owned by another active subscription is skipped');

SELECT is(
  (public.commerce_payment_method_ref_repair_subscription_scope(
    'scope-repair-ambiguous-0001',
    'e2000000-0000-4000-8000-000000000010',
    '2026-07-04T10:12:00Z'::timestamptz,
    'pgtap.ambiguous'
  ) #>> '{paymentMethodRefScopeRepair,reason}'),
  'ambiguous_candidate',
  'multiple same-client active candidates are skipped');

SELECT is(
  (SELECT subscription_id FROM public.commerce_payment_method_refs WHERE id = 'e3000000-0000-4000-8000-000000000005'),
  NULL,
  'cross-client candidate remains client-scoped and untouched');

SELECT is(
  (SELECT count(*)::int FROM public.commerce_payment_method_refs
    WHERE subscription_id = 'e2000000-0000-4000-8000-000000000010'),
  0,
  'ambiguous candidates are not promoted');

SELECT * FROM finish();
ROLLBACK;
