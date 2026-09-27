import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { markdownHeadings, type DocumentationState } from "./documentation-routing.ts";
import { documentationDigest, documentationSources } from "./documentation-navigation.ts";
import { readDocumentationTree } from "./documentation-git.ts";

export const DOCUMENTATION_REPOSITORY = "https://github.com/openlup/openlup";
export const DOCUMENTATION_BUNDLE_FORMAT = 1;
export type DocumentationPage = {
  id: string; path: string; contentPath: string; title: string;
  status: string | null; headings: { id: string; title: string }[];
  sourceHref: string | null;
  links: { raw: string; target: string | null; href: string | null }[];
};
export type DocumentationBundleManifest = {
  formatVersion: 1;
  repository: string;
  profile: "public-development-preview";
  provenance: { kind: "committed" | "local-draft"; publishable: boolean; sourceCommit: string | null; baseCommit: string; candidateDigest: string };
  pages: DocumentationPage[];
  navigation: { id: string; purpose: string; page: string; anchor: string; selectors: string[] }[];
  files: { path: string; digest: string; bytes: number }[];
  bundleDigest: string;
};
export type DocumentationBundle = { manifest: DocumentationBundleManifest; contents: Map<string, Buffer> };

const git = (root: string, args: string[]): string => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const encoded = (path: string): string => path.split("/").map(encodeURIComponent).join("/");
const sourceHref = (revision: string, path: string, kind: "blob" | "tree" = "blob"): string => `${DOCUMENTATION_REPOSITORY}/${kind}/${revision}/${encoded(path)}`;
const json = (value: unknown): Buffer => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

export function documentationPageLinks(path: string, markdown: string, pagePaths: Set<string>, sourcePaths: Set<string>, revision: string | null): DocumentationPage["links"] {
  const links: DocumentationPage["links"] = [];
  // Inline and reference definitions; leave prose/code unchanged in raw Markdown.
  const targets = [
    ...[...markdown.matchAll(/\]\(([^\s)]+)(?:\s+"[^"\n]*")?\)/gu)].map((match) => match[1]),
    ...[...markdown.matchAll(/^\s{0,3}\[[^\]\n]+\]:\s*(\S+)/gmu)].map((match) => match[1]),
  ];
  for (const raw of [...new Set(targets)]) {
    if (/^[a-z][a-z0-9+.-]*:/iu.test(raw)) {
      links.push({ raw, target: null, href: /^https?:/iu.test(raw) ? raw : null });
      continue;
    }
    const [targetPath, fragment] = raw.split("#", 2);
    const target = targetPath === "" ? path : posix.normalize(posix.join(posix.dirname(path), targetPath)).replace(/\/$/u, "");
    if (target.startsWith("../") || target.startsWith("/") || target === "..") throw new Error(`${path}: bundle link escapes the repository: ${raw}`);
    const suffix = fragment ? `#${fragment}` : "";
    const isPage = pagePaths.has(target);
    const directory = raw.endsWith("/") && [...sourcePaths].some((entry) => entry.startsWith(`${target}/`));
    if (!isPage && !sourcePaths.has(target) && !directory) throw new Error(`${path}: missing bundle link ${raw}`);
    links.push({ raw, target, href: isPage ? `markdown/${encoded(target)}${suffix}` : revision ? sourceHref(revision, target, directory ? "tree" : "blob") + suffix : null });
  }
  return links;
}

