import { createHash } from "node:crypto";
import { z } from "./validation.js";
import { canonicalCatalogPublicationJson, canonicalCatalogDraftJson } from "./contracts/draft.js";
import { catalogDraftPayloadV3Schema, catalogDraftSharedContentV3Schema, resolveCatalogDraftProvenance } from "./draftV3Schemas.js";
import { catalogDraftSkuV2Schema } from "./draftV2Schemas.js";
import { isValidGtin, catalogDocumentRevisionRefSchema } from "./foundationSchemas.js";
import { catalogProductTypeRefSchema, catalogQuantitySchema, catalogOptionValueSchema, catalogDimensionKeySchema } from "./productTypeSchemas.js";
import { canonicalizeCatalogCombinationV2 } from "./variantCombination.js";
import { CATALOG_QUANTITY_UNITS, canonicalizeCatalogQuantity, parseCatalogQuantity } from "@openlup/core/catalog";
import type { CatalogProductTypeDefinition, CatalogQuantity } from "./contracts/productTypes.js";
import type { CatalogDraftPayloadV3, CatalogDraftPublicationStoredRecord, CatalogPublicationFacts, CatalogDraftPublicationOperationV3 } from "./contracts/draftV3.js";
import type { CatalogDraftClaimV3 } from "./contracts/draftV3.js";
import type { CatalogPublishedProduct, CatalogPublishedSku, CatalogPublishedIdentifier, CatalogPublicationManifestV2 } from "./contracts/publication.js";
import { CATALOG_PUBLICATION_LIMITS } from "./contracts/publication.js";

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
const ref = z.string().min(1).max(240).refine(value => value.trim() === value);
/** @experimental */
export const publicationReadinessReasons = z.array(z.string().regex(/^[a-z][a-z0-9_]{0,159}$/u)).max(100)
  .refine(reasons => new Set(reasons).size === reasons.length);
/** @experimental */
export const publicationReadinessVerdict = z.object({ ready: z.boolean(), reasons: publicationReadinessReasons }).strict()
  .refine(({ ready, reasons }) => ready === (reasons.length === 0));
const facts = z.record(z.string(), z.json());
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
  attributes, facts, identifiers: z.array(identifierSchema), assetRefs: z.array(ref).max(32),
  logisticsRef: z.string().min(1).max(500).refine(value => value.trim() === value).nullable(),
  memberships: z.array(z.object({ offerVersion: ref, admitted: z.boolean() }).strict()), source: claimSchema,
}).strict().superRefine((sku, context) => {
  if (!sku.memberships.every((row, index) => index === 0 || comparePublicationText(sku.memberships[index - 1]!.offerVersion, row.offerVersion) < 0)
    || sku.identifiers.filter(row => row.isPrimary).length > 1)
    context.addIssue({ code: "custom", message: "membership roster and primary identifier must be unique" });
}) as z.ZodType<CatalogPublishedSku>;
export const catalogPublishedProductSchema: z.ZodType<CatalogPublishedProduct> = z.object({
  id, slug: z.string().min(1), name: z.string().min(1).max(500), status: z.enum(["draft", "active", "archived"]),
  type: catalogProductTypeRefSchema, axes: z.array(catalogDimensionKeySchema).max(16).refine(values => new Set(values).size === values.length), attributes, primarySkuId: id.nullable(),
  document: catalogDocumentRevisionRefSchema.nullable(), presentation: facts.nullable(), source: claimSchema,
  content: catalogDraftSharedContentV3Schema,
}).strict() as z.ZodType<CatalogPublishedProduct>;
export const catalogPublicationManifestSchema: z.ZodType<CatalogPublicationManifestV2> = z.object({
  schemaVersion: z.literal(2), product: catalogPublishedProductSchema,
  skus: z.array(z.object({ skuId: id, revisionId: id, revision, digest }).strict()),
}).strict().superRefine((manifest, context) => {
  if (!manifest.skus.every((sku, index) => index === 0 || manifest.skus[index - 1]!.skuId < sku.skuId)
    || !manifest.skus.some(sku => sku.skuId === manifest.product.primarySkuId))
    context.addIssue({ code: "custom", message: "manifest roster must be sorted, unique and contain its primary" });
});
/** @experimental */
export interface CatalogPublicationDocument {
  reference: z.infer<typeof catalogDocumentRevisionRefSchema>; canonicalText: string;
  provenance: { draftId: string; draftRevision: number; draftCommandKey: string; draftFingerprint: string };
}
/** @experimental */
export interface CatalogPublicationRules {
  /** Installed code only. Validate/canonicalize opaque documents, presentations, vocabularies and full affected-set facts. */
  validateProduct(product: CatalogPublishedProduct, skus: readonly CatalogPublishedSku[], documents: readonly CatalogPublicationDocument[]): readonly string[];
  /** Rejects a membership effect against the SKU's ordered prefix, including a no-op on a frozen roster. */
  validateMembershipChange?(sku: Readonly<CatalogPublishedSku>, change: { offerVersion: string; admitted: boolean }): boolean;
  canonicalizeDocument(document: unknown): string;
  /** Validates stored bytes and returns only their identity, canonicality and value digest. */
  inspectDocument(canonicalText: string): { schemaId: string; documentRef: string; productSlug: string; revisionNo: number;
    canonicallyEncoded: boolean; contentDigest: string };
  /** Reads identity using the installed document's schema. */
  identifyDocument(document: unknown): { schemaId: string; documentRef: string; productSlug: string; revisionNo: number; name?: string };
  /** Optional installed category limit, applied to exactly converted integer grams. */
  validateSkuAmounts?(sku: { code: string; netGrams: string }): boolean;
  deriveSkuFacts(canonicalText: string, sku: CatalogPublishedSku): CatalogPublicationFacts;
  classifySkuChange(before: CatalogPublishedSku, after: CatalogPublishedSku, context: {
    beforeProduct: CatalogPublishedProduct; afterProduct: CatalogPublishedProduct;
    beforeDocument: CatalogPublicationDocument | null; afterDocument: CatalogPublicationDocument;
  }): "compatible" | "material" | "inconclusive";
}
/** @experimental */
export interface CatalogPublicationCompileInput {
  payload: CatalogDraftPayloadV3; record: CatalogDraftPublicationStoredRecord; definition: CatalogProductTypeDefinition;
  product: CatalogPublishedProduct | null; skus: readonly CatalogPublishedSku[]; documents: readonly CatalogPublicationDocument[];
  retainedSources: readonly CatalogDraftPublicationStoredRecord[]; rules: CatalogPublicationRules; capacity?: number;
}
export function catalogPublicationClaim(record: CatalogDraftPublicationStoredRecord): CatalogDraftClaimV3 {
  return { draftId: record.draftId, revision: record.revision, commandKey: record.commandKey, fingerprint: record.fingerprint };
}
const equal = (a: unknown, b: unknown): boolean => publicationJson(a) === publicationJson(b);
const need = (condition: unknown, reason: string): void => { if (!condition) publicationRefuse(reason); };
const sealedPresentation = (presentation: CatalogPublicationFacts | null): CatalogPublicationFacts => presentation ?? {};

