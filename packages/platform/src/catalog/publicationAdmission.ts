import { createHash } from "node:crypto";
import { z } from "./validation.js";
import { canonicalCatalogDraftJson } from "./contracts/draft.js";
import { catalogDocumentRevisionRefSchema } from "./foundationSchemas.js";
import { canonicalizeCatalogCombinationV2 } from "./variantCombination.js";
import type { CatalogDraftIssue, CatalogProductTypeDefinition } from "./contracts/productTypes.js";
import type { CatalogDraftClaimV3, CatalogDraftMediaClaimV3, CatalogDraftPayloadV3, CatalogPublicationFacts } from "./contracts/draftV3.js";
import type { CatalogPublishedProduct, CatalogPublishedSku } from "./publicationContracts.js";
import { CATALOG_PUBLICATION_LIMITS } from "./publicationContracts.js";
import { adopterIssue, CatalogPublicationError, publicationIssue, publicationRefuse,
  type EvaluationIssue, type Issue, type PlatformCode } from "./publicationError.js";
import { assertPublishedFacts, assertPublishedPresentation, assertPublicationRegistration,
  catalogPublishedProductSchema, catalogPublishedSkuSchema, publicationContent,
  publicationDigest, publicationJson, publicationReadinessVerdict } from "./publicationCodec.js";
import { resolvePublicationRules } from "./publicationRules.js";
import type { CatalogRulesContext } from "./catalogPublicationRules.js";
import { validateDraftV2Issues } from "./draftV2Validation.js";
import type { CatalogAttributeReferencePort } from "./attributeReferencePort.js";
import type { CatalogDraftPayloadV2 } from "./contracts/draftV2.js";
import { catalogDefinitionDigest } from "./catalogDefinitionDigest.js";
import type { CatalogHeadRef } from "./contracts/lifecycle.js";
import { matchesPublicationHead, publicationHeadSchema, type ExpectedPublicationHead, type CatalogPublicationEvidence,
  type CatalogPublicationDocument, type CatalogCandidatePublicationDeps } from "./publicationEvidence.js";
import { publicationIntent, lifecycleEvidenceSchema, lifecycleWithdrawalOnly,
  type PublicationDraftRecord, type PublicationOperation } from "./publicationIntent.js";
import {
  assertCatalogAction, assertMaterializedSkuSource, catalogPublicationClaim, checkedDocument,
  equal, matchesAuthoredDocument, need, normalizeIdentifierValue, prefixSku,
} from "./publicationOperationHelpers.js";
import {
  assertCatalogPublicationMassInputs, catalogPublicationAffected,
  preparationIssues, unresolvedPublicationDraftIssues,
} from "./publicationPreparation.js";
import { boundDrafts, documentProvenance, publicationAuthorship } from "./publicationAuthorship.js";

export interface CatalogPublicationCompileInput {
  record: PublicationDraftRecord;
  definition: CatalogProductTypeDefinition;
  installedDefinitionDigest: string;
  expectedHead: CatalogHeadRef | null;
  /** A facade can resolve the full expected head after admission. */
  readCurrentHead?: () => Promise<{ head: CatalogHeadRef | null | undefined; unavailable: boolean; expectedHead?: CatalogHeadRef | undefined }>;
  evidence?: CatalogPublicationEvidence | null;
  evaluation?: CatalogRulesContext;
  attributeReferences?: CatalogAttributeReferencePort | undefined;
  validatePrices?: ((payload: CatalogDraftPayloadV2) => Promise<readonly CatalogDraftIssue[]>) | undefined;
  capacity?: number;
  observations?: Partial<Pick<CatalogCandidatePublicationDeps, "readEvidence" | "presentationReadiness" | "verifyMedia" | "assessActivation">> | undefined;
}

export type CatalogPublicationEvaluateInput = Omit<CatalogPublicationCompileInput, "expectedHead"> & {
  expectedHead: ExpectedPublicationHead | null;
};

