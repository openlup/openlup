#!/usr/bin/env node

// Opt-in development tool. Kernel exports never import this file.
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { findPackageJSON } from "node:module";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export type InstalledPackage = { name: string; version: string; root: string; manifest: string };
type ScanSummary = { scope: "declarations" | "application" | "package-source"; packageName?: string; scannedFiles: number; fileLimit: number; limitReached: boolean };
type ScanResult = { hits: Hit[]; summary?: ScanSummary };
export type SymbolMaturity = "stable" | "experimental" | "testing";
// maturity and deprecated appear only on an export hit for a symbol whose declaration was found inside the package.
type Hit = { title: string; file: string; start: number; end: number; owner?: string; packageName: string; score: number; reason: string; maturity?: SymbolMaturity; deprecated?: true };
export type SearchContextOptions = {
  limit?: number;
  scanLimits?: {
    declarations?: number;
    application?: number;
    packageSource?: number;
  };
};

const ignoredWords = new Set(["a", "an", "and", "are", "by", "do", "for", "from", "how", "in", "is", "of", "on", "or", "the", "to", "with", "czy", "dla", "gdzie", "i", "jak", "jest", "na", "oraz", "po", "przez", "się", "w", "z"]);
const codeExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]);
const skippedDirectories = new Set(["node_modules", ".git", ".next", ".turbo", "coverage", "dist", "build", ".cache"]);
const guideEntryLimit = 400;
const guideFileBytes = 200_000;
const packageFileLimit = 2000;
const applicationFileLimit = 2500;
const defaultHitLimit = 8;
const maxHitLimit = 50;
const apiReportHeading = /^`?packages\/[^/]+\/api\/[^/]+\.api\.md`?$/u;
const usage = "Usage: openlup-context search <task> [--code] [--package-code] [--limit <1..50>] [--json]\n       openlup-context impact --from <version> [--to <version>] [--manifest <path>] [--rail <managed|native>] [--exclude-starter] [--include-dormant] [--format <json|markdown>] [--json] [--root <dir>]\n       openlup-context doctor [--root <dir>] [--receipt <path>] [--json]\n       openlup-context agents-sync [--root <dir>] [--check] [--json]\n       openlup-context mcp\nRun from the application root after installing @openlup/core.\nDeclaration occurrences are unverified import leads; read installed exports and examples for public specifiers and type/value usage.\nIn a symbol's export hit, maturity is the declared maturity (stable, experimental or testing) and deprecated: true marks a deprecated symbol; maturity is absent when the declaration is not found or when no subpath maturity is known and no `@experimental` tag applies, so read the declaration.\n";

export function readSortedEntries(directory: string) {
  return readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
}

function resolveHitLimit(limit: number | undefined): number {
  if (limit === undefined) return defaultHitLimit;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maxHitLimit) {
    throw new Error(`Limit must be an integer between 1 and ${maxHitLimit}`);
  }
  return limit;
}

function resolveScanLimit(limit: number | undefined, fallback: number): number {
  if (limit === undefined) return fallback;
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error("Scan limit must be a positive integer");
  }
  return limit;
}

