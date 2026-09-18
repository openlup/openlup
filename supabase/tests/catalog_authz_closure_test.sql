-- pgTAP: the three live catalog fact tables are no longer writable from a
-- browser session, and the four that only looked writable are still inert.
--
-- This file proves the outcome, not the migration. Reading either half of the
-- catalogue alone gives the wrong answer, and that is the whole reason W3f-d
-- exists: `catalog_bundles`, `catalog_bundle_components`,
-- `catalog_bundle_prices` and `catalog_sku_eans` carry the same PERMISSIVE
-- `FOR ALL` admin policy as the three closed tables and no `authenticated`
-- table grant behind it, so a policy-only reading calls seven tables open and a
-- grant-only reading calls four of them protected for a reason that does not
-- exist. Only the intersection is the truth, so both halves are asserted here
-- for all seven.
--
-- Three deliberate choices about how the assertions are written:
--
--   * Privileges are compared as SETS, over the full PostgreSQL 17 privilege
--     vocabulary and over both browser roles at once. A negative assertion that
--     samples one role or one privilege passes while a second role or a
--     forgotten privilege holds the grant - this repository has already shipped
--     that defect once, in a negative GRANT regex that only ever matched the
--     first role named on the line. Nothing here reads migration text.
--   * The behavioural refusals name the error MESSAGE, not only `42501`. Row
--     level security refuses a browser INSERT with `42501` too, so an
--     errcode-only assertion would keep passing on a table whose write grant
--     had been handed back and whose policy happened to refuse instead. The
--     `TRUNCATE` cases need no message: no policy governs a whole-table
--     statement, so only the withdrawn grant can refuse one - which is what
--     makes them the assertions that discriminate on privilege alone.
--   * The eight fenced RPCs are asserted STRUCTURALLY, through `proacl` and
--     `has_function_privilege`, and never by attempting the denied call. Taking
--     a browser role and calling a routine whose EXECUTE was withdrawn
--     segfaults the backend through the `supautils.hint_roles` permission-denied
--     hint path and puts the database into recovery.
--
-- What the old shape actually admitted, measured on the same database rather
-- than reasoned from the policy text, because the two differ: an active
-- administrator, an active `is_machine_actor` administrator and an active
-- `distributor` all read AND wrote these three tables. A revoked administrator
-- did not - the inlined `EXISTS` reads `admin_users` under that table's own RLS,
-- and `admin_select_admin_users` already carries the `membership_state`
-- test. So the revocation held, but only by borrowing another table's policy
-- shape; the assertions below pin it where the policy now states it itself.
--
-- ⚠️ One thing this file deliberately does NOT claim. `is_admin_user()` is
-- revocation-aware and role-aware but it is NOT machine-actor aware: an active
-- `is_machine_actor` administrator satisfies it. So the machine actor is closed
-- out of these three tables by the withdrawn write privilege, and its read is
-- still admitted. That state is pinned below as it is rather than asserted away,
-- because an assertion that a machine actor "is refused" would have been true
-- for the wrong reason and would have hidden the real boundary, which lives in
-- `catalog_publication_require_human_admin()` inside the publication RPCs.
--
-- Resolution runs before privilege, as in `catalog_document_seam_grants_test.sql`:
-- `has_table_privilege` and `has_function_privilege` yield NULL rather than an
-- error for an unresolvable identity, so a renamed or dropped object would let
-- every assertion below pass vacuously.
BEGIN;
SELECT plan(25);

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------

CREATE TEMP TABLE catalog_authz_relation (
  ident text PRIMARY KEY,
  closed boolean NOT NULL
) ON COMMIT DROP;

INSERT INTO catalog_authz_relation (ident, closed) VALUES
  -- Closed by this wave: the signed-in role held the whole inherited set and an
  -- `ALL` policy that admitted any admin_users row.
  ('public.catalog_products', true),
  ('public.catalog_skus', true),
  ('public.catalog_prices', true),
  -- Already inert and left exactly as they are: same `ALL` policy, no
  -- `authenticated` table grant, so the policy admits nobody. These are the
  -- control that catches a later "alignment" adding a grant to match a policy.
  ('public.catalog_bundles', false),
  ('public.catalog_bundle_components', false),
  ('public.catalog_bundle_prices', false),
  ('public.catalog_sku_eans', false);

CREATE TEMP TABLE catalog_authz_fenced_routine (
  proname text PRIMARY KEY
) ON COMMIT DROP;

