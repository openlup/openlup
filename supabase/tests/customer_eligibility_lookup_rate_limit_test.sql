BEGIN;
SELECT plan(7);

SELECT is(
  (SELECT allowed FROM public.public_record_eligibility_lookup_attempt('ip-a', 'email-a', 60, 2, 2)),
  true,
  'first eligibility lookup attempt is allowed'
);

SELECT is(
  (SELECT attempts_by_ip FROM public.public_record_eligibility_lookup_attempt('ip-a', 'email-b', 60, 2, 2)),
  2,
  'second attempt for same IP increments IP counter'
);

SELECT is(
  (SELECT reason FROM public.public_record_eligibility_lookup_attempt('ip-a', 'email-c', 60, 2, 2)),
  'ip_quota',
  'third attempt for same IP is blocked by IP quota'
);

SELECT public.public_record_eligibility_lookup_attempt('ip-b', 'email-a', 60, 2, 2);

SELECT is(
  (SELECT reason FROM public.public_record_eligibility_lookup_attempt('ip-b', 'email-a', 60, 2, 2)),
  'email_quota',
  'third attempt for same email is blocked by email quota'
);

SELECT ok(
  has_function_privilege('service_role', 'public.public_record_eligibility_lookup_attempt(text,text,integer,integer,integer)', 'EXECUTE'),
  'service_role can execute eligibility lookup limiter RPC'
);

SELECT ok(
  NOT has_function_privilege('anon', 'public.public_record_eligibility_lookup_attempt(text,text,integer,integer,integer)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.public_record_eligibility_lookup_attempt(text,text,integer,integer,integer)', 'EXECUTE'),
  'anon and authenticated cannot execute eligibility lookup limiter RPC'
);

SELECT ok(
  NOT has_table_privilege('anon', 'public.public_eligibility_lookup_attempts', 'SELECT')
  AND NOT has_table_privilege('authenticated', 'public.public_eligibility_lookup_attempts', 'SELECT'),
  'anon and authenticated cannot read eligibility lookup attempts'
);

SELECT * FROM finish();
ROLLBACK;
