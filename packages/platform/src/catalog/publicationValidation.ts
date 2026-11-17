import { catalogDefinitionDigest } from "./catalogDefinitionDigest.js";
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
import type { CatalogDraftPayloadV3, CatalogPublicationFacts, CatalogDraftPublicationOperationV3 } from "./contracts/draftV3.js";
import type { CatalogDraftClaimV3 } from "./contracts/draftV3.js";
import type { CatalogPublishedIdentifier, CatalogPublicationManifestV2 } from "./contracts/publication.js";
import type { CatalogProductState, CatalogSkuState, CatalogLifecycleStoredRecord as CatalogDraftPublicationStoredRecord, CatalogDraftPayloadV4 } from "./contracts/lifecycleV2.js";
import { catalogDraftPayloadV4Schema, catalogAuthoritativeLifecycleV2, catalogLifecycleProjectionV2, catalogLifecycleTransitionV2, resolveCatalogLifecycleProvenance } from "./lifecycleV2.js";
import { CATALOG_PUBLICATION_LIMITS } from "./contracts/publication.js";

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
const id = z.guid().refine(value => value === value.toLowerCase());
const revision = z.number().int().min(1).max(2_147_483_647);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const code = z.string().min(1).max(160).regex(/^[A-Za-z0-9._:-]+$/u);
const ref = z.string().min(1).max(240).refine(value => value.trim() === value);
const facts = z.record(z.string(), z.json());
const attributes = catalogDraftSkuV2Schema.shape.attributes.unwrap();
const claimSchema = z.object({ draftId: id, revision, commandKey: ref, fingerprint: digest }).strict();
const identifierSchema = z.object({ scheme: ref, issuer: ref, value: z.string().min(1).max(128), packagingLevel: z.enum(["unit", "case"]),
  quantity: z.number().int().min(1).max(999_999), isPrimary: z.boolean(), label: z.string().min(1).max(500).refine(value => value.trim() === value).nullable(), sourceRef: ref.nullable() }).strict()
  .refine(value => value.packagingLevel === "unit" ? value.quantity === 1 : value.quantity >= 2)
  .refine(value => !value.isPrimary || value.scheme === "gs1:gtin" && value.packagingLevel === "unit")
  .refine(value => value.scheme !== "gs1:gtin" || isValidGtin(value.value));
