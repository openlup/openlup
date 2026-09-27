import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { documentationDigest, type DocumentationSource } from "./documentation-navigation.ts";
import { markdownHeadings } from "./documentation-routing.ts";
import { DOCUMENTATION_REPOSITORY, documentationPageLinks, type DocumentationBundle, type DocumentationBundleManifest } from "./documentation-bundle.ts";

const normalizedPath = (path: unknown): path is string => typeof path === "string" && path !== "" && !isAbsolute(path)
  && !path.includes("\\") && !path.includes("\0") && path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
const sha = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{40}$/u.test(value);
const digest = (value: unknown): value is string => typeof value === "string" && /^sha256-[a-f0-9]{64}$/u.test(value);

function plainFiles(root: string, prefix = ""): string[] {
  if (lstatSync(join(root, prefix)).isSymbolicLink()) throw new Error("documentation bundle refuses symbolic links");
  return readdirSync(join(root, prefix)).flatMap((name) => {
    const path = prefix ? `${prefix}/${name}` : name;
    const stat = lstatSync(join(root, path));
    if (stat.isSymbolicLink()) throw new Error(`documentation bundle refuses symbolic link ${path}`);
    if (stat.isDirectory()) return plainFiles(root, path);
    if (!stat.isFile()) throw new Error(`documentation bundle contains a non-file ${path}`);
    return [path];
  }).sort();
}

/** Pins must come from a trusted public revision/build, not from this same downloaded manifest. */
export function validateDocumentationBundle(root: string, pins: { sourceCommit?: string; bundleDigest?: string } = {}): DocumentationBundleManifest {
  if (!!pins.sourceCommit !== !!pins.bundleDigest) throw new Error("consumer requires both source commit and bundle digest pins");
  if (lstatSync(root).isSymbolicLink() || !lstatSync(root).isDirectory()) throw new Error("documentation bundle needs a plain directory");
  const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")) as DocumentationBundleManifest;
  if (manifest?.formatVersion !== 1 || manifest.repository !== DOCUMENTATION_REPOSITORY || manifest.profile !== "public-development-preview"
    || !Array.isArray(manifest.files) || !Array.isArray(manifest.pages) || !Array.isArray(manifest.navigation) || !digest(manifest.bundleDigest)) throw new Error("unsupported documentation bundle manifest");
  const { bundleDigest, ...unsigned } = manifest;
  if (documentationDigest(JSON.stringify(unsigned)) !== bundleDigest) throw new Error("documentation manifest digest mismatch");
  const provenance = manifest.provenance;
  if (!provenance || !sha(provenance.baseCommit) || !digest(provenance.candidateDigest)
    || (provenance.kind !== "committed" && provenance.kind !== "local-draft")) throw new Error("invalid documentation provenance");
  if (provenance.kind === "committed" ? !provenance.publishable || !sha(provenance.sourceCommit) || provenance.sourceCommit !== provenance.baseCommit
    : provenance.publishable || provenance.sourceCommit !== null) throw new Error("documentation draft/committed provenance mismatch");
  if (pins.sourceCommit && (!sha(pins.sourceCommit) || !digest(pins.bundleDigest) || !provenance.publishable
    || provenance.sourceCommit !== pins.sourceCommit || bundleDigest !== pins.bundleDigest)) throw new Error("documentation bundle does not match the pinned public revision and digest");
  const paths = manifest.files.map((file) => {
    if (!file || !normalizedPath(file.path) || file.path === "manifest.json" || !digest(file.digest) || !Number.isSafeInteger(file.bytes) || file.bytes < 0) throw new Error("invalid documentation file entry");
    return file.path;
  });
  if (new Set(paths).size !== paths.length || JSON.stringify([...paths, "manifest.json"].sort()) !== JSON.stringify(plainFiles(root))) throw new Error("documentation bundle is incomplete or contains unexpected files");
  for (const file of manifest.files) {
    const bytes = readFileSync(join(root, file.path));
    if (bytes.length !== file.bytes || documentationDigest(bytes) !== file.digest) throw new Error(`documentation content digest mismatch: ${file.path}`);
  }
  const pageIds = new Map<string, typeof manifest.pages[number]>();
  const pagePaths: string[] = [];
  for (const page of manifest.pages) {
    if (!page || !normalizedPath(page.path) || !page.path.endsWith(".md") || page.id !== `page:${page.path}`
      || pageIds.has(page.id) || page.contentPath !== `markdown/${page.path}` || !paths.includes(page.contentPath)
      || typeof page.title !== "string" || !Array.isArray(page.headings) || !Array.isArray(page.links)) throw new Error("invalid documentation page entry");
    const expectedSource = provenance.sourceCommit ? `${DOCUMENTATION_REPOSITORY}/blob/${provenance.sourceCommit}/${page.path.split("/").map(encodeURIComponent).join("/")}` : null;
    if (page.sourceHref !== expectedSource) throw new Error("documentation page mixes source revisions");
    const headings = markdownHeadings(readFileSync(join(root, page.contentPath), "utf8")).map((heading) => ({ id: heading.anchor.slice(1), title: heading.title }));
    if (JSON.stringify(page.headings) !== JSON.stringify(headings)) throw new Error("documentation headings differ from Markdown content");
    pageIds.set(page.id, page); pagePaths.push(page.contentPath);
  }
  if (JSON.stringify(pagePaths.sort()) !== JSON.stringify(paths.filter((path) => path.startsWith("markdown/")).sort())) throw new Error("documentation pages do not cover their Markdown inventory");
  if (!["sources.json", "search.json", "llms.txt", "llms-full.txt"].every((path) => paths.includes(path))) throw new Error("documentation bundle is missing a projection");
  const navigationOwners = new Map<string, typeof manifest.navigation[number]>();
  for (const surface of manifest.navigation) {
    const page = surface && pageIds.get(surface.page);
    if (!page || typeof surface.id !== "string" || navigationOwners.has(surface.id) || typeof surface.purpose !== "string" || !Array.isArray(surface.selectors)
      || typeof surface.anchor !== "string" || (surface.anchor !== "" && !page.headings.some((heading) => `#${heading.id}` === surface.anchor))) throw new Error("documentation navigation has an invalid owner or anchor");
    navigationOwners.set(surface.id, surface);
  }
  const inventory = JSON.parse(readFileSync(join(root, "sources.json"), "utf8")) as { sources: DocumentationSource[] };
  if (!inventory || !Array.isArray(inventory.sources)) throw new Error("invalid documentation source inventory");
  const sourcePaths = new Set<string>();
  for (const source of inventory.sources) {
    if (!source || !normalizedPath(source.path) || sourcePaths.has(source.path) || source.id !== `source:${source.path}` || !digest(source.digest))
      throw new Error("source inventory has an invalid path, identity or digest");
    if (typeof source.class !== "string" || typeof source.role !== "string" || source.descriptionSource !== "authored-owner"
      || !Array.isArray(source.symbols) || source.symbols.some((symbol) => typeof symbol !== "string")
      || source.symbolSource !== (source.symbols.length ? "syntactic-export-declarations" : "none")) throw new Error("invalid documentation source hint format");
    const owner = source.owner && navigationOwners.get(source.owner.unit);
    if (!owner || owner.page !== `page:${source.owner.page}` || owner.anchor !== source.owner.anchor || owner.purpose !== source.owner.purpose)
      throw new Error("source inventory has an invalid canonical owner or anchor");
    sourcePaths.add(source.path);
    if (source.path.endsWith(".md") && manifest.files.find((file) => file.path === `markdown/${source.path}`)?.digest !== source.digest) throw new Error("source inventory and Markdown bytes differ");
  }
  if (manifest.pages.some((page) => !sourcePaths.has(page.path))) throw new Error("source inventory omits a Markdown page");
  const markdownPaths = new Set(manifest.pages.map((page) => page.path));
  for (const page of manifest.pages) {
    const expectedLinks = documentationPageLinks(page.path, readFileSync(join(root, page.contentPath), "utf8"), markdownPaths, sourcePaths, provenance.sourceCommit);
    if (JSON.stringify(page.links) !== JSON.stringify(expectedLinks)) throw new Error("documentation links mix content or source revisions");
  }
  return manifest;
}

