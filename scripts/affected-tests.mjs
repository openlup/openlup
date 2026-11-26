#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_MAX_DEPTH = 8;

const IGNORED_DIRS = new Set([
  ".git",
  ".worktrees",
  "coverage",
  "dist",
  "node_modules",
  "playwright-report",
  "test-results",
]);

const DIRECT_TEST_PATTERN = /\.(?:test|spec)\.(?:ts|tsx|js|mjs|cjs)$/u;
const PACKAGE_TEST_PATTERN = /\.(?:test|spec)\.(?:ts|tsx|js|mjs)$/u;
const SCRIPT_TEST_PATTERN = /\.(?:test|spec)\.(?:ts|mjs)$/u;
const TS_TEST_PATTERN = /\.(?:test|spec)\.(?:ts|tsx)$/u;
const SCRIPT_SOURCE_PATTERN = /^scripts\/(.+)\.(?:ts|mts|cts|js|mjs|cjs)$/u;
const VITEST_MOCK_METHODS = new Set(["mock", "doMock", "importActual", "importMock"]);

const ROOT_VITEST_PATTERNS = [
  /^(?:api|mcp|scripts|server)\/.+\.(?:test|spec)\.ts$/u,
  /^packages\/(?:outbox|platform)\/test\/.+\.(?:test|spec)\.ts$/u,
  /^recipes\/.+\/tests\/.+\.(?:test|spec)\.ts$/u,
  /^src\/.+\.(?:test|spec)\.tsx?$/u,
  /^tests\/(?:golden-master|postgres|platform)\/.+\.(?:test|spec)\.ts$/u,
  /^tests\/preview\/checkout\/helpers\/.+\.test\.ts$/u,
  /^tests\/(?!preview\/)[^/]+\/.+\.(?:test|spec)\.tsx$/u,
];
const CORE_VITEST_PATTERN = /^packages\/core\/test\/.+\.(?:test|spec)\.(?:ts|tsx|js|mjs)$/u;
const VITEST_MOCK_HINT = /\bvi\.(?:mock|doMock|importActual|importMock)\s*\(/u;

const CONTRACT_PIN_RULES = [
  {
    match: (filePath) =>
      /^packages\/platform\/src\/[^/]+\/settings-data\.json$/u.test(filePath)
      || filePath === "packages/platform/settings-catalog.json",
    tests: [
      "scripts/settings-catalogue.test.ts",
      "packages/platform/test/operations/settingsCommand.test.ts",
      "packages/platform/test/operations/settingsCandidateParity.test.ts",
    ],
  },
  {
    match: (filePath) => /^examples\/neutral-store\/owned\/.+$/u.test(filePath),
    tests: [
      "packages/platform/test/operations/settingsCommand.test.ts",
      "packages/platform/test/operations/settingsRead.test.ts",
      "scripts/packages/distribution-cli-settings.test.ts",
    ],
  },
  {
    match: (filePath) => filePath.startsWith("examples/neutral-store/"),
    tests: [
      "scripts/packages/distribution-cli-proof.test.ts",
      "scripts/starter-browser-ci.test.ts",
    ],
  },
  {
    match: (filePath) =>
      /^packages\/[^/]+\/release-gates\.json$/u.test(filePath)
      || filePath.startsWith("packages/core/docs/guide/"),
    tests: [
      "scripts/packages/package-size-policy.test.ts",
      "scripts/documentation-cli.test.ts",
    ],
  },
  {
    match: (filePath) => filePath === "config/openlup-publication-catalog.json",
    tests: [
      "scripts/oss-published-tree-check.test.ts",
    ],
  },
  {
    match: (filePath) => filePath === "config/openlup-packages.json",
    tests: [
      "scripts/oss-published-tree-check.test.ts",
      "scripts/packages/package-size-policy.test.ts",
      "scripts/packages/packages-check.test.ts",
    ],
  },
  {
    match: (filePath) => filePath === "config/vitest-shard-weights.json",
    tests: [
      "scripts/ci-vitest-shard.test.ts",
    ],
  },
  {
    match: (filePath) => filePath === "config/ci-postgres-suite-closures.json",
    tests: [
      "scripts/ci-test-scope.test.ts",
    ],
  },
  {
    match: (filePath) => filePath === "config/ci-quarantine.json",
    tests: [
      "scripts/ci-quarantine.test.ts",
    ],
  },
  {
    match: (filePath) => filePath === "config/reviewed-platform-forwards.json",
    tests: [
      "scripts/platform-migration-manifest.test.ts",
      "scripts/reviewed-native-store-forward.test.ts",
    ],
  },
  {
    match: (filePath) => filePath === "config/doc-routing.json",
    tests: [
      "scripts/agent-review-derived-carriers.test.ts",
      "scripts/documentation-cli.test.ts",
    ],
  },
  {
    match: (filePath) => filePath === "config/environment-variables.json",
    tests: [
      "scripts/packages/release-bump.test.ts",
      "scripts/preflight.test.ts",
    ],
  },
  {
    match: (filePath) => /^supabase\/migrations\/[^/]+\.sql$/u.test(filePath),
    tests: [
      "scripts/platform-migration-manifest.test.ts",
      "scripts/pgtap-parity.test.ts",
    ],
  },
  {
    match: (filePath) => /^db\/platform\/migrations\/[^/]+\.sql$/u.test(filePath)
      || /^packages\/[^/]+\/sql\/[^/]+\.sql$/u.test(filePath),
    tests: [
      "scripts/platform-migration-manifest.test.ts",
      "scripts/packages/platform-migration-projection.test.ts",
      "scripts/pgtap-parity.test.ts",
      "scripts/sql-admit.test.ts",
    ],
  },
  {
    match: (filePath) => filePath === "docs/platform/DATA_AND_MIGRATIONS.md"
      || /^docs\/platform\/migrations\/[^/]+\.md$/u.test(filePath),
    tests: [
      "scripts/documentation-links.test.ts",
      "scripts/reviewed-native-store-forward.test.ts",
    ],
  },
];

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function toPosixRelative(rawPath, rootDir) {
  if (typeof rawPath !== "string") {
    return null;
  }
  const trimmed = rawPath.trim();
  if (!trimmed) {
    return null;
  }
  const normalizedInput = trimmed.split("\\").join("/");
  const resolvedRoot = resolve(rootDir);
  const absolutePath = resolve(resolvedRoot, normalizedInput);
  const rel = relative(resolvedRoot, absolutePath).split("\\").join("/");
  if (!rel || rel.startsWith("..") || rel.startsWith("/")) {
    return null;
  }
  return rel;
}

function isExistingFile(rootDir, relPath, cache = null) {
  if (cache) {
    const cached = cache.get(relPath);
    if (cached !== undefined) {
      return cached;
    }
  }
  let exists = false;
  try {
    exists = statSync(resolve(rootDir, relPath)).isFile();
  } catch {
    exists = false;
  }
  if (cache) {
    cache.set(relPath, exists);
  }
  return exists;
}

export function isTestFile(filePath) {
  return DIRECT_TEST_PATTERN.test(filePath);
}

export function classifyTestRunner(testPath) {
  const normalized = testPath.split("\\").join("/");
  if (ROOT_VITEST_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return "root-vitest";
  }
  if (CORE_VITEST_PATTERN.test(normalized)) {
    return "core-vitest";
  }
  return "separate";
}

function partitionByRunner(affectedTests) {
  const rootVitest = [];
  const coreVitest = [];
  const separate = [];
  for (const item of affectedTests) {
    const runner = classifyTestRunner(item.path);
    if (runner === "root-vitest") {
      rootVitest.push(item.path);
    } else if (runner === "core-vitest") {
      coreVitest.push(item.path);
    } else {
      separate.push(item.path);
    }
  }
  return {
    rootVitest: rootVitest.sort(compareCodeUnits),
    coreVitest: coreVitest.sort(compareCodeUnits),
    separate: separate.sort(compareCodeUnits),
  };
}

export function matchContractPinRules(changedFile, rootDir = REPOSITORY_ROOT) {
  const matched = [];
  for (const rule of CONTRACT_PIN_RULES) {
    if (rule.match(changedFile)) {
      for (const candidate of rule.tests) {
        if (isExistingFile(rootDir, candidate)) {
          matched.push(candidate);
        }
      }
    }
  }
  return [...new Set(matched)].sort(compareCodeUnits);
}

export function matchSiblingScriptTests(changedFile, rootDir = REPOSITORY_ROOT) {
  if (isTestFile(changedFile)) {
    return [];
  }
  const match = SCRIPT_SOURCE_PATTERN.exec(changedFile);
  if (!match) {
    return [];
  }
  const stem = match[1];
  const candidates = [
    `scripts/${stem}.test.ts`,
    `scripts/${stem}.test.mjs`,
    `scripts/${stem}.spec.ts`,
    `scripts/${stem}.spec.mjs`,
  ];
  return candidates.filter((candidate) => isExistingFile(rootDir, candidate)).sort(compareCodeUnits);
}

function scriptKindForPath(filePath) {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".tsx") || lower.endsWith(".jsx")) {
    return ts.ScriptKind.TSX;
  }
  return ts.ScriptKind.TS;
}

