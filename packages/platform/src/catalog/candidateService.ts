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
import type { CatalogCandidatePublicationDeps } from "./publicationEvidence.js";
import { catalogPublicationClaim, evaluateCatalogPublication } from "./publicationValidation.js";
import { publicationRulesFor, resolvePublicationRules } from "./publicationRules.js";

import { CatalogCandidateError, type CatalogCandidateDeps } from "./candidate.js";

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
      const preparePublication = raw?.payload?.schemaVersion === 3 || raw?.payload?.schemaVersion === 4;
      const record = preparePublication ? readPublicationDraftEnvelope(raw) : catalogDraftPublicationStoredRecordSchema.safeParse(raw).data;
      if (!record || record.draftId !== reference.draftId || record.revision !== reference.draftRevision) return refuse("candidate_invalid");
      const payload = record.payload;
      if (!payload?.product?.type) return refuse("candidate_invalid");
      const latest = await deps.readDraft(record.draftId);
      if (!latest || latest.draftId !== record.draftId || latest.revision !== record.revision || latest.status !== record.status) return refuse("candidate_invalid");
      let current: CatalogPublicationReadResult | undefined;
      try { current = await deps.currentHead(record.productId); }
      catch { if (!preparePublication) return refuse("candidate_dependency_unavailable"); }
      const headKnown = current?.outcome === "found" || current?.outcome === "unpublished";
      if (headKnown && !equal(current?.outcome === "found" ? headSchema.parse(current.head) : null, expectedHead))
        return refuse("head_conflict");
      if (!headKnown && !preparePublication) return refuse("candidate_dependency_unavailable");
      const definitionDrift = () => refuse("catalog_definition_drift",
        publicationIssue("catalog_definition_drift", "structural", "product.type", payload.product.type.key).message);
      const definition = deps.registry.resolve(payload.product.type);
      if (!definition?.validatorRef) return definitionDrift();
      const registryDigest = catalogDefinitionDigest(definition);
      const installed = await deps.installedDefinitionDigest(payload.product.type);
      if (installed !== registryDigest) return definitionDrift();
      const handle = publication?.rules ?? publicationRulesFor(definition);
      let preparation: CatalogCandidatePreview["preparation"];
      const issues: CatalogDraftIssue[] = [];
      if (record.status !== "open") issues.push({ path: "draft", code: "draft_abandoned" });
      if (payload.schemaVersion === 1) issues.push({ path: "payload.schemaVersion", code: "candidate_requires_payload_v2" });
      else if (payload.schemaVersion === 2) {
        const validationPayload = JSON.parse(canonicalCatalogDraftJson(payload)) as CatalogDraftPayloadV2;
        const rules = handle && resolvePublicationRules(handle, definition.validatorRef);
        try {
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
          const issue = publicationDiagnostic(error, "structural", "product.sharedContent", definition.key);
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
        let evidence = null;
        try { evidence = await publication?.readEvidence({ candidate: catalogPublicationClaim(record), productId: record.productId, expectedHead }) ?? null; }
        catch { /* This observation is unavailable. Candidate-local checks still run. */ }
        const result = await evaluateCatalogPublication({ record, definition, installedDefinitionDigest: installed,
          expectedHead, evidence, rules: handle, observations: publication,
          attributeReferences: deps.attributeReferences, validatePrices: deps.validatePrices }, "preview");
        if (result.failure?.code === "candidate_invalid") return refuse("candidate_invalid");
        const structural = result.structural.map(issue => issue.diagnostic);
        if (!headKnown) structural.push({ path: "publication", code: "publication_head_unavailable" });
        const blocked = result.structural.some(issue => issue.outcome !== "dependency_unavailable");
        const activationBlocked = result.activationIssues.some(issue => issue.outcome !== "dependency_unavailable");
        const activation = [...structural, ...result.activationIssues.map(issue => issue.diagnostic)];
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