/** Clean exports bind every selected byte to committed HEAD. Drafts are useful only locally. */
export function createDocumentationBundle(root: string, state: DocumentationState, local = false): DocumentationBundle {
  const head = git(root, ["rev-parse", "HEAD"]).trim();
  if (!/^[a-f0-9]{40}$/u.test(head)) throw new Error("documentation export needs an exact committed base");
  const dirty = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]) !== "";
  if (!local && dirty) throw new Error("clean documentation export refuses a changed tree; use --docs-local for a non-publishable draft");
  if (!local) {
    const committed = git(root, ["ls-tree", "-r", "--name-only", "-z", head]).split("\0").filter(Boolean).sort();
    if (JSON.stringify(committed) !== JSON.stringify([...state.paths].sort())) throw new Error("clean documentation export inventory is not committed HEAD");
  }
  const sources = documentationSources(root, state);
  const sourceInputs = sources.map(({ path, digest }) => ({ path, digest, mode: (lstatSync(join(root, path)).mode & 0o111) ? "100755" : "100644" }));
  if (!local) {
    const committed = readDocumentationTree(root, head);
    if (sourceInputs.some((row) => committed.get(row.path)?.digest !== row.digest || committed.get(row.path)?.mode !== row.mode)) throw new Error("clean documentation export bytes/modes differ from committed HEAD");
  }
  const candidateDigest = documentationDigest(JSON.stringify(sourceInputs));
  const revision = local ? null : head;
  const pagePaths = new Set(state.paths.filter((path) => path.endsWith(".md")));
  if (state.paths.some((path) => path.endsWith(".mdx"))) throw new Error("documentation bundles accept plain Markdown only, not executable MDX");
  const contents = new Map<string, Buffer>();
  const pages: DocumentationPage[] = [];
  for (const path of [...pagePaths].sort()) {
    const bytes = readFileSync(join(root, path));
    const markdown = bytes.toString("utf8");
    const title = /^#\s+(.+)$/mu.exec(markdown)?.[1] ?? path;
    // The helper's slug implementation also validates ownership anchors.
    const headings = markdownHeadings(markdown).map((heading) => ({ id: heading.anchor.replace(/^#/u, ""), title: heading.title }));
    const contentPath = `markdown/${path}`;
    pages.push({ id: `page:${path}`, path, contentPath, title, status: /^Status:\s*(.+)$/mu.exec(markdown)?.[1] ?? null,
      headings, sourceHref: revision ? sourceHref(revision, path) : null,
      links: documentationPageLinks(path, markdown, pagePaths, new Set(state.paths), revision) });
    contents.set(contentPath, bytes);
  }
  contents.set("sources.json", json({ description: "Authored owner purpose plus structural path/role and syntactic symbol hints; no behavioral or test-result assertion.", sources }));
  contents.set("search.json", json(pages.map((page) => ({ id: page.id, title: page.title, path: page.contentPath, headings: page.headings,
    text: contents.get(page.contentPath)!.toString("utf8") }))));
  const banner = `OpenLup public development-preview documentation\n${local ? `LOCAL DRAFT — NON-PUBLISHABLE; base ${head}; candidate ${candidateDigest}` : `Source commit ${head}`}\n`;
  contents.set("llms.txt", Buffer.from(`# ${banner}\n${pages.map((page) => `- [${page.title}](${page.contentPath})${page.status ? `: ${page.status}` : ""}`).join("\n")}\n`));
  contents.set("llms-full.txt", Buffer.from(`# ${banner}\n${pages.map((page) => `## ${page.id}\nSource: ${page.path}\n\n${contents.get(page.contentPath)!.toString("utf8")}`).join("\n\n")}\n`));
  const unsigned: Omit<DocumentationBundleManifest, "bundleDigest"> = {
    formatVersion: DOCUMENTATION_BUNDLE_FORMAT, repository: DOCUMENTATION_REPOSITORY, profile: "public-development-preview" as const,
    provenance: { kind: local ? "local-draft" as const : "committed" as const, publishable: !local, sourceCommit: revision, baseCommit: head, candidateDigest },
    pages, navigation: state.surfaces.map((surface) => ({ id: surface.id, purpose: surface.when, page: `page:${surface.doc}`, anchor: surface.anchor, selectors: surface.paths })),
    files: [...contents].map(([path, bytes]) => ({ path, digest: documentationDigest(bytes), bytes: bytes.length })).sort((a, b) => a.path.localeCompare(b.path)),
  };
  const manifest: DocumentationBundleManifest = { ...unsigned, bundleDigest: documentationDigest(JSON.stringify(unsigned)) };
  contents.set("manifest.json", json(manifest));
  return { manifest, contents };
}