export type PublicationMode = "preview" | "first-decision" | "compile";
export type PublicationPhase = "structural" | "activation";
export type DocumentRef = CatalogPublicationDocument["reference"];
export type LifecycleEvidenceState = z.infer<typeof lifecycleEvidenceSchema>;

export interface PublicationPosition {
  phase: PublicationPhase;
  path: string;
  subject: string;
}

export interface PublicationPendingIssue {
  path: string;
  code: PlatformCode;
  channel?: "one_time" | "subscription";
}

export interface PublicationEvaluationRuntime {
  input: CatalogPublicationEvaluateInput;
  mode: PublicationMode;
  attributeReferences: CatalogAttributeReferencePort | undefined;
  structural: EvaluationIssue[];
  activationIssues: EvaluationIssue[];
  issuesByPhase: { structural: EvaluationIssue[]; activation: EvaluationIssue[] };
  position: PublicationPosition;
  missing: (code: PlatformCode, path: string) => EvaluationIssue;
  completed: { structural: boolean; activation: boolean };
  knownHead: CatalogHeadRef | null | undefined;
  activating: boolean;
  pending: PublicationPendingIssue[];
}

export const unavailable = (diagnostic: Issue): EvaluationIssue => ({ diagnostic, outcome: "dependency_unavailable" });
export const isUnavailable = (issue: EvaluationIssue): boolean => issue.outcome === "dependency_unavailable";

// Capture independent writable views at each phase boundary. Installed rule hooks
// already exchange private JSON through their dispatcher.
export const snapshot = <Views extends unknown[]>(...views: Views): Views =>
  views.map(view => structuredClone(view)) as Views;

export async function observe<T>(read: () => Promise<T | undefined>): Promise<T | undefined> {
  try { return await read(); } catch (error) {
    if (error instanceof CatalogPublicationError && (error.stored
      || error.diagnostic.kind === "platform" && error.diagnostic.code === "catalog_publication_route_conflict")) throw error;
    return undefined;
  }
}

export function materialState(product: CatalogPublishedProduct | null, rows: readonly CatalogPublishedSku[]) {
  const p = product && (({ source: _source, content: _content, ...facts }) => facts)(product);
  return {
    product: p,
    skus: [...rows].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map(sku => ({
      id: sku.id,
      digest: publicationDigest((({ source: _source, ...facts }) => facts)(sku), CATALOG_PUBLICATION_LIMITS.skuBytes),
    })),
  };
}