type PublicationEligibility = Extract<PublicationOperation, { op: "set_eligibility" }>;
function enablesSku(operation: PublicationOperation): operation is PublicationEligibility {
  return operation.op === "set_eligibility" && (operation.sellableStandalone || operation.sellableInSubscription);
}

function requiredPromotions(operations: readonly PublicationOperation[], current: Pick<CatalogPublicationCompileInput, "product" | "skus">) {
  const enabling = new Set(operations.filter(enablesSku).map(operation => operation.skuCode));
  return { product: enabling.size > 0 && current.product?.status === "draft",
    skus: current.skus.filter(sku => enabling.has(sku.code) && sku.status === "draft").map(sku => sku.code) };
}

/** Adapts presentation and compiles required draft-status effects before sealing the v3 batch.
 * @experimental
 */
export function compileCatalogPublicationDraft(payload: CatalogDraftPayloadV3, presentation: CatalogPublicationFacts | null,
  current?: Pick<CatalogPublicationCompileInput, "product" | "skus">): CatalogDraftPayloadV3 {
  const { operations } = payload.publication;
  let compiled = operations;
  if (current?.product) {
    const required = requiredPromotions(operations, current);
    const missing = new Set(required.skus);
    for (const operation of operations)
      if (operation.op === "set_sku_status" && operation.status === "active") missing.delete(operation.skuCode);
    compiled = operations.flatMap(operation => enablesSku(operation) && missing.delete(operation.skuCode)
      ? [operation, { op: "set_sku_status", skuCode: operation.skuCode, status: "active" }] : [operation]);
    if (required.product && !compiled.some(operation => operation.op === "set_product_status" && operation.status === "active")) {
      let index = compiled.length;
      while (compiled[index - 1]?.op === "set_offer_membership") index--;
      compiled.splice(index, 0, { op: "set_product_status", productSlug: current.product.slug, status: "active" });
    }
  }
  return { ...payload, product: { ...payload.product, sharedContent: {
    ...payload.product.sharedContent, presentation: sealedPresentation(presentation),
  } }, publication: { ...payload.publication, operations: compiled } };
}

const authoredSlug = z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9_-]*$/u);
/** Temporary native publication boundary, until versioned quantity readers land. */
export function catalogPublicationIntegralGrams(quantity: CatalogQuantity, definition: CatalogProductTypeDefinition): string {
  const reason = "catalog_publication_integral_grams_required";
  try {
    const units = definition.units.flatMap(unit => {
      const known = CATALOG_QUANTITY_UNITS.find(value => value.code === unit.code);
      return known ? [known] : unit.factor ? [{ ...unit, factor: unit.factor }] : [];
    });
    const value = canonicalizeCatalogQuantity(parseCatalogQuantity(quantity, units), units);
    const divisor = 10n ** BigInt(value.scale), unscaled = BigInt(value.unscaled);
    need(value.dimension === "mass" && value.unit === "openlup:g" && unscaled > 0n && unscaled % divisor === 0n, reason);
    const grams = unscaled / divisor, maximum = 2_147_483_647n;
    need(grams <= maximum, reason);
    return grams.toString();
  } catch { return publicationRefuse(reason); }
}
export function assertCatalogPublicationMassInputs(payload: unknown, definition: CatalogProductTypeDefinition): void {
  const header = z.object({ skus: z.array(z.object({ netContent: z.unknown().optional(), grossMass: z.unknown().optional() })) }).safeParse(payload);
  if (!header.success) return;
  for (const sku of header.data.skus) {
    const value = sku.netContent;
    if (value && typeof value === "object" && "dimension" in value && value.dimension === "mass")
      catalogPublicationIntegralGrams(value as CatalogQuantity, definition);
  }
}
type AmountBinding = { definition: CatalogProductTypeDefinition; rules: Pick<CatalogPublicationRules, "validateSkuAmounts"> };