export function readText(path: string): string | undefined {
  try { return readFileSync(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

// Shared only by the development CLI/MCP modules, never a kernel/package export.
export function installedPackageRoots(cwd: string): { name: string; root: string }[] {
  const application = readText(join(cwd, "package.json"));
  const names = new Set<string>(["@openlup/core"]);
  if (application) {
    const manifest = JSON.parse(application) as Record<string, unknown>;
    for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
      const dependencies = manifest[field];
      if (typeof dependencies !== "object" || dependencies === null || Array.isArray(dependencies)) continue;
      for (const name of Object.keys(dependencies)) if (name.startsWith("@openlup/")) names.add(name);
    }
  } else {
    // Retain standalone installations without an application manifest. Do not enumerate
    // an ancestor's scope: it may contain packages belonging only to another app.
    const scope = join(cwd, "node_modules", "@openlup");
    if (existsSync(scope)) for (const entry of readdirSync(scope, { withFileTypes: true })) {
      if (entry.isDirectory() || entry.isSymbolicLink()) names.add(`@openlup/${entry.name}`);
    }
  }
  return [...names].sort().flatMap(name => {
    if (!/^@openlup\/[a-z0-9][a-z0-9-]*$/u.test(name)) throw new Error(`Invalid declared OpenLup package name: ${name}`);
    let manifestPath: string | undefined;
    try {
      // Node resolves self-references before node_modules. Admit only an installed
      // lexical location, without evaluating code or requiring a manifest export.
      manifestPath = findPackageJSON(name, join(resolve(cwd), "package.json"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ERR_MODULE_NOT_FOUND") throw error;
    }
    if (!manifestPath) {
      if (name !== "@openlup/core") return [];
      throw new Error("No installed @openlup/core found for this application; @openlup/core is required. Install Core with an npm node_modules layout; unsupported package-manager layouts cannot be searched.");
    }
    const root = dirname(manifestPath);
    if (!root.endsWith(`${sep}node_modules${sep}${name.split("/").join(sep)}`)) {
      throw new Error(`Installed dependency lookup for ${name} resolved outside node_modules; source self-references are not installed package evidence. Run from an application root with installed @openlup/* packages.`);
    }
    return [{ name, root }];
  });
}

export type LockEntry = { version?: string; link?: boolean; resolved?: string };
export function owningLock(cwd: string): { root: string; entries: Record<string, LockEntry> } | undefined {
  const applicationRoot = resolve(cwd);
  let root = applicationRoot;
  while (true) {
    const lock = readText(join(root, "package-lock.json"));
    if (lock) {
      const entries = (JSON.parse(lock) as { packages?: Record<string, LockEntry> }).packages;
      const applicationPath = relative(root, applicationRoot).split(sep).join("/");
      if (root === applicationRoot || (entries && Object.hasOwn(entries, applicationPath))) {
        if (!entries) throw new Error("Unsupported npm lockfile: use an npm lockfile with a packages map");
        return { root, entries };
      }
    }
    const parent = dirname(root);
    if (parent === root) return undefined;
    root = parent;
  }
}

export function selectedPackages(cwd: string): InstalledPackage[] {
  const packages = installedPackageRoots(cwd).map(({ name, root }) => {
    const manifest = readText(join(root, "package.json"));
    if (!manifest) throw new Error(`Invalid installed package manifest: ${root}`);
    const parsed = JSON.parse(manifest) as { name?: string; version?: string };
    if (parsed.name !== name || typeof parsed.version !== "string" || !parsed.version) throw new Error(`Invalid installed package manifest: ${root}`);
    return { name, version: parsed.version, root, manifest };
  });
  const versions = new Set(packages.map((item) => item.version));
  if (versions.size !== 1) throw new Error(`Mixed @openlup/* versions: ${packages.map((item) => `${item.name}@${item.version}`).join(", ")}`);
  const lock = owningLock(cwd);
  if (lock) {
    for (const item of packages) {
      const installedPath = relative(lock.root, item.root).split(sep).join("/");
      const entry = lock.entries[installedPath];
      const locked = entry?.link && entry.resolved ? lock.entries[entry.resolved]?.version : entry?.version;
      if (!locked) throw new Error(`Owning npm lockfile has no package version for ${item.name} at ${installedPath}; reinstall the declared set from the owning npm workspace`);
      if (locked !== item.version) throw new Error(`Lockfile and installed package disagree: ${item.name} (${locked} vs ${item.version})`);
    }
  }
  return packages.sort((left, right) => left.name.localeCompare(right.name));
}

function tokens(value: string): string[] {
  return [...new Set((value.toLocaleLowerCase("en").match(/[\p{L}\p{N}_./@-]+/gu) ?? []).filter((part) => part.length > 1 && !ignoredWords.has(part)))];
}

function relevance(title: string, body: string, query: string, terms: string[]): number {
  const normalizedTitle = title.toLocaleLowerCase("en");
  const normalizedBody = body.toLocaleLowerCase("en");
  let matched = 0;
  let score = 0;
  for (const term of terms) {
    const inTitle = normalizedTitle.includes(term);
    const inBody = normalizedBody.includes(term);
    if (!inTitle && !inBody) continue;
    matched++;
    score += (inTitle ? 5 : 0) + (inBody ? 1 : 0);
  }
  if (!matched) return 0;
  if (terms.length > 1) score *= matched / terms.length;
  if (normalizedTitle.includes(query)) score += 7;
  else if (normalizedBody.includes(query)) score += 3;
  return score / Math.sqrt(Math.max(1, body.length / 1400));
}

function lineNumber(text: string, offset: number): number {
  let count = 1;
  for (let index = 0; index < offset; index++) if (text[index] === "\n") count++;
  return count;
}

function markdownHits(item: InstalledPackage, fileName: string, query: string, terms: string[]): Hit[] {
  const file = join(item.root, fileName);
  const content = readText(file);
  if (!content) return [];
  const lines = content.split("\n");
  const headings: { index: number; title: string }[] = [];
  let fence: string | undefined;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/u)?.[1];
    if (fence) { if (marker?.[0] === fence[0] && marker.length >= fence.length && /^ {0,3}(?:`+|~+)\s*$/u.test(line)) fence = undefined; continue; }
    if (marker) { fence = marker; continue; }
    const heading = line.match(/^(#{1,6}) (.+)$/u);
    if (heading) headings.push({ index, title: heading[2]! });
  }
  if (!headings.length) headings.push({ index: 0, title: fileName });
  const hits: Hit[] = [];
  for (const [position, heading] of headings.entries()) {
    const endIndex = headings[position + 1]?.index ?? lines.length;
    const body = lines.slice(heading.index, endIndex).join("\n");
    const rawScore = relevance(heading.title, body, query, terms);
    const score = !query.includes(".api.md") && apiReportHeading.test(heading.title.trim()) ? rawScore * 0.25 : rawScore;
    if (score > 0) hits.push({ title: heading.title, file, start: heading.index + 1, end: endIndex, packageName: item.name, score, reason: `installed ${fileName}` });
  }
  return hits;
}

function guideFiles(item: InstalledPackage): string[] {
  // Package roots may be linked by the package manager; guide paths may not.
  for (const directory of ["docs", "docs/guide"]) {
    const path = join(item.root, directory);
    if (!existsSync(path) || !lstatSync(path).isDirectory()) return [];
  }
  const root = join(item.root, "docs/guide");
  const pending = [root];
  const files: string[] = [];
  let seen = 0;
  // Every visited entry (directory, file or link) counts toward one bound, and nothing is
  // queued beyond it, so a hostile tree cannot make the walk or its queue grow without limit.
  while (pending.length && seen < guideEntryLimit) {
    const path = pending.pop()!;
    seen++;
    const local = relative(root, path);
    if (isAbsolute(local) || local.split(sep).includes("..")) throw new Error("Guide path escapes installed docs/guide");
    const state = lstatSync(path);
    if (state.isDirectory()) {
      const names = readdirSync(path).sort().slice(0, Math.max(0, guideEntryLimit - seen - pending.length));
      for (const name of names.reverse()) {
        if (name === "." || name === ".." || /[/\\]/u.test(name)) throw new Error("Invalid installed guide path");
        pending.push(join(path, name));
      }
    } else if (state.isFile() && path.endsWith(".md") && state.size <= guideFileBytes) {
      files.push(`docs/guide/${local.split(sep).join("/")}`);
    }
  }
  return files.sort();
}

function querySymbol(query: string): string | undefined {
  const trimmed = query.trim();
  const exact = /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(trimmed);
  return query.match(/\b[A-Za-z_$][A-Za-z0-9_$]{2,}\b/gu)?.find((word) =>
    (exact && word === trimmed) || /[A-Z_]/u.test(word.slice(1)));
}

// onBlock receives each /* ... */ comment, delimiters included, and the offset in the result where its blank stands.
export function stripDeclarationComments(source: string, onBlock?: (block: string, offset: number) => void): string {
  let out = "";
  let index = 0;
  const length = source.length;
  while (index < length) {
    const ch = source[index]!;
    const next = source[index + 1];
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      out += ch;
      index++;
      while (index < length) {
        const current = source[index]!;
        out += current;
        index++;
        if (current === "\\" && index < length) {
          out += source[index]!;
          index++;
          continue;
        }
        if (current === quote) break;
      }
      continue;
    }
    if (ch === "/" && next === "/") {
      index += 2;
      while (index < length && !/[\n\r\u2028\u2029]/u.test(source[index]!)) index++;
      out += " ";
      continue;
    }
    if (ch === "/" && next === "*") {
      const blockStart = index;
      index += 2;
      let sawNewline = false;
      while (index < length) {
        if (source[index] === "*" && source[index + 1] === "/") {
          index += 2;
          break;
        }
        if (source[index] === "\n") sawNewline = true;
        index++;
      }
      onBlock?.(source.slice(blockStart, index), out.length);
      out += sawNewline ? "\n" : " ";
      continue;
    }
    out += ch;
    index++;
  }
  return out;
}

export function isContainedRegularFile(packageRoot: string, realRoot: string, candidate: string): boolean {
  const rel = relative(packageRoot, candidate);
  if (!rel || isAbsolute(rel)) return false;
  const segments = rel.split(sep);
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return false;
  let current = packageRoot;
  for (let index = 0; index < segments.length; index++) {
    current = join(current, segments[index]!);
    if (!existsSync(current)) return false;
    const state = lstatSync(current);
    if (state.isSymbolicLink()) return false;
    const isLast = index === segments.length - 1;
    if (isLast) {
      if (!state.isFile() || state.size > guideFileBytes) return false;
    } else if (!state.isDirectory()) {
      return false;
    }
  }
  const realCandidate = realpathSync(candidate);
  return realCandidate.startsWith(`${realRoot}${sep}`);
}

function resolveDeclarationFile(packageRoot: string, realRoot: string, fromFile: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const base = resolve(dirname(fromFile), specifier);
  const candidates = specifier.endsWith(".js")
    ? [`${base.slice(0, -3)}.d.ts`]
    : [base, `${base}.d.ts`, resolve(base, "index.d.ts")];
  for (const candidate of candidates) {
    if (isContainedRegularFile(packageRoot, realRoot, candidate)) return candidate;
  }
  return undefined;
}

export function collectExportedSymbols(packageRoot: string, realRoot: string, entrypoint: string): Set<string> {
  const symbols = new Set<string>();
  const visited = new Set<string>();
  const queued = new Set<string>([entrypoint]);
  const queue = [entrypoint];
  const fileLimit = 256;
  let head = 0;
  while (head < queue.length && visited.size < fileLimit) {
    const file = queue[head++]!;
    if (visited.has(file)) continue;
    if (!isContainedRegularFile(packageRoot, realRoot, file)) continue;
    visited.add(file);
    const cleaned = stripDeclarationComments(readFileSync(file, "utf8"));
    for (const match of cleaned.matchAll(/^export\s+(?:declare\s+)?(?:abstract\s+)?(?:const\s+enum|enum|function|const|let|var|class|interface|type|namespace)\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/gmu)) {
      if (match[1]) symbols.add(match[1]);
    }
    for (const match of cleaned.matchAll(/^export\s+(?:type\s+)?\{([^}]*)\}/gmu)) {
      const body = match[1] ?? "";
      for (const rawItem of body.split(",")) {
        const cleanedItem = rawItem.replace(/^\s*type\s+/u, "").trim();
        if (!cleanedItem) continue;
        const asMatch = cleanedItem.match(/^[A-Za-z_$][A-Za-z0-9_$]*\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)$/u);
        if (asMatch?.[1]) symbols.add(asMatch[1]);
        else if (/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(cleanedItem)) symbols.add(cleanedItem);
      }
    }
    for (const match of cleaned.matchAll(/^export\s+(?:type\s+)?\*\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)\s+from\s+["']([^"']+)["']/gmu)) {
      if (match[1]) symbols.add(match[1]);
    }
    for (const match of cleaned.matchAll(/^export\s+(?:type\s+)?\*\s+from\s+["']([^"']+)["']/gmu)) {
      const target = match[1] ? resolveDeclarationFile(packageRoot, realRoot, file, match[1]) : undefined;
      if (target && !queued.has(target)) {
        queued.add(target);
        queue.push(target);
      }
    }
  }
  return symbols;
}

type Tags = { experimental: boolean; deprecated: boolean };
const noTags: Tags = { experimental: false, deprecated: false };
const singleLineSpace = /[ \t\v\f\u0085\u00a0\u1680\u2000-\u200b\u202f\u205f\u3000\ufeff]/u;
// At a line start the scanner knows four blanks and two line ends; elsewhere it uses the wider sets.
const lineStartSpace = /[ \t\v\f]/u;
const newline = /[\n\r]/u;
const lineBreak = /[\n\r\u2028\u2029]/u;
const isBlank = (char: string) => singleLineSpace.test(char) || lineBreak.test(char);
// Identifier characters, plus the hyphen the comment scanner admits in a tag name.
const tagNamePart = "(?:[\\p{ID_Continue}$-]|\\u200c|\\u200d)";
const tagName = new RegExp(`[\\p{ID_Start}$_]${tagNamePart}*`, "uy");
const linkPrefix = new RegExp(`\\{@(?:link|linkcode|linkplain)(?!${tagNamePart})`, "uy");

/**
 * The @experimental and @deprecated tags of one doc comment, read as the TypeScript compiler reads the comment it
 * attaches to a declaration.
 */
export function jsdocTags(block: string): Tags {
  const tags = { ...noTags };
  if (block.length < 5 || !block.startsWith("/**") || block.startsWith("/**/") || !block.endsWith("*/")) return tags;
  const text = block.slice(3, -2);
  let state: "bol" | "saw" | "text" | "tick" = "saw";
  let inTag = false;
  const readTag = (at: number): number => {
    tagName.lastIndex = at + 1;
    const name = tagName.exec(text)?.[0] ?? "";
    if (name === "experimental") tags.experimental = true;
    if (name === "deprecated") tags.deprecated = true;
    inTag = true;
    let index = at + 1 + name.length;
    let afterBreak = false;
    for (; index < text.length; index++) {
      const char = text[index]!;
      if (newline.test(char)) afterBreak = true;
      else if (char === "*" && afterBreak) afterBreak = false;
      else if (!lineStartSpace.test(char)) break;
    }
    state = "saw";
    return index;
  };
  const skipLink = (at: number): number => {
    state = "text";
    linkPrefix.lastIndex = at;
    if (!linkPrefix.test(text)) return at + 1;
    let index = at + 1;
    while (index < text.length && text[index] !== "}" && !newline.test(text[index]!)) index++;
    if (text[index] === "\r" && text[index + 1] === "\n") index++;
    return index + 1;
  };
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    if (newline.test(char)) { state = "bol"; index++; continue; }
    if (state === "bol" || state === "saw") {
      if (lineStartSpace.test(char)) index++;
      else if (char === "*") { state = state === "saw" ? "text" : "saw"; index++; }
      else if (char === "@") index = readTag(index);
      else if (char === "`" && inTag) { state = "tick"; index++; }
      else if (char === "{") index = skipLink(index);
      else { state = "text"; index++; }
      continue;
    }
    if (char === "`") {
      if (inTag) state = state === "tick" ? "text" : "tick";
      index++;
    } else if (state === "text" && char === "{") {
      index = skipLink(index);
    } else if (state === "text" && char === "@" && index > 0 && singleLineSpace.test(text[index - 1]!)
      && !(index + 1 < text.length && (singleLineSpace.test(text[index + 1]!) || lineBreak.test(text[index + 1]!)))) {
      index = readTag(index);
    } else index++;
  }
  return tags;
}

type FileFacts = {
  declared: Map<string, Tags[]>;
  named: Map<string, { local: string; from?: string; tags: Tags }>;
  namespaces: Map<string, Tags>;
  stars: { from: string; tags: Tags }[];
};

function laterDeclarators(text: string, start: number): string[] {
  const names: string[] = [];
  let depth = 0;
  for (let index = start; index < text.length; index++) {
    const char = text[index]!;
    if (char === '"' || char === "'" || char === "`") {
      for (index++; index < text.length && text[index] !== char; index++) if (text[index] === "\\") index++;
    } else if (char === "(" || char === "[" || char === "{" || char === "<") depth++;
    else if (char === ")" || char === "]" || char === "}" || (char === ">" && text[index - 1] !== "=")) { if (--depth < 0) break; }
    else if (depth === 0 && char === ";") break;
    else if (depth === 0 && char === "\n" && /^\s*(?:export|declare|import)\b/u.test(text.slice(index + 1, index + 40))) break;
    else if (depth === 0 && char === ",") {
      const name = /^\s*([A-Za-z_$][A-Za-z0-9_$]*)/u.exec(text.slice(index + 1, index + 200))?.[1];
      if (name) names.push(name);
    }
  }
  return names;
}

function nestedPositions(text: string): Uint8Array {
  const nested = new Uint8Array(text.length);
  let depth = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (char === '"' || char === "'" || char === "`") {
      const start = index;
      for (index++; index < text.length && text[index] !== char; index++) if (text[index] === "\\") index++;
      nested.fill(1, start, Math.min(index + 1, text.length));
    } else if (char === "{") { depth++; nested[index] = 1; }
    else if (char === "}") { depth = Math.max(0, depth - 1); nested[index] = depth > 0 ? 1 : 0; }
    else if (depth > 0) nested[index] = 1;
  }
  return nested;
}

function fileFacts(source: string): FileFacts {
  const blocks: { offset: number; text: string }[] = [];
  const blanks = new Set<number>();
  const cleaned = stripDeclarationComments(source, (text, offset) => {
    blanks.add(offset);
    if (text.startsWith("/**") && !text.startsWith("/**/")) blocks.push({ offset, text });
  });
  const nested = nestedPositions(cleaned);
  const leadingTags = (statementStart: number): Tags => {
    let previousEnd = statementStart;
    while (previousEnd > 0 && isBlank(cleaned[previousEnd - 1]!)) previousEnd--;
    let last: string | undefined;
    for (const { offset, text } of blocks) {
      if (offset < previousEnd || offset >= statementStart) continue;
      let broken = previousEnd === 0;
      for (let at = previousEnd; at < offset && !broken; at++) broken = (cleaned[at] === "\n" || cleaned[at] === "\r") && !blanks.has(at);
      if (broken) last = text;
    }
    return last === undefined ? noTags : jsdocTags(last);
  };
  const startsStatement = (start: number): boolean => {
    let previousEnd = start;
    while (previousEnd > 0 && isBlank(cleaned[previousEnd - 1]!)) previousEnd--;
    return previousEnd === 0 || cleaned[previousEnd - 1] === ";" || cleaned[previousEnd - 1] === "}" || lineBreak.test(cleaned.slice(previousEnd, start));
  };
  const facts: FileFacts = { declared: new Map(), named: new Map(), namespaces: new Map(), stars: [] };
  const statements = (pattern: RegExp, handle: (match: RegExpExecArray, tags: Tags) => void) => {
    for (const match of cleaned.matchAll(pattern)) {
      if (!nested[match.index] && startsStatement(match.index)) handle(match, leadingTags(match.index));
    }
  };
  statements(/\bexport\s+(?:declare\s+)?(?:abstract\s+)?(const\s+enum|enum|function|const|let|var|class|interface|type|namespace)\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/gu, (match, tags) => {
    const names = [match[2]!];
    if (/^(?:const|let|var)$/u.test(match[1]!)) names.push(...laterDeclarators(cleaned, match.index + match[0].length));
    for (const name of names) facts.declared.set(name, [...facts.declared.get(name) ?? [], tags]);
  });
  statements(/\bexport\s+(?:type\s+)?\{([^}]*)\}(?:\s*from\s*["']([^"']+)["'])?/gu, (match, tags) => {
    for (const item of (match[1] ?? "").split(",")) {
      const specifier = /^([A-Za-z_$][A-Za-z0-9_$]*)(?:\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*))?$/u.exec(item.replace(/^\s*type\s+/u, "").trim());
      if (specifier) facts.named.set(specifier[2] ?? specifier[1]!, { local: specifier[1]!, ...(match[2] === undefined ? {} : { from: match[2] }), tags });
    }
  });
  statements(/\bexport\s+(?:type\s+)?\*\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)\s+from\s+["']([^"']+)["']/gu, (match, tags) => {
    facts.namespaces.set(match[1]!, tags);
  });
  statements(/\bexport\s+(?:type\s+)?\*\s+from\s+["']([^"']+)["']/gu, (match, tags) => {
    facts.stars.push({ from: match[1]!, tags });
  });
  return facts;
}

const hasTag = (tags: Tags) => tags.experimental || tags.deprecated;
const inherit = (inner: Tags, statement: Tags): Tags => hasTag(inner) || !hasTag(statement) ? inner : statement;

/**
 * Reads the declared tags of one exported symbol of a subpath from its declaration files, starting at the
 * subpath's entry file.
 */
export function declaredSymbolMaturity(packageRoot: string, entrypoint: string, symbol: string, subpathMaturity?: string): { maturity?: SymbolMaturity; deprecated?: true } | undefined {
  const realRoot = realpathSync(packageRoot);
  const cache = new Map<string, FileFacts | undefined>();
  const facts = (file: string): FileFacts | undefined => {
    if (!cache.has(file)) cache.set(file, isContainedRegularFile(packageRoot, realRoot, file) ? fileFacts(readFileSync(file, "utf8")) : undefined);
    return cache.get(file);
  };
  let budget = 256;
  const find = (file: string, name: string): Tags | undefined => {
    if (budget-- <= 0) return undefined;
    const known = facts(file);
    if (!known) return undefined;
    const declared = known.declared.get(name);
    if (declared) return { experimental: declared.some((tags) => tags.experimental), deprecated: declared.some((tags) => tags.deprecated) };
    const named = known.named.get(name);
    if (named) {
      const target = named.from === undefined ? undefined : resolveDeclarationFile(packageRoot, realRoot, file, named.from);
      const inner = target === undefined ? undefined : find(target, named.local);
      return inner && inherit(inner, named.tags);
    }
    const space = known.namespaces.get(name);
    if (space) return space;
    for (const star of known.stars) {
      const target = resolveDeclarationFile(packageRoot, realRoot, file, star.from);
      const inner = target === undefined ? undefined : find(target, name);
      if (inner) return inherit(inner, star.tags);
    }
    return undefined;
  };
  const tags = find(entrypoint, symbol);
  if (!tags) return undefined;
  const maturity = tags.experimental ? "experimental" : subpathMaturity === "stable" || subpathMaturity === "testing" || subpathMaturity === "experimental" ? subpathMaturity : undefined;
  return { ...(maturity ? { maturity } : {}), ...(tags.deprecated ? { deprecated: true as const } : {}) };
}

function subpathMaturity(item: InstalledPackage, subpath: string): SymbolMaturity | undefined {
  const file = join(item.root, "release-gates.json");
  if (!isContainedRegularFile(item.root, realpathSync(item.root), file)) return undefined;
  try {
    const surface = (JSON.parse(readFileSync(file, "utf8")) as { packageSurface?: Record<string, { maturity?: unknown }> }).packageSurface;
    const maturity = surface && Object.hasOwn(surface, subpath) ? surface[subpath]?.maturity : undefined;
    return maturity === "stable" || maturity === "testing" || maturity === "experimental" ? maturity : undefined;
  } catch { return undefined; }
}

function declarationHits(item: InstalledPackage, query: string, fileLimit: number): ScanResult {
  const symbol = querySymbol(query);
  if (!symbol) return { hits: [] };
  const symbolPattern = new RegExp(`\\b${symbol.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\b`, "u");
  const root = join(item.root, "dist");
  if (!existsSync(root)) return { hits: [] };
  const hits: Hit[] = [];
  const pending = [root];
  let seen = 0;
  while (pending.length && seen < fileLimit) {
    const directory = pending.pop()!;
    const subdirs: string[] = [];
    for (const entry of readSortedEntries(directory)) {
      if (seen >= fileLimit) break;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) subdirs.push(path);
      else if (entry.isFile() && path.endsWith(".d.ts")) {
        seen++;
        const content = readFileSync(path, "utf8");
        const lines = content.split("\n");
        for (let index = 0; index < lines.length; index++) {
          if (!symbolPattern.test(lines[index]!)) continue;
          hits.push({ title: symbol, file: path, start: index + 1, end: index + 1, packageName: item.name, score: 20, reason: "declaration occurrence; public import unverified" });
          break;
        }
      }
    }
    for (let index = subdirs.length - 1; index >= 0; index--) pending.push(subdirs[index]!);
  }
  return { hits, summary: { scope: "declarations", packageName: item.name, scannedFiles: seen, fileLimit, limitReached: seen >= fileLimit } };
}

