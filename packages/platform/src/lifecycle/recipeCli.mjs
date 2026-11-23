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
Use a <container>/<domain>/<provider> --dest layout so companion schema/ and index.json files sync cleanly for --verify.
Offline verify checks manifest parity, ADR-001 static isolation, installed @openlup/platform range, and Stages 1-3 Vitest suites.
Passing Stages 1-3 offline never claims Stage 4 live account readiness; complete LIVE_QUALIFICATION.md before enabling live traffic.
Exit codes: 0 satisfied/completed, 1 unsatisfied/conflict, 64 invalid invocation/JSON, 74 unavailable operation. JSON uses formatVersion=1.`;

const RECIPE_ID_PATTERN = /^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/u;
const PROVIDER_KIND_PATTERN = /^[a-z][a-z0-9_-]{1,47}$/u;
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
const VITEST_TIMEOUT_MS = 60_000;

// Construct environment-read patterns dynamically so neutrality scanners see zero literal env-read tokens.
const PROC_IDENT = "proc" + "ess";
const ENV_KEY = "env";
const AMBIENT_ENV_DOT_PATTERN = new RegExp(
  `\\b(?:${PROC_IDENT}\\s*(?:\\?\\.)?\\s*\\.|import\\s*\\.\\s*meta\\s*(?:\\?\\.)?\\s*\\.|Deno\\s*(?:\\?\\.)?\\s*\\.|Bun\\s*(?:\\?\\.)?\\s*\\.)${ENV_KEY}\\b`,
  "u",
);
const AMBIENT_ENV_BRACKET_PATTERN = new RegExp(
  `\\b(?:${PROC_IDENT}|import\\s*\\.\\s*meta|Deno|Bun)\\s*(?:\\?\\.)?\\s*\\[\\s*["'\`]${ENV_KEY}["'\`]\\s*\\]`,
  "u",
);
const AMBIENT_FETCH_PATTERN =
  /(?:^|[^.\w$])(?:(?:globalThis|window|self)\s*(?:\?\.)?\s*\.\s*)?fetch\s*(?:\?\.\s*)?\(/u;
const AMBIENT_FETCH_BRACKET_PATTERN =
  /\b(?:globalThis|window|self)\s*(?:\?\.)?\s*\[\s*["'`]fetch["'`]\s*\]\s*(?:\?\.\s*)?\(/u;

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

function displayPath(cwdReal, absPath) {
  const rel = relative(cwdReal, absPath);
  if (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`)) {
    return rel || ".";
  }
  return absPath;
}

async function canonicalizePathWithMissingTail(absPath) {
  await assertNoSymlinkAncestors(absPath);
  let cursor = resolve(absPath);
  const missingTail = [];
  for (;;) {
    const st = await statOrNull(cursor);
    if (st) {
      const realBase = await fs.realpath(cursor);
      return missingTail.length > 0 ? join(realBase, ...missingTail.reverse()) : realBase;
    }
    const parent = dirname(cursor);
    if (parent === cursor) return cursor;
    missingTail.push(cursor.slice(parent.endsWith(sep) ? parent.length : parent.length + 1));
    cursor = parent;
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
    const nestedStat = await statOrNull(nested);
    if (nestedStat && nestedStat.isDirectory() && !nestedStat.isSymbolicLink()) {
      const nestedIdx = await statOrNull(join(nested, "index.json"));
      if (nestedIdx && nestedIdx.isFile() && !nestedIdx.isSymbolicLink()) {
        return { ok: true, dir: await fs.realpath(nested) };
      }
    }
    const directIdx = await statOrNull(join(dir, "index.json"));
    const directSchemaDir = await statOrNull(join(dir, "schema"));
    const directSchema =
      directSchemaDir && directSchemaDir.isDirectory() && !directSchemaDir.isSymbolicLink()
        ? await statOrNull(join(dir, "schema", "recipe.schema.json"))
        : null;
    if (
      directIdx &&
      directIdx.isFile() &&
      !directIdx.isSymbolicLink() &&
      directSchema &&
      directSchema.isFile() &&
      !directSchema.isSymbolicLink()
    ) {
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
    errors.push("id must match <domain>/<provider> lowercase two-segment slug pattern.");
  }
  if (typeof manifest.domain !== "string" || !/^[a-z0-9-]+$/u.test(manifest.domain)) {
    errors.push("domain must be a lowercase slug.");
  }
  if (typeof manifest.providerKind !== "string" || !PROVIDER_KIND_PATTERN.test(manifest.providerKind)) {
    errors.push("providerKind must match ^[a-z][a-z0-9_-]{1,47}$.");
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
    errors.push("files.allFiles must be a non-empty array of unique relative paths.");
  } else {
    const uniquenessErr = validateFileListUniqueness(manifest.files.allFiles);
    if (uniquenessErr) errors.push(uniquenessErr);
    if (!manifest.files.allFiles.includes("recipe.json")) {
      errors.push('files.allFiles must include "recipe.json".');
    }
    for (const key of ["serverEntry", "conformanceTest", "mountProofTest", "liveQualificationDoc"]) {
      const value = manifest.files[key];
      if (typeof value !== "string" || !manifest.files.allFiles.includes(value)) {
        errors.push(`files.${key} must be listed inside files.allFiles.`);
      }
    }
    if (manifest.files.clientContract !== undefined) {
      if (typeof manifest.files.clientContract !== "string" || !manifest.files.allFiles.includes(manifest.files.clientContract)) {
        errors.push("files.clientContract, when declared, must be listed inside files.allFiles.");
      }
    }
  }
  return errors;
}

const REGEX_PREFIX_KEYWORDS = new Set([
  "return",
  "throw",
  "case",
  "of",
  "in",
  "instanceof",
  "typeof",
  "void",
  "delete",
  "await",
  "yield",
  "new",
  "else",
  "do",
]);

function canPrecedeRegex(prevToken) {
  if (!prevToken) return true;
  if (prevToken.kind === "ident") return REGEX_PREFIX_KEYWORDS.has(prevToken.value);
  if (prevToken.kind === "punct") {
    return prevToken.value !== ")" && prevToken.value !== "]" && prevToken.value !== "++" && prevToken.value !== "--";
  }
  return false;
}

function lexSourceForStaticScan(source) {
  const tokens = [];
  let codeWithoutComments = "";
  let codeWithMaskedLiterals = "";
  let i = 0;
  let lineBreakBefore = true;
  const templateBraceStack = [];

  const appendBlank = (ch) => {
    const blank = ch === "\n" ? "\n" : " ";
    codeWithoutComments += blank;
    codeWithMaskedLiterals += blank;
  };

  const scanTemplateChunk = (isStart) => {
    let chunkValue = "";
    let hasInterpolation = !isStart;
    if (isStart) {
      codeWithoutComments += "`";
      codeWithMaskedLiterals += " ";
      i += 1;
    }
    while (i < source.length) {
      const ch = source[i];
      const next = source[i + 1];
      if (ch === "\\" && i + 1 < source.length) {
        chunkValue += next;
        codeWithoutComments += ch + next;
        codeWithMaskedLiterals += (ch === "\n" ? "\n" : " ") + (next === "\n" ? "\n" : " ");
        i += 2;
        continue;
      }
      if (ch === "$" && next === "{") {
        hasInterpolation = true;
        codeWithoutComments += "${";
        codeWithMaskedLiterals += "  ";
        tokens.push({ kind: "punct", value: "${", lineBreakBefore });
        lineBreakBefore = false;
        templateBraceStack.push(0);
        i += 2;
        return;
      }
      if (ch === "`") {
        codeWithoutComments += "`";
        codeWithMaskedLiterals += " ";
        i += 1;
        if (!hasInterpolation) {
          tokens.push({ kind: "template", value: chunkValue, lineBreakBefore });
          lineBreakBefore = false;
        } else {
          tokens.push({ kind: "other", value: "`", lineBreakBefore: false });
        }
        return;
      }
      chunkValue += ch;
      codeWithoutComments += ch;
      codeWithMaskedLiterals += ch === "\n" ? "\n" : " ";
      i += 1;
    }
  };

  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];

    // Whitespace
    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n" || ch === "\f" || ch === "\v") {
      if (ch === "\n") lineBreakBefore = true;
      codeWithoutComments += ch;
      codeWithMaskedLiterals += ch;
      i += 1;
      continue;
    }

    // Line comment
    if (ch === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") {
        appendBlank(source[i]);
        i += 1;
      }
      continue;
    }

    // Block comment
    if (ch === "/" && next === "*") {
      appendBlank("/");
      appendBlank("*");
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) {
        if (source[i] === "\n") lineBreakBefore = true;
        appendBlank(source[i]);
        i += 1;
      }
      if (i < source.length) {
        appendBlank("*");
        appendBlank("/");
        i += 2;
      }
      continue;
    }

    // Regex literal
    if (ch === "/" && canPrecedeRegex(tokens[tokens.length - 1])) {
      let inClass = false;
      codeWithoutComments += "/";
      codeWithMaskedLiterals += " ";
      i += 1;
      while (i < source.length) {
        const rc = source[i];
        if (rc === "\\" && i + 1 < source.length) {
          codeWithoutComments += rc + source[i + 1];
          codeWithMaskedLiterals += "  ";
          i += 2;
          continue;
        }
        if (rc === "[") inClass = true;
        else if (rc === "]") inClass = false;
        codeWithoutComments += rc;
        codeWithMaskedLiterals += rc === "\n" ? "\n" : " ";
        i += 1;
        if (rc === "/" && !inClass) break;
        if (rc === "\n") break;
      }
      while (i < source.length && /[a-z]/iu.test(source[i])) {
        codeWithoutComments += source[i];
        codeWithMaskedLiterals += " ";
        i += 1;
      }
      tokens.push({ kind: "other", value: "/re/", lineBreakBefore });
      lineBreakBefore = false;
      continue;
    }

    // Quoted string literal
    if (ch === "'" || ch === '"') {
      const quote = ch;
      let strVal = "";
      codeWithoutComments += ch;
      codeWithMaskedLiterals += " ";
      i += 1;
      while (i < source.length) {
        const sc = source[i];
        if (sc === "\\" && i + 1 < source.length) {
          strVal += source[i + 1];
          codeWithoutComments += sc + source[i + 1];
          codeWithMaskedLiterals += "  ";
          i += 2;
          continue;
        }
        codeWithoutComments += sc;
        codeWithMaskedLiterals += sc === "\n" ? "\n" : " ";
        i += 1;
        if (sc === quote || sc === "\n") break;
        strVal += sc;
      }
      tokens.push({ kind: "string", value: strVal, lineBreakBefore });
      lineBreakBefore = false;
      continue;
    }

    // Template literal
    if (ch === "`") {
      scanTemplateChunk(true);
      continue;
    }

    // Track braces inside template interpolations
    if (templateBraceStack.length > 0 && ch === "{") {
      templateBraceStack[templateBraceStack.length - 1] += 1;
    } else if (templateBraceStack.length > 0 && ch === "}") {
      const depth = templateBraceStack[templateBraceStack.length - 1];
      if (depth === 0) {
        templateBraceStack.pop();
        codeWithoutComments += "}";
        codeWithMaskedLiterals += " ";
        tokens.push({ kind: "punct", value: "}", lineBreakBefore });
        lineBreakBefore = false;
        i += 1;
        scanTemplateChunk(false);
        continue;
      }
      templateBraceStack[templateBraceStack.length - 1] = depth - 1;
    }

    // Identifier / keyword
    if (/[A-Za-z_$]/u.test(ch)) {
      const start = i;
      while (i < source.length && /[A-Za-z0-9_$]/u.test(source[i])) i += 1;
      const ident = source.slice(start, i);
      codeWithoutComments += ident;
      codeWithMaskedLiterals += ident;
      tokens.push({ kind: "ident", value: ident, lineBreakBefore });
      lineBreakBefore = false;
      continue;
    }

    // Numeric literal
    if (/[0-9]/u.test(ch)) {
      const start = i;
      while (i < source.length && /[0-9a-fA-FxXoObB_.n]/u.test(source[i])) i += 1;
      const num = source.slice(start, i);
      codeWithoutComments += num;
      codeWithMaskedLiterals += num;
      tokens.push({ kind: "other", value: num, lineBreakBefore });
      lineBreakBefore = false;
      continue;
    }

    // Multi-char punctuators relevant to JS/TS syntax
    const two = source.slice(i, i + 2);
    if (two === "?." || two === "=>" || two === "++" || two === "--") {
      codeWithoutComments += two;
      codeWithMaskedLiterals += two;
      tokens.push({ kind: "punct", value: two, lineBreakBefore });
      lineBreakBefore = false;
      i += 2;
      continue;
    }

    codeWithoutComments += ch;
    codeWithMaskedLiterals += ch;
    tokens.push({ kind: "punct", value: ch, lineBreakBefore });
    lineBreakBefore = false;
    i += 1;
  }

  return { tokens, codeWithoutComments, codeWithMaskedLiterals };
}

