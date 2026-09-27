import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDocumentationBundle } from "./documentation-bundle.ts";
import { validateDocumentationBundle, writeDocumentationBundle } from "./documentation-bundle-io.ts";
import { documentationDigest, renderDocumentationSourceMap, type DocumentationSource } from "./documentation-navigation.ts";
import type { DocumentationState } from "./documentation-routing.ts";

const fixtures: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); fixtures.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })); });
function fixture(): { root: string; state: DocumentationState } {
  const root = mkdtempSync(join(tmpdir(), "documentation-bundle-")); fixtures.push(root);
  const files = {
    ".gitignore": "dist-docs/\n",
    "README.md": "# Fixture\n\nStatus: development-preview fixture\n\n## Contract\n\n[Implementation](src/example.ts)\n[Directory](src/)\n",
    "src/example.ts": "export const sample = 1;\n",
  };
  const paths = [...Object.keys(files), "config/openlup-publication-catalog.json"].sort();
  for (const [path, bytes] of Object.entries(files)) { mkdirSync(join(root, path, ".."), { recursive: true }); writeFileSync(join(root, path), bytes); }
  mkdirSync(join(root, "config")); writeFileSync(join(root, "config/openlup-publication-catalog.json"), JSON.stringify({ publicPaths: paths.map((path) => ({ path, class: "public-output" })) }));
  const git = (args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git(["init", "-q", "-b", "main"]); git(["add", "."]);
  git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]);
  const surface = { id: "fixture", when: "Fixture contract", paths: ["**"], doc: "README.md", anchor: "#contract" };
  const owner = { ...surface, unit: surface.id };
  return { root, state: { root, version: 2, paths, coreDomains: [], surfaces: [surface], ownersByPath: new Map(paths.map((path) => [path, owner])) } };
}
function write(root: string, contents: Map<string, Buffer>, name = "export"): string {
  const directory = join(root, name); mkdirSync(directory);
  for (const [path, bytes] of contents) { mkdirSync(join(directory, path, ".."), { recursive: true }); writeFileSync(join(directory, path), bytes); }
  return directory;
}

