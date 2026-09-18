-- pgTAP: the due-renewal RPC preserves default-now production calls while
-- admitting deterministic local fixed-as-of selection.

BEGIN;
SELECT plan(29);

SELECT has_function(
  'public',
  'subscription_list_due_for_renewal',
  ARRAY['integer', 'timestamp with time zone'],
  'due-renewal RPC has one two-argument signature'
);
SELECT is(
  to_regprocedure('public.subscription_list_due_for_renewal(integer)'),
  NULL::regprocedure,
  'legacy one-argument overload is removed'
);
SELECT ok(
  (SELECT pg_get_function_arguments(
    'public.subscription_list_due_for_renewal(integer,timestamptz)'::regprocedure
  )) = 'p_limit integer DEFAULT 50, p_as_of timestamp with time zone DEFAULT now()',
  'both arguments retain their default production values'
);

CREATE TEMP TABLE _due_dates AS
SELECT
  now() AS current_as_of,
  now() - interval '90 minutes' AS fixed_as_of;

INSERT INTO public.clients (id, email) VALUES
  ('b7100000-0000-4000-8000-000000000001', 'due-normal-old@example.invalid'),
  ('b7100000-0000-4000-8000-000000000002', 'due-normal-recent@example.invalid'),
  ('b7100000-0000-4000-8000-000000000003', 'due-retry-old@example.invalid'),
  ('b7100000-0000-4000-8000-000000000004', 'due-retry-recent@example.invalid');

INSERT INTO public.subscriptions (
  id, client_id, cadence_days, currency, status, next_cycle_at
)
SELECT
  subscription_id,
  client_id,
  28,
  'PLN',
  'active',
  next_cycle_at
FROM (
  VALUES
    ('b7200000-0000-4000-8000-000000000001'::uuid, 'b7100000-0000-4000-8000-000000000001'::uuid,
      (SELECT current_as_of - interval '2 hours' FROM _due_dates)),
    ('b7200000-0000-4000-8000-000000000002'::uuid, 'b7100000-0000-4000-8000-000000000002'::uuid,
      (SELECT current_as_of - interval '1 hour' FROM _due_dates)),
    ('b7200000-0000-4000-8000-000000000003'::uuid, 'b7100000-0000-4000-8000-000000000003'::uuid,
      (SELECT current_as_of + interval '1 day' FROM _due_dates)),
    ('b7200000-0000-4000-8000-000000000004'::uuid, 'b7100000-0000-4000-8000-000000000004'::uuid,
      (SELECT current_as_of + interval '1 day' FROM _due_dates))
) AS fixture(subscription_id, client_id, next_cycle_at);

INSERT INTO public.subscription_cycles (
  id, subscription_id, cycle_number, scheduled_at, status,
  engine_idempotency_key, retry_attempt, next_retry_at
)
SELECT
  cycle_id,
  subscription_id,
  2,
  scheduled_at,
  'retry_scheduled',
  engine_idempotency_key,
  1,
  next_retry_at
FROM (
  VALUES
    ('b7300000-0000-4000-8000-000000000001'::uuid, 'b7200000-0000-4000-8000-000000000003'::uuid,
      (SELECT current_as_of - interval '3 hours' FROM _due_dates), 'due-as-of-retry-old',
      (SELECT current_as_of - interval '2 hours' FROM _due_dates)),
    ('b7300000-0000-4000-8000-000000000002'::uuid, 'b7200000-0000-4000-8000-000000000004'::uuid,
      (SELECT current_as_of - interval '2 hours' FROM _due_dates), 'due-as-of-retry-recent',
      (SELECT current_as_of - interval '1 hour' FROM _due_dates))
) AS fixture(cycle_id, subscription_id, scheduled_at, engine_idempotency_key, next_retry_at);

SELECT is(
  (SELECT count(*)::integer
     FROM public.subscription_list_due_for_renewal()
    WHERE subscription_id::text LIKE 'b7200000-%'),
  4,
  'zero-argument call defaults p_limit and p_as_of to the current instant'
);
SELECT is(
  (SELECT count(*)::integer
     FROM public.subscription_list_due_for_renewal(50)
    WHERE subscription_id::text LIKE 'b7200000-%'),
  4,
  'one-argument production call keeps default-now due selection'
);

CREATE TEMP TABLE _fixed_due AS
SELECT subscription_id
  FROM public.subscription_list_due_for_renewal(
    50,
    (SELECT fixed_as_of FROM _due_dates)
  )
 WHERE subscription_id::text LIKE 'b7200000-%';