export function extractStaticImports(sourceText, filePath = "module.ts") {
  const specifiers = new Set();
  const preprocessed = ts.preProcessFile(sourceText, true, true);
  for (const entry of preprocessed.importedFiles) {
    const value = entry.fileName.trim();
    if (value) {
      specifiers.add(value);
    }
  }

  if (VITEST_MOCK_HINT.test(sourceText)) {
    const sourceFile = ts.createSourceFile(
      filePath,
      sourceText,
      ts.ScriptTarget.Latest,
      false,
      scriptKindForPath(filePath),
    );
    const visit = (node) => {
      if (
        ts.isCallExpression(node)
        && node.arguments.length >= 1
        && ts.isPropertyAccessExpression(node.expression)
        && ts.isIdentifier(node.expression.expression)
        && node.expression.expression.text === "vi"
        && VITEST_MOCK_METHODS.has(node.expression.name.text)
        && ts.isStringLiteralLike(node.arguments[0])
      ) {
        const value = node.arguments[0].text.trim();
        if (value) {
          specifiers.add(value);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  return [...specifiers].sort(compareCodeUnits);
}

function pickExportTarget(target) {
  if (typeof target === "string") {
    return target;
  }
  if (Array.isArray(target)) {
    for (const item of target) {
      const picked = pickExportTarget(item);
      if (picked) {
        return picked;
      }
    }
    return null;
  }
  if (target && typeof target === "object") {
    for (const key of ["core-source", "import", "default", "module", "node", "types"]) {
      if (key in target) {
        const picked = pickExportTarget(target[key]);
        if (picked) {
          return picked;
        }
      }
    }
    for (const value of Object.values(target)) {
      const picked = pickExportTarget(value);
      if (picked) {
        return picked;
      }
    }
  }
  return null;
}

function matchSubpathMapEntry(specifier, mapping) {
  if (!mapping || typeof mapping !== "object") {
    return null;
  }
  if (specifier in mapping) {
    return pickExportTarget(mapping[specifier]);
  }
  for (const [patternKey, patternValue] of Object.entries(mapping)) {
    if (!patternKey.includes("*")) {
      continue;
    }
    const [prefix, suffix] = patternKey.split("*");
    if (specifier.startsWith(prefix) && specifier.endsWith(suffix)) {
      const captured = specifier.slice(prefix.length, specifier.length - suffix.length);
      const rawTarget = pickExportTarget(patternValue);
      if (rawTarget) {
        return rawTarget.replace("*", captured);
      }
    }
  }
  return null;
}

export function loadWorkspacePackageExports(rootDir = REPOSITORY_ROOT) {
  const packagesDir = resolve(rootDir, "packages");
  const packages = new Map();
  if (!existsSync(packagesDir)) {
    return packages;
  }

  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const pkgJsonPath = resolve(packagesDir, entry.name, "package.json");
    if (!existsSync(pkgJsonPath)) {
      continue;
    }
    try {
      const manifest = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
      if (typeof manifest.name !== "string" || !manifest.name) {
        continue;
      }
      const exportsMap = manifest.exports && typeof manifest.exports === "object" ? manifest.exports : {};
      packages.set(manifest.name, {
        dir: `packages/${entry.name}`,
        exports: exportsMap,
      });
    } catch {
      // Ignore malformed package manifests during discovery.
    }
  }

  return packages;
}

export function loadSubpathImportsMaps(rootDir = REPOSITORY_ROOT) {
  const maps = new Map();

  const readImports = (manifestRelDir) => {
    const manifestPath = manifestRelDir
      ? resolve(rootDir, manifestRelDir, "package.json")
      : resolve(rootDir, "package.json");
    if (!existsSync(manifestPath)) {
      return;
    }
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (manifest.imports && typeof manifest.imports === "object") {
        maps.set(manifestRelDir, manifest.imports);
      }
    } catch {
      // Ignore malformed manifests during discovery.
    }
  };

  readImports("");
  const packagesDir = resolve(rootDir, "packages");
  if (existsSync(packagesDir)) {
    for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        readImports(`packages/${entry.name}`);
      }
    }
  }

  return maps;
}

