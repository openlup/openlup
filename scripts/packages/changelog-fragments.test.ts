import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { parseChangelogFragment, readChangelogFragments, validateChangelogFragment } from "./changelog-fragments.ts";
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
  write("config/documentation-guide-allowlist.json", JSON.stringify({ schemaVersion: 1, terms: [] }));
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
    f.commit();
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

describe("guide publication admission", () => {
  const catalog = JSON.stringify({ schemaVersion: 1, publicPaths: [], guardViability: [] });
  const page = "packages/core/docs/guide/README.md";
  it("admits guide Markdown by pattern, at any depth, without catalog rows", () => {
    const nested = "packages/core/docs/guide/how-to/build/compose-packages.md";
    expect(effectivePublicCatalogPaths(catalog, [{ path: page, mode: "100644" }, { path: nested, mode: "100644" }], () => "# Page\n"))
      .toEqual([{ path: page, class: "public-output" }, { path: nested, class: "public-output" }]);
  });
  it.each([
    [page, "100755", "# Page\n"], [page, "120000", "# Page\n"], ["packages/core/docs/guide/run.sh", "100644", "echo\n"],
    ["packages/core/docs/guide/Start/page.md", "100644", "# Page\n"], [page, "100644", "  \n"], [page, "100644", "# Page\n<<<<<<< HEAD\n"],
    [page, "100644", Buffer.from([0x23, 0x20, 0xc3, 0x28])],
  ])("refuses %s with mode %s and unreadable or non-Markdown content", (path, mode, bytes) => {
    expect(() => effectivePublicCatalogPaths(catalog, [{ path, mode }], () => bytes)).toThrow();
  });
  it("refuses a per-file catalog row for a guide page", () => {
    const rows = JSON.stringify({ schemaVersion: 1, publicPaths: [{ path: page, class: "public-output" }], guardViability: [] });
    expect(() => effectivePublicCatalogPaths(rows, [{ path: page, mode: "100644" }], () => "# Page\n")).toThrow("pattern admission");
  });
});

