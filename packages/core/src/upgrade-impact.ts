// Opt-in development tool for upgrade impact analysis, capability-aware doctor checks,
// and idempotent AGENTS.md rule sync. Kernel exports never import this file.
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  collectExportedSymbols,
  declaredSymbolMaturity,
  installedPackageRoots,
  isContainedRegularFile,
  owningLock,
  readSortedEntries,
  readText,
  type InstalledPackage,
} from "./agent-context-cli.js";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const SKIPPED_DIRECTORIES = new Set(["node_modules", ".git", "dist", ".next", "build", "coverage", ".turbo", ".cache"]);
const MAX_SOURCE_BYTES = 512_000;
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u;
const FORBIDDEN_DEEP_IMPORT_PATTERN = /^@openlup\/[a-z0-9][a-z0-9-]*\/(?:src|dist)(?:\/|$)/u;
const OPENLUP_SPECIFIER_PATTERN = /^@openlup\/[a-z0-9][a-z0-9-]*(?:\/.*)?$/u;

export const AGENTS_RULES_BEGIN = "<!-- BEGIN:openlup-agent-rules -->";
export const AGENTS_RULES_END = "<!-- END:openlup-agent-rules -->";

export type ReleaseIndexSettingsDelta = {
  added: string[];
  removed: string[];
  changed: string[];
};

export type ReleaseIndexChange = {
  kind: "action_required" | "deprecation" | "fix" | "feature";
  audience?: "npm" | "starter";
  subpath?: string;
  symbol?: string;
  domain?: string;
  summary: string;
  migration?: string;
  docRef?: string;
  rail?: "managed" | "native" | "both";
};

export type ReleaseIndexEntry = {
  version: string;
  previousVersion: string | null;
  actionRequired: boolean;
  subpathsAdded: string[];
  subpathsRemoved?: string[];
  symbolsAdded: string[];
  symbolsRemoved?: string[];
  symbolsDeprecated: string[];
  sqlAdded: string[];
  settingsDelta: ReleaseIndexSettingsDelta;
  starterEntriesCount: number;
  changes?: ReleaseIndexChange[];
};

export type ReleaseIndex = {
  schemaVersion: 1;
  currentVersion: string;
  releases: ReleaseIndexEntry[];
};

export type ImportKind =
  | "named"
  | "namespace"
  | "default"
  | "side-effect"
  | "reexport-named"
  | "reexport-namespace"
  | "reexport-wildcard"
  | "dynamic"
  | "require";

export type ScannedImport = {
  file: string;
  line: number;
  subpath: string;
  kind: ImportKind;
  symbols: string[];
};

export type WildcardReexport = {
  file: string;
  line: number;
  subpath: string;
};

export type DeepImportViolation = {
  file: string;
  line: number;
  specifier: string;
};

export type ScanImportsResult = {
  scannedFiles: number;
  imports: ScannedImport[];
  wildcardReexports: WildcardReexport[];
  deepImports: DeepImportViolation[];
};

export type ActionRequiredMatch = {
  file: string;
  line: number;
  subpath: string;
  symbol?: string;
  kind: "action_required" | "deprecation" | "symbol_deprecated" | "symbol_removed" | "subpath_removed" | "wildcard_reexport";
  version: string;
  summary: string;
  migration?: string;
  docRef?: string;
};

export type FreeFixMatch = {
  version: string;
  subpath?: string;
  symbol?: string;
  summary: string;
  matchedFiles: string[];
  docRef?: string;
};

export type OptInOpportunity = {
  version: string;
  kind: "subpath_added" | "feature" | "starter_entries";
  domain: string;
  subpath?: string;
  symbol?: string;
  summary: string;
  inActiveDomain: boolean;
  docRef?: string;
  starterEntriesCount?: number;
};

export type SqlAndSettingsDelta = {
  sqlAdded: string[];
  settingsDelta: ReleaseIndexSettingsDelta;
  railNote?: string;
  portableAdvisories?: unknown;
};

export type AnalyzeUpgradeImpactOptions = {
  root: string;
  from: string;
  to?: string;
  manifestPath?: string;
  rail?: "managed" | "native";
  excludeStarter?: boolean;
  includeDormant?: boolean;
};

export type UpgradeImpactReport = {
  formatVersion: 1;
  from: string;
  to: string;
  hops: string[];
  missingIntermediateHops: boolean;
  rail?: "managed" | "native";
  excludeStarter: boolean;
  includeDormant: boolean;
  scannedFiles: number;
  importedSubpaths: string[];
  importedDomains: string[];
  wildcardReexports: WildcardReexport[];
  hiddenStarterEntriesCount: number;
  actionRequiredOnYourImports: ActionRequiredMatch[];
  freeFixesOnYourImports: FreeFixMatch[];
  newOptInInYourDomains: OptInOpportunity[];
  sqlAndSettingsDelta: SqlAndSettingsDelta;
};

export type DoctorCheckStatus = "passed" | "failed" | "warn" | "skipped" | "configured";

export type DoctorDeprecationHit = {
  file: string;
  line: number;
  subpath: string;
  symbol: string;
};

export type DoctorOptionalCheck =
  | { status: "skipped"; reason: "not_configured" }
  | { status: "configured"; detail: string };

export type DoctorReport = {
  formatVersion: 1;
  verdict: "ready" | "blocked";
  version: string | null;
  packages: string[];
  checks: {
    versionParity: {
      status: "passed" | "failed";
      versions: Record<string, { declared?: string; locked?: string; installed?: string }>;
      issues: string[];
    };
    nodeEngine: {
      status: "passed" | "failed";
      runtimeVersion: string;
      required: string;
      issue?: string;
    };
    forbiddenDeepImports: {
      status: "passed" | "failed";
      violations: DeepImportViolation[];
    };
    deprecationsInUse: {
      status: "passed" | "warn";
      count: number;
      items: DoctorDeprecationHit[];
    };
    verify: DoctorOptionalCheck;
    settings: DoctorOptionalCheck;
    recipes: DoctorOptionalCheck;
  };
  deprecationsInUse: DoctorDeprecationHit[];
  receiptPath?: string;
};

export type RunDoctorOptions = {
  root: string;
  receiptPath?: string;
  nodeVersion?: string;
};

export type SyncAgentsMdOptions = {
  root: string;
  check?: boolean;
};

export type SyncAgentsMdResult = {
  formatVersion: 1;
  path: string;
  status: "up_to_date" | "updated" | "drift";
  action: "none" | "create" | "update" | "append";
  changed: boolean;
};

const asciiCompare = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);
const sortedUnique = (values: Iterable<string>): string[] => [...new Set(values)].sort(asciiCompare);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

export function compareSemver(left: string, right: string): number {
  const a = SEMVER_PATTERN.exec(left);
  const b = SEMVER_PATTERN.exec(right);
  if (!a) throw new Error(`Invalid SemVer version: ${left}`);
  if (!b) throw new Error(`Invalid SemVer version: ${right}`);
  for (const index of [1, 2, 3]) {
    const av = BigInt(a[index]!);
    const bv = BigInt(b[index]!);
    if (av !== bv) return av < bv ? -1 : 1;
  }
  const ap = a[4];
  const bp = b[4];
  if (ap === undefined && bp === undefined) return 0;
  if (ap === undefined) return 1;
  if (bp === undefined) return -1;
  return asciiCompare(ap, bp);
}

// ---------------------------------------------------------------------------
// Comment-stripped, line-preserving static ESM/TS import lexer
// ---------------------------------------------------------------------------

type LexToken = {
  kind: "ident" | "string" | "template" | "punct" | "other";
  value: string;
  line: number;
  lineBreakBefore: boolean;
};

const REGEX_PREFIX_KEYWORDS = new Set([
  "return", "throw", "case", "of", "in", "instanceof", "typeof", "void",
  "delete", "await", "yield", "new", "else", "do",
]);

function canPrecedeRegex(prev: LexToken | undefined): boolean {
  if (!prev) return true;
  if (prev.kind === "ident") return REGEX_PREFIX_KEYWORDS.has(prev.value);
  if (prev.kind === "punct") {
    return prev.value !== ")" && prev.value !== "]" && prev.value !== "++" && prev.value !== "--";
  }
  return false;
}

