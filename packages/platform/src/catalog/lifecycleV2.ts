import { z } from "./validation.js";
import { canonicalCatalogDraftJson } from "./contracts/draft.js";
import { catalogDraftRefusalSchema, catalogDraftSummarySchema } from "./draftSchemas.js";
import { catalogDraftPayloadV3Schema, catalogDraftPublicationStoredPayloadSchema, catalogDraftPublicationStoredCommandSchema, catalogDraftSharedContentV3Schema } from "./draftV3Schemas.js";
import { catalogDraftProductV2Schema, catalogDraftSkuV2Schema } from "./draftV2Schemas.js";
import { catalogProductTypeRefSchema, catalogQuantitySchema } from "./productTypeSchemas.js";
import type { CatalogLifecycleStateV2, CatalogLifecycleOperationV2, CatalogDraftPayloadV4, CatalogDraftCommandV4, CatalogLifecycleStoredPayload,
  CatalogLifecycleStoredCommand, CatalogLifecycleStoredRecord, CatalogAcceptedReferenceV2, CatalogProductState, CatalogSkuState } from "./contracts/lifecycleV2.js";
import { publicationRefuse } from "./publicationValidation.js";
const id = z.guid().refine(value => value === value.toLowerCase());
const revision = z.number().int().min(1).max(2_147_483_647);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const ref = z.string().min(1).max(240).refine(value => value.trim() === value);
const code = z.string().min(1).max(160).regex(/^[A-Za-z0-9._:-]+$/u);
const slug = z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9_-]*$/u);
/** @experimental */
export const catalogLifecycleStateV2Schema = z.enum(["draft", "active", "withdrawn", "archived"]);
const destination = z.enum(["active", "withdrawn", "archived"]);
/** @experimental */
export const catalogLifecycleOperationV2Schema: z.ZodType<CatalogLifecycleOperationV2> = z.discriminatedUnion("op", [
  z.object({ op: z.literal("set_product_lifecycle"), productSlug: slug, expectedState: catalogLifecycleStateV2Schema, state: destination,
    children: z.array(z.object({ skuCode: code, expectedState: catalogLifecycleStateV2Schema }).strict()).max(50_000)
      .refine(rows => rows.every((row, index) => index === 0 || rows[index - 1]!.skuCode < row.skuCode)) }).strict(),
  z.object({ op: z.literal("restore_product"), productSlug: slug, expectedState: z.literal("withdrawn") }).strict(),
  z.object({ op: z.literal("set_sku_lifecycle"), skuCode: code, expectedState: catalogLifecycleStateV2Schema, state: destination }).strict(),
  z.object({ op: z.literal("restore_sku"), skuCode: code, expectedState: z.literal("withdrawn") }).strict(),
]);
/** @experimental */
export function catalogLifecycleTransitionV2(from: CatalogLifecycleStateV2, to: CatalogLifecycleStateV2, restore = false): boolean {
  if (restore) return from === "withdrawn" && to === "active";
  return from === "draft" && (to === "active" || to === "archived")
    || from === "active" && (to === "active" || to === "withdrawn")
    || from === "withdrawn" && to === "archived";
}
/** The v3 grammar still owns every unchanged operation and ordered source guard.
 * @experimental
 */
