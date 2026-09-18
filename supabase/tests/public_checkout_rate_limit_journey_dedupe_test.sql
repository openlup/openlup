-- pgTAP: public checkout quota deduplicates only an exact logical provider
-- attempt. The assertions use opaque digests exclusively: the table/RPC must
-- never need the raw journey idempotency key or a BLIK value.
--
-- The advisory-lock assertions deliberately inspect the function definition
-- instead of opening a second credentialed database session. Together with the
-- one-row exact-replay proof below, they pin the serialization protocol without
-- embedding local database credentials in the repository test suite.
BEGIN;
SELECT plan(24);

SELECT is(
  (SELECT allowed FROM public.public_record_checkout_attempt(
    repeat('a', 64), repeat('b', 64), repeat('c', 64), 60, 10, 5
  )),
  true,
  'first exact provider attempt is allowed'
);

SELECT is(
  (SELECT count(*) FROM public.public_checkout_attempts
    WHERE attempt_identity_hash = repeat('c', 64)),
  1::bigint,
  'first exact provider attempt writes one opaque ledger row'
);

SELECT is(
  (SELECT allowed FROM public.public_record_checkout_attempt(
    repeat('a', 64), repeat('b', 64), repeat('c', 64), 60, 10, 5
  )),
  true,
  'exact replay is admitted to canonical idempotency readback'
);

SELECT is(
  (SELECT count(*) FROM public.public_checkout_attempts
    WHERE attempt_identity_hash = repeat('c', 64)),
  1::bigint,
  'exact replay does not insert a second ledger row'
);

SELECT is(
  (SELECT allowed FROM public.public_record_checkout_attempt(
    repeat('d', 64), repeat('e', 64), repeat('c', 64), 60, 10, 5
  )),
  true,
  'the same exact attempt is recognized even if its incoming IP and email differ'
);

SELECT is(
  (SELECT count(*) FROM public.public_checkout_attempts
    WHERE attempt_identity_hash = repeat('c', 64)),
  1::bigint,
  'changed IP/email does not make the same exact attempt consume another quota slot'
);

SELECT is(
  (SELECT allowed FROM public.public_record_checkout_attempt(
    repeat('a', 64), repeat('b', 64), repeat('f', 64), 60, 10, 5
  )),
  true,
  'a new attempt-identity digest is a new quota-consuming provider attempt'
);

SELECT is(
  (SELECT count(*) FROM public.public_checkout_attempts
    WHERE attempt_identity_hash IN (repeat('c', 64), repeat('f', 64))),
  2::bigint,
  'a changed provider attempt identity has separate ledger weight'
);

SELECT *
  FROM generate_series(1, 5) AS sequence
 CROSS JOIN LATERAL public.public_record_checkout_attempt(
   repeat('1', 64), repeat('2', 64), lpad(sequence::text, 64, '0'), 60, 10, 5
 );

SELECT is(
  (SELECT reason FROM public.public_record_checkout_attempt(
    repeat('1', 64), repeat('2', 64), lpad('6', 64, '0'), 60, 10, 5
  )),
  'email_quota',
  'sixth unique provider attempt for one email is denied'
);

SELECT is(
  (SELECT allowed FROM public.public_record_checkout_attempt(
    repeat('1', 64), repeat('2', 64), lpad('1', 64, '0'), 60, 10, 5
  )),
  true,
  'a previously admitted exact attempt bypasses a now-full email quota'
);

SELECT *
  FROM generate_series(1, 10) AS sequence
 CROSS JOIN LATERAL public.public_record_checkout_attempt(
   repeat('3', 64), lpad(sequence::text, 64, '4'), lpad(sequence::text, 64, '5'), 60, 10, 5
 );

SELECT is(
  (SELECT reason FROM public.public_record_checkout_attempt(
    repeat('3', 64), lpad('b', 64, '4'), lpad('b', 64, '5'), 60, 10, 5
  )),
  'ip_quota',
  'eleventh unique provider attempt for one IP is denied'
);