export async function admitPublication(runtime: PublicationEvaluationRuntime) {
  const { input, mode, position, attributeReferences } = runtime;
  const { definition } = input;
  position.path = "product.type";
  need(input.installedDefinitionDigest === catalogDefinitionDigest(definition), "catalog_definition_drift");
  const rules = resolvePublicationRules(definition, input.evaluation ?? { evaluatedAt: input.record.createdAt }, mode !== "preview");
  position.path = "product";
  need(input.record.payload?.schemaVersion === 3 || input.record.payload?.schemaVersion === 4, "catalog_publication_source_invalid");
  let canonicalPayload: string;
  try { canonicalPayload = canonicalCatalogDraftJson(input.record.payload); }
  catch { return publicationRefuse("candidate_invalid"); }
  const [record] = snapshot(input.record);
  // Check the temporary numeric domain before strict positive-quantity decoding,
  // so zero, negative, fractional and overflow all have the same stable refusal.
  assertCatalogPublicationMassInputs(record.payload, definition);
  const intent = publicationIntent(record.payload, (path, unsupportedKey, fix) => {
    const code = "candidate_invalid";
    const message = fix ?? (unsupportedKey ? "Remove the unsupported field at this path, then prepare the draft again."
      : path.endsWith(".op") ? "Use a supported publication operation at this path, then prepare the draft again."
        : "Correct the draft value at this path, then prepare the draft again.");
    throw new CatalogPublicationError({ ...publicationIssue(code, "structural", path, definition.key), detail: message });
  });
  if (!intent) return publicationRefuse("candidate_invalid");
  const payload = intent;
  const governedIntent = payload.schemaVersion === 4;
  const withdrawalOnly = governedIntent && lifecycleWithdrawalOnly(payload);
  need(equal(payload.product.type, { key: definition.key, version: definition.version }), "catalog_definition_drift");
  const contextualIssue = (issue: Issue, skus: readonly { code?: string }[] = payload.skus): Issue => ({
    ...issue, phase: "structural",
    subject: skus[Number(/^(?:skus\.|\/skus\/)(\d+)/u.exec(issue.path)?.[1])]?.code ?? definition.key,
  });
  const authoredIssues = preparationIssues(payload, { definition, rules: withdrawalOnly ? {} : rules ?? {} });
  if (authoredIssues.length) {
    const { code, path } = authoredIssues[0]!;
    throw new CatalogPublicationError(contextualIssue(publicationIssue(code, undefined, path)));
  }
  position.path = "product.sharedContent.presentation";
  const content = publicationContent(payload.product.sharedContent, definition.key, payload.product.documentRevision?.digest);
  for (const [index, operation] of payload.publication.operations.entries()) {
    position.path = `publication.operations.${index}`;
    position.subject = "skuCode" in operation ? operation.skuCode : definition.key;
    if (operation.op === "set_product_presentation")
      assertPublishedPresentation(operation.presentation, `${position.path}.presentation`, position.subject);
    if (operation.op === "create_sku" || operation.op === "set_derived_sku_facts")
      assertPublishedFacts(operation.facts, `${position.path}.facts`, position.subject);
    if (operation.op === "create_identifier")
      need(!operation.isPrimary || operation.scheme === "gs1:gtin", "catalog_publication_identifier_primary_invalid");
    if (operation.op === "register_document_revision") {
      need(createHash("sha256").update(operation.canonicalText).digest("hex") === operation.digest,
        "catalog_publication_v3_document_digest_mismatch");
      assertPublicationRegistration(operation.canonicalText, `${position.path}.canonicalText`);
    }
  }
  position.subject = definition.key;
  const { publication: _publication, ...base } = payload;
  const validationPayload: CatalogDraftPayloadV2 = { ...base, schemaVersion: 2 };
  position.path = "product.sharedContent";
  const validation = await validateDraftV2Issues(validationPayload, { resolve: () => ({ ...definition,
    validateContent: !withdrawalOnly && rules ? rules.validateContent : () => [] }) }, attributeReferences);
  const draftIssues = validation.valid ? validation.readiness.publication.issues : validation.issues;
  if (!validation.valid) {
    const refusal = draftIssues.find(issue => issue.kind === "adopterRule" || issue.code !== "attribute_reference_unresolved");
    if (refusal) {
      const diagnostic = contextualIssue(refusal);
      throw new CatalogPublicationError(diagnostic);
    }
  }
  return { record, payload, content, rules, governedIntent, withdrawalOnly, canonicalPayload, contextualIssue, validationPayload, draftIssues };
}

export type AdmittedPublication = Awaited<ReturnType<typeof admitPublication>>;