/** Write once into a new ignored dist-docs child. Never overwrite an unrelated directory. */
export function writeDocumentationBundle(root: string, output: string, bundle: DocumentationBundle): string {
  if (!normalizedPath(output) || !output.startsWith("dist-docs/")) throw new Error("documentation output must be a new repository-local dist-docs/<name> directory");
  const canonicalRoot = realpathSync(root);
  const target = resolve(canonicalRoot, output);
  const rootRelative = relative(canonicalRoot, target);
  if (rootRelative.startsWith(`..${sep}`) || isAbsolute(rootRelative)) throw new Error("documentation output escapes the checkout");
  let parent = dirname(target);
  while (parent !== canonicalRoot) {
    if (existsSync(parent) && (lstatSync(parent).isSymbolicLink() || !lstatSync(parent).isDirectory())) throw new Error("documentation output has an unsafe parent");
    const next = dirname(parent); if (next === parent) throw new Error("documentation output has no checkout parent"); parent = next;
  }
  if (existsSync(target)) throw new Error("documentation output already exists; select a new output directory");
  mkdirSync(dirname(target), { recursive: true });
  const staging = join(dirname(target), `.documentation-${randomUUID()}`);
  mkdirSync(staging);
  for (const [path, bytes] of bundle.contents) {
    if (!normalizedPath(path)) throw new Error("documentation bundle has an unsafe file path");
    mkdirSync(dirname(join(staging, path)), { recursive: true }); writeFileSync(join(staging, path), bytes);
  }
  validateDocumentationBundle(staging);
  renameSync(staging, target);
  return target;
}
