/**
 * Governing document: docs/platform/DEVELOPMENT_AND_RELEASE.md, "Releasing a package".
 * Lists documentation affected since the previous core tag without writing any files.
 * Set preparation also uses the assembler before it writes files or consumes fragments.
 */
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { documentationGit, documentationLinkTargets, parseDocumentationRouting, resolveDocumentationOwner, type DocumentationOwner } from "../documentation-routing.ts";
// eslint-disable-next-line no-restricted-imports -- bare Node 24 self-check runs before workspace install and reuses core's owning release-note audit
import { assertReleaseNotePackagedContent, documentedAdapters, findReleaseNotePackagedContentViolations } from "../../packages/core/scripts/core-package-consumer-audit.ts";
// eslint-disable-next-line no-restricted-imports -- bare Node 24 self-check reuses Core's reader-guide Markdown rules in-process
import { assertGuidePage, assertPackageMarkdown, guideAllowListPath, pinGuideReleaseLinks, readGuideAllowList, type GuidePageFix } from "../../packages/core/scripts/documentation-guide-content.ts";
// eslint-disable-next-line no-restricted-imports -- match the Core contract's npm pack inventory without loading its compiler
import { packDryRun } from "../../packages/core/scripts/release-npm-checks.ts";
import { isChangelogFragment, parseChangelogFragment, readChangelogFragments, validateChangelogFragment, type ChangelogFragment } from "./changelog-fragments.ts";
import { PACKAGES_CONFIG_PATH, RELEASE_VERSION, parsePackagesConfig, releaseVersionAbove } from "./package-manifest-policy.ts";
export { assertReleaseNotePackagedContent, documentedAdapters, findReleaseNotePackagedContentViolations };

const GUIDE = "packages/core/docs/guide";
const API_REPORT = /^packages\/[^/]+\/api\/[^/]+\.api\.md$/u;
export type ReleaseChange = { status: string; path: string; previousPath?: string };
export type ReleaseDocumentationChange = ReleaseChange & { owner: DocumentationOwner | null; previousOwner?: DocumentationOwner | null; guidePages: string[] };
export type WebsiteReference = { file: string; line: number; reference: string; status: string };
export type ReleaseDocumentationListing = { since: string | null; changes: ReleaseDocumentationChange[]; websiteReferences: WebsiteReference[]; websiteChecked: boolean; warnings: string[] };
type GuidePlan = { writes: Array<[string, string]>; violations: string[]; pageViolations: Record<string, string[]> };

/** Use core's owning CLI rather than importing a workspace-private helper. */
export function planReleaseGuide(root: string, version: string, pending: Record<string, string> = {}): GuidePlan {
  const helper = fileURLToPath(new URL("../../packages/core/scripts/documentation-contract.ts", import.meta.url));
  try {
    return JSON.parse(execFileSync(process.execPath, ["--experimental-strip-types", helper, "--plan-guide", version, resolve(root)], {
      cwd: root, encoding: "utf8", input: JSON.stringify(pending), stdio: ["pipe", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024,
    })) as GuidePlan;
  } catch (error) {
    const stderr = (error as { stderr?: Buffer | string }).stderr?.toString().trim();
    throw new Error(stderr || String(error), { cause: error });
  }
}

/** Publication-safe filename; headings retain the actual release version. */
export const upgradePagePath = (version: string): string => `${GUIDE}/upgrade/v${version.replace(/[^A-Za-z0-9]/gu, "-")}.md`;

/** NUL-delimited name-status output retains both sides of a rename and literal filenames. */
export function parseReleaseChanges(output: string): ReleaseChange[] {
  const fields = output.split("\0");
  const changes: ReleaseChange[] = [];
  for (let index = 0; index < fields.length && fields[index];) {
    const status = fields[index++]!;
    const first = fields[index++]!;
    if (/^[RC]/u.test(status)) changes.push({ status, previousPath: first, path: fields[index++]! });
    else changes.push({ status, path: first });
  }
  return changes;
}

export function previousCoreTag(root: string): string | undefined {
  if (!documentationGit(root, ["tag", "--merged", "HEAD", "--list", "openlup-core-v*"]).toString("utf8").trim()) return undefined;
  return documentationGit(root, ["describe", "--tags", "--abbrev=0", "--match", "openlup-core-v*", "HEAD"]).toString("utf8").trim();
}

function resolveCommitRef(root: string, ref: string): string {
  return documentationGit(root, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]).toString("utf8").trim();
}

function releaseChanges(root: string, since: string, targetRef = "HEAD"): ReleaseChange[] {
  const base = resolveCommitRef(root, since);
  const head = resolveCommitRef(root, targetRef);
  return parseReleaseChanges(documentationGit(root, ["diff", "--name-status", "-z", "--find-renames", "--no-ext-diff", "--no-textconv", base, head, "--"]).toString("utf8"));
}

const changedPaths = (change: ReleaseChange): string[] => change.previousPath ? [change.previousPath, change.path] : [change.path];
const listedPath = (path: string): boolean => API_REPORT.test(path) || path === "config/openlup-publication-catalog.json"
  || (/^docs\/platform\/.*\.md$/u.test(path) && !path.startsWith("docs/platform/plans/"))
  || /^\.github\/[^/]+\.md$/u.test(path) || /^packages\/[^/]+\/(?:README|AGENTS)\.md$/u.test(path)
  || /^(?:src|server)\/(?:.+\/)?README\.md$/u.test(path) || /^deploy\/[^/]+\/README\.md$/u.test(path)
  || ["AGENTS.md", "README.md", "CONTRIBUTING.md"].includes(path);

/** Walk regular files only; a supplied website checkout is never mutated or followed through links. */
function textFiles(root: string, area: string): string[] {
  if (!existsSync(join(root, area))) return [];
  if (!lstatSync(join(root, area)).isDirectory()) throw new Error(`${area}: expected a directory, not a link or file`);
  return readdirSync(join(root, area), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
    const path = `${area}/${entry.name}`;
    return entry.isDirectory() ? textFiles(root, path) : entry.isFile() ? [path] : [];
  });
}

