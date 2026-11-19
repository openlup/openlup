import { createHash } from "node:crypto";
import type { CatalogCandidateQuery, CatalogCandidatePreview, CatalogCandidateComparison } from "./contracts/candidate.js";
import type { CatalogDraftPayloadV2 } from "./contracts/draftV2.js";
import type { CatalogDraftPublicationStoredRecord } from "./contracts/draftV3.js";
import { catalogDraftPublicationStoredRecordSchema, catalogPublicationDraftRecordSchema } from "./draftV3Schemas.js";
import type { CatalogDraftIssue, CatalogProductTypeRef, CatalogProductTypeRegistry } from "./contracts/productTypes.js";
import type { CatalogHeadRef, CatalogPublicationReadResult } from "./contracts/lifecycle.js";
import type { CatalogAttributeReferencePort } from "./attributeReferencePort.js";
import type { CatalogDocumentRevisionRef } from "./contracts/foundation.js";
import type { CatalogValidationPort } from "./publicationPorts.js";
import { canonicalCatalogDraftJson } from "./contracts/draft.js";
import { catalogDefinitionDigest } from "./catalogDefinitionDigest.js";
import { validateCatalogDraftV2 } from "./draftV2Validation.js";
import { z } from "./validation.js";
import type { CatalogCandidatePublicationDeps } from "./publicationEvidence.js";
import { catalogPublicationClaim, evaluateCatalogPublication, publicationIssueUnavailable } from "./publicationValidation.js";

const id = z.guid().refine(value => value === value.toLowerCase());
const revision = z.number().int().min(1).max(2_147_483_647);
const headSchema = z.object({ publicationId: id, revision, documentDigest: z.string().regex(/^[a-f0-9]{64}$/u) }).strict();
const querySchema = z.object({ draftId: id, draftRevision: revision, expectedHead: headSchema.nullable() }).strict();
const referencePattern = /^v1:([0-9a-f-]{36})@([1-9][0-9]*)\/(unpublished|([0-9a-f-]{36})@([1-9][0-9]*))$/u;
/** Decodes the released candidate reference for the facade and command admission.
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
  /** @experimental Read-only evidence and verified rules for V3 publication preparation. */
  publication?: CatalogCandidatePublicationDeps;
}
const refuse = (code: CatalogCandidateError["code"]): never => { throw new CatalogCandidateError(code); };
const equal = (left: CatalogHeadRef | null, right: CatalogHeadRef | null): boolean => canonicalCatalogDraftJson(left) === canonicalCatalogDraftJson(right);

/** No candidate state: each call reconstructs every digest input through the supplied readers.
 * @experimental
 */
export function createCatalogCandidateService(deps: CatalogCandidateDeps): CatalogValidationPort & {
  prepareCandidate(query: CatalogCandidateQuery): Promise<CatalogCandidatePreview>;
  compareCandidate(input: CatalogCandidateComparison): Promise<CatalogCandidatePreview>;
} {
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
      const codec = raw?.payload.schemaVersion === 3 ? catalogPublicationDraftRecordSchema : catalogDraftPublicationStoredRecordSchema;
      const parsed = codec.safeParse(raw);
      if (!parsed.success || parsed.data.draftId !== reference.draftId || parsed.data.revision !== reference.draftRevision)
        return refuse("candidate_invalid");
      const record = parsed.data, payload = record.payload;
      const canonicalPayload = canonicalCatalogDraftJson(payload);
      const latest = await deps.readDraft(record.draftId);
      if (!latest || latest.draftId !== record.draftId || latest.revision !== record.revision || latest.status !== record.status) return refuse("candidate_invalid");
      let current: CatalogPublicationReadResult | undefined;
      try { current = await deps.currentHead(record.productId); }
      catch { if (payload.schemaVersion !== 3) return refuse("candidate_dependency_unavailable"); }
      const headKnown = current?.outcome === "found" || current?.outcome === "unpublished";
      if (headKnown && !equal(current?.outcome === "found" ? headSchema.parse(current.head) : null, expectedHead))
        return refuse("head_conflict");
      if (!headKnown && payload.schemaVersion !== 3) return refuse("candidate_dependency_unavailable");
      const definition = deps.registry.resolve(payload.product.type);
      if (!definition || !definition.validatorRef) return refuse("catalog_definition_drift");
      const registryDigest = catalogDefinitionDigest(definition);
      const installed = await deps.installedDefinitionDigest(payload.product.type);
      if (installed !== registryDigest) return refuse("catalog_definition_drift");
      const issues: CatalogDraftIssue[] = [];
      if (record.status !== "open") issues.push({ path: "draft", code: "draft_abandoned" });
      if (payload.schemaVersion === 1) issues.push({ path: "payload.schemaVersion", code: "candidate_requires_payload_v2" });
      else if (payload.schemaVersion === 2) {
        const validationPayload = JSON.parse(canonicalPayload) as CatalogDraftPayloadV2;
        const validation = await validateCatalogDraftV2(validationPayload, deps.registry, deps.attributeReferences);
        issues.push(...(validation.valid ? validation.readiness.publication.issues : validation.issues));
        if (payload.product.documentRevision) {
          if (!deps.readDocument) issues.push({ path: "product.documentRevision", code: "document_validation_unavailable" });
          else {
            const document = await deps.readDocument({ ...payload.product.documentRevision });
            if (!document || canonicalCatalogDraftJson(document) !== canonicalCatalogDraftJson(payload.product.documentRevision))
              issues.push({ path: "product.documentRevision", code: "document_reference_invalid" });
          }
        }
        if (payload.skus.some(sku => sku.priceOperations?.length)) {
          if (!deps.validatePrices) issues.push({ path: "skus", code: "price_validation_unavailable" });
          else issues.push(...await deps.validatePrices(validationPayload));
        }
      }
      const candidateDigest = createHash("sha256").update('["catalog-candidate",1,').update(canonicalPayload).update(",")
        .update(canonicalCatalogDraftJson([{ ...payload.product.type, definitionDigest: installed }])).update(",")
        .update(canonicalCatalogDraftJson(expectedHead)).update("]").digest("hex");
      let preparation: CatalogCandidatePreview["preparation"];
      if (payload.schemaVersion === 3) {
        const publication = deps.publication;
        let evidence = null;
        try { evidence = await publication?.readEvidence({ candidate: catalogPublicationClaim(record), productId: record.productId, expectedHead }) ?? null; }
        catch { /* This observation is unavailable. Candidate-local checks still run. */ }
        const result = await evaluateCatalogPublication({ record, definition, installedDefinitionDigest: installed,
          expectedHead, evidence, rules: publication?.rules, observations: publication,
          attributeReferences: deps.attributeReferences, validatePrices: deps.validatePrices }, "preview");
        const structural = [...result.structural];
        if (!headKnown) structural.push({ path: "publication", code: "publication_head_unavailable" });
        const blocked = Boolean(result.failure && result.phase === "structural") || structural.some(issue => !publicationIssueUnavailable(issue));
        const activationBlocked = Boolean(result.failure && result.phase === "activation") || result.activationIssues.some(issue => !publicationIssueUnavailable(issue));
        const activation = [...structural, ...result.activationIssues];
        preparation = { structural: { outcome: blocked ? "blocked-input" : structural.length ? "unknown" : "staged", issues: structural },
          activation: { outcome: blocked || activationBlocked ? "blocked-input" : activation.length ? "unknown"
            : result.activating ? "ready" : "pending", issues: [...activation, ...result.pending] } };
        issues.push(...activation);
      }
      return { head: expectedHead, preview: { candidateRef, candidateDigest, issues, ...(preparation ? { preparation } : {}),
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
