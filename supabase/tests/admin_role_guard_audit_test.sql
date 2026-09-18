-- pgTAP: admin role-mutation guards + audit trail (20260611220000).
--   - admin_update_admin_user_role: an admin can change ANOTHER admin's role,
--     writes an audit row, and forbids changing one's OWN role; a distributor
--     is rejected.
--   - anti-lockout trigger: the LAST admin cannot be demoted or deleted.
--
-- auth.uid() is simulated via request.jwt.claims (set_config, txn-local).
-- Run via: supabase test db

BEGIN;
SELECT plan(9);

-- ---- Fixture: three admins + one distributor -------------------------------
INSERT INTO public.admin_users (id, email, role) VALUES
  ('a1111111-1111-1111-1111-111111111111', 'admin1@example.invalid', 'admin'),
  ('a2222222-2222-2222-2222-222222222222', 'admin2@example.invalid', 'admin'),
  ('a3333333-3333-3333-3333-333333333333', 'admin3@example.invalid', 'admin'),
  ('d1111111-1111-1111-1111-111111111111', 'dist1@example.invalid',  'distributor');

-- ===========================================================================
-- admin1 changes admin2's role admin -> distributor (succeeds + audited)
-- ===========================================================================
SELECT set_config('request.jwt.claims',
  '{"sub":"a1111111-1111-1111-1111-111111111111","role":"authenticated"}', true);

SELECT lives_ok(
  $$ SELECT public.admin_update_admin_user_role('a2222222-2222-2222-2222-222222222222', 'distributor') $$,
  'admin1 can change another admin''s role');

SELECT is(
  (SELECT role FROM public.admin_users WHERE id = 'a2222222-2222-2222-2222-222222222222'),
  'distributor', 'target admin2 role updated to distributor');

SELECT is(
  (SELECT count(*)::int FROM public.admin_audit_events
     WHERE action = 'role_change' AND target_admin_id = 'a2222222-2222-2222-2222-222222222222'),
  1, 'one audit row written for the role change');

SELECT is(
  (SELECT actor_admin_id FROM public.admin_audit_events
     WHERE target_admin_id = 'a2222222-2222-2222-2222-222222222222'),
  'a1111111-1111-1111-1111-111111111111'::uuid, 'audit row records admin1 as the actor');

SELECT is(
  (SELECT new_value->>'role' FROM public.admin_audit_events
     WHERE target_admin_id = 'a2222222-2222-2222-2222-222222222222'),
  'distributor', 'audit row records the new role');

-- ===========================================================================
-- admin1 cannot change their OWN role
-- ===========================================================================
SELECT throws_ok(
  $$ SELECT public.admin_update_admin_user_role('a1111111-1111-1111-1111-111111111111', 'distributor') $$,
  'P0001', 'self_role_change_forbidden', 'admin cannot change their own role');

-- ===========================================================================
-- a distributor cannot call the RPC
-- ===========================================================================
SELECT set_config('request.jwt.claims',
  '{"sub":"d1111111-1111-1111-1111-111111111111","role":"authenticated"}', true);

SELECT throws_ok(
  $$ SELECT public.admin_update_admin_user_role('a3333333-3333-3333-3333-333333333333', 'distributor') $$,
  '42501', 'forbidden', 'distributor is rejected by the role RPC');

-- ===========================================================================
-- anti-lockout trigger: leave exactly one admin, then try to remove/demote it
-- (direct SQL — the trigger is path-independent of the RPC)
-- ===========================================================================
-- a2 already distributor; demote a3 too (a1 remains admin -> allowed).
UPDATE public.admin_users SET role = 'distributor'
  WHERE id = 'a3333333-3333-3333-3333-333333333333';

SELECT throws_ok(
  $$ DELETE FROM public.admin_users WHERE id = 'a1111111-1111-1111-1111-111111111111' $$,
  'P0001', 'last_admin_lockout', 'cannot DELETE the last remaining admin');

SELECT throws_ok(
  $$ UPDATE public.admin_users SET role = 'distributor' WHERE id = 'a1111111-1111-1111-1111-111111111111' $$,
  'P0001', 'last_admin_lockout', 'cannot demote the last remaining admin');

SELECT * FROM finish();
ROLLBACK;