function resolveCandidateFile(candidatePosix, rootDir, existingFileCache = null) {
  const normalized = posix.normalize(candidatePosix);
  if (!normalized || normalized.startsWith("..") || normalized.startsWith("/")) {
    return null;
  }

  const ext = extname(normalized);
  const candidates = [];

  if (ext === ".js") {
    const stem = normalized.slice(0, -3);
    candidates.push(normalized, `${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${stem}.mjs`);
  } else if (ext === ".jsx") {
    const stem = normalized.slice(0, -4);
    candidates.push(normalized, `${stem}.tsx`, `${stem}.ts`, `${stem}.js`);
  } else if (ext === ".mjs") {
    const stem = normalized.slice(0, -4);
    candidates.push(normalized, `${stem}.mts`, `${stem}.ts`);
  } else if (ext === ".cjs") {
    const stem = normalized.slice(0, -4);
    candidates.push(normalized, `${stem}.cts`, `${stem}.ts`);
  } else if (normalized.endsWith(".d.ts")) {
    const stem = normalized.slice(0, -5);
    candidates.push(`${stem}.ts`, `${stem}.tsx`, `${stem}.js`, normalized);
  } else if (ext) {
    candidates.push(normalized);
  } else {
    candidates.push(
      `${normalized}.ts`,
      `${normalized}.tsx`,
      `${normalized}.js`,
      `${normalized}.mjs`,
      `${normalized}.cjs`,
      `${normalized}/index.ts`,
      `${normalized}/index.tsx`,
      `${normalized}/index.js`,
      `${normalized}/index.mjs`,
    );
  }

  for (const candidate of candidates) {
    if (isExistingFile(rootDir, candidate, existingFileCache)) {
      return candidate;
    }
  }
  return null;
}