function tokenizeSource(source: string): LexToken[] {
  const tokens: LexToken[] = [];
  let index = 0;
  let line = 1;
  let lineBreakBefore = true;
  const templateBraceStack: number[] = [];

  const scanTemplateChunk = (isStart: boolean): void => {
    const startLine = line;
    const chunkLineBreak = lineBreakBefore;
    let value = "";
    let hasInterpolation = !isStart;
    if (isStart) index++;
    while (index < source.length) {
      const ch = source[index]!;
      const next = source[index + 1];
      if (ch === "\\" && index + 1 < source.length) {
        if (next === "\n") line++;
        value += next!;
        index += 2;
        continue;
      }
      if (ch === "$" && next === "{") {
        hasInterpolation = true;
        tokens.push({ kind: "punct", value: "${", line, lineBreakBefore });
        lineBreakBefore = false;
        templateBraceStack.push(0);
        index += 2;
        return;
      }
      if (ch === "`") {
        index++;
        if (!hasInterpolation) {
          tokens.push({ kind: "template", value, line: startLine, lineBreakBefore: chunkLineBreak });
          lineBreakBefore = false;
        } else {
          tokens.push({ kind: "other", value: "`", line, lineBreakBefore: false });
        }
        return;
      }
      if (ch === "\n") line++;
      value += ch;
      index++;
    }
  };

  while (index < source.length) {
    const ch = source[index]!;
    const next = source[index + 1];

    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n" || ch === "\f" || ch === "\v") {
      if (ch === "\n") {
        line++;
        lineBreakBefore = true;
      }
      index++;
      continue;
    }

    // Line comment
    if (ch === "/" && next === "/") {
      index += 2;
      while (index < source.length && source[index] !== "\n") index++;
      continue;
    }

    // Block comment (preserves exact line count!)
    if (ch === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        if (source[index] === "\n") {
          line++;
          lineBreakBefore = true;
        }
        index++;
      }
      if (index < source.length) index += 2;
      continue;
    }

    // Regex literal
    if (ch === "/" && canPrecedeRegex(tokens[tokens.length - 1])) {
      const startLine = line;
      let inClass = false;
      index++;
      while (index < source.length) {
        const rc = source[index]!;
        if (rc === "\\" && index + 1 < source.length) {
          if (source[index + 1] === "\n") line++;
          index += 2;
          continue;
        }
        if (rc === "[") inClass = true;
        else if (rc === "]") inClass = false;
        if (rc === "\n") { line++; index++; break; }
        index++;
        if (rc === "/" && !inClass) break;
      }
      while (index < source.length && /[a-z]/iu.test(source[index]!)) index++;
      tokens.push({ kind: "other", value: "/re/", line: startLine, lineBreakBefore });
      lineBreakBefore = false;
      continue;
    }

    // Quoted string literal
    if (ch === "'" || ch === '"') {
      const quote = ch;
      const startLine = line;
      let value = "";
      index++;
      while (index < source.length) {
        const sc = source[index]!;
        if (sc === "\\" && index + 1 < source.length) {
          const escaped = source[index + 1]!;
          if (escaped === "\n") line++;
          value += escaped;
          index += 2;
          continue;
        }
        if (sc === "\n") { line++; index++; break; }
        index++;
        if (sc === quote) break;
        value += sc;
      }
      tokens.push({ kind: "string", value, line: startLine, lineBreakBefore });
      lineBreakBefore = false;
      continue;
    }

    // Template literal
    if (ch === "`") {
      scanTemplateChunk(true);
      continue;
    }

    if (templateBraceStack.length > 0 && ch === "{") {
      templateBraceStack[templateBraceStack.length - 1] = templateBraceStack[templateBraceStack.length - 1]! + 1;
    } else if (templateBraceStack.length > 0 && ch === "}") {
      const depth = templateBraceStack[templateBraceStack.length - 1]!;
      if (depth === 0) {
        templateBraceStack.pop();
        tokens.push({ kind: "punct", value: "}", line, lineBreakBefore });
        lineBreakBefore = false;
        index++;
        scanTemplateChunk(false);
        continue;
      }
      templateBraceStack[templateBraceStack.length - 1] = depth - 1;
    }

    if (/[A-Za-z_$]/u.test(ch)) {
      const start = index;
      while (index < source.length && /[A-Za-z0-9_$]/u.test(source[index]!)) index++;
      tokens.push({ kind: "ident", value: source.slice(start, index), line, lineBreakBefore });
      lineBreakBefore = false;
      continue;
    }

    if (/[0-9]/u.test(ch)) {
      const start = index;
      while (index < source.length && /[0-9a-fA-FxXoObB_.n]/u.test(source[index]!)) index++;
      tokens.push({ kind: "other", value: source.slice(start, index), line, lineBreakBefore });
      lineBreakBefore = false;
      continue;
    }

    const two = source.slice(index, index + 2);
    if (two === "?." || two === "=>" || two === "++" || two === "--") {
      tokens.push({ kind: "punct", value: two, line, lineBreakBefore });
      lineBreakBefore = false;
      index += 2;
      continue;
    }

    tokens.push({ kind: "punct", value: ch, line, lineBreakBefore });
    lineBreakBefore = false;
    index++;
  }

  return tokens;
}

function parseNamedClause(tokens: readonly LexToken[], openBraceIndex: number): { symbols: string[]; closeBraceIndex: number } {
  const symbols: string[] = [];
  let cursor = openBraceIndex + 1;
  while (cursor < tokens.length) {
    const token = tokens[cursor]!;
    if (token.kind === "punct" && token.value === "}") {
      return { symbols, closeBraceIndex: cursor };
    }
    if (token.kind === "punct" && token.value === ",") {
      cursor++;
      continue;
    }
    // Optional `type` modifier on specifier: `{ type Foo as Bar }`
    if (token.kind === "ident" && token.value === "type") {
      const afterType = tokens[cursor + 1];
      if (afterType && afterType.kind === "ident" && afterType.value !== "as") {
        cursor++;
      }
    }
    const nameToken = tokens[cursor];
    if (!nameToken) break;
    if (nameToken.kind === "ident" || nameToken.kind === "string") {
      symbols.push(nameToken.value);
      cursor++;
      if (tokens[cursor]?.kind === "ident" && tokens[cursor]?.value === "as") {
        cursor += 2; // Skip `as <alias>`
      }
      continue;
    }
    cursor++;
  }
  return { symbols, closeBraceIndex: cursor };
}