SELECT is(
  (SELECT count(*)::integer FROM _fixed_due),
  2,
  'two-argument fixed-as-of call excludes rows not yet due at that instant'
);
SELECT ok(
  EXISTS (SELECT 1 FROM _fixed_due WHERE subscription_id = 'b7200000-0000-4000-8000-000000000001'),
  'fixed as-of includes the old normal renewal'
);
SELECT ok(
  NOT EXISTS (SELECT 1 FROM _fixed_due WHERE subscription_id = 'b7200000-0000-4000-8000-000000000002'),
  'fixed as-of excludes the recent normal renewal'
);
SELECT ok(
  EXISTS (SELECT 1 FROM _fixed_due WHERE subscription_id = 'b7200000-0000-4000-8000-000000000003'),
  'fixed as-of includes the old retry renewal'
);
SELECT ok(
  NOT EXISTS (SELECT 1 FROM _fixed_due WHERE subscription_id = 'b7200000-0000-4000-8000-000000000004'),
  'fixed as-of excludes the recent retry renewal'
);

SELECT ok(
  has_function_privilege(
    'service_role',
    'public.subscription_list_due_for_renewal(integer,timestamptz)',
    'EXECUTE'
  ),
  'service_role can execute the replacement due-renewal RPC'
);
SELECT ok(
  NOT has_function_privilege(
    'anon',
    'public.subscription_list_due_for_renewal(integer,timestamptz)',
    'EXECUTE'
  )
  AND NOT has_function_privilege(
    'authenticated',
    'public.subscription_list_due_for_renewal(integer,timestamptz)',
    'EXECUTE'
  ),
  'anon and authenticated cannot execute the replacement due-renewal RPC'
);
SELECT is(
  (SELECT prosecdef
     FROM pg_proc
    WHERE oid = 'public.subscription_list_due_for_renewal(integer,timestamptz)'::regprocedure),
  false,
  'the service-role-only due reader uses invoker privileges'
);

SET LOCAL ROLE service_role;
SELECT is(
  (SELECT count(*)::integer
     FROM public.subscription_list_due_for_renewal(50, now() - interval '90 minutes')
    WHERE subscription_id::text LIKE 'b7200000-%'),
  2,
  'service_role executes fixed-as-of selection successfully with invoker privileges'
);
RESET ROLE;

-- ===========================================================================
-- Q — PR-0c renewal-lane quarantine.
--
-- A row that fails identically every tick re-presents the same work forever.
-- The quarantine degrades that row to a slow retry; it must NEVER become a
-- stop, so every assertion below is paired with the escape it depends on:
-- the streak has to reach three IDENTICAL failures before anything happens, the
-- window self-expires without any unquarantine write, and a single clean pass
-- clears it outright.
-- ===========================================================================

-- Q/streak — the first two failures change nothing an operator or customer can
-- feel; a transient fault must not cost anyone a delayed renewal.
SELECT is(
  (public.subscription_renewal_note_row_outcome(
     'b7200000-0000-4000-8000-000000000003',
     (SELECT current_as_of - interval '3 hours' FROM _due_dates),
     'payment_control_result_idempotency_conflict'
   ) -> 'renewalRowOutcome' ->> 'errorCount'),
  '1',
  'Q1: the first row failure starts the streak at 1');
SELECT is(
  (SELECT renewal_quarantined_until FROM public.subscription_cycles
    WHERE id = 'b7300000-0000-4000-8000-000000000001'),
  NULL::timestamptz,
  'Q1: one failure does not quarantine');

SELECT public.subscription_renewal_note_row_outcome(
  'b7200000-0000-4000-8000-000000000003',
  (SELECT current_as_of - interval '3 hours' FROM _due_dates),
  'payment_control_result_idempotency_conflict');
SELECT is(
  (SELECT renewal_row_error_count FROM public.subscription_cycles
    WHERE id = 'b7300000-0000-4000-8000-000000000001'),
  2,
  'Q2: a second identical failure advances the streak but still does not quarantine');
SELECT is(
  (SELECT renewal_quarantined_until FROM public.subscription_cycles
    WHERE id = 'b7300000-0000-4000-8000-000000000001'),
  NULL::timestamptz,
  'Q2: two failures do not quarantine');

-- Q/third — 2^(3-2) * 15 minutes = 30 minutes, the first rung of the backoff.
SELECT public.subscription_renewal_note_row_outcome(
  'b7200000-0000-4000-8000-000000000003',
  (SELECT current_as_of - interval '3 hours' FROM _due_dates),
  'payment_control_result_idempotency_conflict');
SELECT ok(
  (SELECT renewal_quarantined_until FROM public.subscription_cycles
    WHERE id = 'b7300000-0000-4000-8000-000000000001')
    BETWEEN now() + interval '29 minutes' AND now() + interval '31 minutes',
  'Q3: the third identical failure parks the cycle for 30 minutes');

SELECT ok(
  NOT EXISTS (
    SELECT 1 FROM public.subscription_list_due_for_renewal(50)
     WHERE subscription_id = 'b7200000-0000-4000-8000-000000000003'
  ),
  'Q3: the retry lane skips a cycle inside its quarantine window');

-- Q/expiry — the predicate is a bare timestamp comparison, so the row returns
-- on its own. Nothing has to remember to unquarantine it.
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.subscription_list_due_for_renewal(50, now() + interval '45 minutes')
     WHERE subscription_id = 'b7200000-0000-4000-8000-000000000003'
  ),
  'Q4: an elapsed quarantine re-admits the row with no unquarantine write');

