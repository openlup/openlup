import { createHash } from "node:crypto";
import type { CatalogCandidateQuery, CatalogCandidatePreview, CatalogCandidateComparison } from "./contracts/candidate.js";
import type { CatalogDraftPayloadV2 } from "./contracts/draftV2.js";
import { catalogDraftPublicationStoredRecordSchema, catalogDraftV3ValidationPayload } from "./draftV3Schemas.js";
import type { CatalogDraftIssue } from "./contracts/productTypes.js";
import type { CatalogHeadRef, CatalogPublicationReadResult } from "./contracts/lifecycle.js";
import type { CatalogValidationPort } from "./publicationPorts.js";
import { canonicalCatalogDraftJson } from "./contracts/draft.js";
import { catalogDefinitionDigest } from "./catalogDefinitionDigest.js";
import { validateCatalogDraftV2 } from "./draftV2Validation.js";
import { z } from "./validation.js";
import { CatalogPublicationError, publicationDiagnostic, publicationIssue } from "./publicationError.js";
import { readPublicationDraftEnvelope, type PublicationDraftRecord } from "./publicationIntent.js";
import { matchesPublicationHead, publicationHeadSchema as headSchema, type CatalogCandidatePublicationDeps } from "./publicationEvidence.js";
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
/** Keep returned values distinct from a rejected lineage read. */
async function readLineage<T>(read: () => Promise<T | undefined>): Promise<T | undefined> {
  try { return await read(); } catch { return undefined; }
}

type CatalogCandidateService = CatalogValidationPort & {
  prepareCandidate(query: CatalogCandidateQuery): Promise<CatalogCandidatePreview>;
  compareCandidate(input: CatalogCandidateComparison): Promise<CatalogCandidatePreview>;
};

