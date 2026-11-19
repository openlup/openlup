import { createHash } from "node:crypto";
import type { CatalogCandidateQuery, CatalogCandidatePreview, CatalogCandidateComparison } from "./contracts/candidate.js";
import type { CatalogDraftIssue } from "./contracts/productTypes.js";
import type { CatalogHeadRef, CatalogPublicationReadResult } from "./contracts/lifecycle.js";
import type { CatalogValidationPort } from "./publicationPorts.js";
import { canonicalCatalogDraftJson } from "./contracts/draft.js";
import { catalogDefinitionDigest } from "./catalogDefinitionDigest.js";
import { z } from "./validation.js";
import { CatalogPublicationError, publicationIssue } from "./publicationError.js";
import { readPublicationDraftEnvelope, type PublicationDraftRecord } from "./publicationIntent.js";
import { matchesPublicationHead, publicationHeadSchema as headSchema, type CatalogCandidatePublicationDeps } from "./publicationEvidence.js";
import { evaluateCatalogPublication } from "./publicationValidation.js";

import { CatalogCandidateError, createCatalogCandidateService, type CatalogCandidateDeps } from "./candidate.js";

const id = z.guid().refine(value => value === value.toLowerCase());
const revision = z.number().int().min(1).max(2_147_483_647);
const querySchema = z.object({ draftId: id, draftRevision: revision, expectedHead: z.unknown() }).strict();
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
/** Keep returned values distinct from a rejected lineage read. */
async function readLineage<T>(read: () => Promise<T | undefined>): Promise<T | undefined> {
  try { return await read(); } catch { return undefined; }
}

type CatalogCandidateService = CatalogValidationPort & {
  prepareCandidate(query: CatalogCandidateQuery): Promise<CatalogCandidatePreview>;
  compareCandidate(input: CatalogCandidateComparison): Promise<CatalogCandidatePreview>;
};

/** Opt in to publication preparation by supplying the publication observations.
 * @experimental
 */