function exportHits(item: InstalledPackage, query: string, terms: string[], rawTask: string): Hit[] {
  const parsed = JSON.parse(item.manifest) as { exports?: Record<string, unknown> };
  const hits: Hit[] = [];
  const symbol = querySymbol(rawTask);
  const exportsOffset = item.manifest.indexOf('"exports"');
  for (const [subpath, target] of Object.entries(parsed.exports ?? {})) {
    const title = subpath === "." ? item.name : `${item.name}/${subpath.slice(2)}`;
    const offset = item.manifest.indexOf(JSON.stringify(subpath), exportsOffset);
    if (offset < 0) continue;
    const line = lineNumber(item.manifest, offset);
    let matchedByName = false;
    if (terms.length <= 1 || terms.every((term) => title.toLocaleLowerCase("en").includes(term))) {
      const score = relevance(title, title, query, terms);
      if (score > 0) {
        matchedByName = true;
        hits.push({ title, file: join(item.root, "package.json"), start: line, end: line, packageName: item.name, score: score + 8, reason: "declared public export" });
      }
    }
    if (!matchedByName && symbol && target && typeof target === "object" && !Array.isArray(target)) {
      const typesTarget = (target as { types?: unknown }).types;
      if (typeof typesTarget === "string" && typesTarget.endsWith(".d.ts")) {
        const realRoot = realpathSync(item.root);
        const entrypoint = resolve(item.root, typesTarget);
        if (isContainedRegularFile(item.root, realRoot, entrypoint)) {
          const exported = collectExportedSymbols(item.root, realRoot, entrypoint);
          if (exported.has(symbol)) {
            hits.push({
              title: `${title} (${symbol})`,
              file: join(item.root, "package.json"),
              start: line,
              end: line,
              packageName: item.name,
              score: 26,
              reason: "declared public export",
              ...declaredSymbolMaturity(item.root, entrypoint, symbol, subpathMaturity(item, subpath)),
            });
          }
        }
      }
    }
  }
  return hits;
}

