import { privacyExportResponseSchema, erasureReceiptSchema, privacySubjectSchema, privacyEraseRequestSchema } from "./contracts/privacy.js";
import { PrivacyRefusal, type NativePrivacyStore, type PrivacyUseCaseDependencies, type AuthorizedHumanAdministrator, type PrivacyOperations } from "./privacyPorts.js";
import type { PrivacySubjectRef, PrivacyEraseRequest, PrivacyExport, ErasureReceipt } from "./contracts/privacy.js";
import { missingPrivacyContributors, nativePrivacyUnavailable, validateRequiredPrivacyContributorIds } from "./requiredPrivacyContributors.js";

async function withPrivacyTransaction<C, T>(deps: PrivacyUseCaseDependencies<C>, work: (context: C) => Promise<T>): Promise<T> {
  const { store } = deps;
  if (store.privacyRail !== "native") return deps.unitOfWork.run(work);
  try {
    return await deps.unitOfWork.run(async context => {
      let required: readonly string[];
      try { required = validateRequiredPrivacyContributorIds(await store.readRequiredContributorIds(context)); }
      catch (cause) { throw nativePrivacyUnavailable(cause); }
      const registered = new Set(deps.registry.contributors.map(owner => owner.id));
      const missing = required.filter(id => !registered.has(id));
      if (missing.length) throw missingPrivacyContributors(missing, true);
      return work(context);
    });
  } catch (cause) {
    if (cause instanceof PrivacyRefusal) throw cause;
    throw nativePrivacyUnavailable(cause);
  }
}

export async function exportPersonalData<C>(deps: PrivacyUseCaseDependencies<C>, actor: AuthorizedHumanAdministrator, input: PrivacySubjectRef): Promise<PrivacyExport> {
  const subject = privacySubjectSchema.parse(input);
  return withPrivacyTransaction(deps, async context => {
    const resolved = await deps.store.resolve(context, subject);
    if (!resolved) throw new PrivacyRefusal("PRIVACY_SUBJECT_NOT_FOUND");
    const documents = [];
    for (const contributor of deps.registry.contributors) {
      const document = await contributor.export(context, resolved);
      if (document.contributorId !== contributor.id || document.version !== contributor.version) throw new PrivacyRefusal("PRIVACY_OWNERSHIP_UNDECLARED");
      documents.push(document);
    }
    return privacyExportResponseSchema.parse({ format: "personal-data.v1", generatedAt: deps.now().toISOString(), subject, documents, missingContributors: [...deps.registry.missingContributors], erasure: await deps.store.findReceipt(context, subject) });
  });
}
export async function erasePersonalData<C>(deps: PrivacyUseCaseDependencies<C>, actor: AuthorizedHumanAdministrator, request: PrivacyEraseRequest): Promise<ErasureReceipt> {
  const input = privacyEraseRequestSchema.parse(request);
  // Capability refusal precedes even opening a managed transaction or provider request.
  if (!deps.store.erasureSupported) throw new PrivacyRefusal("MANAGED_PRIVACY_ERASURE_UNAVAILABLE");
  const missing = [...deps.registry.missingContributors];
  if (!deps.registry.contributors.some(c => c.id === "identity")) missing.push("identity");
  if (missing.length) throw deps.store.privacyRail === "native"
    ? missingPrivacyContributors(missing, false) : new PrivacyRefusal("PRIVACY_CONTRIBUTOR_MISSING");
  return withPrivacyTransaction(deps, async context => {
    await deps.store.prepareErasure(context);
    // Domain relation locks precede subject/member row locks and remain held to commit.
    for (const contributor of deps.registry.contributors) await contributor.prepareErasure(context);
    const resolved = await deps.store.resolve(context, input.subject, actor);
    await deps.store.authorizeErasure(context, actor);
    const previous = await deps.store.findReceipt(context, input.subject, input.idempotencyKey);
    if (previous) return erasureReceiptSchema.parse({ ...previous, outcome: "ALREADY_ERASED" });
    if (!resolved) throw new PrivacyRefusal("PRIVACY_SUBJECT_NOT_FOUND");
    const assessments = [];
    for (const contributor of deps.registry.contributors) {
      const assessment = await contributor.assessErasure(context, resolved);
      if (assessment.obligations.some(o => o.disposition === "unresolved")) throw new PrivacyRefusal("PRIVACY_OWNERSHIP_UNDECLARED");
      assessments.push(assessment);
    }
    const dispositions = [];
    for (let i = 0; i < deps.registry.contributors.length; i++) dispositions.push(await deps.registry.contributors[i]!.eraseOrRetain(context, resolved, assessments[i]!, actor));
    const receipt = erasureReceiptSchema.parse({ version: "identity.erasure.v1", erasureId: deps.randomId(), completedAt: deps.now().toISOString(), outcome: "ERASED", obligations: dispositions.flatMap(d => d.obligations) });
    await deps.store.saveReceipt(context, resolved, actor, input.idempotencyKey, receipt, dispositions);
    return receipt;
  });
}
declare const nativePrivacyBrand: unique symbol;
/** The serving module registers the native operations it constructs. */
export interface NativePrivacyOperations extends PrivacyOperations { readonly [nativePrivacyBrand]: true }
const nativeOperations = new WeakSet<object>();

export function isNativePrivacyOperations(value: unknown): value is NativePrivacyOperations {
  return typeof value === "object" && value !== null && nativeOperations.has(value);
}

export function createPrivacyOperations<C>(deps: PrivacyUseCaseDependencies<C> & { store: NativePrivacyStore<C> }): NativePrivacyOperations;
export function createPrivacyOperations<C>(deps: PrivacyUseCaseDependencies<C>): PrivacyOperations;
export function createPrivacyOperations<C>(deps: PrivacyUseCaseDependencies<C>): PrivacyOperations {
  const operations: PrivacyOperations = { export: (actor, subject) => exportPersonalData(deps, actor, subject), erase: (actor, input) => erasePersonalData(deps, actor, input) };
  if (deps.store.privacyRail === "native") {
    if (typeof deps.store.readRequiredContributorIds !== "function") throw nativePrivacyUnavailable(new Error("native_privacy_reader_required"));
    nativeOperations.add(Object.freeze(operations));
  }
  return operations;
}
