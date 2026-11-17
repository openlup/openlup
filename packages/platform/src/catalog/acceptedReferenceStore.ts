import type { PgQueryExecutor } from "../data/index.js";
import type { CatalogAcceptedReferenceV2, CatalogAcceptanceV2 } from "@openlup/core/catalog";
import { z } from "./validation.js";
import { catalogAcceptedReferenceV2Schema } from "./lifecycleV2.js";
/** @experimental */
export const catalogAcceptanceV2Schema: z.ZodType<CatalogAcceptanceV2> = z.object({ schemaVersion: z.literal(2),
  lines: z.array(catalogAcceptedReferenceV2Schema).min(1).max(100).refine(lines => new Set(lines.map(line => line.skuId)).size === lines.length) }).strict();
/** Verifies only supplied immutable identity. It neither infers a legacy binding nor acquires commerce locks.
 * @experimental
 */
export async function assertCatalogAcceptedReferenceV2(db: PgQueryExecutor, value: unknown): Promise<CatalogAcceptedReferenceV2> {
  const reference = catalogAcceptedReferenceV2Schema.parse(value);
  await db.query("SELECT public.catalog_accepted_reference_assert_v2($1::jsonb)", [JSON.stringify(reference)]);
  return reference;
}
/** Capture into orders, edits and frozen terms remains the commerce-first acceptance fence's responsibility.
 * @experimental
 */
export async function assertCatalogAcceptanceV2(db: PgQueryExecutor, value: unknown): Promise<CatalogAcceptanceV2> {
  const acceptance = catalogAcceptanceV2Schema.parse(value);
  await db.query("SELECT public.catalog_acceptance_assert_v2($1::jsonb)", [JSON.stringify(acceptance)]);
  return acceptance;
}
