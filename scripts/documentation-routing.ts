import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";

export const DOCUMENTATION_ROUTING_PATH = "config/doc-routing.json";
export type DocumentationSurface = { id: string; when: string; paths: string[]; doc: string; anchor: string };
export type DocumentationOwner = DocumentationSurface & { unit: string };
export type DocumentationState = {
  root: string; version: 2; paths: string[]; surfaces: DocumentationSurface[];
  coreDomains: string[]; ownersByPath: Map<string, DocumentationOwner>;
};
export type MarkdownHeading = { title: string; anchor: string; level: number; start: number; end: number };

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
export function assertDocumentationPath(path: string): void {
  const control = [...path].some((character) => character.codePointAt(0)! < 32 || character.codePointAt(0) === 127);
  if (!path || path.includes("\\") || control || path.startsWith("/") || path === "." || path === ".." || path.startsWith("../") || posix.normalize(path) !== path)
    throw new Error(`documentation: invalid repository-relative path ${JSON.stringify(path)}`);
}

export function matchesDocumentationSelector(path: string, selector: string): boolean {
  const expression = selector.split(/(\*\*|\*)/u).map((part) => part === "**" ? ".*" : part === "*" ? "[^/]*" : part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("");
  return new RegExp(`^${expression}$`, "u").test(path);
}

function selectorSpecificity(selector: string): number {
  return selector.replace(/\*/gu, "").length * 4 + (selector.includes("*") ? 0 : 2) + (selector.includes("**") ? 0 : 1);
}

export function parseDocumentationRouting(source: string): DocumentationSurface[] {
  const value: unknown = JSON.parse(source);
  if (!object(value) || value.version !== 2 || !Array.isArray(value.surfaces) || value.surfaces.length === 0 || Object.keys(value).some((key) => !["version", "surfaces"].includes(key)))
    throw new Error(`${DOCUMENTATION_ROUTING_PATH}: expected version 2 and nonempty surfaces`);
  const ids = new Set<string>();
  return value.surfaces.map((raw, index) => {
    if (!object(raw) || Object.keys(raw).some((key) => !["id", "when", "paths", "doc", "anchor"].includes(key)) || typeof raw.id !== "string" || !/^[a-z][a-z0-9-]*$/u.test(raw.id) || ids.has(raw.id)
      || typeof raw.when !== "string" || !raw.when.trim() || !Array.isArray(raw.paths) || raw.paths.length === 0 || raw.paths.some((path) => typeof path !== "string")
      || typeof raw.doc !== "string" || !raw.doc.endsWith(".md") || typeof raw.anchor !== "string" || (raw.anchor !== "" && !/^#[\p{L}\p{N}\p{M}_-]+$/u.test(raw.anchor)))
      throw new Error(`${DOCUMENTATION_ROUTING_PATH}: malformed or duplicate surface ${index}`);
    ids.add(raw.id);
    assertDocumentationPath(raw.doc);
    const paths = raw.paths as string[];
    if (new Set(paths).size !== paths.length) throw new Error(`${DOCUMENTATION_ROUTING_PATH}: duplicate selector in ${raw.id}`);
    for (const selector of paths) {
      assertDocumentationPath(selector);
      if (/[?{}!]/u.test(selector) || /\*{3}|[^/]\*\*|\*\*[^/]/u.test(selector)) throw new Error(`${DOCUMENTATION_ROUTING_PATH}: unsupported selector ${selector}`);
    }
    return { id: raw.id, when: raw.when, paths, doc: raw.doc, anchor: raw.anchor };
  });
}

export function resolveDocumentationOwner(state: Pick<DocumentationState, "surfaces">, path: string): DocumentationOwner {
  assertDocumentationPath(path);
  const matches = state.surfaces.flatMap((surface) => surface.paths.filter((selector) => matchesDocumentationSelector(path, selector)).map((selector) => ({ surface, rank: selectorSpecificity(selector) })));
  const rank = Math.max(...matches.map((match) => match.rank));
  const strongest = matches.filter((match) => match.rank === rank);
  if (strongest.length === 0) throw new Error(`documentation: unknown path ${path}`);
  const owners = new Set(strongest.map(({ surface }) => `${surface.doc}${surface.anchor}`));
  if (owners.size !== 1) throw new Error(`documentation: conflicting equally specific owners for ${path}: ${strongest.map(({ surface }) => surface.id).join(", ")}`);
  const surface = strongest.map(({ surface }) => surface).sort((left, right) => left.id.localeCompare(right.id))[0]!;
  return { ...surface, unit: surface.id };
}
export const resolveOwner = resolveDocumentationOwner;

/** Remove fenced examples before reading structural headings, links or review comments. */
export function unfencedMarkdown(markdown: string): string {
  let fence: { character: string; length: number } | null = null;
  return markdown.split("\n").map((line) => {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line); const marker = match?.[1];
    if (!fence && marker) {
      fence = { character: marker[0]!, length: marker.length }; return " ".repeat(line.length);
    }
    if (fence) {
      if (marker && marker[0] === fence.character && marker.length >= fence.length && !match![2]!.trim()) fence = null;
      return " ".repeat(line.length);
    }
    return line;
  }).join("\n");
}

export function markdownHeadings(markdown: string): MarkdownHeading[] {
  const seen = new Map<string, number>();
  const headings: MarkdownHeading[] = [];
  // Slice positions are UTF-16 offsets: preserve code units, including surrogate pairs.
  const structural = unfencedMarkdown(markdown).replace(/<!--[\s\S]*?-->/gu, (comment) => comment.replace(/[^\n]/g, " "));
  for (const match of structural.matchAll(/^ {0,3}(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/gmu)) {
    const title = match[2]!;
    const slug = title.toLowerCase().replace(/!?\[([^\]]*)\]\([^)]*\)/gu, "$1").replace(/<[^>]*>/gu, "").replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, "").replace(/\s/gu, "-");
    const duplicate = seen.get(slug) ?? 0; seen.set(slug, duplicate + 1);
    headings.push({ title, anchor: `#${slug}${duplicate ? `-${duplicate}` : ""}`, level: match[1]!.length, start: match.index!, end: markdown.length });
  }
  for (let index = 0; index < headings.length; index++) {
    const next = headings.slice(index + 1).find((heading) => heading.level <= headings[index]!.level);
    if (next) headings[index]!.end = next.start;
  }
  return headings;
}

