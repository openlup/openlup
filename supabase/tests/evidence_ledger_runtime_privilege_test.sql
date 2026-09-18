-- pgTAP: the runtime role can append to seven evidence ledgers and can no longer rewrite,
-- remove from, or empty any of them.
--
-- The gap this pins is not a missing statement but a statement that does nothing. This
-- platform's default privileges hand `service_role` the full `arwdDxtm` set on every new
-- table in `public` at creation time, so the `GRANT SELECT, INSERT` those ledgers were
-- created with restricted nothing, and the `REVOKE ALL ... FROM PUBLIC` next to it withdrew a
-- grant `PUBLIC` never held. Three of these ledgers additionally carry an append-only row
-- trigger, which cannot fire on a statement that removes no rows one at a time - so the
-- whole-table statement stayed reachable even where the ledger looked defended.
--
-- Every assertion therefore reads the real catalog or takes the role itself; none of it
-- trusts a migration's REVOKE line. The role-based half matters twice over: on the three
-- trigger-protected ledgers the trigger raises SQLSTATE 55000, so an assertion that the
-- refusal arrives as 42501 proves the privilege check refused the statement before the
-- trigger ran - that is, that the withdrawal is what is holding, not the pre-existing
-- trigger.
BEGIN;
SELECT plan(11);

CREATE TEMP TABLE append_only_ledger (
  ident text PRIMARY KEY,
  row_trigger boolean NOT NULL
) ON COMMIT DROP;

INSERT INTO append_only_ledger (ident, row_trigger) VALUES
  -- Inserted by an invoker-rights routine, so `INSERT` is load-bearing for these three.
  ('public.customer_support_recovery_commands', true),
  ('public.customer_support_recovery_audit_events', true),
  ('public.communication_delivery_events', true),
  -- Inserted only by definer-rights routines today; the grant still states the append
  -- contract rather than leaving it to whichever context writes next.
  ('public.communication_permission_events', false),
  ('public.communication_provider_events', false),
  ('public.communication_send_decisions', false),
  ('public.risk_case_events', false);

-- Resolution runs first: `has_table_privilege` yields NULL rather than an error for an
-- unresolvable identity, so a renamed or dropped ledger would let the privilege
-- assertions below pass vacuously.
SELECT is(
  (SELECT string_agg(ident, ', ' ORDER BY ident)
     FROM append_only_ledger WHERE to_regclass(ident) IS NULL),
  NULL,
  'every pinned ledger identity resolves, so the privilege assertions cannot pass vacuously'
);

SELECT is(
  (SELECT string_agg(ident, ', ' ORDER BY ident)
     FROM append_only_ledger
    WHERE NOT has_table_privilege('service_role', ident, 'SELECT')),
  NULL,
  'the runtime role can still read every ledger, so the operator surfaces keep working'
);

SELECT is(
  (SELECT string_agg(ident, ', ' ORDER BY ident)
     FROM append_only_ledger
    WHERE NOT has_table_privilege('service_role', ident, 'INSERT')),
  NULL,
  'the runtime role can still append to every ledger, including through the invoker-rights inserters'
);

-- One assertion over the whole product of ledgers and write privileges, so a regression
-- names the ledger and the privilege that came back rather than a bare count.
SELECT is(
  (SELECT string_agg(ledger.ident || ':' || candidate.privilege, ', '
            ORDER BY ledger.ident, candidate.privilege)
     FROM append_only_ledger AS ledger
     CROSS JOIN (VALUES ('UPDATE'), ('DELETE'), ('TRUNCATE')) AS candidate(privilege)
    WHERE has_table_privilege('service_role', ledger.ident, candidate.privilege)),
  NULL,
  'the runtime role holds no UPDATE, DELETE or TRUNCATE on any of the seven ledgers'
);

-- The append-only triggers are defence in depth against owner-context rewrites, which no
-- grant can restrict, so this wave keeps them and pins that it kept them.
SELECT is(
  (SELECT string_agg(ledger.ident, ', ' ORDER BY ledger.ident)
     FROM append_only_ledger AS ledger
    WHERE ledger.row_trigger
      AND NOT EXISTS (
        SELECT 1 FROM pg_trigger AS trigger_row
         WHERE trigger_row.tgrelid = to_regclass(ledger.ident)
           AND NOT trigger_row.tgisinternal
           AND (trigger_row.tgtype & 24) > 0)),
  NULL,
  'the pre-existing append-only row triggers are still attached, so owner-context rewrites stay refused'
);

-- The catalogue assertions above would still pass if the runtime reached these ledgers as
-- some other principal, so take the role the runtime actually uses and let the server refuse.
SET LOCAL ROLE service_role;

SELECT throws_ok(
  $$UPDATE public.customer_support_recovery_audit_events SET outcome = 'applied'$$,
  '42501',
  NULL,
  'as service_role, rewriting a recovery audit row is refused by privilege, before the append-only trigger'
);

SELECT throws_ok(
  $$DELETE FROM public.customer_support_recovery_commands$$,
  '42501',
  NULL,
  'as service_role, deleting a recovery command receipt is refused, so a replay cannot become a fresh command'
);

SELECT throws_ok(
  $$TRUNCATE public.customer_support_recovery_audit_events$$,
  '42501',
  NULL,
  'as service_role, emptying the recovery audit ledger is refused - the vector the row trigger never covered'
);

SELECT throws_ok(
  $$UPDATE public.risk_case_events SET note = 'rewritten'$$,
  '42501',
  NULL,
  'as service_role, rewriting a risk case event is refused on a ledger that never had a trigger at all'
);

SELECT throws_ok(
  $$DELETE FROM public.communication_delivery_events$$,
  '42501',
  NULL,
  'as service_role, deleting a delivery event is refused, so the delivery timeline cannot lose a transition'
);

SELECT throws_ok(
  $$TRUNCATE public.risk_case_events$$,
  '42501',
  NULL,
  'as service_role, emptying the risk case ledger is refused'
);

RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