INSERT INTO catalog_authz_fenced_routine (proname) VALUES
  ('admin_upsert_catalog_draft'),
  ('admin_set_catalog_price'),
  ('admin_archive_catalog_sku'),
  ('admin_activate_catalog_product'),
  ('admin_archive_catalog_product'),
  ('admin_restore_catalog_product'),
  ('admin_deactivate_catalog_product'),
  ('admin_set_subscription_band_percent');

-- The full PostgreSQL 17 table privilege vocabulary. `MAINTAIN` is in the list
-- on purpose: the schema default hands it out with the rest, so an enumeration
-- that stops at the six familiar write privileges leaves it standing.
CREATE TEMP TABLE catalog_authz_privilege (
  privilege text PRIMARY KEY
) ON COMMIT DROP;

INSERT INTO catalog_authz_privilege (privilege) VALUES
  ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'),
  ('TRUNCATE'), ('REFERENCES'), ('TRIGGER'), ('MAINTAIN');

INSERT INTO public.admin_users (id, email, role, is_machine_actor) VALUES
  ('c3fd0000-0000-4000-8000-000000000001', 'authz-human-admin@example.invalid', 'admin', false),
  ('c3fd0000-0000-4000-8000-000000000002', 'authz-machine-admin@example.invalid', 'admin', true),
  ('c3fd0000-0000-4000-8000-000000000003', 'authz-distributor@example.invalid', 'distributor', false);
INSERT INTO public.admin_users (
  id, email, role, is_machine_actor,
  membership_state, membership_revoked_at, membership_revoked_by, membership_revocation_reason
) VALUES (
  'c3fd0000-0000-4000-8000-000000000004', 'authz-revoked-admin@example.invalid', 'admin', false,
  'revoked', now(), 'c3fd0000-0000-4000-8000-000000000001', 'offboarded, row retained for audit'
);

INSERT INTO public.catalog_products (id, slug, name, status) VALUES
  ('c3fd0000-0000-4000-8000-000000000011', 'w3f-d-authz-closure-probe', 'Authz closure probe', 'active');
INSERT INTO public.catalog_skus (id, product_id, sku, title, pet_type, net_weight_g, kcal_per_unit, status) VALUES
  ('c3fd0000-0000-4000-8000-000000000021', 'c3fd0000-0000-4000-8000-000000000011',
   'W3F-D-AUTHZ-CLOSURE-PROBE', 'Authz closure probe', 'dog', 400, 480, 'active');
INSERT INTO public.catalog_prices (id, sku_id, currency, amount_cents, price_type, active) VALUES
  ('c3fd0000-0000-4000-8000-000000000031', 'c3fd0000-0000-4000-8000-000000000021',
   'PLN', 1490, 'one_time', true);

-- ---------------------------------------------------------------------------
-- Non-vacuity
-- ---------------------------------------------------------------------------

SELECT is(
  (SELECT string_agg(ident, ', ' ORDER BY ident)
     FROM catalog_authz_relation WHERE to_regclass(ident) IS NULL),
  NULL,
  'every pinned catalog relation resolves, so no privilege assertion below can pass vacuously'
);

SELECT is(
  (SELECT string_agg(routine.proname, ', ' ORDER BY routine.proname)
     FROM catalog_authz_fenced_routine AS routine
    WHERE (SELECT count(*) FROM pg_proc AS proc
             JOIN pg_namespace AS ns ON ns.oid = proc.pronamespace
            WHERE ns.nspname = 'public' AND proc.proname = routine.proname) <> 1),
  NULL,
  'every fenced catalog RPC resolves to exactly one identity, so no EXECUTE assertion reads an overload the fence never covered'
);

-- Guards the fixtures themselves: deleting a row would silently shrink every
-- assertion below to the identities that still happen to be listed.
SELECT is(
  (SELECT (SELECT count(*) FROM catalog_authz_relation)::text || '/'
       || (SELECT count(*) FROM catalog_authz_relation WHERE closed)::text || '/'
       || (SELECT count(*) FROM catalog_authz_fenced_routine)::text || '/'
       || (SELECT count(*) FROM catalog_authz_privilege)::text),
  '7/3/8/8',
  'the fixtures pin all seven catalog tables, the three this wave closes, all eight fenced RPCs and the full privilege vocabulary'
);

-- ---------------------------------------------------------------------------
-- Table privilege, compared as sets over both browser roles
-- ---------------------------------------------------------------------------