/** Report each occurrence, including old rename targets; unchanged source references are omitted. */
export function findWebsiteReferences(file: string, source: string, changes: readonly ReleaseChange[]): WebsiteReference[] {
  const statuses = new Map(changes.flatMap((change) => changedPaths(change).map((path) => [path, change.status] as const)));
  return source.split(/\r?\n/u).flatMap((line, index) => [...line.matchAll(/\boss:([\w./@+-]+?)(?=[:\s`"'<>()[\]{},;!?]|$)(?::L?\d+(?:-L?\d+)?)?/gu)].flatMap((match) => {
    const status = statuses.get(match[1]!);
    return status ? [{ file, line: index + 1, reference: match[0], status }] : [];
  }));
}

function guideLinkPath(page: string, target: string): string | undefined {
  const repository = /^https:\/\/github\.com\/openlup\/openlup\/(?:blob|tree)\/[^/]+\/(.*)$/u.exec(target)?.[1];
  if (!repository && /^(?:[a-z][a-z0-9+.-]*:|\/|#)/iu.test(target)) return undefined;
  try { return repository ? decodeURIComponent(repository.split(/[?#]/u)[0]!) : posix.normalize(posix.join(posix.dirname(page), decodeURIComponent(target.split(/[?#]/u)[0]!))); }
  catch { return undefined; }
}

/** Git errors refuse; incomplete documentation/website evidence remains advisory. */
export function listReleaseDocumentation({ root, since = previousCoreTag(root), website }: { root: string; since?: string; website?: string }): ReleaseDocumentationListing {
  const changes = since ? releaseChanges(root, since) : [];
  const warnings: string[] = [];
  const warn = (error: unknown) => { warnings.push(error instanceof Error ? error.message : String(error)); };
  let surfaces: ReturnType<typeof parseDocumentationRouting> = [];
  try { surfaces = parseDocumentationRouting(readFileSync(join(root, "config/doc-routing.json"), "utf8")); } catch (error) { warn(error); }
  const ownerOf = (path: string): DocumentationOwner | null => {
    try { return resolveDocumentationOwner({ surfaces }, path); } catch (error) { warn(error); return null; }
  };
  const guides: Array<{ path: string; owner: DocumentationOwner | null; links: Array<string | undefined> }> = [];
  try {
    for (const path of textFiles(root, GUIDE).filter((path) => path.endsWith(".md"))) guides.push({ path, owner: ownerOf(path), links: documentationLinkTargets(readFileSync(join(root, path), "utf8")).map((target) => guideLinkPath(path, target)) });
  } catch (error) { warn(error); }
  const listed = changes.filter((change) => changedPaths(change).some(listedPath)).map((change) => {
    const owner = ownerOf(change.path);
    const previousOwner = change.previousPath ? ownerOf(change.previousPath) : undefined;
    const owners = [owner, previousOwner].filter((value): value is DocumentationOwner => value != null);
    const targets = new Set([...changedPaths(change), ...owners.map(({ doc }) => doc)]);
    const guidePages = guides.filter((guide) => targets.has(guide.path) || guide.links.some((target) => target !== undefined && targets.has(target))
      || owners.some((candidate) => guide.owner?.doc === candidate.doc && guide.owner.anchor === candidate.anchor)).map(({ path }) => path);
    return { ...change, owner, ...(change.previousPath ? { previousOwner } : {}), guidePages };
  });
  const websiteReferences: WebsiteReference[] = [];
  let websiteChecked = false;
  if (website) {
    try {
      if (!existsSync(website)) throw new Error(`website checkout does not exist: ${website}`);
      for (const area of ["docs/claims", "src/content"]) for (const file of textFiles(website, area)) {
        const bytes = readFileSync(join(website, file));
        if (bytes.includes(0)) continue;
        let source: string;
        try { source = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { continue; }
        websiteReferences.push(...findWebsiteReferences(file, source, changes));
      }
      websiteChecked = true;
    } catch (error) { warn(error); }
  }
  return { since: since ?? null, changes: listed, websiteReferences, websiteChecked, warnings: [...new Set(warnings)] };
}

type Declaration = {
  first: string;
  text: string;
  symbol?: string;
  exported: boolean;
  deprecated: boolean;
};

export type SemanticApiDiff = {
  added: string[];
  removed: string[];
  changed: string[];
  symbolsAdded: string[];
  symbolsRemoved: string[];
  symbolsDeprecated: string[];
};

export type ApiSurfaceSummary = {
  subpathsAdded: string[];
  subpathsRemoved: string[];
  symbolsAdded: string[];
  symbolsRemoved: string[];
  symbolsDeprecated: string[];
};

export type SettingsDelta = {
  added: string[];
  removed: string[];
  changed: string[];
};

export const STARTER_SECTION_HEADING = "### Starter application (examples/neutral-store)";
export const UPGRADE_STARTER_SECTION_HEADING = "## Starter application (examples/neutral-store)";
const ADDED_SYMBOLS_INLINE_LIMIT = 10;

function hasDeprecatedTag(leading: readonly string[]): boolean {
  const commentText = leading.join("\n");
  const jsdocBlocks = [...commentText.matchAll(/\/\*\*(?!\/)[\s\S]*?\*\//gu)];
  const last = jsdocBlocks.at(-1)?.[0];
  if (!last) return false;
  const inner = last.slice(3, -2);
  return /(?:^|[\r\n][ \t]*(?:\*[ \t]*)?|[ \t])@deprecated(?=$|[^A-Za-z0-9_$-])/u.test(inner);
}

/** Extract the exported symbol identifier from a single declaration or per-specifier export line. */
export function extractDeclarationSymbolName(line: string): string | undefined {
  const trimmed = line.replace(/^(?:[\t\n\r ]+|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*)*/u, "").trim();
  const exportList = /^export\s+(?:type\s+)?\{\s*(?:type\s+)?([A-Za-z_$][A-Za-z0-9_$]*)(?:\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*))?\s*\}/u.exec(trimmed);
  if (exportList) return exportList[2] ?? exportList[1];
  const exportNs = /^export\s+(?:type\s+)?\*\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/u.exec(trimmed);
  if (exportNs) return exportNs[1];
  const decl = /^export\s+(?:declare\s+)?(?:default\s+)?(?:abstract\s+|async\s+)?(?:const\s+(?=enum\s))?(?:const|let|var|function|class|interface|type|enum|namespace|module)\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/u.exec(trimmed);
  return decl?.[1];
}

function expandExportListBlock(codeLines: readonly string[], blockLeading: readonly string[], deprecated: boolean): Array<{ key: string; entry: Declaration }> | null {
  const joined = codeLines.map((line) => line.trim()).filter(Boolean).join("\n");
  const list = /^export\s+(type\s+)?\{([^{}]*)\}(?:\s*from\s*("[^"]*"|'[^']*'))?\s*;?/u.exec(joined);
  if (!list) return null;
  if (joined.slice(list[0].length).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/gu, "").trim() !== "") return null;
  const isTypeExport = Boolean(list[1]);
  const rawBody = list[2]!.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/gu, "");
  const specifiers = rawBody.split(",").map((spec) => spec.replace(/\s+/gu, " ").trim()).filter(Boolean);
  if (specifiers.length === 0) return null;
  const fromClause = list[3] ? ` from ${list[3]}` : "";
  const leadingLines = blockLeading.map((line) => line.trimEnd());
  return specifiers.map((spec) => {
    const isTypeSpec = isTypeExport || /^type\s+/u.test(spec);
    const withoutType = spec.replace(/^type\s+/u, "");
    const asMatch = /^([A-Za-z_$][A-Za-z0-9_$]*)\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)$/u.exec(withoutType);
    const symbol = asMatch ? asMatch[2]! : /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(withoutType) ? withoutType : undefined;
    const normalized = `export ${isTypeExport ? "type " : ""}{ ${spec} }${fromClause};`;
    const text = leadingLines.length ? [...leadingLines, normalized].join("\n").trimEnd() : normalized;
    return {
      key: symbol ? `${isTypeSpec ? "export-type" : "export"} ${symbol}` : normalized,
      entry: { first: normalized, text, symbol, exported: true, deprecated },
    };
  });
}

/** Compare complete top-level declaration blocks inside one declaration file or unheaded report. */
function apiDeclarations(source: string) {
  const blocks = new Map<string, Declaration[]>();
  let fence = false, typescript = false;
  let blockLeading: string[] = [], blockCode: string[] = [], leading: string[] = [];
  let first = "", key = "", symbol: string | undefined, exported = false;
  const push = (entryKey: string, entry: Declaration) => {
    const family = blocks.get(entryKey) ?? [];
    family.push(entry);
    blocks.set(entryKey, family);
  };
  const finish = () => {
    if (!blockCode.length) return;
    const deprecated = hasDeprecatedTag(blockLeading);
    if (/^export\s+(?:type\s+)?\{/u.test(first)) {
      const expanded = expandExportListBlock(blockCode, blockLeading, deprecated);
      if (expanded) {
        for (const item of expanded) push(item.key, item.entry);
        blockLeading = [];
        blockCode = [];
        return;
      }
    }
    const text = [...blockLeading, ...blockCode].map((line) => line.trimEnd()).join("\n").trimEnd();
    push(key, { first, text, symbol, exported, deprecated });
    blockLeading = [];
    blockCode = [];
  };
  for (const line of source.split(/\r?\n/u)) {
    if (line.startsWith("```")) {
      finish();
      leading = [];
      typescript = !fence && /^```ts(?:\s.*)?$/u.test(line);
      fence = !fence;
    } else if (typescript) {
      const declaration = /^(?:(export)\s+)?(?:declare\s+)?(?:default\s+)?(?:abstract\s+|async\s+)?(?:const\s+(?=enum\s))?(const|let|var|function|class|interface|type|enum|namespace|module)\b(?:\s+([\w$]+|"[^"]+"|'[^']+'))?/u.exec(line);
      const exportListOrStar = /^export\s+(?:\*|\{|type\s+(?:\*|\{))/u.test(line);
      if (declaration || exportListOrStar) {
        finish();
        first = line.trimEnd();
        exported = Boolean(declaration?.[1]) || exportListOrStar;
        if (declaration?.[2] && declaration[3]) {
          const kind = declaration[2];
          const rawName = declaration[3];
          // Group `type` and `interface` under one namespace key so converting between them is a change, not a false removal.
          const normalizedKind = kind === "interface" ? "type" : kind;
          key = `${normalizedKind} ${rawName}`;
          symbol = exported && /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(rawName) ? rawName : undefined;
        } else {
          const nsMatch = /^export\s+(?:type\s+)?\*\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/u.exec(first);
          symbol = nsMatch?.[1];
          key = symbol ? `export-ns ${symbol}` : first;
        }
        blockLeading = leading;
        blockCode = [line];
        leading = [];
      } else if (/^(?:\/\/|\/\*\*| \*)/u.test(line)) leading.push(line);
      else if (/^import\b/u.test(line)) leading = [];
      else {
        if (blockCode.length) blockCode.push(...leading, line);
        leading = [];
      }
    }
  }
  finish();
  return blocks;
}

function unmatchedDeclarationEntries(blocks: Declaration[], opposite: Declaration[]): Declaration[] {
  const remaining = opposite.slice();
  return blocks.filter(({ text }) => {
    const match = remaining.findIndex((entry) => entry.text === text);
    if (match === -1) return true;
    remaining.splice(match, 1);
    return false;
  });
}

function exportedSymbols(blocks: ReadonlyMap<string, Declaration[]>): Set<string> {
  const symbols = new Set<string>();
  for (const family of blocks.values()) {
    for (const entry of family) {
      if (entry.exported && entry.symbol) symbols.add(entry.symbol);
    }
  }
  return symbols;
}

function exportedDeprecatedSymbols(blocks: ReadonlyMap<string, Declaration[]>): Set<string> {
  const deprecated = new Set<string>();
  for (const family of blocks.values()) {
    for (const entry of family) {
      if (entry.exported && entry.deprecated && entry.symbol) deprecated.add(entry.symbol);
    }
  }
  return deprecated;
}

export function summarizeSemanticApiDiff(before: string, after: string): SemanticApiDiff {
  const oldBlocks = apiDeclarations(before), newBlocks = apiDeclarations(after);
  type DiffItem = { display: string; symbol?: string; exported: boolean };
  const addedItems: DiffItem[] = [], removedItems: DiffItem[] = [], changedItems: DiffItem[] = [];
  for (const [key, current] of newBlocks) {
    const old = oldBlocks.get(key) ?? [];
    if (!old.length && current.length === 1) {
      const entry = current[0]!;
      addedItems.push({ display: entry.first, symbol: entry.symbol, exported: entry.exported });
    } else if (old.length === 1 && current.length === 1) {
      if (old[0]!.text !== current[0]!.text) {
        const entry = current[0]!;
        changedItems.push({ display: entry.first, symbol: entry.symbol, exported: entry.exported });
      }
    } else {
      const target = old.length ? changedItems : addedItems;
      for (const entry of unmatchedDeclarationEntries(current, old)) {
        target.push({ display: entry.text, symbol: entry.symbol, exported: entry.exported });
      }
    }
  }
  for (const [key, old] of oldBlocks) {
    const current = newBlocks.get(key) ?? [];
    if (old.length === 1 && !current.length) {
      const entry = old[0]!;
      removedItems.push({ display: entry.first, symbol: entry.symbol, exported: entry.exported });
    } else if (old.length > 1 || current.length > 1) {
      for (const entry of unmatchedDeclarationEntries(old, current)) {
        removedItems.push({ display: entry.text, symbol: entry.symbol, exported: entry.exported });
      }
    }
  }
  // If an exported symbol moved between a direct declaration and a re-export within the same file, classify it as changed rather than removed + added.
  const addedBySymbol = new Map<string, number[]>();
  for (let i = 0; i < addedItems.length; i++) {
    const item = addedItems[i]!;
    if (item.exported && item.symbol) addedBySymbol.set(item.symbol, [...(addedBySymbol.get(item.symbol) ?? []), i]);
  }
  const removedBySymbol = new Map<string, number[]>();
  for (let i = 0; i < removedItems.length; i++) {
    const item = removedItems[i]!;
    if (item.exported && item.symbol) removedBySymbol.set(item.symbol, [...(removedBySymbol.get(item.symbol) ?? []), i]);
  }
  const pairedAdded = new Set<number>(), pairedRemoved = new Set<number>();
  for (const [sym, remIndices] of removedBySymbol) {
    const addIndices = addedBySymbol.get(sym);
    if (remIndices.length === 1 && addIndices?.length === 1) {
      pairedRemoved.add(remIndices[0]!);
      pairedAdded.add(addIndices[0]!);
      changedItems.push(addedItems[addIndices[0]!]!);
    }
  }
  const finalAdded = addedItems.filter((_, index) => !pairedAdded.has(index));
  const finalRemoved = removedItems.filter((_, index) => !pairedRemoved.has(index));
  const beforeExported = exportedSymbols(oldBlocks);
  const afterExported = exportedSymbols(newBlocks);
  const beforeDeprecated = exportedDeprecatedSymbols(oldBlocks);
  const afterDeprecated = exportedDeprecatedSymbols(newBlocks);
  const symbolsDeprecated = [...afterDeprecated].filter((sym) => !beforeDeprecated.has(sym)).sort(bytewise);
  const symbolsAdded = [...afterExported].filter((sym) => !beforeExported.has(sym)).sort(bytewise);
  const symbolsRemoved = [...beforeExported].filter((sym) => !afterExported.has(sym)).sort(bytewise);
  return {
    added: finalAdded.map((item) => item.display),
    removed: finalRemoved.map((item) => item.display),
    changed: changedItems.map((item) => item.display),
    symbolsAdded,
    symbolsRemoved,
    symbolsDeprecated,
  };
}

export function summarizeApiDiff(before: string, after: string) {
  const { added, removed, changed } = summarizeSemanticApiDiff(before, after);
  return { added, removed, changed };
}

const GATES = /^packages\/[^/]+\/release-gates\.json$/u;
const bytewise = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const snapshotRecovery = (directory: string) =>
  `run \`npm run api:update -w ${directory}\`, commit the snapshot changes, then rerun release:bump.`;

function snapshotSections(source: string) {
  const unheaded: string[] = [], files: Array<{ path: string; lines: string[] }> = [];
  let lines = unheaded, fenced = false, typescript = false;
  for (const line of source.split("\n")) {
    const heading = !fenced && /^## (dist\/.+)$/u.exec(line.trimEnd());
    if (heading) {
      lines = [];
      files.push({ path: heading[1]!, lines });
    } else if (line.startsWith("```")) {
      if (!fenced) typescript = /^```ts(?:\s.*)?$/u.test(line.trimEnd());
      if (typescript) lines.push(fenced ? "```" : "```ts");
      fenced = !fenced;
    } else if (fenced && typescript) lines.push(line);
  }
  return { unheaded: unheaded.join("\n"), files };
}

function readApiSurface(root: string, ref: string, directory: string) {
  const commit = resolveCommitRef(root, ref);
  const gates = `${directory}/release-gates.json`;
  const paths = documentationGit(root, ["ls-tree", "-r", "-z", "--name-only", commit, "--", `${directory}/api`, gates]).toString("utf8").split("\0");
  const read = (path: string) => documentationGit(root, ["show", "--end-of-options", `${commit}:${path}`]).toString("utf8");
  const files = new Map<string, { body: string; report: string; carriers: Set<string>; conflicting: boolean }>();
  const unheaded = new Map<string, string>();
  for (const report of paths.filter((path) => API_REPORT.test(path)).sort(bytewise)) {
    const snapshot = snapshotSections(read(report));
    unheaded.set(report, snapshot.unheaded);
    for (const { path, lines } of snapshot.files) {
      const body = lines.join("\n");
      const entry = files.get(path) ?? { body, report, carriers: new Set<string>(), conflicting: false };
      entry.carriers.add(report);
      entry.conflicting ||= entry.body !== body;
      files.set(path, entry);
    }
  }
  const surface = paths.includes(gates) ? (JSON.parse(read(gates)) as { packageSurface?: Record<string, { snapshot: string }> }).packageSurface : undefined;
  const subpaths = new Map(Object.entries(surface ?? {}).map(([subpath, { snapshot }]) => [subpath, posix.join(directory, snapshot)]));
  const configured = new Set(subpaths.values());
  for (const [path, { carriers, conflicting }] of files) {
    if (!conflicting) continue;
    const reports = [...carriers];
    const stale = reports.filter((report) => !configured.has(report));
    const remedy = stale.length
      ? stale.map((report) => `${report} is not a configured snapshot of @openlup/${posix.basename(directory)}: delete it, ${snapshotRecovery(directory)}`).join(" ")
      : `regenerate the API snapshots: ${snapshotRecovery(directory)}`;
    throw new Error(`${directory}: ${reports.join(" and ")} have conflicting bodies for ${path} at ${ref}; ${remedy}`);
  }
  return { files, unheaded, subpaths };
}

const declarationLabels = { added: "Added", removed: "Removed", changed: "Changed" } as const;
type DeclarationCategory = keyof typeof declarationLabels;
type ApiRow = { category: DeclarationCategory; file: string; text: string };

const SQL_MIGRATION_PATH = /^(?:db\/platform\/migrations|packages\/outbox\/sql)\/[^/]+\.sql$/u;
const SETTINGS_CATALOG_PATH = "packages/platform/settings-catalog.json";

function readGitFileAtRef(root: string, ref: string, path: string): string | undefined {
  try {
    return documentationGit(root, ["show", "--end-of-options", `${ref}:${path}`]).toString("utf8");
  } catch {
    return undefined;
  }
}

function stableJsonString(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJsonString).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => bytewise(a, b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJsonString(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Added platform and outbox SQL migration files between `since` and `targetRef`. */
export function collectSqlDelta(root: string, since: string | undefined, targetRef = "HEAD"): string[] {
  if (!since) return [];
  const changes = releaseChanges(root, since, targetRef);
  return changes
    .filter(({ status, path }) => status === "A" && SQL_MIGRATION_PATH.test(path))
    .map(({ path }) => path)
    .sort(bytewise);
}

/** Added, removed and changed keys in `packages/platform/settings-catalog.json` between `since` and `targetRef`. */
export function collectSettingsDelta(root: string, since: string | undefined, targetRef = "HEAD"): SettingsDelta {
  if (!since) return { added: [], removed: [], changed: [] };
  const base = resolveCommitRef(root, since);
  const head = resolveCommitRef(root, targetRef);
  const parseCatalog = (source: string | undefined): Map<string, string> => {
    if (!source) return new Map();
    const parsed = JSON.parse(source) as { entries?: Array<{ key?: unknown }> };
    const map = new Map<string, string>();
    for (const entry of parsed.entries ?? []) {
      if (entry && typeof entry.key === "string") map.set(entry.key, stableJsonString(entry));
    }
    return map;
  };
  const before = parseCatalog(readGitFileAtRef(root, base, SETTINGS_CATALOG_PATH));
  const after = parseCatalog(readGitFileAtRef(root, head, SETTINGS_CATALOG_PATH));
  const added = [...after.keys()].filter((key) => !before.has(key)).sort(bytewise);
  const removed = [...before.keys()].filter((key) => !after.has(key)).sort(bytewise);
  const changed = [...after.keys()].filter((key) => before.has(key) && before.get(key) !== after.get(key)).sort(bytewise);
  return { added, removed, changed };
}

function packageNameForDirectory(root: string, directory: string): string {
  const manifestPath = join(root, directory, "package.json");
  if (existsSync(manifestPath)) {
    try {
      const name = (JSON.parse(readFileSync(manifestPath, "utf8")) as { name?: unknown }).name;
      if (typeof name === "string" && name) return name;
    } catch { /* fall through */ }
  }
  return `@openlup/${posix.basename(directory)}`;
}

function qualifySubpath(packageName: string, subpath: string): string {
  if (subpath === ".") return packageName;
  return subpath.startsWith("./") ? `${packageName}/${subpath.slice(2)}` : `${packageName}/${subpath}`;
}

function collectSurfaceSymbols(surface: ReturnType<typeof readApiSurface>): { exported: Set<string>; deprecated: Set<string> } {
  const exported = new Set<string>();
  const deprecated = new Set<string>();
  const addBlocks = (source: string) => {
    if (!source) return;
    for (const family of apiDeclarations(source).values()) {
      for (const entry of family) {
        if (!entry.exported || !entry.symbol) continue;
        exported.add(entry.symbol);
        if (entry.deprecated) deprecated.add(entry.symbol);
      }
    }
  };
  for (const { body } of surface.files.values()) addBlocks(body);
  for (const body of surface.unheaded.values()) addBlocks(body);
  return { exported, deprecated };
}

/** Collect semantic API surface summary across all changed packages between `since` and `targetRef`. */
export function collectApiSurfaceSummary(root: string, since: string | undefined, targetRef = "HEAD"): ApiSurfaceSummary {
  if (!since) return { subpathsAdded: [], subpathsRemoved: [], symbolsAdded: [], symbolsRemoved: [], symbolsDeprecated: [] };
  const base = resolveCommitRef(root, since);
  const head = resolveCommitRef(root, targetRef);
  const changes = releaseChanges(root, base, head);
  const paths = changes.flatMap(changedPaths);
  const directories = [...new Set(paths.filter((path) => API_REPORT.test(path) || GATES.test(path)).map((path) => path.split("/").slice(0, 2).join("/")))].sort(bytewise);
  const subpathsAdded = new Set<string>();
  const subpathsRemoved = new Set<string>();
  const symbolsAdded = new Set<string>();
  const symbolsRemoved = new Set<string>();
  const symbolsDeprecated = new Set<string>();
  for (const directory of directories) {
    const before = readApiSurface(root, base, directory);
    const after = readApiSurface(root, head, directory);
    const pkgName = packageNameForDirectory(root, directory);
    for (const subpath of after.subpaths.keys()) if (!before.subpaths.has(subpath)) subpathsAdded.add(qualifySubpath(pkgName, subpath));
    for (const subpath of before.subpaths.keys()) if (!after.subpaths.has(subpath)) subpathsRemoved.add(qualifySubpath(pkgName, subpath));
    const beforeSurface = collectSurfaceSymbols(before);
    const afterSurface = collectSurfaceSymbols(after);
    for (const sym of afterSurface.exported) {
      if (!beforeSurface.exported.has(sym)) symbolsAdded.add(sym);
    }
    for (const sym of beforeSurface.exported) {
      if (!afterSurface.exported.has(sym)) symbolsRemoved.add(sym);
    }
    for (const sym of afterSurface.deprecated) {
      if (!beforeSurface.deprecated.has(sym)) symbolsDeprecated.add(sym);
    }
  }
  return {
    subpathsAdded: [...subpathsAdded].sort(bytewise),
    subpathsRemoved: [...subpathsRemoved].sort(bytewise),
    symbolsAdded: [...symbolsAdded].sort(bytewise),
    symbolsRemoved: [...symbolsRemoved].sort(bytewise),
    symbolsDeprecated: [...symbolsDeprecated].sort(bytewise),
  };
}

function formatAddedDeclarationsSummary(categoryRows: readonly ApiRow[]): string {
  const symbols: string[] = [];
  const seenSymbols = new Set<string>();
  for (const { text } of categoryRows) {
    const name = extractDeclarationSymbolName(text);
    if (name && !seenSymbols.has(name)) {
      seenSymbols.add(name);
      symbols.push(name);
    }
  }
  if (symbols.length === 0) {
    return `Added declarations: ${categoryRows.length} (see \`meta/release-index.json\`).`;
  }
  const listed = symbols.slice(0, ADDED_SYMBOLS_INLINE_LIMIT).map((name) => `\`${name}\``).join(", ");
  const overflow = symbols.length > ADDED_SYMBOLS_INLINE_LIMIT ? `, and ${symbols.length - ADDED_SYMBOLS_INLINE_LIMIT} more` : "";
  return `Added declarations (${categoryRows.length}): ${listed}${overflow} (see \`meta/release-index.json\`).`;
}

function apiSections(root: string, since: string): string[] {
  const changes = releaseChanges(root, since);
  const paths = changes.flatMap(changedPaths);
  const directories = new Set(paths.filter((path) => API_REPORT.test(path) || GATES.test(path)).map((path) => path.split("/").slice(0, 2).join("/")));
  const sections: string[] = [];
  let listedDeclarations = false, noticedSubpath = false;
  for (const directory of directories) {
    const before = readApiSurface(root, since, directory), after = readApiSurface(root, "HEAD", directory);
    const reports = new Map<string, { rows: ApiRow[]; notices: string[] }>();
    const section = (report: string) => {
      const value = reports.get(report) ?? { rows: [], notices: [] };
      reports.set(report, value);
      return value;
    };
    const compare = (file: string, oldText: string, newText: string, oldReport: string, newReport: string) => {
      if (oldText === newText) return;
      const { added, removed, changed } = summarizeApiDiff(oldText, newText);
      for (const [category, rows, report] of [["added", added, newReport], ["removed", removed, oldReport], ["changed", changed, newReport]] as const) {
        if (rows.length) section(report).rows.push(...rows.map((text) => ({ category, file, text })));
      }
    };
    for (const file of new Set([...before.files.keys(), ...after.files.keys()])) {
      const old = before.files.get(file), current = after.files.get(file);
      compare(file, old?.body ?? "", current?.body ?? "", old?.report ?? "", current?.report ?? "");
    }
    for (const { status, path, previousPath } of changes) {
      const oldReport = previousPath ?? path;
      const old = status === "A" ? "" : before.unheaded.get(oldReport) ?? "";
      const current = status === "D" ? "" : after.unheaded.get(path) ?? "";
      compare("", old, current, oldReport, path);
    }
    for (const [label, from, to] of [["Added", after.subpaths, before.subpaths], ["Removed", before.subpaths, after.subpaths]] as const) {
      for (const [subpath, report] of from) if (!to.has(subpath)) section(report).notices.push(`${label} package subpath \`${subpath}\`.`);
    }
    for (const [report, { rows, notices }] of [...reports].sort(([a], [b]) => bytewise(a, b))) {
      listedDeclarations ||= rows.length > 0;
      noticedSubpath ||= notices.length > 0;
      sections.push(`### \`${report}\``, ...notices);
      const qualify = new Set(rows.map(({ file }) => file)).size > 1;
      const seen = new Set<string>();
      for (const [category, label] of Object.entries(declarationLabels)) {
        const categoryRows = rows.filter((row) => row.category === category);
        const excerpts: string[] = [];
        let previousFile: string | undefined;
        for (const { file, text } of categoryRows) {
          const key = `${file}\0${text}`;
          if (seen.has(key)) throw new Error(`${directory}: indistinguishable declaration rows in ${report} for ${file || "unheaded declarations"}; regenerate the API snapshots: ${snapshotRecovery(directory)}`);
          seen.add(key);
          if (category === "added") continue;
          if (qualify && file !== previousFile) excerpts.push(`// ${file || "Unheaded declarations"}`);
          excerpts.push(text);
          previousFile = file;
        }
        if (category === "added" && categoryRows.length) sections.push(formatAddedDeclarationsSummary(categoryRows));
        if (excerpts.length) sections.push(`${label} declarations:`, ["```ts nocheck", "// API report diff: not compiled.", ...excerpts, "```"].join("\n"));
      }
    }
  }
  if (!listedDeclarations) sections.push(noticedSubpath || paths.some((path) => API_REPORT.test(path)) ? "No top-level declarations changed." : "No API reports changed since the previous release.");
  return sections;
}

/** Upper bound (160 KiB) on a simulated or prepared upgrade page: headroom over real releases (1.4.0 measured about 131 KiB), catches runaway API diffs early. */
export const UPGRADE_PAGE_MAX_BYTES = 160 * 1024;
export const RELEASE_NOTE_PACKAGED_CONTENT_REMEDY =
  "wrap approved adapter subpaths in inline code (for example `@openlup/platform/<family>/<adapter>`) "
  + "or remove downstream/provider terms from the offending changelog fragment or API declaration";
export type SimulatedUpgradePageAudit = { version: string; since: string; path: string; bytes: number; maxBytes: number; prepared: boolean; text: string };

function isUpgradeVersion(version: string): boolean {
  return RELEASE_VERSION.test(version) || /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*(?:\+[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*)?$/u.test(version);
}

// An inline link authored from changes/ is projected into two published Markdown files.
export function rebaseCoreGuideLinks(fragment: ChangelogFragment, prefix: string): string {
  const { body } = parseChangelogFragment(fragment);
  return fragment.path.startsWith("packages/core/changes/")
    ? body.replace(/(\]\([ \t]*<?)\.\.\/docs\/guide\//gu, `$1${prefix}`)
    : body;
}

/** Insert `[Upgrading to X.Y.Z](vX-Y-Z.md)` into `packages/core/docs/guide/upgrade/README.md` if missing. */
export function addUpgradeIndexLink(readmeSource: string, version: string): string {
  const filename = `v${version.replace(/[^A-Za-z0-9]/gu, "-")}.md`;
  const link = `[Upgrading to ${version}](${filename})`;
  if (readmeSource.includes(`(${filename})`) || readmeSource.includes(link)) return readmeSource;
  const existing = /\[Upgrading to [^\]]+\]\(v[0-9A-Za-z-]+\.md\)/u.exec(readmeSource);
  if (existing) {
    const lineStart = readmeSource.lastIndexOf("\n", existing.index - 1) + 1;
    const linePrefix = readmeSource.slice(lineStart, existing.index);
    if (/^[ \t]*-\s+$/u.test(linePrefix)) {
      return `${readmeSource.slice(0, lineStart)}${linePrefix}${link}\n${readmeSource.slice(lineStart)}`;
    }
    return `${readmeSource.slice(0, existing.index)}${link},\n${readmeSource.slice(existing.index)}`;
  }
  const perRelease = /^## Per-release notes[ \t]*\r?\n/mu.exec(readmeSource);
  if (perRelease) {
    const afterHeading = perRelease.index + perRelease[0].length;
    const nextSection = /^## /mu.exec(readmeSource.slice(afterHeading));
    const insertAt = nextSection ? afterHeading + nextSection.index : readmeSource.length;
    const prefix = readmeSource.slice(0, insertAt).trimEnd();
    const suffix = readmeSource.slice(insertAt);
    return `${prefix}\n\n- ${link}\n${suffix ? `\n${suffix}` : ""}`;
  }
  return `${readmeSource.trimEnd()}\n\n## Per-release notes\n\n- ${link}\n`;
}

function renderDeltaSections(root: string, since: string | undefined): string[] {
  if (!since) return [];
  const sections: string[] = [];
  const sqlAdded = collectSqlDelta(root, since);
  if (sqlAdded.length > 0) {
    sections.push("## SQL Delta", [`Added migrations (${sqlAdded.length}):`, ...sqlAdded.map((path) => `- \`${path}\``)].join("\n"));
  }
  const settings = collectSettingsDelta(root, since);
  const settingLines: string[] = [];
  if (settings.added.length > 0) settingLines.push(`- Added (${settings.added.length}): ${settings.added.map((key) => `\`${key}\``).join(", ")}`);
  if (settings.changed.length > 0) settingLines.push(`- Changed (${settings.changed.length}): ${settings.changed.map((key) => `\`${key}\``).join(", ")}`);
  if (settings.removed.length > 0) settingLines.push(`- Removed (${settings.removed.length}): ${settings.removed.map((key) => `\`${key}\``).join(", ")}`);
  if (settingLines.length > 0) {
    sections.push("## Settings Delta", settingLines.join("\n"));
  }
  return sections;
}

function renderUpgradePageSections({ root, version, since, fragments }: { root: string; version: string; since: string | undefined; fragments: readonly ChangelogFragment[] }) {
  if (!isUpgradeVersion(version)) throw new Error(`${version} is not a MAJOR.MINOR.PATCH release version or prerelease`);
  const guideRoot = join(resolve(root), GUIDE);
  const procedure = existsSync(join(guideRoot, "upgrade/README.md")) ? "; see the [upgrade procedure](README.md)" : "";
  const intro = [`# Upgrading to ${version}`, `This page lists what changed since the previous release${procedure}.`];
  const notesSections: string[] = [];
  const starterNotes: ChangelogFragment[] = [];
  const config = parsePackagesConfig(readFileSync(join(root, PACKAGES_CONFIG_PATH), "utf8"));
  for (const entry of config.packages.filter(({ publish }) => publish)) {
    const allNotes = fragments.filter(({ path }) => path.startsWith(`${entry.directory}/changes/`)).sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
    const npmNotes: ChangelogFragment[] = [];
    for (const fragment of allNotes) {
      const parsed = parseChangelogFragment(fragment);
      if (parsed.meta.audience === "starter") starterNotes.push(fragment);
      else npmNotes.push(fragment);
    }
    if (npmNotes.length) notesSections.push(`## ${entry.name}`, ...npmNotes.map((fragment) => rebaseCoreGuideLinks(fragment, "../").trimEnd()));
  }
  const api = ["## API changes", ...(since ? apiSections(root, since) : ["The previous release could not be determined: no core release tag is an ancestor of HEAD."])];
  const deltas = renderDeltaSections(root, since);
  const starterSection = starterNotes.length
    ? [UPGRADE_STARTER_SECTION_HEADING, ...starterNotes.map((fragment) => rebaseCoreGuideLinks(fragment, "../").trimEnd())]
    : [];
  return {
    text: `${[...intro, ...notesSections, ...api, ...deltas, ...starterSection].join("\n\n")}\n`,
    generated: `${[...intro, ...api, ...deltas].join("\n\n")}\n`,
  };
}

/** Render the upgrade page Markdown in memory without spawning the TypeScript guide planner. */
export function renderUpgradePage(input: Parameters<typeof renderUpgradePageSections>[0]): string {
  return renderUpgradePageSections(input).text;
}

/** Assemble from the caller's exact consumed fragments, without reading or deleting fragment files. */
export function assembleUpgradePage({ root, version, since, fragments }: { root: string; version: string; since: string | undefined; fragments: readonly ChangelogFragment[] }): { text: string; violations: string[] } {
  const file = join(resolve(root), upgradePagePath(version));
  const text = renderUpgradePage({ root, version, since, fragments });
  const planned = planReleaseGuide(root, version, { [file]: text });
  return { text, violations: [...planned.violations, ...planned.pageViolations[file]!] };
}

function readCoreManifestVersion(root: string): string | undefined {
  const manifestPath = join(root, "packages/core/package.json");
  if (!existsSync(manifestPath)) return undefined;
  try {
    const value = (JSON.parse(readFileSync(manifestPath, "utf8")) as { version?: unknown }).version;
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

function nextCandidateVersion(root: string, since: string): { version: string; bumpedAboveTag: boolean } {
  const manifestVersion = readCoreManifestVersion(root);
  const tagVersion = /^openlup-core-v(\d+\.\d+\.\d+)$/u.exec(since)?.[1];
  if (manifestVersion && tagVersion && releaseVersionAbove(manifestVersion, tagVersion) === true) {
    return { version: manifestVersion, bumpedAboveTag: true };
  }
  const baseVersion = manifestVersion ?? tagVersion;
  const parsed = baseVersion ? /^(\d+)\.(\d+)\.(\d+)$/u.exec(baseVersion) : null;
  return { version: parsed ? `${parsed[1]}.${Number(parsed[2]) + 1}.0` : "0.1.0", bumpedAboveTag: false };
}

function findOffendingUpgradeSections(path: string, text: string): string[] {
  const sections: Array<{ heading: string; lines: string[] }> = [];
  let current = { heading: "# (preamble)", lines: [] as string[] };
  let fenced = false;
  for (const line of text.split(/\r?\n/u)) {
    if (line.startsWith("```")) {
      fenced = !fenced;
      current.lines.push(line);
      continue;
    }
    if (!fenced && /^#{2,3}\s+/u.test(line)) {
      if (current.lines.length) sections.push(current);
      current = { heading: line.trim(), lines: [line] };
      continue;
    }
    current.lines.push(line);
  }
  if (current.lines.length) sections.push(current);
  return sections
    .filter(({ lines }) => findReleaseNotePackagedContentViolations(path, lines.join("\n")).length > 0)
    .map(({ heading }) => heading);
}

function assertUpgradePageDocumentation(
  root: string,
  { version, path, text, prepared }: Pick<SimulatedUpgradePageAudit, "version" | "path" | "text" | "prepared">,
  label: string,
  fragments: readonly ChangelogFragment[],
  generated: string,
): void {
  const repositoryRoot = resolve(root);
  const packageRoot = join(repositoryRoot, "packages/core");
  const guideRoot = join(repositoryRoot, GUIDE);
  const file = join(repositoryRoot, path);
  const pageLabel = relative(packageRoot, file).split(sep).join("/");
  const tag = `openlup-core-v${version}`;
  const violations: string[] = [];
  let allowed: Set<string>;
  try {
    allowed = readGuideAllowList(repositoryRoot, violations);
  } catch {
    refuseUpgradePage(label, [`${guideAllowListPath}: expected readable JSON with schemaVersion 1 and a list of exact terms`], [`correct ${guideAllowListPath}`]);
  }
  if (violations.length > 0) refuseUpgradePage(label, violations, [`correct ${guideAllowListPath}`]);
  const packed = new Set((packDryRun(packageRoot).files ?? []).map((entry) => entry.path));
  if (!prepared) packed.add(pageLabel);
  const { scripts } = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { scripts?: Record<string, string> };
  const context = { packageRoot, file, label: pageLabel, packed, scripts, repositoryRoot, guideRoot, tag, allowed };

  // Preparation re-pins existing release URLs. A prepared file must already have the right pin.
  const normalize = (source: string) => prepared ? source : pinGuideReleaseLinks(source, version, isUpgradeVersion);
  const pageFixes = new Set<GuidePageFix>();
  assertGuidePage({ ...context, source: normalize(text), fixes: prepared ? pageFixes : undefined }, violations);
  const fragmentViolations: string[] = [];
  const instructions: string[] = [];
  const changelog = { packageRoot, file: join(packageRoot, "CHANGELOG.md"), label: "CHANGELOG.md", packed, scripts };
  for (const fragment of fragments) {
    const count = fragmentViolations.length;
    if (violations.length) assertGuidePage({ ...context, source: normalize(rebaseCoreGuideLinks(fragment, "../").trimEnd()), fragmentPath: fragment.path }, fragmentViolations);
    if (fragment.path.startsWith("packages/core/changes/")) {
      const source = rebaseCoreGuideLinks(fragment, "docs/guide/").trimEnd();
      assertPackageMarkdown({ ...changelog, source }, false, fragmentViolations, `${fragment.path} (Core CHANGELOG.md)`);
    }
    if (fragmentViolations.length > count) instructions.push(`correct the reported content in ${fragment.path}`);
  }
  if (violations.length === 0 && fragmentViolations.length === 0) return;
  if (prepared) instructions.push(...preparedPageFixes(path, pageFixes, tag));
  else if (violations.length) {
    const generatorViolations = instructions.length ? [] : violations;
    if (instructions.length) assertGuidePage({ ...context, source: normalize(generated) }, generatorViolations);
    if (generatorViolations.length) instructions.push(generatorViolations.some((diagnostic) => diagnostic.endsWith(" targets a file missing from npm pack"))
      ? "include the linked file in the Core npm packlist by correcting `files` in packages/core/package.json, or correct the link emitted by scripts/packages/release-docs-pass.ts"
      : "correct the input used to render the upgrade page or the generator in scripts/packages/release-docs-pass.ts");
  }
  refuseUpgradePage(label, [...violations, ...fragmentViolations], instructions);
}

function refuseUpgradePage(label: string, diagnostics: readonly string[], instructions: readonly string[]): never {
  throw new Error([
    `Observed: ${label} fails the Core documentation contract.`,
    "Cause:",
    ...diagnostics.map((diagnostic) => diagnostic.replaceAll("; run docs:check -- --write", "")),
    ...instructions.map((instruction) => `Fix: ${instruction}`),
    "Recheck: npm run preflight -- --fast",
  ].join("\n"));
}

function preparedPageFixes(path: string, fixes: ReadonlySet<GuidePageFix>, tag: string): string[] {
  const pinForm = `for an existing file other than a guide Markdown page, keep the link, replace only the branch, tag or commit name after \`/blob/\` with \`${tag}\`, and write the canonical repository path without \`.\` or \`..\` segments. Keep the query and anchor exactly as written.`;
  const messages: Record<GuidePageFix, string> = {
    "unpinned-blob": `in ${path}, for each repository blob link named in Cause, use a relative guide link for a guide Markdown page. To keep a link, ${pinForm} Correct any other reported guide content in the same file and follow any separate Fix. Then rerun \`npm run preflight -- --fast\`.`,
    "content": `correct the reported guide content in ${path}`,
    "relative-link": `replace the pinned link into the guide with a relative guide link in ${path}`,
    "repository-target": `correct the repository link's target path in ${path}`,
    "generated-region": `remove the generated-region marker and its matching closer from ${path}`,
  };
  return (fixes.size ? [...fixes] : ["content"] as const).map((fix) => messages[fix]);
}

/**
 * Dry-run upgrade page audit in memory (no writes, bare Node 24 compatible):
 * when the core manifest is already bumped above the previous core tag and the
 * prepared upgrade page exists on disk, audits that prepared page; otherwise
 * renders the candidate upgrade page in memory from current fragments + API diffs.
 * Enforces the size cap, packed Core release-note neutrality and the Core Markdown contract for the guide page and Core changelog fragments.
 * The only additional subprocess is Core's npm pack dry run.
 * Returns null when no ancestor core release tag exists to diff against.
 */
export function assertSimulatedUpgradePage(
  root: string,
  options: { maxBytes?: number; since?: string; version?: string; fragments?: readonly ChangelogFragment[]; trackedPaths?: readonly string[] } = {},
): SimulatedUpgradePageAudit | null {
  const since = options.since ?? previousCoreTag(root);
  if (!since) return null;
  const maxBytes = options.maxBytes ?? UPGRADE_PAGE_MAX_BYTES;
  const candidate = nextCandidateVersion(root, since);
  const version = options.version ?? candidate.version;
  const path = upgradePagePath(version);
  const prepared = options.version === undefined && options.fragments === undefined && candidate.bumpedAboveTag && existsSync(join(root, path));
  let fragments: readonly ChangelogFragment[] = [];
  let text: string, generated = "";
  if (prepared) {
    text = readFileSync(join(root, path), "utf8");
  } else {
    const config = parsePackagesConfig(readFileSync(join(root, PACKAGES_CONFIG_PATH), "utf8"));
    const publishableDirs = new Set(config.packages.filter(({ publish }) => publish).map(({ directory }) => directory));
    fragments = options.fragments
      ?? (options.trackedPaths
        ? [...options.trackedPaths]
            .filter((entry) => isChangelogFragment(entry) && publishableDirs.has(entry.split("/").slice(0, 2).join("/")))
            .sort(bytewise)
            .map((entry) => {
              const stat = lstatSync(join(root, entry));
              return { path: entry, contents: validateChangelogFragment(entry, readFileSync(join(root, entry)), stat.mode & 0o111 ? "100755" : "100644") };
            })
        : config.packages.filter(({ publish }) => publish).flatMap(({ directory }) => readChangelogFragments(root, directory)));
    ({ text, generated } = renderUpgradePageSections({ root, version, since, fragments }));
  }
  const bytes = Buffer.byteLength(text, "utf8");
  const label = prepared
    ? `prepared upgrade page ${path} (since ${since})`
    : `simulated upgrade page ${path} (in-memory since ${since})`;
  if (bytes > maxBytes) {
    throw new Error(
      `${label} is ${bytes} bytes, exceeding the ${maxBytes}-byte cap; `
      + (prepared
        ? "trim verbose release notes or fix accidental API snapshot churn in the prepared upgrade page"
        : "trim verbose fragments or fix accidental API snapshot churn before release:bump"),
    );
  }
  const violations = findReleaseNotePackagedContentViolations(path, text);
  if (violations.length > 0) {
    const offendingSections = findOffendingUpgradeSections(path, text);
    const offendingFragments = prepared
      ? []
      : fragments
          .filter((fragment) => findReleaseNotePackagedContentViolations(fragment.path, fragment.contents).length > 0)
          .map((fragment) => fragment.path);
    const attribution = [
      ...(offendingFragments.length > 0 ? [`offending fragment(s): ${offendingFragments.join(", ")}`] : []),
      ...(offendingSections.length > 0 ? [`offending section(s): ${offendingSections.join(", ")}`] : []),
    ];
    throw new Error(
      `${label} contains downstream leakage that would fail packed core audit:\n`
      + `${violations.join("\n")}`
      + (attribution.length > 0 ? `\n${attribution.join("\n")}` : "")
      + `\nFix: ${RELEASE_NOTE_PACKAGED_CONTENT_REMEDY}.`,
    );
  }
  const audit = { version, since, path, bytes, maxBytes, prepared, text };
  assertUpgradePageDocumentation(root, audit, label, fragments, generated);
  return audit;
}

export function formatReleaseDocumentation(listing: ReleaseDocumentationListing): string {
  const lines = [listing.since ? `Documentation changes since ${listing.since}:` : "The previous release could not be determined: no core release tag is an ancestor of HEAD."];
  for (const change of listing.changes) {
    lines.push(`${change.status}\t${change.previousPath ? `${change.previousPath} -> ` : ""}${change.path}`,
      `  owner: ${change.owner ? `${change.owner.doc}${change.owner.anchor}` : "unresolved"}`,
      `  guide: ${change.guidePages.join(", ") || "none found"}`);
    if (change.previousPath) lines.push(`  previous owner: ${change.previousOwner ? `${change.previousOwner.doc}${change.previousOwner.anchor}` : "unresolved"}`);
  }
  if (listing.since && !listing.changes.length) lines.push("No API reports, publication catalogue or maintainer pages changed.");
  if (!listing.websiteChecked) lines.push("Website claims were not checked.");
  else if (!listing.since) lines.push("Website references could not be compared without a previous release.");
  else if (!listing.websiteReferences.length) lines.push("No website references cite changed paths.");
  for (const ref of listing.websiteReferences) lines.push(`${ref.file}:${ref.line} ${ref.reference} (${ref.status})`);
  for (const warning of listing.warnings) lines.push(`warning: ${warning}`);
  return lines.join("\n");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const args = process.argv.slice(2), seen = new Set<string>();
    let since: string | undefined, website: string | undefined;
    for (let index = 0; index < args.length; index++) {
      const arg = args[index]!;
      if (!["--since", "--website", "--json"].includes(arg) || seen.has(arg)) throw new Error("usage: release-docs-pass.ts [--since <tag>] [--website <checkout>] [--json]");
      seen.add(arg);
      if (arg === "--json") continue;
      const value = args[++index];
      if (!value || value.startsWith("-")) throw new Error(`usage: ${arg} needs a value`);
      if (arg === "--since") since = value; else website = resolve(value);
    }
    const listing = listReleaseDocumentation({ root: process.cwd(), since, website });
    if (seen.has("--json") && !listing.websiteChecked) console.error("Website claims were not checked.");
    console.log(seen.has("--json") ? JSON.stringify(listing, null, 2) : formatReleaseDocumentation(listing));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`release:docs-pass: ${message}`);
    process.exitCode = message.startsWith("usage:") ? 2 : 1;
  }
}
