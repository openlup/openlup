-- pgTAP: the unauthenticated browser role no longer holds a write privilege it was never
-- meant to earn on the thirty-three tables pinned below, and the surviving evidence-writing
-- routine is no longer callable from a browser at all.
--
-- The gap this pins is not a missing statement but a statement that does nothing. This
-- platform's default privileges hand `anon`, `authenticated` and `service_role` the full
-- `arwdDxtm` set on every new table in `public` at creation time, so a `REVOKE ... FROM
-- PUBLIC` withdraws a grant `PUBLIC` never held, and the unauthenticated role kept UPDATE,
-- DELETE and the whole-table statement on tables no anonymous visitor has any business
-- rewriting. The wave under test narrows that role to the measured keep-set: the read and
-- append it genuinely uses, if any, and nothing else.
--
-- WHY THE KEEP-SET IS NOT UNIFORM. Twenty-nine of the thirty-three keep `SELECT, INSERT`.
-- The three terminal legacy intake tables and the email event ledger keep `SELECT` alone. The
-- intake tables have no supported browser writer after their BFF retirement; restoring their
-- append would be a widening disguised as compatibility. The email event ledger never had an
-- anonymous append and remains separately named below because widening that ledger is a
-- distinct evidence-integrity failure.
--
-- WHAT THIS WAVE DELIBERATELY DOES NOT TOUCH. The signed-in role's grants are a separate
-- wave with its own reachability audit, so the assertions below pin the signed-in role's
-- current width positively. A future author who quietly folds the deferred half into this one
-- fails here rather than shipping an unaudited narrowing under this wave's evidence.
--
-- Every assertion reads the real catalog or takes the role itself; none of it trusts a
-- migration's REVOKE line. The role-based half matters on its own, because the catalogue
-- assertions would all still pass if the runtime reached these objects as some other
-- principal. One role-taking form is deliberately absent and the comment at that assertion
-- says why: on this platform build, invoking a routine the taken role has no EXECUTE on
-- crashes the backend rather than raising, so the routine's half is resolved against the
-- effective principal and the ACL instead of by invocation.
--
-- WHAT THE ROUTINE'S BROWSER REACHABILITY ACTUALLY COST, stated no wider than it was. Its
-- conflict branch re-reads the stored row and returns `sku`, `inventoryClass` and
-- `mismatchKind`, so a caller who guessed an idempotency key got those three internal stock
-- fields echoed back. The exposure was therefore a narrow read as well as an unbounded write
-- into an append-only ledger - and nothing beyond those three fields.
BEGIN;
SELECT plan(25);

CREATE TEMP TABLE narrowed_table (
  ident text PRIMARY KEY,
  expected_privileges text NOT NULL
) ON COMMIT DROP;

-- The measured keep-set, one row per table. `expected_privileges` is the alphabetically
-- ordered set the unauthenticated role must still hold *and no more*, so this column is both
-- the positive and the negative side of the proof.
INSERT INTO narrowed_table (ident, expected_privileges) VALUES
  ('public.admin_users', 'INSERT, SELECT'),
  ('public.b2b_inquiries', 'INSERT, SELECT'),
  ('public.commerce_settings', 'INSERT, SELECT'),
  ('public.comms_notification_controls', 'INSERT, SELECT'),
  ('public.customer_external_refs', 'INSERT, SELECT'),
  ('public.customer_personalization', 'INSERT, SELECT'),
  ('public.email_sends', 'INSERT, SELECT'),
  ('public.email_templates', 'INSERT, SELECT'),
  ('public.email_webhook_attempts', 'INSERT, SELECT'),
  ('public.feedback', 'INSERT, SELECT'),
  ('public.notification_recipients', 'INSERT, SELECT'),
  ('public.order_line_pricing_breakdown', 'INSERT, SELECT'),
  ('public.payment_external_refs', 'INSERT, SELECT'),
  ('public.pet_personalizer_events', 'INSERT, SELECT'),
  ('public.price_entries', 'INSERT, SELECT'),
  ('public.price_lists', 'INSERT, SELECT'),
  ('public.promotion_redemptions', 'INSERT, SELECT'),
  ('public.promotions', 'INSERT, SELECT'),
  ('public.providers', 'INSERT, SELECT'),
  ('public.sample_requests', 'SELECT'),
  ('public.settings', 'INSERT, SELECT'),
  ('public.shipment_external_refs', 'INSERT, SELECT'),
  ('public.shipping_rules', 'INSERT, SELECT'),
  ('public.subscription_cycles', 'INSERT, SELECT'),
  ('public.subscription_lines', 'INSERT, SELECT'),
  ('public.subscription_pause_windows', 'INSERT, SELECT'),
  ('public.subscription_price_agreements', 'INSERT, SELECT'),
  ('public.subscriptions', 'INSERT, SELECT'),
  ('public.testers', 'SELECT'),
  ('public.variant_formats', 'INSERT, SELECT'),
  ('public.variant_unit_forms', 'INSERT, SELECT'),
  ('public.waitlist', 'SELECT'),
  -- The four read-only rows: three retired intakes and the email-event ledger.
  ('public.email_events', 'SELECT');

