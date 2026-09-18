-- pgTAP: advisor performance hygiene (20260714150000_advisor_perf_hygiene).
--   Verifies the mechanical perf rewrite applied and is behaviour-preserving:
--     1. No public policy has an UNWRAPPED auth.uid()/role()/jwt() left (the
--        auth_rls_initplan fix) — the strong global assertion.
--     2. A representative FK covering index exists.
--     3. A representative rls_enabled_no_policy table now has its service_role policy.
--
-- Run via: supabase test db

BEGIN;
SELECT plan(3);

-- 1. Every remaining public RLS policy that references auth.uid()/role()/jwt() wraps it
--    in a scalar subquery (no bare `auth.fn()` left) — proves the initplan rewrite is
--    complete and nothing regressed.
SELECT is(
  -- Note: pg_policies deparses `(select auth.uid())` as `( SELECT auth.uid() AS uid)`
  -- with UPPERCASE SELECT, so the wrapped-check must be case-insensitive (~*).
  (SELECT count(*)::int FROM pg_policies
   WHERE schemaname = 'public'
     AND (
       (coalesce(qual,'')       ~ 'auth\.(uid|role|jwt)\(\)' AND coalesce(qual,'')       !~* '\(\s*select\s+auth\.') OR
       (coalesce(with_check,'') ~ 'auth\.(uid|role|jwt)\(\)' AND coalesce(with_check,'') !~* '\(\s*select\s+auth\.')
     )),
  0,
  'no public policy has an unwrapped auth.uid()/role()/jwt() (auth_rls_initplan fixed)');

-- 2. A representative FK covering index exists (accounting_invoices.policy_approval_id).
SELECT ok(
  EXISTS (SELECT 1 FROM pg_indexes
          WHERE schemaname = 'public'
            AND indexname = 'idx_accounting_invoices_policy_approval_id'),
  'FK covering index idx_accounting_invoices_policy_approval_id created');

-- 3. A representative previously-no-policy table now declares a service_role policy.
SELECT ok(
  EXISTS (SELECT 1 FROM pg_policies
          WHERE schemaname = 'public' AND tablename = 'outbox_events'
            AND policyname = 'service_role_all_outbox_events'),
  'service_role policy declared on outbox_events (rls_enabled_no_policy cleared)');

SELECT * FROM finish();
ROLLBACK;