export function documentationSection(markdown: string, anchor: string): string {
  if (anchor === "") return markdown;
  const heading = markdownHeadings(markdown).find((candidate) => candidate.anchor === anchor);
  if (!heading) throw new Error(`documentation: missing owner anchor ${anchor}`);
  return markdown.slice(heading.start, heading.end);
}

/** Review metadata and generated projections cannot discharge a source obligation. */
export function normalizeDocumentation(markdown: string, options: { includeGenerated?: boolean } = {}): string {
  const withoutGenerated = options.includeGenerated ? markdown : markdown.replace(/<!--\s*openlup-generated(?::|\s+)start(?:\s+[^>]*)?\s*-->[\s\S]*?<!--\s*openlup-generated(?::|\s+)end\s*-->/giu, "");
  return withoutGenerated.replace(/<!--[\s\S]*?-->/gu, "")
    .replace(/^(?:\*\*)?[\p{L}][\p{L}\p{N} _-]*(?:\*\*)?:[ \t]*\d{4}-\d{2}-\d{2}(?:[T ][0-9:.+Z-]+)?(?: UTC)?[ \t]*$/gmiu, "")
    .replace(/^(?:Source commit|Source digest|Source revision|Content digest|Tree digest|Generated from|Provenance):[^\n]*$/gmiu, "")
    .replace(/\s+/gu, " ").trim();
}

