-- pgTAP: magic-link limiter execution is server-only after trusted caller
-- activation. The managed native image crashes when its reserved browser roles
-- directly hit an EXECUTE refusal (upstream engine issue #2112), so
-- actual denial calls use non-reserved roles that inherit each exact browser
-- role. Effective privileges are still asserted on anon/authenticated by name.

BEGIN;
SELECT plan(34);

SELECT has_function(
  'public',
  'public_record_customer_magic_link_attempt',
  ARRAY['text', 'text', 'integer', 'integer', 'integer'],
  'customer magic-link recorder retains its exact signature'
);
SELECT has_function(
  'public',
  'public_count_customer_magic_link_attempts_global',
  ARRAY['integer'],
  'customer magic-link global counter retains its exact signature'
);
SELECT has_function(
  'public',
  'public_record_admin_magic_link_attempt',
  ARRAY['text', 'text', 'integer', 'integer', 'integer'],
  'admin magic-link recorder retains its exact signature'
);

SELECT is(
  has_function_privilege(role_name, routine, 'EXECUTE'),
  role_name = 'service_role',
  role_name || ' has the intended execution boundary on ' || routine
)
FROM (VALUES ('anon'), ('authenticated'), ('service_role')) AS roles(role_name)
CROSS JOIN (VALUES
  ('public.public_record_customer_magic_link_attempt(text,text,integer,integer,integer)'),
  ('public.public_count_customer_magic_link_attempts_global(integer)'),
  ('public.public_record_admin_magic_link_attempt(text,text,integer,integer,integer)')
) AS routines(routine);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM pg_catalog.aclexplode(
        COALESCE(procedure.proacl, pg_catalog.acldefault('f', procedure.proowner))
      ) AS acl
     WHERE acl.grantee = 0
       AND acl.privilege_type = 'EXECUTE'
  ),
  'PUBLIC cannot execute ' || procedure.proname
)
FROM pg_catalog.pg_proc AS procedure
WHERE procedure.oid IN (
  'public.public_record_customer_magic_link_attempt(text,text,integer,integer,integer)'::regprocedure,
  'public.public_count_customer_magic_link_attempts_global(integer)'::regprocedure,
  'public.public_record_admin_magic_link_attempt(text,text,integer,integer,integer)'::regprocedure
);

CREATE ROLE magic_link_anon_execute_probe NOLOGIN INHERIT IN ROLE anon;
CREATE ROLE magic_link_authenticated_execute_probe NOLOGIN INHERIT IN ROLE authenticated;

SELECT ok(
  pg_has_role('magic_link_anon_execute_probe', 'anon', 'MEMBER'),
  'the non-reserved anon probe inherits the exact browser role'
);
SELECT ok(
  pg_has_role('magic_link_authenticated_execute_probe', 'authenticated', 'MEMBER'),
  'the non-reserved authenticated probe inherits the exact browser role'
);

SET LOCAL ROLE service_role;

SELECT results_eq(
  $$ SELECT allowed, reason, attempts_by_ip, attempts_by_email
       FROM public.public_record_customer_magic_link_attempt(
         'sec-a2-customer-ip', 'sec-a2-customer-email', 60, 1, 1
       ) $$,
  $$ VALUES (true, NULL::text, 1, 1) $$,
  'service role records the first customer attempt'
);
SELECT results_eq(
  $$ SELECT allowed, reason, attempts_by_ip, attempts_by_email
       FROM public.public_record_customer_magic_link_attempt(
         'sec-a2-customer-ip', 'sec-a2-customer-email', 60, 1, 1
       ) $$,
  $$ VALUES (false, 'ip_quota'::text, 1, 1) $$,
  'customer IP quota denial retains its fixed policy result'
);
SELECT is(
  (SELECT count(*)::integer FROM public.customer_magic_link_attempts
    WHERE ip_hash = 'sec-a2-customer-ip' AND email_hash = 'sec-a2-customer-email'),
  1,
  'customer IP quota denial appends no row'
);
SELECT results_eq(
  $$ SELECT allowed, reason, attempts_by_ip, attempts_by_email
       FROM public.public_record_customer_magic_link_attempt(
         'sec-a2-customer-other-ip', 'sec-a2-customer-email', 60, 5, 1
       ) $$,
  $$ VALUES (false, 'email_quota'::text, 0, 1) $$,
  'customer email quota denial retains its fixed policy result'
);
SELECT is(
  (SELECT count(*)::integer FROM public.customer_magic_link_attempts
    WHERE email_hash = 'sec-a2-customer-email'),
  1,
  'customer email quota denial appends no row'
);
SELECT is(
  public.public_count_customer_magic_link_attempts_global(60),
  (SELECT count(*)::integer FROM public.customer_magic_link_attempts
    WHERE created_at >= now() - interval '60 minutes'),
  'service role retains the global customer attempt count'
);

