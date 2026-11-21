import type { CatalogPublicationReceipt } from "./contracts/lifecycle.js";
import { createHash } from "node:crypto";
import { CATALOG_DRAFT_MAX_BYTES } from "./contracts/draft.js";
import { z } from "./validation.js";
import { catalogPublicationContentSchema } from "./draftV3Schemas.js";
import { catalogDraftSkuV2Schema } from "./draftV2Schemas.js";
import { isValidGtin, catalogDocumentRevisionRefSchema } from "./foundationSchemas.js";
import { catalogProductTypeRefSchema, catalogQuantitySchema, catalogOptionValueSchema, catalogDimensionKeySchema } from "./productTypeSchemas.js";
import type { CatalogPublishedContent, CatalogPublishedProduct, CatalogPublishedSku, CatalogPublicationManifestV2, CatalogPublicationReceiptV2, CatalogPublicationReceiptV3, CatalogPublicationManifestV3 } from "./publicationContracts.js";
import type { CatalogDraftSharedContentV3 } from "./contracts/draftV3.js";
import { CATALOG_PUBLICATION_LIMITS } from "./publicationContracts.js";
import { catalogPublicationAdmissionRefusal, CatalogPublicationError, publicationIssue, publicationReadFailure, publicationRefuse, publicationRemedy, type Issue, type PlatformCode, type PlatformIssue } from "./publicationError.js";
import { assertPublishedSkuIdentity } from "./publicationSkuIdentity.js";

const PUBLICATION_MAX_DEPTH = 48;
export const SKU_PAGE_DEPTH = 3;

class CanonicalFieldError extends Error {
  constructor(readonly path: string, message: string) { super(message); }
}

export function canonicalCatalogPublicationJson(input: unknown, depth = 0): string {
  const ancestors = new Set<object>();
  function visit(value: unknown, level: number, path: string): unknown {
    if (level > PUBLICATION_MAX_DEPTH) throw new CanonicalFieldError(path, "draft_json_depth");
    if (typeof value === "string") {
      if (value.includes("\u0000") || /[\uD800-\uDFFF]/u.test(value)) throw new CanonicalFieldError(path, "draft_json_invalid");
      return value;
    }
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0)) return value;
    if (typeof value !== "object" || ancestors.has(value)) throw new CanonicalFieldError(path, "draft_json_invalid");
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new CanonicalFieldError(path, "draft_json_invalid");
    ancestors.add(value);
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string" || ["__proto__", "constructor", "prototype"].includes(key))) throw new CanonicalFieldError(path, "draft_json_invalid");
    for (const key of keys) {
      visit(key, level, path);
      if (Object.getOwnPropertyDescriptor(value, key)?.get || Object.getOwnPropertyDescriptor(value, key)?.set) throw new CanonicalFieldError(path, "draft_json_invalid");
    }
    let result: unknown;
    if (Array.isArray(value)) {
      if (keys.length !== value.length + 1 || !Object.keys(value).every((key, index) => key === String(index))) throw new CanonicalFieldError(path, "draft_json_invalid");
      result = Array.from(value, (item, index) => visit(item, level + 1, path ? `${path}.${index}` : String(index)));
    } else {
      result = Object.fromEntries((keys as string[]).sort().map((key) => [key, visit((value as Record<string, unknown>)[key], level + 1, path ? `${path}.${key}` : key)]));
    }
    ancestors.delete(value);
    return result;
  }
  return JSON.stringify(visit(input, depth, ""));
}

export const publicationJson = (input: unknown, maxBytes: number = CATALOG_PUBLICATION_LIMITS.manifestBytes, depth = 0): string => {
  const text = canonicalCatalogPublicationJson(input, depth);
  if (Buffer.byteLength(text) > maxBytes) publicationRefuse("catalog_publication_envelope_too_large");
  return text;
};
export const publicationDigest = (input: unknown, maxBytes: number = CATALOG_PUBLICATION_LIMITS.manifestBytes, depth = 0): string => createHash("sha256").update(publicationJson(input, maxBytes, depth)).digest("hex");

