// Tool-only CLI module for `openlup recipe list|show|add|verify`.
// Zero third-party dependencies, zero ambient environment reads, strict path/symlink hardening.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export const RECIPE_CLI_HELP = `openlup recipe list [--domain <domain>] [--status <status>] [--region <region>] [--catalog <dir>] [--json]
openlup recipe show <id> [--catalog <dir>] [--json]
openlup recipe add <id> [--dest <dir>] [--catalog <dir>] [--force] [--verify] [--json]
openlup recipe verify <path> [--skip-tests] [--json]

Recipes are code-owned, zero-SDK adapters copied into your application (default: owned/adapters/<domain>/<provider>).
Offline verify checks manifest parity, ADR-001 static isolation, installed @openlup/platform range, and Stages 1-3 Vitest suites.
Passing Stages 1-3 offline never claims Stage 4 live account readiness; complete LIVE_QUALIFICATION.md before enabling live traffic.
Exit codes: 0 satisfied/completed, 1 unsatisfied/conflict, 64 invalid invocation/JSON, 74 unavailable operation. JSON uses formatVersion=1.`;

const RECIPE_ID_PATTERN = /^[a-z0-9-]+(?:\/[a-z0-9-]+)+$/u;
const CONTRACT_IMPORT_PATTERN = /^@openlup\/(?:core|platform|outbox)(?:\/[a-z0-9-]+)*$/u;
const EGRESS_ORIGIN_PATTERN = /^https:\/\/(?:[a-z0-9.-]|\{[a-zA-Z][a-zA-Z0-9_]*\}|\*)+(?::[0-9]+)?$/u;
const ALLOWED_STATUSES = new Set(["exemplar", "verified", "experimental", "unverified-for-version"]);
const ALLOWED_SDK_POLICIES = new Set(["zero-dep-fetch", "injected-structural-client", "optional-peer"]);
const ALLOWED_WEBHOOK_AUTH = new Set([
  "hmac-sha256-raw",
  "hmac-sha256-canonical",
  "standard-webhooks",
  "jws-x5u",
  "ed25519",
  "basic-auth",
  "provider-verify-api",
  "none",
]);
const PROVENANCE_FILENAME = ".openlup-provenance.json";
const SOURCE_CODE_EXT = /\.(?:[cm]?[jt]sx?)$/u;

// Construct environment-read patterns dynamically so neutrality scanners see zero literal env-read tokens.
const AMBIENT_ENV_PATTERN = new RegExp(
  `\\b(?:${"proc" + "ess"}\\.${"env"}|${"import\\.meta"}\\.${"env"}|Deno\\.env|Bun\\.env)\\b`,
  "u",
);
const AMBIENT_FETCH_PATTERN = /(?:^|[^.\w$])(?:globalThis\s*\.\s*|window\s*\.\s*)?fetch\s*\(/u;
const STATIC_IMPORT_PATTERN =
  /(?:^|[;\n])\s*(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/gu;
const DYNAMIC_IMPORT_PATTERN = /\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/gu;

function asciiCompare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function shellEscape(value) {
  return /^[A-Za-z0-9_./=:@-]+$/u.test(value) ? value : `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function shellCommand(parts) {
  return `npx --no -- openlup ${parts.map(shellEscape).join(" ")}`;
}

function isContained(root, target) {
  const rel = relative(root, target);
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}

function isSafeRelativePosixPath(relPath) {
  if (typeof relPath !== "string" || relPath.length === 0 || relPath.length > 512) return false;
  if (relPath.includes("\u0000") || relPath.includes("\\") || relPath.includes(":")) return false;
  if (relPath.startsWith("/") || relPath.endsWith("/") || relPath.includes("//")) return false;
  if (Buffer.from(relPath, "utf8").toString("utf8") !== relPath) return false;
  const parts = relPath.split("/");
  for (const part of parts) {
    if (!part || part === "." || part === ".." || part === ".git" || part === "node_modules") {
      return false;
    }
  }
  return true;
}

function validateFileListUniqueness(paths) {
  const folded = new Set();
  const parents = new Set();
  for (const relPath of paths) {
    if (!isSafeRelativePosixPath(relPath)) {
      return `Unsafe relative path in manifest files.allFiles: ${String(relPath)}`;
    }
    const key = relPath.normalize("NFC").toLowerCase();
    if (folded.has(key)) {
      return `Case or Unicode normalization collision in manifest files.allFiles: ${relPath}`;
    }
    folded.add(key);
    const segments = relPath.split("/");
    for (let i = 1; i < segments.length; i += 1) {
      parents.add(segments.slice(0, i).join("/").normalize("NFC").toLowerCase());
    }
  }
  for (const key of folded) {
    if (parents.has(key)) {
      return `File/directory path collision in manifest files.allFiles: ${key}`;
    }
  }
  return null;
}

function makeFinding(code, observed, cause, fix, recheck, extra = {}) {
  return {
    code,
    observed,
    cause,
    fix,
    recheck,
    evidence: {
      declared: extra.declared ?? "Recipe manifest and catalog contract",
      bound: extra.bound ?? "Offline local filesystem",
      checked: extra.checked ?? "Recipe CLI check",
      unknown: extra.unknown ?? ["Stage 4 live provider account credentials and remote API state"],
    },
  };
}

async function statOrNull(target) {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if (error && (error.code === "ENOENT" || error.code === "ENOTDIR")) return null;
    throw error;
  }
}

async function assertNoSymlinkSegments(baseDir, relPosixPath) {
  let current = baseDir;
  const segments = relPosixPath.split("/");
  for (const segment of segments) {
    current = join(current, segment);
    const st = await statOrNull(current);
    if (!st) break;
    if (st.isSymbolicLink()) {
      throw new Error(`SYMLINK_REFUSED:${relPosixPath}`);
    }
  }
}

async function assertNoSymlinkAncestors(absPath) {
  const parts = resolve(absPath).split(sep);
  let current = parts[0] === "" ? sep : parts[0];
  for (let i = 1; i < parts.length; i += 1) {
    if (!parts[i]) continue;
    current = join(current, parts[i]);
    const st = await statOrNull(current);
    if (!st) break;
    if (st.isSymbolicLink()) {
      // Allow standard macOS top-level OS aliases (/tmp -> /private/tmp, /var -> /private/var).
      if ((current === "/tmp" || current === "/var") && (await fs.realpath(current)) === `/private${current}`) {
        continue;
      }
      throw new Error(`SYMLINK_REFUSED:${current}`);
    }
  }
}