CREATE TEMP TABLE evidence_routine (
  ident text PRIMARY KEY
) ON COMMIT DROP;

-- The surviving evidence-writing routine: definer-rights, reached only by the runtime
-- credential, and left EXECUTE-able by browser roles purely by the schema default.
INSERT INTO evidence_routine (ident) VALUES
  ('public.omnipack_record_stock_snapshot(text, text, integer, integer, integer, integer, integer, integer, integer, text, text, jsonb, text)');

-- Resolution runs first: `has_table_privilege` yields NULL rather than an error for an
-- unresolvable identity, so a single typo, rename or drop would let every privilege
-- assertion below pass vacuously on a table nobody is actually checking.
SELECT is(
  (SELECT string_agg(ident, ', ' ORDER BY ident)
     FROM narrowed_table WHERE to_regclass(ident) IS NULL),
  NULL,
  'every pinned table identity resolves, so the privilege assertions cannot pass vacuously'
);

SELECT is(
  (SELECT count(*)::integer
     FROM evidence_routine AS routine
     JOIN pg_proc AS proc ON proc.oid = to_regprocedure(routine.ident)),
  1,
  'the pinned evidence-writing routine still exists, so the execute and security-context assertions cannot pass vacuously'
);

-- Guards the fixture itself: dropping a row would silently shrink the proof to the tables
-- that still happen to be listed, and the count is exactly the wave's scope.
SELECT is(
  (SELECT count(*)::integer FROM narrowed_table),
  33,
  'the fixture pins all thirty-three tables this narrowing covers'
);

-- One assertion over the whole product of tables and withdrawn privileges, so a regression
-- names the table and the privilege that came back rather than reporting a bare count.
SELECT is(
  (SELECT string_agg(narrowed.ident || ':' || candidate.privilege, ', '
            ORDER BY narrowed.ident, candidate.privilege)
     FROM narrowed_table AS narrowed
     CROSS JOIN (VALUES ('UPDATE'), ('DELETE'), ('TRUNCATE')) AS candidate(privilege)
    WHERE has_table_privilege('anon', narrowed.ident, candidate.privilege)),
  NULL,
  'the unauthenticated role holds no UPDATE, DELETE or whole-table privilege on any of the thirty-three pinned tables'
);

-- The positive side, driven from the fixture's expected column rather than from a uniform
-- assumption. A table that lost its read, a table that lost its append, and a table that
-- gained one it should not have all fail here, and the diff names it with what it actually
-- holds.
SELECT is(
  (SELECT string_agg(narrowed.ident || ':' || coalesce(actual.privileges, '<none>'), ', '
            ORDER BY narrowed.ident)
     FROM narrowed_table AS narrowed
     CROSS JOIN LATERAL (
       SELECT string_agg(candidate.privilege, ', ' ORDER BY candidate.privilege) AS privileges
         FROM (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'),
                      ('REFERENCES'), ('TRIGGER')) AS candidate(privilege)
        WHERE has_table_privilege('anon', narrowed.ident, candidate.privilege)
     ) AS actual
    WHERE actual.privileges IS DISTINCT FROM narrowed.expected_privileges),
  NULL,
  'every pinned table grants the unauthenticated role exactly its expected keep-set and nothing else'
);

