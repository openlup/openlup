import { privacyExportResponseSchema, erasureReceiptSchema, privacySubjectSchema, privacyEraseRequestSchema } from "./contracts/privacy.js";
import { PrivacyRefusal, type NativePrivacyStore, type PrivacyStore, type PrivacyUseCaseDependencies, type AuthorizedHumanAdministrator, type PrivacyOperations } from "./privacyPorts.js";
import type { PrivacySubjectRef, PrivacyEraseRequest, PrivacyExport, ErasureReceipt } from "./contracts/privacy.js";
import { hasOrderDraftReceiptDisposition, orderDraftReceiptContributorId } from "./orderDraftReceiptCoverage.js";
import { incompletePrivacyReceiptCoverage, missingPrivacyContributors, nativePrivacyUnavailable, validateOrderedPrivacyContributorIds, validateRequiredPrivacyContributorIds } from "./requiredPrivacyContributors.js";

type PrivacyStoreBinding<C> = {
  store: PrivacyStore<C>;
  native?: Pick<NativePrivacyStore<C>, "readRequiredContributorIds" | "findErasureReplay">;
};

function installedContributors<C>(deps: PrivacyUseCaseDependencies<C>, required?: readonly string[]) {
  const { contributors } = deps.registry;
  return required && !required.includes(orderDraftReceiptContributorId)
    ? contributors.filter(contributor => contributor.id !== orderDraftReceiptContributorId) : contributors;
}

function bindPrivacyStore<C>(store: PrivacyUseCaseDependencies<C>["store"]): PrivacyStoreBinding<C> {
  if (store.privacyRail !== "native") return { store };
  const { readRequiredContributorIds, findErasureReplay } = store;
  if (typeof readRequiredContributorIds !== "function" || typeof findErasureReplay !== "function") {
    throw nativePrivacyUnavailable(new Error("native_privacy_replay_and_declaration_required"));
  }
  return { store, native: { readRequiredContributorIds: readRequiredContributorIds.bind(store), findErasureReplay: findErasureReplay.bind(store) } };
}

async function withPrivacyTransaction<C, T>(deps: PrivacyUseCaseDependencies<C>, binding: PrivacyStoreBinding<C>, work: (context: C, required?: readonly string[]) => Promise<T>): Promise<T> {
  const { native } = binding;
  if (!native) return deps.unitOfWork.run(work);
  try {
    return await deps.unitOfWork.run(async context => {
      let required: readonly string[];
      try { required = validateRequiredPrivacyContributorIds(await native.readRequiredContributorIds(context)); }
      catch (cause) { throw nativePrivacyUnavailable(cause); }
      const registered = new Set(deps.registry.contributors.map(owner => owner.id));
      const missing = required.filter(id => !registered.has(id));
      if (missing.length) throw missingPrivacyContributors(missing, true);
      return work(context, required);
    });
  } catch (cause) {
    if (cause instanceof PrivacyRefusal) throw cause;
    throw nativePrivacyUnavailable(cause);
  }
}

export async function exportPersonalData<C>(deps: PrivacyUseCaseDependencies<C>, actor: AuthorizedHumanAdministrator, input: PrivacySubjectRef): Promise<PrivacyExport> {
  return exportUsingStore(deps, input);
}

async function exportUsingStore<C>(deps: PrivacyUseCaseDependencies<C>, input: PrivacySubjectRef, pinnedStore?: PrivacyStoreBinding<C>): Promise<PrivacyExport> {
  const subject = privacySubjectSchema.parse(input);
  const binding = pinnedStore ?? bindPrivacyStore(deps.store);
  const { store } = binding;
  return withPrivacyTransaction(deps, binding, async (context, required) => {
    const resolved = await store.resolve(context, subject);
    if (!resolved) {
      if (binding.native) await deps.verifyMissingSubject?.(context, subject);
      throw new PrivacyRefusal("PRIVACY_SUBJECT_NOT_FOUND");
    }
    const documents = [];
    for (const contributor of installedContributors(deps, required)) {
      const document = await contributor.export(context, resolved);
      if (document.contributorId !== contributor.id || document.version !== contributor.version) throw new PrivacyRefusal("PRIVACY_OWNERSHIP_UNDECLARED");
      documents.push(document);
    }
    return privacyExportResponseSchema.parse({ format: "personal-data.v1", generatedAt: deps.now().toISOString(), subject, documents, missingContributors: [...deps.registry.missingContributors], erasure: await store.findReceipt(context, subject) });
  });
}