export interface BoundPublicationContext {
  runtime: PublicationEvaluationRuntime;
  admitted: AdmittedPublication;
  requestedHead: ExpectedPublicationHead | null;
  expectedHead: CatalogHeadRef | null;
  evidence: CatalogPublicationEvidence | null;
  highWaterAvailable: boolean;
  missingProduct: boolean;
  retainedState: {
    product: CatalogPublishedProduct | null;
    skus: CatalogPublishedSku[];
    documents: CatalogPublicationEvidence["documents"];
    documentRevisionHighWater: number;
  };
  governed: boolean;
  lifecycleAvailable: boolean;
  missingLifecycle: (path: string) => EvaluationIssue;
  priceOperations: NonNullable<CatalogDraftPayloadV3["skus"][number]["priceOperations"]>[number][];
  claim: CatalogDraftClaimV3;
  slug: string;
  product: CatalogPublishedProduct | null;
  original: string;
  affected: ReturnType<typeof catalogPublicationAffected>;
  originalById: Map<string, CatalogPublishedSku>;
  skus: Map<string, CatalogPublishedSku>;
  documents: CatalogPublicationDocument[];
  authorship: ReturnType<typeof publicationAuthorship>;
  created: Set<string>;
  identities: Set<string>;
  creations: Map<number, CatalogPublishedSku>;
  existingCombinations: Set<string> | undefined;
  unavailableRegistrations: Set<number>;
  incoming: Map<string | undefined, CatalogDraftPayloadV3["skus"][number]>;
  gtins: Set<string>;
  authoredDocument: NonNullable<CatalogDraftPayloadV3["product"]["documentRevision"]>;
  beforeReference: CatalogPublishedProduct["document"] | undefined;
  operations: PublicationOperation[];
  selectedRegistration: Extract<PublicationOperation, { op: "register_document_revision" }> | undefined;
  documentsById: Map<string, CatalogPublicationDocument>;
  referencesByRevision: Map<number, DocumentRef>;
  referencesById: Map<string, DocumentRef>;
  documentValueDigests: Map<string, string>;
  documentReferencesIncomplete: boolean;
  missingSavedDocumentRevision: boolean;
  media: Map<string, CatalogDraftMediaClaimV3>;
  verifiedMedia: CatalogDraftMediaClaimV3[];
  authoredPresentation: CatalogPublicationFacts;
  savedSources: Map<number, NonNullable<ReturnType<ReturnType<typeof publicationAuthorship>["skuOperation"]>>>;
  savedDocuments: Map<number, CatalogPublicationDocument>;
  activationCodes: Set<string>;
  matchedPhysicalSources: Set<CatalogDraftPayloadV3["skus"][number]>;
  productState: LifecycleEvidenceState["product"] | undefined;
  skuStates: Map<string, LifecycleEvidenceState["skus"][string]>;
  lastChildWithdrawn: boolean;
  pendingEligibility: Map<string, Extract<PublicationOperation, { op: "set_eligibility" }>>;
  highWater: number;
  documentExclusionUnavailable: boolean;
}

export function atOperation(ctx: BoundPublicationContext, index: number, operation: PublicationOperation): void {
  ctx.runtime.position.path = `publication.operations.${index}`;
  ctx.runtime.position.subject = "skuCode" in operation ? operation.skuCode : ctx.runtime.input.definition.key;
}

export function knownProduct(ctx: BoundPublicationContext): CatalogPublishedProduct {
  return ctx.product ?? publicationRefuse("catalog_publication_v3_compile_product_absent");
}

export function knownSku(ctx: BoundPublicationContext, code: string): CatalogPublishedSku {
  return prefixSku(ctx.skus, code);
}

export function combination(ctx: BoundPublicationContext, sku: Pick<CatalogPublishedSku, "code" | "options">): string {
  const { position, input: { definition } } = ctx.runtime;
  const subject = position.subject;
  position.subject = sku.code;
  const digest = canonicalizeCatalogCombinationV2({
    definition, axes: ctx.admitted.payload.product.dimensions, options: sku.options,
  }).combinationDigest;
  position.subject = subject;
  return Buffer.from(digest).toString("hex");
}

export function bindDocumentValue(
  ctx: BoundPublicationContext,
  document: CatalogPublicationDocument,
  authored: unknown,
  mismatch?: PlatformCode,
): void {
  const { rules } = ctx.admitted;
  if (!rules || authored === undefined) return;
  if (matchesAuthoredDocument(authored, document.canonicalText, rules))
    ctx.documentValueDigests.set(document.reference.id, publicationDigest(authored));
  else if (mismatch) publicationRefuse(mismatch);
}

export function addDocumentReference(ctx: BoundPublicationContext, reference: DocumentRef): void {
  ctx.referencesById.set(reference.id, reference);
  ctx.referencesByRevision.set(reference.revisionNo, reference);
}