export function publicationApprovalState(product: CatalogPublishedProduct, skus: readonly CatalogPublishedSku[]) {
  assertNativeProductReferences(product);
  if (skus.length > 10_000) publicationRefuse("catalog_publication_roster_limit");
  if (!skus.some(sku => sku.id === product.primarySkuId)) publicationRefuse("catalog_publication_primary_sku_required");
  const state = { schemaVersion: product.schemaVersion ?? 2, product, skus: skus.map(sku => ({
    skuId: sku.id, digest: publicationDigest(sku, CATALOG_PUBLICATION_LIMITS.skuBytes, SKU_PAGE_DEPTH),
  })).sort((a, b) => a.skuId < b.skuId ? -1 : a.skuId > b.skuId ? 1 : 0) };
  return { canonicalText: publicationJson(state), digest: publicationDigest(state) };
}
/** PostgreSQL C collation orders UTF-8 bytes, including supplementary code points.
 * @experimental
 */
export const comparePublicationText = (left: string, right: string): number => Buffer.compare(Buffer.from(left), Buffer.from(right));
const id = z.string().regex(/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u);
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
export const publishedFactsSchema = z.record(z.string(), z.json());
type FieldPath = readonly PropertyKey[];
function fieldPath(parts: FieldPath): string {
  return parts.map(String).join(".");
}

function invalidAt(code: PlatformCode, path: string, subject?: string): never {
  throw new CatalogPublicationError(publicationIssue(code, "structural", path, subject));
}

function assertPublicationCarriers(value: unknown, path: string, subject?: string, allowDocumentReference = false, depth = 0): void {
  if (depth > PUBLICATION_MAX_DEPTH) invalidAt("catalog_publication_wire_invalid", path, subject);
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (allowDocumentReference && key === "document") continue;
    const next = fieldPath([path, key]);
    if (["document", "documentpayload", "canonicaltext"].includes(key.toLowerCase().replaceAll("_", "")))
      invalidAt("catalog_publication_reserved_carrier", next, subject);
    assertPublicationCarriers(child, next, subject, false, depth + 1);
  }
}

const contentSchema = catalogPublicationContentSchema.superRefine((content, context) => {
  if (!presentationSchema.safeParse(content.presentation).success)
    context.addIssue({ code: "custom", path: ["presentation"], message: "Use the supported presentation fields" });
});
export function assertPublishedPresentation(input: unknown, path: string, subject?: string): void {
  assertPublicationCarriers(input, path, subject);
  const parsed = presentationSchema.nullable().safeParse(input);
  if (parsed.success) return;
  const code = "catalog_publication_presentation_invalid";
  const issue = parsed.error.issues[0]!;
  const keys = issue.code === "unrecognized_keys" ? issue.keys.slice(0, 1) : [];
  throw new CatalogPublicationError(publicationIssue(code, "structural", [path, ...issue.path, ...keys].join("."), subject));
}
export function assertPublishedFacts(input: unknown, path: string, subject?: string): void {
  assertPublicationCarriers(input, path, subject);
  const parsed = publishedFactsSchema.safeParse(input);
  if (parsed.success) return;
  const code = "catalog_publication_facts_invalid";
  throw new CatalogPublicationError(publicationIssue(code, "structural", [path, ...parsed.error.issues[0]!.path].join("."), subject));
}
const attributes = catalogDraftSkuV2Schema.shape.attributes.unwrap();
const claimSchema = z.object({ draftId: id, revision, commandKey: ref, fingerprint: digest }).strict();
const identifierSchema = z.object({ scheme: ref, issuer: ref, value: z.string().min(1).max(128), packagingLevel: z.enum(["unit", "case"]),
  quantity: z.number().int().min(1).max(999_999), isPrimary: z.boolean(), label: z.string().min(1).max(500).refine(value => value.trim() === value).nullable(), sourceRef: ref.nullable() }).strict()
  .refine(value => value.packagingLevel === "unit" ? value.quantity === 1 : value.quantity >= 2)
  .refine(value => !value.isPrimary || value.scheme === "gs1:gtin" && value.packagingLevel === "unit")
  .refine(value => value.scheme !== "gs1:gtin" || isValidGtin(value.value));
