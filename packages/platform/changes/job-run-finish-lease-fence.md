Native PostgreSQL job finishes return `false` when the submitted run is no
longer current. The finish marks its own running row `skipped` with
`job_lease_lost` and empty result metadata. Duplicate finishes preserve the
first terminal result.

Migration: Apply the pending forward through the selected native catalogue or
through the existing application migration chain that consumes
`JOB_RUN_LEDGER_MIGRATIONS`. Pre-upgrade checkpoints remain historical records
eligible for selection. The resume guarantee applies to checkpoints written
under the fence.
