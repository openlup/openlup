import { createHash } from "node:crypto";
import { z } from "zod";
import { catalogDocumentRevisionRefSchema, catalogProductTypeRefSchema, catalogQuantitySchema,
  catalogOptionValueSchema, catalogDimensionKeySchema, catalogNamespacedKeySchema } from "@openlup/platform/catalog";
import { isValidGtin, type CatalogHeadRef, type CatalogPublicationReceipt, type CatalogQuantity, type CatalogProductTypeRef,
  type CatalogOptionValue, type CatalogAttributeValue, type CatalogPublicationFacts, type CatalogDraftSharedContentV3,
  type CatalogDraftClaimV3, type CatalogDocumentRevisionRef } from "@openlup/platform/catalog/contracts";

/** @experimental */
export const CATALOG_PUBLICATION_LIMITS = { skuBytes: 2_097_152, manifestBytes: 16_777_216,
  receiptBytes: 8_388_608, historyBytes: 16_777_216, pageBytes: 8_388_608, pageItems: 100 } as const;
/** @experimental */
export interface CatalogPublishedIdentifier {
  scheme: string; issuer: string; value: string; packagingLevel: "unit" | "case"; quantity: number;
  isPrimary: boolean; label: string | null; sourceRef: string | null;
}
/** @experimental */
export interface CatalogPublishedProduct {
  id: string; slug: string; name: string; status: "draft" | "active" | "archived";
  type: CatalogProductTypeRef; axes: string[]; attributes: Record<string, CatalogAttributeValue>;
  primarySkuId: string | null; document: CatalogDocumentRevisionRef | null;
  presentation: CatalogPublishedPresentation | null; source: CatalogDraftClaimV3;
  content: Omit<CatalogDraftSharedContentV3, "document" | "presentation"> & { presentation: CatalogPublishedPresentation };
}
/** @experimental */
export interface CatalogPublishedSku {
  id: string; productId: string; code: string; title: string; status: "draft" | "active" | "archived";
  minQuantity: number; isAddon: boolean; sellableStandalone: boolean; sellableInSubscription: boolean;
  netContent: CatalogQuantity; grossMass: CatalogQuantity | null; options: Record<string, CatalogOptionValue>;
  attributes: Record<string, CatalogAttributeValue>; facts: CatalogPublicationFacts;
  identifiers: CatalogPublishedIdentifier[]; assetRefs: string[]; logisticsRef: string | null;
  memberships: { offerVersion: string; admitted: boolean }[]; source: CatalogDraftClaimV3;
}
/** @experimental */
export interface CatalogSkuRevisionRef { skuId: string; revisionId: string; revision: number; digest: string }
/** @experimental */
export interface CatalogPublicationManifestV2 { schemaVersion: 2; product: CatalogPublishedProduct; skus: CatalogSkuRevisionRef[] }
/** @experimental */
export interface CatalogFullPublicationV2 { outcome: "page"; schemaVersion: 2; head: CatalogHeadRef; product: CatalogPublishedProduct;
  items: { reference: CatalogSkuRevisionRef; facts: CatalogPublishedSku }[]; nextCursor: string | null }
/** @experimental */
export interface CatalogPublicationReceiptV2 extends CatalogPublicationReceipt {
  schemaVersion: 2; productId: string; publicationDigest: string; committedAt: string;
}
/** @experimental */
export interface CatalogRetainedSourceBinding {
  kind: "account" | "order" | "fulfilment"; sourceId: string; lineId: string;
  productId: string; skuId: string; skuRevisionId: string; publicationId: string; documentRevisionId: string;
}
/** @experimental */
export interface CatalogPublicationFailure {
  outcome: "unauthorized" | "validation_issue" | "conflict" | "dependency_unavailable" | "unsupported";
  reason: string;
  message?: string;
}

