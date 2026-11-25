import { PLATFORM_MIGRATION_MANIFEST, type PlatformMigrationManifest, PLATFORM_BASELINE_FILE, QUALIFIED_ACQUISITION_FILE, QUALIFIED_IMPORT_FILE, QUALIFIED_OWNER_PATH_FILE, isChannelIngestMigrationPath, isQualifiedPlatformMigrationPath, checkoutOwnerGrantPath, checkoutOwnerLogin, checkoutOwnerRoutines, renderCheckoutOwnerGrant } from "./platform-migration-manifest.ts";
import { DuplicateJsonKeyError } from "./oss-strict-json.mts";
import { canonical, closedHistoricalForwardPaths, FORWARD_LISTS, MANAGED_BASELINE, REVIEWED_FORWARD_PATH, sqlSha256, type BatchedForwardBinding, type ForwardBinding, type ManagedCommerceForwardBinding, type NativeDeferredTrigger, type NativeStoreCheck, type NativeStoreForwardClass, type NativeStoreSlot, type NativeStoreUnique, type ReviewedForwardRegistry, type RuntimeForwardBinding, type SupportAuthorityForwardBinding } from "./migrations/types.ts";
import { blob, cachedDumpSqlStatements, git, headerAttributes, isExpandOnlyPlatformForward, NATIVE_SUCCESSOR_TABLE_SQL, readPrecedingBlobs, sqlStatements } from "./migrations/sql-tokenizer.ts";
import { assertSecurityDefinerSearchPath, isGrandfatheredSecurityDefinerForward } from "./migrations/security-definer.ts";
import { assertBatchedForward, assertChannelIngestForward, assertFunctionStatements, assertManagedCommerceForward, assertManagedInvoicingStatements, assertPortableCreationStatements, assertQualifiedOwnerPathForward, assertSupportAuthorityForward, batchedFunctionDefinitions, channelIngestShapes, functionSignature, identityHeaderSql, identityPrivilegeKeys, reviewedFunctionDefinitions, reviewedPolicyDefinitions, runtimePrivilegeKeys, runtimeReplacements, updatePolicyDefinitions } from "./migrations/historical-classes.ts";
import { assertExecutePredecessors, assertNativeStoreClassTransition, assertNativeStoreForward, assertNativeStoreSettingsTargets, checkoutForwardRefusal, checkoutOwnerControls, checkoutPredecessorRefusal, checkoutReplacementRefusal, checkoutSlotRefusal, expectedReplacedFunctionAttrs, isNativeStoreMigrationPath, isQualifiedCatalogueReadGrant, nativeStoreAddedForeignKeys, nativeStoreCreatedTable, nativeStoreFunctionDefinitions, nativeStoreNewSlotTimes, nativeStoreRevokePublicMessages, nativeStoreTriggerDefinition, previewAcceptanceSource, previewAcceptanceSourceSha256, previewNoopAcceptanceSql, qualifiedCatalogueReadTargets, qualifiedCatalogueStorageSelectSql, renderNativeDeferredTrigger, renderNativeStoreSettingsOwnerWindow, renderQualifiedSecurityDefiner, replacesCheckoutRoutine } from "./migrations/native-store-admission.ts";
import { approvalBinding, changedForwardApprovals, keepsApprovalOrder, readForwardRegistry, readReviewedForwardRegistry, sharedApproval } from "./migrations/registry.ts";

export {
  checkoutOwnerLogin, checkoutOwnerRoutines, renderCheckoutOwnerGrant,
  REVIEWED_FORWARD_PATH, MANAGED_BASELINE, sqlSha256,
  sqlStatements, isExpandOnlyPlatformForward, NATIVE_SUCCESSOR_TABLE_SQL,
  assertSecurityDefinerSearchPath,
  readReviewedForwardRegistry, changedForwardApprovals,
  reviewedFunctionDefinitions, reviewedPolicyDefinitions, assertQualifiedOwnerPathForward,
  assertPortableCreationStatements, assertManagedInvoicingStatements,
  batchedFunctionDefinitions, assertBatchedForward, assertManagedCommerceForward, assertSupportAuthorityForward, assertChannelIngestForward,
  qualifiedCatalogueStorageSelectSql, previewNoopAcceptanceSql, renderQualifiedSecurityDefiner,
  nativeStoreFunctionDefinitions, isNativeStoreMigrationPath, nativeStoreAddedForeignKeys, nativeStoreCreatedTable,
  renderNativeStoreSettingsOwnerWindow, nativeStoreRevokePublicMessages, nativeStoreTriggerDefinition, renderNativeDeferredTrigger,
  expectedReplacedFunctionAttrs, assertNativeStoreForward,
};
export type {
  BatchedForwardBinding, ManagedCommerceForwardBinding, SupportAuthorityForwardBinding,
  NativeStoreCheck, NativeStoreUnique, NativeDeferredTrigger, NativeStoreSlot, NativeStoreForwardClass, ReviewedForwardRegistry,
};

