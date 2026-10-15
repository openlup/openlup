// The job-run ledger SQL a fresh installation applies through its own migration chain, in order.
// The first file's bytes and migration identity equal the reference application's platform
// migration of the same name; the second adds the v3 claim and finish entry points.
export const JOB_RUN_LEDGER_SQL_URL = new URL("../../sql/20260809150000_job_run_ledger.sql", import.meta.url);

export const JOB_RUN_LEDGER_V3_SQL_URL = new URL("../../sql/20260809150001_job_run_ledger_v3.sql", import.meta.url);

/** Every job-run ledger migration, ordered by migration identity. */
export const JOB_RUN_LEDGER_MIGRATIONS: ReadonlyArray<{ readonly id: string; readonly url: URL }> = [
  { id: "20260809150000_job_run_ledger", url: JOB_RUN_LEDGER_SQL_URL },
  { id: "20260809150001_job_run_ledger_v3", url: JOB_RUN_LEDGER_V3_SQL_URL },
];