const lifecycleState = z.enum(["draft", "active", "withdrawn", "archived"]);
const lifecycleProjection = (state: z.infer<typeof lifecycleState>) => state === "withdrawn" ? "active" : state;
const skuShape = z.object({
  id, productId: id, code, title: z.string().min(1).max(500), status: z.enum(["draft", "active", "archived"]),
  minQuantity: z.number().int().min(1).max(2_147_483_647), isAddon: z.boolean(), sellableStandalone: z.boolean(), sellableInSubscription: z.boolean(),
  netContent: catalogQuantitySchema, grossMass: catalogQuantitySchema.nullable(), options: z.record(catalogDimensionKeySchema, catalogOptionValueSchema),
  attributes, facts: publishedFactsSchema, identifiers: z.array(identifierSchema), assetRefs: z.array(ref).max(32),
  logisticsRef: z.string().min(1).max(500).refine(value => value.trim() === value).nullable(),
  memberships: z.array(z.object({ offerVersion: ref, admitted: z.boolean() }).strict()), source: claimSchema,
}).strict();
const governedSkuShape = skuShape.extend({
  schemaVersion: z.literal(3), lifecycleState, optionDigest: digest, demandPolicyRef: ref.optional(),
}).strict();
export const catalogPublishedSkuSchema: z.ZodType<CatalogPublishedSku> = z.discriminatedUnion("schemaVersion", [skuShape.extend({ schemaVersion: z.undefined().optional() }), governedSkuShape]).superRefine((sku, context) => {
  if ("lifecycleState" in sku && (sku.status !== lifecycleProjection(sku.lifecycleState)
    || sku.lifecycleState !== "active" && (sku.sellableStandalone || sku.sellableInSubscription)))
    context.addIssue({ code: "custom", path: ["lifecycleState"], message: "SKU flags and status must match their lifecycle" });
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
const productShape = z.object({
  id, slug: z.string().min(1), name: z.string().min(1).max(500), status: z.enum(["draft", "active", "archived"]),
  type: catalogProductTypeRefSchema, axes: z.array(catalogDimensionKeySchema).max(16).refine(values => new Set(values).size === values.length), attributes, primarySkuId: id.nullable(),
  document: catalogDocumentRevisionRefSchema.nullable(), presentation: presentationSchema.nullable(), source: claimSchema,
  content: contentSchema,
}).strict();
const governedProductShape = productShape.extend({
  schemaVersion: z.literal(3), lifecycleState, definitionDigest: digest,
}).strict().refine(product => product.status === lifecycleProjection(product.lifecycleState));
export const catalogPublishedProductSchema: z.ZodType<CatalogPublishedProduct> = z.discriminatedUnion("schemaVersion", [productShape.extend({ schemaVersion: z.undefined().optional() }), governedProductShape]);
export function assertNativeProductDocument(product: CatalogPublishedProduct): void {
  if (product.document === null) invalidAt("catalog_publication_document_required", "product.document", product.type.key);
}

export function assertNativeProductReferences(product: CatalogPublishedProduct): void {
  assertNativeProductDocument(product);
  if (product.primarySkuId === null) invalidAt("catalog_publication_primary_sku_required", "product.primarySkuId", product.type.key);
}

export function decodePublishedProduct(product: CatalogPublishedProduct, documentDigests: ReadonlySet<string>): CatalogPublishedProduct {
  assertNativeProductReferences(product);
  assertPublicationCarriers(product, "product", product.type.key, true);
  publicationJson(product, CATALOG_PUBLICATION_LIMITS.manifestBytes, 1);
  const parsed = catalogPublishedProductSchema.safeParse(product);
  if (!parsed.success) return publicationRefuse("catalog_publication_manifest_invalid");
  assertDocumentExclusion(parsed.data, documentDigests, "product", product.type.key);
  return parsed.data;
}

export function decodePublishedSku(input: unknown, path: string, subject?: string): CatalogPublishedSku {
  assertPublicationCarriers(input, path, subject);
  try {
    publicationJson(input, CATALOG_PUBLICATION_LIMITS.skuBytes, SKU_PAGE_DEPTH);
  } catch (error) {
    return invalidAt(error instanceof CatalogPublicationError && error.code === "catalog_publication_envelope_too_large"
      ? "catalog_publication_sku_too_large" : "catalog_publication_wire_invalid", path, subject);
  }
  const parsed = catalogPublishedSkuSchema.safeParse(input);
  if (!parsed.success) return invalidAt("catalog_publication_sku_revision_invalid",
    fieldPath([path, ...parsed.error.issues[0]!.path]), subject);
  return parsed.data;
}

/** The native latest issue must fit the whole-gram projection served by legacy readers. */
export function assertNativeSkuNetWeight({ code, netContent }: CatalogPublishedSku): void {
  if (netContent.dimension !== "mass" || netContent.unit !== "openlup:g" || netContent.scale !== 0
    || Number(netContent.unscaled) > 2_147_483_647)
    invalidAt("catalog_publication_net_weight_unsupported", "skus.netContent", code);
}

export function assertPublishedSkuDocumentExclusion(sku: CatalogPublishedSku, documentDigests: ReadonlySet<string>): void {
  assertDocumentExclusion(sku, documentDigests, "skus", sku.code);
}

function assertDocumentExclusion(value: unknown, digests: ReadonlySet<string>, field: string, subject?: string): void {
  const path = copiedDocumentPath(value, digests);
  if (path) throw new CatalogPublicationError(publicationIssue(copiedDocument, "structural", [field, ...path].join("."), subject));
}
const manifestV2Shape = z.object({
  schemaVersion: z.literal(2), product: productShape,
  skus: z.array(z.object({ skuId: id, revisionId: id, revision, digest }).strict()).max(10_000),
}).strict();
const manifestShape = z.discriminatedUnion("schemaVersion", [manifestV2Shape, manifestV2Shape.extend({
  schemaVersion: z.literal(3), product: governedProductShape,
}).strict()]).superRefine((manifest, context) => {
  const misplaced = manifest.skus.findIndex((sku, index) => index > 0 && manifest.skus[index - 1]!.skuId >= sku.skuId);
  if (misplaced >= 0) context.addIssue({ code: "custom", path: ["skus", misplaced, "skuId"], message: "SKU roster must be sorted and unique" });
  if (!manifest.skus.some(sku => sku.skuId === manifest.product.primarySkuId))
    context.addIssue({ code: "custom", path: ["product", "primarySkuId"], message: "Primary SKU must appear in the roster" });
});

/** Refuses exact copies of canonical values or raw text using the selected and caller-supplied revision digests. */
export function catalogPublicationManifestSchema(documentDigests: ReadonlySet<string> = new Set()): z.ZodType<CatalogPublicationManifestV2 | CatalogPublicationManifestV3> {
  return manifestShape.superRefine((manifest, context) => {
    const selected = manifest.product.document?.digest;
    const path = copiedDocumentPath(manifest.product, selected ? new Set([...documentDigests, selected]) : documentDigests);
    if (path) context.addIssue({ code: "custom", path: ["product", ...path], message: copiedDocument });
  });
}
// Name every neutral field so that new draft carriers cannot become published facts.
export function publicationContent(content: CatalogDraftSharedContentV3, subject?: string, documentDigest?: string): CatalogPublishedContent {
  const { schemaVersion, catalogAction, presentation, offerMemberships, requestedModes, publicationSkus } = content;
  assertPublishedPresentation(presentation, "product.sharedContent.presentation", subject);
  const documentDigests = new Set(documentDigest ? [documentDigest] : []);
  for (const [index, sku] of publicationSkus.entries()) {
    const path = `product.sharedContent.publicationSkus.${index}.facts`;
    assertPublishedFacts(sku.facts, path, subject);
    assertDocumentExclusion(sku.facts, documentDigests, path, subject);
  }
  const published = { schemaVersion, catalogAction, presentation, offerMemberships, requestedModes, publicationSkus };
  assertPublicationCarriers(published, "product.sharedContent", subject);
  return published;
}

const publicationHead = z.object({ publicationId: id, revision, documentDigest: digest }).strict();
const receiptChange = z.object({ productId: id, variantId: id, sku: code, state: z.enum(["draft", "active", "withdrawn"]),
  variantRevision: revision, publicationHead, draftRef: z.object({ draftId: id, revision }).strict() }).strict();
const publicationReceipt = z.object({
  schemaVersion: z.literal(2), productId: id, commandKey: z.string().min(1).refine(key => Buffer.byteLength(key) <= 200),
  fingerprint: digest, actorId: id, previousHead: publicationHead.nullable(), head: publicationHead,
  publicationDigest: digest, committedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u),
  changes: z.array(receiptChange).max(10_000),
}).strict();

const publicationReceiptV3 = publicationReceipt.extend({
  schemaVersion: z.literal(3), changes: z.array(receiptChange.extend({ state: lifecycleState }).strict()).max(10_000),
}).strict();

function boundedJson(text: unknown, bytes: number): unknown {
  if (typeof text !== "string" || Buffer.byteLength(text) > bytes) throw new Error("publication_json_invalid");
  return JSON.parse(text);
}

function decodeStored<T>(text: unknown, maxBytes: number, depth: number, code: PlatformCode, decode: (value: unknown) => T,
  inputCode = code): T {
  let input: unknown, canonical: string;
  try {
    input = boundedJson(text, maxBytes);
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("publication_object_required");
    canonical = publicationJson(input, maxBytes, depth);
  } catch (error) {
    if (error instanceof CanonicalFieldError && code === "catalog_publication_manifest_invalid")
      return invalidAt(code, error.path || "publication");
    return publicationRefuse(inputCode, "dependency_unavailable");
  }
  if (canonical !== text) return publicationRefuse(code, "dependency_unavailable");
  try {
    return decode(input);
  } catch (error) {
    if (error instanceof CatalogPublicationError) throw error;
    if (error instanceof z.ZodError && code === "catalog_publication_manifest_invalid")
      return invalidAt(code, fieldPath(error.issues[0]?.path ?? []) || "publication");
    return publicationRefuse(code, "dependency_unavailable");
  }
}

type StoredFieldIssue = Issue & PlatformIssue & { stored: true };
type Decoded<T> = { ok: true; value: T } | { ok: false; issue: StoredFieldIssue };
type PacketRows = { publications: readonly unknown[]; skuRevisions: readonly unknown[] };

function storedField(code: PlatformCode, path: string): Decoded<never> {
  return { ok: false, issue: { ...publicationIssue(code, "structural", path), stored: true } };
}

export function decodePublicationPacket(input: { manifest: unknown }): Decoded<CatalogPublicationManifestV2 | CatalogPublicationManifestV3>;
export function decodePublicationPacket(input: PacketRows): Decoded<void>;
export function decodePublicationPacket(input: { manifest: unknown } | PacketRows): Decoded<unknown> {
  if ("manifest" in input) {
    const code = "catalog_publication_manifest_invalid";
    try {
      const manifest = decodeStored(input.manifest, CATALOG_PUBLICATION_LIMITS.manifestBytes, 0, code, value => {
        const parsed = manifestShape.parse(value);
        decodePublishedProduct(parsed.product, new Set());
        return parsed;
      });
      return { ok: true, value: manifest };
    } catch (error) {
      if (!(error instanceof CatalogPublicationError)) throw error;
      const issue = error.diagnostic;
      return storedField(issue.kind === "platform" ? issue.code : code, issue.path || "publication");
    }
  }

  const revisions = new Map<string, Record<string, unknown>>();
  const revisionCode = "catalog_publication_sku_revision_invalid";
  for (const [index, row] of input.skuRevisions.entries()) {
    const source = packetRow(row);
    const parsed = id.safeParse(source?.id);
    if (!source || !parsed.success || revisions.has(parsed.data)) return storedField(revisionCode, `catalog_sku_revisions.${index}.id`);
    revisions.set(parsed.data, source);
  }
  const governedRevisions = new Set<string>();
  for (const row of input.publications) {
    const decoded = decodePublicationPacket({ manifest: packetRow(row)?.canonical_state });
    if (!decoded.ok) return decoded;
    for (const [index, ref] of decoded.value.skus.entries()) {
      const revision = revisions.get(ref.revisionId);
      if (!revision || revision.product_id !== decoded.value.product.id || revision.sku_id !== ref.skuId
        || revision.revision !== ref.revision || revision.digest !== ref.digest)
        return storedField(revisionCode, `skus.${index}.revisionId`);
      if (decoded.value.schemaVersion === 3 && !governedRevisions.has(ref.revisionId)) {
        try {
          const facts = decodeStoredPublicationSku(revision.full_facts);
          if (facts.schemaVersion !== 3 || facts.id !== ref.skuId || facts.productId !== decoded.value.product.id
            || facts.code !== revision.sku_code || publicationDigest(facts, CATALOG_PUBLICATION_LIMITS.skuBytes, SKU_PAGE_DEPTH) !== ref.digest)
            return storedField(revisionCode, `skus.${index}.facts`);
        } catch {
          return storedField(revisionCode, `skus.${index}.facts`);
        }
        governedRevisions.add(ref.revisionId);
      }
    }
  }
  return { ok: true, value: undefined };
}

function packetRow(row: unknown): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = typeof row === "string" ? JSON.parse(row) : row;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch { /* The decoder reports the first missing field in the row. */ }
}