describe("manifest-pinned platform SQL migration admission", () => {
  const catalog = JSON.stringify({ schemaVersion: 1, publicPaths: [], guardViability: [] });
  const sql = "SELECT 1;\n";
  const sha = "c1b5f9e0d3d4f38b4ef8016f510657e4f8470e818a43195c8df04e32f0c2e83c";
  const migration = "db/platform/migrations/20990101000000_fixture.sql";
  const mirror = "packages/platform/sql/20990101000000_fixture.sql";
  const handAuthored = "packages/platform/sql/20260809150001_job_run_ledger_v3.sql";
  const manifest = JSON.stringify({
    schemaVersion: 2,
    baseline: { file: "db/platform/migrations/00000000000000_platform_baseline.sql", sha256: sha },
    forward: [{ file: migration, sha256: sha }],
    objectInventorySha256: "0".repeat(64),
  });
  const files = new Map<string, string>([
    ["config/platform-migration-manifest.json", manifest],
    [migration, sql],
    [mirror, sql],
    [handAuthored, sql],
  ]);

  it("admits manifest-pinned migrations and projected mirrors without per-file catalog rows", () => {
    const expectedSha = createHash("sha256").update(sql).digest("hex");
    const validManifest = manifest.replaceAll(sha, expectedSha);
    const read = (path: string) => (path === "config/platform-migration-manifest.json" ? validManifest : files.get(path));
    expect(effectivePublicCatalogPaths(catalog, [
      { path: migration, mode: "100644" },
      { path: mirror, mode: "100644" },
    ], read)).toEqual([
      { path: migration, class: "public-output" },
      { path: mirror, class: "public-output" },
    ]);
  });

  it("keeps the hand-authored package SQL file as an explicit catalog row", () => {
    const rows = JSON.stringify({ schemaVersion: 1, publicPaths: [{ path: handAuthored, class: "public-output" }], guardViability: [] });
    expect(effectivePublicCatalogPaths(rows, [{ path: handAuthored, mode: "100644" }], (path) => files.get(path)))
      .toEqual([{ path: handAuthored, class: "public-output" }]);
  });

  it.each([
    ["unmanifested migration", "db/platform/migrations/20990101000001_rogue.sql", "100644", /unmanifested/u],
    ["unmanifested mirror", "packages/platform/sql/20990101000001_rogue.sql", "100644", /unmanifested/u],
    ["nested rogue SQL", "db/platform/migrations/nested/20990101000000_fixture.sql", "100644", /unmanifested/u],
    ["executable migration", migration, "100755", /non-executable/u],
    ["symlink migration", migration, "120000", /non-executable/u],
    ["digest mismatch", migration, "100644", /SHA-256 mismatch/u],
    ["mirror digest mismatch", mirror, "100644", /SHA-256 mismatch/u],
  ])("refuses %s", (_label, path, mode, pattern) => {
    const read = (target: string) => {
      if (target === "config/platform-migration-manifest.json") return manifest;
      return sql;
    };
    expect(() => effectivePublicCatalogPaths(catalog, [{ path, mode }], read)).toThrow(pattern);
  });

  it("admits qualified and qualifiedAdmin plan migrations and refuses conflicting cross-plan pins", () => {
    const expectedSha = createHash("sha256").update(sql).digest("hex");
    const q2 = "db/platform/migrations/q2_00000000000000_platform_baseline.sql";
    const qa = "db/platform/migrations/qa_00000000000000_platform_baseline.sql";
    const multiPlan = JSON.stringify({
      schemaVersion: 2,
      baseline: { file: "db/platform/migrations/00000000000000_platform_baseline.sql", sha256: expectedSha },
      forward: [{ file: migration, sha256: expectedSha }],
      qualified: { baseline: { file: q2, sha256: expectedSha }, forward: [{ file: migration, sha256: expectedSha }] },
      qualifiedAdmin: { baseline: { file: qa, sha256: expectedSha }, forward: [{ file: migration, sha256: expectedSha }] },
    });
    const read = (target: string) => (target === "config/platform-migration-manifest.json" ? multiPlan : sql);
    expect(effectivePublicCatalogPaths(catalog, [
      { path: q2, mode: "100644" },
      { path: qa, mode: "100644" },
      { path: "packages/platform/sql/q2_00000000000000_platform_baseline.sql", mode: "100644" },
    ], read)).toEqual([
      { path: q2, class: "public-output" },
      { path: qa, class: "public-output" },
      { path: "packages/platform/sql/q2_00000000000000_platform_baseline.sql", class: "public-output" },
    ]);

    const conflicting = JSON.stringify({
      schemaVersion: 2,
      baseline: { file: "db/platform/migrations/00000000000000_platform_baseline.sql", sha256: expectedSha },
      forward: [{ file: migration, sha256: expectedSha }],
      qualified: { forward: [{ file: migration, sha256: "1".repeat(64) }] },
    });
    expect(() => effectivePublicCatalogPaths(catalog, [{ path: migration, mode: "100644" }], (target) => (target === "config/platform-migration-manifest.json" ? conflicting : sql)))
      .toThrow(/conflicting sha256 pin/u);
  });

  it.each([
    ["nested manifest path", "db/platform/migrations/nested/evil.sql"],
    ["package-only manifest path", "packages/platform/sql/rogue.sql"],
    ["dotfile manifest path", "db/platform/migrations/.hidden.sql"],
    ["traversal manifest path", "db/platform/migrations/../other/evil.sql"],
    ["out-of-area manifest path", "scripts/evil.sql"],
  ])("refuses non-canonical manifest unit path: %s", (_label, badFile) => {
    const expectedSha = createHash("sha256").update(sql).digest("hex");
    const badManifest = JSON.stringify({
      schemaVersion: 2,
      forward: [{ file: badFile, sha256: expectedSha }],
    });
    expect(() => effectivePublicCatalogPaths(catalog, [{ path: migration, mode: "100644" }], (target) => (target === "config/platform-migration-manifest.json" ? badManifest : sql)))
      .toThrow(/canonical db\/platform\/migrations\/\*\.sql path/u);
  });

  it.each([
    ["invalid UTF-8 bytes", Buffer.from([0xff, 0xfe]), /not UTF-8/u],
    ["NUL byte payload", Buffer.from("SELECT 1;\x00\n"), /control-character/u],
    ["CR control byte", Buffer.from("SELECT 1;\r\n"), /control-character/u],
  ])("refuses %s even when raw SHA-256 matches the manifest pin", (_label, badBytes, pattern) => {
    const rawSha = createHash("sha256").update(badBytes).digest("hex");
    const matchingManifest = JSON.stringify({
      schemaVersion: 2,
      forward: [{ file: migration, sha256: rawSha }],
    });
    expect(() => effectivePublicCatalogPaths(catalog, [{ path: migration, mode: "100644" }], (target) => (target === "config/platform-migration-manifest.json" ? matchingManifest : badBytes)))
      .toThrow(pattern);
  });

  it("refuses absent or duplicate-key platform migration manifests", () => {
    expect(() => effectivePublicCatalogPaths(catalog, [{ path: migration, mode: "100644" }], (target) => (target === "config/platform-migration-manifest.json" ? undefined : sql)))
      .toThrow(/manifest is absent/u);
    const duplicateKey = `{"schemaVersion":2,"forward":[],"forward":[]}`;
    expect(() => effectivePublicCatalogPaths(catalog, [{ path: migration, mode: "100644" }], (target) => (target === "config/platform-migration-manifest.json" ? duplicateKey : sql)))
      .toThrow(/duplicate/iu);
  });

  it("refuses per-file catalog rows for manifest-pinned platform SQL files", () => {
    for (const pinnedPath of [migration, mirror]) {
      const rows = JSON.stringify({ schemaVersion: 1, publicPaths: [{ path: pinnedPath, class: "public-output" }], guardViability: [] });
      expect(() => effectivePublicCatalogPaths(rows, [], () => undefined)).toThrow("manifest-pinned pattern admission");
    }
  });
});

