const CORE_SCOPE = Object.freeze({
  NONE: "none",
  DOCS_STATIC: "docs_static",
  PACKAGE_FAST: "package_fast",
  PRIVATE_PORTABILITY_FULL: "private_portability_full",
} as const);

type CoreCiScope = (typeof CORE_SCOPE)[keyof typeof CORE_SCOPE];
type CoreCiScopeOptions = { deletedFiles?: string[]; unknownFull?: boolean };

const FULL_ROOT_CONTROLS = new Set([
  ".github/workflows/pr-ci.yml",
  ".npmrc",
  "Dockerfile",
  "LICENSE",
  "config/oss-core-readiness-blockers.json",
  "package-lock.json",
  "package.json",
  "scripts/ci-scope.mjs",
  "scripts/ci-scope.test.ts",
  "scripts/control-plane-proof-v2.test.ts",
  "scripts/control-plane-proof-paths.ts",
  "scripts/core-ci-scope.ts",
  "scripts/core-ci-scope.test.ts",
  "scripts/core-ci-routing.test.ts",
  "scripts/core-release-candidate-proof.sh",
  "scripts/core-release-identity.test.ts",
  "scripts/oss-core-scaffold.test.ts",
  "scripts/oss-readiness-axes.ts",
  "scripts/oss-readiness-domain-boundary.ts",
  "scripts/oss-readiness-report.ts",
  "scripts/oss-readiness.test.ts",
  "scripts/oss-readiness.ts",
  "scripts/oss-technical-split-gate.ts",
  "src/lib/architectureGuardrails.test.ts",
  "src/lib/coreDomains.ts",
  "tsconfig.api.json",
  "tsconfig.app.json",
  "tsconfig.mcp.json",
  "tsconfig.node.json",
  "tsconfig.tests.json",
  "vite.config.ts",
  "vite.public-reference.config.ts",
  "vitest.config.ts",
]);

const FULL_LEGAL_AND_INERT_UI_CONTROLS = new Set([
  "packages/core/LICENSE",
  "packages/ui/package.json",
]);

export function classifyCoreCiScope(files: string[], options: CoreCiScopeOptions = {}) {
  const normalized = normalize(files);
  const deleted = normalize(options.deletedFiles ?? []);
  if (options.unknownFull) return result(CORE_SCOPE.PRIVATE_PORTABILITY_FULL);

  const changedScope = normalized.reduce<CoreCiScope>(maxScope, CORE_SCOPE.NONE);
  const deletedScope: CoreCiScope = deleted.some((file) => scopeForFile(file) !== CORE_SCOPE.NONE)
    ? CORE_SCOPE.PRIVATE_PORTABILITY_FULL
    : CORE_SCOPE.NONE;
  return result(higherScope(changedScope, deletedScope));
}

export function isCoreCiRelevantFile(file: string) {
  return scopeForFile(normalizePath(file)) !== CORE_SCOPE.NONE;
}

// Merge-group core scope (option B, docs/plan/proposals/core-proof-scope-gating.md):
// the queue classifies the exact final merge tree, but never drops below
// package_fast — every merge group still runs the light core proof, and every
// fail-closed rule of classifyCoreCiScope (deletions, root controls, unknown)
// still escalates to the full private-portability proof.
export function classifyMergeGroupCoreCiScope(files: string[], options: CoreCiScopeOptions = {}) {
  const computed = classifyCoreCiScope(files, options);
  if (computed.core_private_portability_full) return computed;
  return result(CORE_SCOPE.PACKAGE_FAST);
}

function maxScope(current: CoreCiScope, file: string): CoreCiScope {
  return higherScope(current, scopeForFile(file));
}

function scopeForFile(file: string): CoreCiScope {
  if (FULL_ROOT_CONTROLS.has(file) || FULL_LEGAL_AND_INERT_UI_CONTROLS.has(file)) {
    return CORE_SCOPE.PRIVATE_PORTABILITY_FULL;
  }
  if (/^scripts\/core-package-consumer-/.test(file)) {
    return CORE_SCOPE.PRIVATE_PORTABILITY_FULL;
  }
  if (!file.startsWith("packages/core/")) return CORE_SCOPE.NONE;

  const relative = file.slice("packages/core/".length);
  if (/^(?:api|scripts|\.github)\//.test(relative)) {
    return CORE_SCOPE.PRIVATE_PORTABILITY_FULL;
  }
  if (isPackageDocsStatic(relative)) return CORE_SCOPE.DOCS_STATIC;
  if (isPackageFast(relative)) return CORE_SCOPE.PACKAGE_FAST;
  return CORE_SCOPE.PRIVATE_PORTABILITY_FULL;
}

function isPackageDocsStatic(relative: string): boolean {
  return (
    relative.toLowerCase().endsWith(".md") ||
    /^(?:LICENSE|NOTICE)(?:\.|$)/i.test(relative)
  );
}

function isPackageFast(relative: string): boolean {
  return (
    /^(?:src|smoke|test|tests)\//.test(relative) ||
    /(?:^|\/)vitest\.config\.[cm]?[jt]s$/.test(relative) ||
    /^tsconfig\.smoke\.json$/.test(relative)
  );
}

function higherScope(left: CoreCiScope, right: CoreCiScope): CoreCiScope {
  const rank: Record<CoreCiScope, number> = {
    [CORE_SCOPE.NONE]: 0,
    [CORE_SCOPE.DOCS_STATIC]: 1,
    [CORE_SCOPE.PACKAGE_FAST]: 2,
    [CORE_SCOPE.PRIVATE_PORTABILITY_FULL]: 3,
  };
  return rank[right] > rank[left] ? right : left;
}

function result(scope: CoreCiScope) {
  return {
    core_ci_scope: scope,
    core_docs_static: scope === CORE_SCOPE.DOCS_STATIC,
    core_package_fast: scope === CORE_SCOPE.PACKAGE_FAST,
    core_private_portability_full: scope === CORE_SCOPE.PRIVATE_PORTABILITY_FULL,
    core_package_relevant: scope !== CORE_SCOPE.NONE,
  };
}

function normalize(files: string[]): string[] {
  return files.map(normalizePath).filter(Boolean).sort();
}

function normalizePath(file: string): string {
  return file.trim().replace(/\\/g, "/");
}

export { CORE_SCOPE };