/** @experimental */
export function catalogPublicationPreparationIssues(payload: CatalogDraftPayloadV3, binding?: AmountBinding) {
  const issues: { path: string; code: string }[] = [];
  const add = (path: string, code: string) => issues.push({ path, code });
  if (!authoredSlug.safeParse(payload.product.slug).success) add("product.slug", "commerce_product_slug_unsupported");
  const codes = new Set(payload.skus.map(sku => sku.code));
  const content = payload.product.sharedContent;
  for (const key of ["publicationSkus", "requestedModes", "offerMemberships"] as const)
    if (content[key].some(intent => !codes.has(intent.skuCode))) add(`product.sharedContent.${key}`, "intent_sku_absent");
  payload.skus.forEach((sku, index) => {
    const path = `skus.${index}`;
    if (!sku.code) { add(`${path}.code`, "sku_code_missing"); return; }
    if (!sku.identifiers?.some(identifier => identifier.scheme === "gs1:gtin"
      && identifier.packagingLevel === "unit" && isValidGtin(identifier.value))) add(`${path}.identifiers`, "unit_trade_identifier_missing");
    if (!binding || sku.netContent?.dimension !== "mass") return;
    try {
      if (sku.grossMass) assertCatalogPublicationGrossMass(sku.netContent, sku.grossMass, binding.definition);
      const netGrams = catalogPublicationIntegralGrams(sku.netContent, binding.definition);
      if (binding.rules.validateSkuAmounts && binding.rules.validateSkuAmounts({ code: sku.code, netGrams }) !== true)
        add(`${path}.netContent`, "catalog_publication_authored_amounts_invalid");
    } catch (error) {
      if (!(error instanceof CatalogPublicationError)) throw error;
      add(`${path}.${error.code.startsWith("catalog_publication_gross") ? "grossMass" : "netContent"}`, error.code);
    }
  });
  return issues;
}
/** Hard preparation guard, independent of dark/activation readiness.
 * @experimental
 */
export function assertCatalogPublicationPreparation(payload: CatalogDraftPayloadV3, binding?: AmountBinding): void {
  const [first] = catalogPublicationPreparationIssues(payload, binding);
  if (first) publicationRefuse(first.code);
}
/** Exact scaled comparison after owner-defined conversion, with no rounding or Number arithmetic.
 * @experimental
 */
export function assertCatalogPublicationGrossMass(net: CatalogQuantity, gross: CatalogQuantity | null, definition: CatalogProductTypeDefinition): void {
  need(net.dimension === "mass", "catalog_publication_mass_required_until_mc5");
  need(gross?.dimension === "mass", "catalog_publication_gross_mass_required");
  const units = definition.units.flatMap(unit => {
    const known = CATALOG_QUANTITY_UNITS.find(value => value.code === unit.code);
    return known ? [known] : unit.factor ? [{ ...unit, factor: unit.factor }] : [];
  });
  try {
    const n = canonicalizeCatalogQuantity(parseCatalogQuantity(net, units), units);
    const g = canonicalizeCatalogQuantity(parseCatalogQuantity(gross!, units), units);
    need(g.dimension === "mass" && n.unit === g.unit && BigInt(g.unscaled) > 0n, "catalog_publication_gross_mass_invalid");
    need(BigInt(g.unscaled) * 10n ** BigInt(n.scale) >= BigInt(n.unscaled) * 10n ** BigInt(g.scale), "catalog_publication_gross_below_net");
  } catch (error) { if (error instanceof CatalogPublicationError) throw error; publicationRefuse("catalog_publication_gross_mass_invalid"); }
}
/** @experimental */
export function catalogPublicationAffected(payload: CatalogDraftPayloadV3) {
  let wholeProduct = false;
  const created = new Set<string>(), admitted = new Set<string>(), enabling = new Set<string>();
  for (const op of payload.publication.operations) {
    if (op.op === "create_sku") created.add(op.skuCode);
    if (op.op === "set_offer_membership" && op.admitted) admitted.add(op.skuCode);
    if (op.op === "set_eligibility" && (op.sellableStandalone || op.sellableInSubscription)) enabling.add(op.skuCode);
    if ((op.op === "move_document_pointer" || op.op === "set_product_status" && op.status === "active")
      && op.productSlug === payload.product.slug) wholeProduct = true;
  }
  const structural = (code: string) => wholeProduct || created.has(code) || admitted.has(code);
  return { structural, enabling,
    source: (code: string) => wholeProduct || admitted.has(code),
    priced: (sku: CatalogPublishedSku) => enabling.has(sku.code) || structural(sku.code) && sku.status === "active"
      && (sku.sellableStandalone || sku.sellableInSubscription) && sku.memberships.some(row => row.admitted),
  };
}
function matchesAuthoredIdentifier(
  authored: NonNullable<CatalogDraftPayloadV3["skus"][number]["identifiers"]>[number],
  published: Pick<CatalogPublishedSku["identifiers"][number], "scheme" | "issuer" | "value" | "packagingLevel" | "quantity">,
) {
  return authored.scheme === published.scheme && authored.issuer === published.issuer
    && (authored.scheme === "gs1:gtin" ? isValidGtin(authored.value) && authored.value.padStart(14, "0") === published.value.padStart(14, "0")
      : authored.value === published.value)
    && authored.packagingLevel === published.packagingLevel && (authored.quantity ?? 1) === published.quantity;
}
/** Checks a sealed media claim against the presentation and SKU before consulting installed evidence.
 * @experimental
 */
