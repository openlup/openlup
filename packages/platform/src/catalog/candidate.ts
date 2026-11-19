import { createHash } from "node:crypto";
import type { CatalogCandidateQuery, CatalogCandidatePreview, CatalogCandidateComparison } from "./contracts/candidate.js";
import type { CatalogPublishedProduct } from "./contracts/publication.js";
import type { CatalogDraftPayloadV2 } from "./contracts/draftV2.js";
import type { CatalogDraftMediaClaimV3, CatalogDraftPayloadV3, CatalogDraftPublicationStoredRecord } from "./contracts/draftV3.js";
import { catalogDraftPublicationStoredRecordSchema, catalogDraftV3ValidationPayload } from "./draftV3Schemas.js";
import type { CatalogDraftIssue, CatalogProductTypeDefinition, CatalogProductTypeRef, CatalogProductTypeRegistry } from "./contracts/productTypes.js";
import type { CatalogHeadRef, CatalogPublicationReadResult } from "./contracts/lifecycle.js";
import type { CatalogAttributeReferencePort } from "./attributeReferencePort.js";
import type { CatalogDocumentRevisionRef } from "./contracts/foundation.js";
import { canonicalCatalogDraftJson } from "./contracts/draft.js";
import { catalogDefinitionDigest } from "./catalogDefinitionDigest.js";
import { validateCatalogDraftV2 } from "./draftV2Validation.js";
import { assertCatalogPublicationGrossMass, catalogPublicationClaim, catalogPublicationMediaIssue, catalogPublicationPreparationIssues,
  CatalogPublicationError, compileCatalogPublication, publicationReadinessVerdict, unresolvedPublicationDraftIssues, verifyCatalogPublicationMedia,
  type CatalogPublicationCompileInput, type CatalogPublicationRules } from "./publicationValidation.js";
import { z } from "./validation.js";

const id = z.guid().refine(value => value === value.toLowerCase());
const revision = z.number().int().min(1).max(2_147_483_647);
const headSchema = z.object({ publicationId: id, revision, documentDigest: z.string().regex(/^[a-f0-9]{64}$/u) }).strict();
const querySchema = z.object({ draftId: id, draftRevision: revision, expectedHead: headSchema.nullable() }).strict();
const referencePattern = /^v1:([0-9a-f-]{36})@([1-9][0-9]*)\/(unpublished|([0-9a-f-]{36})@([1-9][0-9]*))$/u;
/** Exact reference decoding shared by the facade and the transaction admission.
 * @experimental
 */
