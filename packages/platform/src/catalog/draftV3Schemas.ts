import { z } from "./validation.js";
import { canonicalCatalogDraftJson } from "./contracts/draft.js";
import { catalogDraftSummarySchema, catalogDraftRefusalSchema } from "./draftSchemas.js";
import { catalogDraftProductV2Schema, catalogDraftSkuV2Schema, catalogDraftPayloadV2Schema, catalogDraftStoredCommandSchema, catalogDraftStoredPayloadSchema } from "./draftV2Schemas.js";
import { catalogNamespacedKeySchema, catalogQuantitySchema } from "./productTypeSchemas.js";
import { isValidGtin } from "./foundationSchemas.js";
import type { CatalogDraftPayloadV3, CatalogDraftCommandV3, CatalogDraftSharedContentV3, CatalogDraftProvenanceV3,
  CatalogDraftPublicationOperationV3, CatalogDraftPublicationInputsV3, CatalogDraftPublicationStoredPayload,
  CatalogDraftPublicationStoredCommand, CatalogDraftPublicationStoredRecord, CatalogDraftPublicationStoredApplyResult,
  CatalogPublicationJson, CatalogPublicationFacts } from "./contracts/draftV3.js";

const id = z.guid().refine(value => value === value.toLowerCase());
const revision = z.number().int().min(1).max(2_147_483_647);
const documentRevision = z.number().int().min(1).max(999_999_999);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const reference = z.string().min(1).max(240).refine(value => value.trim() === value);
const code = z.string().min(1).max(160).regex(/^[A-Za-z0-9._:-]+$/u);
const slug = z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9_-]*$/u);
const text = z.string().min(1).max(500).refine(value => value.trim() === value);
const json: z.ZodType<CatalogPublicationJson> = z.json();
const facts: z.ZodType<CatalogPublicationFacts> = z.record(z.string(), json);
const skuFacts = z.object({ skuCode: code, title: text, minQuantity: z.number().int().min(1).max(2_147_483_647), isAddon: z.boolean(), facts }).strict();
const membership = z.object({ skuCode: code, offerVersion: reference, admitted: z.boolean() }).strict();
const sharedContentShape = {
  schemaVersion: z.literal(1), catalogAction: z.enum(["create", "revise"]), presentation: facts,
  offerMemberships: z.array(membership).max(10_000),
  requestedModes: z.array(z.object({ skuCode: code, modes: z.array(z.enum(["one_time", "subscription"])).max(2)
    .refine(values => new Set(values).size === values.length) }).strict()).max(10_000),
  publicationSkus: z.array(skuFacts).max(10_000),
};
function uniqueSkuIntents(content: Omit<CatalogDraftSharedContentV3, "document">, context: z.RefinementCtx) {
  for (const key of ["offerMemberships", "requestedModes", "publicationSkus"] as const) {
    const codes = content[key].map(row => row.skuCode);
    if (new Set(codes).size !== codes.length) context.addIssue({ code: "custom", path: [key], message: "SKU intents must be unique" });
  }
}
export const catalogPublicationContentSchema: z.ZodType<Omit<CatalogDraftSharedContentV3, "document">> = z.object(sharedContentShape).strict().superRefine(uniqueSkuIntents);
/** @experimental */
export const catalogDraftSharedContentV3Schema: z.ZodType<CatalogDraftSharedContentV3> =
  z.object({ ...sharedContentShape, document: facts.optional() }).strict().superRefine(uniqueSkuIntents);
