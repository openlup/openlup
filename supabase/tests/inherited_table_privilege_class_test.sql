-- pgTAP: the inherited whole-table privilege class is withdrawn where it was never earned -
-- the runtime role keeps only read on the five provider evidence tables pinned below, both
-- browser roles hold nothing at all on the subscription event ledger, and the schema default
-- that handed all of it out no longer grants a browser role anything beyond read on a newly
-- created table.
--
-- The gap this pins is not a missing statement but a statement that does nothing. This
-- platform's default privileges hand `anon`, `authenticated` and `service_role` the full
-- `arwdDxtm` set on every new table in `public` at creation time, so a narrow
-- `GRANT SELECT, INSERT` on a fresh table is additive to a grant that already contains
-- everything, and a `REVOKE ALL ... FROM PUBLIC` next to it withdraws a grant `PUBLIC` never
-- held. The predecessor wave closed that class on seven append-only ledgers one table at a
-- time; this wave closes it on the five provider evidence tables, on the subscription event
-- ledger's browser reachability, and - the part that stops the class regrowing - at the
-- default itself.
--
-- WHY READ-ONLY IS THE RIGHT WIDTH FOR THOSE FIVE. Every writer into those five is
-- SECURITY DEFINER and therefore runs as the owner, whose privileges no grant restricts, so
-- the runtime credential needs no write privilege of its own to keep the sync and evidence
-- paths working. That argument is only true while those routines stay definer-rights, so the
-- `prosecdef` assertion below is the tripwire: if one became invoker-rights, it would spend
-- the caller's privileges, the narrowing would silently break it, and this suite - not
-- production - is where that shows up.
--
-- Every assertion reads the real catalog or takes the role itself; none of it trusts a
-- migration's REVOKE line. The role-based half matters on its own, because a catalogue
-- assertion would still pass if the runtime reached these tables as some other principal.
-- The default-privilege half is asserted functionally as well as textually: a throwaway
-- table created inside this transaction proves the default actually applies to new tables,
-- rather than proving only that the catalogue text changed.
BEGIN;
SELECT plan(23);

CREATE TEMP TABLE narrowed_table (
  ident text PRIMARY KEY,
  narrowed_principal text NOT NULL
) ON COMMIT DROP;

INSERT INTO narrowed_table (ident, narrowed_principal) VALUES
  -- The provider evidence surface: written only by definer-rights routines, read by
  -- operator surfaces and the sync reconciliation, so the runtime role keeps SELECT alone.
  ('public.omnipack_status_evidence', 'service_role'),
  ('public.omnipack_low_stock_evidence', 'service_role'),
  ('public.omnipack_product_reconciliation_evidence', 'service_role'),
  ('public.omnipack_stock_snapshots', 'service_role'),
  ('public.omnipack_stock_sync_cursors', 'service_role'),
  -- Never reached from a browser by design; the inherited grant was the only reason a
  -- signed-in or anonymous visitor could have read, forged or emptied a subscription's
  -- event history at all.
  ('public.subscription_events', 'anon and authenticated');

CREATE TEMP TABLE definer_write_routine (
  proname text PRIMARY KEY
) ON COMMIT DROP;

INSERT INTO definer_write_routine (proname) VALUES
  ('omnipack_record_status_evidence'),
  ('omnipack_record_stock_snapshot'),
  ('omnipack_record_low_stock_evidence'),
  ('omnipack_record_product_reconciliation_evidence'),
  ('omnipack_upsert_stock_sync_cursor'),
  ('omnipack_resolve_low_stock_evidence'),
  ('omnipack_resolve_product_reconciliation_evidence');

-- Resolution runs first: `has_table_privilege` yields NULL rather than an error for an
-- unresolvable identity, so a renamed or dropped table would let every privilege assertion
-- below pass vacuously.
SELECT is(
  (SELECT string_agg(ident, ', ' ORDER BY ident)
     FROM narrowed_table WHERE to_regclass(ident) IS NULL),
  NULL,
  'every pinned table identity resolves, so the privilege assertions cannot pass vacuously'
);