function resolveMappedTarget(baseDir, rawTarget, rootDir, existingFileCache = null) {
  const cleanedTarget = rawTarget.replace(/^\.\//u, "");
  const sourceTarget = cleanedTarget.startsWith("dist/")
    ? `src/${cleanedTarget.slice("dist/".length)}`
    : cleanedTarget;
  const fromSrc = resolveCandidateFile(
    baseDir ? posix.join(baseDir, sourceTarget) : sourceTarget,
    rootDir,
    existingFileCache,
  );
  if (fromSrc) {
    return fromSrc;
  }
  return resolveCandidateFile(
    baseDir ? posix.join(baseDir, cleanedTarget) : cleanedTarget,
    rootDir,
    existingFileCache,
  );
}

function resolveWorkspacePackageImport(specifier, rootDir, packageExportsMap, existingFileCache = null) {
  for (const [pkgName, pkgInfo] of packageExportsMap.entries()) {
    if (specifier !== pkgName && !specifier.startsWith(`${pkgName}/`)) {
      continue;
    }
    const subpath = specifier === pkgName ? "." : `./${specifier.slice(pkgName.length + 1)}`;
    const target = matchSubpathMapEntry(subpath, pkgInfo.exports);
    if (target) {
      const resolved = resolveMappedTarget(pkgInfo.dir, target, rootDir, existingFileCache);
      if (resolved) {
        return resolved;
      }
    }

    if (subpath !== ".") {
      const fallbackRel = subpath.slice(2);
      const fromSrcFallback = resolveCandidateFile(
        posix.join(pkgInfo.dir, "src", fallbackRel),
        rootDir,
        existingFileCache,
      );
      if (fromSrcFallback) {
        return fromSrcFallback;
      }
    } else {
      const fromIndexFallback = resolveCandidateFile(
        posix.join(pkgInfo.dir, "src", "index"),
        rootDir,
        existingFileCache,
      );
      if (fromIndexFallback) {
        return fromIndexFallback;
      }
    }
    return null;
  }
  return null;
}

function resolveSubpathImport(specifier, fromFile, rootDir, subpathImportsMaps, existingFileCache = null) {
  const normalizedFrom = fromFile.split("\\").join("/");
  const candidateDirs = [];
  const packageMatch = /^(packages\/[^/]+)\//u.exec(normalizedFrom);
  if (packageMatch) {
    candidateDirs.push(packageMatch[1]);
  }
  candidateDirs.push("");

  for (const manifestDir of candidateDirs) {
    const mapping = subpathImportsMaps.get(manifestDir);
    if (!mapping) {
      continue;
    }
    const target = matchSubpathMapEntry(specifier, mapping);
    if (target) {
      const resolved = resolveMappedTarget(manifestDir, target, rootDir, existingFileCache);
      if (resolved) {
        return resolved;
      }
    }
  }
  return null;
}

export function resolveImportPath(
  specifier,
  fromFile,
  rootDir = REPOSITORY_ROOT,
  packageExportsMap = null,
  subpathImportsMaps = null,
  existingFileCache = null,
) {
  if (!specifier || specifier.startsWith("node:")) {
    return null;
  }

  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    const fromDir = posix.dirname(fromFile.split("\\").join("/"));
    const joined = posix.join(fromDir, specifier);
    return resolveCandidateFile(joined, rootDir, existingFileCache);
  }

  if (specifier.startsWith("@/")) {
    return resolveCandidateFile(`src/${specifier.slice(2)}`, rootDir, existingFileCache);
  }

  if (specifier.startsWith("#")) {
    const importsMaps = subpathImportsMaps ?? loadSubpathImportsMaps(rootDir);
    return resolveSubpathImport(specifier, fromFile, rootDir, importsMaps, existingFileCache);
  }

  const exportsMap = packageExportsMap ?? loadWorkspacePackageExports(rootDir);
  if (specifier.startsWith("@openlup/")) {
    return resolveWorkspacePackageImport(specifier, rootDir, exportsMap, existingFileCache);
  }

  return null;
}