export const catalogDraftPayloadV4Schema: z.ZodType<CatalogDraftPayloadV4> = z.object({ schemaVersion: z.literal(4),
  product: catalogDraftProductV2Schema.extend({ sharedContent: catalogDraftSharedContentV3Schema }).strict(),
  skus: z.array(catalogDraftSkuV2Schema).max(10_000),
  publication: z.object({ kind: z.enum(["release", "compensation"]), operations: z.array(z.unknown()), evidence: z.unknown() }).strict(),
}).strict().superRefine((payload, context) => {
  const oldOperations: unknown[] = [];
  for (const [index, operation] of payload.publication.operations.entries()) {
    const parsed = catalogLifecycleOperationV2Schema.safeParse(operation);
    if (parsed.success) {
      const op = parsed.data;
      if (op.op === "set_sku_lifecycle" && op.state === "active" && !payload.publication.operations.some(other => {
        const row = other as Record<string, unknown>;
        return row?.op === "set_eligibility" && row.skuCode === op.skuCode && (row.sellableStandalone === true || row.sellableInSubscription === true);
      })) context.addIssue({ code: "custom", path: ["publication", "operations", index], message: "activation requires explicit enabling eligibility" });
      continue;
    }
    const name = (operation as Record<string, unknown> | null)?.op;
    if (name === "set_product_status" || name === "set_sku_status" || ["set_product_lifecycle", "set_sku_lifecycle", "restore_product", "restore_sku"].includes(String(name))) {
      context.addIssue({ code: "custom", path: ["publication", "operations", index], message: "invalid lifecycle operation or raw status write" }); continue;
    }
    oldOperations.push(operation);
  }
  const base = catalogDraftPayloadV3Schema.safeParse({ ...payload, schemaVersion: 3, publication: { ...payload.publication, operations: oldOperations } });
  if (!base.success) for (const issue of base.error.issues) context.addIssue({ code: "custom", path: issue.path, message: issue.message });
  try { canonicalCatalogDraftJson(payload); } catch { context.addIssue({ code: "custom", message: "payload must be bounded safe JSON" }); }
}) as z.ZodType<CatalogDraftPayloadV4>;
/** @experimental */
export const catalogDraftCommandV4Schema: z.ZodType<CatalogDraftCommandV4> = z.object({ schemaVersion: z.literal(4), action: z.enum(["create", "revise", "abandon", "resume"]),
  draftId: id, commandKey: ref, expectedRevision: z.number().int().min(0).max(2_147_483_646), payload: catalogDraftPayloadV4Schema.optional() }).strict()
  .refine(command => ["create", "revise"].includes(command.action) ? command.payload !== undefined : command.payload === undefined);
/** @experimental */
export const catalogLifecycleStoredPayloadSchema: z.ZodType<CatalogLifecycleStoredPayload> = z.union([catalogDraftPublicationStoredPayloadSchema, catalogDraftPayloadV4Schema]);
/** @experimental */
export const catalogLifecycleStoredCommandSchema: z.ZodType<CatalogLifecycleStoredCommand> = z.union([catalogDraftPublicationStoredCommandSchema, catalogDraftCommandV4Schema]);
/** @experimental */
export const catalogLifecycleStoredRecordSchema: z.ZodType<CatalogLifecycleStoredRecord> = catalogDraftSummarySchema.extend({ payload: catalogLifecycleStoredPayloadSchema }).strict();
/** @experimental */
export const catalogAcceptedReferenceV2Schema: z.ZodType<CatalogAcceptedReferenceV2> = z.object({ schemaVersion: z.literal(2), skuId: id, skuCode: code, skuRevisionId: id,
  publicationHead: z.object({ publicationId: id, revision, documentDigest: digest }).strict(), typeRef: catalogProductTypeRefSchema, definitionDigest: digest, optionDigest: digest,
  netContent: catalogQuantitySchema, demandPolicyRef: ref.optional(),
  subscriptionProfile: catalogProductTypeRefSchema.extend({ digest }).optional() }).strict();
/** @experimental */
export function catalogAuthoritativeLifecycleV2(value: CatalogProductState | CatalogSkuState): CatalogLifecycleStateV2 {
  if (!("schemaVersion" in value) || value.schemaVersion !== 3) return publicationRefuse("catalog_lifecycle_authority_unavailable", "unsupported");
  return value.lifecycleState;
}
/** @experimental */
export function catalogLifecycleProjectionV2(state: CatalogLifecycleStateV2): "draft" | "active" | "archived" { return state === "withdrawn" ? "active" : state; }

/** @experimental */
export const catalogLifecycleStoredApplyResultSchema = z.union([z.object({ outcome: z.enum(["committed", "replayed"]), record: catalogLifecycleStoredRecordSchema }).strict(), catalogDraftRefusalSchema]);
/** @experimental */
export function catalogLifecycleValidationPayload(payload: CatalogLifecycleStoredPayload): import("./contracts/draftV2.js").CatalogDraftPayloadV2 {
  if (payload.schemaVersion === 1) return publicationRefuse("candidate_requires_payload_v2");
  if (payload.schemaVersion === 2) return payload;
  const { publication: _publication, ...base } = payload as import("./contracts/draftV3.js").CatalogDraftPayloadV3 | CatalogDraftPayloadV4;
  return { ...base, schemaVersion: 2 as const };
}

/** @experimental */
export function resolveCatalogLifecycleProvenance(provenance: import("./contracts/draftV3.js").CatalogDraftProvenanceV3, record: CatalogLifecycleStoredRecord) {
  if (provenance.source === "retained_draft") { const { source: _source, ...tuple } = provenance; return tuple; }
  const current = catalogLifecycleStoredRecordSchema.parse(record);
  return { draftId: current.draftId, draftRevision: current.revision, draftCommandKey: current.commandKey, draftFingerprint: current.fingerprint };
}