export function extractImportsFromSource(file: string, source: string): {
  imports: ScannedImport[];
  wildcardReexports: WildcardReexport[];
  deepImports: DeepImportViolation[];
} {
  const tokens = tokenizeSource(source);
  const imports: ScannedImport[] = [];
  const wildcardReexports: WildcardReexport[] = [];
  const deepImports: DeepImportViolation[] = [];

  const recordSpecifier = (line: number, specifier: string, kind: ImportKind, symbols: string[]): void => {
    if (!OPENLUP_SPECIFIER_PATTERN.test(specifier)) return;
    if (FORBIDDEN_DEEP_IMPORT_PATTERN.test(specifier)) {
      deepImports.push({ file, line, specifier });
    }
    if (kind === "reexport-wildcard") {
      wildcardReexports.push({ file, line, subpath: specifier });
    }
    imports.push({ file, line, subpath: specifier, kind, symbols: sortedUnique(symbols) });
  };

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    const prev = i > 0 ? tokens[i - 1] : undefined;
    const isMemberAccess = prev?.kind === "punct" && (prev.value === "." || prev.value === "?.");
    const isStatementStart =
      !prev ||
      (prev.kind === "punct" && (prev.value === ";" || prev.value === "{" || prev.value === "}")) ||
      (tok.lineBreakBefore && !isMemberAccess);

    // Dynamic import expression
    if (tok.kind === "ident" && tok.value === "import" && !isMemberAccess && tokens[i + 1]?.kind === "punct" && tokens[i + 1]?.value === "(") {
      const arg = tokens[i + 2];
      const close = tokens[i + 3];
      if (arg && (arg.kind === "string" || arg.kind === "template") && close?.kind === "punct" && (close.value === ")" || close.value === ",")) {
        recordSpecifier(tok.line, arg.value, "dynamic", []);
        i += 2;
      }
      continue;
    }

    // CommonJS require("...")
    if (tok.kind === "ident" && tok.value === "require" && !isMemberAccess && tokens[i + 1]?.kind === "punct" && tokens[i + 1]?.value === "(") {
      const arg = tokens[i + 2];
      const close = tokens[i + 3];
      if (arg && (arg.kind === "string" || arg.kind === "template") && close?.kind === "punct" && close.value === ")") {
        recordSpecifier(tok.line, arg.value, "require", []);
        i += 2;
      }
      continue;
    }

    // Static `import ...`
    if (isStatementStart && tok.kind === "ident" && tok.value === "import") {
      const next = tokens[i + 1];
      if (!next || (next.kind === "punct" && (next.value === "(" || next.value === "."))) continue;
      // Side-effect import statement
      if (next.kind === "string") {
        recordSpecifier(tok.line, next.value, "side-effect", []);
        i += 1;
        continue;
      }
      let cursor = i + 1;
      if (tokens[cursor]?.kind === "ident" && tokens[cursor]?.value === "type") {
        const afterType = tokens[cursor + 1];
        if (afterType && !(afterType.kind === "ident" && afterType.value === "from")) {
          cursor++;
        }
      }
      let kind: ImportKind = "default";
      let symbols: string[] = [];
      let foundFrom = false;
      while (cursor < tokens.length) {
        const cur = tokens[cursor]!;
        if (cur.kind === "punct" && cur.value === ";") break;
        if (cur.kind === "punct" && cur.value === "{") {
          const parsed = parseNamedClause(tokens, cursor);
          symbols = parsed.symbols;
          kind = "named";
          cursor = parsed.closeBraceIndex + 1;
          continue;
        }
        if (cur.kind === "punct" && cur.value === "*") {
          kind = "namespace";
          cursor++;
          continue;
        }
        if (cur.kind === "ident" && cur.value === "from" && tokens[cursor + 1]?.kind === "string") {
          recordSpecifier(tok.line, tokens[cursor + 1]!.value, kind, symbols);
          i = cursor + 1;
          foundFrom = true;
          break;
        }
        cursor++;
      }
      if (!foundFrom) continue;
      continue;
    }

    // Static re-exports (named, wildcard, and namespace re-export clauses)
    if (isStatementStart && tok.kind === "ident" && tok.value === "export") {
      let cursor = i + 1;
      if (tokens[cursor]?.kind === "ident" && tokens[cursor]?.value === "type") {
        const afterType = tokens[cursor + 1];
        if (afterType && (afterType.kind === "punct" && (afterType.value === "{" || afterType.value === "*"))) {
          cursor++;
        }
      }
      const clause = tokens[cursor];
      if (!clause) continue;
      if (clause.kind === "punct" && clause.value === "*") {
        const afterStar = tokens[cursor + 1];
        if (afterStar?.kind === "ident" && afterStar.value === "from" && tokens[cursor + 2]?.kind === "string") {
          recordSpecifier(tok.line, tokens[cursor + 2]!.value, "reexport-wildcard", []);
          i = cursor + 2;
        } else if (
          afterStar?.kind === "ident" &&
          afterStar.value === "as" &&
          tokens[cursor + 2]?.kind === "ident" &&
          tokens[cursor + 3]?.kind === "ident" &&
          tokens[cursor + 3]?.value === "from" &&
          tokens[cursor + 4]?.kind === "string"
        ) {
          recordSpecifier(tok.line, tokens[cursor + 4]!.value, "reexport-namespace", []);
          i = cursor + 4;
        }
        continue;
      }
      if (clause.kind === "punct" && clause.value === "{") {
        const parsed = parseNamedClause(tokens, cursor);
        const afterBrace = tokens[parsed.closeBraceIndex + 1];
        if (afterBrace?.kind === "ident" && afterBrace.value === "from" && tokens[parsed.closeBraceIndex + 2]?.kind === "string") {
          recordSpecifier(tok.line, tokens[parsed.closeBraceIndex + 2]!.value, "reexport-named", parsed.symbols);
          i = parsed.closeBraceIndex + 2;
        }
      }
    }
  }

  return { imports, wildcardReexports, deepImports };
}

export function scanApplicationImports(root: string): ScanImportsResult {
  const resolvedRoot = resolve(root);
  const imports: ScannedImport[] = [];
  const wildcardReexports: WildcardReexport[] = [];
  const deepImports: DeepImportViolation[] = [];
  let scannedFiles = 0;

  const pending = [resolvedRoot];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    const subdirs: string[] = [];
    for (const entry of readSortedEntries(directory)) {
      if (entry.name.startsWith(".") || SKIPPED_DIRECTORIES.has(entry.name)) continue;
      const fullPath = join(directory, entry.name);
      const state = lstatSync(fullPath);
      if (state.isSymbolicLink()) continue;
      if (state.isDirectory()) {
        subdirs.push(fullPath);
        continue;
      }
      if (!state.isFile()) continue;
      const dot = entry.name.lastIndexOf(".");
      if (dot < 0 || !SOURCE_EXTENSIONS.has(entry.name.slice(dot))) continue;
      if (state.size > MAX_SOURCE_BYTES) continue;
      scannedFiles++;
      const relFile = relative(resolvedRoot, fullPath).split(sep).join("/");
      const content = readFileSync(fullPath, "utf8");
      if (!content.includes("@openlup/")) continue;
      const extracted = extractImportsFromSource(relFile, content);
      imports.push(...extracted.imports);
      wildcardReexports.push(...extracted.wildcardReexports);
      deepImports.push(...extracted.deepImports);
    }
    for (let idx = subdirs.length - 1; idx >= 0; idx--) pending.push(subdirs[idx]!);
  }

  const compareLocation = <T extends { file: string; line: number }>(a: T, b: T, keyA: string, keyB: string) =>
    asciiCompare(a.file, b.file) || a.line - b.line || asciiCompare(keyA, keyB);

  imports.sort((a, b) => compareLocation(a, b, `${a.subpath}:${a.kind}`, `${b.subpath}:${b.kind}`));
  wildcardReexports.sort((a, b) => compareLocation(a, b, a.subpath, b.subpath));
  deepImports.sort((a, b) => compareLocation(a, b, a.specifier, b.specifier));

  return { scannedFiles, imports, wildcardReexports, deepImports };
}

// ---------------------------------------------------------------------------
// Release index loading & domain normalization
// ---------------------------------------------------------------------------

const DOMAIN_ALIASES: Record<string, string> = {
  subscription: "subscriptions",
  payment: "payments",
  promo: "promotions",
};

export function domainOfSubpath(subpath: string): string {
  const parts = subpath.split("/");
  if (parts.length < 2) return subpath;
  if (parts[0] !== "@openlup") return subpath;
  const pkg = parts[1]!;
  const raw = parts[2] ?? pkg;
  return DOMAIN_ALIASES[raw] ?? raw;
}