SELECT is(
  (SELECT string_agg(routine.proname, ', ' ORDER BY routine.proname)
     FROM definer_write_routine AS routine
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_proc AS proc
       JOIN pg_namespace AS ns ON ns.oid = proc.pronamespace
      WHERE ns.nspname = 'public' AND proc.proname = routine.proname)),
  NULL,
  'every pinned write routine still exists, so the security-context assertion cannot pass vacuously'
);

-- Guards the fixtures themselves: dropping a row would silently shrink the proof to the
-- identities that still happen to be listed.
SELECT is(
  (SELECT (SELECT count(*) FROM narrowed_table)::text || '/'
       || (SELECT count(*) FROM definer_write_routine)::text),
  '6/7',
  'the fixtures pin all six tables this narrowing covers and all seven definer write routines'
);

SELECT is(
  (SELECT string_agg(ident, ', ' ORDER BY ident)
     FROM narrowed_table
    WHERE narrowed_principal = 'service_role'
      AND has_table_privilege('service_role', ident, 'SELECT') IS NOT TRUE),
  NULL,
  'the runtime role can still read every pinned provider evidence table, so the operator and reconciliation reads keep working'
);

-- One assertion over the whole product of tables and write privileges, so a regression names
-- the table and the privilege that came back rather than a bare count.
SELECT is(
  (SELECT string_agg(narrowed.ident || ':' || candidate.privilege, ', '
            ORDER BY narrowed.ident, candidate.privilege)
     FROM narrowed_table AS narrowed
     CROSS JOIN (VALUES ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) AS candidate(privilege)
    WHERE narrowed.narrowed_principal = 'service_role'
      AND has_table_privilege('service_role', narrowed.ident, candidate.privilege)),
  NULL,
  'the runtime role holds no INSERT, UPDATE, DELETE or TRUNCATE on any of the five pinned provider evidence tables'
);

-- The tripwire for the whole read-only argument: every writer runs as the owner, so the
-- runtime role needs no write privilege. An invoker-rights routine here would spend the
-- caller's privileges instead and break under the narrowing above.
SELECT is(
  (SELECT string_agg(proc.proname || '(' || pg_get_function_identity_arguments(proc.oid) || ')', ', '
            ORDER BY proc.proname)
     FROM definer_write_routine AS routine
     JOIN pg_proc AS proc ON proc.proname = routine.proname
     JOIN pg_namespace AS ns ON ns.oid = proc.pronamespace
    WHERE ns.nspname = 'public' AND NOT proc.prosecdef),
  NULL,
  'every pinned provider write routine is still SECURITY DEFINER, so the read-only grant cannot have broken a write path'
);

SELECT is(
  (SELECT string_agg(candidate.privilege, ', ' ORDER BY candidate.privilege)
     FROM (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) AS candidate(privilege)
    WHERE has_table_privilege('anon', 'public.subscription_events', candidate.privilege)),
  NULL,
  'anon holds no privilege at all on the subscription event ledger'
);

SELECT is(
  (SELECT string_agg(candidate.privilege, ', ' ORDER BY candidate.privilege)
     FROM (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) AS candidate(privilege)
    WHERE has_table_privilege('authenticated', 'public.subscription_events', candidate.privilege)),
  NULL,
  'authenticated holds no privilege at all on the subscription event ledger'
);

-- The runtime role's grant on this ledger is deliberately untouched by this wave: the
-- subscription engine appends event rows under the runtime credential, and withdrawing its
-- DELETE is a separate wave with its own writer audit.
SELECT is(
  (SELECT string_agg(candidate.privilege, ', ' ORDER BY candidate.privilege)
     FROM (VALUES ('SELECT'), ('INSERT')) AS candidate(privilege)
    WHERE has_table_privilege('service_role', 'public.subscription_events', candidate.privilege) IS NOT TRUE),
  NULL,
  'the runtime role still reads and appends to the subscription event ledger, which this wave leaves alone'
);

