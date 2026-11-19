import { createHash } from "node:crypto";
import { z } from "./validation.js";
import { canonicalCatalogPublicationJson } from "./contracts/draft.js";
import { catalogPublicationContentSchema } from "./draftV3Schemas.js";
import { catalogDraftSkuV2Schema } from "./draftV2Schemas.js";
import { isValidGtin, catalogDocumentRevisionRefSchema } from "./foundationSchemas.js";
import { catalogProductTypeRefSchema, catalogQuantitySchema, catalogOptionValueSchema, catalogDimensionKeySchema } from "./productTypeSchemas.js";
import type { CatalogPublishedContent, CatalogPublishedProduct, CatalogPublishedSku, CatalogPublicationManifestV2 } from "./contracts/publication.js";
import type { CatalogDraftSharedContentV3 } from "./contracts/draftV3.js";
import { CATALOG_PUBLICATION_LIMITS } from "./contracts/publication.js";
import { CatalogPublicationError, publicationIssue, publicationRefuse } from "./publicationError.js";

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
const ref = z.string().min(1).max(240).refine(value => value.trim() === value);
/** @experimental */
export const publicationReadinessReasons = z.array(z.string().regex(/^[a-z][a-z0-9_]{0,159}$/u)).max(100)
  .refine(reasons => new Set(reasons).size === reasons.length);
/** @experimental */
export const publicationReadinessVerdict = z.object({ ready: z.boolean(), reasons: publicationReadinessReasons }).strict()
  .refine(({ ready, reasons }) => ready === (reasons.length === 0));
const locale = z.string().min(2).max(35).regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u);
const localized = z.record(locale, z.string().min(1).max(500));
const presentationSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  routePath: z.record(locale, z.string().min(1).max(500).startsWith("/")).optional(),
  shortName: localized.optional(),
  advertisedWeightsG: z.array(z.number().int().min(1).max(9_999_999)).max(500)
    .refine(values => values.every((value, index) => index === 0 || values[index - 1]! < value)).optional(),
  mediaRef: ref.optional(),
  accent: z.string().regex(/^#[0-9a-fA-F]{6}$/u).optional(),
}).strict();
export const publishedFactsSchema = z.record(code, z.union([z.boolean(), z.number(), z.string().max(2048), z.null()]));
const contentSchema = catalogPublicationContentSchema.superRefine((content, context) => {
  if (!presentationSchema.safeParse(content.presentation).success)
    context.addIssue({ code: "custom", path: ["presentation"], message: "Use the supported presentation fields" });
  content.publicationSkus.forEach((sku, index) => {
    if (!publishedFactsSchema.safeParse(sku.facts).success)
      context.addIssue({ code: "custom", path: ["publicationSkus", index, "facts"], message: "Use scalar facts" });
  });
});
export function assertPublishedPresentation(input: unknown, path: string, subject?: string): void {
  const parsed = presentationSchema.nullable().safeParse(input);
  if (parsed.success) return;
  const code = "catalog_publication_presentation_invalid";
  const issue = parsed.error.issues[0]!;
  const keys = issue.code === "unrecognized_keys" ? issue.keys.slice(0, 1) : [];
  throw new CatalogPublicationError(code, "validation_issue",
    publicationIssue(code, "structural", [path, ...issue.path, ...keys].join("."), subject));
}
export function assertPublishedFacts(input: unknown, path: string, subject?: string): void {
  const parsed = publishedFactsSchema.safeParse(input);
  if (parsed.success) return;
  const code = "catalog_publication_facts_invalid";
  throw new CatalogPublicationError(code, "validation_issue",
    publicationIssue(code, "structural", [path, ...parsed.error.issues[0]!.path].join("."), subject));
}
const attributes = catalogDraftSkuV2Schema.shape.attributes.unwrap();
const claimSchema = z.object({ draftId: id, revision, commandKey: ref, fingerprint: digest }).strict();
const identifierSchema = z.object({ scheme: ref, issuer: ref, value: z.string().min(1).max(128), packagingLevel: z.enum(["unit", "case"]),
  quantity: z.number().int().min(1).max(999_999), isPrimary: z.boolean(), label: z.string().min(1).max(500).refine(value => value.trim() === value).nullable(), sourceRef: ref.nullable() }).strict()
  .refine(value => value.packagingLevel === "unit" ? value.quantity === 1 : value.quantity >= 2)
  .refine(value => !value.isPrimary || value.scheme === "gs1:gtin" && value.packagingLevel === "unit")
  .refine(value => value.scheme !== "gs1:gtin" || isValidGtin(value.value));