export function createCatalogCandidateServiceWithPublication(deps: Omit<CatalogCandidateDeps, "readDraft"> & {
  readDraft(draftId: string, revision?: number): Promise<PublicationDraftRecord | null>;
},
  publication: CatalogCandidatePublicationDeps): CatalogCandidateService {
  async function dispatch<Result>(candidateRef: string,
    legacy: (service: CatalogCandidateService) => Promise<Result>,
    evaluate: (reference: NonNullable<ReturnType<typeof parseCatalogCandidateReference>>, raw: PublicationDraftRecord | null) => Promise<Result>,
  ): Promise<Result> {
    try {
      const reference = parseCatalogCandidateReference(candidateRef);
      if (!reference) return refuse("candidate_invalid");
      const raw = await deps.readDraft(reference.draftId, reference.draftRevision);
      const payload = raw?.payload;
      if (raw && (payload?.schemaVersion === 1 || payload?.schemaVersion === 2)) {
        // The opted-in dispatcher already read the immutable revision.
        const readLegacyDraft = deps.readDraft.bind(deps) as CatalogCandidateDeps["readDraft"];
        return legacy(createCatalogCandidateService({ ...deps, readDraft: (...args) =>
          args[0] === reference.draftId && args[1] === reference.draftRevision
            ? Promise.resolve({ ...raw, payload }) : readLegacyDraft(...args) }));
      }
      return evaluate(reference, raw);
    } catch (error) {
      if (error instanceof CatalogCandidateError) throw error;
      return refuse("candidate_dependency_unavailable");
    }
  }

  async function reconstruct(candidateRef: string, reference: NonNullable<ReturnType<typeof parseCatalogCandidateReference>>,
    raw: PublicationDraftRecord | null, caller?: { expectedHead: unknown }): Promise<CatalogCandidatePreview> {
    try {
      const record = readPublicationDraftEnvelope(raw);
      if (!record || record.draftId !== reference.draftId || record.revision !== reference.draftRevision) return refuse("candidate_invalid");
      const payload = record.payload;
      if ((payload.schemaVersion !== 3 && payload.schemaVersion !== 4) || !payload.product?.type) return refuse("candidate_invalid");
      const referenceHead = reference.head;
      let identityHead = referenceHead;
      let unresolvedImmutableHead = false;
      const readHeadLineage = async () => {
        const parsedHead = caller && headSchema.nullable().safeParse(caller.expectedHead);
        if (parsedHead && (!parsedHead.success || !matchesPublicationHead(referenceHead, parsedHead.data)))
          throw new CatalogPublicationError("head_conflict", "conflict");
        const expected = parsedHead?.data;
        const resolved = referenceHead === null ? undefined : await readLineage(() => deps.resolveHead({ ...referenceHead }));
        const observedHead = headSchema.safeParse(resolved).data;
        unresolvedImmutableHead = referenceHead !== null && observedHead === undefined;
        const fullHead = referenceHead === null ? undefined : expected ?? observedHead;
        const expectedHead = fullHead ?? referenceHead;
        identityHead = expectedHead;
        const latestRead = await readLineage(() => deps.readDraft(record.draftId));
        const latest = readPublicationDraftEnvelope(latestRead) ?? undefined;
        if (latest && (latest.draftId !== record.draftId || latest.revision !== record.revision || latest.status !== record.status)) {
          throw new CatalogPublicationError("catalog_publication_draft_advanced", "conflict",
            publicationIssue("catalog_publication_draft_advanced", "structural", "draft", payload.product.type.key));
        }
        const head = await readLineage(async () => {
          const current: CatalogPublicationReadResult = await deps.currentHead(record.productId);
          if (current?.outcome === "found") return headSchema.safeParse(current.head).data;
          if (current?.outcome === "unpublished") return null;
        });
        const comparisonHead = expected === undefined ? expectedHead : expected;
        if ([observedHead, head].some(observation => observation !== undefined
          && (!matchesPublicationHead(referenceHead, observation) || !matchesPublicationHead(comparisonHead, observation)))) {
          throw new CatalogPublicationError("head_conflict", "conflict");
        }
        const unavailable = latest === undefined || head === undefined || unresolvedImmutableHead;
        return { head, unavailable, expectedHead: fullHead };
      };
      const definitionDrift = () => refuse("catalog_definition_drift",
        publicationIssue("catalog_definition_drift", "structural", "product.type", payload.product.type.key).message);
      const definition = deps.registry.resolve({ ...payload.product.type });
      if (!definition?.validatorRef) return definitionDrift();
      const registryDigest = catalogDefinitionDigest(definition);
      const installed = await deps.installedDefinitionDigest({ ...payload.product.type });
      if (installed !== registryDigest) return definitionDrift();
      const evaluation = publication.evaluation ?? { evaluatedAt: record.createdAt };
      const issues: CatalogDraftIssue[] = [];
      if (record.status !== "open") issues.push({ path: "draft", code: "draft_abandoned" });
      const result = await evaluateCatalogPublication({ record, definition, installedDefinitionDigest: installed,
        expectedHead: referenceHead,
        evaluation, observations: publication, readCurrentHead: () => readHeadLineage(),
        attributeReferences: deps.attributeReferences, validatePrices: deps.validatePrices }, "preview");
      if (result.failure?.code === "head_conflict"
        || (result.failure?.code === "candidate_invalid" && !result.failure.diagnostic?.message)) return refuse(result.failure.code);
      if (unresolvedImmutableHead) {
        // An independent hard refusal still wins, but the unresolved reference cannot issue a digest.
        if (result.failure) return Promise.reject(result.failure);
        return refuse("candidate_dependency_unavailable");
      }
      if (result.head !== undefined) identityHead = result.head;
      const structural = result.structural.map(issue => issue.diagnostic);
      const blocked = result.structural.some(issue => issue.outcome !== "dependency_unavailable");
      const activationBlocked = result.activationIssues.some(issue => issue.outcome !== "dependency_unavailable");
      const activation = [...structural, ...result.activationIssues.map(issue => issue.diagnostic)];
      const first = result.failure?.diagnostic;
      if (first?.phase === "activation") {
        activation.splice(activation.indexOf(first), 1);
        activation.unshift(first);
      }
      const outcome = <T extends string>(complete: boolean, blocked: boolean, issues: readonly unknown[], passed: T) =>
        blocked ? "blocked-input" as const : !complete || issues.length ? "unknown" as const : passed;
      const preparation: CatalogCandidatePreview["preparation"] = { structural: { outcome: outcome(result.completed.structural, blocked, structural, "staged"), issues: structural },
        activation: { outcome: outcome(result.completed.activation, blocked || activationBlocked, activation, result.activating ? "ready" : "pending"),
          issues: [...activation, ...result.pending] } };
      issues.push(...activation.map(({ path, code }) => ({ path, code })));
      const candidateDigest = createHash("sha256").update('["catalog-candidate",1,').update(canonicalCatalogDraftJson(payload)).update(",")
        .update(canonicalCatalogDraftJson([{ ...payload.product.type, definitionDigest: installed }])).update(",")
        .update(canonicalCatalogDraftJson(identityHead)).update("]").digest("hex");
      const skus = Array.isArray(payload.skus) ? payload.skus : [];
      const priceOperationCount = skus.reduce((sum, sku) =>
        sum + (sku && typeof sku === "object" && "priceOperations" in sku && Array.isArray(sku.priceOperations)
          ? sku.priceOperations.length : 0), 0);
      return { candidateRef, candidateDigest, issues, preparation,
        impact: { productId: record.productId, skuIds: skus.flatMap(sku => typeof sku?.id === "string" ? [sku.id] : []), priceOperationCount } };
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
      const head = headSchema.nullable().safeParse(expectedHead).data;
      // A malformed caller head still reaches admission before it can be refused.
      const candidateRef = `v1:${draftId}@${draftRevision}/${head ? `${head.publicationId}@${head.revision}` : "unpublished"}`;
      return dispatch(candidateRef, service => service.prepareCandidate(query),
        (reference, raw) => reconstruct(candidateRef, reference, raw, { expectedHead }));
    },
    async validate(candidateRef) {
      return dispatch(candidateRef, service => service.validate(candidateRef),
        (reference, raw) => reconstruct(candidateRef, reference, raw));
    },
    async compareCandidate(input) {
      return dispatch(input.candidateRef, service => service.compareCandidate(input), async (reference, raw) => {
        const result = await reconstruct(input.candidateRef, reference, raw, { expectedHead: input.expectedHead });
        if (input.candidateDigest !== result.candidateDigest) return refuse("candidate_digest_mismatch");
        return result;
      });
    },
  };
}