SELECT is(
  (SELECT string_agg(rel.ident, ', ' ORDER BY rel.ident)
     FROM catalog_authz_relation AS rel
    WHERE rel.closed
      AND has_table_privilege('authenticated', rel.ident, 'SELECT') IS NOT TRUE),
  NULL,
  'the signed-in role still reads all three closed tables, so this wave narrowed the write edge without taking the read away'
);

-- The core negative. One assertion over the whole product of tables and
-- privileges, so a regression names the table and the privilege that came back
-- instead of collapsing to a bare count.
SELECT is(
  (SELECT string_agg(rel.ident || ':' || priv.privilege, ', ' ORDER BY rel.ident, priv.privilege)
     FROM catalog_authz_relation AS rel
     CROSS JOIN catalog_authz_privilege AS priv
    WHERE rel.closed
      AND priv.privilege <> 'SELECT'
      AND has_table_privilege('authenticated', rel.ident, priv.privilege)),
  NULL,
  'the signed-in role holds no INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER or MAINTAIN on any of the three closed tables'
);

SELECT is(
  (SELECT string_agg(rel.ident || ':' || priv.privilege, ', ' ORDER BY rel.ident, priv.privilege)
     FROM catalog_authz_relation AS rel
     CROSS JOIN catalog_authz_privilege AS priv
    WHERE NOT rel.closed
      AND has_table_privilege('authenticated', rel.ident, priv.privilege)),
  NULL,
  'the four inert bundle and EAN tables still grant the signed-in role nothing at all, so their ALL policy continues to admit nobody'
);

SELECT is(
  (SELECT string_agg(rel.ident || ':' || priv.privilege, ', ' ORDER BY rel.ident, priv.privilege)
     FROM catalog_authz_relation AS rel
     CROSS JOIN catalog_authz_privilege AS priv
    WHERE has_table_privilege('anon', rel.ident, priv.privilege)),
  NULL,
  'the anonymous role holds no privilege at all on any of the seven catalog tables'
);

-- Grantee-set equality. The privilege cross-join above answers "what does this
-- role hold"; this answers "who holds anything at all", which is the half that
-- catches a grant arriving for a role nobody thought to enumerate.
SELECT is(
  (SELECT string_agg(rel.ident || ' -> ' || coalesce(g.grantees, '(none)'), E'\n' ORDER BY rel.ident)
     FROM catalog_authz_relation AS rel
     CROSS JOIN LATERAL (
       SELECT string_agg(DISTINCT entry.grantee::regrole::text, ',' ORDER BY entry.grantee::regrole::text) AS grantees
         FROM pg_class AS c
         CROSS JOIN LATERAL aclexplode(c.relacl) AS entry
        WHERE c.oid = rel.ident::regclass
     ) AS g),
  'public.catalog_bundle_components -> postgres,service_role,openlup_mcp_reader' || E'\n' ||
  'public.catalog_bundle_prices -> postgres,service_role,openlup_mcp_reader' || E'\n' ||
  'public.catalog_bundles -> postgres,service_role,openlup_mcp_reader' || E'\n' ||
  'public.catalog_prices -> authenticated,postgres,service_role,openlup_mcp_reader' || E'\n' ||
  'public.catalog_products -> authenticated,postgres,service_role,openlup_mcp_reader' || E'\n' ||
  'public.catalog_sku_eans -> postgres,service_role,openlup_mcp_reader' || E'\n' ||
  'public.catalog_skus -> authenticated,postgres,service_role,openlup_mcp_reader',
  'exactly the four expected roles hold anything on the closed tables and exactly three on the inert ones, so no unenumerated grantee appeared'
);

-- The roles this wave is not allowed to touch, asserted rather than assumed.
SELECT is(
  (SELECT string_agg(rel.ident || ':' || priv.privilege, ', ' ORDER BY rel.ident, priv.privilege)
     FROM catalog_authz_relation AS rel
     CROSS JOIN catalog_authz_privilege AS priv
    WHERE has_table_privilege('service_role', rel.ident, priv.privilege) IS NOT TRUE),
  NULL,
  'the runtime role keeps the whole privilege set on all seven catalog tables, so no server read or write path was narrowed by this wave'
);

SELECT is(
  (SELECT string_agg(rel.ident || ':' || priv.privilege, ', ' ORDER BY rel.ident, priv.privilege)
     FROM catalog_authz_relation AS rel
     CROSS JOIN catalog_authz_privilege AS priv
    WHERE has_table_privilege('openlup_mcp_reader', rel.ident, priv.privilege) <> (priv.privilege = 'SELECT')),
  NULL,
  'the managed MCP reader still holds exactly SELECT and nothing else on all seven catalog tables'
);