-- Named separately because it is the single most likely authoring mistake: restoring a
-- uniform `SELECT, INSERT` across all thirty-three would hand this ledger an append it never
-- had, and a narrowing wave must not be the thing that widens it.
SELECT ok(
  has_table_privilege('anon', 'public.email_events', 'SELECT')
    AND NOT has_table_privilege('anon', 'public.email_events', 'INSERT'),
  'the email event ledger is read-only for the unauthenticated role - the restore did not widen it to an append it never held'
);

-- The legacy form policies must leave together with their table privilege. An ACL-only
-- withdrawal would be too easy for a later broad grant to reactivate without anyone noticing
-- that a permissive browser policy was still waiting behind it.
SELECT is(
  (SELECT string_agg(policy.schemaname || '.' || policy.tablename || ':' || policy.policyname, ', '
                     ORDER BY policy.schemaname, policy.tablename, policy.policyname)
     FROM pg_policies AS policy
    WHERE policy.schemaname = 'public'
      AND (policy.tablename, policy.policyname) IN (
        ('sample_requests', 'Anyone can submit a sample request'),
        ('testers', 'anon_insert_limited'),
        ('waitlist', 'anon_insert_waitlist')
      )),
  NULL,
  'the three obsolete anonymous legacy-intake insert policies are absent'
);

-- These records remain legitimate service-owned operational data. The revoke targets only
-- `anon`, so the runtime role must retain every DML primitive it may need. The catalogue check
-- is paired with an executable, transaction-rolled-back runtime roundtrip below.
SELECT is(
  (SELECT string_agg(target.ident || ':' || candidate.privilege, ', '
                     ORDER BY target.ident, candidate.privilege)
     FROM (VALUES
       ('public.sample_requests'),
       ('public.testers'),
       ('public.waitlist')
     ) AS target(ident)
     CROSS JOIN (VALUES ('INSERT'), ('UPDATE'), ('DELETE')) AS candidate(privilege)
    WHERE has_table_privilege('service_role', target.ident, candidate.privilege) IS NOT TRUE),
  NULL,
  'the service role retains INSERT, UPDATE, and DELETE on all three retired intake records'
);

-- Admin tester update/delete routes use a signed-in bearer client, not `service_role`.
-- Preserve both sides of that access path: its table privileges and the named signed-in
-- admin policy that admits the authorized principal through RLS.
SELECT ok(
  has_table_privilege('authenticated', 'public.testers', 'UPDATE')
    AND has_table_privilege('authenticated', 'public.testers', 'DELETE')
    AND EXISTS (
      SELECT 1
        FROM pg_policies AS policy
       WHERE policy.schemaname = 'public'
         AND policy.tablename = 'testers'
         AND policy.policyname = 'admin_full_access'
         AND policy.cmd = 'ALL'
         AND 'authenticated'::name = ANY(policy.roles)
    ),
  'the signed-in tester-admin path retains UPDATE/DELETE privileges and its admin_full_access RLS policy'
);

-- The signed-in role's half is deliberately deferred, so its current width is pinned
-- positively. Read from the live catalog at authoring time: it still holds the full inherited
-- set on these tables, and this wave must not be what changes that.
SELECT is(
  (SELECT string_agg(pinned.ident || ':' || candidate.privilege, ', '
            ORDER BY pinned.ident, candidate.privilege)
     FROM (VALUES ('public.subscriptions'), ('public.promotions')) AS pinned(ident)
     CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) AS candidate(privilege)
    WHERE has_table_privilege('authenticated', pinned.ident, candidate.privilege) IS NOT TRUE),
  NULL,
  'the signed-in role still holds its full inherited set on the sampled tables, so the deferred half was not quietly folded into this wave'
);

SELECT ok(
  has_table_privilege('authenticated', 'public.email_events', 'INSERT'),
  'the signed-in role still holds the email-event append the unauthenticated role never had, so the asymmetry was measured rather than assumed'
);

