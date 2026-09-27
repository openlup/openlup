import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDocumentationBundle } from "./documentation-bundle.ts";
import { validateDocumentationBundle, writeDocumentationBundle } from "./documentation-bundle-io.ts";
import { renderDocumentationSourceMap } from "./documentation-navigation.ts";
import type { DocumentationState } from "./documentation-routing.ts";

const fixtures: string[] = [];
afterEach(() => fixtures.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
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
});
