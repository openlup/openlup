import type { SubscriptionQueryExecutor } from "./postgresRenewalStore.js";

function bound(source: unknown, guard: RegExp): number | undefined {
  if (typeof source !== "string") return;
  const matches = [...source.matchAll(guard)];
  if (matches.length !== 1) return;
  const value = Number(matches[0][1]);
  if (Number.isSafeInteger(value) && value > 0) return value;
}

/** Observe the validated quote constraint and both effective native preview guards.
 * @experimental
 */
export async function observeCatalogSubscriptionCadenceBound(db: SubscriptionQueryExecutor): Promise<number | null> {
  const result = await db.query(`SELECT
    pg_get_functiondef(to_regprocedure('public.customer_subscription_preview_bundle_as_actor(uuid,text,jsonb,jsonb,jsonb,integer,integer)')) AS bundle,
    pg_get_functiondef(to_regprocedure('public.subscription_command_preview(uuid,uuid,text,uuid,text,jsonb,timestamptz)')) AS command,
    (SELECT pg_get_expr(conbin, conrelid) FROM pg_constraint
      WHERE conrelid=to_regclass('public.subscription_edit_quotes')
        AND conname='subscription_edit_quotes_cadence_check' AND contype='c' AND convalidated) AS quote_constraint`).catch((error: unknown) => {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "42501") return { rows: [] };
    throw error;
  });
  if (result.rows.length !== 1) return null;
  const row = result.rows[0];
  const bundle = bound(row.bundle, /^\s*IF v_cadence_days NOT BETWEEN 1 AND ([1-9][0-9]*) OR v_expected_version < 1 THEN\s*$/gmu);
  const command = bound(row.command, /^\s*IF cadence NOT BETWEEN 1 AND ([1-9][0-9]*) OR s\.price_list_id IS NULL OR s\.currency_code IS NULL THEN\s*$/gmu);
  const constraint = bound(typeof row.quote_constraint === "string" ? row.quote_constraint.replace(/[()]/gu, "") : row.quote_constraint,
    /^proposed_cadence_days >= 1 AND proposed_cadence_days <= ([1-9][0-9]*)$/gu);
  if (bundle === undefined || command === undefined || constraint === undefined) return null;
  return Math.min(bundle, command, constraint);
}
