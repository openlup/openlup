import { CatalogCombinationError } from "./variantCombination.js";
import { CatalogPublicationError, publicationDiagnostic, publicationIssue, publicationRefuse,
  type EvaluationIssue, type PlatformCode } from "./publicationError.js";
import { catalogCombinationIssue } from "./draftV2Validation.js";
import type { CatalogAttributeReferencePort } from "./attributeReferencePort.js";
import { catalogPublicationClaim } from "./publicationOperationHelpers.js";
import {
  assertCatalogPublicationGrossMass, assertCatalogPublicationMassInputs, assertCatalogPublicationPreparation,
  catalogPublicationAffected, catalogPublicationIntegralGrams, catalogPublicationMediaIssue,
  catalogPublicationPreparationIssues, unresolvedPublicationDraftIssues,
} from "./publicationPreparation.js";
import {
  admitPublication, bindPublicationEvidence, isUnavailable, snapshot, unavailable,
  type AdmittedPublication, type BoundPublicationContext, type CatalogPublicationCompileInput,
  type CatalogPublicationEvaluateInput, type PublicationEvaluationRuntime, type PublicationMode,
  type PublicationPhase,
} from "./publicationAdmission.js";
import { applyPublicationPrefixes, bindPublicationSources } from "./publicationOperationReplay.js";
import {
  addPendingPreviewIssues, checkActivationResult, checkActivationSources,
  checkPhysicalSources, checkStructuralResult, type AssembledStructuralResult,
} from "./publicationReadinessChecks.js";

export type { CatalogPublicationCompileInput };
export {
  assertCatalogPublicationGrossMass, assertCatalogPublicationMassInputs, assertCatalogPublicationPreparation,
  catalogPublicationAffected, catalogPublicationClaim, catalogPublicationIntegralGrams,
  catalogPublicationMediaIssue, catalogPublicationPreparationIssues, unresolvedPublicationDraftIssues,
};

/** Interpret one sealed intent. A writer can consume the ordered operations
 * and price obligations after successful evaluation against its guarded facts.
 */
export async function evaluateCatalogPublication(input: CatalogPublicationEvaluateInput, mode: PublicationMode) {
  const attributeReferences = input.attributeReferences && {
    resolve: (references: Parameters<CatalogAttributeReferencePort["resolve"]>[0]) =>
      input.attributeReferences!.resolve(snapshot(references)[0]),
  };
  const structural: EvaluationIssue[] = [], activationIssues: EvaluationIssue[] = [];
  const issuesByPhase = { structural, activation: activationIssues };
  const position = { phase: "structural" as PublicationPhase, path: "product", subject: input.definition.key };
  const missing = (code: PlatformCode, path: string) => unavailable(publicationIssue(code, position.phase, path, position.subject));
  const completed = { structural: false, activation: false };
  const runtime: PublicationEvaluationRuntime = {
    input, mode, attributeReferences, structural, activationIssues, issuesByPhase,
    position, missing, completed, knownHead: undefined, activating: false, pending: [],
  };
  let failure: CatalogPublicationError | undefined;
  let structuralPlan: AssembledStructuralResult["compiled"] | undefined;
  try {
    const compiled = await planPublication();
    return { compiled, structuralPlan, structural, activationIssues, activating: runtime.activating,
      pending: runtime.pending, failure, completed, head: runtime.knownHead };
  } catch (error) {
    const refusal = error instanceof CatalogCombinationError
      ? new CatalogPublicationError(publicationIssue(error.code, position.phase, catalogCombinationIssue(error).path, position.subject)) : error;
    if (!(refusal instanceof CatalogPublicationError)) throw refusal;
    const diagnostic = publicationDiagnostic(refusal, position.phase, position.path, position.subject);
    const issues = issuesByPhase[diagnostic.phase === "activation" ? "activation" : "structural"];
    const issue = { diagnostic, outcome: refusal.outcome };
    if (isUnavailable(issue) && !refusal.stored) issues.push(issue);
    else { failure = new CatalogPublicationError(diagnostic, refusal.outcome); issues.unshift(issue); }
    return { compiled: undefined, structuralPlan, structural, activationIssues, activating: runtime.activating,
      pending: runtime.pending, failure, completed, head: runtime.knownHead };
  }

  async function planPublication() {
    let admitted!: AdmittedPublication;
    let ctx!: BoundPublicationContext;
    let assembled: AssembledStructuralResult | undefined;
    const compiledResult = () => ctx.documentExclusionUnavailable ? undefined : assembled?.compiled;
    // Donor: P is supabase/migrations/20261012074153_catalog_propagation_product_publication.sql.
    // M is supabase/migrations/20261012074151_catalog_propagation_membership.sql.
    // T is catalogPropagationDraftCompiler.ts in the donor overlay (15ef3b8cf).
    // Admission precedes all lineage checks; bind and compare each source operation in supplied order.
    // Core-W compares publication lineage at write time (P:815–817).
    // Phase                    Modes               Donor at 15ef3b8cf
    const phases = [
      { run: async () => { admitted = await admitPublication(runtime); } },                        // Admit                   all  P:420–442,482–485,745–747,808–809
      { run: async () => { ctx = await bindPublicationEvidence(runtime, admitted); } },            // Bind reads              all  P:508–594 (draft heads: P:560–569)
      { run: () => bindPublicationSources(ctx) },                                                  // Saved-operation sources all  P:595–672
      { run: () => checkPhysicalSources(ctx) },                                                    // Media and identity      all  P:674–691, T:106–117
      { run: () => checkActivationSources(ctx), activation: true },                                // Activation sources      P:263–292,502,548–558,683–697, T:133–152
      { run: () => applyPublicationPrefixes(ctx) },                                                // Ordered effects         all  P:815–929, M:91–98
      { run: async () => {
        assembled = await checkStructuralResult(ctx);
        completed.structural = true;
        if (!structural.length) structuralPlan = compiledResult();
      } },
      { run: async () => { await checkActivationResult(ctx, assembled); completed.activation = true; }, activation: true }, // Activation result       P:955–969
    ];
    for (const phase of phases) {
      if (phase.activation && mode === "first-decision") continue;
      position.phase = phase.activation ? "activation" : "structural";
      await phase.run();
    }
    if (mode === "preview") addPendingPreviewIssues(ctx, assembled);
    return compiledResult();
  }
}

export async function compileCatalogPublication(input: CatalogPublicationCompileInput, mode: Exclude<PublicationMode, "preview"> = "compile") {
  const result = await evaluateCatalogPublication(input, mode);
  if (result.failure) throw result.failure;
  const issues = [...result.structural, ...result.activationIssues];
  const issue = issues.find(entry => !isUnavailable(entry)) ?? issues[0];
  if (issue) throw new CatalogPublicationError(issue.diagnostic, issue.outcome);
  if (!result.compiled) return publicationRefuse("publication_preparation_unavailable", "dependency_unavailable");
  return result.compiled;
}