WITH source AS (
  SELECT pg_get_functiondef(
    'public.public_record_checkout_attempt(text,text,text,integer,integer,integer)'::regprocedure
  ) AS body
)
SELECT ok(
  position(
    $attempt_lock$PERFORM pg_advisory_xact_lock(hashtextextended('checkout-attempt:' || v_attempt_identity_hash, 0));$attempt_lock$
    IN body
  ) > 0,
  'the exact attempt identity has its own transaction advisory lock'
)
FROM source;

WITH source AS (
  SELECT pg_get_functiondef(
    'public.public_record_checkout_attempt(text,text,text,integer,integer,integer)'::regprocedure
  ) AS body
)
SELECT ok(
  position(
    $attempt_lock$PERFORM pg_advisory_xact_lock(hashtextextended('checkout-attempt:' || v_attempt_identity_hash, 0));$attempt_lock$
    IN body
  ) < position('v_lock_a := LEAST' IN body),
  'the exact-attempt lock precedes the IP/email quota locks for concurrent equivalent calls'
)
FROM source;

-- Prove the serialization contract with two actual database sessions. Hold
-- the exact-attempt advisory key in this session until both writers are
-- waiting, then release it: one writer inserts and the second observes that
-- committed row as an exact replay.
CREATE EXTENSION IF NOT EXISTS dblink WITH SCHEMA extensions;
SELECT extensions.dblink_connect(
  'checkout_attempt_dedupe_one',
  'host=' || host(inet_server_addr()) || ' port=' || inet_server_port()
    || ' dbname=' || current_database() || ' user=postgres password=postgres'
);
SELECT extensions.dblink_connect(
  'checkout_attempt_dedupe_two',
  'host=' || host(inet_server_addr()) || ' port=' || inet_server_port()
    || ' dbname=' || current_database() || ' user=postgres password=postgres'
);
SELECT pg_advisory_lock(hashtextextended('checkout-attempt:' || repeat('7', 64), 0));
SELECT extensions.dblink_send_query(
  'checkout_attempt_dedupe_one',
  $$SELECT * FROM public.public_record_checkout_attempt(
    repeat('8', 64), repeat('9', 64), repeat('7', 64), 60, 10, 5
  )$$
);
SELECT extensions.dblink_send_query(
  'checkout_attempt_dedupe_two',
  $$SELECT * FROM public.public_record_checkout_attempt(
    repeat('8', 64), repeat('9', 64), repeat('7', 64), 60, 10, 5
  )$$
);
SELECT pg_sleep(0.05);
SELECT ok(
  extensions.dblink_is_busy('checkout_attempt_dedupe_one') = 1
  AND extensions.dblink_is_busy('checkout_attempt_dedupe_two') = 1,
  'both equivalent calls wait on the same exact-attempt transaction lock'
);
SELECT pg_advisory_unlock(hashtextextended('checkout-attempt:' || repeat('7', 64), 0));

CREATE TEMP TABLE _checkout_attempt_dedupe_results (
  allowed boolean,
  reason text,
  attempts_by_ip integer,
  attempts_by_email integer
) ON COMMIT DROP;
INSERT INTO _checkout_attempt_dedupe_results
SELECT result.*
  FROM extensions.dblink_get_result('checkout_attempt_dedupe_one')
    AS result(allowed boolean, reason text, attempts_by_ip integer, attempts_by_email integer);
INSERT INTO _checkout_attempt_dedupe_results
SELECT result.*
  FROM extensions.dblink_get_result('checkout_attempt_dedupe_two')
    AS result(allowed boolean, reason text, attempts_by_ip integer, attempts_by_email integer);
SELECT * FROM extensions.dblink_get_result('checkout_attempt_dedupe_one')
  AS drained(allowed boolean, reason text, attempts_by_ip integer, attempts_by_email integer);
