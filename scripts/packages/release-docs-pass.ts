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

export function previousCoreTag(root: string): string | undefined {
  if (!documentationGit(root, ["tag", "--merged", "HEAD", "--list", "openlup-core-v*"]).toString("utf8").trim()) return undefined;
  return documentationGit(root, ["describe", "--tags", "--abbrev=0", "--match", "openlup-core-v*", "HEAD"]).toString("utf8").trim();
}

function releaseChanges(root: string, since: string): ReleaseChange[] {
  const base = documentationGit(root, ["rev-parse", "--verify", "--end-of-options", `${since}^{commit}`]).toString("utf8").trim();
  return parseReleaseChanges(documentationGit(root, ["diff", "--name-status", "-z", "--find-renames", "--no-ext-diff", "--no-textconv", base, "HEAD", "--"]).toString("utf8"));
}

const changedPaths = (change: ReleaseChange): string[] => change.previousPath ? [change.previousPath, change.path] : [change.path];
const listedPath = (path: string): boolean => API_REPORT.test(path) || path === "config/openlup-publication-catalog.json"
  || (/^docs\/platform\/.*\.md$/u.test(path) && !path.startsWith("docs/platform/plans/"))
  || /^\.github\/[^/]+\.md$/u.test(path) || /^packages\/[^/]+\/(?:README|AGENTS)\.md$/u.test(path)
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

export function summarizeApiDiff(diff: string): { added: string[]; removed: string[] } {
  const added: string[] = [], removed: string[] = [];
  for (const line of diff.split("\n")) {
    if (line.startsWith("+export ")) added.push(line.slice(1).trim());
    if (line.startsWith("-export ")) removed.push(line.slice(1).trim());
  }
  return { added, removed };
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
  const changes = since ? releaseChanges(root, since).filter((change) => changedPaths(change).some((path) => API_REPORT.test(path))) : [];
  for (const change of changes) {
    const diff = documentationGit(root, ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--unified=0", since!, "HEAD", "--", ...changedPaths(change).map((path) => `:(literal)${path}`)]).toString("utf8");
    const { added, removed } = summarizeApiDiff(diff);
    sections.push(`### \`${change.path}\``);
    for (const [label, lines] of [["Added declarations", added], ["Removed declarations", removed]] as const) if (lines.length) sections.push(`${label}:`, ["```ts nocheck", "// API report diff: not compiled.", ...lines, "```"].join("\n"));
    if (!added.length && !removed.length) sections.push("No exported declaration lines changed.");
  }
  if (!since) sections.push("The previous release could not be determined: no core release tag is an ancestor of HEAD.");
  else if (!changes.length) sections.push("No API reports changed since the previous release.");
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