-- Q/clear — one clean pass ends it early and resets the streak, so the next
-- failure starts from scratch rather than inheriting an old backoff.
SELECT public.subscription_renewal_note_row_outcome(
  'b7200000-0000-4000-8000-000000000003',
  (SELECT current_as_of - interval '3 hours' FROM _due_dates),
  NULL);
SELECT is(
  (SELECT COALESCE(renewal_row_error_key, 'null') || '|' || renewal_row_error_count::text
       || '|' || COALESCE(renewal_quarantined_until::text, 'null')
     FROM public.subscription_cycles WHERE id = 'b7300000-0000-4000-8000-000000000001'),
  'null|0|null',
  'Q5: a clean pass clears the key, the streak, and the quarantine');
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.subscription_list_due_for_renewal(50)
     WHERE subscription_id = 'b7200000-0000-4000-8000-000000000003'
  ),
  'Q5: the cleared cycle is back in the retry lane immediately');

-- Q/distinct-key — a different fault is not the same fault. Counting unrelated
-- failures together would let a row be parked for something it never repeated.
SELECT public.subscription_renewal_note_row_outcome(
  'b7200000-0000-4000-8000-000000000003',
  (SELECT current_as_of - interval '3 hours' FROM _due_dates), 'first_reason');
SELECT public.subscription_renewal_note_row_outcome(
  'b7200000-0000-4000-8000-000000000003',
  (SELECT current_as_of - interval '3 hours' FROM _due_dates), 'first_reason');
SELECT is(
  (public.subscription_renewal_note_row_outcome(
     'b7200000-0000-4000-8000-000000000003',
     (SELECT current_as_of - interval '3 hours' FROM _due_dates), 'second_reason'
   ) -> 'renewalRowOutcome' ->> 'errorCount'),
  '1',
  'Q6: a different error key restarts the streak instead of inheriting it');

-- Q/normal-lane — the open-cycle guard hides most quarantined rows from the
-- normal lane already; this fixture is the one it does not hide, so the lane
-- needs its own predicate or the same failing row simply comes back the other way.
INSERT INTO public.clients (id, email)
VALUES ('b7100000-0000-4000-8000-000000000005', 'due-quarantine-normal@example.invalid');
INSERT INTO public.subscriptions (id, client_id, cadence_days, currency, status, next_cycle_at)
-- Neutral test currency: neither lane reads it, so naming a real one would
-- claim a dependency this proof does not have.
VALUES ('b7200000-0000-4000-8000-000000000005', 'b7100000-0000-4000-8000-000000000005', 28, 'XTS', 'active',
        (SELECT current_as_of - interval '2 hours' FROM _due_dates));
INSERT INTO public.subscription_cycles (
  id, subscription_id, cycle_number, scheduled_at, status, engine_idempotency_key, retry_attempt
)
VALUES ('b7300000-0000-4000-8000-000000000005', 'b7200000-0000-4000-8000-000000000005', 1,
        (SELECT current_as_of - interval '2 hours' FROM _due_dates), 'planned',
        'due-as-of-quarantine-normal', 0);

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.subscription_list_due_for_renewal(50)
     WHERE subscription_id = 'b7200000-0000-4000-8000-000000000005'
  ),
  'Q7: the normal-lane fixture is due before any quarantine');

UPDATE public.subscription_cycles
   SET renewal_quarantined_until = now() + interval '2 hours'
 WHERE id = 'b7300000-0000-4000-8000-000000000005';

SELECT ok(
  NOT EXISTS (
    SELECT 1 FROM public.subscription_list_due_for_renewal(50)
     WHERE subscription_id = 'b7200000-0000-4000-8000-000000000005'
  ),
  'Q7: the normal lane skips a subscription whose cycle is inside a quarantine window');
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.subscription_list_due_for_renewal(50, now() + interval '3 hours')
     WHERE subscription_id = 'b7200000-0000-4000-8000-000000000005'
  ),
  'Q7: the normal lane re-admits it once the window elapses');

-- Q/grants — bookkeeping that any client could call would let an outsider park
-- a renewal, so the write side is service-role only.
SELECT ok(
  has_function_privilege(
    'service_role',
    'public.subscription_renewal_note_row_outcome(uuid,timestamptz,text)',
    'EXECUTE'
  ),
  'Q8: service_role can execute the quarantine bookkeeping RPC');
SELECT ok(
  NOT has_function_privilege(
    'anon',
    'public.subscription_renewal_note_row_outcome(uuid,timestamptz,text)',
    'EXECUTE'
  )
  AND NOT has_function_privilege(
    'authenticated',
    'public.subscription_renewal_note_row_outcome(uuid,timestamptz,text)',
    'EXECUTE'
  ),
  'Q8: anon and authenticated cannot execute the quarantine bookkeeping RPC');

SELECT * FROM finish();
ROLLBACK;
