-- pgTAP: current-panel membership authority and retained revoke.
--
-- Proves the managed forward's compatibility defaults, authenticated revoke
-- transaction, idempotent audit, active-only role/RLS semantics, and the
-- serialized last-active-human-admin refusal. This fixture starts after the
-- migration; the migration itself owns the one-time pre-existing-row backfill.

BEGIN;
SELECT plan(47);

INSERT INTO public.admin_users (id, email, role, is_machine_actor) VALUES
  ('ab100000-0000-4000-8000-000000000001', 'membership-actor@example.invalid', 'admin', false),
  ('ab100000-0000-4000-8000-000000000002', 'membership-target@example.invalid', 'distributor', false),
  ('ab100000-0000-4000-8000-000000000003', 'membership-standby@example.invalid', 'admin', false),
  ('ab100000-0000-4000-8000-000000000004', 'membership-machine@example.invalid', 'admin', true),
  ('ab100000-0000-4000-8000-000000000006', 'admin-oms-preview+mismatch-run-deadbeef@example.invalid', 'admin', true),
  ('ab100000-0000-4000-8000-000000000007', 'admin-oms-preview+human-run-deadbeef@example.invalid', 'distributor', false),
  ('ab100000-0000-4000-8000-000000000008', 'ordinary-machine@example.invalid', 'admin', true);

SELECT is(
  (SELECT membership_state FROM public.admin_users WHERE id = 'ab100000-0000-4000-8000-000000000001'),
  'active',
  'compatibility insert defaults to active membership'
);

SELECT is(
  (SELECT membership_provenance FROM public.admin_users WHERE id = 'ab100000-0000-4000-8000-000000000001'),
  'legacy',
  'compatibility insert defaults to legacy provenance'
);

SELECT ok(
  (SELECT membership_accepted_at IS NOT NULL FROM public.admin_users WHERE id = 'ab100000-0000-4000-8000-000000000001'),
  'compatibility insert records an accepted timestamp'
);

SELECT ok(
  NOT has_function_privilege('anon', 'public.admin_revoke_admin_user(uuid, text)', 'execute'),
  'anon cannot execute the revoke RPC'
);

SELECT ok(
  has_function_privilege('authenticated', 'public.admin_revoke_admin_user(uuid, text)', 'execute'),
  'authenticated keeps the intended revoke RPC grant'
);

SELECT ok(
  NOT has_table_privilege('service_role', 'public.admin_users', 'update'),
  'service_role has no direct admin membership update privilege'
);

SELECT ok(
  NOT has_table_privilege('service_role', 'public.admin_users', 'delete'),
  'service_role has no direct admin membership delete privilege'
);

SELECT ok(
  has_function_privilege('service_role', 'public.admin_oms_preview_cleanup_fixture_admin(uuid, text)', 'execute'),
  'service_role can execute the exact synthetic-fixture cleanup RPC'
);

SELECT ok(
  NOT has_function_privilege('anon', 'public.admin_oms_preview_cleanup_fixture_admin(uuid, text)', 'execute'),
  'anon cannot execute the exact synthetic-fixture cleanup RPC'
);

SELECT ok(
  NOT has_function_privilege('authenticated', 'public.admin_oms_preview_cleanup_fixture_admin(uuid, text)', 'execute'),
  'authenticated cannot execute the exact synthetic-fixture cleanup RPC'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS proc
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(proc.proacl, pg_catalog.acldefault('f', proc.proowner))
    ) AS acl
    WHERE proc.oid = 'public.admin_oms_preview_cleanup_fixture_admin(uuid, text)'::regprocedure
      AND acl.grantee = 0
      AND acl.privilege_type = 'EXECUTE'
  ),
  'PUBLIC holds no execute privilege on the exact synthetic-fixture cleanup RPC'
);

SET LOCAL ROLE service_role;

SELECT lives_ok(
  $$ INSERT INTO public.admin_users (id, email, role, is_machine_actor)
     VALUES (
       'ab100000-0000-4000-8000-000000000005',
       'admin-oms-preview+fixture-run-deadbeef@example.invalid',
       'admin',
       true
     ) $$,
  'service_role can create the synthetic fixture through INSERT only'
);

RESET ROLE;

INSERT INTO public.admin_audit_events
  (actor_admin_id, actor_email, action, target_admin_id, target_email)
VALUES
  ('ab100000-0000-4000-8000-000000000005', 'admin-oms-preview+fixture-run-deadbeef@example.invalid',
   'remove', 'ab100000-0000-4000-8000-000000000004', 'membership-machine@example.invalid'),
  ('ab100000-0000-4000-8000-000000000004', 'membership-machine@example.invalid',
   'remove', 'ab100000-0000-4000-8000-000000000005', 'admin-oms-preview+fixture-run-deadbeef@example.invalid'),
  ('ab100000-0000-4000-8000-000000000004', 'membership-machine@example.invalid',
   'remove', 'ab100000-0000-4000-8000-000000000008', 'ordinary-machine@example.invalid');