function parseReleaseIndexDocument(raw: string, label: string): ReleaseIndex {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${label}: invalid JSON (${error instanceof Error ? error.message : String(error)})`, { cause: error });
  }
  if (!isRecord(parsed) || parsed.schemaVersion !== 1 || typeof parsed.currentVersion !== "string" || !parsed.currentVersion || !Array.isArray(parsed.releases)) {
    throw new Error(`${label}: expected schemaVersion 1, non-empty currentVersion, and releases array`);
  }
  const releases: ReleaseIndexEntry[] = parsed.releases.map((row, idx) => {
    const entryLabel = `${label}: releases[${idx}]`;
    if (!isRecord(row)) throw new Error(`${entryLabel}: entry must be an object`);
    if (typeof row.version !== "string" || !SEMVER_PATTERN.test(row.version)) throw new Error(`${entryLabel}: invalid version`);
    if (row.previousVersion !== null && typeof row.previousVersion !== "string") throw new Error(`${entryLabel}: invalid previousVersion`);
    if (typeof row.actionRequired !== "boolean") throw new Error(`${entryLabel}: actionRequired must be boolean`);
    if (!isStringArray(row.subpathsAdded)) throw new Error(`${entryLabel}: subpathsAdded must be string[]`);
    if (!isStringArray(row.symbolsAdded)) throw new Error(`${entryLabel}: symbolsAdded must be string[]`);
    if (!isStringArray(row.symbolsDeprecated)) throw new Error(`${entryLabel}: symbolsDeprecated must be string[]`);
    if (!isStringArray(row.sqlAdded)) throw new Error(`${entryLabel}: sqlAdded must be string[]`);
    if (!isRecord(row.settingsDelta) || !isStringArray(row.settingsDelta.added) || !isStringArray(row.settingsDelta.removed) || !isStringArray(row.settingsDelta.changed)) {
      throw new Error(`${entryLabel}: invalid settingsDelta`);
    }
    if (!Number.isSafeInteger(row.starterEntriesCount) || (row.starterEntriesCount as number) < 0) {
      throw new Error(`${entryLabel}: invalid starterEntriesCount`);
    }
    const subpathsRemoved = row.subpathsRemoved === undefined ? undefined : isStringArray(row.subpathsRemoved) ? row.subpathsRemoved : (() => { throw new Error(`${entryLabel}: subpathsRemoved must be string[]`); })();
    const symbolsRemoved = row.symbolsRemoved === undefined ? undefined : isStringArray(row.symbolsRemoved) ? row.symbolsRemoved : (() => { throw new Error(`${entryLabel}: symbolsRemoved must be string[]`); })();
    const changes = row.changes === undefined ? undefined : Array.isArray(row.changes) ? row.changes as ReleaseIndexChange[] : (() => { throw new Error(`${entryLabel}: changes must be an array`); })();
    return {
      version: row.version,
      previousVersion: row.previousVersion,
      actionRequired: row.actionRequired,
      subpathsAdded: row.subpathsAdded,
      ...(subpathsRemoved ? { subpathsRemoved } : {}),
      symbolsAdded: row.symbolsAdded,
      ...(symbolsRemoved ? { symbolsRemoved } : {}),
      symbolsDeprecated: row.symbolsDeprecated,
      sqlAdded: row.sqlAdded,
      settingsDelta: {
        added: row.settingsDelta.added,
        removed: row.settingsDelta.removed,
        changed: row.settingsDelta.changed,
      },
      starterEntriesCount: row.starterEntriesCount as number,
      ...(changes ? { changes } : {}),
    };
  });
  return { schemaVersion: 1, currentVersion: parsed.currentVersion, releases };
}

function tryInstalledPackages(root: string): InstalledPackage[] {
  try {
    return installedPackageRoots(root).flatMap(({ name, root: pkgRoot }) => {
      const manifest = readText(join(pkgRoot, "package.json"));
      if (!manifest) return [];
      const parsed = JSON.parse(manifest) as { name?: string; version?: string };
      if (parsed.name !== name || typeof parsed.version !== "string" || !parsed.version) return [];
      return [{ name, version: parsed.version, root: pkgRoot, manifest }];
    });
  } catch {
    return [];
  }
}

function loadReleaseIndex(root: string, manifestPath?: string): { index: ReleaseIndex; packages: InstalledPackage[] } {
  const packages = tryInstalledPackages(root);
  if (manifestPath !== undefined) {
    const target = isAbsolute(manifestPath) ? manifestPath : resolve(root, manifestPath);
    const raw = readText(target);
    if (raw === undefined) throw new Error(`Release index manifest not found: ${manifestPath}`);
    return { index: parseReleaseIndexDocument(raw, manifestPath), packages };
  }
  const core = packages.find((pkg) => pkg.name === "@openlup/core");
  if (!core) {
    throw new Error("No installed @openlup/core found and no --manifest path provided. Install @openlup/core or pass --manifest <path>.");
  }
  const candidate = join(core.root, "meta", "release-index.json");
  const realRoot = realpathSync(core.root);
  if (!isContainedRegularFile(core.root, realRoot, candidate)) {
    throw new Error("Installed @openlup/core does not contain meta/release-index.json. Pass --manifest <path> or upgrade @openlup/core.");
  }
  return { index: parseReleaseIndexDocument(readFileSync(candidate, "utf8"), "meta/release-index.json"), packages };
}

function loadPortableAdvisories(packages: readonly InstalledPackage[]): unknown | undefined {
  const platform = packages.find((pkg) => pkg.name === "@openlup/platform");
  if (!platform) return undefined;
  const candidate = join(platform.root, "sql", "portable-advisories.json");
  const realRoot = realpathSync(platform.root);
  if (!isContainedRegularFile(platform.root, realRoot, candidate)) return undefined;
  try {
    return JSON.parse(readFileSync(candidate, "utf8"));
  } catch {
    return undefined;
  }
}

function resolveSubpathTypesEntrypoint(pkg: InstalledPackage, subpath: string): string | undefined {
  const exportKey = subpath === pkg.name ? "." : `./${subpath.slice(pkg.name.length + 1)}`;
  let parsed: { exports?: Record<string, unknown> };
  try {
    parsed = JSON.parse(pkg.manifest) as { exports?: Record<string, unknown> };
  } catch {
    return undefined;
  }
  const target = parsed.exports?.[exportKey];
  if (!isRecord(target)) return undefined;
  const typesPath = target.types;
  if (typeof typesPath !== "string" || !typesPath.endsWith(".d.ts")) return undefined;
  const realRoot = realpathSync(pkg.root);
  const entrypoint = resolve(pkg.root, typesPath);
  return isContainedRegularFile(pkg.root, realRoot, entrypoint) ? entrypoint : undefined;
}

function exportedSymbolsForSubpath(packages: readonly InstalledPackage[], subpath: string, cache: Map<string, Set<string>>): Set<string> {
  const cached = cache.get(subpath);
  if (cached) return cached;
  const pkg = packages.find((item) => subpath === item.name || subpath.startsWith(`${item.name}/`));
  if (!pkg) {
    const empty = new Set<string>();
    cache.set(subpath, empty);
    return empty;
  }
  const entrypoint = resolveSubpathTypesEntrypoint(pkg, subpath);
  if (!entrypoint) {
    const empty = new Set<string>();
    cache.set(subpath, empty);
    return empty;
  }
  const symbols = collectExportedSymbols(pkg.root, realpathSync(pkg.root), entrypoint);
  cache.set(subpath, symbols);
  return symbols;
}

// ---------------------------------------------------------------------------
// 1. analyzeUpgradeImpact
// ---------------------------------------------------------------------------

export function analyzeUpgradeImpact(options: AnalyzeUpgradeImpactOptions): UpgradeImpactReport {
  const root = resolve(options.root);
  const excludeStarter = options.excludeStarter === true;
  const includeDormant = options.includeDormant === true;
  const rail = options.rail;

  if (!SEMVER_PATTERN.test(options.from)) {
    throw new Error(`Invalid --from version: ${options.from}`);
  }
  const { index, packages } = loadReleaseIndex(root, options.manifestPath);
  const to = options.to ?? index.currentVersion;
  if (!SEMVER_PATTERN.test(to)) {
    throw new Error(`Invalid --to version: ${to}`);
  }
  if (compareSemver(options.from, to) > 0) {
    throw new Error(`--from (${options.from}) must not be greater than --to (${to})`);
  }

  const selectedReleases = index.releases
    .filter((entry) => compareSemver(entry.version, options.from) > 0 && compareSemver(entry.version, to) <= 0)
    .sort((a, b) => compareSemver(a.version, b.version));

  const hops = selectedReleases.map((entry) => entry.version);
  let missingIntermediateHops = false;
  if (compareSemver(to, options.from) > 0) {
    if (selectedReleases.length === 0) {
      missingIntermediateHops = true;
    } else {
      if (selectedReleases[0]!.previousVersion !== null && selectedReleases[0]!.previousVersion !== options.from) {
        missingIntermediateHops = true;
      }
      for (let i = 1; i < selectedReleases.length; i++) {
        if (selectedReleases[i]!.previousVersion !== selectedReleases[i - 1]!.version) {
          missingIntermediateHops = true;
        }
      }
      if (selectedReleases[selectedReleases.length - 1]!.version !== to) {
        missingIntermediateHops = true;
      }
    }
  }

  const scan = scanApplicationImports(root);
  const importedSubpaths = sortedUnique(scan.imports.map((item) => item.subpath));
  const importedDomains = sortedUnique(importedSubpaths.map(domainOfSubpath));
  const importedDomainSet = new Set(importedDomains);
  const subpathSymbolCache = new Map<string, Set<string>>();

  const actionRequired: ActionRequiredMatch[] = [];
  const freeFixes: FreeFixMatch[] = [];
  const optIn: OptInOpportunity[] = [];
  const seenAction = new Set<string>();
  const addAction = (match: ActionRequiredMatch): void => {
    const key = `${match.file}:${match.line}:${match.subpath}:${match.symbol ?? ""}:${match.kind}:${match.version}:${match.summary}`;
    if (seenAction.has(key)) return;
    seenAction.add(key);
    actionRequired.push(match);
  };

  const railMatches = (changeRail?: "managed" | "native" | "both"): boolean =>
    !rail || !changeRail || changeRail === "both" || changeRail === rail;

  const filesBySubpath = new Map<string, string[]>();
  const filesByDomain = new Map<string, string[]>();
  for (const imp of scan.imports) {
    const list = filesBySubpath.get(imp.subpath) ?? [];
    list.push(imp.file);
    filesBySubpath.set(imp.subpath, list);
    const domain = domainOfSubpath(imp.subpath);
    const domainList = filesByDomain.get(domain) ?? [];
    domainList.push(imp.file);
    filesByDomain.set(domain, domainList);
  }

  let hiddenStarterEntriesCount = 0;

  for (const release of selectedReleases) {
    const docRef = `docs/guide/upgrade/v${release.version.replaceAll(".", "-")}.md`;
    const deprecatedSet = new Set(release.symbolsDeprecated);
    const removedSymbolsSet = new Set(release.symbolsRemoved ?? []);
    const removedSubpathsSet = new Set(release.subpathsRemoved ?? []);

    // Match static imports against removed subpaths, removed symbols, and deprecated symbols.
    for (const imp of scan.imports) {
      if (removedSubpathsSet.has(imp.subpath)) {
        addAction({
          file: imp.file,
          line: imp.line,
          subpath: imp.subpath,
          kind: "subpath_removed",
          version: release.version,
          summary: `Subpath \`${imp.subpath}\` was removed in ${release.version}.`,
          docRef,
        });
      }
      for (const symbol of imp.symbols) {
        if (removedSymbolsSet.has(symbol)) {
          addAction({
            file: imp.file,
            line: imp.line,
            subpath: imp.subpath,
            symbol,
            kind: "symbol_removed",
            version: release.version,
            summary: `Symbol \`${symbol}\` from \`${imp.subpath}\` was removed in ${release.version}.`,
            docRef,
          });
        }
        if (deprecatedSet.has(symbol)) {
          addAction({
            file: imp.file,
            line: imp.line,
            subpath: imp.subpath,
            symbol,
            kind: "symbol_deprecated",
            version: release.version,
            summary: `Symbol \`${symbol}\` from \`${imp.subpath}\` is deprecated as of ${release.version}.`,
            docRef,
          });
        }
      }
      if ((imp.kind === "namespace" || imp.kind === "dynamic" || imp.kind === "reexport-namespace") && deprecatedSet.size > 0) {
        const exported = exportedSymbolsForSubpath(packages, imp.subpath, subpathSymbolCache);
        for (const symbol of release.symbolsDeprecated) {
          if (exported.has(symbol)) {
            addAction({
              file: imp.file,
              line: imp.line,
              subpath: imp.subpath,
              symbol,
              kind: "symbol_deprecated",
              version: release.version,
              summary: `Namespace/dynamic import of \`${imp.subpath}\` exposes deprecated symbol \`${symbol}\` (${release.version}).`,
              docRef,
            });
          }
        }
      }
    }

    // Never silently miss wildcard re-exports (`export *` barrels).
    const releaseHasRisk =
      release.actionRequired ||
      deprecatedSet.size > 0 ||
      removedSymbolsSet.size > 0 ||
      removedSubpathsSet.size > 0;
    if (releaseHasRisk) {
      for (const wildcard of scan.wildcardReexports) {
        addAction({
          file: wildcard.file,
          line: wildcard.line,
          subpath: wildcard.subpath,
          kind: "wildcard_reexport",
          version: release.version,
          summary: `Wildcard \`export *\` re-export of \`${wildcard.subpath}\` hides downstream symbol usage from static analysis; audit consumers for ${release.version} changes.`,
          docRef,
        });
      }
    }

    // Match structured changes[] when present in a release-index entry.
    for (const change of release.changes ?? []) {
      if (!railMatches(change.rail)) continue;
      if (excludeStarter && change.audience === "starter") {
        hiddenStarterEntriesCount++;
        continue;
      }
      const changeDomain = change.domain ?? (change.subpath ? domainOfSubpath(change.subpath) : undefined);
      if (change.kind === "action_required" || change.kind === "deprecation") {
        for (const imp of scan.imports) {
          const subpathMatch = change.subpath ? imp.subpath === change.subpath : (changeDomain ? domainOfSubpath(imp.subpath) === changeDomain : false);
          if (!subpathMatch) continue;
          const symbolMatch = !change.symbol || imp.symbols.includes(change.symbol) || imp.kind === "namespace" || imp.kind === "dynamic" || imp.kind === "reexport-wildcard";
          if (!symbolMatch) continue;
          addAction({
            file: imp.file,
            line: imp.line,
            subpath: imp.subpath,
            ...(change.symbol ? { symbol: change.symbol } : {}),
            kind: change.kind,
            version: release.version,
            summary: change.summary,
            ...(change.migration ? { migration: change.migration } : {}),
            docRef: change.docRef ?? docRef,
          });
        }
      } else if (change.kind === "fix") {
        const matched = change.subpath
          ? sortedUnique(filesBySubpath.get(change.subpath) ?? [])
          : changeDomain
            ? sortedUnique(filesByDomain.get(changeDomain) ?? [])
            : [];
        if (matched.length > 0) {
          freeFixes.push({
            version: release.version,
            ...(change.subpath ? { subpath: change.subpath } : {}),
            ...(change.symbol ? { symbol: change.symbol } : {}),
            summary: change.summary,
            matchedFiles: matched,
            docRef: change.docRef ?? docRef,
          });
        }
      } else if (change.kind === "feature") {
        const domain = changeDomain ?? "platform";
        const inActiveDomain = importedDomainSet.has(domain);
        if (inActiveDomain || includeDormant) {
          optIn.push({
            version: release.version,
            kind: "feature",
            domain,
            ...(change.subpath ? { subpath: change.subpath } : {}),
            ...(change.symbol ? { symbol: change.symbol } : {}),
            summary: change.summary,
            inActiveDomain,
            docRef: change.docRef ?? docRef,
          });
        }
      }
    }

    // New opt-in subpaths in adopter's active domains (or all domains when includeDormant=true).
    for (const subpath of release.subpathsAdded) {
      const domain = domainOfSubpath(subpath);
      const inActiveDomain = importedDomainSet.has(domain);
      if (inActiveDomain || includeDormant) {
        optIn.push({
          version: release.version,
          kind: "subpath_added",
          domain,
          subpath,
          summary: `New subpath \`${subpath}\` added in ${release.version}.`,
          inActiveDomain,
          docRef,
        });
      }
    }

    if (release.starterEntriesCount > 0) {
      if (excludeStarter) {
        hiddenStarterEntriesCount += release.starterEntriesCount;
      } else {
        optIn.push({
          version: release.version,
          kind: "starter_entries",
          domain: "starter",
          summary: `${release.starterEntriesCount} starter-specific entry(ies) in ${release.version} (pass --exclude-starter to hide).`,
          inActiveDomain: false,
          starterEntriesCount: release.starterEntriesCount,
          docRef,
        });
      }
    }
  }

  // Deterministic ordering across all buckets.
  actionRequired.sort((a, b) =>
    asciiCompare(a.file, b.file) ||
    a.line - b.line ||
    asciiCompare(a.subpath, b.subpath) ||
    asciiCompare(a.symbol ?? "", b.symbol ?? "") ||
    asciiCompare(a.kind, b.kind) ||
    compareSemver(a.version, b.version),
  );
  freeFixes.sort((a, b) =>
    compareSemver(a.version, b.version) ||
    asciiCompare(a.subpath ?? "", b.subpath ?? "") ||
    asciiCompare(a.summary, b.summary),
  );
  optIn.sort((a, b) =>
    asciiCompare(a.domain, b.domain) ||
    compareSemver(a.version, b.version) ||
    asciiCompare(a.subpath ?? "", b.subpath ?? "") ||
    asciiCompare(a.summary, b.summary),
  );

  // Aggregate Bucket 4: SQL and settings delta across all hops.
  const sqlAdded = sortedUnique(selectedReleases.flatMap((release) => release.sqlAdded));
  const settingsAdded = new Set<string>();
  const settingsRemoved = new Set<string>();
  const settingsChanged = new Set<string>();
  for (const release of selectedReleases) {
    for (const key of release.settingsDelta.added) {
      settingsAdded.add(key);
      settingsRemoved.delete(key);
      settingsChanged.delete(key);
    }
    for (const key of release.settingsDelta.changed) {
      if (!settingsAdded.has(key)) settingsChanged.add(key);
    }
    for (const key of release.settingsDelta.removed) {
      if (settingsAdded.has(key)) {
        settingsAdded.delete(key);
      } else {
        settingsChanged.delete(key);
        settingsRemoved.add(key);
      }
    }
  }

  const portableAdvisories = loadPortableAdvisories(packages);
  const sqlAndSettingsDelta: SqlAndSettingsDelta = {
    sqlAdded,
    settingsDelta: {
      added: sortedUnique(settingsAdded),
      removed: sortedUnique(settingsRemoved),
      changed: sortedUnique(settingsChanged),
    },
    ...(rail === "managed" && sqlAdded.length > 0
      ? {
          railNote:
            "Managed rail: apply newly shipped SQL migrations through your application's managed migration chain without rewriting published bytes, and rehearse schema cutover in staging before rollout.",
        }
      : {}),
    ...(portableAdvisories !== undefined ? { portableAdvisories } : {}),
  };

  return {
    formatVersion: 1,
    from: options.from,
    to,
    hops,
    missingIntermediateHops,
    ...(rail ? { rail } : {}),
    excludeStarter,
    includeDormant,
    scannedFiles: scan.scannedFiles,
    importedSubpaths,
    importedDomains,
    wildcardReexports: scan.wildcardReexports,
    hiddenStarterEntriesCount,
    actionRequiredOnYourImports: actionRequired,
    freeFixesOnYourImports: freeFixes,
    newOptInInYourDomains: optIn,
    sqlAndSettingsDelta,
  };
}