describe("Migration gate with Git-tree fragments", () => {
  it("refuses invalid UTF-8 in a committed fragment even when its Migration marker is valid", () => {
    const f = fixture(), base = f.commit();
    f.write("packages/core/api/core.api.md", "## dist/core.d.ts\nexport declare const b: string;\n");
    f.write(fragment, "- Replace a with b.\n\nMigration: before a, after b.\n");
    writeFileSync(join(f.root, fragment), Buffer.concat([Buffer.from(f.read(fragment)), Buffer.from([0xc3, 0x28])]));
    const invalid = f.commit();
    f.write(fragment, "- Replace a with b.\n\nMigration: valid worktree bytes cannot repair the committed blob.\n");
    expect(() => assertMigrationBlocks(f.root, base, invalid)).toThrow(/encoded data was not valid/u);
  });
  it("requires a marker for removal; head fragment passes; pure addition passes; worktree edits cannot satisfy it", () => {
    const f = fixture(), base = f.commit();
    f.write("packages/core/api/core.api.md", "## dist/core.d.ts\nexport declare const b: string;\n"); const removed = f.commit();
    expect(() => assertMigrationBlocks(f.root, base, removed)).toThrow(/no Migration/);
    f.write(fragment, "- Replace a with b.\n\nMigration: before a, after b.\n");
    expect(() => assertMigrationBlocks(f.root, base, removed)).toThrow(/no Migration/);
    const marked = f.commit(); expect(() => assertMigrationBlocks(f.root, base, marked)).not.toThrow();
    f.write("packages/core/api/core.api.md", "## dist/core.d.ts\nexport declare const a: string;\nexport declare const b: string;\n");
    rmSync(join(f.root, fragment)); const additive = f.commit(); expect(() => assertMigrationBlocks(f.root, base, additive)).not.toThrow();
    f.write(fragment, "## Invalid even for an addition\n"); const invalid = f.commit(); expect(() => assertMigrationBlocks(f.root, base, invalid)).toThrow(/fragment/);
  });
});

describe("fragment frontmatter and strict hygiene", () => {
  it("parses optional kind/audience frontmatter, infers starter-* audience, and strips frontmatter completely", () => {
    expect(parseChangelogFragment({ path: fragment, contents: "- Plain feature.\n" })).toEqual({
      meta: { kind: "feature", audience: "npm" },
      body: "- Plain feature.\n",
    });
    expect(parseChangelogFragment({ path: "packages/core/changes/starter-checkout.md", contents: "- Starter tweak.\n" })).toEqual({
      meta: { kind: "feature", audience: "starter" },
      body: "- Starter tweak.\n",
    });
    expect(parseChangelogFragment({
      path: fragment,
      contents: "---\nkind: action_required\naudience: starter\n---\n\n- Action item.\n\nMigration: update config.\n",
    })).toEqual({
      meta: { kind: "action_required", audience: "starter" },
      body: "- Action item.\n\nMigration: update config.\n",
    });
    expect(parseChangelogFragment({
      path: "packages/core/changes/starter-override.md",
      contents: "---\nkind: deprecation\naudience: npm\n---\n- Explicit npm override.\n",
    })).toEqual({
      meta: { kind: "deprecation", audience: "npm" },
      body: "- Explicit npm override.\n",
    });
  });

  it("never leaks raw frontmatter delimiters into CHANGELOG.md", () => {
    const f = fixture();
    f.commit();
    f.write(fragment, "---\nkind: fix\naudience: npm\n---\n\n- Fixed edge case.\n");
    bumpSet(f.root, "0.5.0");
    const changelog = f.read("packages/core/CHANGELOG.md");
    expect(changelog).toContain("- Fixed edge case.");
    expect(changelog).not.toContain("kind: fix");
    expect(changelog).not.toContain("---");
  });

  it.each([
    ["unknown key", "---\ntype: feature\n---\n- Note.\n", /unknown frontmatter key "type"/u],
    ["invalid kind", "---\nkind: breaking\n---\n- Note.\n", /invalid frontmatter kind "breaking"/u],
    ["invalid audience", "---\naudience: internal\n---\n- Note.\n", /invalid frontmatter audience "internal"/u],
    ["duplicate key", "---\nkind: fix\nkind: feature\n---\n- Note.\n", /duplicate frontmatter key "kind"/u],
    ["unterminated frontmatter", "---\nkind: fix\n- Note.\n", /unterminated frontmatter/u],
    ["empty body after frontmatter", "---\nkind: fix\n---\n\n", /empty or malformed/u],
    ["placeholder literal", "- For the next 1.x release.\n", /For the next 1\.x release\./u],
    ["orphaned Migration block", "Migration: before a, after b.\n", /orphaned Migration:/u],
    ["heading-only before Migration", "### Rename\n\nMigration: before a, after b.\n", /orphaned Migration:/u],
    ["frontmatter then orphaned Migration", "---\nkind: action_required\n---\n\nMigration: before a, after b.\n", /orphaned Migration:/u],
  ])("refuses %s", (_label, contents, pattern) => {
    expect(() => validateChangelogFragment(fragment, contents, "100644")).toThrow(pattern);
  });
});