export const catalogPublishedSkuSchema: z.ZodType<CatalogPublishedSku> = z.object({
  id, productId: id, code, title: z.string().min(1).max(500), status: z.enum(["draft", "active", "archived"]),
  minQuantity: z.number().int().min(1).max(2_147_483_647), isAddon: z.boolean(), sellableStandalone: z.boolean(), sellableInSubscription: z.boolean(),
  netContent: catalogQuantitySchema, grossMass: catalogQuantitySchema.nullable(), options: z.record(catalogDimensionKeySchema, catalogOptionValueSchema),
  attributes, facts: publishedFactsSchema, identifiers: z.array(identifierSchema), assetRefs: z.array(ref).max(32),
  logisticsRef: z.string().min(1).max(500).refine(value => value.trim() === value).nullable(),
  memberships: z.array(z.object({ offerVersion: ref, admitted: z.boolean() }).strict()), source: claimSchema,
}).strict().superRefine((sku, context) => {
  if (!sku.memberships.every((row, index) => index === 0 || comparePublicationText(sku.memberships[index - 1]!.offerVersion, row.offerVersion) < 0)
    || sku.identifiers.filter(row => row.isPrimary).length > 1)
    context.addIssue({ code: "custom", message: "membership roster and primary identifier must be unique" });
}) as z.ZodType<CatalogPublishedSku>;
const copiedDocument = "catalog_publication_document_text_copied";
function copiedDocumentPath(value: unknown, digests: ReadonlySet<string>): string[] | undefined {
  if (!digests.size || value === undefined) return undefined;
  if (typeof value === "string" && digests.has(createHash("sha256").update(value, "utf8").digest("hex"))) return [];
  try {
    if (digests.has(publicationDigest(value))) return [];
  } catch {
    // A value outside the canonical JSON envelope cannot match a canonical document.
  }
  if (value && typeof value === "object") for (const [key, child] of Object.entries(value)) {
    const found = copiedDocumentPath(child, digests);
    if (found) return [key, ...found];
  }
}
export const catalogPublishedProductSchema: z.ZodType<CatalogPublishedProduct> = z.object({
  id, slug: z.string().min(1), name: z.string().min(1).max(500), status: z.enum(["draft", "active", "archived"]),
  type: catalogProductTypeRefSchema, axes: z.array(catalogDimensionKeySchema).max(16).refine(values => new Set(values).size === values.length), attributes, primarySkuId: id.nullable(),
  document: catalogDocumentRevisionRefSchema.nullable(), presentation: presentationSchema.nullable(), source: claimSchema,
  content: contentSchema,
}).strict();
export function decodePublishedProduct(product: CatalogPublishedProduct, documentDigests: ReadonlySet<string>): CatalogPublishedProduct {
  const parsed = catalogPublishedProductSchema.safeParse(product);
  if (!parsed.success) return publicationRefuse("catalog_publication_manifest_invalid");
  assertDocumentExclusion(parsed.data, documentDigests, "product", product.type.key);
  return parsed.data;
}

export function assertPublishedSkuDocumentExclusion(sku: CatalogPublishedSku, documentDigests: ReadonlySet<string>): void {
  assertDocumentExclusion(sku, documentDigests, "skus", sku.code);
}

function assertDocumentExclusion(value: unknown, digests: ReadonlySet<string>, field: string, subject: string): void {
  const path = copiedDocumentPath(value, digests);
  if (path) throw new CatalogPublicationError(copiedDocument, "validation_issue",
    publicationIssue(copiedDocument, "structural", [field, ...path].join("."), subject));
}
/** Refuses exact copies of canonical values or raw text using the selected and caller-supplied revision digests. */
export function catalogPublicationManifestSchema(documentDigests: ReadonlySet<string> = new Set()): z.ZodType<CatalogPublicationManifestV2> {
  return z.object({
    schemaVersion: z.literal(2), product: catalogPublishedProductSchema,
    skus: z.array(z.object({ skuId: id, revisionId: id, revision, digest }).strict()),
  }).strict().superRefine((manifest, context) => {
    const selected = manifest.product.document?.digest;
    const path = copiedDocumentPath(manifest.product, selected ? new Set([...documentDigests, selected]) : documentDigests);
    if (path) context.addIssue({ code: "custom", path: ["product", ...path], message: copiedDocument });
    if (!manifest.skus.every((sku, index) => index === 0 || manifest.skus[index - 1]!.skuId < sku.skuId)
      || !manifest.skus.some(sku => sku.skuId === manifest.product.primarySkuId))
      context.addIssue({ code: "custom", message: "manifest roster must be sorted, unique and contain its primary" });
  });
}
// Name every neutral field so that new draft carriers cannot become published facts.
export function publicationContent(content: CatalogDraftSharedContentV3, subject?: string): CatalogPublishedContent {
  const { schemaVersion, catalogAction, presentation, offerMemberships, requestedModes, publicationSkus } = content;
  assertPublishedPresentation(presentation, "product.sharedContent.presentation", subject);
  for (const [index, sku] of publicationSkus.entries())
    assertPublishedFacts(sku.facts, `product.sharedContent.publicationSkus.${index}.facts`, subject);
  return { schemaVersion, catalogAction, presentation, offerMemberships, requestedModes, publicationSkus };
}