/** @experimental */
export const catalogDraftProvenanceV3Schema: z.ZodType<CatalogDraftProvenanceV3> = z.discriminatedUnion("source", [
  z.object({ source: z.literal("current_draft") }).strict(),
  z.object({ source: z.literal("retained_draft"), draftId: id, draftRevision: revision, draftCommandKey: reference, draftFingerprint: digest }).strict(),
]);
/** @experimental */
export const catalogDraftPublicationOperationV3Schema: z.ZodType<CatalogDraftPublicationOperationV3> = z.discriminatedUnion("op", [
  z.object({ op: z.literal("create_product"), productId: id, productSlug: slug, name: text }).strict(),
  z.object({ op: z.literal("register_document_revision"), productSlug: slug, revisionId: id, revisionNo: documentRevision,
    documentRef: reference, sourceRef: reference, canonicalText: z.string().min(1), digest, provenance: catalogDraftProvenanceV3Schema }).strict(),
  skuFacts.extend({ op: z.literal("create_sku"), skuId: id, productSlug: slug, documentRevisionNo: documentRevision }).strict(),
  z.object({ op: z.literal("create_identifier"), skuCode: code, scheme: catalogNamespacedKeySchema, issuer: reference, value: z.string().min(1).max(128),
    packagingLevel: z.enum(["unit", "case"]), quantity: z.number().int().min(1).max(999_999), isPrimary: z.boolean(),
    label: text.nullable(), sourceRef: reference.nullable() }).strict(),
  z.object({ op: z.literal("set_eligibility"), skuCode: code, sellableStandalone: z.boolean(), sellableInSubscription: z.boolean() }).strict(),
  z.object({ op: z.literal("set_sku_status"), skuCode: code, status: z.enum(["active", "archived"]) }).strict(),
  z.object({ op: z.literal("move_document_pointer"), productSlug: slug, documentRevisionNo: documentRevision }).strict(),
  z.object({ op: z.literal("set_primary_sku"), productSlug: slug, skuCode: code }).strict(),
  z.object({ op: z.literal("set_product_status"), productSlug: slug, status: z.enum(["active", "archived"]) }).strict(),
  membership.extend({ op: z.literal("set_offer_membership") }).strict(),
  z.object({ op: z.literal("set_product_presentation"), productSlug: slug, presentation: facts.nullable() }).strict(),
  z.object({ op: z.literal("set_sku_metadata"), skuCode: code, logisticsRef: reference.nullable() }).strict(),
  z.object({ op: z.literal("set_derived_sku_facts"), skuCode: code, documentRevisionNo: documentRevision, netContent: catalogQuantitySchema, facts }).strict(),
]);
/** @experimental */
export const catalogDraftPublicationInputsV3Schema: z.ZodType<CatalogDraftPublicationInputsV3> = z.object({
  kind: z.enum(["release", "compensation"]), operations: z.array(catalogDraftPublicationOperationV3Schema),
  evidence: z.object({
    drafts: z.array(z.object({ draftId: id, revision, commandKey: reference, fingerprint: digest }).strict()).min(1).max(100).optional(),
    media: z.array(z.object({ skuCode: code, mediaRef: reference, assetRefs: z.array(reference).max(32)
      .refine(values => values.every((value, index) => index === 0 || values[index - 1]! < value)), revisionDigest: digest }).strict()).min(1).optional(),
  }).strict(),
}).strict().superRefine((input, context) => {
  const issue = (message: string) => context.addIssue({ code: "custom", message });
  const drafts = input.evidence.drafts ?? [], media = input.evidence.media ?? [];
  if (new Set(drafts.map(row => row.draftId)).size !== drafts.length) issue("draft evidence must be unique");
  if (new Set(media.map(row => row.skuCode)).size !== media.length) issue("media evidence must be unique");
  const created = new Set<string>(), primaries = new Set<string>(), identities = new Set<string>();
  for (const operation of input.operations) {
    const keys = operation.op === "create_product" ? [`product:${operation.productId}`, `slug:${operation.productSlug}`]
      : operation.op === "create_sku" ? [`sku:${operation.skuId}`, `code:${operation.skuCode}`]
      : operation.op === "register_document_revision" ? [`document:${operation.revisionId}`, `revision:${operation.productSlug}:${operation.revisionNo}`] : [];
    for (const key of keys) { if (identities.has(key)) issue("operation identities must be unique"); identities.add(key); }
    if (operation.op === "create_sku") created.add(operation.skuCode);
    if (operation.op === "create_identifier") {
      if (!created.has(operation.skuCode)) issue("identifier precedes or lacks SKU creation");
      if ((operation.packagingLevel === "unit") !== (operation.quantity === 1)) issue("identifier quantity contradicts packaging level");
      if (operation.isPrimary && (operation.packagingLevel !== "unit" || primaries.has(operation.skuCode))) issue("second or non-unit primary identifier");
      if (operation.isPrimary) primaries.add(operation.skuCode);
      if (operation.scheme === "gs1:gtin") {
        if (!isValidGtin(operation.value)) issue("invalid GTIN");
        const key = `gtin:${operation.value.padStart(14, "0")}`;
        if (identities.has(key)) issue("duplicate GTIN"); identities.add(key);
      }
    }
    if (operation.op === "set_sku_status" && operation.status === "active" && !input.operations.some(other => other.op === "set_eligibility"
      && other.skuCode === operation.skuCode && (other.sellableStandalone || other.sellableInSubscription))) issue("activation requires explicit enabling eligibility");
    if (operation.op === "register_document_revision" && operation.provenance.source === "retained_draft") {
      const p = operation.provenance;
      if (!drafts.some(row => row.draftId === p.draftId && row.revision === p.draftRevision && row.commandKey === p.draftCommandKey
        && row.fingerprint === p.draftFingerprint)) issue("document provenance lacks matching draft evidence");
    }
  }
});
/** Removes only the additive carrier/version for existing scalar, attribute and price validation. */
/** @experimental */
export function catalogDraftV3ValidationPayload(payload: CatalogDraftPayloadV3) {
  const { publication: _publication, ...base } = payload;
  return { ...base, schemaVersion: 2 as const };
}
function draftPayloadV3Schema(content: z.ZodType<CatalogDraftSharedContentV3>): z.ZodType<CatalogDraftPayloadV3> {
  return z.object({
    schemaVersion: z.literal(3), product: catalogDraftProductV2Schema.extend({ sharedContent: content }).strict(),
    skus: z.array(catalogDraftSkuV2Schema).max(10_000), publication: catalogDraftPublicationInputsV3Schema,
  }).strict().superRefine((payload, context) => {
    try { canonicalCatalogDraftJson(payload); } catch { context.addIssue({ code: "custom", message: "payload must be bounded safe JSON" }); }
    const base = catalogDraftPayloadV2Schema.safeParse(catalogDraftV3ValidationPayload(payload));
    if (!base.success) for (const issue of base.error.issues) context.addIssue({ code: "custom", path: issue.path, message: issue.message });
  });
}
/** @experimental */
export const catalogDraftPayloadV3Schema = draftPayloadV3Schema(catalogDraftSharedContentV3Schema);