export function catalogPublicationMediaIssue(mediaRef: unknown, assets: readonly string[],
  claim?: NonNullable<CatalogDraftPayloadV3["publication"]["evidence"]["media"]>[number]) {
  if (!mediaRef && !assets.length && !claim) return null;
  if (typeof mediaRef !== "string" || !mediaRef) return "media_reference_missing";
  if (!claim) return "media_readiness_unknown";
  // The draft seal retains its established order. Compare both sets using the
  // database order without changing signed or persisted bytes.
  return claim.mediaRef === mediaRef && equal([...assets].sort(comparePublicationText), [...claim.assetRefs].sort(comparePublicationText))
    ? null : "media_readiness_mismatch";
}
function checkedDocument(canonicalText: string, reference: Pick<CatalogPublicationDocument["reference"], "digest" | "documentRef" | "revisionNo">
  & { schemaId?: string | undefined },
  slug: string, rules: CatalogPublicationRules) {
  need(createHash("sha256").update(canonicalText).digest("hex") === reference.digest, "catalog_publication_v3_document_digest_mismatch");
  let documentInfo: ReturnType<CatalogPublicationRules["inspectDocument"]>;
  try {
    documentInfo = rules.inspectDocument(canonicalText);
    need(documentInfo?.productSlug === slug && documentInfo.documentRef === reference.documentRef && documentInfo.revisionNo === reference.revisionNo
      && (reference.schemaId === undefined || documentInfo.schemaId === reference.schemaId), "catalog_publication_v3_document_invalid");
  } catch { return publicationRefuse("catalog_publication_v3_document_invalid"); }
  need(documentInfo.canonicallyEncoded === true, "catalog_publication_v3_document_not_canonical");
  return documentInfo.contentDigest;
}
function matchesAuthoredDocument(document: unknown, canonicalText: string, contentDigest: string, rules: CatalogPublicationRules) {
  let canonical: string;
  try {
    canonical = rules.canonicalizeDocument(document);
  } catch { return false; }
  return canonical === canonicalText && publicationDigest(document) === contentDigest;
}
function documentSkuFacts(document: CatalogPublicationDocument, sku: CatalogPublishedSku, rules: CatalogPublicationRules): CatalogPublicationFacts {
  return rules.deriveSkuFacts(document.canonicalText, sku);
}
type PublicationSourceInput = Pick<CatalogPublicationCompileInput, "record" | "payload" | "retainedSources" | "rules">;
type PublicationOperation = CatalogDraftPayloadV3["publication"]["operations"][number];

function skuCreationFacts(operation: Extract<PublicationOperation, { op: "create_sku" }>,
  source: { sku: CatalogDraftPayloadV3["skus"][number]; source: CatalogDraftPublicationStoredRecord }, productId: string): CatalogPublishedSku {
  const { sku } = source;
  need(sku.netContent?.dimension === "mass", "catalog_publication_mass_required_until_mc5");
  return { id: operation.skuId, productId, code: operation.skuCode, title: operation.title,
    status: "draft", minQuantity: operation.minQuantity, isAddon: operation.isAddon, sellableStandalone: false, sellableInSubscription: false,
    netContent: sku.netContent!, grossMass: sku.grossMass ?? null, options: sku.options, attributes: sku.attributes ?? {},
    facts: operation.facts, identifiers: [], assetRefs: sku.assetRefs ?? [], logisticsRef: null, memberships: [], source: catalogPublicationClaim(source.source) };
}

function applyMembershipChange(rules: CatalogPublicationRules, sku: CatalogPublishedSku,
  { offerVersion, admitted }: Extract<PublicationOperation, { op: "set_offer_membership" }>) {
  const row = { offerVersion, admitted };
  if (rules.validateMembershipChange)
    need(rules.validateMembershipChange(sku, row) === true, "catalog_publication_membership_change_not_allowed");
  const index = sku.memberships.findIndex(value => value.offerVersion === offerVersion);
  if (index < 0) sku.memberships.push(row); else sku.memberships[index] = row;
  sku.memberships.sort((a, b) => comparePublicationText(a.offerVersion, b.offerVersion));
}

function prefixSku(skus: ReadonlyMap<string, CatalogPublishedSku>, code: string): CatalogPublishedSku {
  return skus.get(code) ?? publicationRefuse("catalog_publication_v3_compile_sku_absent");
}

function applySkuPrefix(sku: CatalogPublishedSku, operation: PublicationOperation, rules: CatalogPublicationRules) {
  switch (operation.op) {
    case "create_identifier": {
      const { op: _op, skuCode: _code, ...identifier } = operation;
      sku.identifiers.push(identifier);
      break;
    }
    case "set_eligibility":
      sku.sellableStandalone = operation.sellableStandalone; sku.sellableInSubscription = operation.sellableInSubscription;
      break;
    case "set_sku_status": sku.status = operation.status; break;
    case "set_offer_membership": applyMembershipChange(rules, sku, operation); break;
    case "set_sku_metadata": sku.logisticsRef = operation.logisticsRef; break;
    case "set_derived_sku_facts": sku.facts = operation.facts; break;
  }
}

function assertDerivedSource(operation: Extract<PublicationOperation, { op: "set_derived_sku_facts" }>,
  original: Pick<CatalogPublishedSku, "netContent"> | undefined, authoredRevision: number | undefined) {
  need(original && equal(original.netContent, operation.netContent) && operation.documentRevisionNo === authoredRevision,
    "catalog_publication_derived_source_mismatch");
}

