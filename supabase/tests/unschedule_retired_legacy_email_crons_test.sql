-- pgTAP: the three retired legacy pg_cron email schedules are gone after
-- 20260720150000, the still-supported DHL schedule survives, and re-applying the
-- removal is safe.
--
-- These jobs were hard-closed by 20260718130001 (their command body cannot
-- satisfy private.external_cron_is_enabled() from a database-originated session),
-- so the physical schedules were pure noise: they fired daily into a guaranteed
-- no-op. This test pins that they stay removed, and — more importantly — that the
-- removal never reaches check-dhl-tracking-frequent, which was outside its scope.
-- That schedule was later removed on its own by 20260830170001, once the Edge
-- entrypoint its documented driver-switch pointed at was retired; the assertion
-- below still pins the scope of THIS migration and re-seeds the schedule itself,
-- so it is unaffected by that later removal.

BEGIN;
SELECT plan(7);

SELECT ok(
  to_regclass('cron.job') IS NOT NULL,
  'pg_cron is installed, so the schedule assertions below are meaningful'
);

-- Post-migration state: none of the three retired schedules exist.
SELECT is(
  (SELECT count(*)::int FROM cron.job WHERE jobname = 'process-email-queue-daily'),
  0,
  'process-email-queue-daily is unscheduled'
);
SELECT is(
  (SELECT count(*)::int FROM cron.job WHERE jobname = 'send-packaging-digest-daily'),
  0,
  'send-packaging-digest-daily is unscheduled'
);
SELECT is(
  (SELECT count(*)::int FROM cron.job WHERE jobname = 'send-daily-report'),
  0,
  'send-daily-report is unscheduled'
);

-- Re-seeding then re-running the removal must be safe and complete. This is the
-- idempotency + correctness proof: the migration body is replayed verbatim
-- against a database where the schedules DO exist.
SELECT cron.schedule('process-email-queue-daily', '0 9 * * *', $$select 1$$);
SELECT cron.schedule('send-packaging-digest-daily', '0 8 * * *', $$select 1$$);
SELECT cron.schedule('send-daily-report', '0 17 * * *', $$select 1$$);
SELECT cron.schedule('check-dhl-tracking-frequent', '*/30 6-20 * * *', $$select 1$$);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'process-email-queue-daily') THEN
    PERFORM cron.unschedule('process-email-queue-daily');
  END IF;

  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'send-packaging-digest-daily') THEN
    PERFORM cron.unschedule('send-packaging-digest-daily');
  END IF;

  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'send-daily-report') THEN
    PERFORM cron.unschedule('send-daily-report');
  END IF;
END $$;

SELECT is(
  (
    SELECT count(*)::int FROM cron.job
     WHERE jobname IN (
       'process-email-queue-daily',
       'send-packaging-digest-daily',
       'send-daily-report'
     )
  ),
  0,
  'replaying the removal clears all three retired schedules'
);

-- The regression that would actually hurt: over-reaching and killing a schedule
-- that still has a supported re-activation path.
SELECT is(
  (SELECT count(*)::int FROM cron.job WHERE jobname = 'check-dhl-tracking-frequent'),
  1,
  'check-dhl-tracking-frequent is NOT removed by the retirement'
);

-- A second replay against an already-clean database must not raise; cron.unschedule
-- errors on a missing job, which is why each call is existence-guarded.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'process-email-queue-daily') THEN
    PERFORM cron.unschedule('process-email-queue-daily');
  END IF;

  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'send-packaging-digest-daily') THEN
    PERFORM cron.unschedule('send-packaging-digest-daily');
  END IF;

  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'send-daily-report') THEN
    PERFORM cron.unschedule('send-daily-report');
  END IF;
END $$;

SELECT pass('re-running the removal against a clean database does not raise');

SELECT * FROM finish();
ROLLBACK;