export function assertForwardApproval(root: string, base: string, head: string): void {
  const before = blob(root, base, REVIEWED_FORWARD_PATH), after = blob(root, head, REVIEWED_FORWARD_PATH);
  if (!before || !after) throw new Error("reviewed replacement registry must be approved separately before introducing SQL");
  const introducedChannel = channelIngestShapes.filter(shape => !blob(root, base, shape.path) && blob(root, head, shape.path));
  const addedPlatformPaths = git(root, ["diff", "--name-only", "--diff-filter=A", base, head, "--", "db/platform/migrations/"]).toString("utf8").trim().split("\n").filter(Boolean);
  if (before.equals(after) && introducedChannel.length === 0 && addedPlatformPaths.length === 0) return;
  const current = readReviewedForwardRegistry(after);
  const introducedNative = addedPlatformPaths.filter(path => isNativeStoreMigrationPath(path, current.nativeStoreForwardClass?.slots ?? []));
  if (before.equals(after) && introducedChannel.length === 0 && introducedNative.length === 0) return;
  const previous = readReviewedForwardRegistry(before);
  assertNativeStoreClassTransition(previous, current);
  nativeStoreNewSlotTimes(root, base, previous, current);
  for (const path of introducedNative) if (!current.nativeStoreForwardClass?.slots.some(slot => slot.path === path) || !current.nativeStoreForwards?.some(pin => pin.path === path)) {
    if (checkoutOwnerGrantPath.test(path)) throw checkoutSlotRefusal(path);
    throw new Error(`reviewed native store requires an exact slot and feature binding: ${path}`);
  }
  for (const { path } of introducedChannel) if (!current.channelIngestForwards?.some(pin => pin.path === path)) throw new Error(`reviewed M17 channel requires a binding: ${path}`);
  if (before.equals(after)) return;
  for (const path of changedForwardApprovals(before, after)) {
    if (previous.managedExactForwards?.some(pin => pin.path === path)) throw new Error("exact managed forward approvals are immutable within a feature change");
    if (isQualifiedPlatformMigrationPath(path) && previous.qualifiedInstallations?.some(pin => pin.path === path)) throw new Error("issued qualified installation approvals are immutable");
    if (blob(root, base, path) || !blob(root, head, path)) throw new Error(`reviewed replacement pin must be approved separately unless its SQL is introduced in this PR: ${path}`);
  }
}

// Release binds an approval by content, not by array index: its list entry, native slot and the shared fields stay
// unchanged. Entries before it keep their order; those whose SQL had landed before `base` (in its first parent, or in
// `base` itself for a root commit) are issued and also keep their content and index. Only approvals new at `head` may
// come before the ones `base` introduced, as when a landing merge places main's newer approvals before the candidate's own.
// The same rule reads mainline history. For append-only order on main, release relies on the strict registry reader's
// per-index identities and on assertNativeStoreClassTransition in the queue. A non-regular registry keeps its own refusal.
export function assertUnchangedForwardApproval(root: string, base: string, head: string, path: string): void {
  const before = blob(root, base, REVIEWED_FORWARD_PATH), after = blob(root, head, REVIEWED_FORWARD_PATH);
  try {
    if (before && after) {
      const prior = readForwardRegistry(before, true), current = readForwardRegistry(after, true);
      const parent = git(root, ["rev-list", "--parents", "-n", "1", base]).toString("utf8").trim().split(" ")[1] ?? base;
      const issued = new Set(git(root, ["ls-tree", "-r", "-z", "--name-only", parent, "--", "db/platform/migrations/", "supabase/migrations/"]).toString("utf8").split("\0"));
      const slots = (registry: ReviewedForwardRegistry) => registry.nativeStoreForwardClass?.slots ?? [];
      const binding = approvalBinding(prior, path), native = [prior, current].some(registry => slots(registry).some(slot => slot.path === path));
      if (binding && canonical(sharedApproval(prior)) === canonical(sharedApproval(current))
        && keepsApprovalOrder(prior[binding.list]!, current[binding.list] ?? [], issued, path)
        && (!native || keepsApprovalOrder(slots(prior), slots(current), issued, path))) return;
    }
  } catch (error) {
    if (error instanceof DuplicateJsonKeyError) throw error;
    // Other invalid historical approvals cannot authorize a release.
  }
  throw new Error("reviewed replacement allowlist must be approved separately before a feature PR adds SQL");
}

