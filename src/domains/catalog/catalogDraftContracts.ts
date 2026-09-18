import { z } from "../../lib/validation/zod.js";
import { catalogDocumentRevisionRefSchema } from "./catalogFoundationContracts.js";
import {
  catalogDimensionKeySchema, catalogNamespacedKeySchema, catalogOptionValueSchema,
  catalogProductTypeRefSchema, catalogQuantitySchema,
} from "./catalogProductTypeContracts.js";

export const CATALOG_DRAFT_MAX_BYTES = 1_048_576;
export const CATALOG_DRAFT_MAX_PAGE = 100;
const id = z.guid().refine((value) => value === value.toLowerCase(), "UUID must be lowercase");
const reference = z.string().min(1).max(240).refine((value) => value.trim() === value);
const code = z.string().min(1).max(160).regex(/^[A-Za-z0-9._:-]+$/u);
const revision = z.number().int().min(0).max(2_147_483_646);
const persistedRevision = z.number().int().positive().max(2_147_483_647);
const commandKey = reference;
const jsonContent = z.unknown().refine((value) => value !== undefined, "content must be JSON");
export const catalogDraftPayloadSchema = z.object({
  schemaVersion: z.literal(1),
  product: z.object({
    id, type: catalogProductTypeRefSchema, slug: code.optional(), primarySkuId: id.optional(),
    dimensions: z.array(catalogDimensionKeySchema).max(16),
    sharedContent: jsonContent.optional(), documentRevision: catalogDocumentRevisionRefSchema.optional(),
  }).strict(),
  skus: z.array(z.object({
    id, productId: id, code: code.optional(),
    options: z.record(catalogDimensionKeySchema, catalogOptionValueSchema),
    netContent: catalogQuantitySchema.optional(),
    identifiers: z.array(z.object({
      scheme: catalogNamespacedKeySchema, issuer: reference, value: z.string().min(1).max(128),
      packagingLevel: z.enum(["unit", "case"]),
    }).strict()).max(32).optional(),
    assetRefs: z.array(reference).max(32).optional(), grossMass: catalogQuantitySchema.optional(),
    priceRef: reference.optional(), logisticsRef: reference.optional(),
  }).strict()).max(10_000),
}).strict().superRefine((payload, context) => {
  try { canonicalCatalogDraftJson(payload); } catch { context.addIssue({ code: "custom", message: "payload must be bounded safe JSON" }); }
  if (payload.product.documentRevision && payload.product.documentRevision.productId !== payload.product.id) {
    context.addIssue({ code: "custom", path: ["product", "documentRevision", "productId"], message: "document must belong to product" });
  }
  if (payload.product.primarySkuId && !payload.skus.some((sku) => sku.id === payload.product.primarySkuId)) {
    context.addIssue({ code: "custom", path: ["product", "primarySkuId"], message: "primary must belong to product" });
  }
  payload.skus.forEach((sku, index) => {
    if (sku.productId !== payload.product.id) context.addIssue({ code: "custom", path: ["skus", index, "productId"], message: "SKU must belong to product" });
  });
});
export const catalogDraftCommandSchema = z.object({
  schemaVersion: z.literal(1), action: z.enum(["create", "revise", "abandon"]),
  draftId: id, commandKey, expectedRevision: revision, payload: catalogDraftPayloadSchema.optional(),
}).strict().superRefine((command, context) => {
  if ((command.action === "abandon") === (command.payload !== undefined)) {
    context.addIssue({ code: "custom", path: ["payload"], message: "payload is required only for create and revise" });
  }
  if ((command.action === "create") !== (command.expectedRevision === 0)) {
    context.addIssue({ code: "custom", path: ["expectedRevision"], message: "create starts at revision zero; other commands require a persisted revision" });
  }
});
export const catalogDraftGetQuerySchema = z.object({
  draftId: id, revision: persistedRevision.optional(), commandKey: commandKey.optional(),
}).strict().refine((query) => query.revision === undefined || query.commandKey === undefined, "selectors are mutually exclusive");
export const catalogDraftListQuerySchema = z.object({
  afterDraftId: id.optional(), limit: z.number().int().min(1).max(CATALOG_DRAFT_MAX_PAGE),
}).strict();
export const catalogDraftSummarySchema = z.object({
  draftId: id, productId: id, revision: persistedRevision, status: z.enum(["open", "abandoned"]),
  commandKey, fingerprint: z.string().regex(/^[a-f0-9]{64}$/u), actorId: reference,
  createdAt: z.string().datetime({ offset: true }),
}).strict();
export const catalogDraftRecordSchema = catalogDraftSummarySchema.extend({ payload: catalogDraftPayloadSchema }).strict()
  .refine((record) => record.productId === record.payload.product.id, "record product must own payload");
