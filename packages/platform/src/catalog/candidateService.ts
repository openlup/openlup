import { createHash } from "node:crypto";
import type { CatalogCandidateQuery, CatalogCandidatePreview, CatalogCandidateComparison } from "./contracts/candidate.js";
import type { CatalogDraftPayloadV2 } from "./contracts/draftV2.js";
import { catalogDraftPublicationStoredRecordSchema } from "./draftV3Schemas.js";
import type { CatalogDraftIssue } from "./contracts/productTypes.js";
import type { CatalogHeadRef, CatalogPublicationReadResult } from "./contracts/lifecycle.js";
import type { CatalogValidationPort } from "./publicationPorts.js";
import { canonicalCatalogDraftJson } from "./contracts/draft.js";
import { catalogDefinitionDigest } from "./catalogDefinitionDigest.js";
import { validateCatalogDraftV2 } from "./draftV2Validation.js";
import { z } from "./validation.js";
import { CatalogPublicationError, publicationDiagnostic, publicationIssue } from "./publicationError.js";
import { readPublicationDraftEnvelope, type PublicationDraftRecord } from "./publicationIntent.js";
import { publicationHeadSchema as headSchema, type CatalogCandidatePublicationDeps } from "./publicationEvidence.js";
import { evaluateCatalogPublication } from "./publicationValidation.js";
import { resolvePublicationRules } from "./publicationRules.js";

import { CatalogCandidateError, type CatalogCandidateDeps } from "./candidate.js";

const id = z.guid().refine(value => value === value.toLowerCase());
const revision = z.number().int().min(1).max(2_147_483_647);
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
const refuse = (code: CatalogCandidateError["code"], message?: string): never => {
  const error = new CatalogCandidateError(code);
  if (message) error.message = message;
  throw error;
};
const equal = (left: CatalogHeadRef | null, right: CatalogHeadRef | null): boolean => canonicalCatalogDraftJson(left) === canonicalCatalogDraftJson(right);

type CatalogCandidateService = CatalogValidationPort & {
  prepareCandidate(query: CatalogCandidateQuery): Promise<CatalogCandidatePreview>;
  compareCandidate(input: CatalogCandidateComparison): Promise<CatalogCandidatePreview>;
};