export function parseCatalogCandidateReference(value: string) {
  if (typeof value !== "string" || value.length > 200) return null;
  const match = referencePattern.exec(value);
  if (!match || !id.safeParse(match[1]).success || !revision.safeParse(Number(match[2])).success) return null;
  const draftId = match[1]!, draftRevision = Number(match[2]);
  if (match[3] === "unpublished") return { draftId, draftRevision, head: null };
  if (!id.safeParse(match[4]).success || !revision.safeParse(Number(match[5])).success) return null;
  return { draftId, draftRevision, head: { publicationId: match[4]!, revision: Number(match[5]) } };
}
/** @experimental */
export class CatalogCandidateError extends Error {
  constructor(readonly code: "candidate_invalid" | "head_conflict" | "candidate_digest_mismatch" | "catalog_definition_drift" | "candidate_dependency_unavailable") {
    super(code); this.name = "CatalogCandidateError";
  }
}
/** @experimental */
export interface CatalogCandidateDeps {
  /** Authorized immutable revision read; no actor string becomes publication authority. */
  readDraft(draftId: string, revision?: number): Promise<CatalogDraftPublicationStoredRecord | null>;
  registry: CatalogProductTypeRegistry;
  installedDefinitionDigest(ref: CatalogProductTypeRef): Promise<string | null>;
  currentHead(productId: string): Promise<CatalogPublicationReadResult>;
  /** Resolve full immutable lineage, including documentDigest, from the encoded identity. */
  resolveHead(identity: { publicationId: string; revision: number }): Promise<CatalogHeadRef | null>;
  readDocument?: (reference: CatalogDocumentRevisionRef) => Promise<CatalogDocumentRevisionRef | null>;
  attributeReferences?: CatalogAttributeReferencePort;
  /** The price owner validates proposed operations; its absence blocks a price-bearing preview. */
  validatePrices?: (payload: CatalogDraftPayloadV2) => Promise<readonly CatalogDraftIssue[]>;
  /** @experimental Installed rules for sealed v3 publication inputs. */
  publicationRules?: CatalogPublicationRules;
  /** @experimental Reads the exact retained snapshot at the requested head. */
  readPublicationState?: (head: CatalogHeadRef) => Promise<Pick<CatalogPublicationCompileInput,
    "product" | "skus" | "documents" | "retainedSources"> | null>;
  /** @experimental Checks proposed routes against current, independently owned presentations. */
  presentationReadiness?: (productId: string, presentation: NonNullable<CatalogPublishedProduct["presentation"]>) =>
    Promise<{ ready: boolean; reasons: readonly string[] }>;
  /** @experimental Supplies current evidence for an explicit enabling phase. */
  assessActivation?: (state: Pick<ReturnType<typeof compileCatalogPublication>, "product" | "skus">, head: CatalogHeadRef,
    verifiedMedia: readonly CatalogDraftMediaClaimV3[]) =>
    Promise<{ ready: boolean; reasons: readonly string[] } | null>;
  /** @experimental Independently verifies the sealed claim, including its revision digest. */
  verifyMedia?: (claim: CatalogDraftMediaClaimV3, head: CatalogHeadRef) => Promise<boolean>;
}
const refuse = (code: CatalogCandidateError["code"]): never => { throw new CatalogCandidateError(code); };
const equal = (left: CatalogHeadRef | null, right: CatalogHeadRef | null): boolean => canonicalCatalogDraftJson(left) === canonicalCatalogDraftJson(right);

/** No candidate state: each call reconstructs every digest input through the supplied readers.
 * @experimental
 */
