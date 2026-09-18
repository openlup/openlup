// Shared serverless-function packaging-closure analysis for the `api/**` bundle.
//
// WHY: three defect classes crash a deployed function although every file exists
// in the checkout — a relative `.ts` specifier (#1852), a `package.json` `imports`
// alias resolving to a raw `.ts`, and a `new URL("…", import.meta.url)` literal.
// In the last two the platform's file tracer never sees the target, so the lambda
// ships without it: incident `staging-run-31686579103-attempt-1`.
//
// WHY NOT a hand-written list of affected entrypoints (the shape
// `src/lib/providerInvariantGuardrails.test.ts` still carries): a list cannot know
// a fourth entrypoint started importing the adapter — how #3 was missed once.
//
// SO: this module owns the DERIVED analysis — one reachability graph rooted at
// every `api/**` entrypoint, the `imports` leaf walk, and the URL-literal
// extraction. `scripts/serverless-include-globs.ts` owns the `includeFiles`
// declaration and its matcher; the import-specifier guard owns rules, the full
// rationale, and the CLI.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

// Resolution order mirrors what the platform finds on disk: an exact hit first,
// then the TypeScript source a `.js`/`.jsx` specifier compiles down from.
const RESOLVE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"] as const;
// Roots the walk may enter: `api` holds the entrypoints, server/ and src/ the
// transitively-reachable graph.
const FIRST_PARTY_ROOTS = ["api", "server", "src"] as const;
const IGNORED_DIRS = [".git", "node_modules", "dist", "coverage", ".vercel"];

export type SiteRef = { specifier: string; line: number };
export type ModuleScan = {
  file: string;
  rel: string;
  hasDefaultExport: boolean;
  edges: string[];
  tsSpecifiers: SiteRef[];
  aliasLeaves: (SiteRef & { leaf: string })[];
  aliasUnresolved: SiteRef[];
  urlAssets: (SiteRef & { target: string })[];
};
export type ClosureGraph = { root: string; entrypoints: string[]; scans: Map<string, ModuleScan> };

export function toPosix(path: string): string {
  return path.split(sep).join("/");
}

function isTestPath(path: string): boolean {
  return /(?:^|[./])(?:test|spec)\.[tj]sx?$/.test(path) || path.includes(`${sep}tests${sep}`);
}

export function isScannableSource(path: string): boolean {
  if (path.endsWith(".d.ts") || isTestPath(path)) return false;
  return RESOLVE_EXTENSIONS.some((ext) => path.endsWith(ext));
}

export function isRelativeSpecifier(specifier: string): boolean {
  return specifier.startsWith("./") || specifier.startsWith("../");
}

export function hasTsExtension(specifier: string): boolean {
  return /\.tsx?$/.test(specifier);
}

function existingFile(path: string): string | null {
  try {
    return statSync(path).isFile() ? path : null;
  } catch {
    return null;
  }
}

// `.js`/`.jsx` bases map to their `.ts`/`.tsx` source sibling the way the platform
// resolves emitted output back; extensionless bases try index files.
function resolveFileBase(base: string): string | null {
  const extMatch = /\.(tsx?|jsx?)$/.exec(base);
  const stems = extMatch ? [base.slice(0, base.length - extMatch[0].length)] : [base, join(base, "index")];
  if (extMatch) {
    const exact = existingFile(base);
    if (exact) return exact;
  }
  for (const stem of stems) {
    for (const ext of RESOLVE_EXTENSIONS) {
      const candidate = existingFile(stem + ext);
      if (candidate) return candidate;
    }
  }
  return null;
}

// Resolve a specifier to its on-disk module, or null for a bare/package import.
export function resolveSpecifier(fromFile: string, specifier: string, root: string): string | null {
  if (isRelativeSpecifier(specifier)) return resolveFileBase(resolve(dirname(fromFile), specifier));
  if (specifier.startsWith("@/")) return resolveFileBase(resolve(root, "src", specifier.slice(2)));
  return null;
}

function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*");
}

// Line-scoped extraction of static `from "x"`, side-effect `import "x"` and
// dynamic `import("x")` specifiers. A multi-line named import still terminates in
// `} from "x"` on one line, so per-line scanning keeps line numbers honest.
const IMPORT_PATTERNS: RegExp[] = [
  /\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]/g,
  /^\s*import\s+['"]([^'"]+)['"]/g,
];
// Whole-file (not per-line) so a wrapped call and a trailing comma both match;
// `[^()]` keeps the window from spanning a closing paren into unrelated code.
// v1 limitation: the first argument must be a literal — a URL assembled by a
// helper (`buildEdgeUrl(name)`) is a known false negative, and the fix for that
// shape is to extract at the helper rather than to grow this regex.
const URL_ASSET_PATTERN = /new URL\(\s*['"]([^'"]+)['"][^()]{0,120}?import\.meta\.url\s*,?\s*\)/g;
// A default export makes an `api/**` file an invokable function. All three forms
// count, including `export { default } from "./handler.js"` — missing that one
// would silently drop a thin entrypoint out of rules B and C.
const DEFAULT_EXPORT_PATTERNS = [/^\s*export\s+default\b/m, /^\s*export\s*\{[^}]*\bdefault\b/m, /\bas\s+default\b/];

function matchAll(line: string, pattern: RegExp): string[] {
  pattern.lastIndex = 0;
  const out: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(line)) !== null) out.push(match[1]);
  return out;
}

function listSourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (IGNORED_DIRS.includes(entry)) continue;
      const path = join(current, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (isScannableSource(path)) out.push(path);
    }
  };
  walk(root);
  return out;
}

export function isWithinFirstParty(root: string, file: string): boolean {
  const rel = relative(root, file);
  if (rel.startsWith("..")) return false;
  return FIRST_PARTY_ROOTS.some((dir) => rel === dir || rel.startsWith(`${dir}${sep}`));
}

function isInRepository(root: string, file: string): boolean {
  const rel = relative(root, file);
  return rel !== "" && !rel.startsWith("..") && !rel.split(sep).includes("node_modules");
}

// The serverless-function entrypoints: every non-test `.ts(x)` under api/.
export function collectFunctionEntrypoints(root = process.cwd()): string[] {
  const apiRoot = join(root, "api");
  try {
    if (!statSync(apiRoot).isDirectory()) return [];
  } catch {
    return [];
  }
  return listSourceFiles(apiRoot);
}

// Every string leaf of a `package.json` "imports" alias. Conditional objects are
// walked in full because the deployment picks the condition, not this scanner:
// `#email-presentation` resolves to the overlay under `deployment-overlay` and to
// the neutral example under `default`; either can be the packaged file.
export function packageImportLeaves(root: string): Map<string, string[]> {
  let imports: unknown;
  try {
    imports = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { imports?: unknown }).imports;
  } catch {
    return new Map();
  }
  const out = new Map<string, string[]>();
  if (!imports || typeof imports !== "object") return out;
  for (const [alias, target] of Object.entries(imports as Record<string, unknown>)) {
    const leaves: string[] = [];
    const visit = (value: unknown): void => {
      if (typeof value === "string") leaves.push(value);
      else if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object") Object.values(value).forEach(visit);
    };
    visit(target);
    out.set(alias, leaves);
  }
  return out;
}

function collectAliasLeaves(root: string, scan: ModuleScan, leaves: string[] | undefined, site: SiteRef): void {
  // Fail closed: an alias this resolver cannot map (undeclared, or a `#foo/*`
  // pattern form nothing here uses yet) is reported, never skipped.
  if (!leaves?.length) {
    scan.aliasUnresolved.push(site);
    return;
  }
  for (const leaf of leaves) {
    const target = resolveFileBase(resolve(root, leaf));
    if (!target || !isInRepository(root, target)) {
      scan.aliasUnresolved.push(site);
      continue;
    }
    // Only a RAW .ts/.tsx leaf needs packaging; a traceable target travels alone.
    if (hasTsExtension(target)) scan.aliasLeaves.push({ ...site, leaf: target });
    if (isWithinFirstParty(root, target)) scan.edges.push(target);
  }
}

function scanModule(root: string, file: string, aliases: Map<string, string[]>): ModuleScan {
  const scan: ModuleScan = {
    file,
    rel: relative(root, file),
    hasDefaultExport: false,
    edges: [],
    tsSpecifiers: [],
    aliasLeaves: [],
    aliasUnresolved: [],
    urlAssets: [],
  };
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return scan;
  }
  scan.hasDefaultExport = DEFAULT_EXPORT_PATTERNS.some((pattern) => pattern.test(text));
  collectUrlAssets(root, scan, text);
  text.split(/\r?\n/).forEach((line, index) => {
    if (isCommentLine(line)) return;
    for (const specifier of IMPORT_PATTERNS.flatMap((pattern) => matchAll(line, pattern))) {
      const site = { specifier, line: index + 1 };
      if (isRelativeSpecifier(specifier) && hasTsExtension(specifier)) scan.tsSpecifiers.push(site);
      if (specifier.startsWith("#")) {
        collectAliasLeaves(root, scan, aliases.get(specifier), site);
        continue;
      }
      const target = resolveSpecifier(file, specifier, root);
      if (target && isWithinFirstParty(root, target)) scan.edges.push(target);
    }
  });
  return scan;
}

function collectUrlAssets(root: string, scan: ModuleScan, text: string): void {
  URL_ASSET_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = URL_ASSET_PATTERN.exec(text)) !== null) {
    const before = text.slice(0, match.index);
    const line = before.split("\n").length;
    if (isCommentLine(before.slice(before.lastIndexOf("\n") + 1))) continue;
    const target = resolve(dirname(scan.file), match[1]);
    if (existingFile(target) && isInRepository(root, target)) {
      scan.urlAssets.push({ specifier: match[1], line, target });
    }
  }
}

// One pass over the reachable set: scan each module once and keep its resolved
// edges, so per-entrypoint reachability is an in-memory BFS, not 80 disk walks.
export function buildClosureGraph(root = process.cwd()): ClosureGraph {
  const aliases = packageImportLeaves(root);
  const entrypoints = collectFunctionEntrypoints(root);
  const scans = new Map<string, ModuleScan>();
  const queue = [...entrypoints];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (scans.has(file) || !isScannableSource(file)) continue;
    const scan = scanModule(root, file, aliases);
    scans.set(file, scan);
    for (const edge of scan.edges) if (!scans.has(edge)) queue.push(edge);
  }
  return { root, entrypoints, scans };
}

export function reachableFrom(graph: ClosureGraph, entrypoint: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entrypoint];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const edge of graph.scans.get(file)?.edges ?? []) if (!seen.has(edge)) queue.push(edge);
  }
  return seen;
}