export const catalogDraftPageSchema = z.object({
  items: z.array(catalogDraftSummarySchema).max(CATALOG_DRAFT_MAX_PAGE), nextCursor: id.nullable(),
}).strict().superRefine((page, context) => {
  const ids = page.items.map((item) => item.draftId);
  if (ids.some((value, index) => index > 0 && value <= ids[index - 1])
    || (page.nextCursor !== null && page.nextCursor !== ids[ids.length - 1])) {
    context.addIssue({ code: "custom", message: "page must have ordered unique heads and a matching cursor" });
  }
});
export const catalogDraftRefusalSchema = z.object({
  outcome: z.enum(["conflict", "validation_issue", "unauthorized", "dependency_unavailable"]),
  reason: z.string().min(1).max(160).regex(/^[a-z][a-z0-9_]*$/u), currentRevision: z.number().int().min(0).max(2_147_483_647).optional(),
}).strict();
export const catalogDraftApplyResultSchema = z.union([
  z.object({ outcome: z.enum(["committed", "replayed"]), record: catalogDraftRecordSchema }).strict(),
  catalogDraftRefusalSchema,
]);
export type CatalogDraftPayload = z.infer<typeof catalogDraftPayloadSchema>;
export type CatalogDraftCommand = z.infer<typeof catalogDraftCommandSchema>;
export type CatalogDraftRecord = z.infer<typeof catalogDraftRecordSchema>;
export type CatalogDraftSummary = z.infer<typeof catalogDraftSummarySchema>;
export type CatalogDraftPage = z.infer<typeof catalogDraftPageSchema>;
export type CatalogDraftRefusal = z.infer<typeof catalogDraftRefusalSchema>;
export type CatalogDraftApplyResult = z.infer<typeof catalogDraftApplyResultSchema>;
export type CatalogDraftGetQuery = z.infer<typeof catalogDraftGetQuerySchema>;
export type CatalogDraftListQuery = z.infer<typeof catalogDraftListQuerySchema>;

/** Reject lossy JSON inputs, prototype keys and excessive recursion before validation or hashing. */
export function canonicalCatalogDraftJson(input: unknown): string {
  const ancestors = new Set<object>();
  function visit(value: unknown, depth: number): unknown {
    if (depth > 48) throw new Error("draft_json_depth");
    if (typeof value === "string") {
      if (value.includes("\u0000") || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) throw new Error("draft_json_invalid");
      return value;
    }
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0)) return value;
    if (typeof value !== "object" || ancestors.has(value)) throw new Error("draft_json_invalid");
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error("draft_json_invalid");
    ancestors.add(value);
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string" || ["__proto__", "constructor", "prototype"].includes(key))) throw new Error("draft_json_invalid");
    for (const key of keys) {
      visit(key, depth + 1);
      if (Object.getOwnPropertyDescriptor(value, key)?.get || Object.getOwnPropertyDescriptor(value, key)?.set) throw new Error("draft_json_invalid");
    }
    let result: unknown;
    if (Array.isArray(value)) {
      if (keys.length !== value.length + 1) throw new Error("draft_json_invalid");
      result = Array.from(value, (item) => visit(item, depth + 1));
    } else {
      result = Object.fromEntries((keys as string[]).sort().map((key) => [key, visit((value as Record<string, unknown>)[key], depth + 1)]));
    }
    ancestors.delete(value);
    return result;
  }
  const text = JSON.stringify(visit(input, 0));
  if (new TextEncoder().encode(text).byteLength > CATALOG_DRAFT_MAX_BYTES) throw new Error("draft_payload_too_large");
  return text;
}