/** @internal The publication host supplies the platform's read owners. */
export function createCatalogCandidateServiceWithPublication(deps: Omit<CatalogCandidateDeps, "readDraft"> & {
  readDraft(draftId: string, revision?: number): Promise<PublicationDraftRecord | null>;
},
  publication?: CatalogCandidatePublicationDeps): CatalogCandidateService {
  async function readHead(productId: string) {
    try {
      const current: CatalogPublicationReadResult = await deps.currentHead(productId);
      if (current?.outcome === "found") return headSchema.safeParse(current.head).data;
      if (current?.outcome === "unpublished") return null;
    } catch { /* This observation is unavailable. */ }
  }

  async function reconstruct(candidateRef: string, expected?: CatalogHeadRef | null): Promise<{ preview: CatalogCandidatePreview; head: CatalogHeadRef | null }> {
    try {
      const reference = parseCatalogCandidateReference(candidateRef);
      if (!reference) return refuse("candidate_invalid");
      const raw = await deps.readDraft(reference.draftId, reference.draftRevision);
      const preparePublication = raw?.payload?.schemaVersion === 3 || raw?.payload?.schemaVersion === 4;
      const record = preparePublication ? readPublicationDraftEnvelope(raw) : catalogDraftPublicationStoredRecordSchema.safeParse(raw).data;
      if (!record || record.draftId !== reference.draftId || record.revision !== reference.draftRevision) return refuse("candidate_invalid");
      const payload = record.payload;
      if (!payload?.product?.type) return refuse("candidate_invalid");
      const latest = await deps.readDraft(record.draftId);
      if (!latest || latest.draftId !== record.draftId || latest.revision !== record.revision || latest.status !== record.status) return refuse("candidate_invalid");
      let expectedHead: CatalogHeadRef | null = null;
      let unresolvedExpectedHead = false;
      if (reference.head) {
        let observed: CatalogHeadRef | null | undefined;
        try { observed = await deps.resolveHead(reference.head); } catch { /* Admission can still diagnose the supplied draft. */ }
        const parsed = headSchema.safeParse(observed);
        if (parsed.success && parsed.data.publicationId === reference.head.publicationId
          && parsed.data.revision === reference.head.revision) expectedHead = parsed.data;
        else {
          unresolvedExpectedHead = true;
          if (expected?.publicationId === reference.head.publicationId && expected.revision === reference.head.revision)
            expectedHead = expected;
        }
      }
      async function checkLegacyLineage(productId: string) {
        if (unresolvedExpectedHead) return refuse("head_conflict");
        const head = await readHead(productId);
        if (head === undefined) return refuse("candidate_dependency_unavailable");
        if (!equal(head, expectedHead)) return refuse("head_conflict");
      }
      // Older drafts keep the released lineage checks. Publication admission runs before current lineage is read.
      if (!preparePublication) await checkLegacyLineage(record.productId);
      const definitionDrift = () => refuse("catalog_definition_drift",
        publicationIssue("catalog_definition_drift", "structural", "product.type", payload.product.type.key).message);
      const definition = deps.registry.resolve(payload.product.type);
      if (!definition?.validatorRef) return definitionDrift();
      const registryDigest = catalogDefinitionDigest(definition);
      const installed = await deps.installedDefinitionDigest(payload.product.type);
      if (installed !== registryDigest) return definitionDrift();
      const evaluation = publication?.evaluation ?? { evaluatedAt: record.createdAt };
      let preparation: CatalogCandidatePreview["preparation"];
      const issues: CatalogDraftIssue[] = [];
      if (record.status !== "open") issues.push({ path: "draft", code: "draft_abandoned" });
      if (payload.schemaVersion === 1) issues.push({ path: "payload.schemaVersion", code: "candidate_requires_payload_v2" });
      else if (payload.schemaVersion === 2) {
        const validationPayload = JSON.parse(canonicalCatalogDraftJson(payload)) as CatalogDraftPayloadV2;
        try {
          const rules = resolvePublicationRules(definition, evaluation);
          const validation = await validateCatalogDraftV2(validationPayload, { resolve: () => ({
            ...definition, validateContent: rules?.validateContent ?? (() => []),
          }) }, deps.attributeReferences);
          const draftIssues = validation.valid ? validation.readiness.publication.issues : validation.issues;
          issues.push(...draftIssues.map(({ path, code }) => ({ path, code })));
          const details = draftIssues.map(({ path, code }) => publicationIssue(code, "structural", path, definition.key));
          if (!rules) details.push(publicationIssue("publication_preparation_unavailable", "structural", "product.type", definition.key));
          const outcome = !rules || validation.valid ? "unknown" : "blocked-input";
          preparation = { structural: { outcome, issues: details }, activation: { outcome, issues: details } };
        } catch (error) {
          if (!(error instanceof CatalogPublicationError)) throw error;
          const issue = publicationDiagnostic(error, "structural",
            error.code === "catalog_publication_rules_binding_mismatch" ? "product.type" : "product.sharedContent", definition.key);
          issues.push({ code: issue.code, path: issue.path });
          preparation = { structural: { outcome: "blocked-input", issues: [issue] }, activation: { outcome: "blocked-input", issues: [issue] } };
        }
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
      if (preparePublication) {
        const result = await evaluateCatalogPublication({ record, definition, installedDefinitionDigest: installed,
          expectedHead, evaluation, observations: publication,
          readCurrentHead: async () => {
            if (unresolvedExpectedHead) throw new CatalogPublicationError("head_conflict", "conflict");
            return readHead(record.productId);
          },
          attributeReferences: deps.attributeReferences, validatePrices: deps.validatePrices }, "preview");
        if (result.failure?.code === "candidate_invalid" || result.failure?.code === "head_conflict") return refuse(result.failure.code);
        const structural = result.structural.map(issue => issue.diagnostic);
        const blocked = result.structural.some(issue => issue.outcome !== "dependency_unavailable");
        const activationBlocked = result.activationIssues.some(issue => issue.outcome !== "dependency_unavailable");
        const activation = [...structural, ...result.activationIssues.map(issue => issue.diagnostic)];
        const first = result.failure?.diagnostic;
        if (first?.phase === "activation") {
          activation.splice(activation.indexOf(first), 1);
          activation.unshift(first);
        }
        preparation = { structural: { outcome: blocked ? "blocked-input" : structural.length ? "unknown" : "staged", issues: structural },
          activation: { outcome: blocked || activationBlocked ? "blocked-input" : activation.length ? "unknown"
            : result.activating ? "ready" : "pending", issues: [...activation, ...result.pending] } };
        issues.push(...activation.map(({ path, code }) => ({ path, code })));
      }
      const candidateDigest = createHash("sha256").update('["catalog-candidate",1,').update(canonicalCatalogDraftJson(payload)).update(",")
        .update(canonicalCatalogDraftJson([{ ...payload.product.type, definitionDigest: installed }])).update(",")
        .update(canonicalCatalogDraftJson(expectedHead)).update("]").digest("hex");
      return { head: expectedHead, preview: { candidateRef, candidateDigest, issues, ...(preparation ? { preparation } : {}),
        impact: { productId: record.productId, skuIds: payload.skus.map(sku => sku.id),
          priceOperationCount: payload.schemaVersion !== 1 ? payload.skus.reduce((sum, sku) => sum + (sku.priceOperations?.length ?? 0), 0) : 0 } } };
    } catch (error) {
      if (error instanceof CatalogCandidateError) throw error;
      if (error instanceof CatalogPublicationError)
        return refuse("candidate_dependency_unavailable", error.message);
      return refuse("candidate_dependency_unavailable");
    }
  }
  return {
    async prepareCandidate(query) {
      const parsed = querySchema.safeParse(query);
      if (!parsed.success) return refuse("candidate_invalid");
      const { draftId, draftRevision, expectedHead } = parsed.data;
      const candidateRef = `v1:${draftId}@${draftRevision}/${expectedHead === null ? "unpublished" : `${expectedHead.publicationId}@${expectedHead.revision}`}`;
      const result = await reconstruct(candidateRef, expectedHead);
      if (!equal(result.head, expectedHead)) return refuse("head_conflict");
      return result.preview;
    },
    async validate(candidateRef) { return (await reconstruct(candidateRef)).preview; },
    async compareCandidate(input) {
      const head = headSchema.nullable().safeParse(input.expectedHead);
      const result = await reconstruct(input.candidateRef, head.data);
      if (!headSchema.nullable().safeParse(input.expectedHead).success || !equal(input.expectedHead, result.head)) return refuse("head_conflict");
      if (input.candidateDigest !== result.preview.candidateDigest) return refuse("candidate_digest_mismatch");
      return result.preview;
    },
  };
}