// The released draft codec owns its wire shape. Publication checks the neutral
// envelope and retains the opaque legacy value for the installed rules.
export const catalogPublicationDraftPayloadSchema = draftPayloadV3Schema(
  z.object({ ...sharedContentShape, document: z.custom<CatalogPublicationFacts>().optional() }).strict().superRefine(uniqueSkuIntents),
);
export const catalogPublicationDraftRecordSchema: z.ZodType<CatalogDraftPublicationStoredRecord> = catalogDraftSummarySchema.extend({ payload: catalogPublicationDraftPayloadSchema }).strict()
  .refine(record => record.productId === record.payload.product.id, "record product must own payload");
/** @experimental */
export const catalogDraftCommandV3Schema: z.ZodType<CatalogDraftCommandV3> = z.object({
  schemaVersion: z.literal(3), action: z.enum(["create", "revise", "abandon", "resume"]),
  draftId: id, commandKey: reference,
  expectedRevision: z.number().int().min(0).max(2_147_483_646), payload: catalogDraftPayloadV3Schema.optional(),
}).strict().superRefine((command, context) => {
  if (["create", "revise"].includes(command.action) !== (command.payload !== undefined))
    context.addIssue({ code: "custom", path: ["payload"], message: "payload is required only for create and revise" });
  if ((command.action === "create") !== (command.expectedRevision === 0))
    context.addIssue({ code: "custom", path: ["expectedRevision"], message: "create starts at revision zero; other commands require a persisted revision" });
});
/** @experimental */
export const catalogDraftPublicationStoredPayloadSchema: z.ZodType<CatalogDraftPublicationStoredPayload> = z.union([catalogDraftStoredPayloadSchema, catalogDraftPayloadV3Schema]);
/** @experimental */
export const catalogDraftPublicationStoredCommandSchema: z.ZodType<CatalogDraftPublicationStoredCommand> = z.union([catalogDraftStoredCommandSchema, catalogDraftCommandV3Schema]);
/** @experimental */
export const catalogDraftPublicationStoredRecordSchema: z.ZodType<CatalogDraftPublicationStoredRecord> = catalogDraftSummarySchema.extend({ payload: catalogDraftPublicationStoredPayloadSchema }).strict()
  .refine(record => record.productId === record.payload.product.id, "record product must own payload");
/** @experimental */
export const catalogDraftPublicationStoredApplyResultSchema: z.ZodType<CatalogDraftPublicationStoredApplyResult> = z.union([
  z.object({ outcome: z.enum(["committed", "replayed"]), record: catalogDraftPublicationStoredRecordSchema }).strict(), catalogDraftRefusalSchema,
]);
/** Exact typed extraction: no path guessing, coercion, defaults, operation sorting or collapsing.
 * @experimental
 */
export function extractCatalogDraftPublicationInputs(payload: unknown): { content: CatalogDraftSharedContentV3; publication: CatalogDraftPublicationInputsV3 } {
  canonicalCatalogDraftJson(payload);
  const parsed = catalogDraftPayloadV3Schema.parse(payload);
  return { content: parsed.product.sharedContent, publication: parsed.publication };
}
/** Resolves the current source only after persistence; retained tuples still require authority verification at publication.
 * @experimental
 */
export function resolveCatalogDraftProvenance(provenance: CatalogDraftProvenanceV3, record: CatalogDraftPublicationStoredRecord) {
  const parsed = catalogDraftProvenanceV3Schema.parse(provenance);
  if (parsed.source === "retained_draft") { const { source: _source, ...tuple } = parsed; return tuple; }
  const current = catalogDraftPublicationStoredRecordSchema.parse(record);
  return { draftId: current.draftId, draftRevision: current.revision, draftCommandKey: current.commandKey, draftFingerprint: current.fingerprint };
}
