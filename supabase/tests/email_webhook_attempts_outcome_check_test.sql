-- pgTAP: email_webhook_attempts outcome vocabulary includes foreign environment callbacks.
-- Run via: npm run test:db:local

BEGIN;
SELECT plan(4);

SELECT ok(
  (SELECT pg_get_constraintdef(oid) LIKE '%foreign_send_not_found%'
     FROM pg_constraint
    WHERE conrelid = 'public.email_webhook_attempts'::regclass
      AND conname = 'email_webhook_attempts_outcome_check'),
  'email_webhook_attempts_outcome_check admits foreign_send_not_found');

SELECT lives_ok(
  $$INSERT INTO public.email_webhook_attempts (id, outcome, http_status)
      VALUES ('ef000000-0000-4000-8000-000000000001', 'foreign_send_not_found', 200)$$,
  'foreign environment webhook attempt inserts');

SELECT is(
  (SELECT count(*)::int
     FROM public.email_webhook_attempts
    WHERE id = 'ef000000-0000-4000-8000-000000000001'
      AND outcome = 'foreign_send_not_found'),
  1,
  'foreign environment webhook attempt persists in the test transaction');

SELECT throws_ok(
  $$INSERT INTO public.email_webhook_attempts (outcome, http_status)
      VALUES ('unrecognized_outcome', 200)$$,
  '23514',
  NULL,
  'unrecognized outcome remains rejected');

SELECT * FROM finish();
ROLLBACK;