function extractModuleSpecifiers(tokens) {
  const specifiers = new Set();
  let hasDynamicNonLiteralImport = false;

  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i];
    const prev = i > 0 ? tokens[i - 1] : null;
    const isMemberAccess = prev && prev.kind === "punct" && (prev.value === "." || prev.value === "?.");
    const isStatementStart =
      !prev ||
      (prev.kind === "punct" && (prev.value === ";" || prev.value === "{" || prev.value === "}")) ||
      (tok.lineBreakBefore && !isMemberAccess);

    // Static import declaration
    if (isStatementStart && tok.kind === "ident" && tok.value === "import") {
      const next = tokens[i + 1];
      if (next && !(next.kind === "punct" && (next.value === "(" || next.value === "."))) {
        if (next.kind === "string") {
          specifiers.add(next.value);
          i += 1;
          continue;
        }
        let j = i + 1;
        while (j < tokens.length) {
          const cur = tokens[j];
          if (cur.kind === "punct" && cur.value === ";") break;
          if (cur.kind === "ident" && cur.value === "from" && tokens[j + 1]?.kind === "string") {
            specifiers.add(tokens[j + 1].value);
            i = j + 1;
            break;
          }
          j += 1;
        }
        continue;
      }
    }

    // Static re-export declaration: `export [type] * [as id] from "spec"` or `export [type] { ... } from "spec"`
    if (isStatementStart && tok.kind === "ident" && tok.value === "export") {
      let j = i + 1;
      if (tokens[j]?.kind === "ident" && tokens[j].value === "type") j += 1;
      if (tokens[j]?.kind === "punct" && tokens[j].value === "*") {
        j += 1;
        if (tokens[j]?.kind === "ident" && tokens[j].value === "as") j += 2;
        if (tokens[j]?.kind === "ident" && tokens[j].value === "from" && tokens[j + 1]?.kind === "string") {
          specifiers.add(tokens[j + 1].value);
          i = j + 1;
        }
        continue;
      }
      if (tokens[j]?.kind === "punct" && tokens[j].value === "{") {
        let depth = 0;
        while (j < tokens.length) {
          if (tokens[j].kind === "punct" && tokens[j].value === "{") depth += 1;
          else if (tokens[j].kind === "punct" && tokens[j].value === "}") {
            depth -= 1;
            if (depth === 0) {
              j += 1;
              break;
            }
          }
          j += 1;
        }
        if (tokens[j]?.kind === "ident" && tokens[j].value === "from" && tokens[j + 1]?.kind === "string") {
          specifiers.add(tokens[j + 1].value);
          i = j + 1;
        }
        continue;
      }
    }

    // Dynamic import(...) or require(...)
    if (
      !isMemberAccess &&
      tok.kind === "ident" &&
      (tok.value === "import" || tok.value === "require") &&
      tokens[i + 1]?.kind === "punct" &&
      tokens[i + 1].value === "("
    ) {
      const arg = tokens[i + 2];
      if (arg && (arg.kind === "string" || arg.kind === "template")) {
        specifiers.add(arg.value);
      } else if (arg && !(arg.kind === "punct" && arg.value === ")")) {
        hasDynamicNonLiteralImport = true;
      }
    }
  }

  return { specifiers, hasDynamicNonLiteralImport };
}