-- Part C: the default that created the class. Only the entry whose owning role matches the
-- role that creates the table applies, and every migration in this repository runs as
-- `postgres`, so that entry is the reachable one.
SELECT is(
  (SELECT count(*)::integer
     FROM pg_default_acl AS acl
     JOIN pg_namespace AS ns ON ns.oid = acl.defaclnamespace
    WHERE ns.nspname = 'public'
      AND acl.defaclobjtype = 'r'
      AND pg_get_userbyid(acl.defaclrole) = 'postgres'),
  1,
  'the reachable default table ACL entry for the public schema still exists, so the assertions below read something'
);

SELECT is(
  (SELECT string_agg(entry.grantee::regrole::text || ':' || entry.privilege_type, ', '
            ORDER BY entry.grantee::regrole::text, entry.privilege_type)
     FROM pg_default_acl AS acl
     JOIN pg_namespace AS ns ON ns.oid = acl.defaclnamespace
     CROSS JOIN LATERAL aclexplode(acl.defaclacl) AS entry
    WHERE ns.nspname = 'public'
      AND acl.defaclobjtype = 'r'
      AND pg_get_userbyid(acl.defaclrole) = 'postgres'
      AND entry.grantee::regrole::text IN ('anon', 'authenticated')
      AND entry.privilege_type <> 'SELECT'),
  NULL,
  'the reachable default no longer hands a browser role anything beyond SELECT on a new public table'
);

SELECT is(
  (SELECT string_agg(browser.role_name, ', ' ORDER BY browser.role_name)
     FROM (VALUES ('anon'), ('authenticated')) AS browser(role_name)
    WHERE NOT EXISTS (
      SELECT 1
        FROM pg_default_acl AS acl
        JOIN pg_namespace AS ns ON ns.oid = acl.defaclnamespace
        CROSS JOIN LATERAL aclexplode(acl.defaclacl) AS entry
       WHERE ns.nspname = 'public'
         AND acl.defaclobjtype = 'r'
         AND pg_get_userbyid(acl.defaclrole) = 'postgres'
         AND entry.grantee::regrole::text = browser.role_name
         AND entry.privilege_type = 'SELECT')),
  NULL,
  'the reachable default still grants SELECT to both browser roles, so RLS remains the read control rather than a missing grant'
);

-- The strongest form of the Part C claim: create a table and read what it actually got. This
-- refuses to pass on a catalogue text change that does not reach table creation.
CREATE TABLE public.inherited_privilege_class_probe (id integer);

SELECT is(
  (SELECT string_agg(entry.grantee::regrole::text || ':' || entry.privilege_type, ', '
            ORDER BY entry.grantee::regrole::text, entry.privilege_type)
     FROM pg_class AS rel
     CROSS JOIN LATERAL aclexplode(coalesce(rel.relacl, acldefault('r', rel.relowner))) AS entry
    WHERE rel.oid = 'public.inherited_privilege_class_probe'::regclass
      AND entry.grantee::regrole::text IN ('anon', 'authenticated')
      AND entry.privilege_type <> 'SELECT'),
  NULL,
  'a table created now grants a browser role nothing beyond SELECT, so the default really applies to new tables'
);

SELECT is(
  (SELECT string_agg(browser.role_name, ', ' ORDER BY browser.role_name)
     FROM (VALUES ('anon'), ('authenticated')) AS browser(role_name)
    WHERE NOT EXISTS (
      SELECT 1
        FROM pg_class AS rel
        CROSS JOIN LATERAL aclexplode(coalesce(rel.relacl, acldefault('r', rel.relowner))) AS entry
       WHERE rel.oid = 'public.inherited_privilege_class_probe'::regclass
         AND entry.grantee::regrole::text = browser.role_name
         AND entry.privilege_type = 'SELECT')),
  NULL,
  'a table created now still grants SELECT to both browser roles, so the narrowing did not silently take reads away'
);