export async function erasePersonalData<C>(deps: PrivacyUseCaseDependencies<C>, actor: AuthorizedHumanAdministrator, request: PrivacyEraseRequest): Promise<ErasureReceipt> {
  return eraseUsingStore(deps, actor, request);
}

async function eraseUsingStore<C>(deps: PrivacyUseCaseDependencies<C>, actor: AuthorizedHumanAdministrator, request: PrivacyEraseRequest, pinnedStore?: PrivacyStoreBinding<C>): Promise<ErasureReceipt> {
  const input = privacyEraseRequestSchema.parse(request);
  const binding = pinnedStore ?? bindPrivacyStore(deps.store);
  const { store } = binding;
  // Capability refusal precedes even opening a managed transaction or provider request.
  if (!store.erasureSupported) throw new PrivacyRefusal("MANAGED_PRIVACY_ERASURE_UNAVAILABLE");
  const missing = [...deps.registry.missingContributors];
  if (!deps.registry.contributors.some(c => c.id === "identity")) missing.push("identity");
  if (missing.length) throw binding.native
    ? missingPrivacyContributors(missing, false) : new PrivacyRefusal("PRIVACY_CONTRIBUTOR_MISSING");
  return withPrivacyTransaction(deps, binding, async (context, required) => {
    const contributors = installedContributors(deps, required);
    const receiptOwner = required && contributors.find(contributor => contributor.id === orderDraftReceiptContributorId);
    // Clear the receipt while the subject link is still available.
    const erasureOrder = receiptOwner ? [receiptOwner, ...contributors.filter(contributor => contributor !== receiptOwner)] : contributors;
    await store.prepareErasure(context);
    // Domain relation locks precede subject/member row locks and remain held to commit.
    for (const contributor of erasureOrder) await contributor.prepareErasure(context);
    const resolved = await store.resolve(context, input.subject, actor);
    await store.authorizeErasure(context, actor);
    const previous = binding.native
      ? qualifyReplay(await binding.native.findErasureReplay(context, input.subject, input.idempotencyKey), required!)
      : await store.findReceipt(context, input.subject, input.idempotencyKey);
    if (previous) return erasureReceiptSchema.parse({ ...previous, outcome: "ALREADY_ERASED" });
    if (!resolved) {
      if (binding.native) await deps.verifyMissingSubject?.(context, input.subject);
      throw new PrivacyRefusal("PRIVACY_SUBJECT_NOT_FOUND");
    }
    const assessments = [];
    for (const contributor of erasureOrder) {
      const assessment = await contributor.assessErasure(context, resolved);
      if (assessment.obligations.some(o => o.disposition === "unresolved")) throw new PrivacyRefusal("PRIVACY_OWNERSHIP_UNDECLARED");
      assessments.push(assessment);
    }
    const dispositions = [];
    for (const [index, contributor] of erasureOrder.entries()) {
      dispositions.push(await contributor.eraseOrRetain(context, resolved, assessments[index]!, actor));
    }
    if (receiptOwner && !hasOrderDraftReceiptDisposition(dispositions)) throw new PrivacyRefusal("PRIVACY_OWNERSHIP_UNDECLARED");
    const receipt = erasureReceiptSchema.parse({ version: "identity.erasure.v1", erasureId: deps.randomId(), completedAt: deps.now().toISOString(), outcome: "ERASED", obligations: dispositions.flatMap(d => d.obligations) });
    await store.saveReceipt(context, resolved, actor, input.idempotencyKey, receipt, dispositions);
    return receipt;
  });
}
function qualifyReplay(value: Awaited<ReturnType<NativePrivacyStore<unknown>["findErasureReplay"]>>, required: readonly string[]): ErasureReceipt | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).length !== 2 || !Object.hasOwn(value, "receipt") || !Object.hasOwn(value, "coveredContributorIds")) {
    throw new Error("privacy_replay_result_invalid");
  }
  const receipt = erasureReceiptSchema.parse(value.receipt);
  const covered = new Set(validateOrderedPrivacyContributorIds(value.coveredContributorIds, 20_000));
  const missing = required.filter(id => !covered.has(id));
  if (missing.length) throw incompletePrivacyReceiptCoverage(missing);
  return receipt;
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
  const { store } = deps;
  const pinnedStore = store.privacyRail === "native" ? bindPrivacyStore(store) : undefined;
  const operations: PrivacyOperations = {
    export: (_actor, subject) => exportUsingStore(deps, subject, pinnedStore),
    erase: (actor, input) => eraseUsingStore(deps, actor, input, pinnedStore),
  };
  if (pinnedStore) nativeOperations.add(Object.freeze(operations));
  return operations;
}
