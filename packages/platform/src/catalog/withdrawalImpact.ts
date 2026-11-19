import { z } from "zod";
import type { PgQueryExecutor } from "../data/index.js";
import type { CatalogWithdrawalImpactPort } from "./contracts/successors.js";

const obligationSchema = z.looseObject({
  family: z.enum(["template", "pending_activation", "frozen_renewal", "outstanding_order", "replacement", "stock_wait", "graduation"]),
  sourceId: z.guid(),
  caseKind: z.enum(["legacy", "successor"]).optional(),
  subscriptionId: z.guid().nullable(),
  skuId: z.guid(),
  skuCode: z.string().refine(value => value.trim().length > 0),
  skuRevisionId: z.guid().nullable(),
});
const obligationsResult = z.discriminatedUnion("outcome", [
  z.looseObject({ schemaVersion: z.literal(2), outcome: z.literal("complete"), obligations: z.array(obligationSchema) }),
  z.looseObject({ schemaVersion: z.literal(2), outcome: z.literal("unknown"), reason: z.literal("catalog_obligation_evidence_unknown") }),
  z.looseObject({ schemaVersion: z.literal(2), outcome: z.literal("unavailable"), reason: z.literal("catalog_obligation_evidence_unavailable") }),
]);

/** Lifecycle archive and withdrawal impact share one authoritative, unpaginated query.
 * @experimental
 */
export function createPostgresCatalogWithdrawalImpact(executor: PgQueryExecutor): CatalogWithdrawalImpactPort {
  return { async report(skuId) {
    try {
      const rows = (await executor.query("SELECT public.catalog_bound_obligations_v2($1::uuid) AS result", [skuId])).rows;
      if (rows.length !== 1) return { schemaVersion: 2,outcome: "unavailable",reason: "catalog_obligation_evidence_unavailable" };
      const parsed = obligationsResult.safeParse(rows[0]!.result);
      const unknown = { schemaVersion: 2, outcome: "unknown", reason: "catalog_obligation_evidence_unknown" } as const;
      if (!parsed.success) return unknown;
      const value = parsed.data;
      if (value.outcome === "complete") {
        const seen = new Set<string>();
        for (const obligation of value.obligations) {
          if (obligation.skuId.toLowerCase() !== skuId.toLowerCase()) return unknown;
          const key = JSON.stringify([obligation.family, obligation.caseKind ?? "legacy", obligation.sourceId, obligation.skuRevisionId]);
          if (seen.has(key)) return unknown;
          seen.add(key);
        }
      }
      return value;
    } catch { return { schemaVersion: 2,outcome: "unavailable",reason: "catalog_obligation_evidence_unavailable" }; }
  } };
}