SELECT * FROM extensions.dblink_get_result('checkout_attempt_dedupe_two')
  AS drained(allowed boolean, reason text, attempts_by_ip integer, attempts_by_email integer);

SELECT is(
  (SELECT count(*)::integer FROM _checkout_attempt_dedupe_results WHERE allowed AND reason IS NULL),
  2,
  'both concurrent exact calls are admitted for canonical idempotency'
);
SELECT is(
  (SELECT count(*)::integer FROM public.public_checkout_attempts
    WHERE attempt_identity_hash = repeat('7', 64)),
  1,
  'concurrent exact calls commit only one quota ledger row'
);
SELECT is(
  (SELECT count(*)::integer FROM _checkout_attempt_dedupe_results
    WHERE attempts_by_ip = 1 AND attempts_by_email = 1),
  2,
  'both concurrent results observe the same single committed quota weight'
);

SELECT extensions.dblink_exec(
  'checkout_attempt_dedupe_one',
  $$DELETE FROM public.public_checkout_attempts WHERE attempt_identity_hash = repeat('7', 64)$$
);
SELECT extensions.dblink_disconnect('checkout_attempt_dedupe_one');
SELECT extensions.dblink_disconnect('checkout_attempt_dedupe_two');

SELECT throws_ok(
  $$SELECT * FROM public.public_record_checkout_attempt(NULL, repeat('a', 64), repeat('b', 64), 60, 10, 5)$$,
  '22023',
  'public_checkout_attempt_invalid_ip_hash',
  'null IP digest is rejected'
);

SELECT throws_ok(
  $$SELECT * FROM public.public_record_checkout_attempt(repeat('a', 64), repeat('b', 64), 'not-a-hash', 60, 10, 5)$$,
  '22023',
  'public_checkout_attempt_invalid_attempt_identity_hash',
  'malformed attempt identity digest is rejected'
);

SELECT ok(
  has_function_privilege(
    'service_role',
    'public.public_record_checkout_attempt(text,text,text,integer,integer,integer)',
    'EXECUTE'
  ),
  'service_role can execute the six-argument rate-limit RPC'
);

SELECT ok(
  NOT has_function_privilege(
    'anon',
    'public.public_record_checkout_attempt(text,text,text,integer,integer,integer)',
    'EXECUTE'
  )
  AND NOT has_function_privilege(
    'authenticated',
    'public.public_record_checkout_attempt(text,text,text,integer,integer,integer)',
    'EXECUTE'
  )
  AND NOT EXISTS (
    SELECT 1
      FROM pg_proc AS procedure
     CROSS JOIN LATERAL aclexplode(
       coalesce(procedure.proacl, acldefault('f', procedure.proowner))
     ) AS acl
     WHERE procedure.oid = to_regprocedure(
       'public.public_record_checkout_attempt(text,text,text,integer,integer,integer)'
     )::oid
       AND acl.grantee = 0
       AND acl.privilege_type = 'EXECUTE'
  ),
  'browser roles and PUBLIC cannot execute the rate-limit RPC'
);

SELECT is(
  (SELECT count(*) FROM pg_proc AS procedure
    JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
   WHERE namespace.nspname = 'public'
     AND procedure.proname = 'public_record_checkout_attempt'
     AND procedure.pronargs = 5),
  0::bigint,
  'the stale five-argument rate-limit RPC overload is absent'
);

SELECT ok(
  NOT has_table_privilege('anon', 'public.public_checkout_attempts', 'SELECT')
  AND NOT has_table_privilege('authenticated', 'public.public_checkout_attempts', 'SELECT'),
  'browser roles cannot read the rate-limit ledger'
);

SELECT is(
  to_regprocedure('public.public_record_checkout_attempt(text,text,text,integer,integer,integer)') IS NOT NULL,
  true,
  'the six-argument rate-limit RPC resolves exactly'
);

SELECT * FROM finish();
ROLLBACK;
