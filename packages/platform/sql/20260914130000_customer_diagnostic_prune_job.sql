-- Public platform retention permission for `customer-diagnostic-prune`: this kernel learns that a
-- diagnostic drain exists and that it is not allowed to delete anything yet.
--
-- WHAT THIS FORWARD SHIPS. A single seed in `platform_job_controls` for the job name
-- `customer-diagnostic-prune`, `enabled = false`, `active_driver = 'worker'`. That is the entire
-- forward. The four diagnostic relations and the bounded `customer_diagnostic_prune_v1` routine
-- this job calls were authored by the durable-diagnostics forward in this same catalogue; the
-- claim/finish routines it leases through were authored by the job-run ledger forward. Nothing
-- new is stored, and nothing new is granted. What is added is a refusal.
--
-- WHY AN ABSENT ROW WOULD BE WORSE THAN A DISABLED ONE. `platform_claim_job_run` upserts the
-- control row for whatever job name it is handed, and the column default for `enabled` is `true`.
-- A retention job with no seed would therefore MINT ITS OWN PERMISSION on its first claim and
-- begin deleting an adopter's diagnostic history on the first tick of whatever clock they pointed
-- at the route. Seeding the row explicitly disabled means that first claim finds a row that
-- already says no, records the attempt as skipped with reason `job_disabled`, and deletes nothing.
-- For a job whose entire effect is deletion this is the difference between a wired rail and an
-- armed one.
--
-- WHY THE DRIVER IS `worker` — AND WHY THE NEAREST NEIGHBOUR IN THIS CATALOGUE IS THE WRONG
-- MODEL. `platform_job_controls` constrains `active_driver` to the neutral runner classes
-- `worker`, `scheduler` and `operator`, and `platform_claim_job_run` refuses a claim whose driver
-- differs from the stored one as `inactive_driver`. The portable v3 entry point passes the
-- trigger kind straight through as the driver, and this job claims as `worker` on every runtime —
-- from the in-process scheduler on a self-hosted Node bundle and from an external poker alike. The
-- channel-order-pull seed in this catalogue writes `scheduler`, which is right for a poll whose
-- claim arrives as a scheduler; copying that value here would make every claim this job ever makes
-- fail as `inactive_driver`. `worker` is also the one value inside both this catalogue's CHECK and
-- the managed chain's, so for this job the two seeds agree on the driver rather than diverging.
--
-- EVERY DEPARTURE FROM THE MANAGED TWIN, SAID OUT LOUD.
--
--   1. NO `allowed_trigger_kinds`. The column is a v3 addition that exists only in the managed
--      chain, where a NULL one makes the claim refuse outright. This catalogue's claim path
--      delegates to `platform_claim_job_run` and gates on `enabled`, the driver and the lease, so
--      there is no column to write and no refusal to avoid. The insert is four columns, not five.
--   2. NO RLS, NO POLICY, NO `GRANT`/`REVOKE`, matching every forward in this catalogue. The
--      managed chain's principals do not exist here, so authoring them would be authoring empty
--      shapes.
--   3. The metadata omits the managed twin's `requiresFlag`. An environment variable named
--      `COMMERCE_CUSTOMER_DIAGNOSTIC_PRUNE_ENABLED` is a fact about one deployment's runner, not
--      about this kernel; an adopter's second gate is theirs to name. The `pendingFlip` fact is
--      kept, because "a human has not yet decided" is true for every adopter.
--   4. The metadata omits the managed twin's `hostedCron` note for the same reason: which hosted
--      schedulers a deployment declines to use is not a property of this catalogue.
--
-- ON CONFLICT REFRESHES THE DRIVER AND THE METADATA AND NEVER `enabled`. An adopter who has
-- already enabled this drain is relying on it to bound their storage, and one who has deliberately
-- disabled it is retaining evidence on purpose. A re-applied forward must not reverse either
-- decision silently.
INSERT INTO public.platform_job_controls (job_name, enabled, active_driver, metadata)
VALUES (
  'customer-diagnostic-prune',
  false,
  'worker',
  jsonb_build_object(
    'owner', 'observability',
    'customerDiagnosticRetention', true,
    'pendingFlip', 'human-flip'
  )
)
ON CONFLICT (job_name) DO UPDATE
   SET active_driver = 'worker',
       metadata = public.platform_job_controls.metadata
         || EXCLUDED.metadata
         || jsonb_build_object('updatedByMigration', '20260914130000_customer_diagnostic_prune_job'),
       updated_at = now();