DROP TABLE public.inherited_privilege_class_probe;

-- The named residual gap. A table created by the administrative role named below - a
-- dashboard table editor action, not a migration - still inherits the wide set, because that role owns its own
-- default ACL entry and this wave does not alter another role's defaults. Asserting the hole
-- is still exactly this shape keeps it a documented residual rather than a silent one, and
-- turns the day somebody closes it into a deliberate edit here.
SELECT is(
  (SELECT string_agg(expected.role_name || ':' || expected.privilege, ', '
            ORDER BY expected.role_name, expected.privilege)
     FROM (VALUES ('anon'), ('authenticated')) AS browser(role_name)
     CROSS JOIN (VALUES ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) AS candidate(privilege)
     CROSS JOIN LATERAL (SELECT browser.role_name, candidate.privilege) AS expected
    WHERE NOT EXISTS (
      SELECT 1
        FROM pg_default_acl AS acl
        JOIN pg_namespace AS ns ON ns.oid = acl.defaclnamespace
        CROSS JOIN LATERAL aclexplode(acl.defaclacl) AS entry
       WHERE ns.nspname = 'public'
         AND acl.defaclobjtype = 'r'
         AND pg_get_userbyid(acl.defaclrole) = 'supabase_admin'
         AND entry.grantee::regrole::text = expected.role_name
         AND entry.privilege_type = expected.privilege)),
  NULL,
  'the administrative-role-owned default is still wide - the named residual gap this wave does not close'
);

-- The catalogue assertions above would still pass if the runtime reached these tables as some
-- other principal, so take the role the runtime actually carries and let the server refuse.
SET LOCAL ROLE service_role;

SELECT throws_ok(
  $$INSERT INTO public.omnipack_status_evidence DEFAULT VALUES$$,
  '42501',
  NULL,
  'as service_role, appending a status evidence row directly is refused - the definer routine is the only door'
);

SELECT throws_ok(
  $$UPDATE public.omnipack_stock_snapshots SET sku = 'rewritten'$$,
  '42501',
  NULL,
  'as service_role, rewriting a stock snapshot is refused, so a mismatch record cannot be edited after the fact'
);

SELECT throws_ok(
  $$DELETE FROM public.omnipack_low_stock_evidence$$,
  '42501',
  NULL,
  'as service_role, deleting low-stock evidence is refused, so a resolved threshold keeps its history'
);

SELECT throws_ok(
  $$TRUNCATE public.omnipack_product_reconciliation_evidence$$,
  '42501',
  NULL,
  'as service_role, emptying the reconciliation evidence table is refused - the whole-table statement no row trigger can see'
);

SELECT throws_ok(
  $$UPDATE public.omnipack_stock_sync_cursors SET status = 'rewritten'$$,
  '42501',
  NULL,
  'as service_role, moving the stock sync cursor by hand is refused, so only the definer upsert advances it'
);

SELECT lives_ok(
  $$SELECT 1 FROM public.omnipack_status_evidence LIMIT 1$$,
  'as service_role, reading status evidence still works, so the narrowing did not cost the operator surfaces their data'
);

RESET ROLE;

SET LOCAL ROLE anon;

SELECT throws_ok(
  $$SELECT 1 FROM public.subscription_events$$,
  '42501',
  NULL,
  'as anon, reading the subscription event ledger is refused by privilege rather than by RLS returning nothing'
);

RESET ROLE;

SET LOCAL ROLE authenticated;

-- Deliberately TRUNCATE rather than INSERT: row-level security also refuses a browser insert
-- with 42501, so an insert here would keep passing on a table whose grant had been handed
-- back. No policy governs the whole-table statement, so only the withdrawn grant can refuse
-- it - which makes this the assertion that actually discriminates.
SELECT throws_ok(
  $$TRUNCATE public.subscription_events$$,
  '42501',
  NULL,
  'as authenticated, emptying the subscription event ledger is refused by the withdrawn grant, which no policy could have done'
);

RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
