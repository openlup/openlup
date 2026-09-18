-- pgTAP: record_admin_audit_event audit primitive (20260614150000).
--   - writes one row with a NOT-NULL explicit actor (the service-role fix);
--   - re-derives actor_kind from admin_users.is_machine_actor (not the caller);
--   - RAISEs 42501 on NULL actor and on unknown actor;
--   - idempotent replay: same (entity_type, idempotency_key) returns one row.
--
-- Run via: supabase test db
BEGIN;
SELECT plan(22);

-- ---- Fixture: one human admin + one machine actor --------------------------
INSERT INTO public.admin_users (id, email, role, is_machine_actor) VALUES
  ('a1111111-1111-1111-1111-111111111111', 'human@example.invalid',  'admin', false),
  ('a2222222-2222-2222-2222-222222222222', 'agent@example.invalid',  'admin', true);

SELECT is(
  has_table_privilege('service_role', 'public.admin_audit_events', privilege),
  privilege = 'SELECT',
  'runtime audit privilege: ' || privilege
)
FROM (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'),
  ('REFERENCES'), ('TRIGGER')) AS privileges(privilege);

SELECT results_eq(
  $$ SELECT privilege_type::text FROM pg_catalog.pg_class c
     CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a
     WHERE c.oid = 'public.admin_audit_events'::regclass
       AND a.grantee = 'service_role'::regrole ORDER BY 1 $$,
  $$ VALUES ('SELECT'::text) $$,
  'runtime table grant is exactly SELECT, including version-specific privileges'
);

SET LOCAL ROLE service_role;

-- ===========================================================================
-- explicit actor → one row written, actor recorded, actor_kind derived = human
-- ===========================================================================
SELECT lives_ok(
  $$ SELECT public.record_admin_audit_event(
       'a1111111-1111-1111-1111-111111111111', 'role_change', 'admin_ui',
       'admin_user', 'e-1', NULL, jsonb_build_object('role','distributor')) $$,
  'human actor can write an audit row via the primitive');

SELECT is(
  (SELECT count(*)::int FROM public.admin_audit_events
     WHERE entity_type = 'admin_user' AND entity_id = 'e-1'),
  1, 'exactly one audit row written');

SELECT is(
  (SELECT actor_kind FROM public.admin_audit_events WHERE entity_id = 'e-1'),
  'human', 'actor_kind derived as human from admin_users');

-- machine actor → actor_kind derived = machine (caller cannot spoof it)
SELECT lives_ok(
  $$ SELECT public.record_admin_audit_event(
       'a2222222-2222-2222-2222-222222222222', 'role_change', 'mcp_agent',
       'admin_user', 'e-2', NULL, jsonb_build_object('x',1)) $$,
  'machine actor can write an audit row');

SELECT is(
  (SELECT actor_kind FROM public.admin_audit_events WHERE entity_id = 'e-2'),
  'machine', 'actor_kind derived as machine from admin_users.is_machine_actor');

-- ===========================================================================
-- NULL actor and unknown actor both RAISE 42501 (the abort-prevention boundary)
-- ===========================================================================
SELECT throws_ok(
  $$ SELECT public.record_admin_audit_event(
       NULL, 'role_change', 'system', 'admin_user', 'e-x', NULL, NULL) $$,
  '42501', 'audit_actor_required', 'NULL actor is rejected');

SELECT throws_ok(
  $$ SELECT public.record_admin_audit_event(
       'a9999999-9999-9999-9999-999999999999', 'role_change', 'system',
       'admin_user', 'e-y', NULL, NULL) $$,
  '42501', 'audit_actor_unknown', 'unknown actor is rejected');

-- ===========================================================================
-- idempotent replay: same (entity_type, idempotency_key) → still one row
-- ===========================================================================
SELECT public.record_admin_audit_event(
  'a1111111-1111-1111-1111-111111111111', 'role_change', 'mcp_agent',
  'catalog_sku', 'sku-1', NULL, jsonb_build_object('n',1), 'idem-key-1');
SELECT public.record_admin_audit_event(
  'a1111111-1111-1111-1111-111111111111', 'role_change', 'mcp_agent',
  'catalog_sku', 'sku-1', NULL, jsonb_build_object('n',1), 'idem-key-1');

SELECT is(
  (SELECT count(*)::int FROM public.admin_audit_events
     WHERE entity_type = 'catalog_sku' AND idempotency_key = 'idem-key-1'),
  1, 'idempotent replay writes exactly one row');

-- A writable session setting cannot authorize a direct table mutation.
SELECT set_config('app.audit_via_fn', 'true', true);
SELECT set_config('app.admin_oms_preview_fixture_cleanup', 'true', true);

SELECT throws_ok(command, '42501', 'permission denied for table admin_audit_events',
  'runtime cannot directly mutate completed audit evidence')
FROM (VALUES
  ($$ INSERT INTO public.admin_audit_events(actor_admin_id, actor_email, action)
      VALUES ('a1111111-1111-1111-1111-111111111111', 'forged@example.invalid', 'role_change') $$),
  ($$ UPDATE public.admin_audit_events SET actor_email = 'forged@example.invalid' WHERE entity_id = 'e-1' $$),
  ($$ DELETE FROM public.admin_audit_events WHERE entity_id = 'e-1' $$),
  ($$ TRUNCATE TABLE public.admin_audit_events $$)
) AS attempts(command);

SELECT is((SELECT count(*)::integer FROM public.admin_audit_events
  WHERE actor_admin_id IN ('a1111111-1111-1111-1111-111111111111', 'a2222222-2222-2222-2222-222222222222')),
  3, 'all three fixture audit rows survive refused direct writes');
SELECT is((SELECT actor_email FROM public.admin_audit_events WHERE entity_id = 'e-1'),
  'human@example.invalid', 'refused update retains original audit evidence');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