function walkMatchingFiles(rootDir, startRelDir, matcher, results) {
  const startAbs = resolve(rootDir, startRelDir);
  if (!existsSync(startAbs)) {
    return;
  }
  const stack = [startRelDir];
  while (stack.length > 0) {
    const currentRel = stack.pop();
    const currentAbs = resolve(rootDir, currentRel);
    let entries;
    try {
      entries = readdirSync(currentAbs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) {
          stack.push(posix.join(currentRel, entry.name));
        }
      } else if (entry.isFile()) {
        const fileRel = posix.join(currentRel, entry.name);
        if (matcher(fileRel)) {
          results.add(fileRel);
        }
      }
    }
  }
}

export function collectTestFiles(rootDir = REPOSITORY_ROOT) {
  const found = new Set();

  // packages/**/test/**/*.test.{ts,tsx,js,mjs}
  const packagesAbs = resolve(rootDir, "packages");
  if (existsSync(packagesAbs)) {
    for (const entry of readdirSync(packagesAbs, { withFileTypes: true })) {
      if (entry.isDirectory() && !IGNORED_DIRS.has(entry.name)) {
        walkMatchingFiles(
          rootDir,
          posix.join("packages", entry.name, "test"),
          (fileRel) => PACKAGE_TEST_PATTERN.test(fileRel),
          found,
        );
      }
    }
  }

  // scripts/**/*.test.{ts,mjs}
  walkMatchingFiles(rootDir, "scripts", (fileRel) => SCRIPT_TEST_PATTERN.test(fileRel), found);

  // tests/**/*.{test,spec}.{ts,tsx}
  walkMatchingFiles(rootDir, "tests", (fileRel) => TS_TEST_PATTERN.test(fileRel), found);

  // src/**/*.{test,spec}.{ts,tsx}
  walkMatchingFiles(rootDir, "src", (fileRel) => TS_TEST_PATTERN.test(fileRel), found);

  // api/**/*.{test,spec}.{ts,tsx}, server/**/*.{test,spec}.{ts,tsx}, mcp/**/*.{test,spec}.{ts,tsx}
  walkMatchingFiles(rootDir, "api", (fileRel) => TS_TEST_PATTERN.test(fileRel), found);
  walkMatchingFiles(rootDir, "server", (fileRel) => TS_TEST_PATTERN.test(fileRel), found);
  walkMatchingFiles(rootDir, "mcp", (fileRel) => TS_TEST_PATTERN.test(fileRel), found);

  // recipes/**/tests/**/*.{test,spec}.{ts,tsx}
  walkMatchingFiles(
    rootDir,
    "recipes",
    (fileRel) => /(?:^|\/)tests\/.+\.(?:test|spec)\.(?:ts|tsx)$/u.test(fileRel),
    found,
  );

  return [...found].sort(compareCodeUnits);
}

