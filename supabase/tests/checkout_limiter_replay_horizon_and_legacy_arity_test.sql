-- pgTAP: the exact-attempt checkout limiter recognizes a replay across the whole
-- retained ledger, not only inside the quota window, and it still answers a
-- caller that predates the identity argument.
--
-- Both properties are absent from
-- public_checkout_rate_limit_journey_dedupe_test.sql: every exact-replay case
-- there is created inside the same transaction and therefore inside the
-- 60-minute window, and every call there supplies an identity. The two gaps this
-- file closes are the two ways the limiter could refuse a legitimate buyer.
--
-- Group A ages a ledger row past the quota window but inside the 24-hour
-- retention — the interval where the unqualified unique index still enforced the
-- identity while the windowed replay probe could not see it.
-- Group B calls with the third argument omitted, which is the exact shape
-- PostgREST sends for a pre-identity build during a migrations-before-promote
-- release window.
BEGIN;
SELECT plan(12);

-- ---------------------------------------------------------------------------
-- Group A: replay detection spans the retention horizon
-- ---------------------------------------------------------------------------

SELECT is(
  (SELECT allowed FROM public.public_record_checkout_attempt(
    repeat('1', 64), repeat('2', 64), repeat('3', 64), 60, 10, 5
  )),
  true,
  'a first attempt is allowed and seeds the ledger'
);

-- Age the row beyond the 60-minute quota window and well inside the 24-hour
-- retention the function itself trims to.
UPDATE public.public_checkout_attempts
   SET created_at = now() - interval '90 minutes'
 WHERE attempt_identity_hash = repeat('3', 64);

SELECT is(
  (SELECT allowed FROM public.public_record_checkout_attempt(
    repeat('1', 64), repeat('2', 64), repeat('3', 64), 60, 10, 5
  )),
  true,
  'a 90-minute-old exact attempt is recognized as a replay instead of raising unique_violation'
);

SELECT is(
  (SELECT count(*) FROM public.public_checkout_attempts
    WHERE attempt_identity_hash = repeat('3', 64)),
  1::bigint,
  'the out-of-window replay still does not insert a second ledger row'
);

SELECT is(
  (SELECT attempts_by_ip FROM public.public_record_checkout_attempt(
    repeat('1', 64), repeat('2', 64), repeat('3', 64), 60, 10, 5
  )),
  0,
  'quota accounting stays window-scoped: the aged row is not counted'
);

-- ---------------------------------------------------------------------------
-- Group B: a caller that predates the identity argument is still answered
-- ---------------------------------------------------------------------------

SELECT is(
  (SELECT allowed FROM public.public_record_checkout_attempt(
    p_ip_hash => repeat('4', 64),
    p_email_hash => repeat('5', 64),
    p_window_minutes => 60,
    p_max_per_ip => 10,
    p_max_per_email => 5
  )),
  true,
  'a five-argument caller with no attempt identity is admitted'
);

SELECT is(
  (SELECT count(*) FROM public.public_checkout_attempts
    WHERE ip_hash = repeat('4', 64)),
  1::bigint,
  'the identity-less call is counted exactly once'
);

SELECT ok(
  (SELECT bool_and(attempt_identity_hash ~ '^[0-9a-f]{64}$')
     FROM public.public_checkout_attempts
    WHERE ip_hash = repeat('4', 64)),
  'the synthesized identity satisfies the ledger digest shape'
);

SELECT is(
  (SELECT allowed FROM public.public_record_checkout_attempt(
    p_ip_hash => repeat('4', 64),
    p_email_hash => repeat('5', 64),
    p_window_minutes => 60,
    p_max_per_ip => 10,
    p_max_per_email => 5
  )),
  true,
  'a second identity-less call is admitted and never deduplicated against the first'
);

SELECT is(
  (SELECT count(DISTINCT attempt_identity_hash) FROM public.public_checkout_attempts
    WHERE ip_hash = repeat('4', 64)),
  2::bigint,
  'two identity-less calls hold two distinct synthesized identities'
);

-- ---------------------------------------------------------------------------
-- Group C: the guarantees 20260828231000 established are unchanged
-- ---------------------------------------------------------------------------

SELECT throws_ok(
  $$SELECT * FROM public.public_record_checkout_attempt(repeat('a', 64), repeat('b', 64), 'not-a-hash', 60, 10, 5)$$,
  '22023',
  'public_checkout_attempt_invalid_attempt_identity_hash',
  'a supplied but malformed attempt identity is still rejected'
);

SELECT throws_ok(
  $$SELECT * FROM public.public_record_checkout_attempt(NULL, repeat('b', 64), repeat('c', 64), 60, 10, 5)$$,
  '22023',
  'public_checkout_attempt_invalid_ip_hash',
  'a null IP digest is still rejected'
);

-- Five identity-less calls fill the per-email quota; the sixth must be refused.
DO $$
BEGIN
  FOR i IN 1..5 LOOP
    PERFORM public.public_record_checkout_attempt(
      p_ip_hash => repeat('6', 64),
      p_email_hash => repeat('7', 64),
      p_window_minutes => 60,
      p_max_per_ip => 10,
      p_max_per_email => 5
    );
  END LOOP;
END;
$$;

SELECT is(
  (SELECT reason FROM public.public_record_checkout_attempt(
    p_ip_hash => repeat('6', 64),
    p_email_hash => repeat('7', 64),
    p_window_minutes => 60,
    p_max_per_ip => 10,
    p_max_per_email => 5
  )),
  'email_quota',
  'identity-less calls still consume and enforce the per-email quota'
);

SELECT * FROM finish();
ROLLBACK;