SELECT results_eq(
  $$ SELECT allowed, reason, attempts_by_ip, attempts_by_email
       FROM public.public_record_admin_magic_link_attempt(
         'sec-a2-admin-ip', 'sec-a2-admin-email', 60, 1, 1
       ) $$,
  $$ VALUES (true, NULL::text, 1, 1) $$,
  'service role records the first admin attempt'
);
SELECT results_eq(
  $$ SELECT allowed, reason, attempts_by_ip, attempts_by_email
       FROM public.public_record_admin_magic_link_attempt(
         'sec-a2-admin-ip', 'sec-a2-admin-email', 60, 1, 1
       ) $$,
  $$ VALUES (false, 'ip_quota'::text, 1, 1) $$,
  'admin IP quota denial retains its fixed policy result'
);
SELECT is(
  (SELECT count(*)::integer FROM public.admin_magic_link_attempts
    WHERE ip_hash = 'sec-a2-admin-ip' AND email_hash = 'sec-a2-admin-email'),
  1,
  'admin quota denial appends no row'
);

RESET ROLE;

SELECT throws_ok(
  $probe$ DO $body$ BEGIN SET LOCAL ROLE magic_link_anon_execute_probe;
    PERFORM * FROM public.public_record_customer_magic_link_attempt(
      'sec-a2-denied-customer-anon-ip', 'sec-a2-denied-customer-anon-email', 60, 1, 1
    );
  END $body$ $probe$,
  '42501', NULL,
  'an anon-inheriting caller cannot execute the customer recorder'
);
SELECT throws_ok(
  $probe$ DO $body$ BEGIN SET LOCAL ROLE magic_link_authenticated_execute_probe;
    PERFORM * FROM public.public_record_customer_magic_link_attempt(
      'sec-a2-denied-customer-auth-ip', 'sec-a2-denied-customer-auth-email', 60, 1, 1
    );
  END $body$ $probe$,
  '42501', NULL,
  'an authenticated-inheriting caller cannot execute the customer recorder'
);
SELECT throws_ok(
  $probe$ DO $body$ BEGIN SET LOCAL ROLE magic_link_anon_execute_probe;
    PERFORM public.public_count_customer_magic_link_attempts_global(60);
  END $body$ $probe$,
  '42501', NULL,
  'an anon-inheriting caller cannot execute the global counter'
);
SELECT throws_ok(
  $probe$ DO $body$ BEGIN SET LOCAL ROLE magic_link_authenticated_execute_probe;
    PERFORM public.public_count_customer_magic_link_attempts_global(60);
  END $body$ $probe$,
  '42501', NULL,
  'an authenticated-inheriting caller cannot execute the global counter'
);
SELECT throws_ok(
  $probe$ DO $body$ BEGIN SET LOCAL ROLE magic_link_anon_execute_probe;
    PERFORM * FROM public.public_record_admin_magic_link_attempt(
      'sec-a2-denied-admin-anon-ip', 'sec-a2-denied-admin-anon-email', 60, 1, 1
    );
  END $body$ $probe$,
  '42501', NULL,
  'an anon-inheriting caller cannot execute the admin recorder'
);
SELECT throws_ok(
  $probe$ DO $body$ BEGIN SET LOCAL ROLE magic_link_authenticated_execute_probe;
    PERFORM * FROM public.public_record_admin_magic_link_attempt(
      'sec-a2-denied-admin-auth-ip', 'sec-a2-denied-admin-auth-email', 60, 1, 1
    );
  END $body$ $probe$,
  '42501', NULL,
  'an authenticated-inheriting caller cannot execute the admin recorder'
);

SELECT is(
  (SELECT count(*)::integer FROM public.customer_magic_link_attempts
    WHERE ip_hash LIKE 'sec-a2-denied-%' OR email_hash LIKE 'sec-a2-denied-%'),
  0,
  'browser-role customer denials leave no attempt rows'
);
SELECT is(
  (SELECT count(*)::integer FROM public.admin_magic_link_attempts
    WHERE ip_hash LIKE 'sec-a2-denied-%' OR email_hash LIKE 'sec-a2-denied-%'),
  0,
  'browser-role admin denials leave no attempt rows'
);

SELECT * FROM finish();
ROLLBACK;