export function findAffectedTests({
  changedFiles = [],
  rootDir = REPOSITORY_ROOT,
  maxDepth = DEFAULT_MAX_DEPTH,
  includePostgres = true,
} = {}) {
  const normalizedChanged = [...new Set(
    changedFiles
      .map((filePath) => toPosixRelative(filePath, rootDir))
      .filter((filePath) => filePath !== null),
  )].sort(compareCodeUnits);

  const reasonsByTest = new Map();
  const addReason = (testPath, reason) => {
    if (!includePostgres && testPath.startsWith("tests/postgres/")) {
      return;
    }
    let reasons = reasonsByTest.get(testPath);
    if (!reasons) {
      reasons = new Set();
      reasonsByTest.set(testPath, reasons);
    }
    reasons.add(reason);
  };

  // 1. Direct test matches
  for (const changedFile of normalizedChanged) {
    if (isTestFile(changedFile) && isExistingFile(rootDir, changedFile)) {
      addReason(changedFile, "direct");
    }
  }

  // 2. Contract-pin rules
  for (const changedFile of normalizedChanged) {
    for (const pinnedTest of matchContractPinRules(changedFile, rootDir)) {
      addReason(pinnedTest, "contract-pin");
    }
  }

  // 3. Sibling CLI tests for scripts/ entrypoints invoked as subprocesses
  for (const changedFile of normalizedChanged) {
    for (const siblingTest of matchSiblingScriptTests(changedFile, rootDir)) {
      addReason(siblingTest, "sibling-test");
    }
  }

  // 4. Reverse import graph (transitive reverse closure up to maxDepth)
  if (normalizedChanged.length > 0 && maxDepth > 0) {
    const testFiles = collectTestFiles(rootDir);
    const testFileSet = new Set(testFiles);
    const packageExportsMap = loadWorkspacePackageExports(rootDir);
    const subpathImportsMaps = loadSubpathImportsMaps(rootDir);
    const existingFileCache = new Map();
    const directImportsCache = new Map();

    const getDirectImports = (filePath) => {
      const cached = directImportsCache.get(filePath);
      if (cached) {
        return cached;
      }
      let source;
      try {
        source = readFileSync(resolve(rootDir, filePath), "utf8");
      } catch {
        directImportsCache.set(filePath, []);
        return [];
      }
      const specifiers = extractStaticImports(source, filePath);
      const resolved = [];
      for (const specifier of specifiers) {
        const target = resolveImportPath(
          specifier,
          filePath,
          rootDir,
          packageExportsMap,
          subpathImportsMaps,
          existingFileCache,
        );
        if (target && target !== filePath) {
          resolved.push(target);
        }
      }
      const uniqueResolved = [...new Set(resolved)];
      directImportsCache.set(filePath, uniqueResolved);
      return uniqueResolved;
    };

    // Expand forward from test files up to `maxDepth` hops and record reverse edges.
    const reverseAdj = new Map();
    let frontier = [...testFiles];
    const expanded = new Set();

    for (let depth = 0; depth < maxDepth && frontier.length > 0; depth += 1) {
      const nextFrontier = [];
      for (const filePath of frontier) {
        if (expanded.has(filePath)) {
          continue;
        }
        expanded.add(filePath);
        const imports = getDirectImports(filePath);
        for (const target of imports) {
          let dependents = reverseAdj.get(target);
          if (!dependents) {
            dependents = new Set();
            reverseAdj.set(target, dependents);
          }
          dependents.add(filePath);
          if (!expanded.has(target)) {
            nextFrontier.push(target);
          }
        }
      }
      frontier = nextFrontier;
    }

    // BFS along reverse edges from changedFiles up to `maxDepth`.
    const visitedDepth = new Map();
    const queue = [];
    for (const changedFile of normalizedChanged) {
      visitedDepth.set(changedFile, 0);
      queue.push({ filePath: changedFile, depth: 0 });
    }

    let head = 0;
    while (head < queue.length) {
      const { filePath, depth } = queue[head++];
      if (depth >= maxDepth) {
        continue;
      }
      const dependents = reverseAdj.get(filePath);
      if (!dependents) {
        continue;
      }
      const nextDepth = depth + 1;
      for (const dependent of dependents) {
        if (testFileSet.has(dependent)) {
          addReason(dependent, "import-graph");
        }
        const prevDepth = visitedDepth.get(dependent);
        if (prevDepth === undefined || nextDepth < prevDepth) {
          visitedDepth.set(dependent, nextDepth);
          queue.push({ filePath: dependent, depth: nextDepth });
        }
      }
    }
  }

  const affectedTests = [...reasonsByTest.entries()]
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([path, reasons]) => ({
      path,
      reasons: [...reasons].sort(compareCodeUnits),
    }));

  return {
    changedFiles: normalizedChanged,
    affectedTests,
    runners: partitionByRunner(affectedTests),
  };
}