export function classifyDocumentationPath(path: string): "documentation" | "historical" | "generated" | "test" | "asset" | "source" {
  if (/\.md$/iu.test(path) && (/^docs\/(?:history|archive)\//u.test(path) || /^docs\/platform\/plans\//u.test(path))) return "historical";
  if (["config/openlup-publication-catalog.json", "config/openlup-source-release-contract.json", "docs/platform/SOURCE_MAP.md"].includes(path)) return "generated";
  if (/\.md$/iu.test(path)) return "documentation";
  if (/(?:\.test\.|\.spec\.|(?:^|\/)(?:tests?|__tests__)\/)/u.test(path)) return "test";
  if (/\.(?:svg|png|jpe?g|gif|webp|ico|woff2?|ttf|mp[34]|wav)$/iu.test(path)) return "asset";
  return "source";
}

function readCoreDomains(root: string): string[] {
  const source = readFileSync(join(root, "src/lib/coreDomains.ts"), "utf8");
  const literal = /export const CORE_DOMAINS = Object\.freeze\(\[([\s\S]*?)\]\s+as const\);/u.exec(source)?.[1];
  if (!literal || literal.replace(/"[a-z][a-z0-9-]*"|[\s,]/gu, "") !== "") throw new Error("documentation: CORE_DOMAINS must remain a readable literal array");
  const domains = [...literal.matchAll(/"([a-z][a-z0-9-]*)"/gu)].map((match) => match[1]!);
  if (domains.length === 0 || new Set(domains).size !== domains.length) throw new Error("documentation: CORE_DOMAINS is empty or duplicate");
  return domains;
}

export function assertMaterializedDocumentationPath(root: string, path: string): void {
  assertDocumentationPath(path);
  const parts = path.split("/");
  for (let index = 1; index <= parts.length; index++) {
    if (lstatSync(join(root, ...parts.slice(0, index))).isSymbolicLink()) throw new Error(`documentation: symlink objects are refused: ${path}`);
  }
  if (!lstatSync(join(root, path)).isFile()) throw new Error(`documentation: expected a materialized file: ${path}`);
}

export function documentationCandidatePaths(root: string): string[] {
  const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\0").filter(Boolean);
  return [...new Set([...git(["ls-files", "-z"]), ...git(["ls-files", "-z", "--others", "--exclude-standard"])])].filter((path) => {
    try { lstatSync(join(root, path)); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  }).sort();
}

export function assertDocumentationNavigation(state: DocumentationState): void {
  const { root, paths, surfaces } = state;
  const available = new Set(paths);
  const pending = ["README.md", "CONTRIBUTING.md", "docs/platform/README.md"].filter((path) => available.has(path));
  const reached = new Set<string>();
  while (pending.length > 0) {
    const page = pending.pop()!;
    if (reached.has(page)) continue;
    reached.add(page);
    const markdown = unfencedMarkdown(readFileSync(join(root, page), "utf8")).replace(/<!--[\s\S]*?-->/gu, "");
    for (const match of markdown.matchAll(/\]\(([^)\s]+)(?:\s+[^)]*)?\)/gu)) {
      const target = match[1]!.replace(/^<|>$/gu, "").split(/[?#]/u)[0]!;
      if (!target || /^(?:[a-z][a-z0-9+.-]*:|\/)/iu.test(target)) continue;
      const normalized = posix.normalize(posix.join(posix.dirname(page), target));
      if (normalized.endsWith(".md") && available.has(normalized)) pending.push(normalized);
    }
  }
  for (const surface of surfaces) if (!reached.has(surface.doc)) throw new Error(`documentation: unreachable owner ${surface.doc} for ${surface.id}`);
}

export function readDocumentationState(root: string, candidatePaths?: Iterable<string>): DocumentationState {
  const paths = [...new Set(candidatePaths ?? documentationCandidatePaths(root))].sort();
  for (const path of paths) assertMaterializedDocumentationPath(root, path);
  const surfaces = parseDocumentationRouting(readFileSync(join(root, DOCUMENTATION_ROUTING_PATH), "utf8"));
  const coreDomains = readCoreDomains(root);
  const state: DocumentationState = { root, version: 2, paths, surfaces, coreDomains, ownersByPath: new Map() };
  const available = new Set(paths);
  for (const surface of surfaces) {
    if (!available.has(surface.doc)) throw new Error(`documentation: missing owner ${surface.doc} for ${surface.id}`);
    documentationSection(readFileSync(join(root, surface.doc), "utf8"), surface.anchor);
    for (const selector of surface.paths) if (!paths.some((path) => matchesDocumentationSelector(path, selector))) throw new Error(`documentation: dead selector ${selector} in ${surface.id}`);
  }
  for (const domain of coreDomains) {
    if (!surfaces.some((surface) => surface.paths.some((selector) => selector === `src/domains/${domain}/**` || selector === `server/domains/${domain}/**`)))
      throw new Error(`documentation: registered domain ${domain} needs an explicit route`);
  }
  for (const path of paths) {
    const domain = /^(?:src|server)\/domains\/([^/]+)\//u.exec(path)?.[1];
    if (domain && !coreDomains.includes(domain)) throw new Error(`documentation: unregistered domain ${domain}: ${path}`);
    state.ownersByPath.set(path, resolveDocumentationOwner(state, path));
  }
  return state;
}