SELECT is(
  (SELECT string_agg(routine.ident, ', ' ORDER BY routine.ident)
     FROM evidence_routine AS routine
    WHERE has_function_privilege('anon', to_regprocedure(routine.ident)::oid, 'execute')),
  NULL,
  'the unauthenticated role holds no execute privilege on the evidence-writing routine'
);

SELECT is(
  (SELECT string_agg(routine.ident, ', ' ORDER BY routine.ident)
     FROM evidence_routine AS routine
    WHERE has_function_privilege('authenticated', to_regprocedure(routine.ident)::oid, 'execute')),
  NULL,
  'the signed-in role holds no execute privilege on the evidence-writing routine'
);

-- The revoke must not have cost the only role that actually calls it: the routine is reached
-- through the runtime credential from the provider sync path.
SELECT is(
  (SELECT string_agg(routine.ident, ', ' ORDER BY routine.ident)
     FROM evidence_routine AS routine
    WHERE has_function_privilege('service_role', to_regprocedure(routine.ident)::oid, 'execute') IS NOT TRUE),
  NULL,
  'the runtime role retains execute on the evidence-writing routine, so the sync path still records a snapshot'
);

-- The tripwire for the whole design. The routine writes to a table the runtime role cannot
-- write directly, which only works while it runs as its owner. If it ever became
-- invoker-rights it would spend the caller's privileges instead, and the narrowing above
-- would silently break the write path - this suite, not production, is where that shows up.
SELECT is(
  (SELECT string_agg(routine.ident, ', ' ORDER BY routine.ident)
     FROM evidence_routine AS routine
     JOIN pg_proc AS proc ON proc.oid = to_regprocedure(routine.ident)
    WHERE NOT proc.prosecdef),
  NULL,
  'the evidence-writing routine is still SECURITY DEFINER, so the narrowing cannot have broken a write path'
);

-- The ACL read directly, rather than through the privilege helpers: a browser role could in
-- principle hold EXECUTE via a grant to PUBLIC that `has_function_privilege` reports without
-- naming, so this assertion pins the grant list itself and names any browser grantee it finds.
SELECT is(
  (SELECT string_agg(DISTINCT coalesce(nullif(acl.grantee::regrole::text, '-'), 'PUBLIC'), ', '
            ORDER BY coalesce(nullif(acl.grantee::regrole::text, '-'), 'PUBLIC'))
     FROM evidence_routine AS routine
     JOIN pg_proc AS proc ON proc.oid = to_regprocedure(routine.ident)
     CROSS JOIN LATERAL aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) AS acl
    WHERE acl.privilege_type = 'EXECUTE'
      AND (acl.grantee = 0 OR acl.grantee::regrole::text IN ('anon', 'authenticated'))),
  NULL,
  'the routine grant list itself names no browser role and no PUBLIC execute grant'
);

-- Exercise the retained runtime path, not only its ACL. The table's only write trigger
-- synchronizes local permission-ledger rows; this transaction rolls those rows back and no
-- delivery or other egress routine is invoked.
SET LOCAL ROLE service_role;

SELECT lives_ok(
  $sql$DO $probe$
  DECLARE
    v_tester_id uuid;
  BEGIN
    INSERT INTO public.testers (
      first_name, last_name, email, phone, street, postal_code, city,
      gdpr_consent, verification_consent
    ) VALUES (
      'runtime', 'probe', 'runtime-privilege-probe@example.invalid', '000000000',
      'probe street', '00-000', 'probe city', true, true
    )
    RETURNING id INTO v_tester_id;

    UPDATE public.testers
       SET status = 'approved'
     WHERE id = v_tester_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'runtime tester update did not reach its inserted row';
    END IF;

    DELETE FROM public.testers
     WHERE id = v_tester_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'runtime tester delete did not reach its inserted row';
    END IF;
  END
  $probe$$sql$,
  'the runtime role can insert, update, and delete a valid tester row under the retained grants'
);

RESET ROLE;

