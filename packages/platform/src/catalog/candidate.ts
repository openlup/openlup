import { createHash } from "node:crypto";
import type { CatalogCandidateQuery, CatalogCandidatePreview, CatalogCandidateComparison } from "./contracts/candidate.js";
import type { CatalogDraftPayloadV2 } from "./contracts/draftV2.js";
import type { CatalogLifecycleStoredRecord as CatalogDraftPublicationStoredRecord } from "./contracts/lifecycleV2.js";
import { catalogLifecycleStoredRecordSchema as catalogDraftPublicationStoredRecordSchema, catalogLifecycleValidationPayload as catalogDraftV3ValidationPayload } from "./lifecycleV2.js";
import type { CatalogDraftIssue, CatalogProductTypeRef, CatalogProductTypeRegistry } from "./contracts/productTypes.js";
import type { CatalogHeadRef, CatalogPublicationReadResult } from "./contracts/lifecycle.js";
import type { CatalogAttributeReferencePort } from "./attributeReferencePort.js";
import type { CatalogDocumentRevisionRef } from "./contracts/foundation.js";
import type { CatalogValidationPort } from "./publicationPorts.js";
import { canonicalCatalogDraftJson } from "./contracts/draft.js";
import { catalogDefinitionDigest } from "./catalogDefinitionDigest.js";
import { validateCatalogDraftV2 } from "./draftV2Validation.js";
import { z } from "./validation.js";

const id = z.guid().refine(value => value === value.toLowerCase());
const revision = z.number().int().min(1).max(2_147_483_647);
const headSchema = z.object({ publicationId: id, revision, documentDigest: z.string().regex(/^[a-f0-9]{64}$/u) }).strict();
const querySchema = z.object({ draftId: id, draftRevision: revision, expectedHead: headSchema.nullable() }).strict();
const referencePattern = /^v1:([0-9a-f-]{36})@([1-9][0-9]*)\/(unpublished|([0-9a-f-]{36})@([1-9][0-9]*))$/u;
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
      if (typeof candidateRef !== "string" || candidateRef.length > 200) return refuse("candidate_invalid");
      const match = referencePattern.exec(candidateRef);
      if (!match || !id.safeParse(match[1]).success || !revision.safeParse(Number(match[2])).success) return refuse("candidate_invalid");
      let expectedHead: CatalogHeadRef | null = null;
      if (match[3] !== "unpublished") {
        if (!id.safeParse(match[4]).success || !revision.safeParse(Number(match[5])).success) return refuse("candidate_invalid");
        const resolved = await deps.resolveHead({ publicationId: match[4]!, revision: Number(match[5]) });
        const parsed = headSchema.safeParse(resolved);
        if (!parsed.success || parsed.data.publicationId !== match[4] || parsed.data.revision !== Number(match[5])) return refuse("head_conflict");
        expectedHead = parsed.data;
      }
      const raw = await deps.readDraft(match[1]!, Number(match[2]));
      const parsed = catalogDraftPublicationStoredRecordSchema.safeParse(raw);
      if (!parsed.success || parsed.data.draftId !== match[1] || parsed.data.revision !== Number(match[2])) return refuse("candidate_invalid");
      const record = parsed.data, payload = record.payload;
      const canonicalPayload = canonicalCatalogDraftJson(payload);
      const latest = await deps.readDraft(record.draftId);
      if (!latest || latest.draftId !== record.draftId || latest.revision !== record.revision || latest.status !== record.status) return refuse("candidate_invalid");
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
        const validationPayload = payload.schemaVersion >= 3 ? catalogDraftV3ValidationPayload(JSON.parse(canonicalPayload)) : JSON.parse(canonicalPayload);
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
          else issues.push(...await deps.validatePrices(payload.schemaVersion >= 3 ? catalogDraftV3ValidationPayload(JSON.parse(canonicalPayload)) : JSON.parse(canonicalPayload)));
        }
      }
      const candidateDigest = createHash("sha256").update('["catalog-candidate",1,').update(canonicalPayload).update(",")
        .update(canonicalCatalogDraftJson([{ ...payload.product.type, definitionDigest: installed }])).update(",")
        .update(canonicalCatalogDraftJson(expectedHead)).update("]").digest("hex");
      return { head: expectedHead, preview: { candidateRef, candidateDigest, issues,
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
