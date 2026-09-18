-- pgTAP: the admin email console statistics routine preserves the four legacy
-- exact meanings while replacing four transport reads with one service-only
-- RPC. Engagement counters count event rows, including repeated send events.

BEGIN;
SELECT plan(10);

SELECT ok(
  has_function_privilege('service_role', 'public.communication_admin_email_sends_stats()', 'EXECUTE'),
  'service_role can execute the admin email statistics read');
SELECT ok(
  NOT has_function_privilege('anon', 'public.communication_admin_email_sends_stats()', 'EXECUTE'),
  'anon cannot execute the admin email statistics read');
SELECT ok(
  NOT has_function_privilege('authenticated', 'public.communication_admin_email_sends_stats()', 'EXECUTE'),
  'authenticated cannot execute the admin email statistics read');
SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc
    WHERE oid = 'public.communication_admin_email_sends_stats()'::regprocedure
      AND prosecdef = false
      AND provolatile = 's'
  ),
  'the statistics routine is stable and uses invoker rights');

SET LOCAL ROLE service_role;
SELECT lives_ok(
  $$SELECT public.communication_admin_email_sends_stats()$$,
  'service_role can execute the invoker-rights read against the native schema');
RESET ROLE;

CREATE TEMP TABLE _admin_email_stats_before AS
SELECT public.communication_admin_email_sends_stats() AS value;

INSERT INTO public.email_sends (id, resend_id, template_slug, status, sent_at)
VALUES
  ('ed000000-0000-4000-8000-000000000001', 'ps3a-1', 'alpha', 'delivered', now()),
  ('ed000000-0000-4000-8000-000000000002', 'ps3a-2', 'alpha', 'sent', now()),
  ('ed000000-0000-4000-8000-000000000003', 'ps3a-3', NULL, 'failed', NULL);

INSERT INTO public.email_events (id, send_id, event_type, timestamp)
VALUES
  ('ee000000-0000-4000-8000-000000000001', 'ed000000-0000-4000-8000-000000000001', 'open', now()),
  ('ee000000-0000-4000-8000-000000000002', 'ed000000-0000-4000-8000-000000000001', 'open', now()),
  ('ee000000-0000-4000-8000-000000000003', 'ed000000-0000-4000-8000-000000000001', 'click', now()),
  ('ee000000-0000-4000-8000-000000000004', 'ed000000-0000-4000-8000-000000000002', 'bounce', now());

CREATE TEMP TABLE _admin_email_stats_after AS
SELECT public.communication_admin_email_sends_stats() AS value;

SELECT ok(
  (SELECT value ?& ARRAY['totalSent', 'delivered', 'opened', 'clicked'] FROM _admin_email_stats_after),
  'the statistics result carries all four console keys');
SELECT is(
  (SELECT (value->>'totalSent')::bigint FROM _admin_email_stats_after),
  (SELECT (value->>'totalSent')::bigint + 3 FROM _admin_email_stats_before),
  'totalSent counts every email_sends row');
SELECT is(
  (SELECT (value->>'delivered')::bigint FROM _admin_email_stats_after),
  (SELECT (value->>'delivered')::bigint + 1 FROM _admin_email_stats_before),
  'delivered counts only email_sends rows with delivered status');
SELECT is(
  (SELECT (value->>'opened')::bigint FROM _admin_email_stats_after),
  (SELECT (value->>'opened')::bigint + 2 FROM _admin_email_stats_before),
  'opened counts repeated open event rows rather than distinct sends');
SELECT is(
  (SELECT (value->>'clicked')::bigint FROM _admin_email_stats_after),
  (SELECT (value->>'clicked')::bigint + 1 FROM _admin_email_stats_before),
  'clicked counts click event rows and ignores other event types');

SELECT * FROM finish();
ROLLBACK;
