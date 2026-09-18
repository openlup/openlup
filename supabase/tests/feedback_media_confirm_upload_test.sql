-- pgTAP: feedback media confirmation stays gated to delivered testers and
-- returns the RPC contract consumed by the feedback upload notification port.
-- Calls name the server-owned fixed maximum explicitly so this clean-history
-- proof cannot silently select a deployed two-argument overload.

BEGIN;
SELECT plan(20);

SELECT has_function(
  'public',
  'append_feedback_photo_url',
  ARRAY['text', 'text', 'integer'],
  'feedback media confirmation RPC exists with the port contract signature'
);

INSERT INTO public.testers (
  id, first_name, last_name, email, phone, street, postal_code, city,
  country, pet_type, dog_name, gdpr_consent, verification_consent, status,
  delivered_at
) VALUES
  (
    'f5100000-0000-0000-0000-000000000001', 'Anna', 'Nowak',
    'feedback-delivered@example.invalid', '+48111111111', 'Testowa 1',
    '00-001', 'Warszawa', 'Polska', 'dog', 'Figa', true, true,
    'delivered', '2026-06-01T12:00:00Z'
  ),
  (
    'f5100000-0000-0000-0000-000000000002', 'Jan', 'Kowalski',
    'feedback-undelivered@example.invalid', '+48222222222', 'Testowa 2',
    '00-002', 'Warszawa', 'Polska', 'dog', 'Borys', true, true,
    'approved', NULL
  );

INSERT INTO public.feedback (id, tester_id, hash, photo_urls) VALUES
  (
    'f5200000-0000-0000-0000-000000000001',
    'f5100000-0000-0000-0000-000000000001',
    'hash-delivered',
    ARRAY[]::text[]
  ),
  (
    'f5200000-0000-0000-0000-000000000002',
    'f5100000-0000-0000-0000-000000000002',
    'hash-undelivered',
    ARRAY[]::text[]
  );

SELECT is(
  has_function_privilege(role_name, routine, 'EXECUTE'),
  role_name = 'service_role',
  role_name || ' has the intended media capability on ' || routine
)
FROM (VALUES ('anon'), ('authenticated'), ('service_role')) AS roles(role_name)
CROSS JOIN (VALUES
  ('public.feedback_add_photo_url_by_hash(text,text,integer)'),
  ('public.feedback_remove_photo_url_by_hash(text,text)'),
  ('public.append_feedback_photo_url(text,text,integer)')
) AS routines(routine);

SELECT ok(
  NOT EXISTS (
    SELECT 1 FROM pg_catalog.aclexplode(
      COALESCE(proacl, pg_catalog.acldefault('f', proowner))
    ) WHERE grantee = 0 AND privilege_type = 'EXECUTE'
  ),
  'PUBLIC cannot execute ' || proname
)
FROM pg_catalog.pg_proc
WHERE oid IN (
  'public.feedback_add_photo_url_by_hash(text,text,integer)'::regprocedure,
  'public.feedback_remove_photo_url_by_hash(text,text)'::regprocedure,
  'public.append_feedback_photo_url(text,text,integer)'::regprocedure
);

-- Actual browser calls (all six, with predecessor success controls and no-write
-- assertions) live in tests/postgres/feedbackMediaAuthority.test.ts. Supabase
-- image 17.6.1.106 has a reserved-role denial SIGSEGV (postgres issue 2112), also
-- reproduced on an unchanged RPC outside pgTAP. Effective ACLs stay above and
-- actual service behavior stays below; this does not certify a hosted image.

SET LOCAL ROLE service_role;

SELECT results_eq(
  $$ SELECT was_appended, new_count FROM public.append_feedback_photo_url('hash-delivered', 'f5100000-0000-0000-0000-000000000001/c/photo.jpg', 10) $$,
  $$ VALUES (true, 1) $$,
  'delivered tester can confirm a first uploaded media object'
);

SELECT results_eq(
  $$ SELECT was_appended, new_count FROM public.append_feedback_photo_url('hash-delivered', 'f5100000-0000-0000-0000-000000000001/c/photo.jpg', 10) $$,
  $$ VALUES (false, 1) $$,
  'replaying the same media confirmation is idempotent and does not notify again'
);

SELECT is(
  (SELECT photo_urls[1] FROM public.feedback WHERE hash = 'hash-delivered'),
  'f5100000-0000-0000-0000-000000000001/c/photo.jpg',
  'delivered true-positive persists the confirmed media key'
);

SELECT throws_like(
  $$ SELECT * FROM public.append_feedback_photo_url('hash-undelivered', 'f5100000-0000-0000-0000-000000000002/c/photo.jpg', 10) $$,
  '%Feedback media unlocks after delivery%',
  'undelivered tester cannot confirm media or trigger an admin notification'
);

SELECT is(
  COALESCE(array_length(photo_urls, 1), 0),
  0,
  'undelivered false-positive leaves feedback photo_urls unchanged'
)
FROM public.feedback
WHERE hash = 'hash-undelivered';

SELECT results_eq(
  $$ SELECT remaining_count, removed FROM public.feedback_remove_photo_url_by_hash('hash-delivered', 'f5100000-0000-0000-0000-000000000001/c/photo.jpg') $$,
  $$ VALUES (0, true) $$,
  'service role retains supported metadata removal'
);
SELECT is(COALESCE(array_length(photo_urls, 1), 0), 0,
  'service removal persists without a browser grant')
FROM public.feedback WHERE hash = 'hash-delivered';
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
