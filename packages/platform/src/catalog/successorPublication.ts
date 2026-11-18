import { z } from "./validation.js";
import { canonicalCatalogDraftJson } from "./contracts/draft.js";
import { catalogDraftRefusalSchema, catalogDraftSummarySchema } from "./draftSchemas.js";
import { catalogDraftPayloadV4Schema, catalogLifecycleStoredPayloadSchema, catalogLifecycleStoredCommandSchema } from "./lifecycleV2.js";
import { catalogDraftProductV2Schema, catalogDraftSkuV2Schema } from "./draftV2Schemas.js";
import { catalogDraftSharedContentV3Schema } from "./draftV3Schemas.js";
import type { CatalogDraftCommandV5, CatalogDraftPayloadV5, CatalogSuccessorStoredRecord, CatalogSuccessorStoredCommand } from "./contracts/successors.js";

const id = z.guid().refine(value => value === value.toLowerCase());
/** Separate authoring version; older strict schemas retain their grammar and bytes.
 * @experimental
 */
export const catalogDraftPayloadV5Schema: z.ZodType<CatalogDraftPayloadV5> = z.object({
  schemaVersion: z.literal(5),
  product: catalogDraftProductV2Schema.extend({ sharedContent: catalogDraftSharedContentV3Schema }).strict(),
  skus: z.array(catalogDraftSkuV2Schema).max(10_000),
  publication: z.object({ kind: z.enum(["release", "compensation"]), operations: z.array(z.unknown()), evidence: z.unknown() }).strict(),
}).strict().superRefine((payload, context) => {
  const operations = payload.publication.operations.map((raw, index) => {
    if (typeof raw !== "object" || raw === null || !("successorOf" in raw)) return raw;
    const { successorOf, ...operation } = raw;
    if (!("op" in operation) || operation.op !== "create_sku" || !id.safeParse(successorOf).success
      || "skuId" in operation && operation.skuId === successorOf) {
      context.addIssue({ code: "custom", path: ["publication", "operations", index], message: "successor declaration requires distinct SKU identities" });
    }
    return operation;
  });
  const base = catalogDraftPayloadV4Schema.safeParse({ ...payload, schemaVersion: 4, publication: { ...payload.publication, operations } });
  if (!base.success) for (const issue of base.error.issues) context.addIssue({ code: "custom", path: issue.path, message: issue.message });
  try { canonicalCatalogDraftJson(payload); } catch { context.addIssue({ code: "custom", message: "payload must be bounded safe JSON" }); }
}) as z.ZodType<CatalogDraftPayloadV5>;
/** @experimental */
export const catalogDraftCommandV5Schema: z.ZodType<CatalogDraftCommandV5> = z.object({ schemaVersion: z.literal(5),
  action: z.enum(["create", "revise", "abandon", "resume"]), draftId: id,
  commandKey: z.string().min(1).max(240).refine(value => value.trim() === value), expectedRevision: z.number().int().min(0).max(2_147_483_646), payload: catalogDraftPayloadV5Schema.optional(),
}).strict().refine(command => ["create", "revise"].includes(command.action) ? command.payload !== undefined : command.payload === undefined);
/** @experimental */
export const catalogSuccessorStoredPayloadSchema = z.union([catalogLifecycleStoredPayloadSchema, catalogDraftPayloadV5Schema]);
/** @experimental */
export const catalogSuccessorStoredCommandSchema: z.ZodType<CatalogSuccessorStoredCommand> = z.union([catalogLifecycleStoredCommandSchema, catalogDraftCommandV5Schema]);
/** @experimental */
export const catalogSuccessorStoredRecordSchema: z.ZodType<CatalogSuccessorStoredRecord> = catalogDraftSummarySchema.extend({ payload: catalogSuccessorStoredPayloadSchema }).strict();
/** @experimental */
export const catalogSuccessorStoredApplyResultSchema = z.union([z.object({ outcome: z.enum(["committed", "replayed"]), record: catalogSuccessorStoredRecordSchema }).strict(), catalogDraftRefusalSchema]);
/** Pure validation adapter only: original canonical payload remains the digest input.
 * @experimental
 */
export function catalogSuccessorValidationPayload(payload: CatalogDraftPayloadV5): import("./contracts/lifecycleV2.js").CatalogDraftPayloadV4 {
  return { ...payload, schemaVersion: 4, publication: { ...payload.publication, operations: payload.publication.operations.map(operation => {
    if (operation.op !== "create_sku" || !("successorOf" in operation)) return operation;
    const { successorOf: _source, ...old } = operation; return old;
  }) } };
}