/** Run from trusted main. Candidate objects are data; their validator is never loaded. */
// The real-PostgreSQL catalog suites, their shared module and the files that select, run and containerize them. A native-SQL change that
// touches any of them, or anything under tests/setup/, is refused; code these files run is a review duty, not a control.
export const NATIVE_CATALOG_CONTROLS = [
  "tests/postgres/nativeStoreForwardCatalog.serviceRole.test.ts", "tests/postgres/nativeStoreForwardCatalog.noServiceRole.test.ts", "tests/postgres/nativeStoreForwardCatalog.shared.ts",
  "tests/postgres/subscriptionExactInstallation.test.ts",
  "tests/helpers/postgresContainer.ts", "vitest.config.ts", "scripts/run-vitest.mjs", "scripts/ci-test-scope.mjs",
  "scripts/ci-image-pull.mjs", "scripts/ci-image-mirror.mjs", "scripts/disposable-docker.mjs", "scripts/ci-vitest-duration-keys.ts", "scripts/coverage-summary-protocol.ts",
  "src/test/setup.ts", "src/checkout/machine/commerceRequestCache.ts", "config/ci-images.json", ".npmrc",
];
export function assertCoLocatedForwardApproval(root: string, base: string, head: string): void {
  const before = blob(root, base, REVIEWED_FORWARD_PATH), after = blob(root, head, REVIEWED_FORWARD_PATH);
  const prior = before ? readForwardRegistry(before, true) : undefined;
  for (const pin of prior?.managedExactForwards ?? []) {
    const issued = blob(root, base, pin.path);
    if (!issued) continue;
    if (!after) throw new Error("issued exact managed forward requires its approval registry");
    const proposed = blob(root, head, pin.path);
    if (!proposed || !issued.equals(proposed)) {
      throw new Error(`issued exact managed forward must retain its bytes: ${pin.path}`);
    }
  }
  if (before && prior && after && !before.equals(after)) {
    const candidate = readReviewedForwardRegistry(after);
    assertNativeStoreClassTransition(prior, candidate);
    nativeStoreNewSlotTimes(root, base, prior, candidate);
    for (const [index, pin] of (prior.managedExactForwards ?? []).entries()) {
      if (blob(root, base, pin.path) && canonical(candidate.managedExactForwards?.[index]) !== canonical(pin)) {
        throw new Error("issued exact managed forward approvals are immutable");
      }
    }
    const existingExactPaths = new Set(prior.managedExactForwards?.map(pin => pin.path));
    for (const pin of candidate.managedExactForwards ?? []) {
      if (!existingExactPaths.has(pin.path) && blob(root, base, pin.path)) {
        throw new Error(`exact managed forward approval must precede its SQL: ${pin.path}`);
      }
    }
    if (prior.channelIngestForwards !== undefined && candidate.channelIngestForwards === undefined) throw new Error("issued M17 channel class approval cannot be removed");
    for (const [index, entry] of (prior.channelIngestForwards ?? []).entries()) {
      if (canonical(candidate.channelIngestForwards?.[index]) !== canonical(entry)) throw new Error("issued M17 channel approvals are immutable");
    }
    for (const [index, entry] of (prior.qualifiedInstallations ?? []).entries()) {
      if (canonical(candidate.qualifiedInstallations?.[index]) !== canonical(entry)) {
        throw new Error("issued qualified installation approvals are immutable");
      }
    }
  }
  const added = git(root, ["diff", "--name-only", "--no-renames", "--diff-filter=A", "-z", base, head, "--", "db/platform/migrations/", "supabase/migrations/"]).toString("utf8").split("\0").filter((path) => path.endsWith(".sql"));
  const checkAddedSecurityDefiner = (registry: ReviewedForwardRegistry) => {
    const closed = closedHistoricalForwardPaths(registry);
    for (const path of added) {
      if (closed.has(path)) continue;
      const bytes = blob(root, head, path);
      if (bytes && !isGrandfatheredSecurityDefinerForward(path, bytes)) assertSecurityDefinerSearchPath(bytes, path);
    }
  };
  if (before && after && before.equals(after) && !added.some(path => isQualifiedPlatformMigrationPath(path) || isChannelIngestMigrationPath(path) || isNativeStoreMigrationPath(path, readReviewedForwardRegistry(after).nativeStoreForwardClass?.slots ?? []) || hasExactManagedForward(root, base, path))) {
    if (added.length > 0) checkAddedSecurityDefiner(readForwardRegistry(after, true));
    return;
  }
  if (added.length === 0) return; // Existing control-only preparation remains available.
  if (!before || !after) throw new Error("reviewed replacement registry must be approved separately before introducing SQL");
  const controls = ["scripts/oss-source-release-contract.ts", "scripts/reviewed-platform-forward.ts", "scripts/platform-migration-manifest.ts", "scripts/documentation-git.ts", "scripts/documentation-routing.ts", ...NATIVE_CATALOG_CONTROLS, "package.json", "package-lock.json"];
  const changed = git(root, ["diff", "--name-only", "--no-renames", "-z", base, head]).toString("utf8").split("\0");
  const releaseTool = (path: string) => /^scripts\/(?:agent-review-|oss-|source-|packages\/|migrations\/)/u.test(path) && !/\.test\.[cm]?[jt]sx?$/u.test(path);
  if (changed.some((path) => controls.includes(path) || path.startsWith(".github/") || path.startsWith("tests/setup/") || releaseTool(path))) throw new Error("reviewed replacement admission machinery must be approved separately before co-located SQL/pins");
  assertForwardApproval(root, base, head);
  const registry = readReviewedForwardRegistry(after);
  for (const list of FORWARD_LISTS) for (const entry of registry[list] ?? []) {
    if (added.includes(entry.path)) assertReviewedPlatformForward(root, base, head, entry.path, blob(root, head, entry.path)!);
  }
  checkAddedSecurityDefiner(registry);
}