export function requireDecodedPublication<T>(decoded: Decoded<T>): T {
  if (!decoded.ok) throw new CatalogPublicationError(decoded.issue);
  return decoded.value;
}

export function decodeStoredPublicationSku(text: unknown): CatalogPublishedSku {
  return decodeStored(text, CATALOG_PUBLICATION_LIMITS.skuBytes, SKU_PAGE_DEPTH,
    "catalog_publication_sku_revision_invalid", input => decodePublishedSku(input, "sku"));
}

export function decodeStoredPublicationReceipt(text: unknown): CatalogPublicationReceiptV2 | CatalogPublicationReceiptV3 {
  return decodeStored(text, CATALOG_PUBLICATION_LIMITS.receiptBytes, 1,
    "catalog_publication_receipt_invalid", input => z.union([publicationReceipt, publicationReceiptV3]).parse(input), "catalog_publication_receipt_input_invalid");
}

export function assertPublicationRegistration(text: string, path: string): void {
  try {
    const document = boundedJson(text, CATALOG_DRAFT_MAX_BYTES);
    if (!document || typeof document !== "object" || Array.isArray(document)) throw new Error("publication_document_object_required");
    canonicalCatalogPublicationJson(document);
  } catch {
    invalidAt("catalog_publication_v3_document_invalid", path);
  }
}

export function legacyPublicationReceipt(receipt: CatalogPublicationReceiptV2 | CatalogPublicationReceiptV3): CatalogPublicationReceipt {
  const { commandKey, fingerprint, actorId, previousHead, head } = receipt;
  const changes = receipt.schemaVersion === 2 ? receipt.changes : receipt.changes.map(change => ({
    ...change, state: change.state === "archived" ? "withdrawn" as const : change.state,
  }));
  return { commandKey, fingerprint, actorId, previousHead, head, changes };
}

/** @internal Shared by native PostgreSQL adapters and catalogue preparation. */
export const nativeCatalogPublication = {
  assertPublishedSkuIdentity, legacyPublicationReceipt,
  decodePublicationPacket, requireDecodedPublication, decodeStoredPublicationReceipt, decodeStoredPublicationSku,
  publicationJson, publicationDigest, SKU_PAGE_DEPTH, limits: CATALOG_PUBLICATION_LIMITS,
  catalogPublicationAdmissionRefusal, publicationReadFailure, publicationRefuse, publicationRemedy,
};
