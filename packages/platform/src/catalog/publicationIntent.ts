import { z } from "./validation.js";
import { canonicalCatalogDraftJson } from "./contracts/draft.js";
import type { CatalogDraftPayloadV3, CatalogDraftPublicationStoredRecord } from "./contracts/draftV3.js";
import { catalogDraftPayloadV3Schema, catalogPublicationDraftPayloadSchema } from "./draftV3Schemas.js";
import { catalogDraftSummarySchema } from "./draftSchemas.js";
import { readDraftBasisPrices, type DraftBasisPriceContext } from "./draftBasisPrice.js";
import type { CatalogDraftBasisPriceOperationV2, CatalogDraftPriceOperationV2 } from "./contracts/draftV2.js";
import { catalogDraftProductV2Schema, catalogDraftSkuV2Schema } from "./draftV2Schemas.js";

const state = z.enum(["draft", "active", "withdrawn", "archived"]);
export const lifecycleEvidenceSchema = z.object({ product: state,
  skus: z.record(z.string(), z.object({ state }).strict()) }).strict();
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
export type PublicationIntent = Omit<CatalogDraftPayloadV3, "schemaVersion" | "publication"> & {
  schemaVersion: 3 | 4;
  publication: Omit<CatalogDraftPayloadV3["publication"], "operations"> & { operations: PublicationOperation[];
    evidence: CatalogDraftPayloadV3["publication"]["evidence"] & { priceContext?: DraftBasisPriceContext } };
};
/** @experimental */
export type CatalogDraftPayloadV4 = Omit<PublicationIntent, "skus"> & { schemaVersion: 4;
  skus: (Omit<PublicationIntent["skus"][number], "priceOperations"> & {
    priceOperations?: (CatalogDraftPriceOperationV2 | CatalogDraftBasisPriceOperationV2)[] | undefined;
  })[] };
/** @experimental */
export type PublicationDraftRecord = Omit<CatalogDraftPublicationStoredRecord, "payload"> & {
  payload: CatalogDraftPublicationStoredRecord["payload"] | CatalogDraftPayloadV4;
};

export function lifecycleWithdrawalOnly(payload: PublicationIntent): boolean {
  const { operations } = payload.publication;
  return operations.length > 0 && operations.every(operation =>
    (operation.op === "set_product_lifecycle" || operation.op === "set_sku_lifecycle") && operation.state === "withdrawn"
    || operation.op === "set_eligibility" && !operation.sellableStandalone && !operation.sellableInSubscription)
    && !payload.publication.evidence.priceContext && !payload.skus.some(sku => sku.priceOperations?.length);
}

const v4Wire = z.object({ schemaVersion: z.literal(4),
  product: catalogDraftProductV2Schema.extend({ sharedContent: z.unknown() }).strict(),
  skus: z.array(catalogDraftSkuV2Schema.extend({ priceOperations: z.array(z.unknown()).optional() })).max(10_000),
  publication: z.object({ kind: z.enum(["release", "compensation"]), operations: z.array(z.unknown()), evidence: z.unknown() }).strict(),
}).strict();
export function draftBasisPriceIssue(input: unknown) {
  const draft = v4Wire.safeParse(input);
  return draft.success ? readDraftBasisPrices(draft.data.skus, draft.data.publication.evidence).issue : undefined;
}
const summary = catalogDraftSummarySchema.extend({ payload: z.unknown() }).strict();

export function isLifecycleOperation(operation: PublicationOperation): operation is PublicationLifecycleOperation {
  return operation.op === "set_product_lifecycle" || operation.op === "restore_product"
    || operation.op === "set_sku_lifecycle" || operation.op === "restore_sku";
}