/** @internal The publication host supplies the platform's read owners. */
export function createCatalogCandidateServiceWithPublication(deps: Omit<CatalogCandidateDeps, "readDraft"> & {
  readDraft(draftId: string, revision?: number): Promise<PublicationDraftRecord | null>;
},
  publication?: CatalogCandidatePublicationDeps): CatalogCandidateService {
  function unknownPreparation(subject: string): NonNullable<CatalogCandidatePreview["preparation"]> {
    const result = { outcome: "unknown" as const, issues: [publicationIssue("publication_preparation_unavailable", "structural", "product.type", subject)] };
    return { structural: result, activation: result };
  }

  async function legacyIssues(payload: CatalogDraftPayloadV2, issues: CatalogDraftIssue[]) {
    const copy = () => JSON.parse(canonicalCatalogDraftJson(payload)) as CatalogDraftPayloadV2;
    const validation = await validateCatalogDraftV2(copy(), deps.registry, deps.attributeReferences);
    issues.push(...(validation.valid ? validation.readiness.publication.issues : validation.issues));
    await legacyReadIssues(payload, copy, issues);
  }

  async function legacyReadIssues(payload: CatalogDraftPayloadV2, copy: () => CatalogDraftPayloadV2, issues: CatalogDraftIssue[]) {
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
      else issues.push(...await deps.validatePrices(copy()));
    }
  }

  async function reconstruct(candidateRef: string, expected?: CatalogHeadRef | null): Promise<CatalogCandidatePreview> {
    try {
      const reference = parseCatalogCandidateReference(candidateRef);
      if (!reference) return refuse("candidate_invalid");
      const raw = await deps.readDraft(reference.draftId, reference.draftRevision);
      const preparePublication = raw?.payload?.schemaVersion === 3 || raw?.payload?.schemaVersion === 4;
      const record = preparePublication ? readPublicationDraftEnvelope(raw) : catalogDraftPublicationStoredRecordSchema.safeParse(raw).data;
      if (!record || record.draftId !== reference.draftId || record.revision !== reference.draftRevision) return refuse("candidate_invalid");
      const payload = record.payload;
      let identityPayload = payload;
      if (!payload?.product?.type) return refuse("candidate_invalid");
      const referenceHead = reference.head;
      let identityHead = referenceHead;
      const readHeadLineage = async (legacy = false) => {
        const resolved = referenceHead === null ? undefined : await readLineage(() => deps.resolveHead({ ...referenceHead }));
        const observedHead = headSchema.safeParse(resolved).data;
        if (legacy && referenceHead !== null) {
          if (resolved === undefined) return refuse("candidate_dependency_unavailable");
          if (!observedHead || !matchesPublicationHead(referenceHead, observedHead)) return refuse("head_conflict");
        }
        const fullHead = referenceHead === null ? undefined : expected ?? observedHead;
        const expectedHead = fullHead ?? referenceHead;
        identityHead = expectedHead;
        const latestRead = await readLineage(() => deps.readDraft(record.draftId));
        const latest = legacy ? latestRead : readPublicationDraftEnvelope(latestRead) ?? undefined;
        if (latest !== undefined && (!latest || latest.draftId !== record.draftId || latest.revision !== record.revision || latest.status !== record.status)) {
          if (legacy) return refuse("candidate_invalid");
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
          if (legacy) return refuse("head_conflict");
          throw new CatalogPublicationError("head_conflict", "conflict");
        }
        const unavailable = latest === undefined || head === undefined || referenceHead !== null && observedHead === undefined;
        if (legacy && unavailable) return refuse("candidate_dependency_unavailable");
        return { head, unavailable, expectedHead: fullHead };
      };
      // Older drafts keep the released lineage checks. Publication admission runs before lineage is compared.
      if (!preparePublication) await readHeadLineage(true);
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
        const copy = () => JSON.parse(canonicalCatalogDraftJson(payload)) as CatalogDraftPayloadV2;
        try {
          const rules = resolvePublicationRules(definition, evaluation);
          if (rules) {
            const validation = await validateCatalogDraftV2(copy(), { resolve: () => ({
              ...definition, validateContent: rules.validateContent,
            }) }, deps.attributeReferences);
            const draftIssues = validation.valid ? validation.readiness.publication.issues : validation.issues;
            issues.push(...draftIssues);
            const details = draftIssues.map(({ path, code }) => publicationIssue(code, "structural", path, definition.key));
            const outcome = validation.valid ? "unknown" : "blocked-input";
            preparation = { structural: { outcome, issues: details }, activation: { outcome, issues: details } };
          } else {
            await legacyIssues(payload, issues);
            preparation = unknownPreparation(definition.key);
          }
          if (rules) await legacyReadIssues(payload, copy, issues);
        } catch (error) {
          if (!(error instanceof CatalogPublicationError)) throw error;
          const issue = publicationDiagnostic(error, "structural",
            error.code === "catalog_publication_rules_binding_mismatch" ? "product.type" : "product.sharedContent", definition.key);
          issues.push({ code: issue.code, path: issue.path });
          preparation = { structural: { outcome: "blocked-input", issues: [issue] }, activation: { outcome: "blocked-input", issues: [issue] } };
        }
      }
      if (payload.schemaVersion === 3 && !definition.publicationRules && !publication) {
        const legacy = catalogDraftPublicationStoredRecordSchema.safeParse(raw);
        if (!legacy.success || legacy.data.payload.schemaVersion !== 3) return refuse("candidate_invalid");
        await readHeadLineage(true);
        identityPayload = legacy.data.payload;
        await legacyIssues(catalogDraftV3ValidationPayload(legacy.data.payload), issues);
        preparation = unknownPreparation(definition.key);
      } else if (preparePublication) {
        const result = await evaluateCatalogPublication({ record, definition, installedDefinitionDigest: installed,
          expectedHead: referenceHead === null ? null : expected ?? referenceHead,
          evaluation, observations: publication, readCurrentHead: () => readHeadLineage(),
          attributeReferences: deps.attributeReferences, validatePrices: deps.validatePrices }, "preview");
        if (result.failure?.code === "head_conflict"
          || (result.failure?.code === "candidate_invalid" && !result.failure.diagnostic?.message)) return refuse(result.failure.code);
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
        preparation = { structural: { outcome: outcome(result.completed.structural, blocked, structural, "staged"), issues: structural },
          activation: { outcome: outcome(result.completed.activation, blocked || activationBlocked, activation, result.activating ? "ready" : "pending"),
            issues: [...activation, ...result.pending] } };
        issues.push(...activation.map(({ path, code }) => ({ path, code })));
      }
      const candidateDigest = createHash("sha256").update('["catalog-candidate",1,').update(canonicalCatalogDraftJson(identityPayload)).update(",")
        .update(canonicalCatalogDraftJson([{ ...identityPayload.product.type, definitionDigest: installed }])).update(",")
        .update(canonicalCatalogDraftJson(identityHead)).update("]").digest("hex");
      const skus = Array.isArray(payload.skus) ? payload.skus : [];
      const priceOperationCount = payload.schemaVersion === 1 ? 0 : skus.reduce((sum, sku) =>
        sum + (sku && typeof sku === "object" && "priceOperations" in sku && Array.isArray(sku.priceOperations)
          ? sku.priceOperations.length : 0), 0);
      return { candidateRef, candidateDigest, issues, ...(preparation ? { preparation } : {}),
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
      const candidateRef = `v1:${draftId}@${draftRevision}/${expectedHead === null ? "unpublished" : `${expectedHead.publicationId}@${expectedHead.revision}`}`;
      return reconstruct(candidateRef, expectedHead);
    },
    async validate(candidateRef) { return reconstruct(candidateRef); },
    async compareCandidate(input) {
      const head = headSchema.nullable().safeParse(input.expectedHead);
      if (!head.success) return refuse("candidate_invalid");
      const result = await reconstruct(input.candidateRef, head.data);
      if (input.candidateDigest !== result.candidateDigest) return refuse("candidate_digest_mismatch");
      return result;
    },
  };
}