-- The catalogue assertions above would all still pass if the runtime reached these objects as
-- some other principal, so take the role an anonymous visitor actually carries and let the
-- server refuse.
SET LOCAL ROLE anon;

SELECT throws_ok(
  $$UPDATE public.subscriptions SET status = 'rewritten'$$,
  '42501',
  NULL,
  'as the unauthenticated role, rewriting a subscription is refused by privilege rather than silently matching no rows'
);

SELECT throws_ok(
  $$DELETE FROM public.promotion_redemptions$$,
  '42501',
  NULL,
  'as the unauthenticated role, deleting redemption history is refused, so a spent promotion cannot be laundered'
);

-- The load-bearing one. Row-level security also refuses a browser write with 42501, so an
-- UPDATE or DELETE could in principle be refused by a policy rather than by the withdrawn
-- grant. No policy governs the whole-table statement, so only the missing privilege can
-- refuse it - which makes this the assertion that discriminates a real revocation from a
-- grant handed straight back.
SELECT throws_ok(
  $$TRUNCATE public.price_entries$$,
  '42501',
  NULL,
  'as the unauthenticated role, emptying the price entries table is refused by the withdrawn grant, which no policy could have done'
);

-- The routine's role-taking half is asserted structurally rather than by invocation, and that
-- is forced rather than chosen. Calling a routine this role has no EXECUTE on CRASHES the
-- backend on this platform build: the extension that rewrites permission-denied hints for the
-- managed roles faults while composing the hint, the server drops the connection and enters
-- recovery, and every later assertion in the file is lost. That was established the expensive
-- way once - with the grant intact the call reaches the routine's own input validation, and
-- with the grant withdrawn it takes the server down - and must not be re-established. Do not
-- add an invocation of this routine under any browser role here, in any form, including inside
-- a subtransaction or an exception block. So this assertion resolves the privilege against
-- the session's *effective* principal, which is what the role-taking half is actually for -
-- it fails if the running session turns out to be some principal other than the one the
-- catalogue assertions above name.
-- The identity is spelled again here rather than read from the fixture above, because a temp
-- table created by the migration-running role is not readable once the browser role is taken.
SELECT ok(
  NOT has_function_privilege(
    current_user,
    to_regprocedure('public.omnipack_record_stock_snapshot(text, text, integer, integer, integer, integer, integer, integer, integer, text, text, jsonb, text)')::oid,
    'execute'),
  'the effective principal of an unauthenticated session holds no execute on the evidence-writing routine'
);

SELECT lives_ok(
  $$SELECT 1 FROM public.promotions LIMIT 1$$,
  'as the unauthenticated role, reading the promotions catalogue still works, so the narrowing did not cost the storefront its reads'
);

-- The exact catalogue assertion above proves that INSERT is absent; these role-taking statements
-- prove a browser session cannot reach row validation or turn a later RLS-policy change into a
-- write while the table capability remains withdrawn.
SELECT throws_ok(
  $$INSERT INTO public.sample_requests (
       first_name, last_name, email, phone, address, postal_code, city, feedback
     ) VALUES (
       'privilege', 'probe', 'sample-privilege-probe@example.invalid', '000000000',
       'probe street', '00-000', 'probe city', 'privilege probe'
     )$$,
  '42501',
  NULL,
  'as the unauthenticated role, a valid retired sample-request append is refused'
);

SELECT throws_ok(
  $$INSERT INTO public.testers (
       first_name, last_name, email, phone, street, postal_code, city,
       gdpr_consent, verification_consent
     ) VALUES (
       'privilege', 'probe', 'tester-privilege-probe@example.invalid', '000000000',
       'probe street', '00-000', 'probe city', true, true
     )$$,
  '42501',
  NULL,
  'as the unauthenticated role, a valid retired tester-signup append is refused'
);

SELECT throws_ok(
  $$INSERT INTO public.waitlist (email, first_name)
     VALUES ('waitlist-privilege-probe@example.invalid', 'probe')$$,
  '42501',
  NULL,
  'as the unauthenticated role, a valid retired waitlist append is refused'
);

RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
