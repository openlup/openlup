import { z } from "./validation.js";
import { catalogDraftPageSchema, catalogDraftRefusalSchema, catalogDraftSummarySchema } from "./draftSchemas.js";
import { catalogDraftPublicationStoredCommandSchema, catalogDraftPublicationStoredPayloadSchema } from "./draftV3Schemas.js";
import { readStoredLifecycleDraftPayload, type CatalogDraftPayloadV4 } from "./publicationIntent.js";

/** @experimental */
export const catalogDraftPayloadV4Schema = z.custom<CatalogDraftPayloadV4>(input => readStoredLifecycleDraftPayload(input) !== null);
const reference = z.string().refine(value => value.length >= 1 && value.length <= 240 && value.trim() === value);
/** @experimental */
export const catalogDraftCommandV4Schema = z.object({
  schemaVersion: z.literal(4), action: z.enum(["create", "revise", "abandon", "resume"]),
  draftId: z.guid().refine(value => value === value.toLowerCase()), commandKey: reference,
  expectedRevision: z.number().int().min(0).max(2_147_483_646), payload: catalogDraftPayloadV4Schema.optional(),
}).strict().refine(command =>
  (["create", "revise"].includes(command.action) === (command.payload !== undefined))
  && ((command.action === "create") === (command.expectedRevision === 0)));
/** @experimental */
export type CatalogDraftCommandV4 = z.infer<typeof catalogDraftCommandV4Schema>;
export const lifecycleStoredCommandSchema = z.union([catalogDraftPublicationStoredCommandSchema, catalogDraftCommandV4Schema]);
export const lifecycleStoredRecordSchema = catalogDraftSummarySchema.extend({
  payload: z.union([catalogDraftPublicationStoredPayloadSchema, catalogDraftPayloadV4Schema]),
}).strict().refine(record => record.productId === record.payload.product.id);
export const lifecycleStoredResultSchema = z.union([
  z.object({ outcome: z.enum(["committed", "replayed"]), record: lifecycleStoredRecordSchema }).strict(),
  catalogDraftRefusalSchema,
]);
export const lifecycleStoredPageSchema = z.object({
  items: z.array(lifecycleStoredRecordSchema), nextCursor: catalogDraftPageSchema.shape.nextCursor,
}).strict().refine(page => catalogDraftPageSchema.safeParse({
  ...page, items: page.items.map(({ payload: _payload, ...summary }) => summary),
}).success);
/** @experimental */
export type CatalogLifecycleDraftPage = z.infer<typeof lifecycleStoredPageSchema>;
