#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_MAX_DEPTH = 3;

const IGNORED_DIRS = new Set([
  ".git",
  ".worktrees",
  "coverage",
  "dist",
  "node_modules",
  "playwright-report",
  "test-results",
]);

const DIRECT_TEST_PATTERN = /\.test\.(?:ts|tsx|js|mjs|cjs)$/;
const PACKAGE_TEST_PATTERN = /\.test\.(?:ts|tsx|js|mjs)$/;
const SCRIPT_TEST_PATTERN = /\.test\.(?:ts|mjs)$/;
const TS_TEST_PATTERN = /\.test\.(?:ts|tsx)$/;

const CONTRACT_PIN_RULES = [
  {
    match: (filePath) =>
      /^packages\/platform\/src\/[^/]+\/settings-data\.json$/.test(filePath)
      || filePath === "packages/platform/settings-catalog.json",
    tests: [
      "scripts/settings-catalogue.test.ts",
      "packages/platform/test/operations/settingsCommand.test.ts",
      "packages/platform/test/operations/settingsCandidateParity.test.ts",
    ],
  },
  {
    match: (filePath) => /^examples\/neutral-store\/owned\/.+$/.test(filePath),
    tests: [
      "packages/platform/test/operations/settingsCommand.test.ts",
      "packages/platform/test/operations/settingsRead.test.ts",
      "scripts/packages/distribution-cli-settings.test.ts",
    ],
  },
  {
    match: (filePath) =>
      /^packages\/[^/]+\/release-gates\.json$/.test(filePath)
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
    match: (filePath) => /^supabase\/migrations\/[^/]+\.sql$/.test(filePath),
    tests: [
      "scripts/platform-migration-manifest.test.ts",
      "scripts/pgtap-parity.test.ts",
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

function isExistingFile(rootDir, relPath) {
  try {
    return statSync(resolve(rootDir, relPath)).isFile();
  } catch {
    return false;
  }
}

export function isTestFile(filePath) {
  return DIRECT_TEST_PATTERN.test(filePath);
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

function stripCommentsForImportScan(sourceText) {
  let output = "";
  let index = 0;
  const length = sourceText.length;

  while (index < length) {
    const ch = sourceText[index];
    const next = sourceText[index + 1];

    // Preserve string and template literals so specifiers containing // or /* are untouched.
    if (ch === "\"" || ch === "'" || ch === "`") {
      const quote = ch;
      output += ch;
      index += 1;
      while (index < length) {
        const cur = sourceText[index];
        output += cur;
        index += 1;
        if (cur === "\\") {
          if (index < length) {
            output += sourceText[index];
            index += 1;
          }
          continue;
        }
        if (cur === quote) {
          break;
        }
      }
      continue;
    }

    if (ch === "/" && next === "/") {
      index += 2;
      while (index < length && sourceText[index] !== "\n") {
        index += 1;
      }
      continue;
    }

    if (ch === "/" && next === "*") {
      index += 2;
      while (index < length && !(sourceText[index] === "*" && sourceText[index + 1] === "/")) {
        if (sourceText[index] === "\n") {
          output += "\n";
        }
        index += 1;
      }
      index += 2;
      continue;
    }

    output += ch;
    index += 1;
  }

  return output;
}

export function extractStaticImports(sourceText) {
  const cleaned = stripCommentsForImportScan(sourceText);
  const specifiers = new Set();

  // Matches `import ... from "specifier"` and `export ... from "specifier"` (including multi-line clauses).
  const fromPattern = /(?:^|[;\r\n])\s*(?:import|export)\s+(?:type\s+)?[^;]*?\bfrom\s*["']([^"'\n]+)["']/g;
  let match;
  while ((match = fromPattern.exec(cleaned)) !== null) {
    const specifier = match[1].trim();
    if (specifier) {
      specifiers.add(specifier);
    }
  }

  // Matches side-effect imports: `import "specifier"`
  const sideEffectPattern = /(?:^|[;\r\n])\s*import\s*["']([^"'\n]+)["']/g;
  while ((match = sideEffectPattern.exec(cleaned)) !== null) {
    const specifier = match[1].trim();
    if (specifier) {
      specifiers.add(specifier);
    }
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

function resolveCandidateFile(candidatePosix, rootDir) {
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
    if (isExistingFile(rootDir, candidate)) {
      return candidate;
    }
  }
  return null;
}

function resolveWorkspacePackageImport(specifier, rootDir, packageExportsMap) {
  for (const [pkgName, pkgInfo] of packageExportsMap.entries()) {
    if (specifier !== pkgName && !specifier.startsWith(`${pkgName}/`)) {
      continue;
    }
    const subpath = specifier === pkgName ? "." : `./${specifier.slice(pkgName.length + 1)}`;

    let target = null;
    if (subpath in pkgInfo.exports) {
      target = pickExportTarget(pkgInfo.exports[subpath]);
    } else {
      for (const [exportKey, exportValue] of Object.entries(pkgInfo.exports)) {
        if (!exportKey.includes("*")) {
          continue;
        }
        const [prefix, suffix] = exportKey.split("*");
        if (subpath.startsWith(prefix) && subpath.endsWith(suffix)) {
          const captured = subpath.slice(prefix.length, subpath.length - suffix.length);
          const rawTarget = pickExportTarget(exportValue);
          if (rawTarget) {
            target = rawTarget.replace("*", captured);
            break;
          }
        }
      }
    }

    if (target) {
      const cleanedTarget = target.replace(/^\.\//, "");
      const sourceTarget = cleanedTarget.startsWith("dist/")
        ? `src/${cleanedTarget.slice("dist/".length)}`
        : cleanedTarget;
      const fromSrc = resolveCandidateFile(posix.join(pkgInfo.dir, sourceTarget), rootDir);
      if (fromSrc) {
        return fromSrc;
      }
      const fromRaw = resolveCandidateFile(posix.join(pkgInfo.dir, cleanedTarget), rootDir);
      if (fromRaw) {
        return fromRaw;
      }
    }

    if (subpath !== ".") {
      const fallbackRel = subpath.slice(2);
      const fromSrcFallback = resolveCandidateFile(posix.join(pkgInfo.dir, "src", fallbackRel), rootDir);
      if (fromSrcFallback) {
        return fromSrcFallback;
      }
    } else {
      const fromIndexFallback = resolveCandidateFile(posix.join(pkgInfo.dir, "src", "index"), rootDir);
      if (fromIndexFallback) {
        return fromIndexFallback;
      }
    }
    return null;
  }
  return null;
}

export function resolveImportPath(specifier, fromFile, rootDir = REPOSITORY_ROOT, packageExportsMap = null) {
  if (!specifier || specifier.startsWith("node:")) {
    return null;
  }

  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    const fromDir = posix.dirname(fromFile.split("\\").join("/"));
    const joined = posix.join(fromDir, specifier);
    return resolveCandidateFile(joined, rootDir);
  }

  if (specifier.startsWith("@/")) {
    return resolveCandidateFile(`src/${specifier.slice(2)}`, rootDir);
  }

  const exportsMap = packageExportsMap ?? loadWorkspacePackageExports(rootDir);
  if (specifier.startsWith("@openlup/")) {
    return resolveWorkspacePackageImport(specifier, rootDir, exportsMap);
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

  // tests/**/*.test.{ts,tsx}
  walkMatchingFiles(rootDir, "tests", (fileRel) => TS_TEST_PATTERN.test(fileRel), found);

  // src/**/*.test.{ts,tsx}
  walkMatchingFiles(rootDir, "src", (fileRel) => TS_TEST_PATTERN.test(fileRel), found);

  return [...found].sort(compareCodeUnits);
}

export function findAffectedTests({
  changedFiles = [],
  rootDir = REPOSITORY_ROOT,
  maxDepth = DEFAULT_MAX_DEPTH,
} = {}) {
  const normalizedChanged = [...new Set(
    changedFiles
      .map((filePath) => toPosixRelative(filePath, rootDir))
      .filter((filePath) => filePath !== null),
  )].sort(compareCodeUnits);

  const reasonsByTest = new Map();
  const addReason = (testPath, reason) => {
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

  // 3. Reverse import graph (transitive reverse closure up to maxDepth)
  if (normalizedChanged.length > 0 && maxDepth > 0) {
    const testFiles = collectTestFiles(rootDir);
    const testFileSet = new Set(testFiles);
    const packageExportsMap = loadWorkspacePackageExports(rootDir);
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
      const specifiers = extractStaticImports(source);
      const resolved = [];
      for (const specifier of specifiers) {
        const target = resolveImportPath(specifier, filePath, rootDir, packageExportsMap);
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
  };
}

export function parseAffectedArgs(argv) {
  let base = null;
  let files = null;
  let json = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
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
    } else if (arg === "--json") {
      json = true;
    } else {
      throw new Error(
        `Unknown option: ${arg}\nUsage: node scripts/affected-tests.mjs [--base <ref>] [--files <p1,p2,...>] [--json]`,
      );
    }
  }

  if (files === null && base === null) {
    base = "HEAD";
  }

  return { base, files, json };
}

export function collectChangedFilesFromGit(baseRef, rootDir = REPOSITORY_ROOT) {
  const diffOutput = execFileSync("git", ["diff", "--name-only", baseRef], {
    cwd: rootDir,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  const untrackedOutput = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], {
    cwd: rootDir,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return [...new Set([
    ...diffOutput.split(/\r?\n/),
    ...untrackedOutput.split(/\r?\n/),
  ].map((line) => line.trim()).filter(Boolean))].sort(compareCodeUnits);
}

export function formatAffectedTestsText({ base, changedFiles, affectedTests }) {
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
  if (affectedTests.length > 0) {
    lines.push("");
    lines.push(`Run command:`);
    lines.push(`npx --no -- vitest run ${affectedTests.map((item) => item.path).join(" ")}`);
  }
  return `${lines.join("\n")}\n`;
}

function main(argv = process.argv.slice(2)) {
  const { base, files, json } = parseAffectedArgs(argv);
  const changedFiles = files !== null ? files : collectChangedFilesFromGit(base, REPOSITORY_ROOT);
  const result = findAffectedTests({ changedFiles, rootDir: REPOSITORY_ROOT });
  const payload = {
    base,
    changedFiles: result.changedFiles,
    affectedTests: result.affectedTests,
  };

  if (json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    process.stdout.write(formatAffectedTestsText(payload));
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