function publicationAuthorship({ record, payload, retainedSources, rules }: PublicationSourceInput) {
  const sources = [record, ...retainedSources];
  const slug = payload.product.slug!;
  function sku(code: string) {
    const applicable = sources.filter(source => source.productId === payload.product.id && source.payload.schemaVersion === 3
      && source.payload.skus.some(sku => sku.code === code));
    const current = applicable.find(source => source.draftId === record.draftId && source.revision === record.revision);
    const declared = applicable.filter(source => payload.publication.evidence.drafts?.some(claim => equal(claim, catalogPublicationClaim(source))));
    const claimed = current ? [current, ...declared.filter(source => !equal(catalogPublicationClaim(source), catalogPublicationClaim(current)))]
      : declared;
    need(claimed.length <= 1, "catalog_publication_operation_source_ambiguous");
    const source = claimed[0];
    if (!source || source.payload.schemaVersion !== 3) return publicationRefuse("catalog_publication_operation_source_missing");
    const sku = source.payload.skus.find(sku => sku.code === code)!;
    need(sku.productId === payload.product.id, "catalog_publication_operation_source_mismatch");
    return { source, payload: source.payload, sku };
  }
  function document(operation: Extract<PublicationOperation, { op: "register_document_revision" }>): CatalogPublicationDocument {
    const provenance = resolveCatalogDraftProvenance(operation.provenance, record);
    const source = sources.find(source => source.draftId === provenance.draftId && source.revision === provenance.draftRevision
      && source.commandKey === provenance.draftCommandKey && source.fingerprint === provenance.draftFingerprint);
    const schemaId = source?.payload.schemaVersion === 3 ? source.payload.product.documentRevision?.schemaId : undefined;
    const contentDigest = checkedDocument(operation.canonicalText, { ...operation, schemaId }, slug, rules);
    if (source?.payload.schemaVersion !== 3 || source.productId !== payload.product.id) return publicationRefuse("catalog_publication_document_source_missing");
    const reference = source.payload.product.documentRevision;
    if (!reference || reference.id !== operation.revisionId || reference.revisionNo !== operation.revisionNo
      || reference.documentRef !== operation.documentRef || reference.sourceRef !== operation.sourceRef || reference.digest !== operation.digest)
      return publicationRefuse("catalog_publication_document_source_mismatch");
    need(matchesAuthoredDocument(source.payload.product.sharedContent.document, operation.canonicalText, contentDigest, rules),
      "catalog_publication_v3_document_invalid");
    return { reference, canonicalText: operation.canonicalText, provenance };
  }
  function productOperation(operation: Extract<PublicationOperation, { productSlug: string }>) {
    need(operation.productSlug === slug, "catalog_publication_scope_expansion");
    if (operation.op === "create_product") {
      need(operation.productId === payload.product.id, "catalog_publication_v3_compile_product_conflict");
      let name: string | undefined;
      try { name = rules.identifyDocument(payload.product.sharedContent.document)?.name; }
      catch { /* A name could not be read from the authored document. */ }
      need(name === operation.name, "catalog_publication_product_name_source_mismatch");
    }
    if (operation.op === "move_document_pointer")
      need(operation.documentRevisionNo === payload.product.documentRevision?.revisionNo, "catalog_publication_document_source_mismatch");
    if (operation.op === "set_product_presentation")
      need(equal(sealedPresentation(operation.presentation), payload.product.sharedContent.presentation), "catalog_publication_presentation_source_mismatch");
  }
  function skuOperation(operation: Extract<PublicationOperation, { skuCode: string }>) {
    const source = sku(operation.skuCode);
    const content = source.payload.product.sharedContent;
    if (operation.op === "create_sku") {
      const authored = content.publicationSkus.find(sku => sku.skuCode === operation.skuCode);
      need(source.sku.id === operation.skuId && authored && equal(authored, {
        skuCode: operation.skuCode, title: operation.title, minQuantity: operation.minQuantity, isAddon: operation.isAddon, facts: operation.facts,
      }), "catalog_publication_operation_source_mismatch");
    }
    if (operation.op === "create_identifier")
      need(source.sku.identifiers?.some(identifier => matchesAuthoredIdentifier(identifier, operation)), "catalog_publication_identifier_source_mismatch");
    if (operation.op === "set_primary_sku")
      need(source.payload.product.primarySkuId === source.sku.id, "catalog_publication_v3_compile_primary_foreign");
    if (operation.op === "set_eligibility") {
      const modes = content.requestedModes.find(value => value.skuCode === operation.skuCode)?.modes ?? [];
      need(operation.sellableStandalone === modes.includes("one_time") && operation.sellableInSubscription === modes.includes("subscription"),
        "catalog_publication_eligibility_source_mismatch");
    }
    if (operation.op === "set_offer_membership")
      need(content.offerMemberships.some(row => equal(row, { skuCode: operation.skuCode, offerVersion: operation.offerVersion, admitted: operation.admitted })),
        "catalog_publication_membership_source_mismatch");
    if (operation.op === "set_sku_metadata")
      need(operation.logisticsRef === (source.sku.logisticsRef ?? null), "catalog_publication_logistics_source_mismatch");
    return source;
  }
  return { document, productOperation, skuOperation };
}

/** Check the authored operation inputs before resolving the publication head.
 * @experimental
 */
export function assertCatalogPublicationAuthorship(input: PublicationSourceInput &
  { skus: readonly CatalogPublishedSku[]; register?: boolean }) {
  const { payload } = input;
  const authored = publicationAuthorship(input);
  const registrationSkus = input.register && payload.publication.operations.some(op => op.op === "set_offer_membership")
    ? new Map(input.skus.map(sku => [sku.code, structuredClone(sku)])) : null;
  for (const operation of payload.publication.operations) {
    if ("productSlug" in operation) authored.productOperation(operation);
    if (operation.op === "register_document_revision") authored.document(operation);
    if (operation.op === "set_derived_sku_facts") {
      const actual = input.skus.find(sku => sku.code === operation.skuCode);
      assertDerivedSource(operation, actual, payload.product.documentRevision?.revisionNo);
      if (registrationSkus?.has(operation.skuCode))
        applySkuPrefix(prefixSku(registrationSkus, operation.skuCode), operation, input.rules);
    } else if ("skuCode" in operation) {
      const prior = !registrationSkus ? undefined : operation.op === "set_offer_membership"
        ? prefixSku(registrationSkus, operation.skuCode) : registrationSkus.get(operation.skuCode);
      const source = authored.skuOperation(operation);
      if (registrationSkus && operation.op === "create_sku")
        registrationSkus.set(operation.skuCode, skuCreationFacts(operation, source, payload.product.id));
      else if (prior) applySkuPrefix(prior, operation, input.rules);
    }
  }
}

/** Ordered publication compiler using installed definitions; never persists or calls commerce.
 * @experimental
 */
export function compileCatalogPublication(input: CatalogPublicationCompileInput): { product: CatalogPublishedProduct; skus: CatalogPublishedSku[]; documents: CatalogPublicationDocument[]; activation: boolean; changed: boolean } {
  const compilation = compileCatalogPublicationEffects(input);
  let step = compilation.next();
  while (!step.done) step = compilation.next();
  const { validatePriceReadiness, validateAfterReadiness, ...effects } = step.value;
  validatePriceReadiness();
  validateAfterReadiness();
  return effects;
}
/** Compile ordered effects and defer the final eligibility check until readiness is known.
 * @experimental
 */