export function formatUpgradeImpactMarkdown(report: UpgradeImpactReport): string {
  const lines: string[] = [
    `# OpenLup Upgrade Impact (${report.from} -> ${report.to})`,
    "",
    `- **Hops analyzed:** ${report.hops.length ? report.hops.join(" -> ") : "none"}`,
    `- **Application source files scanned:** ${report.scannedFiles}`,
    `- **Imported @openlup/* subpaths:** ${report.importedSubpaths.length}`,
    `- **Wildcard re-exports detected (\`export *\`):** ${report.wildcardReexports.length}`,
  ];
  if (report.rail) lines.push(`- **Rail:** ${report.rail}`);
  if (report.missingIntermediateHops) {
    lines.push("- **Warning:** Release index does not contain every intermediate hop between `--from` and `--to`; inspect release notes for missing versions.");
  }
  if (report.excludeStarter && report.hiddenStarterEntriesCount > 0) {
    lines.push(`- **Starter entries hidden:** ${report.hiddenStarterEntriesCount}`);
  }

  lines.push("", "## 1. Action required on your imports", "");
  if (report.actionRequiredOnYourImports.length === 0) {
    lines.push("No action-required changes matched your static `@openlup/*` imports.");
  } else {
    for (const item of report.actionRequiredOnYourImports) {
      const symbolPart = item.symbol ? ` (${item.symbol})` : "";
      lines.push(`- \`${item.file}:${item.line}\` — \`${item.subpath}\`${symbolPart} [${item.kind}, ${item.version}]: ${item.summary}`);
      if (item.migration) lines.push(`  - Migration: ${item.migration}`);
      if (item.docRef) lines.push(`  - Reference: \`${item.docRef}\``);
    }
  }
  if (report.wildcardReexports.length > 0) {
    lines.push("", "### Wildcard re-exports (`export *`)", "");
    for (const wildcard of report.wildcardReexports) {
      lines.push(`- \`${wildcard.file}:${wildcard.line}\` — wildcard \`export *\` re-export of \`${wildcard.subpath}\``);
    }
  }

  lines.push("", "## 2. Free fixes on your imports", "");
  if (report.freeFixesOnYourImports.length === 0) {
    lines.push("No matched free-fix entries in the release index for your imports.");
  } else {
    for (const fix of report.freeFixesOnYourImports) {
      const target = fix.subpath ? `\`${fix.subpath}\`` : "matched domain";
      lines.push(`- [${fix.version}] ${target}: ${fix.summary} (files: ${fix.matchedFiles.map((f) => `\`${f}\``).join(", ")})`);
    }
  }

  lines.push("", "## 3. New opt-in capabilities in your domains", "");
  if (report.newOptInInYourDomains.length === 0) {
    lines.push("No new opt-in capabilities matched your active domains.");
  } else {
    for (const item of report.newOptInInYourDomains) {
      const scope = item.inActiveDomain ? item.domain : `${item.domain}, dormant`;
      lines.push(`- [${item.version}] (${scope}) ${item.summary}`);
    }
  }

  lines.push("", "## 4. SQL and settings delta", "");
  lines.push(`- **SQL migrations added:** ${report.sqlAndSettingsDelta.sqlAdded.length}`);
  for (const sql of report.sqlAndSettingsDelta.sqlAdded) {
    lines.push(`  - \`${sql}\``);
  }
  const { added, changed, removed } = report.sqlAndSettingsDelta.settingsDelta;
  lines.push(`- **Settings added:** ${added.length}${added.length ? ` (${added.map((k) => `\`${k}\``).join(", ")})` : ""}`);
  lines.push(`- **Settings changed:** ${changed.length}${changed.length ? ` (${changed.map((k) => `\`${k}\``).join(", ")})` : ""}`);
  lines.push(`- **Settings removed:** ${removed.length}${removed.length ? ` (${removed.map((k) => `\`${k}\``).join(", ")})` : ""}`);
  if (report.sqlAndSettingsDelta.railNote) {
    lines.push(`- **Rail note:** ${report.sqlAndSettingsDelta.railNote}`);
  }
  if (report.sqlAndSettingsDelta.portableAdvisories !== undefined) {
    lines.push("- **Portable SQL advisories:** present in installed `@openlup/platform/sql/portable-advisories.json` (inspect JSON output for details).");
  }

  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// 2. Capability-aware runDoctor