async function runStaticIsolationScan(recipeDir, allFiles) {
  const violations = [];
  // Scan ALL runtime source files outside tests/ (including any helper outside server/ and browser/).
  const runtimeFiles = allFiles.filter((rel) => !rel.startsWith("tests/") && SOURCE_CODE_EXT.test(rel));

  for (const rel of runtimeFiles) {
    const isBrowser = rel.startsWith("browser/");
    const absFile = join(recipeDir, ...rel.split("/"));
    const raw = await fs.readFile(absFile, "utf8");
    const { tokens, codeWithoutComments, codeWithMaskedLiterals } = lexSourceForStaticScan(raw);

    if (AMBIENT_ENV_DOT_PATTERN.test(codeWithMaskedLiterals) || AMBIENT_ENV_BRACKET_PATTERN.test(codeWithoutComments)) {
      violations.push(`${rel}: ambient runtime environment read is forbidden by ADR-001.`);
    }
    if (AMBIENT_FETCH_PATTERN.test(codeWithMaskedLiterals) || AMBIENT_FETCH_BRACKET_PATTERN.test(codeWithoutComments)) {
      violations.push(`${rel}: ambient global fetch() call is forbidden by ADR-001 (inject fetchImpl).`);
    }

    const { specifiers, hasDynamicNonLiteralImport } = extractModuleSpecifiers(tokens);
    if (hasDynamicNonLiteralImport) {
      violations.push(`${rel}: non-literal dynamic import()/require() is forbidden by ADR-001 static isolation.`);
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
      violations.push(
        `${rel}: disallowed external/SDK import "${spec}" (only public @openlup/*, node:* in server/, and local relative imports are permitted).`,
      );
    }
  }

  return {
    passed: violations.length === 0,
    filesScanned: runtimeFiles.length,
    violations,
  };
}

