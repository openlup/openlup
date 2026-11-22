import type { PgQueryExecutor } from "../data/index.js";
import type { CatalogAcceptedReferenceV2, CatalogAcceptanceV2 } from "@openlup/core/catalog";
import { z } from "./validation.js";
import { catalogProductTypeRefSchema, catalogQuantitySchema } from "./productTypeSchemas.js";

const id = z.guid().refine(value => value === value.toLowerCase());
const revision = z.number().int().min(1).max(2_147_483_647);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const policy = z.string().min(1).max(240).refine(value => value.trim() === value);

/** @experimental */
export const catalogAcceptedReferenceV2Schema: z.ZodType<CatalogAcceptedReferenceV2> = z.object({
  schemaVersion: z.literal(2),
  skuId: id,
  skuCode: z.string().min(1).max(160).regex(/^[A-Za-z0-9._:-]+$/u),
  skuRevisionId: id,
  publicationHead: z.object({ publicationId: id, revision, documentDigest: digest }).strict(),
  typeRef: catalogProductTypeRefSchema,
  definitionDigest: digest,
  optionDigest: digest,
  netContent: catalogQuantitySchema,
  demandPolicyRef: policy.optional(),
}).strict();

/** @experimental */
export const catalogAcceptanceV2Schema: z.ZodType<CatalogAcceptanceV2> = z.object({ schemaVersion: z.literal(2),
  lines: z.array(catalogAcceptedReferenceV2Schema).min(1).max(100).refine(lines => new Set(lines.map(line => line.skuId)).size === lines.length && new Set(lines.map(line => line.skuCode)).size === lines.length) }).strict();
/** Verifies only supplied immutable identity. It neither infers a legacy binding nor acquires commerce locks.
 * @experimental
 */
export async function assertCatalogAcceptedReferenceV2(db: PgQueryExecutor, value: unknown): Promise<CatalogAcceptedReferenceV2> {
  const reference = catalogAcceptedReferenceV2Schema.parse(value);
  await db.query("SELECT public.catalog_accepted_reference_assert_v2($1::jsonb)", [JSON.stringify(reference)]);
  return reference;
}
/** Validates the supplied roster in the caller’s transaction.
 * @experimental
 */
export async function assertCatalogAcceptanceV2(db: PgQueryExecutor, value: unknown): Promise<CatalogAcceptanceV2> {
  const acceptance = catalogAcceptanceV2Schema.parse(value);
  await db.query("SELECT public.catalog_acceptance_assert_v2($1::jsonb)", [JSON.stringify(acceptance)]);
  return acceptance;
}