describe("public documentation bundle", () => {
  it("keeps committed provenance bound to its checkout despite ambient Git redirects", () => {
    const { root, state } = fixture(); const decoy = fixture().root;
    const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
    const head = git(root, ["rev-parse", "HEAD"]);
    writeFileSync(join(decoy, "src/example.ts"), "export const sample = 7;\n"); git(decoy, ["add", "."]);
    git(decoy, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "decoy"]);
    vi.stubEnv("GIT_DIR", join(decoy, ".git")); vi.stubEnv("GIT_WORK_TREE", decoy); vi.stubEnv("GIT_INDEX_FILE", join(decoy, ".git/index"));
    expect(createDocumentationBundle(root, state).manifest.provenance.sourceCommit).toBe(head);
  });
  it("is deterministic and reads back a complete pinned clean bundle", () => {
    const { root, state } = fixture();
    const first = createDocumentationBundle(root, state);
    expect([...createDocumentationBundle(root, state).contents]).toEqual([...first.contents]);
    const directory = write(root, first.contents);
    expect(validateDocumentationBundle(directory, { sourceCommit: first.manifest.provenance.sourceCommit!, bundleDigest: first.manifest.bundleDigest })).toEqual(first.manifest);
    const sources = JSON.parse(first.contents.get("sources.json")!.toString()).sources;
    expect(sources.find((row: { path: string }) => row.path === "src/example.ts").symbols).toEqual(["sample"]);
    expect(first.manifest.pages[0].links[0].href).toContain(`/blob/${first.manifest.provenance.sourceCommit}/src/example.ts`);
    expect(first.manifest.pages[0].links[1].href).toContain(`/tree/${first.manifest.provenance.sourceCommit}/src`);
    expect(renderDocumentationSourceMap(state)).toBe(renderDocumentationSourceMap(state));
  });

  it.each(["clean", "process"])("exports without executing a configured Git %s filter", (kind) => {
    const { root, state } = fixture(); const marker = join(root, ".git/filter-executed");
    const program = join(root, ".git/fixture-filter.mjs");
    writeFileSync(program, `import { readFileSync, writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "executed"); ${kind === "clean" ? "process.stdout.write(readFileSync(0));" : "process.exit(1);"}`);
    writeFileSync(join(root, ".git/fixture-attributes"), "src/example.ts filter=fixture\n");
    const git = (args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
    const quote = (value: string): string => `'${value.replaceAll("'", "'\"'\"'")}'`;
    git(["config", "core.attributesFile", ".git/fixture-attributes"]);
    git(["config", `filter.fixture.${kind}`, `${quote(process.execPath)} ${quote(program)}`]);
    utimesSync(join(root, "src/example.ts"), new Date(2000, 0, 1), new Date(2000, 0, 1));
    expect(createDocumentationBundle(root, state).manifest.provenance.publishable).toBe(true);
    expect(createDocumentationBundle(root, state, true).manifest.provenance.publishable).toBe(false);
    expect(existsSync(marker)).toBe(false);
  });

  it("refuses a changed index even when materialized bytes match HEAD", () => {
    const { root, state } = fixture(); const source = join(root, "src/example.ts"); const original = readFileSync(source);
    writeFileSync(source, "export const sample = 2;\n"); execFileSync("git", ["add", "src/example.ts"], { cwd: root, stdio: "pipe" }); writeFileSync(source, original);
    expect(() => createDocumentationBundle(root, state)).toThrow(/changed tree: index/u);
    expect(createDocumentationBundle(root, state, true).manifest.provenance.publishable).toBe(false);
  });

  it("refuses an untracked source omitted from a supplied inventory", () => {
    const { root, state } = fixture(); writeFileSync(join(root, "src/untracked.ts"), "export const added = true;\n");
    expect(() => createDocumentationBundle(root, state)).toThrow(/changed tree: inventory/u);
  });

  it("labels changed bytes as non-publishable rather than committed HEAD", () => {
    const { root, state } = fixture(); writeFileSync(join(root, "src/example.ts"), "export const sample = 2;\n");
    expect(() => createDocumentationBundle(root, state)).toThrow(/changed tree/u);
    const draft = createDocumentationBundle(root, state, true);
    expect(draft.manifest.provenance).toMatchObject({ kind: "local-draft", publishable: false, sourceCommit: null });
    expect(draft.manifest.pages[0].sourceHref).toBeNull();
    expect(draft.manifest.pages[0].links[0].href).toBeNull();
    const directory = write(root, draft.contents);
    expect(() => validateDocumentationBundle(directory, { sourceCommit: draft.manifest.provenance.baseCommit, bundleDigest: draft.manifest.bundleDigest })).toThrow(/pinned/u);
  });

  it("refuses missing pages, extra paths, tampering and a mixed manifest", () => {
    const { root, state } = fixture(); const bundle = createDocumentationBundle(root, state);
    const tampered = write(root, bundle.contents, "tampered"); writeFileSync(join(tampered, "markdown/README.md"), "# Different\n");
    expect(() => validateDocumentationBundle(tampered)).toThrow(/digest mismatch/u);
    const missing = write(root, bundle.contents, "missing"); rmSync(join(missing, "markdown/README.md"));
    expect(() => validateDocumentationBundle(missing)).toThrow(/incomplete/u);
    const extra = write(root, bundle.contents, "extra"); writeFileSync(join(extra, "surprise.txt"), "extra");
    expect(() => validateDocumentationBundle(extra)).toThrow(/unexpected/u);
    const mixed = write(root, bundle.contents, "mixed");
    const manifest = { ...bundle.manifest, provenance: { ...bundle.manifest.provenance, sourceCommit: "f".repeat(40) } };
    writeFileSync(join(mixed, "manifest.json"), JSON.stringify(manifest));
    expect(() => validateDocumentationBundle(mixed)).toThrow(/manifest digest/u);
    expect(() => validateDocumentationBundle(extra, { sourceCommit: "f".repeat(40) })).toThrow(/both/u);
  });

  it.each(["missing-id", "wrong-id", "duplicate-id", "missing-anchor", "wrong-owner", "missing-page-source", "malformed-hint", "invented-heading"])("refuses self-consistent malformed source navigation: %s", (kind) => {
    const { root, state } = fixture(); const bundle = createDocumentationBundle(root, state);
    const inventory = JSON.parse(bundle.contents.get("sources.json")!.toString()) as { sources: DocumentationSource[] };
    if (kind === "missing-id") delete (inventory.sources[0] as Partial<DocumentationSource>).id;
    else if (kind === "wrong-id") inventory.sources[0].id = "source:unrelated.ts";
    else if (kind === "duplicate-id") inventory.sources[1].id = inventory.sources[0].id;
    else if (kind === "missing-anchor") inventory.sources[0].owner.anchor = "#missing";
    else if (kind === "wrong-owner") inventory.sources[0].owner.unit = "unknown-owner";
    else if (kind === "missing-page-source") inventory.sources = inventory.sources.filter((source) => source.path !== "README.md");
    else if (kind === "malformed-hint") (inventory.sources[0] as unknown as { symbols: unknown }).symbols = 7;
    else {
      bundle.manifest.pages[0].headings.push({ id: "invented", title: "Invented" });
      bundle.manifest.navigation[0].anchor = "#invented";
      inventory.sources.forEach((source) => { source.owner.anchor = "#invented"; });
    }
    const bytes = Buffer.from(JSON.stringify(inventory)); bundle.contents.set("sources.json", bytes);
    const file = bundle.manifest.files.find((entry) => entry.path === "sources.json")!;
    file.bytes = bytes.length; file.digest = documentationDigest(bytes);
    const { bundleDigest: _previous, ...unsigned } = bundle.manifest;
    bundle.manifest.bundleDigest = documentationDigest(JSON.stringify(unsigned));
    bundle.contents.set("manifest.json", Buffer.from(JSON.stringify(bundle.manifest)));
    const directory = write(root, bundle.contents);
    expect(() => validateDocumentationBundle(directory)).toThrow(/identity|owner or anchor|headings differ|omits a Markdown page|hint format/u);
    expect(() => validateDocumentationBundle(directory, { sourceCommit: bundle.manifest.provenance.sourceCommit!, bundleDigest: bundle.manifest.bundleDigest }))
      .toThrow(/identity|owner or anchor|headings differ|omits a Markdown page|hint format/u);
  });

  it("writes only a new safe ignored output and refuses symlink destinations", () => {
    const { root, state } = fixture(); const bundle = createDocumentationBundle(root, state);
    expect(() => writeDocumentationBundle(root, "../outside", bundle)).toThrow(/repository-local/u);
    const directory = writeDocumentationBundle(root, "dist-docs/clean", bundle);
    expect(readFileSync(join(directory, "manifest.json"), "utf8")).toContain(bundle.manifest.bundleDigest);
    expect(() => writeDocumentationBundle(root, "dist-docs/clean", bundle)).toThrow(/already exists/u);
    symlinkSync(root, join(root, "dist-docs/link"));
    expect(() => writeDocumentationBundle(root, "dist-docs/link/child", bundle)).toThrow(/unsafe parent/u);
    const linked = write(root, bundle.contents); symlinkSync(join(root, "README.md"), join(linked, "linked.md"));
    expect(() => validateDocumentationBundle(linked)).toThrow(/symbolic link/u);
  });

  it("refuses a linked or directory manifest before reading outside bytes", () => {
    const { root, state } = fixture(); const bundle = createDocumentationBundle(root, state);
    const linked = write(root, bundle.contents, "linked-manifest"); rmSync(join(linked, "manifest.json"));
    const outside = join(root, "synthetic-outside.json"); writeFileSync(outside, "SYNTHETIC_OUTSIDE_BYTES_ARE_NOT_JSON");
    symlinkSync(outside, join(linked, "manifest.json"));
    expect(() => validateDocumentationBundle(linked)).toThrow(/symbolic link/u);
    const directory = write(root, bundle.contents, "directory-manifest"); rmSync(join(directory, "manifest.json")); mkdirSync(join(directory, "manifest.json"));
    expect(() => validateDocumentationBundle(directory)).toThrow(/plain manifest.json file/u);
  });

  it.skipIf(process.platform === "win32")("refuses a FIFO manifest without blocking the consumer", () => {
    const { root, state } = fixture(); const bundle = createDocumentationBundle(root, state);
    const directory = write(root, bundle.contents, "fifo-manifest"); rmSync(join(directory, "manifest.json"));
    execFileSync("mkfifo", [join(directory, "manifest.json")]);
    const script = `import { validateDocumentationBundle } from ${JSON.stringify(new URL("./documentation-bundle-io.ts", import.meta.url).href)}; validateDocumentationBundle(${JSON.stringify(directory)});`;
    const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], { encoding: "utf8", timeout: 2000 });
    expect(child.error).toBeUndefined(); expect(child.status).toBe(1); expect(child.stderr).toMatch(/non-file manifest.json/u);
  });
});
