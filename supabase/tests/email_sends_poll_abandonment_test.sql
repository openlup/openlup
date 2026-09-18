-- pgTAP: Resend delivery poller un-pollable abandonment
-- (communication_record_email_poll_not_found). A send is given up only after N
-- consecutive provider 404s; the transition is reported exactly once.
--
-- Run via: supabase test db

BEGIN;
SELECT plan(11);

-- Two minimal sends (tester_id/template_id are nullable FKs).
INSERT INTO public.email_sends (id, resend_id, status, sent_at)
VALUES
  ('aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa', 're_abandon_1', 'sent', now() - interval '2 hours'),
  ('bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb', 're_abandon_2', 'sent', now() - interval '2 hours');

-- Column defaults.
SELECT is(
  (SELECT poll_not_found_count FROM public.email_sends WHERE id = 'aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa'),
  0,
  'poll_not_found_count defaults to 0');
SELECT ok(
  (SELECT poll_abandoned_at IS NULL FROM public.email_sends WHERE id = 'aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa'),
  'poll_abandoned_at defaults to NULL');

-- First two 404s: count climbs, not abandoned (threshold 3), returns false.
SELECT is(
  public.communication_record_email_poll_not_found('aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa', 3),
  false,
  'first 404 does not abandon below threshold');
SELECT is(
  public.communication_record_email_poll_not_found('aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa', 3),
  false,
  'second 404 does not abandon below threshold');
SELECT is(
  (SELECT poll_not_found_count FROM public.email_sends WHERE id = 'aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa'),
  2,
  'counter reflects two 404s');
SELECT ok(
  (SELECT poll_last_attempt_at IS NOT NULL FROM public.email_sends WHERE id = 'aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa'),
  '404 records the durable poll attempt timestamp');
SELECT ok(
  (SELECT poll_abandoned_at IS NULL FROM public.email_sends WHERE id = 'aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa'),
  'still not abandoned before the threshold');

-- Third 404 crosses the threshold: marker set, returns true exactly once.
SELECT is(
  public.communication_record_email_poll_not_found('aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa', 3),
  true,
  'threshold 404 reports the newly-abandoned transition');
SELECT ok(
  (SELECT poll_abandoned_at IS NOT NULL FROM public.email_sends WHERE id = 'aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa'),
  'poll_abandoned_at is set at the threshold');

-- A further 404 on an already-abandoned send returns false (no double count).
SELECT is(
  public.communication_record_email_poll_not_found('aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa', 3),
  false,
  'already-abandoned send does not re-report the transition');

-- An unknown send id is a no-op, not an error.
SELECT is(
  public.communication_record_email_poll_not_found('cccccccc-2222-4222-8222-cccccccccccc', 3),
  false,
  'unknown send id returns false without raising');

SELECT * FROM finish();
ROLLBACK;
