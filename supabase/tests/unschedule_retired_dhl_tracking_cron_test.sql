-- pgTAP: `check-dhl-tracking-frequent` is gone after 20260830170001, replaying the
-- removal is safe, and the removal reaches exactly one job name.
--
-- 20260720150000 deliberately spared this schedule because a documented
-- driver-switch could still re-activate it. That target — the `check-dhl-tracking`
-- Supabase Edge Function — is removed in the same change, so the schedule now
-- stands for no reachable effect and 20260830170001 removes the row.
--
-- The regression this pins is the same one the email sweep pinned, in the other
-- direction: an unschedule that over-reaches and kills a schedule that still has
-- a driver. A sentinel schedule stands in for any such neighbour, because the
-- assertion must hold for every job name the migration does not literally name.

BEGIN;
SELECT plan(5);

SELECT ok(
  to_regclass('cron.job') IS NOT NULL,
  'pg_cron is installed, so the schedule assertions below are meaningful'
);

-- Post-migration state: the retired DHL schedule does not exist.
SELECT is(
  (SELECT count(*)::int FROM cron.job WHERE jobname = 'check-dhl-tracking-frequent'),
  0,
  'check-dhl-tracking-frequent is unscheduled'
);

-- Re-seeding then replaying the removal must be safe and complete, and must not
-- touch a neighbouring schedule. The migration body is replayed verbatim against
-- a database where the schedule DOES exist.
SELECT cron.schedule('check-dhl-tracking-frequent', '*/30 6-20 * * *', $$select 1$$);
SELECT cron.schedule('pgtap-unschedule-sentinel', '0 3 * * *', $$select 1$$);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'check-dhl-tracking-frequent') THEN
    PERFORM cron.unschedule('check-dhl-tracking-frequent');
  END IF;
END $$;

SELECT is(
  (SELECT count(*)::int FROM cron.job WHERE jobname = 'check-dhl-tracking-frequent'),
  0,
  'replaying the removal clears the retired DHL schedule'
);

SELECT is(
  (SELECT count(*)::int FROM cron.job WHERE jobname = 'pgtap-unschedule-sentinel'),
  1,
  'the removal reaches only the job name it literally names'
);

-- A second replay against an already-clean database must not raise;
-- cron.unschedule errors on a missing job, which is why the call is guarded.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'check-dhl-tracking-frequent') THEN
    PERFORM cron.unschedule('check-dhl-tracking-frequent');
  END IF;
END $$;

SELECT pass('re-running the removal against a clean database does not raise');

SELECT * FROM finish();
ROLLBACK;