export function createCatalogCandidateService(deps: CatalogCandidateDeps): {
  validate(candidateRef: string): Promise<CatalogCandidatePreview>;
  prepareCandidate(query: CatalogCandidateQuery): Promise<CatalogCandidatePreview>;
  compareCandidate(input: CatalogCandidateComparison): Promise<CatalogCandidatePreview>;
} {
  async function preparePublication(record: CatalogDraftPublicationStoredRecord, payload: CatalogDraftPayloadV3,
    definition: CatalogProductTypeDefinition, head: CatalogHeadRef | null, existingIssues: readonly CatalogDraftIssue[]):
    Promise<NonNullable<CatalogCandidatePreview["preparation"]>> {
    const rules = deps.publicationRules;
    const authored = catalogPublicationPreparationIssues(payload, { definition, rules: rules ?? {} });
    const hard: CatalogDraftIssue[] = [], unknown: CatalogDraftIssue[] = [];
    let current: Awaited<ReturnType<NonNullable<CatalogCandidateDeps["readPublicationState"]>>> | undefined;
    try { current = head ? await deps.readPublicationState?.(head) : { product: null, skus: [], documents: [], retainedSources: [] }; }
    catch { /* Retained state is unavailable. */ }
    if (head && current?.product?.id !== record.productId) current = undefined;
    const unresolved = current ? unresolvedPublicationDraftIssues(existingIssues, current) : existingIssues;
    for (const issue of new Map([...unresolved, ...authored].map(issue => [`${issue.path}:${issue.code}`, issue])).values()) {
      if (issue.code.endsWith("_unavailable")) unknown.push(issue);
      else hard.push(issue);
    }
    if (!payload.product.documentRevision) hard.push({ path: "product.documentRevision", code: "document_reference_missing" });
    if (!rules || !current) unknown.push({ path: "publication", code: "publication_preparation_unavailable" });
    let compiled: ReturnType<typeof compileCatalogPublication> | undefined;
    if (hard.length === 0 && rules && current) {
      try {
        compiled = compileCatalogPublication({ ...current, record, payload, definition, rules });
      } catch (error) {
        if (error instanceof CatalogPublicationError)
          hard.push({ path: error.code === "catalog_publication_activation_effect_missing" ? "publication.operations" : "publication", code: error.code });
        else unknown.push({ path: "publication", code: "publication_preparation_unavailable" });
      }
    }
    let presentation = compiled ? compiled.product.presentation : payload.product.sharedContent.presentation;
    if (!compiled) for (const operation of payload.publication.operations)
      if (operation.op === "set_product_presentation") presentation = operation.presentation;
    if (presentation !== null) {
      let result: unknown;
      try { result = await deps.presentationReadiness?.(record.productId, presentation); } catch { /* Evidence is unknown. */ }
      const verdict = publicationReadinessVerdict.safeParse(result), path = "product.sharedContent.presentation";
      if (!verdict.success) unknown.push({ path, code: "catalog_publication_presentation_unavailable" });
      else hard.push(...verdict.data.reasons.map(code => ({ path, code })));
    }
    const activation: NonNullable<CatalogCandidatePreview["preparation"]>["activation"] = { outcome: "pending", issues: [] };
    const activating = new Set(payload.publication.operations.flatMap(op => op.op === "set_eligibility"
      && (op.sellableStandalone || op.sellableInSubscription) ? [op.skuCode] : []));
    const mediaIssues: CatalogDraftIssue[] = [];
    const compiledSkus = new Map(compiled?.skus.map(sku => [sku.code, sku]));
    const claims = new Map(payload.publication.evidence.media?.map(claim => [claim.skuCode, claim]));
    const mediaRef = presentation?.mediaRef;
    function mediaIssue(code: string, assets: readonly string[], path: string) {
      const media = catalogPublicationMediaIssue(mediaRef, compiledSkus.get(code)?.assetRefs ?? assets, claims.get(code));
      return media ? { path: media === "media_reference_missing" ? "product.sharedContent.presentation.mediaRef" : `${path}.assetRefs`, code: media } : null;
    }
    const pending = payload.skus.flatMap((sku, index) => {
      if (!sku.code) return [];
      const path = `skus.${index}`, issues: (CatalogDraftIssue & { channel?: "one_time" | "subscription" })[] = [];
      const content = payload.product.sharedContent;
      const modes = content.requestedModes.find(intent => intent.skuCode === sku.code)?.modes;
      if (!sku.grossMass) issues.push({ path: `${path}.grossMass`, code: "gross_mass_missing" });
      if (!sku.logisticsRef) issues.push({ path: `${path}.logisticsRef`, code: "logistics_reference_missing" });
      if (!sku.priceOperations?.length) issues.push({ path: `${path}.priceOperations`, code: "price_reference_missing" });
      if (payload.publication.operations.some(op => op.op === "create_sku" && op.skuCode === sku.code)
        && !content.offerMemberships.some(row => row.skuCode === sku.code))
        issues.push({ path: "product.sharedContent.offerMemberships", code: "offer_membership_missing" });
      if (!modes) issues.push({ path: "product.sharedContent.requestedModes", code: "requested_modes_missing" });
      for (const channel of modes ?? []) issues.push({ path: `${path}.priceOperations`, code: "activation_not_assessed", channel });
      const issue = mediaIssue(sku.code, sku.assetRefs ?? [], path);
      if (issue) {
        issues.push(issue);
        if (activating.has(sku.code)) mediaIssues.push(issue);
      }
      return issues;
    });
    const authoredSkuCodes = new Set(payload.skus.map(sku => sku.code));
    for (const code of activating) if (!authoredSkuCodes.has(code) && compiledSkus.has(code)) {
      const issue = mediaIssue(code, [], "publication.operations");
      if (issue) mediaIssues.push(issue);
    }
    activation.issues = pending;
    if (activating.size > 0) {
      let verdict: Awaited<ReturnType<NonNullable<CatalogCandidateDeps["assessActivation"]>>> | undefined;
      const activationRefusals: CatalogDraftIssue[] = [];
      let proofUnavailable = false;
      if (head && current && compiled) {
        const verifiedMedia: CatalogDraftMediaClaimV3[] = [];
        try {
          for (const code of activating) {
            const source = payload.skus.some(sku => sku.code === code) ? payload : current.retainedSources.find(source =>
              source.payload.schemaVersion === 3 && source.payload.skus.some(sku => sku.code === code)
              && payload.publication.evidence.drafts?.some(claim =>
                canonicalCatalogDraftJson(claim) === canonicalCatalogDraftJson(catalogPublicationClaim(source))))?.payload;
            const sku = source?.skus.find(sku => sku.code === code);
            if (!sku?.netContent) throw new CatalogPublicationError("catalog_publication_operation_source_mismatch");
            assertCatalogPublicationGrossMass(sku.netContent, sku.grossMass ?? null, definition);
            const claim = claims.get(code);
            if (!claim) continue;
            if (!authoredSkuCodes.has(code)) throw new CatalogPublicationError("catalog_publication_draft_advanced", "conflict");
            if (catalogPublicationMediaIssue(payload.product.sharedContent.presentation.mediaRef, sku.assetRefs ?? [], claim))
              throw new CatalogPublicationError("catalog_publication_media_evidence_mismatch");
            if (!deps.verifyMedia) { proofUnavailable = true; continue; }
            await verifyCatalogPublicationMedia(claim, () => deps.verifyMedia!(claim, head));
            verifiedMedia.push(claim);
          }
          if (!proofUnavailable && !mediaIssues.length)
            verdict = await deps.assessActivation?.(compiled, head, verifiedMedia);
        } catch (error) {
          if (error instanceof CatalogPublicationError && error.outcome !== "dependency_unavailable")
            activationRefusals.push({ path: "publication.operations", code: error.code });
          else proofUnavailable = true;
        }
      }
      const parsed = publicationReadinessVerdict.safeParse(verdict);
      activation.outcome = hard.length > 0 || activationRefusals.length > 0 || !head || parsed.success && !parsed.data.ready
        || mediaIssues.some(issue => issue.code !== "media_readiness_unknown") ? "blocked-input"
        : parsed.success && !mediaIssues.length ? "ready" : "unknown";
      activation.issues = hard.length || activationRefusals.length ? [...hard, ...activationRefusals, ...pending] : !head ? [{ path: "publication", code: "product_not_materialized" }]
        : parsed.success ? [...parsed.data.reasons.map(code => ({ path: "publication", code })), ...mediaIssues]
        : [...pending, { path: "publication", code: "activation_unknown" }];
    }
    return { structural: { outcome: hard.length ? "blocked-input" : unknown.length ? "unknown" : "staged", issues: [...hard, ...unknown] },
      activation };
  }
  async function reconstruct(candidateRef: string): Promise<{ preview: CatalogCandidatePreview; head: CatalogHeadRef | null }> {
    try {
      const reference = parseCatalogCandidateReference(candidateRef);
      if (!reference) return refuse("candidate_invalid");
      let expectedHead: CatalogHeadRef | null = null;
      if (reference.head) {
        const parsed = headSchema.safeParse(await deps.resolveHead(reference.head));
        if (!parsed.success || parsed.data.publicationId !== reference.head.publicationId
          || parsed.data.revision !== reference.head.revision) return refuse("head_conflict");
        expectedHead = parsed.data;
      }
      const raw = await deps.readDraft(reference.draftId, reference.draftRevision);
      const parsed = catalogDraftPublicationStoredRecordSchema.safeParse(raw);
      if (!parsed.success || parsed.data.draftId !== reference.draftId || parsed.data.revision !== reference.draftRevision) return refuse("candidate_invalid");
      const record = parsed.data, payload = record.payload;
      const canonicalPayload = canonicalCatalogDraftJson(payload);
      const latest = await deps.readDraft(record.draftId);
      if (!latest || latest.draftId !== record.draftId || latest.revision !== record.revision || latest.status !== record.status || latest.productId !== record.productId) return refuse("candidate_invalid");
      const current = await deps.currentHead(record.productId);
      if (current.outcome !== "found" && current.outcome !== "unpublished") return refuse("candidate_dependency_unavailable");
      const head = current.outcome === "found" ? headSchema.parse(current.head) : null;
      if (!equal(head, expectedHead)) return refuse("head_conflict");
      const definition = deps.registry.resolve(payload.product.type);
      if (!definition || !definition.validatorRef) return refuse("catalog_definition_drift");
      const registryDigest = catalogDefinitionDigest(definition);
      const installed = await deps.installedDefinitionDigest(payload.product.type);
      if (installed !== registryDigest) return refuse("catalog_definition_drift");
      const issues: CatalogDraftIssue[] = [];
      if (record.status !== "open") issues.push({ path: "draft", code: "draft_abandoned" });
      if (payload.schemaVersion === 1) issues.push({ path: "payload.schemaVersion", code: "candidate_requires_payload_v2" });
      else {
        const validationPayload = payload.schemaVersion === 3 ? catalogDraftV3ValidationPayload(JSON.parse(canonicalPayload)) : JSON.parse(canonicalPayload);
        const validation = await validateCatalogDraftV2(validationPayload, deps.registry, deps.attributeReferences);
        issues.push(...(validation.valid ? validation.readiness.publication.issues : validation.issues));
        if (payload.schemaVersion === 2 && payload.product.documentRevision) {
          if (!deps.readDocument) issues.push({ path: "product.documentRevision", code: "document_validation_unavailable" });
          else {
            const document = await deps.readDocument({ ...payload.product.documentRevision });
            if (!document || canonicalCatalogDraftJson(document) !== canonicalCatalogDraftJson(payload.product.documentRevision))
              issues.push({ path: "product.documentRevision", code: "document_reference_invalid" });
          }
        }
        if (payload.skus.some(sku => sku.priceOperations?.length)) {
          if (!deps.validatePrices) issues.push({ path: "skus", code: "price_validation_unavailable" });
          else issues.push(...await deps.validatePrices(payload.schemaVersion === 3 ? catalogDraftV3ValidationPayload(JSON.parse(canonicalPayload)) : JSON.parse(canonicalPayload)));
        }
      }
      const candidateDigest = createHash("sha256").update('["catalog-candidate",1,').update(canonicalPayload).update(",")
        .update(canonicalCatalogDraftJson([{ ...payload.product.type, definitionDigest: installed }])).update(",")
        .update(canonicalCatalogDraftJson(expectedHead)).update("]").digest("hex");
      const preparation = payload.schemaVersion === 3 ? await preparePublication(record, payload, definition, expectedHead, issues) : undefined;
      return { head: expectedHead, preview: { candidateRef, candidateDigest, issues: preparation?.structural.issues ?? issues,
        ...(preparation ? { preparation } : {}),
        impact: { productId: record.productId, skuIds: payload.skus.map(sku => sku.id),
          priceOperationCount: payload.schemaVersion !== 1 ? payload.skus.reduce((sum, sku) => sum + (sku.priceOperations?.length ?? 0), 0) : 0 } } };
    } catch (error) {
      if (error instanceof CatalogCandidateError) throw error;
      return refuse("candidate_dependency_unavailable");
    }
  }
  return {
    async prepareCandidate(query) {
      const parsed = querySchema.safeParse(query);
      if (!parsed.success) return refuse("candidate_invalid");
      const { draftId, draftRevision, expectedHead } = parsed.data;
      const candidateRef = `v1:${draftId}@${draftRevision}/${expectedHead === null ? "unpublished" : `${expectedHead.publicationId}@${expectedHead.revision}`}`;
      const result = await reconstruct(candidateRef);
      if (!equal(result.head, expectedHead)) return refuse("head_conflict");
      return result.preview;
    },
    async validate(candidateRef) { return (await reconstruct(candidateRef)).preview; },
    async compareCandidate(input) {
      const result = await reconstruct(input.candidateRef);
      if (!headSchema.nullable().safeParse(input.expectedHead).success || !equal(input.expectedHead, result.head)) return refuse("head_conflict");
      if (input.candidateDigest !== result.preview.candidateDigest) return refuse("candidate_digest_mismatch");
      return result.preview;
    },
  };
}