-- ---------------------------------------------------------------------------
-- Policy, so privilege and policy cannot disagree again
-- ---------------------------------------------------------------------------

SELECT is(
  (SELECT string_agg(
            tablename || '|' || policyname || '|' || permissive || '|' || cmd
              || '|' || coalesce(qual, '-') || '|' || coalesce(with_check, '-'),
            E'\n' ORDER BY tablename)
     FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN ('catalog_products', 'catalog_skus', 'catalog_prices')
      AND roles = '{authenticated}'::name[]),
  'catalog_prices|admin_select_catalog_prices|PERMISSIVE|SELECT|is_admin_user()|-' || E'\n' ||
  'catalog_products|admin_select_catalog_products|PERMISSIVE|SELECT|is_admin_user()|-' || E'\n' ||
  'catalog_skus|admin_select_catalog_skus|PERMISSIVE|SELECT|is_admin_user()|-',
  'each closed table carries exactly one signed-in policy: SELECT only, no WITH CHECK, and the shared revocation-aware predicate rather than an inlined copy of it'
);

SELECT is(
  (SELECT string_agg(tablename || '|' || policyname || '|' || cmd, E'\n' ORDER BY tablename)
     FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN ('catalog_bundles', 'catalog_bundle_components',
                        'catalog_bundle_prices', 'catalog_sku_eans')
      AND roles = '{authenticated}'::name[]),
  'catalog_bundle_components|admin_all_catalog_bundle_components|ALL' || E'\n' ||
  'catalog_bundle_prices|admin_all_catalog_bundle_prices|ALL' || E'\n' ||
  'catalog_bundles|admin_all_catalog_bundles|ALL' || E'\n' ||
  'catalog_sku_eans|admin_all_catalog_sku_eans|ALL',
  'the four inert tables keep the ALL policy they had, so this wave changed privileges and policies on exactly the three tables it measured'
);

SELECT is(
  (SELECT string_agg(rel.ident, ', ' ORDER BY rel.ident)
     FROM catalog_authz_relation AS rel
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_policies AS p
       WHERE p.schemaname = 'public'
         AND p.tablename = split_part(rel.ident, '.', 2)
         AND p.policyname = 'openlup_mcp_reader_select'
         AND p.cmd = 'SELECT')),
  NULL,
  'every catalog table still carries its openlup_mcp_reader_select policy, so the managed reader was not collateral damage'
);

-- ---------------------------------------------------------------------------
-- Behaviour. The catalogue assertions above would all still pass if a browser
-- session reached these tables as some other principal, so take the role and
-- let the server answer.
-- ---------------------------------------------------------------------------

