BEGIN;
SELECT plan(13);

SELECT is(
  (SELECT allowed FROM public.public_submit_b2b_inquiry(
    'pgtap-b2b-ip', ' Acme Pets ', 'DE', 'Ada', 'Lovelace',
    ' ADA@EXAMPLE.COM ', '+49 123', ' First inquiry ', 60, 2
  )),
  true,
  'first B2B inquiry is accepted and inserted atomically'
);

SELECT is(
  (SELECT allowed FROM public.public_submit_b2b_inquiry(
    'pgtap-b2b-ip', 'Acme Pets', 'DE', 'Grace', 'Hopper',
    'grace@example.com', NULL, NULL, 60, 2
  )),
  true,
  'second B2B inquiry within the quota is accepted'
);

SELECT is(
  (SELECT reason FROM public.public_submit_b2b_inquiry(
    'pgtap-b2b-ip', 'Acme Pets', 'DE', 'Katherine', 'Johnson',
    'katherine@example.com', NULL, NULL, 60, 2
  )),
  'ip_quota',
  'third B2B inquiry for the same IP is denied'
);

SELECT is(
  (SELECT count(*)::integer FROM public.b2b_inquiries WHERE ip_hash = 'pgtap-b2b-ip'),
  2,
  'a denied B2B inquiry does not insert a row'
);

SELECT is(
  (SELECT count(*)::integer FROM public.b2b_inquiries
    WHERE ip_hash = 'pgtap-b2b-ip' AND business_email = 'ada@example.com'),
  1,
  'the RPC normalizes the persisted email'
);

SELECT throws_ok(
  $$SELECT public.public_submit_b2b_inquiry(
    '', 'Acme', 'DE', 'Ada', 'Lovelace', 'ada@example.com', NULL, NULL, 60, 3
  )$$,
  '22023',
  'b2b_inquiry_missing_ip_hash',
  'the RPC rejects a missing IP hash'
);

SELECT ok(
  has_function_privilege(
    'service_role',
    'public.public_submit_b2b_inquiry(text,text,text,text,text,text,text,text,integer,integer)',
    'EXECUTE'
  ),
  'service_role can execute the B2B submit RPC'
);

SELECT ok(
  NOT has_function_privilege(
    'anon',
    'public.public_submit_b2b_inquiry(text,text,text,text,text,text,text,text,integer,integer)',
    'EXECUTE'
  )
  AND NOT has_function_privilege(
    'authenticated',
    'public.public_submit_b2b_inquiry(text,text,text,text,text,text,text,text,integer,integer)',
    'EXECUTE'
  ),
  'anon and authenticated cannot execute the B2B submit RPC'
);

CREATE EXTENSION IF NOT EXISTS dblink WITH SCHEMA extensions;
SELECT extensions.dblink_connect(
  'b2b_submit_one',
  'host=' || host(inet_server_addr()) || ' port=' || inet_server_port()
    || ' dbname=' || current_database() || ' user=postgres password=postgres'
);
SELECT extensions.dblink_connect(
  'b2b_submit_two',
  'host=' || host(inet_server_addr()) || ' port=' || inet_server_port()
    || ' dbname=' || current_database() || ' user=postgres password=postgres'
);
SELECT pg_advisory_lock(hashtextextended('b2b-inquiry:pgtap-b2b-concurrent-ip', 0));
SELECT extensions.dblink_send_query(
  'b2b_submit_one',
  $$SELECT * FROM public.public_submit_b2b_inquiry(
    'pgtap-b2b-concurrent-ip', 'Concurrent One', 'DE', 'One', 'Writer',
    'one@example.com', NULL, NULL, 60, 1
  )$$
);
SELECT extensions.dblink_send_query(
  'b2b_submit_two',
  $$SELECT * FROM public.public_submit_b2b_inquiry(
    'pgtap-b2b-concurrent-ip', 'Concurrent Two', 'DE', 'Two', 'Writer',
    'two@example.com', NULL, NULL, 60, 1
  )$$
);
SELECT pg_sleep(0.05);
SELECT is(
  extensions.dblink_is_busy('b2b_submit_one'),
  1,
  'first concurrent submit waits at the per-IP transaction lock'
);
SELECT is(
  extensions.dblink_is_busy('b2b_submit_two'),
  1,
  'second concurrent submit waits at the same per-IP transaction lock'
);
SELECT pg_advisory_unlock(hashtextextended('b2b-inquiry:pgtap-b2b-concurrent-ip', 0));

CREATE TEMP TABLE pgtap_b2b_concurrent_results (
  connection_name text,
  allowed boolean,
  reason text,
  inquiry_id uuid
) ON COMMIT DROP;
INSERT INTO pgtap_b2b_concurrent_results
SELECT 'one', result.*
  FROM extensions.dblink_get_result('b2b_submit_one')
    AS result(allowed boolean, reason text, inquiry_id uuid);
INSERT INTO pgtap_b2b_concurrent_results
SELECT 'two', result.*
  FROM extensions.dblink_get_result('b2b_submit_two')
    AS result(allowed boolean, reason text, inquiry_id uuid);
SELECT * FROM extensions.dblink_get_result('b2b_submit_one')
  AS result(allowed boolean, reason text, inquiry_id uuid);
SELECT * FROM extensions.dblink_get_result('b2b_submit_two')
  AS result(allowed boolean, reason text, inquiry_id uuid);

SELECT is(
  (SELECT count(*)::integer FROM pgtap_b2b_concurrent_results WHERE allowed),
  1,
  'exactly one overlapping submit is accepted at a quota of one'
);
SELECT is(
  (SELECT count(*)::integer FROM pgtap_b2b_concurrent_results WHERE reason = 'ip_quota'),
  1,
  'the other overlapping submit observes the committed quota and is denied'
);
SELECT is(
  (SELECT count(*)::integer FROM public.b2b_inquiries WHERE ip_hash = 'pgtap-b2b-concurrent-ip'),
  1,
  'overlapping transactions cannot commit more rows than the quota'
);

SELECT extensions.dblink_exec(
  'b2b_submit_one',
  'DELETE FROM public.b2b_inquiries WHERE ip_hash = ''pgtap-b2b-concurrent-ip'''
);
SELECT extensions.dblink_disconnect('b2b_submit_one');
SELECT extensions.dblink_disconnect('b2b_submit_two');

SELECT * FROM finish();
ROLLBACK;
