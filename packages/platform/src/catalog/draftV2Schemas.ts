import { z } from "./validation.js";
import { canonicalCatalogDraftJson } from "./contracts/draft.js";
import { catalogDraftPayloadSchema, catalogDraftCommandSchema, catalogDraftSummarySchema, catalogDraftRefusalSchema } from "./draftSchemas.js";
import { catalogQuantitySchema } from "./productTypeSchemas.js";
import { catalogAttributeReferenceSchema } from "./attributeSchemas.js";
import type { CatalogDraftPriceOperationV2, CatalogDraftPayloadV2, CatalogDraftCommandV2, CatalogDraftStoredPayload,
  CatalogDraftStoredCommand, CatalogDraftStoredRecord, CatalogDraftStoredApplyResult } from "./contracts/draftV2.js";

const id = z.guid().refine(value => value === value.toLowerCase(), "UUID must be lowercase");
const amount = z.number().int().min(0).max(2_147_483_647);
/** Exact price setup command grammar, including the original positive-only write boundary.
 * @experimental
 */
export const catalogDraftPriceOperationV2Schema: z.ZodType<CatalogDraftPriceOperationV2> = z.object({
  schemaVersion: z.literal(1),
  commandKey: z.string().min(1).max(240).refine(value => value.trim() === value, "command key must be trimmed"),
  variantId: id, priceListId: id, mode: z.literal("one_time"), minQty: z.literal(1), amountKind: z.literal("gross"),
  unitPriceMinor: z.number().int().min(1).max(2_147_483_647),
  expected: z.union([
    z.object({ entryId: z.null(), unitPriceMinor: z.null() }).strict(),
    z.object({ entryId: id, unitPriceMinor: amount }).strict(),
  ]),
}).strict();
const scalar = z.union([z.string(), z.boolean(), catalogQuantitySchema, catalogAttributeReferenceSchema, z.record(z.string(), z.string())]);
const attributes = z.record(z.string(), z.union([scalar, z.array(scalar)]));
// Keep the legacy leaf grammar without its cross-product refinement; check ownership below.
const legacy = catalogDraftPayloadSchema;
export const catalogDraftSkuV2Schema = legacy.shape.skus.element.omit({ priceRef: true }).extend({
  attributes: attributes.optional(), priceOperations: z.array(catalogDraftPriceOperationV2Schema).optional(),
}).strict();
export const catalogDraftProductV2Schema = legacy.shape.product.extend({ attributes: attributes.optional() }).strict();
/** @experimental */
export const catalogDraftPayloadV2Schema: z.ZodType<CatalogDraftPayloadV2> = z.object({
  schemaVersion: z.literal(2), product: catalogDraftProductV2Schema,
  skus: z.array(catalogDraftSkuV2Schema).max(10_000),
}).strict().superRefine((payload, context) => {
  try { canonicalCatalogDraftJson(payload); } catch { context.addIssue({ code: "custom", message: "payload must be bounded safe JSON" }); }
  const { attributes: _attributes, ...product } = payload.product;
  const v1 = legacy.safeParse({ schemaVersion: 1, product, skus: payload.skus.map(({ attributes: _a, priceOperations: _p, ...s }) => s) });
  if (!v1.success) for (const issue of v1.error.issues) context.addIssue({ code: "custom", path: issue.path, message: issue.message });
  payload.skus.forEach((s, index) => s.priceOperations?.forEach((operation, operationIndex) => {
    if (operation.variantId !== s.id) context.addIssue({ code: "custom", path: ["skus", index, "priceOperations", operationIndex, "variantId"], message: "price operation must belong to SKU" });
  }));
});
/** @experimental */
export const catalogDraftCommandV2Schema: z.ZodType<CatalogDraftCommandV2> = z.object({
  schemaVersion: z.literal(2), action: z.enum(["create", "revise", "abandon", "resume"]),
  draftId: id, commandKey: catalogDraftCommandSchema.shape.commandKey,
  expectedRevision: catalogDraftCommandSchema.shape.expectedRevision, payload: catalogDraftPayloadV2Schema.optional(),
}).strict().superRefine((command, context) => {
  if (["create", "revise"].includes(command.action) !== (command.payload !== undefined))
    context.addIssue({ code: "custom", path: ["payload"], message: "payload is required only for create and revise" });
  if ((command.action === "create") !== (command.expectedRevision === 0))
    context.addIssue({ code: "custom", path: ["expectedRevision"], message: "create starts at revision zero; other commands require a persisted revision" });
});
/** @experimental */
export const catalogDraftStoredPayloadSchema: z.ZodType<CatalogDraftStoredPayload> = z.union([catalogDraftPayloadSchema, catalogDraftPayloadV2Schema]);
/** @experimental */
export const catalogDraftStoredCommandSchema: z.ZodType<CatalogDraftStoredCommand> = z.union([catalogDraftCommandSchema, catalogDraftCommandV2Schema]);
/** @experimental */
export const catalogDraftStoredRecordSchema: z.ZodType<CatalogDraftStoredRecord> = catalogDraftSummarySchema.extend({ payload: catalogDraftStoredPayloadSchema }).strict()
  .refine(record => record.productId === record.payload.product.id, "record product must own payload");
/** @experimental */
export const catalogDraftStoredApplyResultSchema: z.ZodType<CatalogDraftStoredApplyResult> = z.union([
  z.object({ outcome: z.enum(["committed", "replayed"]), record: catalogDraftStoredRecordSchema }).strict(), catalogDraftRefusalSchema,
]);
