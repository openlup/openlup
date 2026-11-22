import { MAX_CADENCE_DAYS } from "@openlup/core/subscription";
import type { SubscriptionQueryExecutor } from "./postgresRenewalStore.js";

// Owner-published limits for the complete installed preview definitions and validated
// quote check. The 3660-day bundle has two issued definitions because the later
// search-path forward changes its attributes. Any unknown tuple has no evidence.
const installedCadenceBounds = [
  {
    days: 90,
    bundle: ["61fc6fb352531fbf6ac9e23cb6ec36162b3ece58d554421f1b164af521b85c28"],
    command: "cce931d85fee2ec1b3b7ea080effed9c68a8a4420b789726c3daa35495685b40",
    quote: "CHECK (((proposed_cadence_days >= 1) AND (proposed_cadence_days <= 90)))",
  },
  {
    days: MAX_CADENCE_DAYS,
    bundle: [
      "19365490200fafaaa95dbcb23354a85435f9b9126db230183c5bf0b9c79a272b",
      "539fe814ed7fa599c157a4b55e0928fd943222e0140c1801d89d8852455e48e6",
    ],
    command: "e668ceac3508a58165d91567eab0c6fb542da27d316dc5ec5b05703bdce3eeae",
    quote: "CHECK (((proposed_cadence_days >= 1) AND (proposed_cadence_days <= 3660)))",
  },
];

/** Read the bound for an exact known native preview and quote-check installation.
 * @experimental
 */
export async function observeCatalogSubscriptionCadenceBound(db: SubscriptionQueryExecutor): Promise<number | null> {
  const result = await db.query(`SELECT
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.pg_get_functiondef(
      pg_catalog.to_regprocedure('public.customer_subscription_preview_bundle_as_actor(uuid,text,jsonb,jsonb,jsonb,integer,integer)')), 'UTF8')), 'hex') AS bundle,
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.pg_get_functiondef(
      pg_catalog.to_regprocedure('public.subscription_command_preview(uuid,uuid,text,uuid,text,jsonb,timestamptz)')), 'UTF8')), 'hex') AS command,
    (SELECT CASE WHEN count(*) = 1 AND bool_and(c.convalidated AND c.conname = 'subscription_edit_quotes_cadence_check')
        THEN min(pg_catalog.pg_get_constraintdef(c.oid)) END
      FROM pg_catalog.pg_constraint c JOIN pg_catalog.pg_attribute a
        ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
      WHERE c.conrelid = pg_catalog.to_regclass('public.subscription_edit_quotes')
        AND c.contype = 'c' AND a.attname = 'proposed_cadence_days') AS quote_constraint`).catch((error: unknown) => {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "42501") return { rows: [] };
    throw error;
  });
  if (result.rows.length !== 1) return null;
  const row = result.rows[0];
  return installedCadenceBounds.find(bound => bound.bundle.some(digest => digest === row.bundle)
    && bound.command === row.command && bound.quote === row.quote_constraint)?.days ?? null;
}
