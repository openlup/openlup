/**
 * Governing document: docs/platform/DEVELOPMENT_AND_RELEASE.md, "Releasing a package".
 * Lists documentation affected since the previous core tag without writing any files.
 * Set preparation also uses the assembler before it writes files or consumes fragments.
 */
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, posix, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { documentationGit, documentationLinkTargets, parseDocumentationRouting, resolveDocumentationOwner, type DocumentationOwner } from "../documentation-routing.ts";
import type { ChangelogFragment } from "./changelog-fragments.ts";
import { PACKAGES_CONFIG_PATH, RELEASE_VERSION, parsePackagesConfig } from "./package-manifest-policy.ts";

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

export function previousPackageTag(root: string, name: string): string | undefined {
  const pattern = `openlup-${name}-v*`;
  if (!documentationGit(root, ["tag", "--merged", "HEAD", "--list", pattern]).toString("utf8").trim()) return undefined;
  return documentationGit(root, ["describe", "--tags", "--abbrev=0", "--match", pattern, "HEAD"]).toString("utf8").trim();
}

export function previousCoreTag(root: string): string | undefined {
  return previousPackageTag(root, "core");
}

function releaseChanges(root: string, since: string): ReleaseChange[] {
  const base = documentationGit(root, ["rev-parse", "--verify", "--end-of-options", `${since}^{commit}`]).toString("utf8").trim();
  return parseReleaseChanges(documentationGit(root, ["diff", "--name-status", "-z", "--find-renames", "--no-ext-diff", "--no-textconv", base, "HEAD", "--"]).toString("utf8"));
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

type Declaration = { first: string; text: string };

/** Compare complete top-level declaration blocks inside one declaration file or unheaded report. */
function apiDeclarations(source: string) {
  const blocks = new Map<string, Declaration[]>();
  let fence = false, typescript = false, block: string[] = [], leading: string[] = [], first = "", key = "";
  const finish = () => {
    if (!block.length) return;
    const text = block.map((line) => line.trimEnd()).join("\n").trimEnd();
    const family = blocks.get(key) ?? [];
    family.push({ first, text });
    blocks.set(key, family);
    block = [];
  };
  for (const line of source.split(/\r?\n/u)) {
    if (line.startsWith("```")) {
      finish();
      leading = [];
      typescript = !fence && /^```ts(?:\s.*)?$/u.test(line);
      fence = !fence;
    } else if (typescript) {
      const declaration = /^(?:export\s+)?(?:declare\s+)?(?:default\s+)?(?:abstract\s+|async\s+)?(?:const\s+(?=enum\s))?(const|let|var|function|class|interface|type|enum|namespace|module)\b(?:\s+([\w$]+|"[^"]+"|'[^']+'))?/u.exec(line);
      if (declaration || /^export\s+(?:\*|\{|type\s+\*)/u.test(line)) {
        finish();
        first = line.trimEnd();
        key = declaration?.[2] ? `${declaration[1]} ${declaration[2]}` : first;
        block = [...leading, line];
        leading = [];
      } else if (/^(?:\/\/|\/\*\*| \*)/u.test(line)) leading.push(line);
      else if (/^import\b/u.test(line)) leading = [];
      else {
        if (block.length) block.push(...leading, line);
        leading = [];
      }
    }
  }
  finish();
  return blocks;
}

function unmatchedDeclarations(blocks: Declaration[], opposite: Declaration[]): string[] {
  const remaining = opposite.slice();
  return blocks.filter(({ text }) => {
    const match = remaining.findIndex((entry) => entry.text === text);
    if (match === -1) return true;
    remaining.splice(match, 1);
    return false;
  }).map(({ text }) => text);
}

export function summarizeApiDiff(before: string, after: string) {
  const oldBlocks = apiDeclarations(before), newBlocks = apiDeclarations(after);
  const added: string[] = [], removed: string[] = [], changed: string[] = [];
  for (const [key, current] of newBlocks) {
    const old = oldBlocks.get(key) ?? [];
    if (!old.length && current.length === 1) added.push(current[0]!.first);
    else if (old.length === 1 && current.length === 1) {
      if (old[0]!.text !== current[0]!.text) changed.push(current[0]!.first);
    } else (old.length ? changed : added).push(...unmatchedDeclarations(current, old));
  }
  for (const [key, old] of oldBlocks) {
    const current = newBlocks.get(key) ?? [];
    if (old.length === 1 && !current.length) removed.push(old[0]!.first);
    else if (old.length > 1 || current.length > 1) removed.push(...unmatchedDeclarations(old, current));
  }
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
  const gates = `${directory}/release-gates.json`;
  const paths = documentationGit(root, ["ls-tree", "-r", "-z", "--name-only", ref, "--", `${directory}/api`, gates]).toString("utf8").split("\0");
  const read = (path: string) => documentationGit(root, ["show", `${ref}:${path}`]).toString("utf8");
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
        const excerpts: string[] = [];
        let previousFile: string | undefined;
        for (const { file, text } of rows.filter((row) => row.category === category)) {
          const key = `${file}\0${text}`;
          if (seen.has(key)) throw new Error(`${directory}: indistinguishable declaration rows in ${report} for ${file || "unheaded declarations"}; regenerate the API snapshots: ${snapshotRecovery(directory)}`);
          seen.add(key);
          if (qualify && file !== previousFile) excerpts.push(`// ${file || "Unheaded declarations"}`);
          excerpts.push(text);
          previousFile = file;
        }
        if (excerpts.length) sections.push(`${label} declarations:`, ["```ts nocheck", "// API report diff: not compiled.", ...excerpts, "```"].join("\n"));
      }
    }
  }
  if (!listedDeclarations) sections.push(noticedSubpath || paths.some((path) => API_REPORT.test(path)) ? "No top-level declarations changed." : "No API reports changed since the previous release.");
  return sections;
}

/** Assemble from the caller's exact consumed fragments, without reading or deleting fragment files. */
export function assembleUpgradePage({ root, version, since, fragments }: { root: string; version: string; since: string | undefined; fragments: readonly ChangelogFragment[] }): { text: string; violations: string[] } {
  if (!RELEASE_VERSION.test(version) && !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*(?:\+[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*)?$/u.test(version)) throw new Error(`${version} is not a MAJOR.MINOR.PATCH release version or prerelease`);
  const guideRoot = join(resolve(root), GUIDE), file = join(resolve(root), upgradePagePath(version));
  const procedure = existsSync(join(guideRoot, "upgrade/README.md")) ? "; see the [upgrade procedure](README.md)" : "";
  const sections = [`# Upgrading to ${version}`, `This page lists what changed since the previous release${procedure}.`];
  const config = parsePackagesConfig(readFileSync(join(root, PACKAGES_CONFIG_PATH), "utf8"));
  for (const entry of config.packages.filter(({ publish }) => publish)) {
    const notes = fragments.filter(({ path }) => path.startsWith(`${entry.directory}/changes/`)).sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
    if (notes.length) sections.push(`## ${entry.name}`, ...notes.map(({ contents }) => contents.trimEnd()));
  }
  sections.push("## API changes");
  if (since) sections.push(...apiSections(root, since));
  else sections.push("The previous release could not be determined: no core release tag is an ancestor of HEAD.");
  const text = `${sections.join("\n\n")}\n`;
  const planned = planReleaseGuide(root, version, { [file]: text });
  return { text, violations: [...planned.violations, ...planned.pageViolations[file]!] };
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