export function selectedDocument(
  ctx: BoundPublicationContext,
  reference: CatalogPublishedProduct["document"] | undefined,
  needed = !ctx.admitted.withdrawalOnly,
): CatalogPublicationDocument | undefined {
  if (!reference) return;
  const selected = ctx.documentsById.get(reference.id);
  if (!selected && needed && !ctx.runtime.structural.some(issue => issue.diagnostic.kind === "platform" && issue.diagnostic.code === "catalog_publication_document_bytes_unavailable"))
    ctx.runtime.structural.push(ctx.runtime.missing("catalog_publication_document_bytes_unavailable", "product.documentRevision"));
  return selected;
}

export async function readRoute(ctx: BoundPublicationContext, presentation: CatalogPublicationFacts): Promise<void> {
  const { input: { observations }, structural, position, missing } = ctx.runtime;
  const verdict = publicationReadinessVerdict.safeParse(await observe(() =>
    observations?.presentationReadiness?.(ctx.admitted.record.productId, presentation) ?? Promise.resolve(undefined)));
  if (!verdict.success) structural.push(missing("catalog_publication_presentation_unavailable", "product.sharedContent.presentation"));
  else if (!verdict.data.ready) throw new CatalogPublicationError(adopterIssue("presentationReadiness", verdict.data.reasons[0]!, position.path));
}

export function bindPhysicalSource(
  ctx: BoundPublicationContext,
  code: string | undefined,
  source: CatalogDraftPayloadV3["skus"][number],
): void {
  if (ctx.matchedPhysicalSources.has(source)) return;
  const actual = code === undefined ? undefined : ctx.skus.get(code);
  assertMaterializedSkuSource(actual, source);
  ctx.matchedPhysicalSources.add(source);
}

function readDocuments(ctx: BoundPublicationContext): boolean {
  const { position, structural, missing } = ctx.runtime;
  const { payload, rules, withdrawalOnly } = ctx.admitted;
  position.path = "product.documentRevision";
  const current = ctx.product?.document;
  for (const document of ctx.retainedState.documents) {
    const parsed = catalogDocumentRevisionRefSchema.safeParse(document?.reference);
    if (!parsed.success) {
      ctx.documentReferencesIncomplete = true;
      structural.push(missing("catalog_publication_read_invalid", position.path));
      continue;
    }
    const reference = parsed.data;
    need(reference.productId === payload.product.id && (!ctx.highWaterAvailable || reference.revisionNo <= ctx.retainedState.documentRevisionHighWater)
      && !ctx.referencesById.has(reference.id) && !ctx.referencesByRevision.has(reference.revisionNo), "catalog_publication_document_source_mismatch");
    if (current && (current.id === reference.id || current.revisionNo === reference.revisionNo))
      need(equal(current, reference), "catalog_publication_document_source_mismatch");
    addDocumentReference(ctx, reference);
    if (typeof document.canonicalText !== "string" || createHash("sha256").update(document.canonicalText).digest("hex") !== reference.digest) continue;
    if (rules && !withdrawalOnly) {
      try { checkedDocument(document.canonicalText, reference, ctx.slug, rules); }
      catch (error) {
        if (error instanceof CatalogPublicationError && (error.code === "catalog_publication_v3_document_invalid"
          || error.code === "catalog_publication_v3_document_not_canonical")) continue;
        throw error;
      }
    }
    const provenance = documentProvenance.safeParse(document.provenance);
    if (!provenance.success) continue;
    const selected = { canonicalText: document.canonicalText, reference, provenance: provenance.data };
    ctx.documents.push(selected);
    ctx.documentsById.set(reference.id, selected);
    bindDocumentValue(ctx, selected, ctx.authorship.documentValue(selected));
  }
  // Saved revision numbers are unique and bounded by the high-water mark.
  const missingSavedRevision = ctx.referencesByRevision.size < ctx.retainedState.documentRevisionHighWater;
  if (current) addDocumentReference(ctx, current);
  return missingSavedRevision;
}