const USAGE = "Usage: node scripts/affected-tests.mjs [--base <ref>] [--files <p1,p2,...>] [--max-depth <n>] [--json] [--run] [--dry-run] [--hosted] [--no-postgres] [-- <vitest-args>]";

function parseNonNegativeInt(raw, flagName) {
  if (!/^\d+$/u.test(raw)) {
    throw new Error(`${flagName} requires a non-negative integer`);
  }
  return Number.parseInt(raw, 10);
}

export function parseAffectedArgs(argv) {
  let base = null;
  let files = null;
  let json = false;
  let run = false;
  let dryRun = false;
  let hosted = false;
  let noPostgres = false;
  let maxDepth = DEFAULT_MAX_DEPTH;
  const vitestArgs = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      vitestArgs.push(...argv.slice(index + 1));
      break;
    }
    if (arg === "--base") {
      base = argv[++index] ?? "";
      if (!base) {
        throw new Error("--base requires a non-empty git ref");
      }
    } else if (arg.startsWith("--base=")) {
      base = arg.slice("--base=".length);
      if (!base) {
        throw new Error("--base requires a non-empty git ref");
      }
    } else if (arg === "--files") {
      const raw = argv[++index] ?? "";
      if (!raw) {
        throw new Error("--files requires a comma-separated list of file paths");
      }
      files = [...(files ?? []), ...raw.split(",").map((item) => item.trim()).filter(Boolean)];
    } else if (arg.startsWith("--files=")) {
      const raw = arg.slice("--files=".length);
      if (!raw) {
        throw new Error("--files requires a comma-separated list of file paths");
      }
      files = [...(files ?? []), ...raw.split(",").map((item) => item.trim()).filter(Boolean)];
    } else if (arg === "--max-depth") {
      const raw = argv[++index] ?? "";
      maxDepth = parseNonNegativeInt(raw, "--max-depth");
    } else if (arg.startsWith("--max-depth=")) {
      maxDepth = parseNonNegativeInt(arg.slice("--max-depth=".length), "--max-depth");
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--run") {
      run = true;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--hosted") {
      hosted = true;
    } else if (arg === "--no-postgres") {
      noPostgres = true;
    } else {
      throw new Error(`Unknown option: ${arg}\n${USAGE}`);
    }
  }

  return { base, files, json, run, dryRun, hosted, noPostgres, maxDepth, vitestArgs };
}

const FIXED_GIT_PATHS = [
  "/usr/bin/git",
  "/opt/homebrew/bin/git",
  "/usr/local/bin/git",
];

function resolveFixedGitBinary() {
  for (const candidate of FIXED_GIT_PATHS) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error("Unable to locate git binary in fixed system directories.");
}

export function resolveDefaultBaseRef(rootDir = REPOSITORY_ROOT) {
  const gitBin = resolveFixedGitBinary();
  const mergeBase = spawnSync(gitBin, ["merge-base", "HEAD", "origin/main"], {
    cwd: rootDir,
    encoding: "utf8",
  });
  if (mergeBase.status === 0) {
    const sha = mergeBase.stdout.trim();
    if (/^[0-9a-f]{40}$/u.test(sha)) {
      return sha;
    }
  }
  return "HEAD";
}