// ---------------------------------------------------------------------------

function parseNodeMajor(version: string): number {
  const cleaned = version.replace(/^v/u, "");
  const match = /^(\d+)\./u.exec(cleaned);
  return match ? Number(match[1]) : 0;
}

function requiredNodeMajor(packages: readonly InstalledPackage[]): number {
  let minMajor = 24;
  for (const pkg of packages) {
    try {
      const parsed = JSON.parse(pkg.manifest) as { engines?: { node?: unknown } };
      const spec = parsed.engines?.node;
      if (typeof spec === "string") {
        const match = />=\s*(\d+)/u.exec(spec);
        if (match) minMajor = Math.max(minMajor, Number(match[1]));
      }
    } catch { /* ignore malformed engines */ }
  }
  return minMajor;
}

function detectOptionalChecks(root: string, appManifest: Record<string, unknown> | undefined): {
  verify: DoctorOptionalCheck;
  settings: DoctorOptionalCheck;
  recipes: DoctorOptionalCheck;
} {
  const scripts = isRecord(appManifest?.scripts) ? appManifest.scripts : {};
  const scriptValues = Object.entries(scripts)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string");

  // verify
  const observationFiles = ["application-observations.mjs", "application-observations.ts", "application-observations.js"];
  const foundObservation = observationFiles.find((file) => existsSync(join(root, file)));
  const verifyScript = scriptValues.find(([, command]) => /\bopenlup\s+verify\b/u.test(command));
  const verify: DoctorOptionalCheck = foundObservation
    ? { status: "configured", detail: `Found ${foundObservation}; run npx --no -- openlup verify --app ./${foundObservation}` }
    : verifyScript
      ? { status: "configured", detail: `Configured via npm script "${verifyScript[0]}"` }
      : { status: "skipped", reason: "not_configured" };

  // settings
  const settingsFiles = ["owned/settings-host.ts", "owned/settings-host.mjs", "owned/settings-host.js"];
  const foundSettings = settingsFiles.find((file) => existsSync(join(root, file)));
  const settingsScript = scriptValues.find(([, command]) => /\bopenlup\s+settings\b/u.test(command));
  const settings: DoctorOptionalCheck = foundSettings
    ? { status: "configured", detail: `Found ${foundSettings}; run npx --no -- openlup settings check --app ./${foundSettings}` }
    : settingsScript
      ? { status: "configured", detail: `Configured via npm script "${settingsScript[0]}"` }
      : { status: "skipped", reason: "not_configured" };

  // recipes
  const adaptersRoot = join(root, "owned", "adapters");
  let recipeCount = 0;
  if (existsSync(adaptersRoot) && !lstatSync(adaptersRoot).isSymbolicLink() && lstatSync(adaptersRoot).isDirectory()) {
    const queue = [adaptersRoot];
    let visited = 0;
    while (queue.length > 0 && visited < 200) {
      const dir = queue.pop()!;
      visited++;
      for (const entry of readSortedEntries(dir)) {
        const full = join(dir, entry.name);
        const st = lstatSync(full);
        if (st.isSymbolicLink()) continue;
        if (st.isDirectory()) queue.push(full);
        else if (st.isFile() && (entry.name === "recipe.json" || entry.name === ".openlup-provenance.json")) {
          recipeCount++;
        }
      }
    }
  }
  const recipes: DoctorOptionalCheck = recipeCount > 0
    ? { status: "configured", detail: `Found ${recipeCount} recipe manifest/provenance file(s) under owned/adapters; run npx --no -- openlup recipe verify <path>` }
    : { status: "skipped", reason: "not_configured" };

  return { verify, settings, recipes };
}