export function canonicalCatalogPublicationJson(input: unknown): string {
  const ancestors = new Set<object>();
  function visit(value: unknown, depth: number): unknown {
    if (depth > 48) throw new Error("draft_json_depth");
    if (typeof value === "string") {
      if (value.includes("\u0000") || /[\uD800-\uDFFF]/u.test(value)) throw new Error("draft_json_invalid");
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
  if (new TextEncoder().encode(text).byteLength > CATALOG_PUBLICATION_LIMITS.manifestBytes) throw new Error("draft_payload_too_large");
  return text;
}

/** @experimental */
export class CatalogPublicationError extends Error {
  constructor(readonly code: string, readonly outcome: "unauthorized" | "validation_issue" | "conflict" | "dependency_unavailable" | "unsupported" = "validation_issue") {
    super(code); this.name = "CatalogPublicationError";
  }
}
export const publicationRefuse = (code: string, outcome?: CatalogPublicationError["outcome"]): never => { throw new CatalogPublicationError(code, outcome); };
export const publicationJson = (input: unknown, maxBytes: number = CATALOG_PUBLICATION_LIMITS.manifestBytes): string => {
  const text = canonicalCatalogPublicationJson(input);
  if (Buffer.byteLength(text) > maxBytes) publicationRefuse("catalog_publication_envelope_too_large");
  return text;
};
export const publicationDigest = (input: unknown, maxBytes: number = CATALOG_PUBLICATION_LIMITS.manifestBytes): string => createHash("sha256").update(publicationJson(input, maxBytes)).digest("hex");
/** PostgreSQL C collation orders UTF-8 bytes, including supplementary code points.
 * @experimental
 */
export const comparePublicationText = (left: string, right: string): number => Buffer.compare(Buffer.from(left), Buffer.from(right));
const id = z.guid().refine(value => value === value.toLowerCase());
const revision = z.number().int().min(1).max(2_147_483_647);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const code = z.string().min(1).max(160).regex(/^[A-Za-z0-9._:-]+$/u);
// Match the publication wire's UTF-16 limit even when Zod counts Unicode code points.
const text = (max: number, min = 1) => z.string().min(min).refine(value => value.length <= max);
const ref = text(240).refine(value => value.trim() === value);
const facts = z.record(z.string(), z.json());
const locale = z.string().min(2).max(35).regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u);
const localized = z.record(locale, text(500));
const presentation = z.object({
  title: text(500).optional(),
  routePath: z.record(locale, text(500).refine(value => value.startsWith("/"))).optional(),
  shortName: localized.optional(),
  advertisedWeightsG: z.array(z.number().int().positive()).max(500).optional(),
  mediaRef: ref.optional(),
  accent: z.string().regex(/^#[0-9a-fA-F]{6}$/u).optional(),
}).strict();
type CatalogPublishedPresentation = z.infer<typeof presentation>;
const scalarFacts = z.record(code, z.union([z.boolean(), z.number(), text(2048, 0), z.null()]));

const attribute = z.union([z.string(), z.boolean(), catalogQuantitySchema,
  z.object({ namespace: catalogNamespacedKeySchema, id: z.string().min(1).max(120) }).strict(), z.record(z.string(), z.string())]);
const attributes = z.record(z.string(), z.union([attribute, z.array(attribute)]));
const claimSchema = z.object({ draftId: id, revision, commandKey: ref, fingerprint: digest }).strict();
const identifierSchema = z.object({ scheme: ref, issuer: ref, value: text(128), packagingLevel: z.enum(["unit", "case"]),
  quantity: z.number().int().min(1).max(999_999), isPrimary: z.boolean(), label: text(500).refine(value => value.trim() === value).nullable(), sourceRef: ref.nullable() }).strict()
  .refine(value => value.packagingLevel === "unit" ? value.quantity === 1 : value.quantity >= 2)
  .refine(value => !value.isPrimary || value.scheme === "gs1:gtin" && value.packagingLevel === "unit")
  .refine(value => value.scheme !== "gs1:gtin" || isValidGtin(value.value));
export const catalogPublishedSkuSchema: z.ZodType<CatalogPublishedSku> = z.object({
  id, productId: id, code, title: text(500), status: z.enum(["draft", "active", "archived"]),
  minQuantity: z.number().int().min(1).max(2_147_483_647), isAddon: z.boolean(), sellableStandalone: z.boolean(), sellableInSubscription: z.boolean(),
  netContent: catalogQuantitySchema, grossMass: catalogQuantitySchema.nullable(), options: z.record(catalogDimensionKeySchema, catalogOptionValueSchema.refine(value =>
    value.kind !== "choice" || value.value.length <= 120)),
  attributes, facts, identifiers: z.array(identifierSchema), assetRefs: z.array(ref).max(32),
  logisticsRef: text(500).refine(value => value.trim() === value).nullable(),
  memberships: z.array(z.object({ offerVersion: ref, admitted: z.boolean() }).strict()), source: claimSchema,
}).strict().superRefine((sku, context) => {
  if (!sku.memberships.every((row, index) => index === 0 || comparePublicationText(sku.memberships[index - 1]!.offerVersion, row.offerVersion) < 0)
    || sku.identifiers.filter(row => row.isPrimary).length > 1)
    context.addIssue({ code: "custom", message: "membership roster and primary identifier must be unique" });
}) as z.ZodType<CatalogPublishedSku>;
const catalogPublishedContentSchema = z.object({
  schemaVersion: z.literal(1), catalogAction: z.enum(["create", "revise"]), presentation,
  offerMemberships: z.array(z.object({ skuCode: code, offerVersion: ref, admitted: z.boolean() }).strict()).max(10_000),
  requestedModes: z.array(z.object({ skuCode: code, modes: z.array(z.enum(["one_time", "subscription"])).max(2)
    .refine(modes => new Set(modes).size === modes.length) }).strict()).max(10_000),
  publicationSkus: z.array(z.object({ skuCode: code, title: text(500).refine(text => text.trim() === text),
    minQuantity: revision, isAddon: z.boolean(), facts: scalarFacts }).strict()).max(10_000),
}).strict().superRefine((content, context) => {
  for (const key of ["offerMemberships", "requestedModes", "publicationSkus"] as const) {
    const codes = content[key].map(row => row.skuCode);
    if (new Set(codes).size !== codes.length) context.addIssue({ code: "custom", path: [key], message: "SKU intents must be unique" });
  }
});

export const catalogPublishedProductSchema: z.ZodType<CatalogPublishedProduct> = z.object({
  id, slug: z.string().min(1), name: text(500), status: z.enum(["draft", "active", "archived"]),
  type: catalogProductTypeRefSchema, axes: z.array(catalogDimensionKeySchema).max(16).refine(values => new Set(values).size === values.length), attributes, primarySkuId: id.nullable(),
  document: catalogDocumentRevisionRefSchema.extend({ schemaId: ref, documentRef: ref, sourceRef: ref }).nullable(), presentation: presentation.nullable(), source: claimSchema,
  content: catalogPublishedContentSchema,
}).strict() as z.ZodType<CatalogPublishedProduct>;
export const catalogPublicationManifestSchema: z.ZodType<CatalogPublicationManifestV2> = z.object({
  schemaVersion: z.literal(2), product: catalogPublishedProductSchema,
  skus: z.array(z.object({ skuId: id, revisionId: id, revision, digest }).strict()),
}).strict().superRefine((manifest, context) => {
  if (!manifest.skus.every((sku, index) => index === 0 || manifest.skus[index - 1]!.skuId < sku.skuId)
    || !manifest.skus.some(sku => sku.skuId === manifest.product.primarySkuId))
    context.addIssue({ code: "custom", message: "manifest roster must be sorted, unique and contain its primary" });
});
