import type { PgQueryExecutor } from "../data/index.js";
import type { CatalogWithdrawalImpactPort } from "./contracts/successors.js";
import type { CatalogBoundObligationsV2 } from "./contracts/lifecycleV2.js";
/** Lifecycle archive and withdrawal impact share one authoritative, unpaginated query.
 * @experimental
 */
export function createPostgresCatalogWithdrawalImpact(executor: PgQueryExecutor): CatalogWithdrawalImpactPort {
  return { async report(skuId) {
    try {
      const rows = (await executor.query("SELECT public.catalog_bound_obligations_v2($1::uuid) AS result", [skuId])).rows;
      if (rows.length !== 1) return { schemaVersion: 2,outcome: "unavailable",reason: "catalog_obligation_evidence_unavailable" };
      const value = rows[0]!.result as CatalogBoundObligationsV2;
      if (!value || value.schemaVersion !== 2 || !["complete","unknown","unavailable"].includes(value.outcome)
        || value.outcome === "complete" && !Array.isArray(value.obligations)) return { schemaVersion: 2,outcome: "unknown",reason: "catalog_obligation_evidence_unknown" };
      return value;
    } catch { return { schemaVersion: 2,outcome: "unavailable",reason: "catalog_obligation_evidence_unavailable" }; }
  } };
}