export function collectChangedFilesFromGit(baseRef, rootDir = REPOSITORY_ROOT) {
  const gitBin = resolveFixedGitBinary();
  const diffOutput = execFileSync(gitBin, ["diff", "--name-only", baseRef], {
    cwd: rootDir,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  const untrackedOutput = execFileSync(gitBin, ["ls-files", "--others", "--exclude-standard"], {
    cwd: rootDir,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return [...new Set([
    ...diffOutput.split(/\r?\n/u),
    ...untrackedOutput.split(/\r?\n/u),
  ].map((line) => line.trim()).filter(Boolean))].sort(compareCodeUnits);
}

export function formatAffectedTestsText({
  base,
  changedFiles,
  affectedTests,
  runners = partitionByRunner(affectedTests),
  hosted = false,
  vitestArgs = [],
}) {
  const lines = [];
  if (base) {
    lines.push(`Base ref: ${base}`);
  }
  lines.push(`Changed files (${changedFiles.length}):`);
  for (const filePath of changedFiles) {
    lines.push(`  - ${filePath}`);
  }
  lines.push(`Affected tests (${affectedTests.length}):`);
  for (const item of affectedTests) {
    lines.push(`  - ${item.path} [${item.reasons.join(", ")}]`);
  }
  if (runners.rootVitest.length > 0) {
    const suffix = vitestArgs.length > 0 ? ` ${vitestArgs.join(" ")}` : "";
    lines.push("");
    lines.push("Run command:");
    lines.push(
      hosted
        ? `npm run test:hosted -- ${runners.rootVitest.join(" ")}${suffix}`
        : `npx --no -- vitest run ${runners.rootVitest.join(" ")}${suffix}`,
    );
  }
  if (runners.coreVitest.length > 0) {
    lines.push("");
    lines.push(`Core package tests (${runners.coreVitest.length}, separate runner):`);
    for (const filePath of runners.coreVitest) {
      lines.push(`  - ${filePath}`);
    }
    lines.push("npm --workspace @openlup/core run ci");
  }
  if (runners.separate.length > 0) {
    lines.push("");
    lines.push(`Separate-runner tests (${runners.separate.length}, not passed to root Vitest):`);
    for (const filePath of runners.separate) {
      lines.push(`  - ${filePath}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export function executeAffectedRootVitest({
  rootVitest,
  hosted = false,
  vitestArgs = [],
  rootDir = REPOSITORY_ROOT,
  spawnImpl = spawnSync,
}) {
  if (rootVitest.length === 0) {
    return 0;
  }
  if (hosted) {
    const result = spawnImpl(
      process.execPath,
      [resolve(rootDir, "scripts/test-hosted.mjs"), ...rootVitest, ...vitestArgs],
      { cwd: rootDir, stdio: "inherit" },
    );
    return result.status ?? 1;
  }
  const buildResult = spawnImpl(
    process.execPath,
    [resolve(rootDir, "scripts/build-packages-incremental.mjs")],
    { cwd: rootDir, stdio: "inherit" },
  );
  if ((buildResult.status ?? 1) !== 0) {
    return buildResult.status ?? 1;
  }
  const testResult = spawnImpl(
    process.execPath,
    [resolve(rootDir, "scripts/run-vitest.mjs"), "run", ...rootVitest, ...vitestArgs],
    { cwd: rootDir, stdio: "inherit" },
  );
  return testResult.status ?? 1;
}

function main(argv = process.argv.slice(2)) {
  const {
    base: requestedBase,
    files,
    json,
    run,
    dryRun,
    hosted,
    noPostgres,
    maxDepth,
    vitestArgs,
  } = parseAffectedArgs(argv);
  const base = files !== null ? null : (requestedBase ?? resolveDefaultBaseRef(REPOSITORY_ROOT));
  const changedFiles = files !== null ? files : collectChangedFilesFromGit(base, REPOSITORY_ROOT);
  const result = findAffectedTests({
    changedFiles,
    rootDir: REPOSITORY_ROOT,
    maxDepth,
    includePostgres: !noPostgres,
  });
  const payload = {
    base,
    changedFiles: result.changedFiles,
    affectedTests: result.affectedTests,
    runners: result.runners,
  };

  if (json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return 0;
  }

  process.stdout.write(formatAffectedTestsText({ ...payload, hosted, vitestArgs }));

  if (!run || dryRun) {
    return 0;
  }

  if (result.runners.rootVitest.length === 0) {
    process.stdout.write("No affected root Vitest files to run.\n");
    return 0;
  }

  return executeAffectedRootVitest({
    rootVitest: result.runners.rootVitest,
    hosted,
    vitestArgs,
    rootDir: REPOSITORY_ROOT,
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
