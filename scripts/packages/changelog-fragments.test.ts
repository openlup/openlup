import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { readChangelogFragments, validateChangelogFragment } from "./changelog-fragments.ts";
import { addReleaseSection, bumpSet } from "./release-bump.ts";
import { assertMigrationBlocks } from "./packages-check.ts";
import { effectivePublicCatalogPaths } from "../oss-publication-policy.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const fragment = "packages/core/changes/a-one.md";
const history = "## [0.4.0]\n\n- Previous bytes.  \n\n";
function fixture(legacy = "") {
  const root = mkdtempSync(join(tmpdir(), "carry-fragments-")); roots.push(root);
  const write = (path: string, text: string) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); };
  const read = (path: string) => readFileSync(join(root, path), "utf8");
  write("config/openlup-packages.json", JSON.stringify({ schemaVersion: 2, packages: [{ name: "@openlup/core", directory: "packages/core", publish: true }], unreleased: [] }));
  write("package-lock.json", JSON.stringify({ packages: { "packages/core": { version: "0.4.0" } } }, null, 2));
  write("packages/core/package.json", JSON.stringify({ name: "@openlup/core", version: "0.4.0" }, null, 2));
  write("packages/core/CHANGELOG.md", `# Changelog\n\n## [Unreleased]\n\n${legacy}${history}`);
  write("packages/core/release-gates.json", JSON.stringify({ packageSurface: { ".": { snapshot: "api/core.api.md" } } }));
  write("packages/core/api/core.api.md", "## dist/core.d.ts\nexport declare const a: string;\n");
  const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q");
  const commit = () => { git("add", "."); git("commit", "-qm", "fixture"); return git("rev-parse", "HEAD"); };
  return { root, write, read, git, commit };
}

describe("changelog fragment preparation", () => {
  it.each(["legacy", "fragments", "mixed"])("assembles %s in byte path order and preserves history byte-for-byte", (kind) => {
    const f = fixture(kind === "fragments" ? "" : "- Legacy first.\n\n");
    if (kind !== "legacy") {
      f.write("packages/core/changes/z-last.md", "- Last.\n"); f.write(fragment, "### Added\n\n- First.\n");
    }
    f.write("packages/outbox/changes/not-consumed.md", "- Other package.\n");
    const paths = bumpSet(f.root, "0.5.0"), result = f.read("packages/core/CHANGELOG.md");
    expect(result.endsWith(history)).toBe(true);
    expect(result).toContain("## [Unreleased]\n\n## [0.5.0]\n");
    if (kind !== "legacy") {
      expect(result.indexOf("- First.")).toBeLessThan(result.indexOf("- Last."));
      expect(paths).toContain(fragment); expect(existsSync(join(f.root, fragment))).toBe(false);
    }
    if (kind === "mixed") expect(result.indexOf("- Legacy first.")).toBeLessThan(result.indexOf("- First."));
    expect(f.read("packages/outbox/changes/not-consumed.md")).toBe("- Other package.\n");
  });
  it.each(["", " \n", "# Heading\n", "## [1.0.0]\n", "<<<<<<< ours\n- Note\n", "- Note\n=======\n", "\0bad"])("refuses invalid content before any write: %j", (content) => {
    const f = fixture(); f.write(fragment, content); const before = f.read("package-lock.json"), manifest = f.read("packages/core/package.json"), changelog = f.read("packages/core/CHANGELOG.md");
    expect(() => bumpSet(f.root, "0.5.0")).toThrow(/fragment/);
    expect(f.read("package-lock.json")).toBe(before); expect(f.read("packages/core/package.json")).toBe(manifest); expect(f.read("packages/core/CHANGELOG.md")).toBe(changelog); expect(f.read(fragment)).toBe(content);
  });
  it("refuses nested directories, links and executable fragment modes", () => {
    for (const kind of ["nested", "link", "exec"]) {
      const f = fixture(); f.write(fragment, "- Note\n");
      if (kind === "nested") f.write("packages/core/changes/nested/a.md", "- Note\n");
      if (kind === "link") symlinkSync("a-one.md", join(f.root, "packages/core/changes/link.md"));
      if (kind === "exec") chmodSync(join(f.root, fragment), 0o755);
      expect(() => readChangelogFragments(f.root, "packages/core")).toThrow(/fragment/);
    }
    expect(() => addReleaseSection("CHANGELOG.md", "## [Unreleased]\n\n## [Unreleased]\n\n", "0.5.0", "tag")).toThrow();
  });
});

describe("fragment publication admission", () => {
  const catalog = JSON.stringify({ schemaVersion: 1, publicPaths: [], guardViability: [] });
  it("admits only the exact validated non-executable pattern without catalog rows", () => {
    expect(effectivePublicCatalogPaths(catalog, [{ path: fragment, mode: "100644" }], () => "- Note\n")).toEqual([{ path: fragment, class: "public-output" }]);
    for (const [path, mode] of [[fragment, "100755"], [fragment, "120000"], ["packages/core/changes/a.sh", "100644"], ["packages/core/changes/nested/a.md", "100644"]]) expect(() => effectivePublicCatalogPaths(catalog, [{ path, mode }], () => "- Note\n")).toThrow();
    expect(() => validateChangelogFragment(fragment, "## bad", "100644")).toThrow();
  });
});

describe("Migration gate with Git-tree fragments", () => {
  it("refuses invalid UTF-8 in a committed fragment even when its Migration marker is valid", () => {
    const f = fixture(), base = f.commit();
    f.write("packages/core/api/core.api.md", "## dist/core.d.ts\nexport declare const b: string;\n");
    f.write(fragment, "Migration: before a, after b.\n");
    writeFileSync(join(f.root, fragment), Buffer.concat([Buffer.from(f.read(fragment)), Buffer.from([0xc3, 0x28])]));
    const invalid = f.commit();
    f.write(fragment, "Migration: valid worktree bytes cannot repair the committed blob.\n");
    expect(() => assertMigrationBlocks(f.root, base, invalid)).toThrow(/encoded data was not valid/u);
  });
  it("requires a marker for removal; head fragment passes; pure addition passes; worktree edits cannot satisfy it", () => {
    const f = fixture(), base = f.commit();
    f.write("packages/core/api/core.api.md", "## dist/core.d.ts\nexport declare const b: string;\n"); const removed = f.commit();
    expect(() => assertMigrationBlocks(f.root, base, removed)).toThrow(/no Migration/);
    f.write(fragment, "Migration: before a, after b.\n");
    expect(() => assertMigrationBlocks(f.root, base, removed)).toThrow(/no Migration/);
    const marked = f.commit(); expect(() => assertMigrationBlocks(f.root, base, marked)).not.toThrow();
    f.write("packages/core/api/core.api.md", "## dist/core.d.ts\nexport declare const a: string;\nexport declare const b: string;\n");
    rmSync(join(f.root, fragment)); const additive = f.commit(); expect(() => assertMigrationBlocks(f.root, base, additive)).not.toThrow();
    f.write(fragment, "## Invalid even for an addition\n"); const invalid = f.commit(); expect(() => assertMigrationBlocks(f.root, base, invalid)).toThrow(/fragment/);
  });
});