SET LOCAL ROLE service_role;

SELECT lives_ok(
  $$ SELECT public.admin_oms_preview_cleanup_fixture_admin(
       'ab100000-0000-4000-8000-000000000005',
       'admin-oms-preview+fixture-run-deadbeef@example.invalid'
     ) $$,
  'service_role cleanup removes the exact synthetic machine fixture'
);

RESET ROLE;

SELECT is(
  (SELECT count(*)::integer FROM public.admin_users
   WHERE id = 'ab100000-0000-4000-8000-000000000005'),
  0,
  'cleanup removes the exact synthetic machine membership'
);

SELECT is(
  (SELECT count(*)::integer FROM public.admin_audit_events
   WHERE actor_admin_id = 'ab100000-0000-4000-8000-000000000005'
      OR target_admin_id = 'ab100000-0000-4000-8000-000000000005'),
  0,
  'cleanup removes audit rows in both fixture-owned foreign-key directions'
);

SELECT is(
  (SELECT count(*)::integer FROM public.admin_audit_events
   WHERE actor_admin_id = 'ab100000-0000-4000-8000-000000000004'
     AND target_admin_id = 'ab100000-0000-4000-8000-000000000008'),
  1,
  'cleanup leaves unrelated audit history intact'
);

SET LOCAL ROLE service_role;

SELECT lives_ok(
  $$ SELECT public.admin_oms_preview_cleanup_fixture_admin(
       'ab100000-0000-4000-8000-000000000005',
       'admin-oms-preview+fixture-run-deadbeef@example.invalid'
     ) $$,
  'a replay against an absent, exact fixture is idempotently safe'
);

SELECT throws_ok(
  $$ SELECT public.admin_oms_preview_cleanup_fixture_admin(
       'ab100000-0000-4000-8000-000000000006',
       'admin-oms-preview+other-run-deadbeef@example.invalid'
     ) $$,
  '42501', 'admin_oms_preview_fixture_identity_mismatch',
  'a mismatched id and exact-shaped email cannot select a different fixture'
);

SELECT is(
  (SELECT count(*)::integer FROM public.admin_users
   WHERE id = 'ab100000-0000-4000-8000-000000000006'),
  1,
  'the mismatched synthetic fixture remains present'
);

SELECT throws_ok(
  $$ SELECT public.admin_oms_preview_cleanup_fixture_admin(
       'ab100000-0000-4000-8000-000000000007',
       'admin-oms-preview+human-run-deadbeef@example.invalid'
     ) $$,
  '42501', 'admin_oms_preview_fixture_cleanup_forbidden',
  'a human row with a fixture-shaped email cannot be physically removed'
);

SELECT is(
  (SELECT count(*)::integer FROM public.admin_users
   WHERE id = 'ab100000-0000-4000-8000-000000000007'),
  1,
  'the human row remains present after refused cleanup'
);

SELECT throws_ok(
  $$ SELECT public.admin_oms_preview_cleanup_fixture_admin(
       'ab100000-0000-4000-8000-000000000008',
       'ordinary-machine@example.invalid'
     ) $$,
  '22023', 'admin_oms_preview_fixture_email_invalid',
  'a machine row with an ordinary email cannot be physically removed'
);

SELECT is(
  (SELECT count(*)::integer FROM public.admin_users
   WHERE id = 'ab100000-0000-4000-8000-000000000008'),
  1,
  'the ordinary-email machine row remains present after refused cleanup'
);

SELECT set_config('app.admin_oms_preview_fixture_cleanup', 'true', true);

SELECT throws_ok(
  $$ DELETE FROM public.admin_users
     WHERE id = 'ab100000-0000-4000-8000-000000000006' $$,
  '42501', 'permission denied for table admin_users',
  'a forged cleanup GUC does not grant service_role direct delete authority'
);

RESET ROLE;

SELECT is(
  (SELECT count(*)::integer FROM public.admin_users
   WHERE id = 'ab100000-0000-4000-8000-000000000006'),
  1,
  'forged-GUC direct delete leaves the synthetic fixture intact'
);