SELECT set_config('request.jwt.claims',
  '{"sub":"c3fd0000-0000-4000-8000-000000000001","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;

SELECT is(
  (SELECT (SELECT count(*)::integer FROM public.catalog_products WHERE slug = 'w3f-d-authz-closure-probe')::text || '/'
       || (SELECT count(*)::integer FROM public.catalog_skus WHERE sku = 'W3F-D-AUTHZ-CLOSURE-PROBE')::text || '/'
       || (SELECT count(*)::integer FROM public.catalog_prices WHERE id = 'c3fd0000-0000-4000-8000-000000000031')::text),
  '1/1/1',
  'an active human administrator still reads all three closed tables, so the admin panel read path survived the narrowing'
);

SELECT throws_ok(
  $$INSERT INTO public.catalog_products (slug, name, status)
    VALUES ('w3f-d-authz-forged', 'Forged', 'active')$$,
  '42501', 'permission denied for table catalog_products',
  'an active human administrator cannot insert a product directly - refused by the withdrawn privilege, not by a policy that could be widened back'
);

SELECT throws_ok(
  $$UPDATE public.catalog_prices SET amount_cents = 1$$,
  '42501', 'permission denied for table catalog_prices',
  'an active human administrator cannot reprice a SKU directly, so the revisioned document authority stays the only writer'
);

SELECT throws_ok(
  $$DELETE FROM public.catalog_skus$$,
  '42501', 'permission denied for table catalog_skus',
  'an active human administrator cannot delete SKUs directly'
);

-- No policy governs a whole-table statement, so only the withdrawn grant can
-- refuse this one. It is the assertion that cannot be satisfied by RLS.
SELECT throws_ok(
  $$TRUNCATE public.catalog_prices$$,
  '42501', NULL,
  'emptying the price table is refused by the withdrawn grant alone, which no row level policy could have done'
);

RESET ROLE;

SELECT set_config('request.jwt.claims',
  '{"sub":"c3fd0000-0000-4000-8000-000000000004","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;

SELECT is(
  (SELECT (SELECT count(*)::integer FROM public.catalog_products)::text || '/'
       || (SELECT count(*)::integer FROM public.catalog_skus)::text || '/'
       || (SELECT count(*)::integer FROM public.catalog_prices)::text),
  '0/0/0',
  'a revoked administrator whose row is retained for audit reads nothing at all, now stated by the policy itself rather than borrowed from another table RLS'
);

SELECT throws_ok(
  $$TRUNCATE public.catalog_products$$,
  '42501', NULL,
  'a revoked administrator is refused at the privilege layer as well as the policy layer'
);

RESET ROLE;

SELECT set_config('request.jwt.claims',
  '{"sub":"c3fd0000-0000-4000-8000-000000000003","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;

SELECT is(
  (SELECT count(*)::integer FROM public.catalog_products),
  0,
  'an active distributor reads nothing - it read and wrote these tables before this wave, and the role test in is_admin_user() is what closes it'
);

RESET ROLE;

SELECT set_config('request.jwt.claims',
  '{"sub":"c3fd0000-0000-4000-8000-000000000002","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;

SELECT throws_ok(
  $$INSERT INTO public.catalog_prices (sku_id, currency, amount_cents, price_type, active)
    VALUES ('c3fd0000-0000-4000-8000-000000000021', 'PLN', 1, 'one_time', true)$$,
  '42501', 'permission denied for table catalog_prices',
  'a machine actor cannot write a catalog price - the sentence the master plan asked this wave to prove, and the withdrawn privilege is what proves it'
);

-- ⚠️ Pinned as it is, not asserted away. `is_admin_user()` tests membership and
-- role, not actor kind, so the machine admin still READS. Writing this as a
-- refusal would have passed for the wrong reason and hidden where the real
-- machine-actor boundary lives.
SELECT is(
  (SELECT count(*)::integer FROM public.catalog_products WHERE slug = 'w3f-d-authz-closure-probe'),
  1,
  'a machine actor still reads these tables, because is_admin_user() is revocation-aware but deliberately not machine-actor aware'
);

RESET ROLE;

-- ---------------------------------------------------------------------------
-- The eight W3c-fenced RPCs, pinned structurally so a returning grant is red
-- ---------------------------------------------------------------------------

SELECT is(
  (SELECT string_agg(DISTINCT routine.proname || ' -> ' || coalesce(g.grantees, '(none)'), E'\n'
            ORDER BY routine.proname || ' -> ' || coalesce(g.grantees, '(none)'))
     FROM catalog_authz_fenced_routine AS routine
     JOIN pg_proc AS proc ON proc.proname = routine.proname
     JOIN pg_namespace AS ns ON ns.oid = proc.pronamespace AND ns.nspname = 'public'
     CROSS JOIN LATERAL (
       SELECT string_agg(DISTINCT entry.grantee::regrole::text, ',' ORDER BY entry.grantee::regrole::text) AS grantees
         FROM aclexplode(proc.proacl) AS entry
     ) AS g
    WHERE coalesce(g.grantees, '(none)') <> 'postgres,service_role'),
  NULL,
  'every fenced catalog RPC still holds EXECUTE for exactly postgres and service_role, so a browser-role grant coming back is red rather than invisible'
);

SELECT is(
  (SELECT string_agg(routine.proname || ':' || browser.role_name, ', '
            ORDER BY routine.proname, browser.role_name)
     FROM catalog_authz_fenced_routine AS routine
     JOIN pg_proc AS proc ON proc.proname = routine.proname
     JOIN pg_namespace AS ns ON ns.oid = proc.pronamespace AND ns.nspname = 'public'
     CROSS JOIN (VALUES ('anon'), ('authenticated')) AS browser(role_name)
    WHERE has_function_privilege(browser.role_name, proc.oid, 'EXECUTE') IS NOT FALSE),
  NULL,
  'neither browser role can execute any fenced catalog RPC, asserted through the catalogue because taking the role and calling it crashes the backend'
);

SELECT * FROM finish();
ROLLBACK;