export function runDoctor(options: RunDoctorOptions): DoctorReport {
  const root = resolve(options.root);
  const appManifestRaw = readText(join(root, "package.json"));
  let appManifest: Record<string, unknown> | undefined;
  const parityIssues: string[] = [];
  const versions: Record<string, { declared?: string; locked?: string; installed?: string }> = {};

  if (appManifestRaw !== undefined) {
    try {
      const parsed = JSON.parse(appManifestRaw);
      if (isRecord(parsed)) appManifest = parsed;
      else parityIssues.push("package.json must be a JSON object.");
    } catch (error) {
      parityIssues.push(`package.json is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Gather declared @openlup/* specs from package.json
  const declaredSpecs = new Map<string, string>();
  if (appManifest) {
    for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
      const section = appManifest[field];
      if (!isRecord(section)) continue;
      for (const [name, spec] of Object.entries(section)) {
        if (!name.startsWith("@openlup/") || typeof spec !== "string") continue;
        declaredSpecs.set(name, spec);
        versions[name] = { ...(versions[name] ?? {}), declared: spec };
      }
    }
  }

  // Inspect installed packages
  let installed: InstalledPackage[] = [];
  try {
    installed = installedPackageRoots(root).map(({ name, root: pkgRoot }) => {
      const manifest = readText(join(pkgRoot, "package.json"));
      if (!manifest) throw new Error(`Invalid installed package manifest: ${pkgRoot}`);
      const parsed = JSON.parse(manifest) as { name?: string; version?: string };
      if (parsed.name !== name || typeof parsed.version !== "string" || !parsed.version) {
        throw new Error(`Invalid installed package manifest: ${pkgRoot}`);
      }
      return { name, version: parsed.version, root: pkgRoot, manifest };
    });
  } catch (error) {
    parityIssues.push(error instanceof Error ? error.message : String(error));
  }

  for (const pkg of installed) {
    versions[pkg.name] = { ...(versions[pkg.name] ?? {}), installed: pkg.version };
  }

  // Check declared specs for missing installations and exact version parity
  const parityPackageNames = sortedUnique([...declaredSpecs.keys(), ...installed.map((pkg) => pkg.name)]);
  const installedVersionSet = new Set(installed.map((pkg) => pkg.version));
  if (installed.length === 0) {
    if (!parityIssues.length) parityIssues.push("No installed @openlup/* packages found.");
  } else if (installedVersionSet.size > 1) {
    parityIssues.push(`Mixed installed @openlup/* versions: ${installed.map((pkg) => `${pkg.name}@${pkg.version}`).join(", ")}`);
  }

  for (const name of parityPackageNames) {
    const info = versions[name]!;
    if (info.declared && !info.installed) {
      parityIssues.push(`Declared ${name}@${info.declared} is not installed in node_modules.`);
    }
    if (info.declared && info.installed && !info.declared.startsWith("file:")) {
      if (info.declared !== info.installed) {
        parityIssues.push(`package.json declares ${name}@${info.declared}, but installed version is ${info.installed}; pin exact matching @openlup/* versions.`);
      }
    }
  }

  // Check owning package-lock.json parity
  try {
    const lock = owningLock(root);
    if (lock) {
      for (const pkg of installed) {
        const installedPath = relative(lock.root, pkg.root).split(sep).join("/");
        const entry = lock.entries[installedPath];
        const locked = entry?.link && entry.resolved ? lock.entries[entry.resolved]?.version : entry?.version;
        if (locked) {
          versions[pkg.name] = { ...(versions[pkg.name] ?? {}), locked };
        }
        if (!locked) {
          parityIssues.push(`Owning package-lock.json has no version entry for ${pkg.name} at ${installedPath}.`);
        } else if (locked !== pkg.version) {
          parityIssues.push(`package-lock.json (${locked}) disagrees with installed ${pkg.name} (${pkg.version}).`);
        }
      }
    }
  } catch (error) {
    parityIssues.push(error instanceof Error ? error.message : String(error));
  }

  const versionParityStatus: "passed" | "failed" = parityIssues.length === 0 ? "passed" : "failed";

  // Node engine compatibility (>=24)
  const runtimeVersion = options.nodeVersion ?? process.versions.node;
  const minMajor = requiredNodeMajor(installed);
  const actualMajor = parseNodeMajor(runtimeVersion);
  const nodeOk = actualMajor >= minMajor;
  const nodeEngine = {
    status: (nodeOk ? "passed" : "failed") as "passed" | "failed",
    runtimeVersion,
    required: `>=${minMajor}`,
    ...(nodeOk ? {} : { issue: `Node.js ${runtimeVersion} does not satisfy required >=${minMajor}.` }),
  };

  // Source scan: forbidden deep imports + deprecations in use
  const scan = scanApplicationImports(root);
  const forbiddenDeepImports = {
    status: (scan.deepImports.length === 0 ? "passed" : "failed") as "passed" | "failed",
    violations: scan.deepImports,
  };

  // Check every imported symbol against installed .d.ts @deprecated tags
  const deprecationHits: DoctorDeprecationHit[] = [];
  const seenDeprecation = new Set<string>();
  const entrypointCache = new Map<string, { pkgRoot: string; entrypoint: string } | null>();
  const maturityCache = new Map<string, { deprecated?: true } | undefined>();

  for (const imp of scan.imports) {
    if (imp.symbols.length === 0) continue;
    let resolved = entrypointCache.get(imp.subpath);
    if (resolved === undefined) {
      const pkg = installed.find((item) => imp.subpath === item.name || imp.subpath.startsWith(`${item.name}/`));
      const entrypoint = pkg ? resolveSubpathTypesEntrypoint(pkg, imp.subpath) : undefined;
      resolved = pkg && entrypoint ? { pkgRoot: pkg.root, entrypoint } : null;
      entrypointCache.set(imp.subpath, resolved);
    }
    if (!resolved) continue;
    for (const symbol of imp.symbols) {
      const cacheKey = `${resolved.entrypoint}\0${symbol}`;
      if (!maturityCache.has(cacheKey)) {
        maturityCache.set(cacheKey, declaredSymbolMaturity(resolved.pkgRoot, resolved.entrypoint, symbol));
      }
      if (maturityCache.get(cacheKey)?.deprecated === true) {
        const hitKey = `${imp.file}:${imp.line}:${imp.subpath}:${symbol}`;
        if (!seenDeprecation.has(hitKey)) {
          seenDeprecation.add(hitKey);
          deprecationHits.push({ file: imp.file, line: imp.line, subpath: imp.subpath, symbol });
        }
      }
    }
  }
  deprecationHits.sort((a, b) =>
    asciiCompare(a.file, b.file) || a.line - b.line || asciiCompare(a.subpath, b.subpath) || asciiCompare(a.symbol, b.symbol),
  );

  const optional = detectOptionalChecks(root, appManifest);
  const blocked =
    versionParityStatus === "failed" ||
    nodeEngine.status === "failed" ||
    forbiddenDeepImports.status === "failed";

  const version = installedVersionSet.size === 1 ? [...installedVersionSet][0]! : null;
  const resolvedReceiptPath = options.receiptPath
    ? (isAbsolute(options.receiptPath) ? options.receiptPath : resolve(root, options.receiptPath))
    : undefined;

  const report: DoctorReport = {
    formatVersion: 1,
    verdict: blocked ? "blocked" : "ready",
    version,
    packages: installed.map((pkg) => pkg.name).sort(asciiCompare),
    checks: {
      versionParity: {
        status: versionParityStatus,
        versions: Object.fromEntries(Object.entries(versions).sort(([a], [b]) => asciiCompare(a, b))),
        issues: parityIssues,
      },
      nodeEngine,
      forbiddenDeepImports,
      deprecationsInUse: {
        status: deprecationHits.length === 0 ? "passed" : "warn",
        count: deprecationHits.length,
        items: deprecationHits,
      },
      verify: optional.verify,
      settings: optional.settings,
      recipes: optional.recipes,
    },
    deprecationsInUse: deprecationHits,
    ...(resolvedReceiptPath ? { receiptPath: relative(root, resolvedReceiptPath).split(sep).join("/") } : {}),
  };

  if (resolvedReceiptPath) {
    mkdirSync(dirname(resolvedReceiptPath), { recursive: true });
    writeFileSync(resolvedReceiptPath, `${JSON.stringify({ ...report, generatedAt: new Date().toISOString() }, null, 2)}\n`, "utf8");
  }

  return report;
}

export function formatDoctorText(report: DoctorReport): string {
  const lines: string[] = [
    `OpenLup doctor: ${report.verdict}${report.version ? ` (version ${report.version})` : ""}`,
    `- versionParity: ${report.checks.versionParity.status}`,
  ];
  for (const issue of report.checks.versionParity.issues) lines.push(`  * ${issue}`);
  lines.push(`- nodeEngine: ${report.checks.nodeEngine.status} (runtime ${report.checks.nodeEngine.runtimeVersion}, required ${report.checks.nodeEngine.required})`);
  if (report.checks.nodeEngine.issue) lines.push(`  * ${report.checks.nodeEngine.issue}`);
  lines.push(`- forbiddenDeepImports: ${report.checks.forbiddenDeepImports.status} (${report.checks.forbiddenDeepImports.violations.length} violation(s))`);
  for (const v of report.checks.forbiddenDeepImports.violations) {
    lines.push(`  * ${v.file}:${v.line}: ${v.specifier}`);
  }
  lines.push(`- deprecationsInUse: ${report.checks.deprecationsInUse.status} (${report.checks.deprecationsInUse.count} hit(s))`);
  for (const d of report.checks.deprecationsInUse.items) {
    lines.push(`  * ${d.file}:${d.line}: ${d.symbol} from ${d.subpath}`);
  }
  for (const key of ["verify", "settings", "recipes"] as const) {
    const check = report.checks[key];
    lines.push(`- ${key}: ${check.status}${check.status === "skipped" ? ` (${check.reason})` : ` (${check.detail})`}`);
  }
  if (report.receiptPath) lines.push(`Receipt written: ${report.receiptPath}`);
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// 3. Idempotent syncAgentsMd
// ---------------------------------------------------------------------------

export function renderManagedAgentsBlock(): string {
  return [
    AGENTS_RULES_BEGIN,
    "## OpenLup rules",
    "",
    "This application installs `@openlup/*` packages from npm. Keep your application's own rules outside this managed block.",
    "",
    "- **Read the installed guide first.** Start from `node_modules/@openlup/core/docs/guide/README.md` and each installed package's `AGENTS.md`, `README.md`, and `CHANGELOG.md` before relying on memory.",
    "- **Search installed contracts offline.** Run `npx --no -- openlup-context search \"<task or symbol>\"` (or configure `openlup-context mcp`) from the application root and inspect cited `.d.ts` declarations and shipped `src/` before editing.",
    "- **Analyze upgrades before editing.** Run `npx --no -- openlup-context impact --from <previous-version> --format markdown` (or `npx --no -- openlup upgrade impact --from <previous-version>`) and follow the bundled upgrade skill at `node_modules/@openlup/core/skills/openlup-upgrade/SKILL.md`.",
    "- **Verify parity and wiring with doctor.** Run `npx --no -- openlup-context doctor` (or `npx --no -- openlup doctor`) after changing `@openlup/*` pins to confirm exact version parity, Node `>=24`, zero deep internal imports, and deprecated symbols in use.",
    "- **Keep the managed block fresh.** Run `npx --no -- openlup-context agents-sync` (or `npx --no -- openlup agents sync`) after upgrades; pass `--check` in CI to detect drift.",
    "- **Keep the engine in npm.** Move every `@openlup/*` package together to the same exact version. Never edit `node_modules/@openlup/*` or import `@openlup/*/src/*` or `@openlup/*/dist/*`.",
    "- **Never rewrite published SQL.** Apply newly shipped SQL migrations through your application's own migration chain and verify behavior with characterization tests before deploying.",
    AGENTS_RULES_END,
  ].join("\n");
}

export function syncAgentsMd(options: SyncAgentsMdOptions): SyncAgentsMdResult {
  const root = resolve(options.root);
  const check = options.check === true;
  const targetPath = join(root, "AGENTS.md");
  const managedBlock = renderManagedAgentsBlock();
  const existing = readText(targetPath);

  if (existing === undefined) {
    const created = `# Agent guide for this application\n\n${managedBlock}\n\n## This application\n\nWrite your application's own rules here, outside the managed block.\n`;
    if (!check) writeFileSync(targetPath, created, "utf8");
    return { formatVersion: 1, path: "AGENTS.md", status: check ? "drift" : "updated", action: "create", changed: true };
  }

  const beginIdx = existing.indexOf(AGENTS_RULES_BEGIN);
  const endIdx = existing.indexOf(AGENTS_RULES_END);
  const secondBegin = beginIdx >= 0 ? existing.indexOf(AGENTS_RULES_BEGIN, beginIdx + AGENTS_RULES_BEGIN.length) : -1;
  const secondEnd = endIdx >= 0 ? existing.indexOf(AGENTS_RULES_END, endIdx + AGENTS_RULES_END.length) : -1;

  if ((beginIdx >= 0) !== (endIdx >= 0) || (beginIdx >= 0 && endIdx < beginIdx) || secondBegin >= 0 || secondEnd >= 0) {
    throw new Error("Malformed openlup-agent-rules markers in AGENTS.md; fix the BEGIN/END comment pair before running agents-sync.");
  }

  let next: string;
  let action: "none" | "update" | "append";
  if (beginIdx >= 0 && endIdx >= 0) {
    const before = existing.slice(0, beginIdx);
    const after = existing.slice(endIdx + AGENTS_RULES_END.length);
    next = `${before}${managedBlock}${after}`;
    action = next === existing ? "none" : "update";
  } else {
    const separator = existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
    next = `${existing}${separator}${managedBlock}\n`;
    action = "append";
  }

  if (action === "none") {
    return { formatVersion: 1, path: "AGENTS.md", status: "up_to_date", action: "none", changed: false };
  }
  if (!check) writeFileSync(targetPath, next, "utf8");
  return { formatVersion: 1, path: "AGENTS.md", status: check ? "drift" : "updated", action, changed: true };
}