SELECT set_config(
  'request.jwt.claims',
  '{"sub":"ab100000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);

SELECT lives_ok(
  $$ SELECT public.admin_revoke_admin_user('ab100000-0000-4000-8000-000000000002', 'offboarding') $$,
  'an active administrator revokes another current membership'
);

SELECT is(
  (SELECT count(*)::integer FROM public.admin_users WHERE id = 'ab100000-0000-4000-8000-000000000002'),
  1,
  'revoke retains the target admin_users row'
);

SELECT is(
  (SELECT membership_state FROM public.admin_users WHERE id = 'ab100000-0000-4000-8000-000000000002'),
  'revoked',
  'revoke changes durable membership state'
);

SELECT is(
  (SELECT membership_revoked_by FROM public.admin_users WHERE id = 'ab100000-0000-4000-8000-000000000002'),
  'ab100000-0000-4000-8000-000000000001'::uuid,
  'revoke retains the actor reference on the target membership'
);

SELECT is(
  (SELECT membership_revocation_reason FROM public.admin_users WHERE id = 'ab100000-0000-4000-8000-000000000002'),
  'offboarding',
  'revoke retains the optional reason'
);

SELECT is(
  (SELECT count(*)::integer FROM public.admin_audit_events
   WHERE action = 'revoke' AND target_admin_id = 'ab100000-0000-4000-8000-000000000002'),
  1,
  'revoke appends exactly one audit event'
);

SELECT is(
  (SELECT new_value->>'membershipState' FROM public.admin_audit_events
   WHERE action = 'revoke' AND target_admin_id = 'ab100000-0000-4000-8000-000000000002'),
  'revoked',
  'revoke audit records the after-state'
);

SELECT lives_ok(
  $$ SELECT public.admin_revoke_admin_user('ab100000-0000-4000-8000-000000000002', 'different replay reason') $$,
  'replaying a completed revoke returns the retained target without failure'
);

SELECT is(
  (SELECT count(*)::integer FROM public.admin_audit_events
   WHERE action = 'revoke' AND target_admin_id = 'ab100000-0000-4000-8000-000000000002'),
  1,
  'replayed revoke appends no second audit event'
);

SELECT throws_ok(
  $$ SELECT public.admin_revoke_admin_user('ab100000-0000-4000-8000-000000000001', NULL) $$,
  'P0001', 'self_revoke_forbidden', 'an administrator cannot revoke their own membership'
);

SELECT throws_ok(
  $$ SELECT public.admin_revoke_admin_user('ab100000-0000-4000-8000-000000000004', NULL) $$,
  'P0001', 'machine_actor_revoke_forbidden', 'an administrator cannot revoke a machine actor target'
);

SELECT throws_ok(
  $$ SELECT public.admin_update_admin_user_role('ab100000-0000-4000-8000-000000000002', 'admin') $$,
  'P0001', 'target_membership_inactive', 'role mutation refuses a revoked target'
);

SELECT lives_ok(
  $$ UPDATE public.admin_users SET role = 'distributor'
     WHERE id = 'ab100000-0000-4000-8000-000000000003' $$,
  'a direct demotion is allowed while another active human administrator remains'
);

SELECT set_config('app.admin_membership_revoke', 'true', true);

SELECT throws_ok(
  $$ UPDATE public.admin_users
     SET membership_state = 'revoked',
         membership_revoked_at = clock_timestamp(),
         membership_revoked_by = 'ab100000-0000-4000-8000-000000000003',
         membership_revocation_reason = 'attempted last-admin removal'
     WHERE id = 'ab100000-0000-4000-8000-000000000001' $$,
  'P0001', 'last_admin_lockout', 'the last active human administrator cannot be revoked'
);

SELECT is(
  (SELECT count(*)::integer FROM public.admin_audit_events
   WHERE action = 'revoke' AND target_admin_id = 'ab100000-0000-4000-8000-000000000001'),
  0,
  'a rejected last-admin transition leaves no success audit event'
);

SET LOCAL ROLE service_role;
SELECT set_config('app.admin_membership_revoke', 'true', true);

SELECT throws_ok(
  $$ UPDATE public.admin_users
     SET membership_state = 'active',
         membership_revoked_at = NULL,
         membership_revoked_by = NULL,
         membership_revocation_reason = NULL
     WHERE id = 'ab100000-0000-4000-8000-000000000002' $$,
  '42501', 'permission denied for table admin_users',
  'a forged revoke GUC does not grant service_role direct lifecycle update authority'
);

SELECT throws_ok(
  $$ DELETE FROM public.admin_users
     WHERE id = 'ab100000-0000-4000-8000-000000000002' $$,
  '42501', 'permission denied for table admin_users',
  'a forged revoke GUC does not grant service_role direct delete authority'
);

RESET ROLE;

SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"ab100000-0000-4000-8000-000000000002","role":"authenticated"}',
  true
);

SELECT is(
  (SELECT count(*)::integer FROM public.admin_users),
  0,
  'a revoked browser principal cannot read even its retained membership through RLS'
);

SELECT is(
  (SELECT count(*)::integer FROM public.admin_audit_events),
  0,
  'a revoked browser principal cannot read the admin audit ledger through helper-backed RLS'
);

RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"ab100000-0000-4000-8000-000000000003","role":"authenticated"}',
  true
);

SELECT is(
  (SELECT count(*)::integer FROM public.admin_users),
  1,
  'an active distributor retains its own RLS-visible membership row'
);

RESET ROLE;

SELECT is(
  public.communications_operator_is_active('ab100000-0000-4000-8000-000000000002'),
  false,
  'a revoked membership no longer passes the managed operator helper'
);

SELECT is(
  public.communications_operator_is_active('ab100000-0000-4000-8000-000000000001'),
  true,
  'an active administrator still passes the managed operator helper'
);

SELECT * FROM finish();
ROLLBACK;
