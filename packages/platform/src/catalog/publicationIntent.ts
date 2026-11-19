import { z } from "./validation.js";
import { canonicalCatalogDraftJson } from "./contracts/draft.js";
import type { CatalogDraftPayloadV3, CatalogDraftPublicationStoredRecord } from "./contracts/draftV3.js";
import { catalogPublicationDraftPayloadSchema } from "./draftV3Schemas.js";
import { catalogDraftSummarySchema } from "./draftSchemas.js";
import { catalogDraftProductV2Schema, catalogDraftSkuV2Schema } from "./draftV2Schemas.js";

const state = z.enum(["draft", "active", "withdrawn", "archived"]);
const destination = z.enum(["active", "withdrawn", "archived"]);
const code = z.string().min(1).max(160).regex(/^[A-Za-z0-9._:-]+$/u);
const slug = z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9_-]*$/u);
const lifecycleOperation = z.discriminatedUnion("op", [
  z.object({ op: z.literal("set_product_lifecycle"), productSlug: slug, expectedState: state, state: destination,
    children: z.array(z.object({ skuCode: code, expectedState: state }).strict()).max(50_000)
      .refine(rows => rows.every((row, index) => index === 0 || rows[index - 1]!.skuCode < row.skuCode)) }).strict(),
  z.object({ op: z.literal("restore_product"), productSlug: slug, expectedState: z.literal("withdrawn") }).strict(),
  z.object({ op: z.literal("set_sku_lifecycle"), skuCode: code, expectedState: state, state: destination }).strict(),
  z.object({ op: z.literal("restore_sku"), skuCode: code, expectedState: z.literal("withdrawn") }).strict(),
]);
export type PublicationLifecycleState = z.infer<typeof state>;
export type PublicationLifecycleOperation = z.infer<typeof lifecycleOperation>;
type LegacyOperation = CatalogDraftPayloadV3["publication"]["operations"][number];
export type PublicationOperation = LegacyOperation | PublicationLifecycleOperation;
type IntentSku = CatalogDraftPayloadV3["skus"][number] & { demandPolicyRef?: string | undefined };
export type PublicationIntent = Omit<CatalogDraftPayloadV3, "schemaVersion" | "publication" | "skus"> & {
  schemaVersion: 3 | 4;
  skus: IntentSku[];
  publication: Omit<CatalogDraftPayloadV3["publication"], "operations"> & { operations: PublicationOperation[] };
};
export type PublicationDraftRecord = Omit<CatalogDraftPublicationStoredRecord, "payload"> & {
  payload: CatalogDraftPublicationStoredRecord["payload"] | (PublicationIntent & { schemaVersion: 4 });
};

const v4Wire = z.object({ schemaVersion: z.literal(4),
  product: catalogDraftProductV2Schema.extend({ sharedContent: z.unknown() }).strict(),
  skus: z.array(catalogDraftSkuV2Schema.extend({
    demandPolicyRef: z.string().min(1).max(240).refine(value => value.trim() === value).optional(),
  })).max(10_000),
  publication: z.object({ kind: z.enum(["release", "compensation"]), operations: z.array(z.unknown()), evidence: z.unknown() }).strict(),
}).strict();
const summary = catalogDraftSummarySchema.extend({ payload: z.unknown() }).strict();

export function isLifecycleOperation(operation: PublicationOperation): operation is PublicationLifecycleOperation {
  return operation.op === "set_product_lifecycle" || operation.op === "restore_product"
    || operation.op === "set_sku_lifecycle" || operation.op === "restore_sku";
}

/** Preserve the original wire for identity. Lower both inputs once into a single ordered intent. */
export function publicationIntent(input: unknown): PublicationIntent | null {
  const v3 = catalogPublicationDraftPayloadSchema.safeParse(input);
  if (v3.success) return v3.data;
  const wire = v4Wire.safeParse(input);
  if (!wire.success) return null;
  const { publication, skus } = wire.data;
  const lifecycle = publication.operations.map(operation => lifecycleOperation.safeParse(operation));
  const common = catalogPublicationDraftPayloadSchema.safeParse({ ...wire.data, schemaVersion: 3,
    skus: skus.map(({ demandPolicyRef: _policy, ...sku }) => sku),
    publication: { ...publication, operations: publication.operations.filter((_operation, index) => !lifecycle[index]!.success) },
  });
  if (!common.success || common.data.publication.operations.some(op => op.op === "set_product_status" || op.op === "set_sku_status"))
    return null;
  let index = 0;
  const operations = lifecycle.map(op => op.success ? op.data : common.data.publication.operations[index++]!);
  if (operations.some(op => (op.op === "restore_sku" || op.op === "set_sku_lifecycle" && op.state === "active")
    && !operations.some(other => other.op === "set_eligibility" && other.skuCode === op.skuCode
      && (other.sellableStandalone || other.sellableInSubscription)))) return null;
  try { canonicalCatalogDraftJson(input); } catch { return null; }
  return { ...common.data, schemaVersion: 4, skus, publication: { ...common.data.publication, operations } };
}

/** Read only the revision identity. The interpreter owns payload admission. */
export function readPublicationDraftEnvelope(input: unknown): PublicationDraftRecord | null {
  const row = summary.safeParse(input);
  if (!row.success) return null;
  return row.data as PublicationDraftRecord;
}

export function readPublicationDraftRecord(input: unknown): PublicationDraftRecord | null {
  const row = readPublicationDraftEnvelope(input);
  if (!row) return null;
  const payload = publicationIntent(row.payload);
  return payload?.product.id === row.productId ? row : null;
}

export function lifecycleTransition(from: PublicationLifecycleState, to: PublicationLifecycleState, restore: boolean): boolean {
  if (restore) return from === "withdrawn" && to === "active";
  return from === "draft" && (to === "active" || to === "archived")
    || from === "active" && (to === "active" || to === "withdrawn")
    || from === "withdrawn" && to === "archived";
}
