-- Public platform channel-order-pull control row: the kernel learns that a scheduled channel poll
-- exists, and that it must not run until a person says so. One row, no relation, no behaviour.
--
-- WHAT THIS FORWARD SHIPS. A single seed in `platform_job_controls` for the job name
-- `channel-order-pull`, with `enabled = false`. That is the whole forward. The ingest saga's
-- relations arrived with the channel-order-ingest forward; the cursor a poll advances belongs to
-- `sales_channel_connections`, authored by the sales-channel registry forward. A poller therefore
-- needs no new storage on this kernel — only permission, and this forward is the one that withholds
-- it.
--
-- WHY THE ABSENCE OF A ROW IS NOT THE SAME AS A DISABLED ROW, AND THIS IS THE POINT.
-- `platform_claim_job_run` upserts the control row for any job name it is handed, and the column
-- default for `enabled` is `true`. A job with no seed row therefore MINTS ITS OWN PERMISSION on its
-- first claim and proceeds. An adopter who scheduled the pull route before flipping anything would
-- discover that the schedule was the flip. Seeding the row explicitly disabled closes that: the
-- first claim finds a row that already says no, records the attempt as `skipped` with reason
-- `job_disabled`, and touches nothing.
--
-- WHY THE DRIVER IS `scheduler` AND NOT THE MANAGED CHAIN'S LABEL. `platform_job_controls`
-- constrains `active_driver` to the neutral runner classes `worker`, `scheduler` and `operator`.
-- The managed twin of this seed writes `vercel_cron`, which is a concrete adapter name this kernel
-- deliberately does not know. `scheduler` is the same claim in this catalogue's own vocabulary, and
-- a claim arriving with any other driver is refused as `inactive_driver` — which is the correct
-- answer here, because a worker taking over a poll nobody enabled is exactly what the seed exists
-- to prevent.
--
-- EVERY DEPARTURE FROM THE MANAGED TWIN, SAID OUT LOUD.
--
--   1. `active_driver` is `scheduler`, not `vercel_cron`. Named above; forced by the CHECK this
--      catalogue's own ledger forward authored.
--   2. NO RLS, NO POLICY, NO `GRANT`/`REVOKE`, matching every forward in this catalogue. The
--      managed chain's principals do not exist here, so authoring them would be authoring empty
--      shapes.
--   3. The metadata omits the managed twin's `requiresFlag`. An environment flag named
--      `CHANNEL_ORDER_PULL_ENABLED` is a fact about one deployment's runner, not about this
--      kernel; an adopter's second gate is their own to name. The `pendingFlip` fact is kept,
--      because "a human has not yet decided" is true for every adopter.
--
-- ON CONFLICT REFRESHES THE DRIVER AND THE METADATA AND NEVER `enabled`. An adopter who has already
-- turned this job on made an operational decision, and a re-applied forward must not silently
-- reverse it.
INSERT INTO public.platform_job_controls (job_name, enabled, active_driver, metadata)
VALUES (
  'channel-order-pull',
  false,
  'scheduler',
  jsonb_build_object(
    'owner', 'channels',
    'channelOrderPull', true,
    'pendingFlip', 'human-flip'
  )
)
ON CONFLICT (job_name) DO UPDATE
   SET active_driver = 'scheduler',
       metadata = public.platform_job_controls.metadata
         || EXCLUDED.metadata
         || jsonb_build_object('updatedByMigration', '20260813210000_channel_order_pull_job_control'),
       updated_at = now();