/** Bind the full managed prefix, including companion table ACLs and DDL. */
export function managedForwardPrefixSha256(root: string, revision: string, path: string): string {
  const preceding = readPrecedingBlobs(root, revision, "supabase/migrations/", path, true);
  if (preceding[0]?.path !== MANAGED_BASELINE) throw new Error("exact managed forward requires the managed baseline");
  return sqlSha256(JSON.stringify(preceding.map(item => [item.path, sqlSha256(item.bytes)])));
}

export function hasExactManagedForward(root: string, revision: string, path: string): boolean {
  if (!path.startsWith("supabase/migrations/")) return false;
  const registry = blob(root, revision, REVIEWED_FORWARD_PATH);
  return registry !== undefined && (readForwardRegistry(registry, true).managedExactForwards?.some(pin => pin.path === path) ?? false);
}

/** Both required CI and release preparation use this exact path/byte/signature check. */
export function assertReviewedPlatformForward(root: string, base: string, head: string, path: string, bytes: Buffer, release = false): void {
  const checkout = checkoutOwnerGrantPath.test(path);
  const controlByte = (byte: number) => (byte < 0x20 && byte !== 0x09 && byte !== 0x0a) || byte === 0x7f;
  if (bytes.some(controlByte)) throw checkout ? checkoutForwardRefusal(path) : new Error(`reviewed replacement refuses control characters in a forward: ${path}`);
  const targetRegistry = blob(root, head, REVIEWED_FORWARD_PATH);
  if (!targetRegistry) throw checkout ? checkoutSlotRefusal(path) : new Error(`non-expand-only forward has no reviewed replacement approval: ${path}`);
  const registry = readReviewedForwardRegistry(targetRegistry);
  if (checkout && !registry.nativeStoreForwards?.some(pin => pin.path === path)) throw checkoutSlotRefusal(path);
  const exact = registry.managedExactForwards?.find(pin => pin.path === path);
  if (exact) {
    let approval = base;
    if (release) {
      const introductions = git(root, ["log", "--first-parent", "--format=%H", "--diff-filter=A", `${base}..${head}`, "--", path])
        .toString("utf8").trim().split("\n").filter(Boolean);
      if (introductions.length !== 1) throw new Error("exact managed forward requires one first-parent introduction");
      approval = git(root, ["rev-parse", `${introductions[0]}^`]).toString("utf8").trim();
      const introduction = introductions[0]!;
      assertUnchangedForwardApproval(root, approval, introduction, path);
      const introduced = blob(root, introduction, path);
      if (!introduced || sqlSha256(introduced) !== exact.sha256
        || managedForwardPrefixSha256(root, introduction, path) !== exact.prefixSha256) {
        throw new Error("exact managed forward introduction differs from upstream approval");
      }
    }
    // An upstream approval is mandatory, including when the candidate adds its own pin.
    assertUnchangedForwardApproval(root, approval, head, path);
    if (exact.sha256 !== sqlSha256(bytes)) throw new Error("exact managed forward bytes differ from upstream approval");
    if (exact.prefixSha256 !== managedForwardPrefixSha256(root, head, path)) throw new Error("exact managed forward managed prefix differs from upstream approval");
    if (!isGrandfatheredSecurityDefinerForward(path, bytes)) assertSecurityDefinerSearchPath(bytes, path);
    return;
  }
  const portable = path.startsWith("db/platform/migrations/");
  const candidates = portable ? [...registry.portableReplacementForwards ?? [], ...registry.portableCreationForwards ?? []] : [...registry.replacementForwards, ...registry.creationForwards, ...(registry.runtimeForwards ?? []), ...(registry.managedInvoicingForwards ?? [])];
  const forward = [...candidates, ...(registry.batchedForwards ?? []), ...(registry.managedCommerceForwards ?? []), ...(registry.supportAuthorityForwards ?? []), ...(registry.qualifiedInstallations ?? []), ...(registry.channelIngestForwards ?? []), ...(registry.nativeStoreForwards ?? [])].find((entry) => entry.path === path);
  if (!forward) throw new Error(`non-expand-only forward differs from reviewed replacement path or bytes: ${path}`);
  if (isQualifiedPlatformMigrationPath(path) && sqlSha256(bytes) !== forward.sha256) throw new Error(`qualified installation differs from its exact approved bytes: ${path}`);
  let approval = base;
  let introduction = head;
  if (release) {
    // Bind at the unique mainline introduction, never at a later repair of the pins.
    const commits = git(root, ["log", "--first-parent", "--format=%H", "--diff-filter=A", `${base}..${head}`, "--", path]).toString("utf8").trim().split("\n").filter(Boolean);
    if (commits.length !== 1) throw new Error("reviewed replacement requires one unambiguous forward introduction");
    introduction = commits[0]!;
    approval = git(root, ["rev-parse", `${commits[0]}^`]).toString("utf8").trim();
    git(root, ["merge-base", "--is-ancestor", approval, head]);
    try { assertUnchangedForwardApproval(root, approval, commits[0]!, path); }
    catch (error) {
      if (error instanceof DuplicateJsonKeyError) throw error;
      assertForwardApproval(root, approval, commits[0]!);
    }
    assertUnchangedForwardApproval(root, commits[0]!, head, path);
  } else {
    assertForwardApproval(root, base, head);
  }
  if (sqlSha256(bytes) !== forward.sha256) throw checkout ? checkoutForwardRefusal(path) : new Error(`non-expand-only forward differs from reviewed replacement path or bytes: ${path}`);
  const nativeSlot = registry.nativeStoreForwardClass?.slots.find(slot => slot.path === path);
  if (path.startsWith("db/platform/migrations/") && replacesCheckoutRoutine(bytes, nativeSlot)) {
    const manifestBytes = blob(root, head, PLATFORM_MIGRATION_MANIFEST);
    const manifest = manifestBytes && JSON.parse(manifestBytes.toString("utf8")) as PlatformMigrationManifest;
    const plans = !manifest ? [] : [manifest, ...(manifest.schemaVersion === 1 ? [] : [manifest.qualified]),
      ...(manifest.schemaVersion === 3 ? [manifest.qualifiedAdmin] : [])];
    const prefixes = plans.flatMap(({ forward }) => {
      const position = forward.findIndex(unit => unit.file === path);
      return position < 0 ? [] : [forward.slice(0, position)];
    });
    if (!prefixes.length || prefixes.some(prefix => !prefix.some(unit => {
      if (!checkoutOwnerGrantPath.test(unit.file)) return false;
      const pin = registry.nativeStoreForwards?.find(entry => entry.path === unit.file);
      const issued = blob(root, approval, unit.file);
      return pin?.sha256 === unit.sha256 && issued !== undefined && sqlSha256(issued) === unit.sha256;
    }))) throw checkoutReplacementRefusal(path);
  }
  if (isQualifiedPlatformMigrationPath(path)) {
    const priorRegistry = blob(root, approval, REVIEWED_FORWARD_PATH);
    if (priorRegistry && approvalBinding(readForwardRegistry(priorRegistry, true), path)) assertUnchangedForwardApproval(root, approval, head, path);
    else if (release) assertUnchangedForwardApproval(root, introduction, head, path);
    if (path === QUALIFIED_OWNER_PATH_FILE) {
      const acquisition = blob(root, head, QUALIFIED_ACQUISITION_FILE);
      const retained = blob(root, head, QUALIFIED_IMPORT_FILE);
      if (!acquisition || !retained) throw new Error("qualified owner path forward requires both issued definition sources");
      assertQualifiedOwnerPathForward(forward as ForwardBinding, bytes, [acquisition, retained]);
    }
    return;
  }
  const baselinePath = portable ? PLATFORM_BASELINE_FILE : MANAGED_BASELINE;
  const baseline = blob(root, approval, baselinePath);
  if (!baseline || (!portable && sqlSha256(baseline) !== registry.baselineSha256)) throw new Error("reviewed replacement immutable baseline drifted");
  if (registry.supportAuthorityForwards?.includes(forward as SupportAuthorityForwardBinding) || registry.channelIngestForwards?.includes(forward as BatchedForwardBinding) || registry.nativeStoreForwards?.includes(forward as ForwardBinding)) {
    const prefix = readPrecedingBlobs(root, head, portable ? "db/platform/migrations/" : "supabase/migrations/", path, true);
    if (registry.nativeStoreForwards?.includes(forward as ForwardBinding)) {
      const { slot, priceListBasisPredecessor, priceSetupPredecessors, checkoutPredecessor } = assertNativeStoreForward(registry, path, bytes, prefix);
      if (checkoutPredecessor) {
        const controlChanges = git(root, ["diff", "--name-only", approval, introduction, "--", ...checkoutOwnerControls]);
        if (controlChanges.length) throw checkoutForwardRefusal(path);
        const sourcePath = checkoutPredecessor.slot.path;
        const manifestBytes = blob(root, head, PLATFORM_MIGRATION_MANIFEST);
        const manifest = manifestBytes && JSON.parse(manifestBytes.toString("utf8")) as PlatformMigrationManifest;
        if (manifest && manifest.schemaVersion !== 1) {
          const sources = new Map(readPrecedingBlobs(root, head, "db/platform/migrations/", "db/platform/migrations/z", true)
            .map(source => [source.path, source.bytes]));
          for (const plan of [manifest.qualified, ...(manifest.schemaVersion === 3 ? [manifest.qualifiedAdmin] : [])]) {
            const position = plan.forward.findIndex(unit => unit.file === path);
            if (position < 0) throw checkoutPredecessorRefusal(PLATFORM_MIGRATION_MANIFEST);
            const issued = [plan.baseline, ...plan.forward.slice(0, position)].map(unit => {
              const source = sources.get(unit.file);
              if (!source || sqlSha256(source) !== unit.sha256) throw checkoutPredecessorRefusal(unit.file);
              return { path: unit.file, bytes: source };
            });
            assertExecutePredecessors(registry, [checkoutPredecessor.slot], issued, checkoutOwnerRoutines, true, prefix);
          }
        }
        const approved = blob(root, approval, REVIEWED_FORWARD_PATH);
        const registryAtApproval = approved && readForwardRegistry(approved, true);
        if (!registryAtApproval
          || canonical(registryAtApproval.nativeStoreForwardClass?.slots.find(entry => entry.path === sourcePath)) !== canonical(checkoutPredecessor.slot)
          || canonical(registryAtApproval.nativeStoreForwards?.find(entry => entry.path === sourcePath)) !== canonical(checkoutPredecessor.pin)
          || !blob(root, approval, sourcePath)?.equals(prefix.find(source => source.path === sourcePath)!.bytes)) {
          throw checkoutPredecessorRefusal(sourcePath);
        }
        if (release && (!blob(root, introduction, path)?.equals(bytes)
          || !blob(root, introduction, sourcePath)?.equals(prefix.find(source => source.path === sourcePath)!.bytes))) throw checkoutForwardRefusal(path);
      }
      if (slot.settingsOnlyFunctions) assertNativeStoreSettingsTargets(slot.settingsOnlyFunctions, readPrecedingBlobs(root, approval, "db/platform/migrations/", path, true));
      if (isQualifiedCatalogueReadGrant(slot)) {
        for (const [sourcePath] of qualifiedCatalogueReadTargets) {
          const issued = blob(root, approval, sourcePath);
          if (!issued?.equals(prefix.find(source => source.path === sourcePath)!.bytes)) throw new Error(`reviewed native store qualified catalogue read predecessor must already be issued: ${sourcePath}`);
        }
      }
      if (priceListBasisPredecessor) {
        const { path: sourcePath, sha256 } = priceListBasisPredecessor;
        const issued = blob(root, approval, sourcePath), approved = blob(root, approval, REVIEWED_FORWARD_PATH);
        const pin = approved && readForwardRegistry(approved, true).nativeStoreForwards?.find(entry => entry.path === sourcePath);
        if (!issued || sqlSha256(issued) !== sha256 || pin?.sha256 !== sha256) {
          throw new Error(`reviewed native store qualified price list basis SELECT predecessor must already be issued: ${sourcePath}`);
        }
      }
      if (priceSetupPredecessors) {
        const approved = blob(root, approval, REVIEWED_FORWARD_PATH);
        const pins = approved && readForwardRegistry(approved, true).nativeStoreForwards;
        for (const predecessor of priceSetupPredecessors) {
          const issued = blob(root, approval, predecessor.path);
          const pin = pins?.find(entry => entry.path === predecessor.path);
          if (!issued?.equals(prefix.find(source => source.path === predecessor.path)!.bytes) || canonical(pin) !== canonical(predecessor)) {
            throw new Error(`reviewed native store qualified price setup EXECUTE predecessor must already be issued: ${predecessor.path}`);
          }
        }
      }
      if (slot.previewNoopAcceptance) {
        const issued = blob(root, approval, previewAcceptanceSource);
        if (!issued || sqlSha256(issued) !== previewAcceptanceSourceSha256) throw new Error("reviewed native store preview acceptance CHECK predecessor must already be issued");
      }
    } else if (registry.channelIngestForwards?.includes(forward as BatchedForwardBinding)) assertChannelIngestForward(registry, path, bytes, prefix);
    else assertSupportAuthorityForward(registry, path, bytes, prefix);
    return;
  }
  if (registry.managedCommerceForwards?.includes(forward as ManagedCommerceForwardBinding)) {
    assertManagedCommerceForward(registry, path, bytes, readPrecedingBlobs(root, head, "supabase/migrations/", path, true));
    return;
  }
  if (registry.batchedForwards?.includes(forward as BatchedForwardBinding)) {
    const prefix = readPrecedingBlobs(root, head, portable ? "db/platform/migrations/" : "supabase/migrations/", path, false);
    const byPath = new Map(prefix.map(source => [source.path, source.bytes]));
    for (const prior of registry.batchedForwards!) {
      if (prior.path >= path || prior.path.startsWith("db/") !== portable) continue;
      const landed = byPath.get(prior.path);
      if (!landed || sqlSha256(landed) !== prior.sha256) throw new Error("reviewed batch requires every earlier same-rail pin landed first");
    }
    assertBatchedForward(forward as BatchedForwardBinding, bytes, prefix.map(source => source.bytes));
    return;
  }
  if (registry.portableCreationForwards?.includes(forward)) {
    assertPortableCreationStatements(bytes, readPrecedingBlobs(root, head, "db/platform/migrations/", path, false).map(source => source.bytes));
    return;
  }
  // Creation-only entries returned above; existing classes retain their function bindings.
  const functionForward = forward as ForwardBinding;
  const names = new Set(functionForward.functions.map(({ signature }) => signature.split("(")[0]!));
  const prior = reviewedFunctionDefinitions(baseline, names);
  const priorPolicies = reviewedPolicyDefinitions(baseline);
  const priorStatements = new Map<string, string>();
  const collectPriorStatements = (source: Buffer) => {
    for (const statement of cachedDumpSqlStatements(source)) {
      const header = /^CREATE(?: OR REPLACE)? FUNCTION (public\.[a-z_][a-z0-9_]*)\(([^)]*)\)\s+RETURNS\s+/iu.exec(identityHeaderSql(statement));
      if (header && names.has(header[1]!.toLowerCase())) priorStatements.set(functionSignature(header[1]!, header[2]!), statement);
    }
  };
  collectPriorStatements(baseline);
  // The portable manifest validator requires strict filename order and exact catalogue coverage.
  // Thus path order below is the same as portable installation order; never read the managed rail.
  const directory = portable ? "db/platform/migrations/" : "supabase/migrations/";
  for (const { path: priorPath, bytes: source } of readPrecedingBlobs(root, head, directory, path, false)) {
    if (priorPath === baselinePath) continue;
    for (const [signature, sha256] of reviewedFunctionDefinitions(source, names)) prior.set(signature, sha256);
    collectPriorStatements(source);
    updatePolicyDefinitions(priorPolicies, source);
  }
  const definitions = reviewedFunctionDefinitions(bytes);
  if (portable) {
    const statements = sqlStatements(bytes.toString("utf8"));
    const statement = statements[0]!;
    const preceding = priorStatements.get(functionForward.functions[0]!.signature);
    if (statements.length !== 1 || !/^CREATE OR REPLACE FUNCTION public\.[a-z_][a-z0-9_]*\(/u.test(statement)) throw new Error("reviewed portable replacement requires only one CREATE OR REPLACE FUNCTION");
    if (!preceding || headerAttributes(statement) !== headerAttributes(preceding)) throw new Error("reviewed portable replacement function attributes drifted");
  } else if (registry.runtimeForwards?.includes(forward as RuntimeForwardBinding)) {
    const runtime = forward as RuntimeForwardBinding;
    const identity = registry.runtimeForwards[1] === runtime;
    const privileges: string[] = [];
    const retiredPolicies: string[] = [];
    for (const statement of sqlStatements(bytes.toString("utf8"))) {
      if (/^(?:BEGIN|COMMIT);$/iu.test(statement)) continue;
      const header = /^CREATE OR REPLACE FUNCTION (public\.[a-z_][a-z0-9_]*)\(([^)]*)\)\s+RETURNS\s+/iu.exec(identityHeaderSql(statement));
      if (header && !identity) {
        const signature = functionSignature(header[1]!, header[2]!);
        const preceding = priorStatements.get(signature);
        if (!runtimeReplacements.has(signature) || !preceding || headerAttributes(statement) !== headerAttributes(preceding)) throw new Error("reviewed replacement runtime function attributes drifted");
        continue;
      }
      const retired = /^DROP POLICY ([a-z_]+) ON public\.([a-z_]+);$/u.exec(statement);
      if (retired && !identity) {
        const binding = runtime.retiredPolicies?.[retiredPolicies.length];
        if (privileges.length || !binding || binding.name !== retired[1] || binding.table !== retired[2] || priorPolicies.get(`${binding.table}.${binding.name}`) !== binding.beforeSha256) throw new Error("reviewed replacement runtime policy retirement differs from exact ordered preimages");
        retiredPolicies.push(statement);
        continue;
      }
      (identity ? identityPrivilegeKeys : runtimePrivilegeKeys)(statement);
      privileges.push(statement);
    }
    if (retiredPolicies.length !== (runtime.retiredPolicies?.length ?? 0)) throw new Error("reviewed replacement runtime has missing policy retirements");
    if (privileges.length !== runtime.privileges.length || privileges.some((statement, index) => statement !== runtime.privileges[index])) throw new Error("reviewed replacement runtime privileges differ from exact statement pins");
  } else if (registry.managedInvoicingForwards?.includes(functionForward)) {
    assertManagedInvoicingStatements(bytes, path);
  } else assertFunctionStatements(bytes, definitions);
  if (definitions.size !== functionForward.functions.length) throw new Error("reviewed replacement has missing or additional function signatures");
  for (const binding of functionForward.functions) {
    if (definitions.get(binding.signature) !== binding.afterSha256 || (prior.get(binding.signature) ?? null) !== binding.beforeSha256) throw new Error(`reviewed replacement definition drifted: ${binding.signature}`);
  }
}