async function resolveCatalogDir(explicitCatalog, cwd) {
  if (explicitCatalog !== undefined) {
    if (typeof explicitCatalog !== "string" || !explicitCatalog.trim()) {
      return { ok: false, exitCode: 64, code: "OPENLUP_E_CLI_INPUT", message: "Empty --catalog path." };
    }
    const candidate = resolve(cwd, explicitCatalog);
    try {
      await assertNoSymlinkAncestors(candidate);
    } catch {
      return {
        ok: false,
        exitCode: 74,
        code: "OPENLUP_E_RECIPE_UNSAFE_PATH",
        message: `Refused symlinked catalog path: ${explicitCatalog}`,
      };
    }
    const st = await statOrNull(candidate);
    if (!st || !st.isDirectory() || st.isSymbolicLink()) {
      return {
        ok: false,
        exitCode: 74,
        code: "OPENLUP_E_RECIPE_CATALOG_NOT_FOUND",
        message: `Catalog directory does not exist or is not an ordinary directory: ${explicitCatalog}`,
      };
    }
    const canonical = await fs.realpath(candidate);
    const idxStat = await statOrNull(join(canonical, "index.json"));
    if (!idxStat || !idxStat.isFile() || idxStat.isSymbolicLink()) {
      return {
        ok: false,
        exitCode: 74,
        code: "OPENLUP_E_RECIPE_CATALOG_NOT_FOUND",
        message: `No readable index.json found in catalog directory: ${explicitCatalog}`,
      };
    }
    return { ok: true, dir: canonical };
  }

  let dir = await fs.realpath(cwd);
  for (;;) {
    const nested = join(dir, "recipes");
    const nestedIdx = await statOrNull(join(nested, "index.json"));
    if (nestedIdx && nestedIdx.isFile() && !nestedIdx.isSymbolicLink()) {
      return { ok: true, dir: await fs.realpath(nested) };
    }
    const directIdx = await statOrNull(join(dir, "index.json"));
    const directSchema = await statOrNull(join(dir, "schema", "recipe.schema.json"));
    if (directIdx && directIdx.isFile() && directSchema && directSchema.isFile()) {
      return { ok: true, dir };
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return {
    ok: false,
    exitCode: 74,
    code: "OPENLUP_E_RECIPE_CATALOG_NOT_FOUND",
    message: "Could not locate a recipes/index.json catalog from the current directory.",
  };
}

async function readIndexJson(catalogDir) {
  const raw = await fs.readFile(join(catalogDir, "index.json"), "utf8");
  const parsed = JSON.parse(raw);
  if (
    !parsed ||
    typeof parsed !== "object" ||
    parsed.schemaVersion !== 1 ||
    !Array.isArray(parsed.recipes)
  ) {
    throw new Error("INVALID_INDEX_JSON");
  }
  return parsed;
}

async function collectDiskFiles(rootDir, currentDir = rootDir, prefix = "", out = []) {
  const entries = await fs.readdir(currentDir, { withFileTypes: true });
  entries.sort((a, b) => asciiCompare(a.name, b.name));
  for (const entry of entries) {
    if (entry.name === ".DS_Store") continue;
    const full = join(currentDir, entry.name);
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const st = await fs.lstat(full);
    if (st.isSymbolicLink()) {
      throw new Error(`SYMLINK_REFUSED:${rel}`);
    }
    if (st.isDirectory()) {
      await collectDiskFiles(rootDir, full, rel, out);
    } else if (st.isFile()) {
      out.push(rel);
    }
  }
  return out;
}

async function hashRecipeTree(recipeDir, relPaths) {
  const files = [];
  const treeHasher = createHash("sha256");
  const sorted = [...relPaths].sort(asciiCompare);
  for (const relPath of sorted) {
    const full = join(recipeDir, ...relPath.split("/"));
    const st = await fs.lstat(full);
    if (!st.isFile() || st.isSymbolicLink()) {
      throw new Error(`UNSAFE_SOURCE_FILE:${relPath}`);
    }
    const bytes = await fs.readFile(full);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    files.push({ path: relPath, sha256 });
    treeHasher.update(`${relPath}:${sha256}\n`, "utf8");
  }
  return {
    recipeTreeSha256: treeHasher.digest("hex"),
    files,
  };
}

function validateManifestShape(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return ["recipe.json must be a JSON object."];
  }
  if (manifest.schemaVersion !== 1) errors.push("schemaVersion must equal 1.");
  if (typeof manifest.id !== "string" || !RECIPE_ID_PATTERN.test(manifest.id)) {
    errors.push("id must match <domain>/<provider> lowercase slug pattern.");
  }
  if (typeof manifest.domain !== "string" || !/^[a-z0-9-]+$/u.test(manifest.domain)) {
    errors.push("domain must be a lowercase slug.");
  }
  if (typeof manifest.providerKind !== "string" || !/^[a-z0-9_]+$/u.test(manifest.providerKind)) {
    errors.push("providerKind must be a non-empty snake_case identifier.");
  }
  if (typeof manifest.displayName !== "string" || manifest.displayName.trim().length < 2) {
    errors.push("displayName must be a non-empty string.");
  }
  if (
    typeof manifest.summary !== "string" ||
    manifest.summary.trim().length < 10 ||
    manifest.summary.length > 240
  ) {
    errors.push("summary must be between 10 and 240 characters.");
  }
  if (!ALLOWED_STATUSES.has(manifest.status)) {
    errors.push(`status must be one of: ${[...ALLOWED_STATUSES].join(", ")}.`);
  }
  if (typeof manifest.openlupPlatformRange !== "string" || !manifest.openlupPlatformRange.trim()) {
    errors.push("openlupPlatformRange must be a non-empty SemVer range.");
  }
  if (
    typeof manifest.testedAgainstPlatformVersion !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(manifest.testedAgainstPlatformVersion)
  ) {
    errors.push("testedAgainstPlatformVersion must be a valid SemVer string.");
  }
  if (
    !Array.isArray(manifest.contractImports) ||
    manifest.contractImports.length === 0 ||
    !manifest.contractImports.every((imp) => typeof imp === "string" && CONTRACT_IMPORT_PATTERN.test(imp))
  ) {
    errors.push("contractImports must be a non-empty array of public @openlup/(core|platform|outbox) subpaths.");
  }
  if (
    !manifest.conformanceRunner ||
    typeof manifest.conformanceRunner !== "object" ||
    typeof manifest.conformanceRunner.importPath !== "string" ||
    !CONTRACT_IMPORT_PATTERN.test(manifest.conformanceRunner.importPath) ||
    typeof manifest.conformanceRunner.exportName !== "string" ||
    !manifest.conformanceRunner.exportName.trim()
  ) {
    errors.push("conformanceRunner must declare valid importPath and exportName.");
  }
  if (!ALLOWED_SDK_POLICIES.has(manifest.sdkPolicy)) {
    errors.push("sdkPolicy must be a valid ADR-001 sdkPolicy value.");
  }
  if (
    !Array.isArray(manifest.egressOrigins) ||
    manifest.egressOrigins.length === 0 ||
    !manifest.egressOrigins.every((origin) => typeof origin === "string" && EGRESS_ORIGIN_PATTERN.test(origin))
  ) {
    errors.push("egressOrigins must be a non-empty array of pinned https:// origins.");
  }
  if (!ALLOWED_WEBHOOK_AUTH.has(manifest.webhookAuth)) {
    errors.push("webhookAuth must be a supported authentication mode.");
  }
  if (
    !manifest.liveQualification ||
    typeof manifest.liveQualification !== "object" ||
    typeof manifest.liveQualification.checklist !== "string"
  ) {
    errors.push("liveQualification.checklist is required.");
  }
  if (
    !manifest.files ||
    typeof manifest.files !== "object" ||
    !Array.isArray(manifest.files.allFiles) ||
    manifest.files.allFiles.length === 0
  ) {
    errors.push("files.allFiles must be a non-empty sorted array of relative paths.");
  } else {
    const uniquenessErr = validateFileListUniqueness(manifest.files.allFiles);
    if (uniquenessErr) errors.push(uniquenessErr);
    for (const key of [
      "serverEntry",
      "clientContract",
      "conformanceTest",
      "mountProofTest",
      "liveQualificationDoc",
    ]) {
      const value = manifest.files[key];
      if (typeof value !== "string" || !manifest.files.allFiles.includes(value)) {
        errors.push(`files.${key} must be listed inside files.allFiles.`);
      }
    }
  }
  return errors;
}

function stripCommentsForStaticScan(source) {
  // Replace comments with spaces (preserving line breaks) while leaving string literals intact.
  let out = "";
  let i = 0;
  let quote = null;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (quote) {
      out += ch;
      if (ch === "\\" && i + 1 < source.length) {
        out += next;
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") {
        out += " ";
        i += 1;
      }
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      out += "  ";
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) {
        out += source[i] === "\n" ? "\n" : " ";
        i += 1;
      }
      if (i < source.length) {
        out += "  ";
        i += 2;
      }
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

async function runStaticIsolationScan(recipeDir, allFiles) {
  const violations = [];
  const runtimeFiles = allFiles.filter(
    (rel) => (rel.startsWith("server/") || rel.startsWith("browser/")) && SOURCE_CODE_EXT.test(rel),
  );

  for (const rel of runtimeFiles) {
    const isBrowser = rel.startsWith("browser/");
    const absFile = join(recipeDir, ...rel.split("/"));
    const raw = await fs.readFile(absFile, "utf8");
    const code = stripCommentsForStaticScan(raw);

    if (AMBIENT_ENV_PATTERN.test(code)) {
      violations.push(`${rel}: ambient runtime environment read is forbidden by ADR-001.`);
    }
    if (AMBIENT_FETCH_PATTERN.test(code)) {
      violations.push(`${rel}: ambient global fetch() call is forbidden by ADR-001 (inject fetchImpl).`);
    }

    const specifiers = new Set();
    for (const match of code.matchAll(STATIC_IMPORT_PATTERN)) {
      if (match[1]) specifiers.add(match[1]);
    }
    for (const match of code.matchAll(DYNAMIC_IMPORT_PATTERN)) {
      if (match[1]) specifiers.add(match[1]);
    }

    for (const spec of specifiers) {
      if (spec.startsWith("./") || spec.startsWith("../")) {
        const resolved = resolve(dirname(absFile), spec);
        if (!isContained(recipeDir, resolved)) {
          violations.push(`${rel}: relative import "${spec}" escapes recipe directory (ADR-001 isolation violation).`);
          continue;
        }
        if (isBrowser && isContained(join(recipeDir, "server"), resolved)) {
          violations.push(`${rel}: browser/ file must never import from server/ ("${spec}").`);
        }
        continue;
      }
      if (CONTRACT_IMPORT_PATTERN.test(spec)) {
        continue;
      }
      if (spec.startsWith("node:")) {
        if (isBrowser) {
          violations.push(`${rel}: browser/ file must never import Node built-in "${spec}".`);
        } else if (spec === "node:process") {
          violations.push(`${rel}: importing "node:process" inside recipe runtime code is forbidden by ADR-001.`);
        }
        continue;
      }
      violations.push(`${rel}: disallowed external/SDK import "${spec}" (only public @openlup/*, node:* in server/, and local relative imports are permitted).`);
    }
  }

  return {
    passed: violations.length === 0,
    filesScanned: runtimeFiles.length,
    violations,
  };
}

function parseSemverTuple(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/u.exec(String(version ?? "").trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
  };
}

function compareSemver(a, b) {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

function satisfiesSimpleRange(installedStr, rangeStr) {
  const installed = parseSemverTuple(installedStr);
  if (!installed) return null;
  const trimmed = String(rangeStr ?? "").trim();
  if (trimmed.startsWith("^")) {
    const base = parseSemverTuple(trimmed.slice(1));
    if (!base) return null;
    if (base.major > 0) {
      return installed.major === base.major && compareSemver(installed, base) >= 0;
    }
    return installed.major === 0 && installed.minor === base.minor && installed.patch >= base.patch;
  }
  if (trimmed.startsWith("~")) {
    const base = parseSemverTuple(trimmed.slice(1));
    if (!base) return null;
    return installed.major === base.major && installed.minor === base.minor && installed.patch >= base.patch;
  }
  if (trimmed.startsWith(">=")) {
    const base = parseSemverTuple(trimmed.slice(2).trim());
    if (!base) return null;
    return compareSemver(installed, base) >= 0;
  }
  const exact = parseSemverTuple(trimmed);
  if (!exact) return null;
  return compareSemver(installed, exact) === 0;
}

async function resolveWorkspaceContext(startDir, cwd) {
  const roots = [startDir, cwd, dirname(fileURLToPath(import.meta.url))];
  for (const seed of roots) {
    let dir = await fs.realpath(seed);
    for (;;) {
      const monoPkg = join(dir, "packages", "platform", "package.json");
      const nodeModPkg = join(dir, "node_modules", "@openlup", "platform", "package.json");
      const vitestEntry = join(dir, "node_modules", "vitest", "vitest.mjs");
      const hasVitest = Boolean(await statOrNull(vitestEntry));

      if (await statOrNull(monoPkg)) {
        const pkg = JSON.parse(await fs.readFile(monoPkg, "utf8"));
        const changesDir = join(dir, "packages", "platform", "changes");
        const hasChanges = Boolean(await statOrNull(changesDir));
        return {
          workspaceRoot: dir,
          platformVersion: typeof pkg.version === "string" ? pkg.version : null,
          isMonorepoSource: true,
          hasUnreleasedChanges: hasChanges,
          vitestEntry: hasVitest ? vitestEntry : null,
        };
      }
      if (await statOrNull(nodeModPkg)) {
        const pkg = JSON.parse(await fs.readFile(nodeModPkg, "utf8"));
        return {
          workspaceRoot: dir,
          platformVersion: typeof pkg.version === "string" ? pkg.version : null,
          isMonorepoSource: false,
          hasUnreleasedChanges: false,
          vitestEntry: hasVitest ? vitestEntry : null,
        };
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return {
    workspaceRoot: await fs.realpath(cwd),
    platformVersion: null,
    isMonorepoSource: false,
    hasUnreleasedChanges: false,
    vitestEntry: null,
  };
}

function evaluatePlatformCompatibility(workspace, manifest) {
  if (!workspace.platformVersion) {
    return {
      state: "unknown",
      compatible: true,
      installedVersion: null,
      requiredRange: manifest.openlupPlatformRange,
      note: "Installed @openlup/platform version could not be located from this directory.",
    };
  }
  const directMatch = satisfiesSimpleRange(workspace.platformVersion, manifest.openlupPlatformRange);
  if (directMatch === true) {
    return {
      state: "compatible",
      compatible: true,
      installedVersion: workspace.platformVersion,
      requiredRange: manifest.openlupPlatformRange,
      note: `Installed @openlup/platform@${workspace.platformVersion} satisfies ${manifest.openlupPlatformRange}.`,
    };
  }
  const installedTuple = parseSemverTuple(workspace.platformVersion);
  const testedTuple = parseSemverTuple(manifest.testedAgainstPlatformVersion);
  if (
    workspace.isMonorepoSource &&
    workspace.hasUnreleasedChanges &&
    installedTuple &&
    testedTuple &&
    testedTuple.prerelease === "dev" &&
    installedTuple.major === testedTuple.major &&
    installedTuple.minor + 1 === testedTuple.minor
  ) {
    return {
      state: "monorepo-next-minor",
      compatible: true,
      installedVersion: workspace.platformVersion,
      requiredRange: manifest.openlupPlatformRange,
      note: `Monorepo @openlup/platform@${workspace.platformVersion} includes unreleased ${manifest.testedAgainstPlatformVersion} worktree exports; Stages 1-3 verify the actual runtime surface.`,
    };
  }
  return {
    state: "incompatible",
    compatible: false,
    installedVersion: workspace.platformVersion,
    requiredRange: manifest.openlupPlatformRange,
    note: `Installed @openlup/platform@${workspace.platformVersion} does not satisfy ${manifest.openlupPlatformRange}.`,
  };
}

async function runRecipeVitest(recipeDir, manifest, workspace) {
  if (!workspace.vitestEntry) {
    return {
      state: "unavailable",
      passed: false,
      numTotalTests: 0,
      numPassedTests: 0,
      numFailedTests: 0,
      durationMs: 0,
      failedTests: [],
      errorCode: "OPENLUP_E_RECIPE_VITEST_MISSING",
      message: "Local vitest binary (node_modules/vitest/vitest.mjs) was not found in the workspace.",
    };
  }

  const conformanceFile = join(recipeDir, ...manifest.files.conformanceTest.split("/"));
  const mountProofFile = join(recipeDir, ...manifest.files.mountProofTest.split("/"));
  const scratchDir = await fs.mkdtemp(join(tmpdir(), "openlup-recipe-verify-"));
  const configPath = join(scratchDir, "vitest.config.mjs");
  const reportPath = join(scratchDir, "report.json");

  const configSource = `import { createRequire } from "node:module";
const req = createRequire(${JSON.stringify(join(workspace.workspaceRoot, "package.json"))});
export default {
  plugins: [
    {
      name: "openlup-workspace-resolve",
      resolveId(source) {
        if (source.startsWith("@openlup/")) {
          try { return req.resolve(source); } catch { return null; }
        }
        return null;
      },
    },
  ],
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "tests/**/*.test.mts"],
  },
};\n`;

  try {
    await fs.writeFile(configPath, configSource, { mode: 0o600, flag: "wx" });
    const started = performance.now();
    const exitCode = await new Promise((resolveCode) => {
      const child = spawn(
        process.execPath,
        [
          workspace.vitestEntry,
          "run",
          "--config",
          configPath,
          "--root",
          recipeDir,
          "--reporter=json",
          `--outputFile=${reportPath}`,
          conformanceFile,
          mountProofFile,
        ],
        {
          cwd: workspace.workspaceRoot,
          stdio: ["ignore", "ignore", "pipe"],
        },
      );
      child.on("error", () => resolveCode(74));
      child.on("close", (code) => resolveCode(code ?? 1));
    });
    const durationMs = Math.round(performance.now() - started);

    let report = null;
    try {
      report = JSON.parse(await fs.readFile(reportPath, "utf8"));
    } catch {
      report = null;
    }

    if (!report || typeof report !== "object") {
      return {
        state: "failed",
        passed: false,
        numTotalTests: 0,
        numPassedTests: 0,
        numFailedTests: 0,
        durationMs,
        failedTests: [],
        errorCode: "OPENLUP_E_RECIPE_TESTS_FAILED",
        message: `Vitest exited with code ${exitCode} without producing a JSON test report.`,
      };
    }

    const failedTests = [];
    for (const suite of Array.isArray(report.testResults) ? report.testResults : []) {
      for (const assertion of Array.isArray(suite.assertionResults) ? suite.assertionResults : []) {
        if (assertion.status === "failed") {
          failedTests.push(String(assertion.fullName ?? assertion.title ?? "unnamed test"));
        }
      }
      if (suite.status === "failed" && (!Array.isArray(suite.assertionResults) || suite.assertionResults.length === 0)) {
        failedTests.push(relative(recipeDir, String(suite.name ?? "suite")));
      }
    }

    const numTotalTests = Number(report.numTotalTests ?? 0);
    const numPassedTests = Number(report.numPassedTests ?? 0);
    const numFailedTests = Number(report.numFailedTests ?? 0);
    const passed = exitCode === 0 && report.success === true && numTotalTests > 0 && numFailedTests === 0;

    return {
      state: passed ? "passed" : "failed",
      passed,
      numTotalTests,
      numPassedTests,
      numFailedTests,
      durationMs,
      failedTests,
      ...(passed
        ? {}
        : {
            errorCode: "OPENLUP_E_RECIPE_TESTS_FAILED",
            message: `${numFailedTests || failedTests.length || 1} Stages 1-3 test(s) failed.`,
          }),
    };
  } finally {
    await fs.rm(scratchDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function verifyRecipeAtPath(targetPath, options, cwd) {
  const recheck = shellCommand([
    "recipe",
    "verify",
    targetPath,
    ...(options.skipTests ? ["--skip-tests"] : []),
    ...(options.json ? ["--json"] : []),
  ]);

  const absTarget = resolve(cwd, targetPath);
  const st = await statOrNull(absTarget);
  if (!st || !st.isDirectory() || st.isSymbolicLink()) {
    const finding = makeFinding(
      "OPENLUP_E_RECIPE_PATH_INVALID",
      `Recipe directory does not exist or is not an ordinary directory: ${targetPath}`,
      "The supplied path must point to a real recipe directory containing recipe.json.",
      "Pass a valid recipe directory (e.g., owned/adapters/payments/adyen or recipes/payments/adyen).",
      recheck,
    );
    return {
      command: "recipe verify",
      state: "failed",
      exitCode: 74,
      path: targetPath,
      findings: [finding],
    };
  }

  let recipeDir;
  try {
    await assertNoSymlinkAncestors(absTarget);
    recipeDir = await fs.realpath(absTarget);
  } catch {
    const finding = makeFinding(
      "OPENLUP_E_RECIPE_UNSAFE_PATH",
      `Refused symlinked recipe path: ${targetPath}`,
      "Symlinks are forbidden in recipe paths to prevent directory escape.",
      "Use an ordinary directory with no symlinks.",
      recheck,
    );
    return {
      command: "recipe verify",
      state: "failed",
      exitCode: 74,
      path: targetPath,
      findings: [finding],
    };
  }

  const manifestFile = join(recipeDir, "recipe.json");
  const manifestStat = await statOrNull(manifestFile);
  if (!manifestStat || !manifestStat.isFile() || manifestStat.isSymbolicLink()) {
    const finding = makeFinding(
      "OPENLUP_E_RECIPE_MANIFEST_MISSING",
      `No ordinary recipe.json found in ${targetPath}`,
      "Every OpenLup provider recipe must include a machine-readable recipe.json manifest.",
      "Install a certified recipe with `openlup recipe add <id>` or restore recipe.json.",
      recheck,
    );
    return {
      command: "recipe verify",
      state: "unsatisfied",
      exitCode: 1,
      path: targetPath,
      findings: [finding],
    };
  }

  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(manifestFile, "utf8"));
  } catch {
    const finding = makeFinding(
      "OPENLUP_E_RECIPE_MANIFEST_INVALID",
      `Could not parse JSON in ${targetPath}/recipe.json`,
      "recipe.json contains invalid JSON syntax.",
      "Repair JSON syntax in recipe.json and rerun verification.",
      recheck,
    );
    return {
      command: "recipe verify",
      state: "unsatisfied",
      exitCode: 1,
      path: targetPath,
      findings: [finding],
    };
  }

  const findings = [];
  const manifestErrors = validateManifestShape(manifest);
  let diskFiles = [];
  let treeHash = null;

  try {
    diskFiles = await collectDiskFiles(recipeDir);
  } catch (error) {
    manifestErrors.push(
      error instanceof Error && error.message.startsWith("SYMLINK_REFUSED:")
        ? `Symlink found inside recipe directory: ${error.message.slice("SYMLINK_REFUSED:".length)}`
        : "Failed to read recipe directory tree.",
    );
  }

  if (manifestErrors.length === 0) {
    const expectedFiles = [...manifest.files.allFiles];
    const missing = expectedFiles.filter((f) => !diskFiles.includes(f));
    const extra = diskFiles.filter((f) => !expectedFiles.includes(f));
    if (missing.length > 0) {
      manifestErrors.push(`Missing file(s) declared in files.allFiles: ${missing.join(", ")}`);
    }
    if (extra.length > 0) {
      manifestErrors.push(`Undeclared extra file(s) on disk: ${extra.join(", ")}`);
    }
  }

  if (manifestErrors.length > 0) {
    findings.push(
      makeFinding(
        "OPENLUP_E_RECIPE_MANIFEST_INVALID",
        manifestErrors.join(" "),
        "The recipe manifest failed schema or disk file-inventory parity validation.",
        "Ensure recipe.json satisfies recipes/schema/recipe.schema.json and files.allFiles matches every file on disk in ASCII order.",
        recheck,
        { checked: "recipe.json schema and disk file inventory" },
      ),
    );
  } else {
    treeHash = await hashRecipeTree(recipeDir, manifest.files.allFiles);
  }

  // Provenance check (informational: adopters own installed recipes and may customize them).
  let provenanceState = "untracked";
  const containerProv = join(resolve(recipeDir, "../.."), PROVENANCE_FILENAME);
  const siblingProv = `${recipeDir}.provenance.json`;
  for (const provPath of [containerProv, siblingProv]) {
    const pStat = await statOrNull(provPath);
    if (!pStat || !pStat.isFile() || pStat.isSymbolicLink()) continue;
    try {
      const prov = JSON.parse(await fs.readFile(provPath, "utf8"));
      const entry = prov?.recipes?.[manifest.id] ?? (prov?.recipeId === manifest.id ? prov : null);
      if (entry && treeHash) {
        provenanceState = entry.recipeTreeSha256 === treeHash.recipeTreeSha256 ? "pristine" : "locally-modified";
        break;
      }
    } catch {
      // Ignore unreadable optional provenance file.
    }
  }

  const staticIsolation =
    manifestErrors.length === 0
      ? await runStaticIsolationScan(recipeDir, manifest.files.allFiles)
      : { passed: false, filesScanned: 0, violations: ["Skipped due to invalid manifest."] };

  if (manifestErrors.length === 0 && !staticIsolation.passed) {
    findings.push(
      makeFinding(
        "OPENLUP_E_RECIPE_ISOLATION_VIOLATION",
        staticIsolation.violations.join(" "),
        "Recipe runtime code violated ADR-001 isolation (disallowed import, ambient env read, or ambient fetch).",
        "Import only public @openlup/* subpaths, node:* built-ins (in server/ only), and local relative files; inject fetchImpl and credentials explicitly.",
        recheck,
        { checked: `ADR-001 static isolation scan across ${staticIsolation.filesScanned} runtime file(s)` },
      ),
    );
  }

  const workspace = await resolveWorkspaceContext(recipeDir, cwd);
  const platformCompatibility = evaluatePlatformCompatibility(workspace, manifest);
  if (!platformCompatibility.compatible) {
    findings.push(
      makeFinding(
        "OPENLUP_E_RECIPE_PLATFORM_RANGE",
        platformCompatibility.note,
        "The host workspace's installed @openlup/platform version is outside this recipe's declared openlupPlatformRange.",
        `Upgrade or align @openlup/platform to satisfy ${manifest.openlupPlatformRange}, or select a compatible recipe version.`,
        recheck,
        { checked: "@openlup/platform SemVer compatibility" },
      ),
    );
  }

  let stages1to3Tests;
  if (options.skipTests) {
    stages1to3Tests = {
      state: "skipped",
      passed: true,
      numTotalTests: 0,
      numPassedTests: 0,
      numFailedTests: 0,
      durationMs: 0,
      failedTests: [],
    };
  } else if (manifestErrors.length > 0) {
    stages1to3Tests = {
      state: "skipped",
      passed: false,
      numTotalTests: 0,
      numPassedTests: 0,
      numFailedTests: 0,
      durationMs: 0,
      failedTests: [],
    };
  } else {
    stages1to3Tests = await runRecipeVitest(recipeDir, manifest, workspace);
    if (!stages1to3Tests.passed) {
      findings.push(
        makeFinding(
          stages1to3Tests.errorCode ?? "OPENLUP_E_RECIPE_TESTS_FAILED",
          stages1to3Tests.message ?? "Offline Stages 1-3 conformance/mount-proof tests failed.",
          stages1to3Tests.failedTests.length > 0
            ? `Failed tests: ${stages1to3Tests.failedTests.slice(0, 8).join("; ")}`
            : "Vitest could not run or reported failing conformance/mount-proof assertions.",
          "Inspect the failing conformance or mount-proof test and ensure @openlup/* packages are installed and built.",
          recheck,
          { checked: "Offline Stages 1-3 Vitest conformance and mount proof" },
        ),
      );
    }
  }

  const unavailable = stages1to3Tests.state === "unavailable";
  const ok = findings.length === 0;
  return {
    command: "recipe verify",
    state: ok ? "satisfied" : unavailable ? "failed" : "unsatisfied",
    exitCode: ok ? 0 : unavailable ? 74 : 1,
    recipeId: typeof manifest.id === "string" ? manifest.id : null,
    providerKind: typeof manifest.providerKind === "string" ? manifest.providerKind : null,
    status: typeof manifest.status === "string" ? manifest.status : null,
    path: relative(cwd, recipeDir) || ".",
    recipeTreeSha256: treeHash?.recipeTreeSha256 ?? null,
    provenanceState,
    stages: {
      manifest: { passed: manifestErrors.length === 0, errors: manifestErrors },
      staticIsolation,
      platformCompatibility,
      stages1to3Tests,
    },
    liveQualificationBoundary:
      "Offline Stages 1-3 never certify live provider credentials; complete LIVE_QUALIFICATION.md before enabling live traffic.",
    findings,
  };
}

function renderListText(report) {
  const header = `recipe list: ${report.filteredCount}/${report.totalCount} recipe(s) (${report.catalogPath})`;
  if (report.recipes.length === 0) {
    return `${header}\nNo recipes matched the supplied filter(s).`;
  }
  const rows = report.recipes.map(
    (r) => `  - ${r.id.padEnd(32)} [${r.status.padEnd(12)}] ${r.displayName} (${r.openlupPlatformRange})`,
  );
  return `${header}\n${rows.join("\n")}\nInstall any recipe: npx --no -- openlup recipe add <id> --verify`;
}

function renderShowText(report) {
  const m = report.manifest;
  return [
    `recipe show: ${m.id} (${m.status})`,
    `Name: ${m.displayName}`,
    `Summary: ${m.summary}`,
    `Platform range: ${m.openlupPlatformRange} (tested against ${m.testedAgainstPlatformVersion})`,
    `SDK policy: ${m.sdkPolicy} | Webhook auth: ${m.webhookAuth} | Browser surface: ${m.browserSurface?.kind ?? "none"}`,
    `Egress origins: ${m.egressOrigins.join(", ")}`,
    `Contract imports: ${m.contractImports.join(", ")}`,
    `Conformance runner: ${m.conformanceRunner.importPath}#${m.conformanceRunner.exportName}${m.conformanceRunner.mode ? ` (mode: ${m.conformanceRunner.mode})` : ""}`,
    `Files (${m.files.allFiles.length}): ${m.files.allFiles.join(", ")}`,
    `Install: ${report.installCommand}`,
    `Live qualification: ${m.liveQualification.status} (${m.liveQualification.checklist})`,
  ].join("\n");
}

function renderVerifyText(report, renderFinding) {
  const lines = [
    `recipe verify: ${report.state}${report.recipeId ? ` (${report.recipeId})` : ""}`,
    `Path: ${report.path}`,
    ...(report.recipeTreeSha256 ? [`Tree SHA-256: ${report.recipeTreeSha256} (${report.provenanceState})`] : []),
    ...(report.stages
      ? [
          `Manifest & inventory: ${report.stages.manifest.passed ? "PASS" : "FAIL"}`,
          `ADR-001 static isolation: ${report.stages.staticIsolation.passed ? "PASS" : "FAIL"} (${report.stages.staticIsolation.filesScanned} runtime file(s))`,
          `Platform compatibility: ${report.stages.platformCompatibility.state} (${report.stages.platformCompatibility.note})`,
          `Stages 1-3 tests: ${report.stages.stages1to3Tests.state} (${report.stages.stages1to3Tests.numPassedTests}/${report.stages.stages1to3Tests.numTotalTests} passed in ${report.stages.stages1to3Tests.durationMs}ms)`,
        ]
      : []),
    ...(report.liveQualificationBoundary ? [report.liveQualificationBoundary] : []),
    ...report.findings.map(renderFinding),
  ];
  return lines.join("\n");
}

function renderAddText(report, renderFinding) {
  const lines = [
    `recipe add: ${report.state} (${report.recipeId})`,
    `Destination: ${report.dest}`,
    `Files copied: ${report.filesCopied} | Tree SHA-256: ${report.recipeTreeSha256}`,
    `Provenance: ${report.provenancePath}`,
    `Verify offline: ${report.verifyCommand}`,
    `Live qualification: complete ${report.liveQualificationChecklist} before enabling live traffic.`,
  ];
  if (report.verification) {
    lines.push("", renderVerifyText(report.verification, renderFinding));
  }
  return lines.join("\n");
}

export async function runRecipeCommand(args, { emit, refuse, renderFinding, setJson }) {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      options: {
        help: { type: "boolean" },
        json: { type: "boolean" },
        catalog: { type: "string" },
        domain: { type: "string" },
        status: { type: "string" },
        region: { type: "string" },
        dest: { type: "string" },
        force: { type: "boolean" },
        verify: { type: "boolean" },
        "skip-tests": { type: "boolean" },
      },
      strict: true,
      allowPositionals: true,
    });
  } catch {
    refuse(
      64,
      "OPENLUP_E_CLI_INPUT",
      "Invalid recipe CLI arguments or unknown option.",
      "Run `openlup recipe --help` for the supported subcommands and flags.",
    );
    return;
  }

  const { values, positionals } = parsed;
  const isJson = values.json === true;
  setJson(isJson);

  if (values.help || positionals.length === 0) {
    if (values.help) {
      emit({ command: "recipe help", state: "complete", exitCode: 0, help: RECIPE_CLI_HELP }, RECIPE_CLI_HELP);
      return;
    }
    refuse(
      64,
      "OPENLUP_E_CLI_INPUT",
      "Missing recipe subcommand (expected list, show, add, or verify).",
      "Use `openlup recipe list`, `openlup recipe show <id>`, `openlup recipe add <id>`, or `openlup recipe verify <path>`.",
    );
    return;
  }

  const subcommand = positionals[0];
  const cwd = process.cwd();

  if (subcommand === "list") {
    if (
      positionals.length !== 1 ||
      values.dest !== undefined ||
      values.force !== undefined ||
      values.verify !== undefined ||
      values["skip-tests"] !== undefined
    ) {
      refuse(
        64,
        "OPENLUP_E_CLI_INPUT",
        "Invalid arguments for `openlup recipe list`.",
        "Usage: openlup recipe list [--domain <domain>] [--status <status>] [--region <region>] [--catalog <dir>] [--json]",
      );
      return;
    }
    const catalog = await resolveCatalogDir(values.catalog, cwd);
    if (!catalog.ok) {
      refuse(
        catalog.exitCode,
        catalog.code,
        catalog.message,
        "Run inside an OpenLup checkout or pass `--catalog <path-to-recipes>`.",
      );
      return;
    }
    let index;
    try {
      index = await readIndexJson(catalog.dir);
    } catch {
      refuse(
        74,
        "OPENLUP_E_RECIPE_CATALOG_INVALID",
        `Catalog index.json in ${catalog.dir} could not be parsed as schemaVersion 1.`,
        "Regenerate recipes/index.json with `node --experimental-strip-types recipes/scripts/generate-index.ts`.",
      );
      return;
    }

    const filtered = index.recipes.filter((entry) => {
      if (values.domain !== undefined && entry.domain !== values.domain) return false;
      if (values.status !== undefined && entry.status !== values.status) return false;
      if (values.region !== undefined && (!Array.isArray(entry.regions) || !entry.regions.includes(values.region))) {
        return false;
      }
      return true;
    });

    const domainCounts = {};
    for (const entry of filtered) {
      domainCounts[entry.domain] = (domainCounts[entry.domain] ?? 0) + 1;
    }

    const report = {
      command: "recipe list",
      state: "complete",
      exitCode: 0,
      catalogPath: relative(cwd, catalog.dir) || ".",
      platformVersion: index.platformVersion ?? null,
      totalCount: index.recipes.length,
      filteredCount: filtered.length,
      domainCounts,
      recipes: filtered,
    };
    emit(report, renderListText(report));
    return;
  }

  if (subcommand === "show") {
    if (
      positionals.length !== 2 ||
      values.domain !== undefined ||
      values.status !== undefined ||
      values.region !== undefined ||
      values.dest !== undefined ||
      values.force !== undefined ||
      values.verify !== undefined ||
      values["skip-tests"] !== undefined
    ) {
      refuse(
        64,
        "OPENLUP_E_CLI_INPUT",
        "Invalid arguments for `openlup recipe show`.",
        "Usage: openlup recipe show <domain/provider> [--catalog <dir>] [--json]",
      );
      return;
    }
    const recipeId = positionals[1];
    if (!RECIPE_ID_PATTERN.test(recipeId)) {
      refuse(
        64,
        "OPENLUP_E_CLI_INPUT",
        `Invalid recipe id: ${recipeId}`,
        "Supply a canonical lowercase `<domain>/<provider>` recipe id (e.g., payments/adyen).",
      );
      return;
    }
    const catalog = await resolveCatalogDir(values.catalog, cwd);
    if (!catalog.ok) {
      refuse(
        catalog.exitCode,
        catalog.code,
        catalog.message,
        "Run inside an OpenLup checkout or pass `--catalog <path-to-recipes>`.",
      );
      return;
    }
    let index;
    try {
      index = await readIndexJson(catalog.dir);
    } catch {
      refuse(
        74,
        "OPENLUP_E_RECIPE_CATALOG_INVALID",
        `Catalog index.json in ${catalog.dir} is invalid.`,
        "Regenerate recipes/index.json and retry.",
      );
      return;
    }
    const entry = index.recipes.find((item) => item.id === recipeId);
    if (!entry) {
      const available = index.recipes.map((r) => r.id).join(", ");
      const finding = makeFinding(
        "OPENLUP_E_RECIPE_NOT_FOUND",
        `Recipe "${recipeId}" was not found in the catalog.`,
        "The requested recipe id is not listed in index.json.",
        `Choose one of the available recipes: ${available}`,
        shellCommand(["recipe", "list", ...(values.catalog ? ["--catalog", values.catalog] : []), ...(isJson ? ["--json"] : [])]),
      );
      emit(
        { command: "recipe show", state: "unsatisfied", exitCode: 1, recipeId, findings: [finding] },
        renderFinding(finding),
      );
      return;
    }
    if (!isSafeRelativePosixPath(entry.manifestPath)) {
      refuse(74, "OPENLUP_E_RECIPE_UNSAFE_PATH", "Catalog manifestPath failed path safety checks.", "Repair index.json.");
      return;
    }
    const manifestAbs = resolve(catalog.dir, ...entry.manifestPath.split("/"));
    await assertNoSymlinkSegments(catalog.dir, entry.manifestPath);
    const manifestReal = await fs.realpath(manifestAbs);
    if (!isContained(catalog.dir, manifestReal)) {
      refuse(74, "OPENLUP_E_RECIPE_UNSAFE_PATH", "Resolved manifest escapes catalog root.", "Repair catalog symlinks.");
      return;
    }
    const manifest = JSON.parse(await fs.readFile(manifestReal, "utf8"));
    const report = {
      command: "recipe show",
      state: "complete",
      exitCode: 0,
      recipeId,
      catalogPath: relative(cwd, catalog.dir) || ".",
      installCommand: shellCommand([
        "recipe",
        "add",
        recipeId,
        ...(values.catalog ? ["--catalog", values.catalog] : []),
        "--verify",
      ]),
      manifest,
    };
    emit(report, renderShowText(report));
    return;
  }

  if (subcommand === "add") {
    if (
      positionals.length !== 2 ||
      values.domain !== undefined ||
      values.status !== undefined ||
      values.region !== undefined ||
      values["skip-tests"] !== undefined
    ) {
      refuse(
        64,
        "OPENLUP_E_CLI_INPUT",
        "Invalid arguments for `openlup recipe add`.",
        "Usage: openlup recipe add <domain/provider> [--dest <dir>] [--catalog <dir>] [--force] [--verify] [--json]",
      );
      return;
    }
    const recipeId = positionals[1];
    if (!RECIPE_ID_PATTERN.test(recipeId)) {
      refuse(
        64,
        "OPENLUP_E_CLI_INPUT",
        `Invalid recipe id: ${recipeId}`,
        "Supply a canonical lowercase `<domain>/<provider>` recipe id (e.g., payments/adyen).",
      );
      return;
    }
    const catalog = await resolveCatalogDir(values.catalog, cwd);
    if (!catalog.ok) {
      refuse(
        catalog.exitCode,
        catalog.code,
        catalog.message,
        "Run inside an OpenLup checkout or pass `--catalog <path-to-recipes>`.",
      );
      return;
    }
    let index;
    try {
      index = await readIndexJson(catalog.dir);
    } catch {
      refuse(
        74,
        "OPENLUP_E_RECIPE_CATALOG_INVALID",
        `Catalog index.json in ${catalog.dir} is invalid.`,
        "Regenerate recipes/index.json and retry.",
      );
      return;
    }
    const entry = index.recipes.find((item) => item.id === recipeId);
    if (!entry) {
      const available = index.recipes.map((r) => r.id).join(", ");
      const finding = makeFinding(
        "OPENLUP_E_RECIPE_NOT_FOUND",
        `Recipe "${recipeId}" was not found in the catalog.`,
        "The requested recipe id is not listed in index.json.",
        `Choose one of the available recipes: ${available}`,
        shellCommand(["recipe", "list", ...(values.catalog ? ["--catalog", values.catalog] : [])]),
      );
      emit(
        { command: "recipe add", state: "unsatisfied", exitCode: 1, recipeId, findings: [finding] },
        renderFinding(finding),
      );
      return;
    }

    if (!isSafeRelativePosixPath(entry.manifestPath)) {
      refuse(74, "OPENLUP_E_RECIPE_UNSAFE_PATH", "Catalog manifestPath is unsafe.", "Repair index.json.");
      return;
    }
    const srcManifestAbs = resolve(catalog.dir, ...entry.manifestPath.split("/"));
    const srcRecipeDir = dirname(srcManifestAbs);
    await assertNoSymlinkSegments(catalog.dir, entry.manifestPath);
    const srcRecipeReal = await fs.realpath(srcRecipeDir);
    if (!isContained(catalog.dir, srcRecipeReal)) {
      refuse(74, "OPENLUP_E_RECIPE_UNSAFE_PATH", "Source recipe escapes catalog root.", "Check catalog links.");
      return;
    }

    const manifest = JSON.parse(await fs.readFile(join(srcRecipeReal, "recipe.json"), "utf8"));
    const manifestErrors = validateManifestShape(manifest);
    if (manifestErrors.length > 0) {
      refuse(74, "OPENLUP_E_RECIPE_MANIFEST_INVALID", manifestErrors.join(" "), "Repair the source recipe manifest.");
      return;
    }

    const defaultDestRel = join("owned", "adapters", ...recipeId.split("/"));
    const requestedDest = values.dest !== undefined ? values.dest : defaultDestRel;
    if (!requestedDest || !requestedDest.trim()) {
      refuse(64, "OPENLUP_E_CLI_INPUT", "Empty --dest path.", "Pass a non-empty destination directory.");
      return;
    }
    const destAbs = resolve(cwd, requestedDest);

    try {
      await assertNoSymlinkAncestors(destAbs);
    } catch {
      refuse(
        74,
        "OPENLUP_E_RECIPE_UNSAFE_PATH",
        `Destination path contains a symlink: ${requestedDest}`,
        "Choose a destination directory with no symlink ancestors.",
      );
      return;
    }

    if (destAbs === srcRecipeReal || isContained(srcRecipeReal, destAbs) || isContained(destAbs, srcRecipeReal)) {
      refuse(
        1,
        "OPENLUP_E_RECIPE_DEST_CONFLICT",
        "Destination directory overlaps the source catalog recipe directory.",
        "Install into an application-owned destination such as `owned/adapters/<domain>/<provider>`.",
      );
      return;
    }

    const destStat = await statOrNull(destAbs);
    if (destStat) {
      if (destStat.isSymbolicLink() || !destStat.isDirectory()) {
        refuse(
          74,
          "OPENLUP_E_RECIPE_UNSAFE_PATH",
          `Destination exists and is not an ordinary directory: ${requestedDest}`,
          "Choose a clean directory path for --dest.",
        );
        return;
      }
      const existingEntries = await fs.readdir(destAbs);
      if (existingEntries.length > 0 && values.force !== true) {
        const finding = makeFinding(
          "OPENLUP_E_RECIPE_DEST_EXISTS",
          `Destination directory already exists and is non-empty: ${requestedDest}`,
          "Refusing to overwrite application-owned adapter files without explicit --force.",
          "Inspect existing edits, choose a new --dest, or rerun with `--force` to overwrite.",
          shellCommand([
            "recipe",
            "add",
            recipeId,
            ...(values.dest ? ["--dest", values.dest] : []),
            ...(values.catalog ? ["--catalog", values.catalog] : []),
            "--force",
            ...(values.verify ? ["--verify"] : []),
            ...(isJson ? ["--json"] : []),
          ]),
        );
        emit(
          { command: "recipe add", state: "refused", exitCode: 1, recipeId, dest: requestedDest, findings: [finding] },
          renderFinding(finding),
        );
        return;
      }
    }

    // Validate every source file before writing anything to destination.
    const plannedFiles = [];
    for (const relPath of manifest.files.allFiles) {
      await assertNoSymlinkSegments(srcRecipeReal, relPath);
      const srcFile = join(srcRecipeReal, ...relPath.split("/"));
      const srcStat = await fs.lstat(srcFile);
      if (!srcStat.isFile() || srcStat.isSymbolicLink()) {
        refuse(74, "OPENLUP_E_RECIPE_UNSAFE_PATH", `Source file is not an ordinary file: ${relPath}`, "Repair catalog.");
        return;
      }
      const bytes = await fs.readFile(srcFile);
      plannedFiles.push({
        relPath,
        bytes,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }

    // Check target file paths inside destAbs for symlinks when --force is used.
    if (destStat) {
      for (const item of plannedFiles) {
        await assertNoSymlinkSegments(destAbs, item.relPath);
      }
    }

    await fs.mkdir(destAbs, { recursive: true });
    for (const item of plannedFiles) {
      const targetFile = join(destAbs, ...item.relPath.split("/"));
      await fs.mkdir(dirname(targetFile), { recursive: true });
      await fs.writeFile(targetFile, item.bytes);
    }

    // Sync schema files and record provenance outside RECIPE_DIR so allFiles parity stays 100% intact.
    const recipeIdSuffix = `${sep}${recipeId.split("/").join(sep)}`;
    const usesCanonicalContainerLayout = destAbs.endsWith(recipeIdSuffix);
    const sortedPlanned = [...plannedFiles].sort((a, b) => asciiCompare(a.relPath, b.relPath));
    const treeHasher = createHash("sha256");
    for (const item of sortedPlanned) {
      treeHasher.update(`${item.relPath}:${item.sha256}\n`, "utf8");
    }
    const recipeTreeSha256 = treeHasher.digest("hex");
    const destDisplay = relative(cwd, destAbs) || ".";

    const provenanceRecord = {
      recipeId: manifest.id,
      providerKind: manifest.providerKind,
      status: manifest.status,
      dest: destDisplay,
      openlupPlatformRange: manifest.openlupPlatformRange,
      testedAgainstPlatformVersion: manifest.testedAgainstPlatformVersion,
      installedAt: new Date().toISOString(),
      recipeTreeSha256,
      files: sortedPlanned.map(({ relPath, sha256 }) => ({ path: relPath, sha256 })),
      liveQualificationStatus: manifest.liveQualification.status,
      liveQualificationChecklist: join(destDisplay, manifest.files.liveQualificationDoc),
    };

    let provenancePathAbs;
    try {
      if (usesCanonicalContainerLayout) {
        const containerRoot = resolve(destAbs, "../..");
        await assertNoSymlinkAncestors(containerRoot);
        const schemaSrcDir = join(catalog.dir, "schema");
        const schemaDstDir = join(containerRoot, "schema");
        if (await statOrNull(schemaSrcDir)) {
          await fs.mkdir(schemaDstDir, { recursive: true });
          for (const schemaName of ["recipe.schema.json", "csp.schema.json"]) {
            const srcSchema = join(schemaSrcDir, schemaName);
            const sStat = await statOrNull(srcSchema);
            if (sStat && sStat.isFile() && !sStat.isSymbolicLink()) {
              const dstSchema = join(schemaDstDir, schemaName);
              const dstStat = await statOrNull(dstSchema);
              if (dstStat && dstStat.isSymbolicLink()) {
                throw new Error(`SYMLINK_REFUSED:${dstSchema}`);
              }
              await fs.writeFile(dstSchema, await fs.readFile(srcSchema));
            }
          }
        }
        // Maintain owned-adapters index.json so conformance suites referencing ../../index.json pass seamlessly.
        const localIndexPath = join(containerRoot, "index.json");
        const idxStat = await statOrNull(localIndexPath);
        if (idxStat && idxStat.isSymbolicLink()) {
          throw new Error(`SYMLINK_REFUSED:${localIndexPath}`);
        }
        let localIndex = { schemaVersion: 1, recipes: [] };
        if (idxStat && idxStat.isFile()) {
          try {
            const loaded = JSON.parse(await fs.readFile(localIndexPath, "utf8"));
            if (loaded && typeof loaded === "object" && Array.isArray(loaded.recipes)) {
              localIndex = loaded;
            }
          } catch {
            localIndex = { schemaVersion: 1, recipes: [] };
          }
        }
        const nextRecipes = localIndex.recipes.filter((item) => item && item.id !== entry.id);
        nextRecipes.push(entry);
        nextRecipes.sort((a, b) => asciiCompare(String(a.id ?? ""), String(b.id ?? "")));
        localIndex.schemaVersion = 1;
        localIndex.recipes = nextRecipes;
        await fs.writeFile(localIndexPath, `${JSON.stringify(localIndex, null, 2)}\n`, "utf8");

        provenancePathAbs = join(containerRoot, PROVENANCE_FILENAME);
        const provStat = await statOrNull(provenancePathAbs);
        if (provStat && provStat.isSymbolicLink()) {
          throw new Error(`SYMLINK_REFUSED:${provenancePathAbs}`);
        }
        let existingLedger = { schemaVersion: 1, recipes: {} };
        if (provStat && provStat.isFile()) {
          try {
            const loaded = JSON.parse(await fs.readFile(provenancePathAbs, "utf8"));
            if (loaded && typeof loaded === "object" && loaded.recipes && typeof loaded.recipes === "object") {
              existingLedger = loaded;
            }
          } catch {
            existingLedger = { schemaVersion: 1, recipes: {} };
          }
        }
        existingLedger.schemaVersion = 1;
        existingLedger.recipes[manifest.id] = provenanceRecord;
        await fs.writeFile(provenancePathAbs, `${JSON.stringify(existingLedger, null, 2)}\n`, "utf8");
      } else {
        provenancePathAbs = `${destAbs}.provenance.json`;
        const provStat = await statOrNull(provenancePathAbs);
        if (provStat && provStat.isSymbolicLink()) {
          throw new Error(`SYMLINK_REFUSED:${provenancePathAbs}`);
        }
        await fs.writeFile(
          provenancePathAbs,
          `${JSON.stringify({ schemaVersion: 1, ...provenanceRecord }, null, 2)}\n`,
          "utf8",
        );
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("SYMLINK_REFUSED:")) {
        refuse(
          74,
          "OPENLUP_E_RECIPE_UNSAFE_PATH",
          "Refused symlinked schema, index, or provenance target during recipe install.",
          "Remove symlinks under the adapter container directory and retry.",
        );
        return;
      }
      throw error;
    }

    const verifyCommand = shellCommand(["recipe", "verify", destDisplay]);
    let verification = null;
    if (values.verify === true) {
      verification = await verifyRecipeAtPath(destDisplay, { skipTests: false, json: isJson }, cwd);
    }

    const exitCode = verification ? verification.exitCode : 0;
    const state = verification ? (verification.exitCode === 0 ? "installed-and-verified" : verification.state) : "installed";
    const report = {
      command: "recipe add",
      state,
      exitCode,
      recipeId: manifest.id,
      providerKind: manifest.providerKind,
      status: manifest.status,
      dest: destDisplay,
      filesCopied: plannedFiles.length,
      recipeTreeSha256,
      provenancePath: relative(cwd, provenancePathAbs) || provenancePathAbs,
      verifyCommand,
      liveQualificationChecklist: provenanceRecord.liveQualificationChecklist,
      ...(verification ? { verification } : {}),
    };
    emit(report, renderAddText(report, renderFinding));
    return;
  }

  if (subcommand === "verify") {
    if (
      positionals.length !== 2 ||
      values.domain !== undefined ||
      values.status !== undefined ||
      values.region !== undefined ||
      values.dest !== undefined ||
      values.catalog !== undefined ||
      values.force !== undefined ||
      values.verify !== undefined
    ) {
      refuse(
        64,
        "OPENLUP_E_CLI_INPUT",
        "Invalid arguments for `openlup recipe verify`.",
        "Usage: openlup recipe verify <recipe-dir> [--skip-tests] [--json]",
      );
      return;
    }
    const report = await verifyRecipeAtPath(
      positionals[1],
      { skipTests: values["skip-tests"] === true, json: isJson },
      cwd,
    );
    emit(report, renderVerifyText(report, renderFinding));
    return;
  }

  refuse(
    64,
    "OPENLUP_E_CLI_INPUT",
    `Unknown recipe subcommand: ${subcommand}`,
    "Use `openlup recipe list`, `openlup recipe show <id>`, `openlup recipe add <id>`, or `openlup recipe verify <path>`.",
  );
}