export function* compileCatalogPublicationEffects(input: CatalogPublicationCompileInput) {
  const canonicalPayload = canonicalCatalogDraftJson(input.payload);
  // Check the temporary numeric domain before strict positive-quantity decoding,
  // so zero, negative, fractional and overflow all have the same stable refusal.
  assertCatalogPublicationMassInputs(input.payload, input.definition);
  const payload = catalogDraftPayloadV3Schema.parse(input.payload);
  assertCatalogPublicationPreparation(payload, input);
  need(input.skus.length === 0 || input.product !== null, "catalog_publication_source_invalid");
  if (input.product !== null && !catalogPublishedProductSchema.safeParse(input.product).success)
    publicationRefuse("catalog_publication_read_invalid", "dependency_unavailable");
  need(input.skus.every(sku => sku.productId === payload.product.id), "catalog_publication_scope_expansion");
  const retainedIds = new Set<string>(), retainedCodes = new Set<string>();
  for (const sku of input.skus) {
    need(!retainedIds.has(sku.id) && !retainedCodes.has(sku.code) && catalogPublishedSkuSchema.safeParse(sku).success,
      "catalog_publication_sku_revision_invalid");
    retainedIds.add(sku.id); retainedCodes.add(sku.code);
  }
  const claim = catalogPublicationClaim(input.record), slug = payload.product.slug!;
  let product = input.product === null ? null : structuredClone(input.product);
  function materialState(product: CatalogPublishedProduct | null, rows: readonly CatalogPublishedSku[]) {
    const p = product && (({ source: _source, content: _content, ...facts }) => facts)(product);
    return { product: p, skus: [...rows].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map(sku => ({ id: sku.id,
      digest: publicationDigest((({ source: _source, ...facts }) => facts)(sku), CATALOG_PUBLICATION_LIMITS.skuBytes) })) };
  }
  const original = publicationJson(materialState(product, input.skus));
  const affected = catalogPublicationAffected(payload);
  const originalById = new Map(input.skus.map(sku => [sku.id, sku] as const));
  const skus = new Map(input.skus.map(sku => [sku.code, structuredClone(sku)]));
  const documents = input.documents.map(document => structuredClone(document));
  const authorship = publicationAuthorship({ ...input, payload });
  const created = new Set<string>(), identities = new Set<string>();
  const combination = (options: CatalogPublishedSku["options"]) => Buffer.from(canonicalizeCatalogCombinationV2({
    definition: input.definition, axes: payload.product.dimensions, options,
  }).combinationDigest).toString("hex");
  let existingCombinations: Set<string> | undefined;
  const registered = new Set<string>(), moved = new Set<string>();
  const incoming = new Map(payload.skus.map(sku => [sku.code, sku]));
  const gtins = new Set(input.skus.flatMap(sku => sku.identifiers.filter(identifier => identifier.scheme === "gs1:gtin").map(identifier => identifier.value.padStart(14, "0"))));
  need(input.record.productId === payload.product.id && input.record.status === "open" && input.record.payload.schemaVersion === 3, "catalog_publication_source_invalid");
  need(canonicalCatalogDraftJson(input.record.payload) === canonicalPayload, "catalog_publication_source_mismatch");
  if (product) need(product.id === payload.product.id && product.slug === slug && equal(product.type, payload.product.type), "catalog_publication_product_identity_conflict");
  need((payload.product.sharedContent.catalogAction === "create") === (product === null), "catalog_action_conflict");
  if (product && payload.product.primarySkuId)
    need(product.primarySkuId === payload.product.primarySkuId, "current_primary_mismatch");
  const authoredDocument = payload.product.documentRevision;
  need(authoredDocument, "document_reference_missing");
  for (const document of documents) {
    need(document.reference.productId === payload.product.id, "catalog_publication_document_source_mismatch");
    checkedDocument(document.canonicalText, document.reference, slug, input.rules);
  }
  function knownProduct(): CatalogPublishedProduct { return product ?? publicationRefuse("catalog_publication_v3_compile_product_absent"); }
  const knownSku = (code: string) => prefixSku(skus, code);
  function documentAt(no: number): CatalogPublicationDocument { return documents.find(document => document.reference.revisionNo === no) ?? publicationRefuse("catalog_publication_v3_compile_document_absent"); }
  function currentDocument(): CatalogPublicationDocument { return documents.find(document => document.reference.id === knownProduct().document?.id) ?? publicationRefuse("catalog_publication_v3_compile_document_absent"); }
  let activation = false;
  for (const operation of payload.publication.operations) {
    if ("productSlug" in operation) need(operation.productSlug === slug, "catalog_publication_scope_expansion");
    if (operation.op === "create_product") {
      need(product === null && operation.productId === payload.product.id, "catalog_publication_v3_compile_product_conflict");
      authorship.productOperation(operation);
      product = { id: operation.productId, slug, name: operation.name, status: "draft", type: payload.product.type,
        axes: [...payload.product.dimensions], attributes: payload.product.attributes ?? {}, primarySkuId: null, document: null,
        presentation: null, source: claim, content: payload.product.sharedContent };
    } else if (operation.op === "register_document_revision") {
      const entry = authorship.document(operation);
      knownProduct();
      const prior = documents.find(document => document.reference.id === operation.revisionId || document.reference.revisionNo === operation.revisionNo);
      if (prior) need(equal(prior, entry), "catalog_publication_v3_compile_document_conflict");
      else {
        need(operation.revisionNo === Math.max(0, ...documents.map(document => document.reference.revisionNo)) + 1, "catalog_publication_document_revision_sequence");
        documents.push(entry);
      }
      registered.add(entry.reference.id);
    } else if (operation.op === "move_document_pointer") {
      const document = documentAt(operation.documentRevisionNo);
      need(document.reference.productId === knownProduct().id && payload.product.documentRevision?.id === document.reference.id, "catalog_publication_document_source_mismatch");
      knownProduct().document = document.reference;
      if (registered.has(document.reference.id)) moved.add(document.reference.id);
    } else if (operation.op === "create_sku") {
      need(!skus.has(operation.skuCode) && ![...skus.values()].some(sku => sku.id === operation.skuId), "catalog_publication_v3_compile_sku_conflict");
      const source = authorship.skuOperation(operation);
      const sku = skuCreationFacts(operation, source, knownProduct().id);
      existingCombinations ??= new Set([...skus.values()].map(existing => combination(existing.options)));
      const identity = combination(sku.options);
      need(!existingCombinations.has(identity), "duplicate_combination");
      need(knownProduct().document?.revisionNo === operation.documentRevisionNo
        && equal(source.payload.product.documentRevision, knownProduct().document), "catalog_publication_v3_compile_document_stale");
      existingCombinations.add(identity);
      need(equal(documentSkuFacts(currentDocument(), sku, input.rules), sku.facts), "catalog_publication_v3_compile_derived_facts_mismatch");
      skus.set(sku.code, sku); created.add(sku.code);
    } else if (operation.op === "create_identifier") {
      const sku = knownSku(operation.skuCode);
      need(created.has(sku.code), "catalog_publication_identifier_requires_created_sku");
      authorship.skuOperation(operation);
      const { op: _op, skuCode: _code, ...identifier } = operation;
      if (identifier.scheme === "gs1:gtin") {
        need(isValidGtin(identifier.value) && !gtins.has(identifier.value.padStart(14, "0")), "catalog_publication_v3_compile_identifier_conflict");
        gtins.add(identifier.value.padStart(14, "0"));
      }
      need(!identifier.isPrimary || identifier.scheme === "gs1:gtin" && identifier.packagingLevel === "unit" && !sku.identifiers.some(value => value.isPrimary), "catalog_publication_identifier_primary_invalid");
      applySkuPrefix(sku, operation, input.rules);
    } else if (operation.op === "set_primary_sku") {
      const sku = knownSku(operation.skuCode), source = authorship.skuOperation(operation);
      need(sku.productId === knownProduct().id && source.sku.id === sku.id, "catalog_publication_v3_compile_primary_foreign");
      need(knownProduct().primarySkuId === null || knownProduct().primarySkuId === sku.id, "catalog_publication_v3_compile_primary_immutable");
      need(sku.status !== "archived", "catalog_publication_v3_compile_sku_archived");
      knownProduct().primarySkuId = sku.id;
    } else if (operation.op === "set_product_status") {
      if (operation.status === "active") need(knownProduct().document !== null && knownProduct().primarySkuId !== null, "catalog_publication_v3_compile_product_incomplete");
      knownProduct().status = operation.status;
    } else if (operation.op === "set_eligibility") {
      const sku = knownSku(operation.skuCode), source = authorship.skuOperation(operation);
      const on = operation.sellableStandalone || operation.sellableInSubscription;
      const materialized = originalById.get(sku.id);
      need(!on || materialized && materialized.id === source.sku.id && materialized.productId === source.sku.productId
        && equal(source.sku.netContent, materialized.netContent) && equal(source.sku.options, materialized.options),
      "catalog_publication_operation_source_mismatch");
      need(!on || sku.status !== "archived" && !input.skus.some(value => value.id === sku.id && value.status === "archived"), "catalog_publication_v3_compile_sku_archived");
      activation ||= on;
      applySkuPrefix(sku, operation, input.rules);
    } else if (operation.op === "set_sku_status") {
      const sku = knownSku(operation.skuCode);
      authorship.skuOperation(operation);
      if (operation.status === "archived") need(!sku.sellableStandalone && !sku.sellableInSubscription && knownProduct().primarySkuId !== sku.id, "catalog_publication_v3_compile_archive_refused");
      else need(payload.publication.operations.some(other => other.op === "set_eligibility" && other.skuCode === sku.code
        && (other.sellableStandalone || other.sellableInSubscription)), "catalog_publication_activation_requires_explicit_eligibility");
      applySkuPrefix(sku, operation, input.rules);
    } else if (operation.op === "set_offer_membership") {
      const sku = knownSku(operation.skuCode);
      authorship.skuOperation(operation);
      applySkuPrefix(sku, operation, input.rules);
    } else if (operation.op === "set_product_presentation") {
      authorship.productOperation(operation);
      knownProduct().presentation = operation.presentation;
    } else if (operation.op === "set_sku_metadata") {
      const sku = knownSku(operation.skuCode);
      authorship.skuOperation(operation);
      applySkuPrefix(sku, operation, input.rules);
    } else if (operation.op === "set_derived_sku_facts") {
      const sku = knownSku(operation.skuCode);
      const original = originalById.get(sku.id);
      assertDerivedSource(operation, original, authoredDocument?.revisionNo);
      need(knownProduct().document?.revisionNo === operation.documentRevisionNo, "catalog_publication_derived_source_mismatch");
      need(equal(documentSkuFacts(currentDocument(), sku, input.rules), operation.facts), "catalog_publication_v3_compile_derived_facts_mismatch");
      applySkuPrefix(sku, operation, input.rules);
    } else { const _exhaustive: never = operation; publicationRefuse("catalog_publication_operation_invalid"); }
    yield { operation, product: knownProduct(), skus, documents };
  }
  const result = knownProduct();
  if (payload.product.documentRevision) need(equal(payload.product.documentRevision, result.document), "catalog_publication_document_source_mismatch");
  if (input.product?.document && !equal(input.product.document, authoredDocument) && !moved.has(authoredDocument!.id))
    publicationRefuse("catalog_publication_v3_document_reference_stale", "conflict");
  if (payload.product.sharedContent.document !== undefined) {
    const document = currentDocument();
    need(matchesAuthoredDocument(payload.product.sharedContent.document, document.canonicalText,
      checkedDocument(document.canonicalText, document.reference, slug, input.rules), input.rules), "catalog_publication_document_source_mismatch");
  }
  result.attributes = payload.product.attributes ?? result.attributes; result.axes = [...payload.product.dimensions];
  result.content = payload.product.sharedContent; result.source = claim;
  for (const [code, authored] of incoming) {
    const sku = skus.get(code!);
    need(sku, "catalog_publication_sku_effect_missing");
    if (created.has(code!)) need(authored.identifiers?.every(identifier =>
      sku!.identifiers.some(stored => matchesAuthoredIdentifier(identifier, stored))), "catalog_publication_identifier_effect_missing");
    if (authored.logisticsRef) need(sku!.logisticsRef === authored.logisticsRef, "catalog_publication_metadata_effect_missing");
  }
  for (const intent of payload.product.sharedContent.offerMemberships)
    need(skus.get(intent.skuCode)?.memberships.some(row => row.offerVersion === intent.offerVersion && row.admitted === intent.admitted),
      "catalog_publication_membership_effect_missing");
  const productPhysicalChange = input.product !== null && !equal(
    [input.product.type, input.product.axes, input.product.attributes, input.product.document],
    [result.type, result.axes, result.attributes, result.document]);
  for (const sku of skus.values()) {
    const draft = incoming.get(sku.code);
    if (draft && !created.has(sku.code)) {
      need(draft.id === sku.id && draft.productId === sku.productId && equal(draft.netContent, sku.netContent)
        && equal(draft.options, sku.options), "sku_identity_change_requires_new_sku");
      for (const identifier of draft.identifiers ?? []) {
        need(sku.identifiers.some(stored => identifier.scheme === "gs1:gtin" && stored.scheme === "gs1:gtin"
          ? isValidGtin(identifier.value) && identifier.value.padStart(14, "0") === stored.value.padStart(14, "0")
          : matchesAuthoredIdentifier(identifier, stored)), "catalog_publication_identifier_source_mismatch");
      }
      const after = { ...sku, attributes: draft.attributes ?? sku.attributes, grossMass: draft.grossMass ?? sku.grossMass, assetRefs: draft.assetRefs ?? sku.assetRefs };
      Object.assign(sku, after);
    }
    const before = originalById.get(sku.id);
    if (before && (productPhysicalChange || !equal(
      [before.netContent, before.options, before.attributes, before.facts, before.grossMass, before.assetRefs],
      [sku.netContent, sku.options, sku.attributes, sku.facts, sku.grossMass, sku.assetRefs]))) {
      need(input.rules.classifySkuChange(before, sku, { beforeProduct: input.product!, afterProduct: result,
        beforeDocument: input.documents.find(document => document.reference.id === input.product!.document?.id) ?? null,
        afterDocument: currentDocument() }) === "compatible", "sku_identity_change_requires_new_sku");
    }
    need(sku.netContent.dimension === "mass", "catalog_publication_mass_required_until_mc5");
    catalogPublicationIntegralGrams(sku.netContent, input.definition);
    need(equal(documentSkuFacts(currentDocument(), sku, input.rules), sku.facts),
      "catalog_publication_v3_compile_derived_facts_mismatch");
    const key = combination(sku.options);
    need(!identities.has(key), "duplicate_combination"); identities.add(key);
    publicationJson(catalogPublishedSkuSchema.parse(sku), CATALOG_PUBLICATION_LIMITS.skuBytes);
  }
  need(skus.size <= (input.capacity ?? 50_000), "product_capacity_exceeded");
  need(result.primarySkuId && result.document && (input.product !== null || result.presentation), "catalog_publication_v3_structural_readiness_failed");
  need(equal(sealedPresentation(result.presentation), payload.product.sharedContent.presentation), "catalog_publication_presentation_effect_missing");
  const primary = [...skus.values()].find(sku => sku.id === result.primarySkuId);
  need(primary && primary.status !== "archived", "catalog_publication_v3_compile_primary_foreign");
  function validatePriceReadiness() {
    for (const sku of skus.values()) if (affected.priced(sku)) {
      need(sku.status !== "archived", "catalog_publication_v3_compile_sku_archived");
      assertCatalogPublicationGrossMass(sku.netContent, sku.grossMass, input.definition);
      need(sku.identifiers.some(identifier => identifier.scheme === "gs1:gtin" && identifier.isPrimary && identifier.packagingLevel === "unit")
        && sku.logisticsRef && sku.memberships.some(row => row.admitted), "catalog_publication_v3_activation_readiness_failed");
    }
  }
  function validateAfterReadiness() {
    if (payload.publication.operations.some(operation => operation.op === "set_product_status" && operation.status === "active")) {
      need(primary?.status === "active" && (primary.sellableStandalone || primary.sellableInSubscription), "catalog_publication_v3_active_primary_required");
      need(result.presentation, "catalog_publication_v3_presentation_required");
    }
    const promotions = requiredPromotions(payload.publication.operations, input);
    need((!promotions.product || result.status === "active") && promotions.skus.every(code => skus.get(code)?.status === "active"),
      "catalog_publication_activation_effect_missing");
    const issues = input.rules.validateProduct(result, [...skus.values()], documents);
    need(issues.length === 0, "catalog_publication_adopter_validation_failed");
  }
  const sorted = [...skus.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const changed = original !== publicationJson(materialState(result, sorted));
  for (const sku of sorted) {
    const before = originalById.get(sku.id);
    // An omitted derived cache effect has this publication's draft/receipt as
    // its effect provenance. Keep the retained physical/media source available.
    if (before && incoming.has(sku.code) && !equal(before, sku)) sku.source = claim;
  }
  if (!changed && input.product) { result.source = input.product.source; result.content = input.product.content; }
  need(changed || payload.publication.kind === "compensation" && payload.publication.operations.length > 0, "catalog_publication_v3_compile_change_noop");
  return { product: result, skus: sorted, documents, activation, changed, validateAfterReadiness, validatePriceReadiness };
}