function applicationHits(cwd: string, query: string, terms: string[], fileLimit: number): ScanResult {
  const hits: Hit[] = [];
  const pending = [cwd];
  let seen = 0;
  while (pending.length && seen < fileLimit) {
    const directory = pending.pop()!;
    const subdirs: string[] = [];
    for (const entry of readSortedEntries(directory)) {
      if (seen >= fileLimit) break;
      if (entry.name.startsWith(".") || skippedDirectories.has(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { subdirs.push(path); continue; }
      if (!entry.isFile() || !codeExtensions.has(entry.name.slice(entry.name.lastIndexOf(".")))) continue;
      if (lstatSync(path).size > 200_000) continue;
      seen++;
      const lines = readFileSync(path, "utf8").split("\n");
      for (let index = 0; index < lines.length; index++) {
        if (!lines[index]!.includes("@openlup/") && !terms.some((term) => lines[index]!.toLocaleLowerCase("en").includes(term))) continue;
        const score = relevance(basename(path), lines[index]!, query, terms);
        if (score > 0) hits.push({ title: relative(cwd, path), file: path, start: index + 1, end: index + 1, packageName: "application", score, reason: "local application source" });
      }
    }
    for (let index = subdirs.length - 1; index >= 0; index--) pending.push(subdirs[index]!);
  }
  return { hits, summary: { scope: "application", scannedFiles: seen, fileLimit, limitReached: seen >= fileLimit } };
}

function packageSourceHits(item: InstalledPackage, query: string, terms: string[], fileLimit: number): ScanResult {
  const root = join(item.root, "src");
  if (!existsSync(root) || !lstatSync(root).isDirectory()) return { hits: [] };
  const hits: Hit[] = [];
  const pending = [root];
  let seen = 0;
  while (pending.length && seen < fileLimit) {
    const directory = pending.pop()!;
    const subdirs: string[] = [];
    for (const entry of readSortedEntries(directory)) {
      if (seen >= fileLimit) break;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { subdirs.push(path); continue; }
      if (!entry.isFile() || !codeExtensions.has(entry.name.slice(entry.name.lastIndexOf(".")))) continue;
      if (lstatSync(path).size > 200_000) continue;
      seen++;
      const installedPath = relative(item.root, path);
      if (query.includes(installedPath.toLocaleLowerCase("en"))) {
        hits.push({ title: installedPath, file: path, start: 1, end: 1, packageName: item.name, score: 30, reason: "exact installed source path" });
        continue;
      }
      const lines = readFileSync(path, "utf8").split("\n");
      let best: Hit | undefined;
      for (let index = 0; index < lines.length; index++) {
        if (!terms.some((term) => lines[index]!.toLocaleLowerCase("en").includes(term))) continue;
        const score = relevance(installedPath, lines[index]!, query, terms);
        if (score > (best?.score ?? 0)) best = { title: installedPath, file: path, start: index + 1, end: index + 1, packageName: item.name, score, reason: "installed package source" };
      }
      if (best) hits.push(best);
    }
    for (let index = subdirs.length - 1; index >= 0; index--) pending.push(subdirs[index]!);
  }
  return { hits, summary: { scope: "package-source", packageName: item.name, scannedFiles: seen, fileLimit, limitReached: seen >= fileLimit } };
}

export function searchContext(
  cwd: string,
  task: string,
  includeCode = false,
  includePackageCode = false,
  options: SearchContextOptions = {},
): { version: string; packages: string[]; hits: Hit[]; scans: ScanSummary[] } {
  const hitLimit = resolveHitLimit(options.limit);
  const declarationsLimit = resolveScanLimit(options.scanLimits?.declarations, packageFileLimit);
  const appLimit = resolveScanLimit(options.scanLimits?.application, applicationFileLimit);
  const packageSourceLimit = resolveScanLimit(options.scanLimits?.packageSource, packageFileLimit);
  const packages = selectedPackages(cwd);
  const query = task.toLocaleLowerCase("en").trim();
  const terms = tokens(task);
  if (!terms.length) throw new Error("Give a specific task, path or symbol to search");
  const scans: ScanSummary[] = [];
  const hits = packages.flatMap((item) => {
    const packageHits = [
      ...markdownHits(item, "AGENTS.md", query, terms),
      ...markdownHits(item, "README.md", query, terms),
      ...(item.name === "@openlup/core" ? [
        ...markdownHits(item, "docs/SUBSCRIPTION_ENGINE.md", query, terms),
        ...guideFiles(item).flatMap((file) => markdownHits(item, file, query, terms)),
      ] : []),
      ...(terms.some((term) => /upgrad|migrat|release|wersj/u.test(term)) ? markdownHits(item, "CHANGELOG.md", query, terms) : []),
    ];
    const declarations = declarationHits(item, task, declarationsLimit);
    if (declarations.summary) scans.push(declarations.summary);
    packageHits.push(...declarations.hits, ...exportHits(item, query, terms, task));
    return packageHits;
  });
  if (includeCode) {
    const result = applicationHits(cwd, query, terms, appLimit);
    hits.push(...result.hits);
    if (result.summary) scans.push(result.summary);
  }
  if (includePackageCode) {
    for (const item of packages) {
      const result = packageSourceHits(item, query, terms, packageSourceLimit);
      hits.push(...result.hits);
      if (result.summary) scans.push(result.summary);
    }
  }
  hits.sort((left, right) => right.score - left.score || left.file.localeCompare(right.file) || left.start - right.start);
  const unique = new Set<string>();
  const apiDiffFiles = new Set<string>();
  const selected = hits.filter((hit) => {
    const key = `${hit.file}:${hit.start}:${hit.end}`;
    if (unique.has(key)) return false;
    unique.add(key);
    if (!query.includes(".api.md") && apiReportHeading.test(hit.title.trim())) {
      if (apiDiffFiles.has(hit.file)) return false;
      apiDiffFiles.add(hit.file);
    }
    return true;
  }).slice(0, hitLimit);
  return { version: packages[0]!.version, packages: packages.map((item) => item.name), hits: selected, scans };
}

export function formatContextResult(cwd: string, result: ReturnType<typeof searchContext>): string {
  const lines = [`OpenLup ${result.version}: ${result.packages.join(", ")}`];
  for (const scan of result.scans.filter((item) => item.limitReached)) {
    lines.push(`Scan limit reached: ${scan.scope}${scan.packageName ? ` [${scan.packageName}]` : ""} ${scan.scannedFiles}/${scan.fileLimit}; inspect a known path with scoped rg.`);
  }
  if (!result.hits.length) lines.push("No indexed match. This does not prove a public seam is absent; inspect installed exports and declarations.");
  for (const [index, hit] of result.hits.entries()) {
    const path = relative(cwd, hit.file);
    lines.push(`${index + 1}. ${hit.title} [${hit.packageName}]\n   ${path}:${hit.start}-${hit.end} (${hit.reason})${hit.owner ? `; source ${hit.owner}` : ""}${hit.maturity ? `; maturity ${hit.maturity}` : ""}${hit.deprecated ? "; deprecated" : ""}`);
  }
  return `${lines.join("\n")}\n`;
}

function readOptionValue(args: readonly string[], index: number, flag: string): { value: string; nextIndex: number } {
  const arg = args[index]!;
  if (arg.startsWith(`${flag}=`)) {
    const value = arg.slice(flag.length + 1);
    if (!value) throw new Error(`${flag} requires a value`);
    return { value, nextIndex: index };
  }
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return { value, nextIndex: index + 1 };
}

async function runImpactCli(args: readonly string[]): Promise<void> {
  let root = process.cwd();
  let from: string | undefined;
  let to: string | undefined;
  let manifestPath: string | undefined;
  let rail: "managed" | "native" | undefined;
  let excludeStarter = false;
  let includeDormant = false;
  let format: "json" | "markdown" = "markdown";
  for (let index = 1; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--json") { format = "json"; continue; }
    if (arg === "--exclude-starter") { excludeStarter = true; continue; }
    if (arg === "--include-dormant") { includeDormant = true; continue; }
    if (arg === "--from" || arg.startsWith("--from=")) {
      const read = readOptionValue(args, index, "--from");
      from = read.value; index = read.nextIndex; continue;
    }
    if (arg === "--to" || arg.startsWith("--to=")) {
      const read = readOptionValue(args, index, "--to");
      to = read.value; index = read.nextIndex; continue;
    }
    if (arg === "--manifest" || arg.startsWith("--manifest=")) {
      const read = readOptionValue(args, index, "--manifest");
      manifestPath = read.value; index = read.nextIndex; continue;
    }
    if (arg === "--root" || arg.startsWith("--root=")) {
      const read = readOptionValue(args, index, "--root");
      root = read.value; index = read.nextIndex; continue;
    }
    if (arg === "--rail" || arg.startsWith("--rail=")) {
      const read = readOptionValue(args, index, "--rail");
      if (read.value !== "managed" && read.value !== "native") {
        throw new Error("--rail must be managed or native");
      }
      rail = read.value; index = read.nextIndex; continue;
    }
    if (arg === "--format" || arg.startsWith("--format=")) {
      const read = readOptionValue(args, index, "--format");
      if (read.value !== "json" && read.value !== "markdown") {
        throw new Error("--format must be json or markdown");
      }
      format = read.value; index = read.nextIndex; continue;
    }
    throw new Error(`Unknown option for impact: ${arg}`);
  }
  if (!from) throw new Error("impact requires --from <version>");
  const { analyzeUpgradeImpact, formatUpgradeImpactMarkdown } = await import("./upgrade-impact.js");
  const report = analyzeUpgradeImpact({
    root,
    from,
    ...(to ? { to } : {}),
    ...(manifestPath ? { manifestPath } : {}),
    ...(rail ? { rail } : {}),
    excludeStarter,
    includeDormant,
  });
  process.stdout.write(format === "json" ? `${JSON.stringify(report)}\n` : formatUpgradeImpactMarkdown(report));
}

async function runDoctorCli(args: readonly string[]): Promise<void> {
  let root = process.cwd();
  let receiptPath: string | undefined;
  let json = false;
  for (let index = 1; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--json") { json = true; continue; }
    if (arg === "--root" || arg.startsWith("--root=")) {
      const read = readOptionValue(args, index, "--root");
      root = read.value; index = read.nextIndex; continue;
    }
    if (arg === "--receipt" || arg.startsWith("--receipt=")) {
      const read = readOptionValue(args, index, "--receipt");
      receiptPath = read.value; index = read.nextIndex; continue;
    }
    throw new Error(`Unknown option for doctor: ${arg}`);
  }
  const { runDoctor, formatDoctorText } = await import("./upgrade-impact.js");
  const report = runDoctor({ root, ...(receiptPath ? { receiptPath } : {}) });
  process.stdout.write(json ? `${JSON.stringify(report)}\n` : formatDoctorText(report));
  if (report.verdict === "blocked") process.exitCode = 1;
}

async function runAgentsSyncCli(args: readonly string[]): Promise<void> {
  let root = process.cwd();
  let check = false;
  let json = false;
  for (let index = 1; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--check") { check = true; continue; }
    if (arg === "--json") { json = true; continue; }
    if (arg === "--root" || arg.startsWith("--root=")) {
      const read = readOptionValue(args, index, "--root");
      root = read.value; index = read.nextIndex; continue;
    }
    throw new Error(`Unknown option for agents-sync: ${arg}`);
  }
  const { syncAgentsMd } = await import("./upgrade-impact.js");
  const result = syncAgentsMd({ root, check });
  if (json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    process.stdout.write(`AGENTS.md: ${result.status} (${result.action})\n`);
  }
  if (check && result.status === "drift") process.exitCode = 1;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) { process.stdout.write(usage); return; }
  if (args[0] === "mcp" && args.length === 1) {
    const { runMcp } = await import("./agent-context-mcp.js");
    await runMcp(process.cwd(), process.stdin, process.stdout);
    return;
  }
  if (args[0] === "impact") { await runImpactCli(args); return; }
  if (args[0] === "doctor") { await runDoctorCli(args); return; }
  if (args[0] === "agents-sync") { await runAgentsSyncCli(args); return; }
  if (args[0] !== "search") throw new Error(usage.trim());
  let json = false;
  let code = false;
  let packageCode = false;
  let limit: number | undefined;
  const taskParts: string[] = [];
  for (let index = 1; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--json") { json = true; continue; }
    if (arg === "--code") { code = true; continue; }
    if (arg === "--package-code") { packageCode = true; continue; }
    if (arg === "--limit" || arg.startsWith("--limit=")) {
      const raw = arg === "--limit" ? args[++index] : arg.slice("--limit=".length);
      if (raw === undefined || !/^\d+$/u.test(raw)) {
        throw new Error(`Limit must be an integer between 1 and ${maxHitLimit}`);
      }
      limit = resolveHitLimit(Number(raw));
      continue;
    }
    if (arg.startsWith("--")) throw new Error(usage.trim());
    taskParts.push(arg);
  }
  const task = taskParts.join(" ").trim();
  const result = searchContext(process.cwd(), task, code, packageCode, limit === undefined ? undefined : { limit });
  if (json) { process.stdout.write(`${JSON.stringify(result)}\n`); return; }
  process.stdout.write(formatContextResult(process.cwd(), result));
}

export async function runCli(): Promise<void> {
  try { await main(); }
  catch (error) { process.stderr.write(`openlup-context: ${(error as Error).message}\n`); process.exitCode = 1; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void runCli();