/** Preserve the original wire for identity. Lower both inputs once into a single ordered intent. */
export function publicationIntent(input: unknown, onInvalid?: (path: string, unsupportedKey: boolean, fix?: string) => never, stored = false): PublicationIntent | null {
  function invalid(issue: z.core.$ZodIssue, indexes?: readonly number[]) {
    const path = [...issue.path];
    if (indexes && path[0] === "publication" && path[1] === "operations" && typeof path[2] === "number")
      path[2] = indexes[path[2]] ?? path[2];
    if (issue.code === "unrecognized_keys") path.push(issue.keys[0]!);
    const fix = issue.code === "custom" && path.length > 0 ? issue.message : undefined;
    return onInvalid?.(path.join(".") || "payload", issue.code === "unrecognized_keys", fix) ?? null;
  }
  if (!input || typeof input !== "object" || !("schemaVersion" in input) || input.schemaVersion !== 4) {
    const v3 = catalogPublicationDraftPayloadSchema.safeParse(input);
    return v3.success ? v3.data : invalid(v3.error.issues[0]!);
  }
  const wire = v4Wire.safeParse(input);
  if (!wire.success) return invalid(wire.error.issues[0]!);
  const { publication, skus } = wire.data;
  const basis = readDraftBasisPrices(skus, publication.evidence);
  if (basis.issue) return onInvalid?.(basis.issue.path, false, basis.issue.message) ?? null;
  const evidence = basis.context ? Object.fromEntries(Object.entries(publication.evidence as object).filter(([key]) => key !== "priceContext"))
    : publication.evidence;
  const lifecycle = publication.operations.map(operation => lifecycleOperation.safeParse(operation));
  const commonIndexes = lifecycle.flatMap((op, index) => op.success ? [] : [index]);
  const common = (stored ? catalogDraftPayloadV3Schema : catalogPublicationDraftPayloadSchema).safeParse({ ...wire.data, schemaVersion: 3,
    skus: basis.v2 ? skus.map(sku => sku.priceOperations === undefined ? sku
      : { ...sku, priceOperations: sku.priceOperations.filter(operation => !basis.v2!.has(operation)) }) : skus,
    publication: { ...publication, evidence, operations: publication.operations.filter((_operation, index) => !lifecycle[index]!.success) },
  });
  if (!common.success) {
    const issue = common.error.issues[0]!;
    const index = issue.path[0] === "publication" && issue.path[1] === "operations" && typeof issue.path[2] === "number"
      ? commonIndexes[issue.path[2]] : undefined;
    if (index !== undefined) {
      const result = lifecycle[index]!;
      // A recognized lifecycle operation can name the malformed field directly.
      const lifecycleIssue = !result.success && result.error.issues[0];
      if (lifecycleIssue && !(lifecycleIssue.code === "invalid_union" && lifecycleIssue.path[0] === "op"))
        return invalid({ ...lifecycleIssue, path: ["publication", "operations", index, ...lifecycleIssue.path] });
    }
    return invalid(issue, commonIndexes);
  }
  const status = common.data.publication.operations.findIndex(op => op.op === "set_product_status" || op.op === "set_sku_status");
  if (status >= 0) return onInvalid?.(`publication.operations.${commonIndexes[status]}.op`, false) ?? null;
  let index = 0;
  const operations = lifecycle.map(op => op.success ? op.data : common.data.publication.operations[index++]!);
  const missingEligibility = operations.findIndex(op => (op.op === "restore_sku" || op.op === "set_sku_lifecycle" && op.state === "active")
    && !operations.some(other => other.op === "set_eligibility" && other.skuCode === op.skuCode
      && (other.sellableStandalone || other.sellableInSubscription)));
  if (missingEligibility >= 0) return onInvalid?.(`publication.operations.${missingEligibility}`, false) ?? null;
  try { canonicalCatalogDraftJson(input); } catch { return null; }
  return { ...common.data, schemaVersion: 4, publication: { ...common.data.publication, operations,
    evidence: basis.context ? { ...common.data.publication.evidence, priceContext: basis.context } : common.data.publication.evidence } };
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
  const payload = row.payload?.schemaVersion === 4 ? readStoredLifecycleDraftPayload(row.payload) : publicationIntent(row.payload);
  return payload?.product.id === row.productId ? row : null;
}

/** Validate the storage dialect without returning the lowered interpreter view. */
export function readStoredLifecycleDraftPayload(input: unknown): CatalogDraftPayloadV4 | null {
  return publicationIntent(input, undefined, true)?.schemaVersion === 4 ? input as CatalogDraftPayloadV4 : null;
}

export function lifecycleTransition(from: PublicationLifecycleState, to: PublicationLifecycleState, restore: boolean): boolean {
  if (restore) return from === "withdrawn" && to === "active";
  return from === "draft" && (to === "active" || to === "archived")
    || from === "active" && (to === "active" || to === "withdrawn")
    || from === "withdrawn" && to === "archived";
}