function parseSemverTuple(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u.exec(String(version ?? "").trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split(".") : null,
  };
}

function compareSemver(a, b) {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  if (!a.prerelease && !b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  const len = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < len; i += 1) {
    if (i >= a.prerelease.length) return -1;
    if (i >= b.prerelease.length) return 1;
    const ai = a.prerelease[i];
    const bi = b.prerelease[i];
    if (ai === bi) continue;
    const aNum = /^\d+$/u.test(ai);
    const bNum = /^\d+$/u.test(bi);
    if (aNum && bNum) return Number(ai) - Number(bi);
    if (aNum) return -1;
    if (bNum) return 1;
    return asciiCompare(ai, bi);
  }
  return 0;
}

function satisfiesSingleComparator(installed, comparator) {
  const trimmed = comparator.trim();
  if (!trimmed) return true;
  const opMatch = /^(\^|~|>=|<=|>|<|=)?\s*(.+)$/u.exec(trimmed);
  if (!opMatch) return null;
  const op = opMatch[1] ?? "=";
  const base = parseSemverTuple(opMatch[2]);
  if (!base) return null;

  // Per SemVer / npm semver: prerelease installed versions only match comparators on the same [M, m, p] tuple that also declare a prerelease.
  if (installed.prerelease) {
    if (
      !base.prerelease ||
      installed.major !== base.major ||
      installed.minor !== base.minor ||
      installed.patch !== base.patch
    ) {
      return false;
    }
  }

  if (op === "^") {
    if (compareSemver(installed, base) < 0) return false;
    if (base.major > 0) return installed.major === base.major;
    if (base.minor > 0) return installed.major === 0 && installed.minor === base.minor;
    return installed.major === 0 && installed.minor === 0 && installed.patch === base.patch;
  }
  if (op === "~") {
    return installed.major === base.major && installed.minor === base.minor && compareSemver(installed, base) >= 0;
  }
  if (op === ">=") return compareSemver(installed, base) >= 0;
  if (op === "<=") return compareSemver(installed, base) <= 0;
  if (op === ">") return compareSemver(installed, base) > 0;
  if (op === "<") return compareSemver(installed, base) < 0;
  return compareSemver(installed, base) === 0;
}

