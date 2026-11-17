import type { PgQueryExecutor } from "../data/index.js";

/** Drain bounded batches with the explicitly supplied migration-owner executor; safe to resume.
 * @experimental
 */
export async function backfillCatalogNetContent(installExecutor: PgQueryExecutor, options: { batchSize: number }): Promise<void> {
  if (!Number.isSafeInteger(options.batchSize) || options.batchSize < 1 || options.batchSize > 2147483647) {
    throw new Error("invalid_catalog_backfill_batch_size");
  }
  for (;;) {
    const { rows } = await installExecutor.query(
      "SELECT public.catalog_net_content_backfill_batch($1::integer)::text AS remaining", [options.batchSize],
    );
    const remaining = rows[0]?.remaining;
    if (rows.length !== 1 || typeof remaining !== "string" || !/^(0|[1-9][0-9]*)$/.test(remaining)) {
      throw new Error("invalid_catalog_backfill_remaining");
    }
    if (BigInt(remaining) === 0n) return;
  }
}
