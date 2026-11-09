import { subscriptionRecord, type SubscriptionQueryExecutor } from "./postgresRenewalStore.js";

/** Trusted scheduled job. The host owns scheduling, enablement and run-ledger binding. */
export function createPostgresSubscriptionAutoResume(executor: SubscriptionQueryExecutor) {
  return {
    async run(limit = 100, now?: string): Promise<{ ok: boolean; scanned: number; resumed: number; skippedRows: number; failed: number }> {
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("subscription_auto_resume_limit_invalid");
      const result = await executor.query(`SELECT public.subscription_auto_resume_due($1::integer,COALESCE($2::timestamptz,now())) AS response`, [limit, now ?? null]);
      const row = subscriptionRecord(result.rows[0]?.response);
      if (typeof row.ok !== "boolean" || [row.scanned, row.resumed, row.skippedRows, row.failed].some(value => !Number.isInteger(value) || Number(value) < 0)) {
        throw new Error("subscription_auto_resume_response_invalid");
      }
      return { ok: row.ok, scanned: Number(row.scanned), resumed: Number(row.resumed), skippedRows: Number(row.skippedRows), failed: Number(row.failed) };
    },
  };
}