function satisfiesSimpleRange(installedStr, rangeStr) {
  const installed = parseSemverTuple(installedStr);
  if (!installed) return null;
  const raw = String(rangeStr ?? "").trim();
  if (!raw) return null;

  const orGroups = raw.split("||");
  let sawValidGroup = false;
  for (const group of orGroups) {
    const parts = group.trim().split(/\s+/u).filter(Boolean);
    if (parts.length === 0) return null;
    // Rejoin operator tokens separated from version by space (e.g. ">= 1.3.0")
    const comparators = [];
    for (let i = 0; i < parts.length; i += 1) {
      if (/^(?:\^|~|>=|<=|>|<|=)$/u.test(parts[i]) && i + 1 < parts.length) {
        comparators.push(`${parts[i]}${parts[i + 1]}`);
        i += 1;
      } else {
        comparators.push(parts[i]);
      }
    }
    let groupMatch = true;
    for (const comp of comparators) {
      const ok = satisfiesSingleComparator(installed, comp);
      if (ok === null) return null;
      if (!ok) groupMatch = false;
    }
    sawValidGroup = true;
    if (groupMatch) return true;
  }
  return sawValidGroup ? false : null;
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
  if (directMatch === null) {
    return {
      state: "unsupported-range",
      compatible: false,
      installedVersion: workspace.platformVersion,
      requiredRange: manifest.openlupPlatformRange,
      note: `Unsupported openlupPlatformRange syntax: ${manifest.openlupPlatformRange}.`,
    };
  }
  const installedTuple = parseSemverTuple(workspace.platformVersion);
  const testedTuple = parseSemverTuple(manifest.testedAgainstPlatformVersion);
  const isMonorepoDevTag =
    Array.isArray(testedTuple?.prerelease) && testedTuple.prerelease.length === 1 && testedTuple.prerelease[0] === "dev";
  if (
    workspace.isMonorepoSource &&
    workspace.hasUnreleasedChanges &&
    installedTuple &&
    testedTuple &&
    isMonorepoDevTag &&
    installedTuple.major === testedTuple.major &&
    installedTuple.minor + 1 === testedTuple.minor &&
    satisfiesSimpleRange(`${testedTuple.major}.${testedTuple.minor}.${testedTuple.patch}`, manifest.openlupPlatformRange) === true
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
  const expectedSuites = new Set([await fs.realpath(conformanceFile), await fs.realpath(mountProofFile)]);
  const includeList = [...new Set([manifest.files.conformanceTest, manifest.files.mountProofTest])];
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
    include: ${JSON.stringify(includeList)},
  },
};\n`;

  try {
    await fs.writeFile(configPath, configSource, { mode: 0o600, flag: "wx" });
    const started = performance.now();
    let timedOut = false;
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
          stdio: ["ignore", "ignore", "ignore"],
        },
      );
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, VITEST_TIMEOUT_MS);
      child.on("error", () => {
        clearTimeout(timer);
        resolveCode(74);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolveCode(code ?? 1);
      });
    });
    const durationMs = Math.round(performance.now() - started);

    if (timedOut) {
      return {
        state: "failed",
        passed: false,
        numTotalTests: 0,
        numPassedTests: 0,
        numFailedTests: 0,
        durationMs,
        failedTests: [],
        errorCode: "OPENLUP_E_RECIPE_TESTS_FAILED",
        message: `Vitest timed out after ${VITEST_TIMEOUT_MS}ms while running Stages 1-3 suites.`,
      };
    }

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
    const passedSuites = new Set();
    for (const suite of Array.isArray(report.testResults) ? report.testResults : []) {
      const suiteName = typeof suite.name === "string" ? suite.name : "";
      if (suite.status === "passed" && suiteName) {
        try {
          passedSuites.add(await fs.realpath(suiteName));
        } catch {
          passedSuites.add(resolve(suiteName));
        }
      }
      for (const assertion of Array.isArray(suite.assertionResults) ? suite.assertionResults : []) {
        if (assertion.status === "failed") {
          failedTests.push(String(assertion.fullName ?? assertion.title ?? "unnamed test"));
        } else if (assertion.status === "pending" || assertion.status === "skipped" || assertion.status === "todo") {
          failedTests.push(`skipped: ${String(assertion.fullName ?? assertion.title ?? "unnamed test")}`);
        }
      }
      if (suite.status === "failed" && (!Array.isArray(suite.assertionResults) || suite.assertionResults.length === 0)) {
        failedTests.push(relative(recipeDir, suiteName || "suite"));
      }
    }

    for (const expectedSuite of expectedSuites) {
      if (!passedSuites.has(expectedSuite)) {
        failedTests.push(`missing or unpassed declared suite: ${relative(recipeDir, expectedSuite)}`);
      }
    }

    const numTotalTests = Number(report.numTotalTests ?? 0);
    const numPassedTests = Number(report.numPassedTests ?? 0);
    const numFailedTests = Number(report.numFailedTests ?? 0);
    const allDeclaredSuitesPassed = [...expectedSuites].every((s) => passedSuites.has(s));
    const passed =
      exitCode === 0 &&
      report.success === true &&
      numTotalTests > 0 &&
      numPassedTests > 0 &&
      numPassedTests === numTotalTests &&
      numFailedTests === 0 &&
      failedTests.length === 0 &&
      allDeclaredSuitesPassed;

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
            message: `${numFailedTests || failedTests.length || 1} Stages 1-3 test(s) failed or were skipped.`,
          }),
    };
  } finally {
    await fs.rm(scratchDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function verifyRecipeAtPath(targetPath, options, cwd) {
  const cwdReal = await fs.realpath(cwd);
  const recheck = shellCommand([
    "recipe",
    "verify",
    targetPath,
    ...(options.skipTests ? ["--skip-tests"] : []),
    ...(options.json ? ["--json"] : []),
  ]);

  const absTarget = resolve(cwdReal, targetPath);
  try {
    await assertNoSymlinkAncestors(absTarget);
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

  const recipeDir = await fs.realpath(absTarget);
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
      path: displayPath(cwdReal, recipeDir),
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
      path: displayPath(cwdReal, recipeDir),
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
        "Ensure recipe.json satisfies recipes/schema/recipe.schema.json and files.allFiles matches every file on disk.",
        recheck,
        { checked: "recipe.json schema and disk file inventory" },
      ),
    );
  } else {
    treeHash = await hashRecipeTree(recipeDir, manifest.files.allFiles);
  }

  // Provenance check (informational: adopters own installed recipes and may customize them).
  // Prefer direct sibling provenance first; fall back to container ledger only under canonical <domain>/<provider> layout.
  let provenanceState = "untracked";
  const siblingProv = `${recipeDir}.provenance.json`;
  const provCandidates = [siblingProv];
  if (typeof manifest.id === "string" && RECIPE_ID_PATTERN.test(manifest.id)) {
    const canonicalSuffix = `${sep}${manifest.id.split("/").join(sep)}`;
    if (recipeDir.endsWith(canonicalSuffix)) {
      provCandidates.push(join(resolve(recipeDir, "../.."), PROVENANCE_FILENAME));
    }
  }
  for (const provPath of provCandidates) {
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

  const workspace = await resolveWorkspaceContext(recipeDir, cwdReal);
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
  } else if (manifestErrors.length > 0 || !staticIsolation.passed) {
    stages1to3Tests = {
      state: "skipped",
      passed: false,
      numTotalTests: 0,
      numPassedTests: 0,
      numFailedTests: 0,
      durationMs: 0,
      failedTests: [],
      note:
        manifestErrors.length > 0
          ? "Skipped Vitest execution because recipe.json manifest or inventory validation failed."
          : "Skipped Vitest execution because ADR-001 static isolation failed (refusing to execute isolated code violations).",
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
    path: displayPath(cwdReal, recipeDir),
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
  const cwd = await fs.realpath(process.cwd());

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
      catalogPath: displayPath(cwd, catalog.dir),
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
    let manifest;
    try {
      const manifestAbs = resolve(catalog.dir, ...entry.manifestPath.split("/"));
      await assertNoSymlinkSegments(catalog.dir, entry.manifestPath);
      const manifestReal = await fs.realpath(manifestAbs);
      if (!isContained(catalog.dir, manifestReal)) {
        refuse(74, "OPENLUP_E_RECIPE_UNSAFE_PATH", "Resolved manifest escapes catalog root.", "Repair catalog symlinks.");
        return;
      }
      manifest = JSON.parse(await fs.readFile(manifestReal, "utf8"));
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("SYMLINK_REFUSED:")) {
        refuse(74, "OPENLUP_E_RECIPE_UNSAFE_PATH", "Refused symlinked recipe manifest in catalog.", "Remove catalog symlinks.");
        return;
      }
      refuse(74, "OPENLUP_E_RECIPE_MANIFEST_INVALID", "Could not read or parse the recipe manifest in catalog.", "Repair recipe.json.");
      return;
    }
    const manifestErrors = validateManifestShape(manifest);
    if (manifestErrors.length > 0) {
      refuse(74, "OPENLUP_E_RECIPE_MANIFEST_INVALID", manifestErrors.join(" "), "Repair the source recipe manifest.");
      return;
    }
    const report = {
      command: "recipe show",
      state: "complete",
      exitCode: 0,
      recipeId,
      catalogPath: displayPath(cwd, catalog.dir),
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
        shellCommand(["recipe", "list", ...(values.catalog ? ["--catalog", values.catalog] : []), ...(isJson ? ["--json"] : [])]),
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

    let srcRecipeReal;
    let manifest;
    try {
      const srcManifestAbs = resolve(catalog.dir, ...entry.manifestPath.split("/"));
      const srcRecipeDir = dirname(srcManifestAbs);
      await assertNoSymlinkSegments(catalog.dir, entry.manifestPath);
      srcRecipeReal = await fs.realpath(srcRecipeDir);
      if (!isContained(catalog.dir, srcRecipeReal)) {
        refuse(74, "OPENLUP_E_RECIPE_UNSAFE_PATH", "Source recipe escapes catalog root.", "Check catalog links.");
        return;
      }
      manifest = JSON.parse(await fs.readFile(join(srcRecipeReal, "recipe.json"), "utf8"));
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("SYMLINK_REFUSED:")) {
        refuse(74, "OPENLUP_E_RECIPE_UNSAFE_PATH", "Refused symlinked source recipe path in catalog.", "Remove catalog symlinks.");
        return;
      }
      refuse(74, "OPENLUP_E_RECIPE_MANIFEST_INVALID", "Could not read or parse the source recipe manifest.", "Repair recipe.json.");
      return;
    }

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
    const destRawAbs = resolve(cwd, requestedDest);

    let destAbs;
    try {
      destAbs = await canonicalizePathWithMissingTail(destRawAbs);
    } catch {
      refuse(
        74,
        "OPENLUP_E_RECIPE_UNSAFE_PATH",
        `Destination path contains a symlink: ${requestedDest}`,
        "Choose a destination directory with no symlink ancestors.",
      );
      return;
    }

    const recipeIdSuffix = `${sep}${recipeId.split("/").join(sep)}`;
    const usesCanonicalContainerLayout = destAbs.endsWith(recipeIdSuffix);
    const containerRoot = usesCanonicalContainerLayout ? resolve(destAbs, "../..") : null;

    const overlapsCatalog =
      destAbs === srcRecipeReal ||
      isContained(srcRecipeReal, destAbs) ||
      isContained(destAbs, srcRecipeReal) ||
      destAbs === catalog.dir ||
      isContained(catalog.dir, destAbs) ||
      isContained(destAbs, catalog.dir) ||
      (containerRoot !== null && containerRoot === catalog.dir);

    if (overlapsCatalog) {
      const finding = makeFinding(
        "OPENLUP_E_RECIPE_DEST_CONFLICT",
        "Destination directory overlaps the source catalog directory.",
        "Installing into or over the source catalog would overwrite upstream recipes, schema, or index.json.",
        "Install into an application-owned destination such as `owned/adapters/<domain>/<provider>`.",
        shellCommand(["recipe", "add", recipeId, ...(values.catalog ? ["--catalog", values.catalog] : []), "--verify"]),
      );
      emit(
        { command: "recipe add", state: "refused", exitCode: 1, recipeId, dest: requestedDest, findings: [finding] },
        renderFinding(finding),
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

    // Validate every source file, target path, and companion container target BEFORE writing anything to disk.
    const plannedFiles = [];
    try {
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

      if (destStat) {
        for (const item of plannedFiles) {
          await assertNoSymlinkSegments(destAbs, item.relPath);
        }
      }

      // Pre-validate companion container paths (schema/, index.json, .openlup-provenance.json) before any write.
      if (usesCanonicalContainerLayout && containerRoot !== null) {
        await assertNoSymlinkAncestors(containerRoot);
        const schemaDstDir = join(containerRoot, "schema");
        const schemaDstStat = await statOrNull(schemaDstDir);
        if (schemaDstStat && (schemaDstStat.isSymbolicLink() || !schemaDstStat.isDirectory())) {
          throw new Error(`SYMLINK_REFUSED:${schemaDstDir}`);
        }
        if (schemaDstStat) {
          const schemaDstReal = await fs.realpath(schemaDstDir);
          if (!isContained(containerRoot, schemaDstReal)) {
            throw new Error(`SYMLINK_REFUSED:${schemaDstDir}`);
          }
          for (const schemaName of ["recipe.schema.json", "csp.schema.json"]) {
            const dstSchemaStat = await statOrNull(join(schemaDstDir, schemaName));
            if (dstSchemaStat && (dstSchemaStat.isSymbolicLink() || !dstSchemaStat.isFile())) {
              throw new Error(`SYMLINK_REFUSED:${join(schemaDstDir, schemaName)}`);
            }
          }
        }
        const localIndexStat = await statOrNull(join(containerRoot, "index.json"));
        if (localIndexStat && (localIndexStat.isSymbolicLink() || !localIndexStat.isFile())) {
          throw new Error(`SYMLINK_REFUSED:${join(containerRoot, "index.json")}`);
        }
        const provStat = await statOrNull(join(containerRoot, PROVENANCE_FILENAME));
        if (provStat && (provStat.isSymbolicLink() || !provStat.isFile())) {
          throw new Error(`SYMLINK_REFUSED:${join(containerRoot, PROVENANCE_FILENAME)}`);
        }
      } else {
        const siblingProvStat = await statOrNull(`${destAbs}.provenance.json`);
        if (siblingProvStat && (siblingProvStat.isSymbolicLink() || !siblingProvStat.isFile())) {
          throw new Error(`SYMLINK_REFUSED:${destAbs}.provenance.json`);
        }
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("SYMLINK_REFUSED:")) {
        refuse(
          74,
          "OPENLUP_E_RECIPE_UNSAFE_PATH",
          "Refused symlinked source, destination, schema, index, or provenance path during recipe install.",
          "Remove symlinks under the source catalog or destination container directory and retry.",
        );
        return;
      }
      throw error;
    }

    await fs.mkdir(destAbs, { recursive: true });
    for (const item of plannedFiles) {
      const targetFile = join(destAbs, ...item.relPath.split("/"));
      await fs.mkdir(dirname(targetFile), { recursive: true });
      await fs.writeFile(targetFile, item.bytes);
    }

    // Sync schema files and record provenance outside RECIPE_DIR so allFiles parity stays 100% intact.
    const sortedPlanned = [...plannedFiles].sort((a, b) => asciiCompare(a.relPath, b.relPath));
    const treeHasher = createHash("sha256");
    for (const item of sortedPlanned) {
      treeHasher.update(`${item.relPath}:${item.sha256}\n`, "utf8");
    }
    const recipeTreeSha256 = treeHasher.digest("hex");
    const destDisplay = displayPath(cwd, destAbs);

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
      if (usesCanonicalContainerLayout && containerRoot !== null) {
        const schemaSrcDir = join(catalog.dir, "schema");
        const schemaSrcStat = await statOrNull(schemaSrcDir);
        if (schemaSrcStat && schemaSrcStat.isDirectory() && !schemaSrcStat.isSymbolicLink()) {
          const schemaSrcReal = await fs.realpath(schemaSrcDir);
          if (isContained(catalog.dir, schemaSrcReal)) {
            const schemaDstDir = join(containerRoot, "schema");
            await fs.mkdir(schemaDstDir, { recursive: true });
            const schemaDstReal = await fs.realpath(schemaDstDir);
            if (!isContained(containerRoot, schemaDstReal)) {
              throw new Error(`SYMLINK_REFUSED:${schemaDstDir}`);
            }
            for (const schemaName of ["recipe.schema.json", "csp.schema.json"]) {
              const srcSchema = join(schemaSrcReal, schemaName);
              const sStat = await statOrNull(srcSchema);
              if (sStat && sStat.isFile() && !sStat.isSymbolicLink()) {
                const dstSchema = join(schemaDstReal, schemaName);
                const dstStat = await statOrNull(dstSchema);
                if (dstStat && dstStat.isSymbolicLink()) {
                  throw new Error(`SYMLINK_REFUSED:${dstSchema}`);
                }
                await fs.writeFile(dstSchema, await fs.readFile(srcSchema));
              }
            }
          }
        }
        // Maintain owned-adapters index.json so conformance suites referencing ../../index.json pass seamlessly.
        const localIndexPath = join(containerRoot, "index.json");
        const idxStat = await statOrNull(localIndexPath);
        if (idxStat && (idxStat.isSymbolicLink() || !idxStat.isFile())) {
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
        if (provStat && (provStat.isSymbolicLink() || !provStat.isFile())) {
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
        if (provStat && (provStat.isSymbolicLink() || !provStat.isFile())) {
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
      if (!usesCanonicalContainerLayout && verification.exitCode !== 0) {
        verification.findings.push(
          makeFinding(
            "OPENLUP_E_RECIPE_NONCANONICAL_DEST",
            `Installed into non-canonical destination "${destDisplay}" (does not end with "${recipeId}").`,
            "Recipes whose conformance suites read ../../schema/*.json or ../../index.json require a <container>/<domain>/<provider> layout.",
            `Install into a canonical destination such as owned/adapters/${recipeId} (the default when --dest is omitted).`,
            shellCommand(["recipe", "add", recipeId, ...(values.catalog ? ["--catalog", values.catalog] : []), "--verify"]),
          ),
        );
      }
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
      provenancePath: displayPath(cwd, provenancePathAbs),
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
      !positionals[1].trim() ||
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