export const catalogPublishedSkuSchema: z.ZodType<CatalogSkuState> = z.object({
  id, productId: id, code, title: z.string().min(1).max(500), status: z.enum(["draft", "active", "archived"]),
  minQuantity: z.number().int().min(1).max(2_147_483_647), isAddon: z.boolean(), sellableStandalone: z.boolean(), sellableInSubscription: z.boolean(),
  netContent: catalogQuantitySchema, grossMass: catalogQuantitySchema.nullable(), options: z.record(catalogDimensionKeySchema, catalogOptionValueSchema),
  attributes, facts, identifiers: z.array(identifierSchema), assetRefs: z.array(ref).max(32), logisticsRef: ref.nullable(),
  memberships: z.array(z.object({ offerVersion: ref, admitted: z.boolean() }).strict()), source: claimSchema,
}).strict().superRefine((sku, context) => {
  if (!sku.memberships.every((row, index) => index === 0 || sku.memberships[index - 1]!.offerVersion < row.offerVersion)
    || sku.identifiers.filter(row => row.isPrimary).length > 1)
    context.addIssue({ code: "custom", message: "membership roster and primary identifier must be unique" });
}) as z.ZodType<CatalogSkuState>;
export const catalogPublishedProductSchema: z.ZodType<CatalogProductState> = z.object({
  id, slug: z.string().min(1), name: z.string().min(1).max(500), status: z.enum(["draft", "active", "archived"]),
  type: catalogProductTypeRefSchema, axes: z.array(catalogDimensionKeySchema).max(16).refine(values => new Set(values).size === values.length), attributes, primarySkuId: id.nullable(),
  document: catalogDocumentRevisionRefSchema.nullable(), presentation: facts.nullable(), source: claimSchema,
  content: catalogDraftSharedContentV3Schema,
}).strict() as z.ZodType<CatalogProductState>;
export const catalogPublicationManifestSchema: z.ZodType<CatalogPublicationManifestV2> = z.object({
  schemaVersion: z.literal(2), product: catalogPublishedProductSchema,
  skus: z.array(z.object({ skuId: id, revisionId: id, revision, digest }).strict()),
}).strict().superRefine((manifest, context) => {
  if (!manifest.skus.every((sku, index) => index === 0 || manifest.skus[index - 1]!.skuId < sku.skuId)
    || !manifest.skus.some(sku => sku.skuId === manifest.product.primarySkuId))
    context.addIssue({ code: "custom", message: "manifest roster must be sorted, unique and contain its primary" });
});
function governedSchema<T, K extends "definitionDigest" | "optionDigest">(base: z.ZodType<T>, key: K) {
  return z.object({ schemaVersion: z.literal(3), lifecycleState: z.enum(["draft", "active", "withdrawn", "archived"]) }).passthrough().superRefine((value, context) => {
    const { schemaVersion: _version, lifecycleState, ...old } = value;
    const selectedDigest = old[key]; delete old[key];
    if (!digest.safeParse(selectedDigest).success || !base.safeParse(old).success || old.status !== catalogLifecycleProjectionV2(lifecycleState)
      || lifecycleState !== "active" && (old.sellableStandalone === true || old.sellableInSubscription === true)) context.addIssue({ code: "custom", message: "invalid authoritative lifecycle facts" });
  }) as unknown as z.ZodType<T & { schemaVersion: 3; lifecycleState: import("./contracts/lifecycleV2.js").CatalogLifecycleStateV2 } & Record<K, string>>;
}
export const catalogProductStateSchema: z.ZodType<CatalogProductState> = z.union([catalogPublishedProductSchema, governedSchema(catalogPublishedProductSchema, "definitionDigest")]);
export const catalogSkuStateSchema: z.ZodType<CatalogSkuState> = z.union([catalogPublishedSkuSchema, governedSchema(catalogPublishedSkuSchema, "optionDigest")]);
export const catalogPublicationStateSchema = z.union([catalogPublicationManifestSchema, z.object({ schemaVersion: z.literal(3), product: governedSchema(catalogPublishedProductSchema, "definitionDigest"), skus: z.array(z.object({ skuId: id, revisionId: id, revision, digest }).strict()) }).strict().refine(value => value.skus.every((sku, index) => index === 0 || value.skus[index - 1]!.skuId < sku.skuId) && value.skus.some(sku => sku.skuId === value.product.primarySkuId))]);
export interface CatalogPublicationDocument {
  reference: z.infer<typeof catalogDocumentRevisionRefSchema>; canonicalText: string;
  provenance: { draftId: string; draftRevision: number; draftCommandKey: string; draftFingerprint: string };
}
export interface CatalogPublicationRules {
  /** Installed code only. Validate/canonicalize opaque documents, presentations, vocabularies and full affected-set facts. */
  validateProduct(product: CatalogProductState, skus: readonly CatalogSkuState[], documents: readonly CatalogPublicationDocument[]): readonly string[];
  canonicalizeDocument(document: unknown): string;
  deriveSkuFacts(document: unknown, sku: CatalogSkuState): CatalogPublicationFacts;
  classifySkuChange(before: CatalogSkuState, after: CatalogSkuState, context: {
    beforeProduct: CatalogProductState; afterProduct: CatalogProductState;
    beforeDocument: CatalogPublicationDocument | null; afterDocument: CatalogPublicationDocument;
  }): "compatible" | "material" | "inconclusive";
}
export interface CatalogPublicationCompileInput {
  payload: CatalogDraftPayloadV3 | CatalogDraftPayloadV4; record: CatalogDraftPublicationStoredRecord; definition: CatalogProductTypeDefinition;
  product: CatalogProductState | null; skus: readonly CatalogSkuState[]; documents: readonly CatalogPublicationDocument[];
  retainedSources: readonly CatalogDraftPublicationStoredRecord[]; rules: CatalogPublicationRules; capacity?: number;
}
export function catalogPublicationClaim(record: CatalogDraftPublicationStoredRecord): CatalogDraftClaimV3 {
  return { draftId: record.draftId, revision: record.revision, commandKey: record.commandKey, fingerprint: record.fingerprint };
}
const equal = (a: unknown, b: unknown): boolean => publicationJson(a) === publicationJson(b);
const need = (condition: unknown, reason: string): void => { if (!condition) publicationRefuse(reason); };
const authoredSlug = z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9_-]*$/u);
/** Temporary native publication boundary, until versioned quantity readers land. */
export function catalogPublicationIntegralGrams(quantity: CatalogQuantity, definition: CatalogProductTypeDefinition, kind: "net" | "gross"): string {
  const reason = "catalog_publication_integral_grams_required";
  try {
    const units = definition.units.flatMap(unit => {
      const known = CATALOG_QUANTITY_UNITS.find(value => value.code === unit.code);
      return known ? [known] : unit.factor ? [{ ...unit, factor: unit.factor }] : [];
    });
    const value = canonicalizeCatalogQuantity(parseCatalogQuantity(quantity, units), units);
    const divisor = 10n ** BigInt(value.scale), unscaled = BigInt(value.unscaled);
    need(value.dimension === "mass" && value.unit === "openlup:g" && unscaled > 0n && unscaled % divisor === 0n, reason);
    const grams = unscaled / divisor, maximum = kind === "net" ? 2_147_483_647n : 10n ** 40n - 1n;
    need(grams <= maximum, reason);
    return grams.toString();
  } catch { return publicationRefuse(reason); }
}
export function assertCatalogPublicationMassInputs(payload: unknown, definition: CatalogProductTypeDefinition): void {
  const header = z.object({ skus: z.array(z.object({ netContent: z.unknown().optional(), grossMass: z.unknown().optional() })) }).safeParse(payload);
  if (!header.success) return;
  for (const sku of header.data.skus) for (const [kind, value] of [["net", sku.netContent], ["gross", sku.grossMass]] as const) {
    if (value && typeof value === "object" && "dimension" in value && value.dimension === "mass")
      catalogPublicationIntegralGrams(value as CatalogQuantity, definition, kind);
  }
}
/** Hard preparation guard, independent of dark/activation readiness. */
export function assertCatalogPublicationPreparation(payload: CatalogDraftPayloadV3 | CatalogDraftPayloadV4): void {
  need(authoredSlug.safeParse(payload.product.slug).success, "commerce_product_slug_unsupported");
  for (const sku of payload.skus) need(sku.identifiers?.some(identifier => identifier.scheme === "gs1:gtin"
    && identifier.packagingLevel === "unit" && isValidGtin(identifier.value)), "unit_trade_identifier_missing");
}
/** Exact scaled comparison after owner-defined conversion, with no rounding or Number arithmetic. */
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
/** Ordered publication compiler using installed definitions; never persists or calls commerce. */
export function compileCatalogPublication(input: CatalogPublicationCompileInput): { product: CatalogProductState; skus: CatalogSkuState[]; documents: CatalogPublicationDocument[]; activation: boolean; changed: boolean } {
  canonicalCatalogDraftJson(input.payload);
  // Check the temporary numeric domain before strict positive-quantity decoding,
  // so zero, negative, fractional and overflow all have the same stable refusal.
  assertCatalogPublicationMassInputs(input.payload, input.definition);
  const governed = input.payload.schemaVersion === 4;
  const payload = governed ? catalogDraftPayloadV4Schema.parse(input.payload) : catalogDraftPayloadV3Schema.parse(input.payload);
  if (governed && input.product) catalogAuthoritativeLifecycleV2(input.product);
  if (!governed && (input.product && "lifecycleState" in input.product || input.skus.some(sku => "lifecycleState" in sku))) publicationRefuse("catalog_lifecycle_raw_status_fenced");
  assertCatalogPublicationPreparation(payload);
  need(input.skus.length === 0 || input.product !== null, "catalog_publication_source_invalid");
  need(input.skus.every(sku => sku.productId === payload.product.id), "catalog_publication_scope_expansion");
  const claim = catalogPublicationClaim(input.record), slug = payload.product.slug!;
  let product = input.product === null ? null : structuredClone(input.product);
  function materialState(product: CatalogProductState | null, rows: readonly CatalogSkuState[]) {
    const p = product && (({ source: _source, content: _content, ...facts }) => facts)(product);
    return { product: p, skus: [...rows].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map(sku => ({ id: sku.id,
      digest: publicationDigest((({ source: _source, ...facts }) => facts)(sku), CATALOG_PUBLICATION_LIMITS.skuBytes) })) };
  }
  const original = publicationJson(materialState(product, input.skus));
  const skus = new Map(input.skus.map(sku => [sku.code, structuredClone(sku)]));
  const documents = input.documents.map(document => structuredClone(document));
  const sources = [input.record, ...input.retainedSources];
  const created = new Set<string>(), identities = new Set<string>();
  const incoming = new Map(payload.skus.map(sku => [sku.code, sku]));
  const gtins = new Set(input.skus.flatMap(sku => sku.identifiers.filter(identifier => identifier.scheme === "gs1:gtin").map(identifier => identifier.value.padStart(14, "0"))));
  need(input.record.productId === payload.product.id && input.record.status === "open" && input.record.payload.schemaVersion >= 3, "catalog_publication_source_invalid");
  if (product) need(product.id === payload.product.id && product.slug === slug && equal(product.type, payload.product.type), "catalog_publication_product_identity_conflict");
  need((payload.product.sharedContent.catalogAction === "create") === (product === null), "catalog_action_conflict");
  function knownProduct(): CatalogProductState { return product ?? publicationRefuse("catalog_publication_v3_compile_product_absent"); }
  function knownSku(code: string): CatalogSkuState { return skus.get(code) ?? publicationRefuse("catalog_publication_v3_compile_sku_absent"); }
  function documentAt(no: number): CatalogPublicationDocument { return documents.find(document => document.reference.revisionNo === no) ?? publicationRefuse("catalog_publication_v3_compile_document_absent"); }
  function currentDocument(): CatalogPublicationDocument { return documents.find(document => document.reference.id === knownProduct().document?.id) ?? publicationRefuse("catalog_publication_v3_compile_document_absent"); }
  function sourceSku(code: string) {
    const applicable = sources.filter(source => source.productId === payload.product.id && source.payload.schemaVersion >= 3 && source.payload.skus.some(sku => sku.code === code));
    const current = applicable.find(source => source.draftId === input.record.draftId && source.revision === input.record.revision);
    const declared = applicable.filter(source => payload.publication.evidence.drafts?.some(claim => equal(claim, catalogPublicationClaim(source))));
    need(current || declared.length <= 1, "catalog_publication_operation_source_ambiguous");
    const retainedClaim = input.skus.find(sku => sku.code === code)?.source;
    const retained = applicable.find(source => retainedClaim && equal(catalogPublicationClaim(source), retainedClaim));
    const source = current ?? declared[0] ?? retained;
    if (!source || source.payload.schemaVersion < 3) return publicationRefuse("catalog_publication_operation_source_missing");
    return { source, payload: source.payload as CatalogDraftPayloadV3 | CatalogDraftPayloadV4, sku: (source.payload as CatalogDraftPayloadV3 | CatalogDraftPayloadV4).skus.find(sku => sku.code === code)! };
  }
  let activation = false;
  let lastChildWithdrawn = false;
  for (const operation of payload.publication.operations) {
    if ("productSlug" in operation) need(operation.productSlug === slug, "catalog_publication_scope_expansion");
    if (operation.op === "create_product") {
      need(product === null && operation.productId === payload.product.id, "catalog_publication_v3_compile_product_conflict");
      product = { id: operation.productId, slug, name: operation.name, status: "draft", type: payload.product.type,
        axes: [...payload.product.dimensions], attributes: payload.product.attributes ?? {}, primarySkuId: null, document: null,
        presentation: null, source: claim, content: payload.product.sharedContent, ...(governed ? { schemaVersion: 3 as const, lifecycleState: "draft" as const, definitionDigest: catalogDefinitionDigest(input.definition) } : {}) };
    } else if (operation.op === "register_document_revision") {
      knownProduct();
      const provenance = resolveCatalogLifecycleProvenance(operation.provenance, input.record);
      const source = sources.find(source => source.draftId === provenance.draftId && source.revision === provenance.draftRevision
        && source.commandKey === provenance.draftCommandKey && source.fingerprint === provenance.draftFingerprint);
      need(source && source.payload.schemaVersion >= 3 && source.productId === payload.product.id, "catalog_publication_document_source_missing");
      const sourcePayload = source!.payload as CatalogDraftPayloadV3 | CatalogDraftPayloadV4, reference = sourcePayload.product.documentRevision;
      need(reference && reference.id === operation.revisionId && reference.revisionNo === operation.revisionNo
        && reference.documentRef === operation.documentRef && reference.sourceRef === operation.sourceRef && reference.digest === operation.digest,
      "catalog_publication_document_source_mismatch");
      let document: unknown;
      try { document = JSON.parse(operation.canonicalText); } catch { publicationRefuse("catalog_publication_v3_document_invalid"); }
      need(input.rules.canonicalizeDocument(document) === operation.canonicalText
        && createHash("sha256").update(operation.canonicalText).digest("hex") === operation.digest
        && equal(document, sourcePayload.product.sharedContent.document), "catalog_publication_v3_document_invalid");
      const registered: CatalogPublicationDocument = { reference: reference!, canonicalText: operation.canonicalText, provenance };
      const prior = documents.find(document => document.reference.id === operation.revisionId || document.reference.revisionNo === operation.revisionNo);
      if (prior) need(equal(prior, registered), "catalog_publication_v3_compile_document_conflict");
      else {
        need(operation.revisionNo === Math.max(0, ...documents.map(document => document.reference.revisionNo)) + 1, "catalog_publication_document_revision_sequence");
        documents.push(registered);
      }
    } else if (operation.op === "move_document_pointer") {
      const document = documentAt(operation.documentRevisionNo);
      need(document.reference.productId === knownProduct().id && payload.product.documentRevision?.id === document.reference.id, "catalog_publication_document_source_mismatch");
      knownProduct().document = document.reference;
    } else if (operation.op === "create_sku") {
      need(!skus.has(operation.skuCode) && ![...skus.values()].some(sku => sku.id === operation.skuId), "catalog_publication_v3_compile_sku_conflict");
      const source = sourceSku(operation.skuCode), authored = source.payload.product.sharedContent.publicationSkus.find(sku => sku.skuCode === operation.skuCode);
      need(source.sku.id === operation.skuId && authored && equal(authored, {
        skuCode: operation.skuCode, title: operation.title, minQuantity: operation.minQuantity, isAddon: operation.isAddon, facts: operation.facts,
      }), "catalog_publication_operation_source_mismatch");
      need(source.sku.netContent?.dimension === "mass", "catalog_publication_mass_required_until_mc5");
      need(knownProduct().document?.revisionNo === operation.documentRevisionNo, "catalog_publication_v3_compile_document_stale");
      const sku: CatalogSkuState = { id: operation.skuId, productId: knownProduct().id, code: operation.skuCode, title: operation.title,
        status: "draft", minQuantity: operation.minQuantity, isAddon: operation.isAddon, sellableStandalone: false, sellableInSubscription: false,
        netContent: source.sku.netContent!, grossMass: source.sku.grossMass ?? null, options: source.sku.options, attributes: source.sku.attributes ?? {},
        facts: operation.facts, identifiers: [], assetRefs: source.sku.assetRefs ?? [], logisticsRef: null, memberships: [], source: catalogPublicationClaim(source.source), ...(governed ? { schemaVersion: 3 as const, lifecycleState: "draft" as const, optionDigest: Buffer.from(canonicalizeCatalogCombinationV2({ definition: input.definition, axes: knownProduct().axes, options: source.sku.options }).combinationDigest).toString("hex") } : {}) };
      need(equal(input.rules.deriveSkuFacts(JSON.parse(currentDocument().canonicalText), sku), sku.facts), "catalog_publication_v3_compile_derived_facts_mismatch");
      skus.set(sku.code, sku); created.add(sku.code);
    } else if (operation.op === "create_identifier") {
      const sku = knownSku(operation.skuCode), source = sourceSku(operation.skuCode);
      need(created.has(sku.code), "catalog_publication_identifier_requires_created_sku");
      need(source.sku.identifiers?.some(identifier => identifier.scheme === operation.scheme && identifier.issuer === operation.issuer
        && identifier.value === operation.value && identifier.packagingLevel === operation.packagingLevel && (identifier.quantity ?? 1) === operation.quantity), "catalog_publication_identifier_source_mismatch");
      const { op: _op, skuCode: _code, ...identifier } = operation;
      if (identifier.scheme === "gs1:gtin") {
        need(isValidGtin(identifier.value) && !gtins.has(identifier.value.padStart(14, "0")), "catalog_publication_v3_compile_identifier_conflict");
        gtins.add(identifier.value.padStart(14, "0"));
      }
      need(!identifier.isPrimary || identifier.scheme === "gs1:gtin" && identifier.packagingLevel === "unit" && !sku.identifiers.some(value => value.isPrimary), "catalog_publication_identifier_primary_invalid");
      sku.identifiers.push(identifier);
    } else if (operation.op === "set_primary_sku") {
      const sku = knownSku(operation.skuCode);
      need(sku.productId === knownProduct().id && payload.product.primarySkuId === sku.id, "catalog_publication_v3_compile_primary_foreign");
      need(knownProduct().primarySkuId === null || knownProduct().primarySkuId === sku.id, "catalog_publication_v3_compile_primary_immutable");
      need(sku.status !== "archived", "catalog_publication_v3_compile_sku_archived");
      knownProduct().primarySkuId = sku.id;
    } else if (operation.op === "set_product_lifecycle" || operation.op === "restore_product") {
      const row = knownProduct(), before = catalogAuthoritativeLifecycleV2(row);
      const restored = operation.op === "restore_product", after = restored ? "active" : operation.state;
      need(before === operation.expectedState, "catalog_lifecycle_state_conflict");
      need(catalogLifecycleTransitionV2(before, after, restored), "catalog_lifecycle_transition_refused");
      if (after === "active") need(row.document !== null && row.primarySkuId !== null, "catalog_publication_v3_compile_product_incomplete");
      if (!restored && after === "withdrawn") {
        const children = [...skus.values()].sort((a, b) => a.code < b.code ? -1 : a.code > b.code ? 1 : 0);
        need(equal(operation.children, children.map(child => ({ skuCode: child.code, expectedState: catalogAuthoritativeLifecycleV2(child) }))), "catalog_lifecycle_child_effects_mismatch");
        for (const child of children) {
          child.sellableStandalone = false; child.sellableInSubscription = false;
          if (catalogAuthoritativeLifecycleV2(child) === "active") Object.assign(child, { lifecycleState: "withdrawn" });
        }
      } else if (!restored) need(operation.children.length === 0, "catalog_lifecycle_child_effects_mismatch");
      Object.assign(row, { lifecycleState: after, status: catalogLifecycleProjectionV2(after) });
      activation ||= restored;
    } else if (operation.op === "set_sku_lifecycle" || operation.op === "restore_sku") {
      const sku = knownSku(operation.skuCode), before = catalogAuthoritativeLifecycleV2(sku);
      const restored = operation.op === "restore_sku", after = restored ? "active" : operation.state;
      need(before === operation.expectedState, "catalog_lifecycle_state_conflict");
      need(catalogLifecycleTransitionV2(before, after, restored), "catalog_lifecycle_transition_refused");
      if (after === "archived") need(!sku.sellableStandalone && !sku.sellableInSubscription && knownProduct().primarySkuId !== sku.id, "catalog_publication_v3_compile_archive_refused");
      if (after === "withdrawn") {
        sku.sellableStandalone = false; sku.sellableInSubscription = false;
        lastChildWithdrawn ||= ![...skus.values()].some(other => other.id !== sku.id && catalogAuthoritativeLifecycleV2(other) === "active");
      }
      Object.assign(sku, { lifecycleState: after, status: catalogLifecycleProjectionV2(after) });
      activation ||= restored;
    } else if (operation.op === "set_product_status") {
      if (operation.status === "active") need(knownProduct().document !== null && knownProduct().primarySkuId !== null, "catalog_publication_v3_compile_product_incomplete");
      knownProduct().status = operation.status;
    } else if (operation.op === "set_eligibility") {
      const sku = knownSku(operation.skuCode), source = sourceSku(sku.code);
      const modes = source.payload.product.sharedContent.requestedModes.find(value => value.skuCode === sku.code)?.modes;
      need(modes && operation.sellableStandalone === modes.includes("one_time") && operation.sellableInSubscription === modes.includes("subscription"), "catalog_publication_eligibility_source_mismatch");
      const on = operation.sellableStandalone || operation.sellableInSubscription;
      need(!on || sku.status !== "archived" && !input.skus.some(value => value.id === sku.id && value.status === "archived"), "catalog_publication_v3_compile_sku_archived");
      if (governed && on) need(catalogAuthoritativeLifecycleV2(sku) === "active" && catalogAuthoritativeLifecycleV2(knownProduct()) === "active", "catalog_lifecycle_fresh_sale_refused");
      activation ||= on;
      sku.sellableStandalone = operation.sellableStandalone; sku.sellableInSubscription = operation.sellableInSubscription;
    } else if (operation.op === "set_sku_status") {
      const sku = knownSku(operation.skuCode);
      if (operation.status === "archived") need(!sku.sellableStandalone && !sku.sellableInSubscription && knownProduct().primarySkuId !== sku.id, "catalog_publication_v3_compile_archive_refused");
      else need(payload.publication.operations.some(other => other.op === "set_eligibility" && other.skuCode === sku.code
        && (other.sellableStandalone || other.sellableInSubscription)), "catalog_publication_activation_requires_explicit_eligibility");
      sku.status = operation.status;
    } else if (operation.op === "set_offer_membership") {
      const sku = knownSku(operation.skuCode), source = sourceSku(sku.code);
      need(source.payload.product.sharedContent.offerMemberships.some(row => equal(row, { skuCode: sku.code, offerVersion: operation.offerVersion, admitted: operation.admitted })), "catalog_publication_membership_source_mismatch");
      const index = sku.memberships.findIndex(value => value.offerVersion === operation.offerVersion);
      const row = { offerVersion: operation.offerVersion, admitted: operation.admitted };
      if (index < 0) sku.memberships.push(row); else sku.memberships[index] = row;
      sku.memberships.sort((a, b) => a.offerVersion < b.offerVersion ? -1 : a.offerVersion > b.offerVersion ? 1 : 0);
    } else if (operation.op === "set_product_presentation") {
      need(equal(operation.presentation, payload.product.sharedContent.presentation), "catalog_publication_presentation_source_mismatch");
      knownProduct().presentation = operation.presentation;
    } else if (operation.op === "set_sku_metadata") {
      const sku = knownSku(operation.skuCode), source = sourceSku(sku.code);
      need(operation.logisticsRef === (source.sku.logisticsRef ?? null), "catalog_publication_logistics_source_mismatch");
      sku.logisticsRef = operation.logisticsRef;
    } else if (operation.op === "set_derived_sku_facts") {
      const sku = knownSku(operation.skuCode);
      need(equal(operation.netContent, sku.netContent) && knownProduct().document?.revisionNo === operation.documentRevisionNo,
        "catalog_publication_derived_source_mismatch");
      need(equal(input.rules.deriveSkuFacts(JSON.parse(currentDocument().canonicalText), sku), operation.facts), "catalog_publication_v3_compile_derived_facts_mismatch");
      sku.facts = operation.facts;
    } else { const _exhaustive: never = operation; publicationRefuse("catalog_publication_operation_invalid"); }
  }
  const result = knownProduct();
  if (lastChildWithdrawn) need(governed && catalogAuthoritativeLifecycleV2(result) === "withdrawn" && payload.publication.operations.some(op => op.op === "set_product_lifecycle" && op.state === "withdrawn"), "catalog_lifecycle_last_active_child");

  if (payload.product.documentRevision) need(equal(payload.product.documentRevision, result.document), "catalog_publication_document_source_mismatch");
  if (payload.product.sharedContent.document !== undefined) need(equal(payload.product.sharedContent.document, JSON.parse(currentDocument().canonicalText)),
    "catalog_publication_document_source_mismatch");
  result.attributes = payload.product.attributes ?? result.attributes; result.axes = [...payload.product.dimensions];
  result.content = payload.product.sharedContent; result.source = claim;
  const productPhysicalChange = input.product !== null && !equal(
    [input.product.type, input.product.axes, input.product.attributes, input.product.document],
    [result.type, result.axes, result.attributes, result.document]);
  for (const sku of skus.values()) {
    const draft = incoming.get(sku.code);
    if (draft && !created.has(sku.code)) {
      need(draft.id === sku.id && draft.productId === sku.productId && equal(draft.netContent, sku.netContent)
        && equal(draft.options, sku.options), "sku_identity_change_requires_new_sku");
      const after = { ...sku, attributes: draft.attributes ?? sku.attributes, grossMass: draft.grossMass ?? sku.grossMass, assetRefs: draft.assetRefs ?? sku.assetRefs };
      Object.assign(sku, after);
    }
    const before = input.skus.find(before => before.id === sku.id);
    if (before && (productPhysicalChange || !equal(
      [before.netContent, before.options, before.attributes, before.facts, before.grossMass, before.assetRefs],
      [sku.netContent, sku.options, sku.attributes, sku.facts, sku.grossMass, sku.assetRefs]))) {
      need(input.rules.classifySkuChange(before, sku, { beforeProduct: input.product!, afterProduct: result,
        beforeDocument: input.documents.find(document => document.reference.id === input.product!.document?.id) ?? null,
        afterDocument: currentDocument() }) === "compatible", "sku_identity_change_requires_new_sku");
    }
    need(sku.netContent.dimension === "mass", "catalog_publication_mass_required_until_mc5");
    catalogPublicationIntegralGrams(sku.netContent, input.definition, "net");
    if (sku.grossMass) catalogPublicationIntegralGrams(sku.grossMass, input.definition, "gross");
    need(equal(input.rules.deriveSkuFacts(JSON.parse(currentDocument().canonicalText), sku), sku.facts),
      "catalog_publication_v3_compile_derived_facts_mismatch");
    if (sku.sellableStandalone || sku.sellableInSubscription) {
      need(sku.status !== "archived" && result.status !== "archived", "catalog_publication_v3_compile_sku_archived");
      assertCatalogPublicationGrossMass(sku.netContent, sku.grossMass, input.definition);
      need(sku.identifiers.some(identifier => identifier.scheme === "gs1:gtin" && identifier.isPrimary && identifier.packagingLevel === "unit")
        && sku.logisticsRef && sku.memberships.some(row => row.admitted), "catalog_publication_v3_activation_readiness_failed");
    }
    const identity = canonicalizeCatalogCombinationV2({ definition: input.definition, axes: result.axes, options: sku.options });
    const key = Buffer.from(identity.combinationDigest).toString("hex");
    if ("schemaVersion" in sku) need(sku.optionDigest === key, "sku_identity_change_requires_new_sku");
    if (sku.status === "active") { need(!identities.has(key), "duplicate_combination"); identities.add(key); }
    publicationJson(catalogSkuStateSchema.parse(sku), CATALOG_PUBLICATION_LIMITS.skuBytes);
  }
  need(skus.size <= (input.capacity ?? 50_000), "product_capacity_exceeded");
  need(result.primarySkuId && result.document && result.presentation, "catalog_publication_v3_structural_readiness_failed");
  const primary = [...skus.values()].find(sku => sku.id === result.primarySkuId);
  need(primary && primary.status !== "archived", "catalog_publication_v3_compile_primary_foreign");
  const issues = input.rules.validateProduct(result, [...skus.values()], documents);
  need(issues.length === 0, "catalog_publication_adopter_validation_failed");
  const sorted = [...skus.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const changed = original !== publicationJson(materialState(result, sorted));
  for (const sku of sorted) {
    const before = input.skus.find(row => row.id === sku.id);
    // An omitted derived cache effect has this publication's draft/receipt as
    // its effect provenance. Keep the retained physical/media source available.
    if (before && incoming.has(sku.code) && !equal(before, sku)) sku.source = claim;
  }
  if (!changed && input.product) { result.source = input.product.source; result.content = input.product.content; }
  need(changed || payload.publication.kind === "compensation" && payload.publication.operations.length > 0, "catalog_publication_v3_compile_change_noop");
  return { product: result, skus: sorted, documents, activation, changed };
}