export async function bindPublicationEvidence(
  runtime: PublicationEvaluationRuntime,
  admitted: AdmittedPublication,
): Promise<BoundPublicationContext> {
  const { input, structural, issuesByPhase, position, missing } = runtime;
  const { record, payload, rules, governedIntent, canonicalPayload, contextualIssue, draftIssues } = admitted;
  const { observations } = input;
  position.path = "publication";
  const [expected] = snapshot(input.expectedHead);
  let lineage: Awaited<ReturnType<NonNullable<typeof input.readCurrentHead>>>;
  try { lineage = await input.readCurrentHead?.() ?? { head: undefined, unavailable: Boolean(input.readCurrentHead) }; }
  catch (error) {
    if (error instanceof CatalogPublicationError && (error.stored || error.outcome !== "dependency_unavailable")) throw error;
    lineage = { head: undefined, unavailable: true };
  }
  const completion = publicationHeadSchema.safeParse(lineage.expectedHead).data;
  if (completion !== undefined && !matchesPublicationHead(expected, completion)) publicationRefuse("head_conflict", "conflict");
  const requestedHead = expected && completion && expected.documentDigest === undefined
    ? { ...expected, documentDigest: completion.documentDigest } : expected;
  const current = lineage.head === null ? null : publicationHeadSchema.safeParse(lineage.head).data;
  if (current !== undefined && !matchesPublicationHead(requestedHead, current)) publicationRefuse("head_conflict", "conflict");
  runtime.knownHead = requestedHead === null ? null : requestedHead.documentDigest === undefined ? current
    : { ...requestedHead, documentDigest: requestedHead.documentDigest };
  const evidenceHead = runtime.knownHead;
  const evidence = await observe(async () => {
    if (input.evidence !== undefined) return snapshot(input.evidence)[0];
    if (evidenceHead === undefined || !observations?.readEvidence) return;
    const [request] = snapshot({
      candidate: catalogPublicationClaim(record), productId: record.productId, expectedHead: evidenceHead,
    });
    return snapshot(await observations.readEvidence(request))[0];
  }) ?? null;
  const head = evidence && publicationHeadSchema.nullable().safeParse(evidence.head);
  const recordedProduct = evidence && catalogPublishedProductSchema.nullable().safeParse(evidence.product);
  const recordedDocuments = Boolean(evidence && Array.isArray(evidence.documents));
  const highWaterAvailable = Boolean(evidence && Number.isSafeInteger(evidence.documentRevisionHighWater) && evidence.documentRevisionHighWater >= 0);
  if (head?.success && !matchesPublicationHead(evidenceHead === undefined ? requestedHead : evidenceHead, head.data)) publicationRefuse("head_conflict", "conflict");
  if (head?.success && runtime.knownHead === undefined) runtime.knownHead = head.data;
  const expectedHead = runtime.knownHead ?? null;
  const retainedSkus = evidence ? z.array(catalogPublishedSkuSchema).safeParse(evidence.skus).data
    : requestedHead === null ? [] : undefined;
  if (!retainedSkus) return publicationRefuse("catalog_publication_read_invalid", "dependency_unavailable");
  if (evidence && (!head?.success || !recordedProduct?.success || !recordedDocuments || !highWaterAvailable))
    structural.push(missing("catalog_publication_read_invalid", "publication"));
  const sourceRead = evidence && Array.isArray(evidence.drafts) ? boundDrafts(record, payload, evidence.drafts) : undefined;
  const markSourceUnavailable = () => {
    const issues = issuesByPhase[position.phase];
    if (!issues.some(issue => issue.diagnostic.kind === "platform" && issue.diagnostic.code === "catalog_publication_read_invalid"))
      issues.push(missing("catalog_publication_read_invalid", "publication"));
  };
  if (evidence && (!sourceRead || sourceRead.incomplete)) markSourceUnavailable();
  const missingProduct = requestedHead !== null && !recordedProduct?.data;
  const retainedState = {
    product: recordedProduct?.data ?? null,
    skus: retainedSkus,
    documents: recordedDocuments ? evidence!.documents : [],
    documentRevisionHighWater: highWaterAvailable ? evidence!.documentRevisionHighWater : 0,
  };
  if (!rules || !evidence) structural.push(missing("publication_preparation_unavailable", "publication"));
  if (lineage.unavailable || lineage.head !== undefined && current === undefined
    || lineage.expectedHead !== undefined && completion === undefined || runtime.knownHead === undefined) structural.push(missing("publication_head_unavailable", "publication"));
  const governedState = evidence?.lifecycle;
  const states = governedState && lifecycleEvidenceSchema.safeParse(governedState).data;
  const governed = governedIntent || governedState !== undefined;
  const lifecycleAvailable = !requestedHead || Boolean(states && retainedState.skus.every(sku => states.skus[sku.code]));
  const legacyHead = governedState === undefined && head?.success && head.data
    && recordedProduct?.success && recordedProduct.data && recordedProduct.data.schemaVersion === undefined;
  const missingLifecycle = (path: string) => unavailable({
    ...publicationIssue("catalog_lifecycle_evidence_unavailable", position.phase, path, position.subject),
    ...(legacyHead ? {} : { detail: "Load the current publication evidence, including the product and SKU lifecycle states, and prepare the draft again." }),
  });
  if (governed && !lifecycleAvailable) structural.push(missingLifecycle("publication"));
  if (!governedIntent && states && lifecycleAvailable) publicationRefuse("catalog_lifecycle_raw_status_fenced");
  const priceOperations = payload.skus.flatMap(sku => sku.priceOperations ?? []);
  const unresolved = unresolvedPublicationDraftIssues(draftIssues, retainedState);
  for (const issue of unresolved) {
    if (issue.kind === "platform" && (issue.code === "attribute_reference_unresolved"
      || missingProduct && (issue.code === "primary_sku_missing" || issue.code === "sku_missing"))) {
      structural.push(missing("publication_evidence_unavailable", issue.path));
    } else {
      const diagnostic = contextualIssue(issue);
      throw new CatalogPublicationError(diagnostic);
    }
  }
  need(record.productId === payload.product.id && record.status === "open", "catalog_publication_source_invalid");
  need(canonicalCatalogDraftJson(record.payload) === canonicalPayload, "catalog_publication_source_mismatch");
  position.path = "publication";
  if (head?.success && recordedProduct?.success)
    need((retainedState.product?.document?.digest ?? null) === (head.data?.documentDigest ?? null), "catalog_publication_source_mismatch");
  need(missingProduct || retainedState.skus.length === 0 || retainedState.product !== null, "catalog_publication_source_invalid");
  need(retainedState.skus.every(sku => sku.productId === payload.product.id), "catalog_publication_scope_expansion");
  const retainedIds = new Set<string>(), retainedCodes = new Set<string>();
  for (const sku of retainedState.skus) {
    need(!retainedIds.has(sku.id) && !retainedCodes.has(sku.code),
      "catalog_publication_sku_revision_invalid");
    retainedIds.add(sku.id); retainedCodes.add(sku.code);
  }
  const claim = catalogPublicationClaim(record), slug = payload.product.slug!;
  const product = retainedState.product === null ? null : structuredClone(retainedState.product);
  const original = publicationJson(materialState(product, retainedState.skus));
  const affected = catalogPublicationAffected(payload);
  const originalById = new Map(retainedState.skus.map(sku => [sku.id, sku] as const));
  const skus = new Map(retainedState.skus.map(sku => [sku.code, structuredClone(sku)]));
  const documents: CatalogPublicationDocument[] = [];
  const authorship = publicationAuthorship(record, payload, sourceRead?.retained ?? [], skus, rules, !sourceRead || sourceRead.incomplete, markSourceUnavailable);
  const incoming = new Map(payload.skus.map(sku => [sku.code, sku]));
  const gtins = new Set(retainedState.skus.flatMap(sku => sku.identifiers
    .filter(identifier => identifier.scheme === "gs1:gtin")
    .map(identifier => normalizeIdentifierValue(identifier.scheme, identifier.value))));
  if (product) need(product.id === payload.product.id && product.slug === slug && equal(product.type, payload.product.type), "catalog_publication_product_identity_conflict");
  assertCatalogAction(payload, requestedHead === null ? "create" : "revise");
  if (product && payload.product.primarySkuId)
    need(product.primarySkuId === payload.product.primarySkuId, "current_primary_mismatch");
  const authoredDocument = payload.product.documentRevision ?? publicationRefuse("document_reference_missing");
  const beforeReference = product?.document;
  const operations = payload.publication.operations;
  const registrationFor = (reference: DocumentRef, source?: PublicationDraftRecord) =>
    operations.find((operation): operation is Extract<PublicationOperation, { op: "register_document_revision" }> =>
      operation.op === "register_document_revision"
      && operation.productSlug === slug && operation.revisionId === reference.id && operation.revisionNo === reference.revisionNo
      && operation.documentRef === reference.documentRef && operation.sourceRef === reference.sourceRef && operation.digest === reference.digest
      && (!source || (operation.provenance.source === "current_draft" ? source === record
        : operation.provenance.draftId === source.draftId && operation.provenance.draftRevision === source.revision)));
  const bindDocumentReference = (reference: DocumentRef | undefined, source?: PublicationDraftRecord) => {
    const registration = reference && registrationFor(reference, source);
    if (!reference || reference.productId !== record.productId || beforeReference && !equal(beforeReference, reference)
      && (!registration || !operations.some(operation => operation.op === "move_document_pointer"
        && operation.productSlug === slug && operation.documentRevisionNo === reference.revisionNo))) {
      position.path = "product.documentRevision";
      publicationRefuse("catalog_publication_v3_document_reference_stale", "conflict");
    }
    return registration;
  };
  const selectedRegistration = bindDocumentReference(authoredDocument);
  for (const source of sourceRead?.claimed ?? [])
    bindDocumentReference(publicationIntent(source.payload)?.product.documentRevision, source);
  const ctx: BoundPublicationContext = {
    runtime,
    admitted,
    requestedHead,
    expectedHead,
    evidence,
    highWaterAvailable,
    missingProduct,
    retainedState,
    governed,
    lifecycleAvailable,
    missingLifecycle,
    priceOperations,
    claim,
    slug,
    product,
    original,
    affected,
    originalById,
    skus,
    documents,
    authorship,
    created: new Set(),
    identities: new Set(),
    creations: new Map(),
    existingCombinations: undefined,
    unavailableRegistrations: new Set(),
    incoming,
    gtins,
    authoredDocument,
    beforeReference,
    operations,
    selectedRegistration,
    documentsById: new Map(),
    referencesByRevision: new Map(),
    referencesById: new Map(),
    documentValueDigests: new Map(),
    documentReferencesIncomplete: !recordedDocuments,
    missingSavedDocumentRevision: false,
    media: new Map(payload.publication.evidence.media?.map(mediaClaim => [mediaClaim.skuCode, mediaClaim])),
    verifiedMedia: [],
    authoredPresentation: payload.product.sharedContent.presentation,
    savedSources: new Map(),
    savedDocuments: new Map(),
    activationCodes: new Set(affected.enabling),
    matchedPhysicalSources: new Set(),
    productState: states?.product,
    skuStates: new Map(Object.entries(states?.skus ?? {})),
    lastChildWithdrawn: false,
    pendingEligibility: new Map(),
    highWater: retainedState.documentRevisionHighWater,
    documentExclusionUnavailable: false,
  };
  ctx.missingSavedDocumentRevision = readDocuments(ctx);
  return ctx;
}
